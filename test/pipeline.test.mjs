/**
 * The daily pipeline — validation, the deck writer, image generation and a
 * real render — against a local fake of the Gemini API.
 *
 * Nothing here calls Google. The fake returns canned model output, so these
 * tests prove the PLUMBING: that bad model output is caught and repaired or
 * dropped, that ids/tokens are ours not the model's, that images are cached
 * and a failed one degrades instead of failing the deck, and that a generated
 * deck renders to PNG + JPEG. Whether the real model writes GOOD decks is what
 * the Telegram approval is for.
 *
 *   node --test "test/**\/*.test.mjs"
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETING = join(HERE, "..");
const KEY = "AIza-FAKE-MARKETING-KEY";

let server, data;
let calls = [];
let textReplies = [];     // queued JSON replies for text calls
let imageMode = "ok";     // "ok" | "fail"

/** A real, decodable PNG — Chrome has to be able to draw it. */
function png(w, h, [r, g, b]) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A deck that passes strict validation — the shape the model is asked for. */
function goodDeck(overrides = {}) {
  return {
    slug: "typing-ingredients",
    title: "Stop typing ingredients",
    angle: "problem-solution",
    hookId: "PS-06",
    ctaId: "CTA-01",
    capabilities: ["get_recipe_suggestion", "identify_scene"],
    slides: [
      { type: "hook", kicker: "Every recipe app", headline: "Fourteen ingredients, typed. Again.", image: { prompt: "an open refrigerator at night, eggs and half a lemon on a shelf, warm light spilling onto a kitchen floor" } },
      { type: "body", step: "THE USUAL WAY", headline: "Type it all in first", body: "Half a lemon. Parsley, probably fine. By the time it's typed you've lost interest." },
      { type: "body", step: "THE OTHER WAY", headline: "Point the camera and [[gold]]talk[[/gold]]", body: "Argus sees the shelf through your camera while you speak. No typing, no list." },
      { type: "quote", headline: "What that sounds like", turns: [{ who: "you", text: "Twenty minutes. What can I make?" }, { who: "argus", text: "Eggs, that lemon and the parsley — a herb omelette. Fifteen minutes." }] },
      { type: "split", headline: "The difference", before: "Open app. Type. Filter. Scroll. Order takeout.", after: "Open fridge. Ask. Cook." },
      { type: "body", step: "WORTH KNOWING", headline: "No account to make", body: "No sign-up, no password. Delete everything from inside the app whenever you like." },
      { type: "cta", headline: "Argus — free on iPhone", body: "No sign-up.", pill: { tiktok: "Search “My Argus” · App Store", instagram: "Link in bio" } },
    ],
    caption: { tiktok: "Stop typing ingredients into recipe apps. Point the camera, ask. Free on iPhone — search “My Argus” on the App Store.", instagram: "The fridge has everything. Point, ask, cook.\n\nFree on iPhone — link in bio.\n\nSend this to whoever asks what's for dinner." },
    hashtags: { tiktok: ["whatsfordinner", "cookingtips", "iphoneapps"], instagram: ["whatsfordinner", "weeknightdinner", "iphoneapp"] },
    ...overrides,
  };
}

before(async () => {
  data = mkdtempSync(join(tmpdir(), "argus-pipeline-test-"));
  mkdirSync(join(data, "decks"), { recursive: true });

  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ url: req.url, headers: req.headers, body });
    const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };

    if (body.generationConfig?.responseModalities?.includes("IMAGE")) {
      if (imageMode === "fail") return send(400, { error: { message: "Image generation blocked by safety filter" } });
      return send(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png(90, 160, [180, 120, 60]).toString("base64") } }] } }] });
    }
    const next = textReplies.shift();
    if (!next) return send(500, { error: { message: "fake: no reply queued" } });
    return send(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(next) }] }, finishReason: "STOP" }] });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  Object.assign(process.env, {
    MARKETING_DATA_DIR: data,
    GEMINI_API_BASE: `http://127.0.0.1:${server.address().port}`,
    MARKETING_GEMINI_API_KEY: KEY,
    DECKS_PER_DAY: "3",
  });
});

after(() => {
  server?.close();
  for (let i = 0; i < 10; i++) { try { rmSync(data, { recursive: true, force: true }); break; } catch { /* windows lock */ } }
});

/* ── validation ─────────────────────────────────────────────────────────── */

test("every hand-written deck still passes the renderer's checks", async () => {
  const { validateDeck } = await import("../lib/validate.mjs");
  const dir = join(MARKETING, "decks");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const errs = validateDeck(JSON.parse(readFileSync(join(dir, f), "utf8")), ["tiktok", "instagram"]);
    assert.deepEqual(errs, [], `${f}: ${errs.join("; ")}`);
  }
});

