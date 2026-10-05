/**
 * The Instagram browser bot, driving REAL Chrome against a local imitation of
 * instagram.com's Create dialog.
 *
 * What this proves: the bot's own logic — open Create, attach the slides in
 * order, set the crop to 4:5, step through to the caption, write it, press
 * Share, recognise success, stop before Share on a dry run, and fail loudly
 * (with a screenshot) when logged out or when the crop can't be set.
 *
 * What it can NOT prove: that Instagram's real page looks like this
 * imitation. That is what scripts/instagram-dry-run.mjs is for.
 *
 * Skips when Chrome isn't installed.
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
let posted = null;          // what the fake page received on Share
let pageMode = {};          // knobs for the fake page

const PAGE = (m) => `<!doctype html><meta charset="utf-8"><title>Instagram (fake)</title>
<body style="font-family:sans-serif">
${m.loggedOut ? `<form><input name="username"><input name="password" type="password"></form>` : `
<div role="dialog" id="notif"><div>Turn on Notifications</div><button>Turn On</button><button>Not Now</button></div>
<a href="#" id="create"><svg aria-label="New post" width="24" height="24"></svg><span>Create</span></a>
<div role="dialog" id="dlg" hidden>
  <div id="title">Create new post</div>
  <div id="s-pick"><div role="button">Select from computer</div><form><input type="file" accept="image/jpeg,image/png,video/mp4" multiple id="f"></form></div>
  <div id="s-crop" hidden>
    ${m.noCrop ? "" : `<button id="cropbtn"><svg aria-label="Select crop" width="16" height="16"></svg></button>
    <div id="cropmenu" hidden><div role="button">Original</div><div role="button">1:1</div><div role="button">4:5</div><div role="button">9:16</div><div role="button">16:9</div></div>`}
  </div>
  <div id="s-edit" hidden>Filters</div>
  <div id="s-cap" hidden><div aria-label="Write a caption..." contenteditable="true" role="textbox" id="cap" style="min-height:80px;border:1px solid #ccc"></div>
    <!-- The real row (2026-10-04). -->
    ${m.noAiSwitch ? "" : `<div><div><span dir="auto">Add AI label</span></div><div><div><div></div><div></div><input dir="ltr" aria-checked="false" role="switch" type="checkbox" id="ai" onchange="this.setAttribute('aria-checked', this.checked)"></div></div></div>`}
  </div>
  <div role="button" id="next" hidden>Next</div>
  <div role="button" id="share" hidden>Share</div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  let stage = "pick", crop = "1:1";
  const show = (s) => { stage = s; for (const x of ["pick", "crop", "edit", "cap"]) $("s-" + x).hidden = x !== s; $("next").hidden = s === "pick" || s === "cap"; $("share").hidden = s !== "cap"; };
  notif.querySelectorAll("button")[1].onclick = () => notif.remove();
  create.onclick = (e) => { e.preventDefault(); dlg.hidden = false; };
  f.onchange = () => setTimeout(() => show("crop"), 500);
  const cropbtn = $("cropbtn");
  if (cropbtn) {
    cropbtn.onclick = () => { cropmenu.hidden = false; };
    for (const o of cropmenu.children) o.onclick = () => { crop = o.innerText; cropmenu.hidden = true; };
  }
  next.onclick = () => show(stage === "crop" ? "edit" : "cap");
  share.onclick = async () => {
    await fetch("/posted", { method: "POST", body: JSON.stringify({ caption: cap.innerText, crop, ai: $("ai") ? $("ai").getAttribute("aria-checked") : null, files: [...f.files].map((x) => x.name), size: f.files[0] && f.files[0].size }) });
    dlg.innerHTML = /mp4$/.test(f.files[0].name) ? "<div>Reel shared</div><div>Your reel has been shared.</div>" : "<div>Post shared</div><div>Your post has been shared.</div>";
  };
</script>`}`;

before(async () => {
  // The sandbox must be set BEFORE anything imports lib/paths.mjs, which
  // reads MARKETING_DATA_DIR once, at import.
  data = mkdtempSync(join(tmpdir(), "argus-igweb-test-"));
  process.env.MARKETING_DATA_DIR = data;
  try { (await import("../../lib/browser.mjs")).findChrome(); }
  catch (e) { skip = e.message; return; }

  const dir = join(data, "out", "d1", "instagram");
  mkdirSync(dir, { recursive: true });
  // Two real JPEG slides from a real render.
  const real = join(HERE, "..", "..", "out", "01-fridge-stare", "instagram");
  for (const n of ["01", "02"]) {
    const src = join(real, `${n}.jpg`);
    if (!existsSync(src)) { skip = "no rendered slides to post — run make-slideshow first"; return; }
    writeFileSync(join(dir, `${n}.jpg`), readFileSync(src));
  }

  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/posted") { posted = JSON.parse(Buffer.concat(chunks).toString()); res.end("ok"); return; }
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(PAGE(pageMode)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  process.env.INSTAGRAM_WEB_URL = `${base}/`;
  // The format is read per post; the tests below pin carousel, the reel test switches it.
  process.env.INSTAGRAM_FORMAT = "carousel";
  delete process.env.DRY_RUN;
  ({ publish } = await import("../publishers/instagramweb.mjs"));
});

after(() => {
  server?.close();
  for (let i = 0; i < 10 && data; i++) { try { rmSync(data, { recursive: true, force: true }); break; } catch { /* chrome lock */ } }
});

