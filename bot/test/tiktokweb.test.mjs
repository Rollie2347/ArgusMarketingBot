/**
 * The TikTok browser bot, driving REAL Chrome against a local imitation of
 * TikTok Studio's upload page.
 *
 * What this proves: the bot's own logic — attach the video, wait for the
 * upload, replace the caption, turn the AI label on, refuse a private post,
 * press Post, recognise success, stop before Post on a dry run, and fail
 * loudly (with a screenshot) when logged out or when a step can't be done.
 *
 * What it can NOT prove: that TikTok's real page looks like this imitation.
 * That is what the first DRY_RUN against the real site is for.
 *
 * Skips when Chrome or ffmpeg isn't installed.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let server, base, data, publish, skip = null;
let posted = null;          // what the fake page received on Post
let pageMode = {};          // knobs for the fake page

const PAGE = (m) => `<!doctype html><meta charset="utf-8"><title>TikTok Studio (fake)</title>
<body style="font-family:sans-serif">
<input type="file" accept="video/*" id="f">
<div data-e2e="caption_container"><div class="public-DraftEditor-content" contenteditable="true" id="cap">video.mp4</div></div>
<div id="more-wrap">${m.noAiSwitch ? "" : `<span id="more">Show more</span>`}
  <div id="adv" hidden><div class="headline-wrapper"><span>AI-generated content</span><div class="headline-switch"><div class="Switch__root">
    <!-- TikTok's real structure (2026-09-27): a visible styled box carrying the
         state, around an invisible zero-size checkbox that cannot be clicked. -->
    <div class="Switch__content" id="ai" aria-checked="false" data-state="unchecked" style="position:relative;width:30px;height:16px;background:#ccc">
      <input role="switch" type="checkbox" aria-hidden="true" tabindex="-1" style="appearance:none;position:absolute;width:0;height:0;pointer-events:none">
    </div></div></div></div></div>
</div>
<div id="vis">${m.private ? "Only me" : "Everyone"}</div>
<button data-e2e="post_video_button" id="post" disabled>Post</button>
<div id="modal" style="display:none"><button id="turnon">Turn on</button></div>
<script>
  f.onchange = () => setTimeout(() => { post.disabled = false; }, 800);
  const more = document.getElementById("more");
  if (more) more.onclick = () => { adv.hidden = false; };
  ai.onclick = () => { modal.style.display = "block"; };
  turnon.onclick = () => { ai.setAttribute("aria-checked", "true"); ai.dataset.state = "checked"; modal.style.display = "none"; };
  post.onclick = async () => {
    await fetch("/posted", { method: "POST", body: JSON.stringify({ caption: cap.innerText, ai: ai.getAttribute("aria-checked"), file: f.files[0] && f.files[0].name, size: f.files[0] && f.files[0].size }) });
    location.href = "/tiktokstudio/content";
  };
</script>`;

before(async () => {
  // The sandbox must be set BEFORE anything imports lib/paths.mjs, which
  // reads MARKETING_DATA_DIR once, at import.
  data = mkdtempSync(join(tmpdir(), "argus-ttweb-test-"));
  process.env.MARKETING_DATA_DIR = data;
  try { (await import("../../lib/browser.mjs")).findChrome(); (await import("../../lib/video.mjs")).findFfmpeg(); }
  catch (e) { skip = e.message; return; }

  const dir = join(data, "out", "d1", "tiktok");
  mkdirSync(dir, { recursive: true });
  // Two real JPEG slides, cut from a real render so ffmpeg has real input.
  const real = join(HERE, "..", "..", "out", "01-fridge-stare", "tiktok");
  for (const n of ["01", "02"]) {
    const src = join(real, `${n}.jpg`);
    if (!existsSync(src)) { skip = "no rendered slides to build a test video from — run make-slideshow first"; return; }
    writeFileSync(join(dir, `${n}.jpg`), readFileSync(src));
  }
  mkdirSync(join(data, "decks"), { recursive: true });
  writeFileSync(join(data, "decks", "d1.json"), JSON.stringify({ slides: [{ type: "hook", headline: "Open fridge. No idea." }, { type: "cta", headline: "Argus" }] }));

  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/posted") { posted = JSON.parse(Buffer.concat(chunks).toString()); res.end("ok"); return; }
    if (req.url.startsWith("/login")) { res.setHeader("content-type", "text/html"); res.end("<title>Log in</title>Log in to TikTok"); return; }
    if (req.url.startsWith("/tiktokstudio/upload")) {
      if (pageMode.loggedOut) { res.writeHead(302, { location: "/login?redirect=upload" }); res.end(); return; }
      res.setHeader("content-type", "text/html"); res.end(PAGE(pageMode)); return;
    }
    if (req.url.startsWith("/tiktokstudio/content")) { res.setHeader("content-type", "text/html"); res.end("<title>Posts</title>Your video is being uploaded"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  Object.assign(process.env, { MARKETING_DATA_DIR: data, TIKTOK_UPLOAD_URL: `${base}/tiktokstudio/upload` });
  delete process.env.DRY_RUN;
  ({ publish } = await import("../publishers/tiktokweb.mjs"));
});

after(() => {
  server?.close();
  for (let i = 0; i < 10 && data; i++) { try { rmSync(data, { recursive: true, force: true }); break; } catch { /* chrome lock */ } }
});

