/**
 * The free Instagram path — slide hosting (lib/gcs.mjs), the Instagram Login
 * publisher and token refresh (igtoken.mjs) — against local fakes of Google's
 * token + upload endpoints and graph.instagram.com.
 *
 * Proves the request sequence matches Meta's documented carousel flow, that
 * the token only ever travels in a header (except the one refresh call Meta
 * defines as a query parameter), that a container Instagram rejects fails
 * loudly, and that a lost publish reply cannot turn a retry into a double post.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "IGAA-FAKE-TOKEN-abcdef0123456789";
let server, base, data, publish, refreshIfDue, currentToken;
let log = [];
let mode = {};

before(async () => {
  data = mkdtempSync(join(tmpdir(), "argus-ig-test-"));
  for (const p of ["instagram"]) {
    const dir = join(data, "out", "d1", p);
    mkdirSync(dir, { recursive: true });
    for (const n of ["01", "02", "03"]) writeFileSync(join(dir, `${n}.jpg`), Buffer.from(`jpeg-${n}`));
  }

  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url, "http://x");
    log.push({ method: req.method, path: u.pathname, query: u.search, auth: req.headers.authorization, body });
    const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };

    if (u.pathname === "/token") return send(200, { access_token: "gcs-access", expires_in: 3600 });
    if (u.pathname.startsWith("/upload/")) return send(200, { name: u.searchParams.get("name") });
    if (u.pathname === "/refresh_access_token") {
      return mode.refresh === "fail" ? send(400, { error: { message: "Session has expired", code: 190 } }) : send(200, { access_token: "IGAA-REFRESHED", token_type: "bearer", expires_in: 5184000 });
    }
    const p = u.pathname.replace(/^\/v25\.0\//, "");
    if (req.method === "GET" && p === "178/media") return send(200, { data: mode.recent || [] });
    if (req.method === "POST" && p === "178/media") {
      const f = new URLSearchParams(body);
      if (f.get("media_type") === "CAROUSEL") return send(200, { id: "parent-1" });
      return send(200, { id: `child-${log.filter((l) => l.path.endsWith("178/media") && l.method === "POST").length}` });
    }
    if (req.method === "GET" && p === "parent-1") {
      mode.polls = (mode.polls || 0) + 1;
      if (mode.container === "ERROR") return send(200, { status_code: "ERROR" });
      return send(200, { status_code: mode.polls < 2 ? "IN_PROGRESS" : "FINISHED" });
    }
    if (req.method === "POST" && p === "178/media_publish") return send(200, { id: "media-99" });
    if (req.method === "GET" && p === "media-99") return send(200, { permalink: "https://www.instagram.com/p/ABC/" });
    return send(404, { error: { message: `fake: no route ${req.method} ${p}`, code: 100 } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { client_email: "uploader@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: `${base}/token` };

  Object.assign(process.env, {
    MARKETING_DATA_DIR: data,
    IG_USER_ID: "178",
    IG_ACCESS_TOKEN: TOKEN,
    IG_GRAPH_BASE: base,
    IG_POLL_MS: "20",
    MARKETING_GCS_BUCKET: "test-bucket",
    MARKETING_GCS_KEY_B64: Buffer.from(JSON.stringify(sa)).toString("base64"),
    GCS_UPLOAD_BASE: `${base}/upload/storage/v1`,
    GCS_PUBLIC_BASE: "https://storage.googleapis.com",
  });
  delete process.env.DRY_RUN;
  ({ publish } = await import("../publishers/instagram.mjs"));
  ({ refreshIfDue, currentToken } = await import("../igtoken.mjs"));
});

after(() => {
  server?.close();
  rmSync(data, { recursive: true, force: true });
});

const item = (extra = {}) => ({
  id: "d1:instagram", deckId: "d1", platform: "instagram", title: "Probe",
  slideFiles: ["01.png", "02.png", "03.png"], jpgFiles: ["01.jpg", "02.jpg", "03.jpg"],
  caption: "The fridge has everything. Point, ask, cook.", hashtags: ["#whatsfordinner"],
  aiImages: false, history: [], ...extra,
});

test("publishes a carousel via the documented flow, token in the header only", async () => {
  log = []; mode = {};
  const r = await publish(item());

  assert.equal(r.published, true);
  assert.equal(r.postId, "media-99");
  assert.equal(r.url, "https://www.instagram.com/p/ABC/");

  const uploads = log.filter((l) => l.path.startsWith("/upload/"));
  assert.equal(uploads.length, 3, "every slide is hosted first");
  assert.match(uploads[0].query, /name=ig%2Fd1%2F[A-Za-z0-9_-]{12}%2F01\.jpg/, "random, unguessable prefix");
  assert.equal(uploads[0].auth, "Bearer gcs-access");

  const posts = log.filter((l) => l.method === "POST" && l.path.includes("/178/media") && !l.path.endsWith("_publish"));
  assert.equal(posts.length, 4, "3 children + 1 carousel");
  const child = new URLSearchParams(posts[0].body);
  assert.equal(child.get("is_carousel_item"), "true");
  assert.match(child.get("image_url"), /^https:\/\/storage\.googleapis\.com\/test-bucket\/ig\/d1\/.+\/01\.jpg$/);
  const parent = new URLSearchParams(posts[3].body);
  assert.equal(parent.get("media_type"), "CAROUSEL");
  assert.equal(parent.get("children"), "child-1,child-2,child-3");
  assert.match(parent.get("caption"), /cook\.\n\n#whatsfordinner$/);

  assert.ok(mode.polls >= 2, "waits for FINISHED before publishing");
  const pub = log.find((l) => l.path.endsWith("/178/media_publish"));
  assert.equal(new URLSearchParams(pub.body).get("creation_id"), "parent-1");

  const graph = log.filter((l) => !l.path.startsWith("/upload") && l.path !== "/token");
  for (const l of graph) {
    assert.equal(l.auth, `Bearer ${TOKEN}`);
    assert.ok(!l.query.includes(TOKEN) && !l.body.includes(TOKEN), `token leaked into ${l.method} ${l.path}`);
  }
});

test("a container Instagram rejects is a loud failure, never a publish", async () => {
  log = []; mode = { container: "ERROR" };
  await assert.rejects(publish(item()), /container parent-1 is ERROR/);
  assert.ok(!log.some((l) => l.path.endsWith("media_publish")));
});

test("a retry after a lost reply finds the existing post instead of posting twice", async () => {
  log = [];
  mode = { recent: [{ id: "media-77", caption: "The fridge has everything. Point, ask, cook.\n\n#whatsfordinner", permalink: "https://www.instagram.com/p/OLD/", timestamp: new Date().toISOString() }] };
  const r = await publish(item());
  assert.equal(r.postId, "media-77");
  assert.match(r.note, /rather than posting twice/);
  assert.ok(!log.some((l) => l.path.startsWith("/upload") || l.path.endsWith("media_publish")), "nothing re-uploaded or re-published");
});

test("PNG-only decks are refused before anything is uploaded", async () => {
  log = []; mode = {};
  await assert.rejects(publish(item({ jpgFiles: [] })), /JPEG only/);
  assert.equal(log.length, 0);
});

test("token refresh: stores the new token, and a new env token wins over the stored one", async () => {
  mode = {};
  assert.equal(currentToken(), TOKEN);
  const r = await refreshIfDue();
  assert.equal(r.refreshed, true);
  assert.equal(currentToken(), "IGAA-REFRESHED", "the refreshed token is used from now on");
  const stored = JSON.parse(readFileSync(join(data, "state", "ig-token.json"), "utf8"));
  assert.ok(Date.parse(stored.expiresAt) > Date.now() + 50 * 86400_000);

  assert.equal((await refreshIfDue()).refreshed, false, "not again within 7 days");

  process.env.IG_ACCESS_TOKEN = "IGAA-PASTED-NEW";
  assert.equal(currentToken(), "IGAA-PASTED-NEW", "a token pasted after an expiry takes over");
  process.env.IG_ACCESS_TOKEN = TOKEN;
});

test("a failed refresh is reported without the token in it", async () => {
  mode = { refresh: "fail" };
  const r = await refreshIfDue(Date.now() + 8 * 86400_000);
  assert.equal(r.refreshed, false);
  assert.match(r.warning, /Session has expired/);
  assert.ok(!r.warning.includes(TOKEN));
});