const item = (extra = {}) => ({
  id: "d1:instagram", deckId: "d1", platform: "instagram",
  slideFiles: ["01.png", "02.png"], jpgFiles: ["01.jpg", "02.jpg"],
  caption: "Open fridge. No idea.\nPoint the camera and ask.\n\nFree on iPhone — link in bio.",
  hashtags: ["#whatsfordinner", "#iphoneapps"], aiImages: true, history: [], ...extra,
});

test("posts: slides attached in order, crop set to 4:5, caption written, Share pressed", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = {};
  const r = await publish(item());
  assert.equal(r.published, true);
  assert.ok(posted, "the fake page received a Share");
  assert.deepEqual(posted.files, ["01.jpg", "02.jpg"]);
  assert.ok(posted.size > 10_000, "real slides were uploaded");
  assert.equal(posted.crop, "4:5", "not the default square crop");
  assert.match(posted.caption, /^Open fridge\. No idea\./);
  assert.match(posted.caption, /link in bio\.[\s\S]*#whatsfordinner #iphoneapps/);
  assert.match(r.note, /2-photo carousel/);
  assert.equal(posted.ai, "true", "AI label switched on");
});

test("no AI label switch on the page → refuses to post an AI deck unlabelled", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = { noAiSwitch: true };
  const err = await publish(item()).catch((e) => e);
  assert.match(err.message, /Add AI label switch/);
  assert.equal(posted, null);
  // …but a deck without generated photos doesn't need it.
  const r = await publish(item({ aiImages: false }));
  assert.equal(r.published, true);
});

test("dry run stops before Share and returns a screenshot", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = {};
  process.env.DRY_RUN = "1";
  const { publish: dry } = await import(`../publishers/instagramweb.mjs?dry=${Date.now()}`);
  delete process.env.DRY_RUN;
  const r = await dry(item());
  assert.equal(r.published, false);
  assert.equal(posted, null, "Share was never pressed");
  assert.ok(r.screenshot && existsSync(r.screenshot));
});

test("logged out → a clear failure with a screenshot, nothing posted", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = { loggedOut: true };
  const err = await publish(item()).catch((e) => e);
  assert.match(err.message, /isn't logged in[\s\S]*instagram-login/, "tells you the command that fixes it");
  assert.ok(err.screenshot && existsSync(err.screenshot));
  assert.equal(posted, null);
});

test("no crop control → refuses to post square-cropped slides", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = { noCrop: true };
  const err = await publish(item()).catch((e) => e);
  assert.match(err.message, /crop button/);
  assert.equal(posted, null);
});

test("reel: one video with a music track mixed in, cropped 9:16, Share pressed", async (t) => {
  if (skip) return t.skip(skip);
  const { findFfmpeg } = await import("../../lib/video.mjs");
  const { tracks } = await import("../../lib/music.mjs");
  try { findFfmpeg(); } catch (e) { return t.skip(e.message); }
  if (!tracks().length) return t.skip("no music in assets/music");
  posted = null; pageMode = {};
  process.env.INSTAGRAM_FORMAT = "reel";
  try {
    const r = await publish(item());
    assert.equal(r.published, true);
    assert.equal(posted.files.length, 1);
    assert.match(posted.files[0], /^slideshow-.*.mp4$/);
    assert.ok(posted.size > 50_000, "a real video was uploaded");
    assert.equal(posted.crop, "9:16");
    assert.equal(posted.ai, "true");
    assert.match(r.note, /reel with the music “.+.mp3”/);
  } finally { process.env.INSTAGRAM_FORMAT = "carousel"; }
});

test("carousel-sound: one clip per slide, in order, each with the music, cropped 4:5", async (t) => {
  if (skip) return t.skip(skip);
  const { findFfmpeg } = await import("../../lib/video.mjs");
  const { tracks } = await import("../../lib/music.mjs");
  try { findFfmpeg(); } catch (e) { return t.skip(e.message); }
  if (!tracks().length) return t.skip("no music in assets/music");
  posted = null; pageMode = {};
  process.env.INSTAGRAM_FORMAT = "carousel-sound";
  try {
    const r = await publish(item());
    assert.equal(r.published, true);
    assert.equal(posted.files.length, 2, "still one slide per swipe");
    assert.match(posted.files[0], /^clip-01-.*.mp4$/);
    assert.match(posted.files[1], /^clip-02-.*.mp4$/);
    assert.ok(posted.size > 50_000, "real video clips were uploaded");
    assert.equal(posted.crop, "4:5");
    assert.match(r.note, /2-slide swipeable carousel with the music “.+.mp3”/);
  } finally { process.env.INSTAGRAM_FORMAT = "carousel"; }
});

test("more photos than the website takes → refused before the browser opens", async (t) => {
  if (skip) return t.skip(skip);
  posted = null; pageMode = {};
  const many = Array.from({ length: 11 }, () => "01.jpg");
  const err = await publish(item({ jpgFiles: many })).catch((e) => e);
  assert.match(err.message, /at most 10 photos/);
  assert.equal(posted, null);
});