const item = (extra = {}) => ({
  id: "d1:tiktok", deckId: "d1", platform: "tiktok",
  slideFiles: ["01.png", "02.png"], jpgFiles: ["01.jpg", "02.jpg"],
  caption: "Open fridge. No idea.\nPoint the camera and ask. Free on iPhone — search “My Argus”.",
  hashtags: ["#whatsfordinner", "#iphoneapps"], aiImages: true, history: [], ...extra,
});

test("posts: video attached, caption replaced, AI label on, Post pressed", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = {};
  const r = await publish(item());
  assert.equal(r.published, true);
  assert.ok(posted, "the fake page received a Post");
  assert.match(posted.file, /^slideshow-.*\.mp4$/);
  assert.ok(posted.size > 10_000, "a real video was uploaded");
  assert.match(posted.caption, /^Open fridge\. No idea\./, "the prefilled filename was replaced");
  assert.ok(!posted.caption.includes("video.mp4"));
  assert.match(posted.caption, /#whatsfordinner #iphoneapps/);
  assert.equal(posted.ai, "true", "AI-generated label switched on (after the Turn on confirm)");
});

test("dry run stops before Post and returns a screenshot", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = {};
  process.env.DRY_RUN = "1";
  const { publish: dry } = await import(`../publishers/tiktokweb.mjs?dry=${Date.now()}`);
  delete process.env.DRY_RUN;
  const r = await dry(item());
  assert.equal(r.published, false);
  assert.equal(posted, null, "Post was never pressed");
  assert.ok(r.screenshot && existsSync(r.screenshot));
});

test("logged out → a clear failure with a screenshot, nothing posted", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = { loggedOut: true };
  const err = await publish(item()).catch((e) => e);
  assert.match(err.message, /isn't logged in[\s\S]*\/tiktoklogin/, "tells you the Telegram command that fixes it");
  assert.ok(err.screenshot && existsSync(err.screenshot));
  assert.equal(posted, null);
});

test("no AI switch on the page → refuses to post an AI deck unlabelled", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = { noAiSwitch: true };
  const err = await publish(item()).catch((e) => e);
  assert.match(err.message, /AI-generated content switch/);
  assert.equal(posted, null);
  // …but a deck without generated photos doesn't need it.
  posted = null;
  const r = await publish(item({ aiImages: false }));
  assert.equal(r.published, true);
});

test("a private default is refused", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = { private: true };
  const err = await publish(item()).catch((e) => e);
  assert.match(err.message, /private/);
  assert.equal(posted, null);
});
