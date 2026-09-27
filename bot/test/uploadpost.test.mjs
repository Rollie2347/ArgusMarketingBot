/**
 * The Upload-Post publisher against a local fake of its API.
 *
 * The request shape is taken from docs.upload-post.com/api/upload-photo
 * (2026-09-26). These tests prove the adapter sends that shape and — more
 * importantly — that every way the real API can report "didn't post" becomes
 * a thrown error (→ publish_failed, loud) and never a quiet success:
 * an unconnected platform, an explicit failure, an auth error, a missing JPEG.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "UP-FAKE-KEY-0123456789";
let server, port, data, publish, config;
let requests = [];
let respond = null; // (req, form) => [status, json]

before(async () => {
  data = mkdtempSync(join(tmpdir(), "argus-uploadpost-test-"));
  for (const p of ["tiktok", "instagram"]) {
    const dir = join(data, "out", "d1", p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01.jpg"), Buffer.from("jpeg-bytes-1"));
    writeFileSync(join(dir, "02.jpg"), Buffer.from("jpeg-bytes-2"));
  }

  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    let form = null;
    if (req.method === "POST") {
      form = await new Request("http://x", { method: "POST", headers: req.headers, body }).formData();
    }
    requests.push({ method: req.method, url: req.url, headers: req.headers, form });
    const [status, json] = respond(req, form);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;

  Object.assign(process.env, {
    MARKETING_DATA_DIR: data,
    UPLOADPOST_API_KEY: KEY,
    UPLOADPOST_USER: "argus",
    UPLOADPOST_API_BASE: `http://127.0.0.1:${port}`,
    UPLOADPOST_POLL_MS: "30",
  });
  delete process.env.DRY_RUN;
  delete process.env.UPLOADPOST_TIKTOK_POST_MODE;
  ({ config } = await import("../config.mjs"));
  ({ publish } = await import("../publishers/uploadpost.mjs"));
});

after(() => {
  server?.close();
  rmSync(data, { recursive: true, force: true });
});

const item = (platform, extra = {}) => ({
  id: `d1:${platform}`, deckId: "d1", platform, title: "Probe",
  slideFiles: ["01.png", "02.png"], jpgFiles: ["01.jpg", "02.jpg"],
  caption: "Open fridge. No idea. Hold the phone up and ask. Free on iPhone, link in bio.",
  hashtags: ["#whatsfordinner", "#iphoneapps"],
  aiImages: true, history: [], ...extra,
});

test("TikTok: posts JPEGs with the documented fields and returns the post URL", async () => {
  requests = [];
  respond = () => [200, { success: true, results: { tiktok: { success: true, url: "https://www.tiktok.com/@argus/photo/1" } } }];
  const r = await publish(item("tiktok"));

  assert.equal(r.published, true);
  assert.equal(r.url, "https://www.tiktok.com/@argus/photo/1");

  const { url, headers, form } = requests[0];
  assert.equal(url, "/api/upload_photos");
  assert.equal(headers.authorization, `Apikey ${KEY}`);
  assert.equal(headers["idempotency-key"], "d1:tiktok#0");
  assert.equal(form.get("user"), "argus");
  assert.deepEqual(form.getAll("platform[]"), ["tiktok"]);
  const photos = form.getAll("photos[]");
  assert.equal(photos.length, 2);
  assert.equal(photos[0].type, "image/jpeg", "TikTok refuses PNG");
  assert.equal(form.get("post_mode"), "DIRECT_POST");
  assert.equal(form.get("privacy_level"), "PUBLIC_TO_EVERYONE");
  assert.equal(form.get("tiktok_is_ai_generated"), "true", "generated photos must carry the AI label");
  assert.ok(form.get("tiktok_title").length <= 90);
  assert.match(form.get("tiktok_description"), /#whatsfordinner/);
});

test("Instagram: caption + hashtags as the title, AI label set", async () => {
  requests = [];
  respond = () => [200, { success: true, results: { instagram: { success: true, url: "https://instagram.com/p/x" } } }];
  const r = await publish(item("instagram"));
  assert.equal(r.published, true);
  const { form } = requests[0];
  assert.deepEqual(form.getAll("platform[]"), ["instagram"]);
  // multipart/form-data serialisation normalises text-field newlines to CRLF
  // (HTML spec) — that is what the real API receives too.
  assert.match(form.get("instagram_title"), /link in bio\.\r?\n\r?\n#whatsfordinner #iphoneapps$/);
  assert.equal(form.get("is_ai_generated"), "true");
});

test("an unconnected platform ('skipped', no result) is a FAILURE, not a success", async () => {
  respond = () => [200, { success: true, results: {} }];
  await assert.rejects(publish(item("tiktok")), /no result for tiktok[\s\S]*connected/);

  respond = () => [200, { success: true, results: { tiktok: { success: false, status: "skipped", error: "platform not connected" } } }];
  await assert.rejects(publish(item("tiktok")), /not connected/);
});

test("an API error throws with the reason and never echoes the key", async () => {
  respond = () => [401, { success: false, message: `Invalid API key ${KEY}`, error_code: "unauthorized" }];
  const err = await publish(item("tiktok")).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /unauthorized/);
  assert.ok(!err.message.includes(KEY), "API key leaked into an error");
});

test("a slow upload that goes async is polled to completion", async () => {
  requests = [];
  let polls = 0;
  respond = (req) => {
    if (req.method === "POST") return [200, { success: true, message: "Upload initiated successfully in background.", request_id: "req-1", total_platforms: 1 }];
    polls++;
    return polls < 3
      ? [200, { status: "processing", completed: 0, total: 1 }]
      : [200, { status: "completed", completed: 1, total: 1, results: { tiktok: { success: true, url: "https://www.tiktok.com/@argus/photo/2" } } }];
  };
  const r = await publish(item("tiktok"));
  assert.equal(r.url, "https://www.tiktok.com/@argus/photo/2");
  assert.equal(requests.at(-1).url, "/api/uploadposts/status?request_id=req-1");
});

test("no JPEGs → refuses before calling the API", async () => {
  requests = [];
  await assert.rejects(publish(item("tiktok", { jpgFiles: [] })), /no JPEG slides/);
  assert.equal(requests.length, 0);
});

test("a retry after an explicit failure gets a new idempotency key; after a timeout it doesn't", async () => {
  respond = () => [200, { success: true, results: { tiktok: { success: true, url: "u" } } }];
  requests = [];
  await publish(item("tiktok", { history: [{ status: "publish_failed", error: "upload-post: quota exceeded" }] }));
  assert.equal(requests[0].headers["idempotency-key"], "d1:tiktok#1");
  requests = [];
  await publish(item("tiktok", { history: [{ status: "publish_failed", error: "upload-post /api/upload_photos: network failure: timeout" }] }));
  assert.equal(requests[0].headers["idempotency-key"], "d1:tiktok#0", "a timed-out upload may have landed — same key, so no double post");
});

test("checkConnection reports which platforms are connected, and a bad key", async () => {
  const { checkConnection } = await import("../publishers/uploadpost.mjs");
  respond = (req) => req.url === "/api/uploadposts/users/argus"
    ? [200, { success: true, profile: { username: "argus", social_accounts: { tiktok: { username: "myargusai" }, instagram: null } } }]
    : [404, { success: false, message: "no route" }];
  const r = await checkConnection(["tiktok", "instagram"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.connected, { tiktok: "myargusai" });
  assert.deepEqual(r.missing, ["instagram"]);

  respond = () => [401, { success: false, message: `bad key ${KEY}` }];
  const bad = await checkConnection(["tiktok"]);
  assert.equal(bad.ok, false);
  assert.ok(bad.error && !bad.error.includes(KEY));
});

test("MEDIA_UPLOAD sends a TikTok draft and reports it as NOT published", async () => {
  config.uploadpost.tiktokPostMode = "MEDIA_UPLOAD";
  requests = [];
  respond = () => [200, { success: true, results: { tiktok: { success: true } } }];
  const r = await publish(item("tiktok"));
  config.uploadpost.tiktokPostMode = "DIRECT_POST";
  assert.equal(requests[0].form.get("post_mode"), "MEDIA_UPLOAD");
  assert.equal(r.published, false, "a draft is not a post — it must end in /posted");
  assert.match(r.note, /DRAFT/);
});