test("strict mode catches what a model gets wrong", async () => {
  const { validateDeck } = await import("../lib/validate.mjs");
  const v = (o) => validateDeck({ ...goodDeck(o), ct: "ps-2609" }, ["tiktok", "instagram"], { strict: true });

  assert.deepEqual(v({}), [], "the good deck is good");
  assert.ok(v({ hookId: "DM-05" }).some((e) => /not a live hook/.test(e)), "retired hook");
  assert.ok(v({ hookId: "PS-99" }).some((e) => /not a live hook/.test(e)), "invented hook");
  assert.ok(v({ hookId: "DM-01" }).some((e) => /does not belong to angle/.test(e)), "hook from another angle");
  assert.ok(v({ ctaId: "CTA-99" }).some((e) => /CTA library/.test(e)));
  assert.ok(v({ capabilities: ["web_search"] }).some((e) => /not on the verified list/.test(e)), "dormant tool");
  assert.ok(v({ capabilities: ["cooking_timer"] }).some((e) => /not on the verified list/.test(e)));

  const s = goodDeck().slides;
  const withSlide = (i, patch) => ({ slides: s.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  assert.ok(v(withSlide(1, { body: "It is powered by AI." })).some((e) => /never-use/.test(e)));
  assert.ok(v(withSlide(1, { body: "Set a timer and it will notify you." })).some((e) => /notifications/.test(e)));
  assert.ok(v(withSlide(0, { image: { prompt: "a phone screen showing the Argus app interface" } })).some((e) => /plain photographs/.test(e)), "a generated app screen is a fake demo");
  assert.ok(v(withSlide(0, { headline: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen" })).some((e) => /hook headline/.test(e)));
});

test("personal TikTok: 'link in bio' is refused for TikTok, allowed per-platform for Instagram", async () => {
  const { validateDeck } = await import("../lib/validate.mjs");
  const { forPlatform } = await import("../templates/render.mjs");
  const both = ["tiktok", "instagram"];
  const opts = { noBioLink: ["tiktok"] };
  const withCta = (pill, captionTt) => ({ ...goodDeck({ slides: goodDeck().slides.map((x) => (x.type === "cta" ? { ...x, body: "Free, iPhone.", pill } : x)), caption: { ...goodDeck().caption, tiktok: captionTt } }), ct: "ps-2609" });

  const shared = validateDeck(withCta("Link in bio", "Free on iPhone."), both, opts);
  assert.ok(shared.some((e) => /tiktok slides point to a bio link/.test(e)), "a shared 'Link in bio' pill would show on TikTok");

  const cap = validateDeck(withCta({ tiktok: "Search “My Argus”", instagram: "Link in bio" }, "Free on iPhone, link in bio."), both, opts);
  assert.ok(cap.some((e) => /caption\.tiktok points to a bio link/.test(e)));

  const ok = validateDeck(withCta({ tiktok: "Search “My Argus”", instagram: "Link in bio" }, "Free on iPhone — search “My Argus”."), both, opts);
  assert.deepEqual(ok, []);
  assert.deepEqual(validateDeck(withCta("Link in bio", "Free, link in bio."), both, { noBioLink: [] }), [], "a business account may say it");

  const cta = { type: "cta", headline: "Argus", pill: { tiktok: "Search", instagram: "Link in bio" } };
  assert.equal(forPlatform(cta, "tiktok").pill, "Search");
  assert.equal(forPlatform(cta, "instagram").pill, "Link in bio");
  assert.deepEqual(forPlatform({ turns: [{ who: "you", text: "hi" }] }, "tiktok"), { turns: [{ who: "you", text: "hi" }] }, "ordinary objects pass through");
});

test("every verified capability is a real tool in backend/agents.js", async () => {
  const agents = join(MARKETING, "..", "backend", "agents.js");
  if (!existsSync(agents)) return; // marketing deployed without the backend tree
  const { VERIFIED_CAPABILITIES } = await import("../lib/validate.mjs");
  const src = readFileSync(agents, "utf8");
  for (const c of VERIFIED_CAPABILITIES.filter((x) => x !== "intrinsic")) {
    assert.match(src, new RegExp(`name:\\s*["']${c}["']`), `${c} is on the verified list but not declared in agents.js`);
  }
});

/* ── writer ─────────────────────────────────────────────────────────────── */

const DAY1 = new Date(2026, 9, 3, 7, 0);   // 3 Oct 2026, local
const DAY2 = new Date(2026, 9, 4, 7, 0);

test("writer: a bad deck is sent back with its errors and the fixed one is written", async () => {
  const { writeDecks } = await import("../scripts/write-decks.mjs");
  calls = [];
  const bad = goodDeck({ slides: goodDeck().slides.map((x, i) => (i === 1 ? { ...x, body: "It's revolutionary." } : x)) });
  textReplies = [
    { decks: [bad, goodDeck({ slug: "label-squint", angle: "things-you-didnt-know", hookId: "TY-03", capabilities: ["read_text"] })] },
    { deck: goodDeck() },
  ];

  const res = await writeDecks({ count: 2, now: DAY1, log: () => {} });
  assert.deepEqual(res.written, ["261003-1-typing-ingredients", "261003-2-label-squint"]);
  assert.equal(res.dropped.length, 0);

  const repair = calls[1].body.contents[0].parts[0].text;
  assert.match(repair, /revolutionary/, "the repair prompt carries the actual error");

  const deck = JSON.parse(readFileSync(join(data, "decks", "261003-1-typing-ingredients.json"), "utf8"));
  assert.equal(deck.ct, "ps-2610", "campaign token is ours: angle + month");
  assert.equal(deck.generated.batch, "261003");
  assert.ok(!("slug" in deck));
  assert.equal(JSON.parse(readFileSync(join(data, "decks", "261003-2-label-squint.json"), "utf8")).ct, "ty-2610");

  assert.equal(calls[0].headers["x-goog-api-key"], KEY, "key goes in a header");
  assert.ok(!calls[0].url.includes(KEY), "key never in the URL");
});

test("writer: re-running the same day does nothing (idempotent)", async () => {
  const { writeDecks } = await import("../scripts/write-decks.mjs");
  calls = [];
  const res = await writeDecks({ now: DAY1, log: () => {} });
  assert.equal(res.skipped, true);
  assert.equal(calls.length, 0, "no model call, no spend");
});

test("writer: a deck that fails twice is dropped, never written; recent hooks are avoided", async () => {
  const { writeDecks } = await import("../scripts/write-decks.mjs");
  calls = [];
  const invented = goodDeck({ slug: "made-up", hookId: "PS-42" });
  textReplies = [{ decks: [invented] }, { deck: invented }, { deck: invented }];

  const res = await writeDecks({ count: 1, now: DAY2, log: () => {} });
  assert.deepEqual(res.written, []);
  assert.equal(res.dropped.length, 1);
  assert.ok(!existsSync(join(data, "decks", "261004-1-made-up.json")));
  assert.match(calls[0].body.contents[0].parts[0].text, /Do NOT use these hook ids[^\n]*PS-06/, "yesterday's hook is off the table");
});

/* ── images ─────────────────────────────────────────────────────────────── */

test("images: generated once, cached by prompt, and written into the deck", async () => {
  const { makeImages } = await import("../scripts/make-images.mjs");
  calls = [];
  imageMode = "ok";
  const r1 = await makeImages(["261003-1-typing-ingredients"], { log: () => {} });
  assert.equal(r1.generated, 1);
  const deck = JSON.parse(readFileSync(join(data, "decks", "261003-1-typing-ingredients.json"), "utf8"));
  assert.match(deck.slides[0].image.file, /^01-[0-9a-f]{8}\.png$/);
  assert.ok(existsSync(join(data, "assets", "261003-1-typing-ingredients", deck.slides[0].image.file)));
  assert.match(calls[0].body.contents[0].parts[0].text, /no legible text[\s\S]*phone screens/i, "the style guard is appended to every prompt");
  assert.equal(calls[0].body.generationConfig.imageConfig.aspectRatio, "9:16");

  calls = [];
  const r2 = await makeImages(["261003-1-typing-ingredients"], { log: () => {} });
  assert.equal(r2.reused, 1);
  assert.equal(calls.length, 0, "an unchanged prompt is never paid for twice");
});

test("images: a failed image drops the slot with a note instead of failing the deck", async () => {
  const { makeImages } = await import("../scripts/make-images.mjs");
  imageMode = "fail";
  const r = await makeImages(["261003-2-label-squint"], { log: () => {} });
  imageMode = "ok";
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /safety filter/);
  const deck = JSON.parse(readFileSync(join(data, "decks", "261003-2-label-squint.json"), "utf8"));
  assert.equal(deck.slides[0].image, undefined);
  assert.match(deck.generated.notes[0], /no image/);
});

/* ── render ─────────────────────────────────────────────────────────────── */

test("a generated deck with a photo renders PNG + JPEG for both platforms", () => {
  const r = spawnSync(process.execPath, [join(MARKETING, "scripts", "make-slideshow.mjs"), "261003-1-typing-ingredients"], {
    env: { ...process.env, MARKETING_DATA_DIR: data }, encoding: "utf8", timeout: 120_000,
  });
  if (/no Chrome\/Edge found/.test(r.stderr)) return; // no browser on this box
  assert.equal(r.status, 0, r.stderr || r.stdout);

  for (const p of ["tiktok", "instagram"]) {
    const files = readdirSync(join(data, "out", "261003-1-typing-ingredients", p));
    assert.equal(files.filter((f) => f.endsWith(".png")).length, 7);
    assert.equal(files.filter((f) => f.endsWith(".jpg")).length, 7, "TikTok's API needs the JPEG twins");
  }
  const html = readFileSync(join(data, "out", "261003-1-typing-ingredients", "tiktok", "_html", "01.html"), "utf8");
  assert.match(html, /class="bgimg"/, "the hook slide carries its photo");
  const manifest = JSON.parse(readFileSync(join(data, "out", "261003-1-typing-ingredients", "manifest.json"), "utf8"));
  assert.equal(manifest.aiImages, true);
});
