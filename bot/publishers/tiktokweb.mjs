/**
 * TikTok, posted automatically for free: a browser bot drives TikTok Studio's
 * upload page (tiktok.com/tiktokstudio/upload) in a real Chrome you are
 * logged into (lib/browser.mjs, `npm run tiktok-login`).
 *
 * Why this and not TikTok's API: the API makes every post from an unaudited
 * app private (SELF_ONLY), and the audit isn't granted to one-person tools.
 *
 * Two formats, from config.json `tiktokFormat` (or TIKTOK_FORMAT):
 *   "carousel"  the slides as a swipeable PHOTO post, with a sound from
 *               TikTok's own picker. The upload page grew a Photos tab and an
 *               "Add sound" button — seen on the real page 2026-10-04; before
 *               that the website was video-only.
 *   "video"     the slides as a slideshow video (lib/video.mjs), no sound.
 *               The fallback if TikTok takes the Photos tab away again.
 *
 * ⚠️ Against TikTok's terms (automated access). Accepted 2026-09-26 with that
 * known. See lib/browser.mjs for what keeps the footprint small.
 *
 * ⚠️ TikTok's upload page is undocumented and changes. Every step looks for
 * the thing it needs in more than one way, and ANY failure throws with a
 * screenshot of the page at that moment (the bot sends it to Telegram) — so
 * when TikTok changes the page, the fix starts from a picture, not a guess.
 *
 * Steps: open upload page → (logged-out? fail) → attach the photos (or the
 * MP4) → wait for the upload → replace the caption → add a sound (carousel)
 * → AI-generated label ON (when the deck has generated photos) → check it
 * isn't private → Post → confirm → wait for TikTok to accept it.
 *
 * DRY_RUN=1 does everything except press Post, and returns a screenshot.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, OUT_DIR } from "../config.mjs";
import { CONFIG_FILE } from "../../lib/paths.mjs";
import { openBrowser, pause, exclusive } from "../../lib/browser.mjs";
import { makeSlideshowVideo } from "../../lib/video.mjs";

export const name = "tiktokweb";

// Overridable only so bot/test/ can point it at a local imitation of the page.
const UPLOAD_URL = process.env.TIKTOK_UPLOAD_URL || "https://www.tiktok.com/tiktokstudio/upload?from=webapp";
const DRY_RUN = process.env.DRY_RUN === "1";
const REQUIRE_AI_LABEL = process.env.TIKTOK_REQUIRE_AI_LABEL !== "0";
const REQUIRE_SOUND = process.env.TIKTOK_REQUIRE_SOUND !== "0";
// How many recent posts' sounds to avoid repeating.
const SOUND_MEMORY = 10;
const SOUNDS_FILE = join(STATE_DIR, "tiktok-sounds.json");

function format() {
  if (process.env.TIKTOK_FORMAT) return process.env.TIKTOK_FORMAT;
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")).tiktokFormat || "carousel"; } catch { return "carousel"; }
}

function recentSounds() {
  try { return JSON.parse(readFileSync(SOUNDS_FILE, "utf8")).slice(-SOUND_MEMORY); } catch { return []; }
}

class StepError extends Error {}

async function shot(page, tag) {
  const dir = join(STATE_DIR, "screenshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `tiktok-${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); return file; } catch { return null; }
}

/** First locator (of several ways to find a thing) that becomes visible. */
async function firstVisible(page, candidates, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const make of candidates) {
      const loc = make(page).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await page.waitForTimeout(400);
  }
  return null;
}

/**
 * First-run and occasional pop-ups that sit on top of the form and swallow
 * clicks. Seen on the real page 2026-09-27:
 *   - "Turn on automatic content checks?" (music copyright + For You
 *     eligibility) — answered "Turn on": those checks only protect the post
 *   - "New editing features added" — a react-joyride tutorial tooltip
 *     (role="alertdialog") with "Got it", over a click-swallowing overlay
 * Anything else that looks like a one-button acknowledgement is dismissed.
 * Tutorials can have several steps, hence the rounds.
 */
async function clearPopups(page) {
  const clicked = [];
  for (let round = 0; round < 6; round++) {
    const dialog = page.locator('[role="dialog"], [role="alertdialog"], .react-joyride__tooltip, .TUXModal, [class*="modal" i]')
      .filter({ has: page.locator("button") }).first();
    if (!(await dialog.isVisible().catch(() => false))) break;
    const text = (await dialog.innerText().catch(() => "")).slice(0, 200);
    const btn = await firstVisible(dialog, [
      (d) => d.getByRole("button", { name: /^turn on$/i }),
      (d) => d.getByRole("button", { name: /^(got it|ok|okay|continue|i understand|not now|skip|close)$/i }),
    ], 1_500);
    if (!btn) break; // an unknown dialog — leave it; the next step's failure screenshot will show it
    const label = (await btn.innerText().catch(() => "?")).trim();
    await btn.click().catch(() => {});
    clicked.push(`${label} (${text.split("\n")[0]})`);
    await page.waitForTimeout(800);
  }
  return clicked;
}

async function isOn(sw) {
  const aria = await sw.getAttribute("aria-checked").catch(() => null);
  if (aria !== null) return aria === "true";
  const state = await sw.getAttribute("data-state").catch(() => null);
  if (state !== null) return state === "checked";
  return sw.isChecked().catch(() => false);
}

/**
 * Adds a sound from TikTok's picker ("Add sound" → the For You list, which is
 * what TikTok recommends to this account right now — the website has no
 * separate Trending tab). Picks the first track that isn't somebody's
 * "original sound" (unvetted audio from a random post: could be speech, could
 * be anything) and wasn't used in the last few posts; relaxes those in that
 * order rather than post silent.
 *
 * @returns {Promise<string>} the sound's title
 */
async function addSound(page) {
  const add = await firstVisible(page, [(p) => p.getByRole("button", { name: /^add sound$/i })], 15_000);
  if (!add) throw new StepError("couldn't find the Add sound button");
  await add.click();
  const picker = page.locator(".MusicPickerView__root, [class*='MusicPicker']").first();
  const rows = picker.locator('[role="listitem"]');
  await rows.first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  await pause(page, 1200, 2200);

  const titles = [];
  for (const row of await rows.all()) {
    const t = await row.locator('[class*="Title"]').first().innerText({ timeout: 2_000 }).catch(() => "");
    titles.push((t || (await row.innerText({ timeout: 2_000 }).catch(() => "")).split("\n")[0]).trim());
  }
  if (!titles.some(Boolean)) throw new StepError("the sound picker opened with no sounds in it");
  const recent = recentSounds();
  const original = (t) => /^original sound\b/i.test(t);
  const want = [
    (t) => t && !original(t) && !recent.includes(t),
    (t) => t && !original(t),
    (t) => t && !recent.includes(t),
    (t) => t,
  ];
  let pick = -1;
  for (const ok of want) { pick = titles.findIndex(ok); if (pick >= 0) break; }
  const title = titles[pick];

  await rows.nth(pick).getByRole("button", { name: /^use$/i }).click();
  // Chosen = the picker closes and the Sound row offers "Replace" instead of "Add sound".
  const replaced = await firstVisible(page, [(p) => p.getByRole("button", { name: /^replace$/i })], 15_000);
  if (!replaced) throw new StepError(`picked the sound "${title}" but the form didn't take it`);
  return title;
}

function rememberSound(title) {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(SOUNDS_FILE, JSON.stringify([...recentSounds(), title].slice(-SOUND_MEMORY), null, 2), "utf8"); } catch { /* only costs a repeat */ }
}

export async function publish(item) {
  // One browser job at a time (a /tiktoklogin may be running).
  return exclusive(() => publishNow(item));
}

async function publishNow(item) {
  const carousel = format() !== "video";
  let video = null, photos = [];
  if (carousel) {
    // JPEG: the Photos tab takes JPG/PNG/WebP, and the JPEGs are a tenth the size.
    const dir = join(OUT_DIR, item.deckId, item.platform);
    photos = (item.jpgFiles?.length ? item.jpgFiles : item.slideFiles).map((f) => join(dir, f));
    for (const f of photos) if (!existsSync(f)) throw new Error(`missing slide ${f}`);
    if (photos.length > 35) throw new Error(`TikTok takes at most 35 photos per post — this deck has ${photos.length}`);
  } else {
    video = await makeSlideshowVideo(item);
  }
  const what = carousel ? `${photos.length}-photo carousel` : `${video.seconds}s slideshow video`;
  let sound = null;
  const caption = `${item.caption}\n\n${item.hashtags.join(" ")}`.trim();

  const ctx = await openBrowser();
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30_000);
  let step = "opening the upload page";
  try {
    await page.goto(carousel ? `${UPLOAD_URL}${UPLOAD_URL.includes("?") ? "&" : "?"}tab=photo` : UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pause(page, 2500, 4000);
    if (/\/login/.test(page.url())) {
      throw new StepError("TikTok isn't logged in on the posting browser — send /tiktoklogin here and scan the QR code with the TikTok app, then Retry.");
    }

    if (carousel) {
      step = "switching to the Photos tab";
      // ?tab=photo normally lands on it; the click covers a page that ignores it.
      const tab = await firstVisible(page, [(p) => p.getByRole("tab", { name: /^photos$/i })], 30_000);
      if (!tab) throw new StepError('the upload page has no Photos tab — TikTok may have removed photo posts from the website. Set "tiktokFormat": "video" in config.json to go back to slideshow videos.');
      if ((await tab.getAttribute("aria-selected").catch(() => null)) !== "true") { await tab.click(); await pause(page); }

      step = "attaching the photos";
      const input = page.locator('input[type="file"][accept*="image"]').first();
      await input.waitFor({ state: "attached", timeout: 45_000 });
      await input.setInputFiles(photos);
    } else {
      step = "attaching the video";
      const input = page.locator('input[type="file"]').first();
      await input.waitFor({ state: "attached", timeout: 45_000 });
      await input.setInputFiles(video.path);
    }

    step = "waiting for the upload to finish";
    const post = await firstVisible(page, [
      (p) => p.locator('button[data-e2e="post_video_button"]'),
      (p) => p.getByRole("button", { name: /^post$/i }),
    ], 90_000);
    if (!post) throw new StepError(`the Post button never appeared after attaching the ${carousel ? "photos" : "video"}`);
    const uploadUntil = Date.now() + 5 * 60_000;
    while (Date.now() < uploadUntil) {
      const disabled = (await post.isDisabled().catch(() => true)) ||
        (await post.getAttribute("data-disabled").catch(() => null)) === "true" ||
        (await post.getAttribute("aria-disabled").catch(() => null)) === "true";
      if (!disabled) break;
      await page.waitForTimeout(1500);
    }
    if (await post.isDisabled().catch(() => true)) throw new StepError("the upload didn't finish within 5 minutes (Post stayed disabled)");
    await pause(page, 1500, 2500);

    step = "writing the caption";
    await clearPopups(page);
    const editor = await firstVisible(page, [
      (p) => p.locator('.public-DraftEditor-content[contenteditable="true"]'),
      (p) => p.locator('[data-e2e="caption_container"] [contenteditable="true"]'),
      (p) => p.locator('div[contenteditable="true"]'),
    ], 20_000);
    if (!editor) throw new StepError("couldn't find the caption box");
    await editor.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await pause(page, 300, 600);
    // Hashtags typed one at a time: each "#" opens TikTok's suggestion list,
    // and a space after the word closes it without picking a suggestion.
    const [body, tags = ""] = caption.split(/\n\n(?=#)/);
    for (const line of body.split("\n")) {
      await page.keyboard.type(line, { delay: 12 });
      await page.keyboard.press("Shift+Enter");
    }
    await page.keyboard.press("Shift+Enter");
    for (const tag of tags.split(/\s+/).filter(Boolean)) {
      await page.keyboard.type(tag, { delay: 40 });
      await page.waitForTimeout(700);
      await page.keyboard.type(" ");
      await page.keyboard.press("Escape").catch(() => {});
    }
    await pause(page);
    const typed = (await editor.innerText().catch(() => "")).replace(/\s+/g, " ");
    const want = body.split("\n")[0].slice(0, 30).replace(/\s+/g, " ");
    if (!typed.includes(want)) throw new StepError(`the caption didn't take (expected it to start "${want}")`);

    if (carousel) {
      step = "adding a sound";
      await clearPopups(page);
      try {
        sound = await addSound(page);
      } catch (err) {
        if (REQUIRE_SOUND) throw new StepError(`${err.message.split("\n")[0]} — set TIKTOK_REQUIRE_SOUND=0 to post without one`);
        // Don't leave the picker open over the rest of the form.
        await page.keyboard.press("Escape").catch(() => {});
      }
      await pause(page);
    }

    if (item.aiImages) {
      step = "turning on the AI-generated content label";
      await clearPopups(page);
      const more = await firstVisible(page, [(p) => p.getByText(/^show more$/i), (p) => p.getByText(/more options|advanced settings/i)], 5_000);
      if (more) { await more.click().catch(() => {}); await pause(page); }
      // TikTok's switches (seen 2026-09-27): a visible `.Switch__content`
      // carrying aria-checked/data-state, wrapping an INVISIBLE
      // `input[role=switch]` (appearance:none, tabindex -1) that can't be
      // clicked. So: the innermost block holding both the label and a switch,
      // and click the visible part.
      const label = page.getByText("AI-generated content", { exact: true });
      await label.first().waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
      const row = page.locator("div").filter({ has: label }).filter({ has: page.locator('.Switch__content, [role="switch"]') }).last();
      let sw = row.locator(".Switch__content").first();
      if (!(await sw.count().catch(() => 0))) sw = row.locator('[role="switch"]').first();
      // It sits in a collapsed section on the real page; present but hidden
      // counts as not found (clicking it would just time out).
      await sw.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
      if (await sw.isVisible().catch(() => false)) {
        if (!(await isOn(sw))) {
          await sw.click();
          const confirm = await firstVisible(page, [(p) => p.getByRole("button", { name: /turn on/i })], 4_000);
          if (confirm) await confirm.click();
          await pause(page);
        }
        if (!(await isOn(sw))) throw new StepError("the AI-generated content switch wouldn't turn on");
      } else if (REQUIRE_AI_LABEL) {
        throw new StepError("couldn't find the AI-generated content switch, and this deck has generated photos (TikTok requires the label). Set TIKTOK_REQUIRE_AI_LABEL=0 only if you'll add it by hand.");
      }
    }

    step = "checking who can view it";
    await clearPopups(page);
    const privateHint = await firstVisible(page, [(p) => p.getByText(/^(only me|only you|private)$/i)], 2_000);
    if (privateHint) throw new StepError("the post is set to private (Only me) — change the account's default to Everyone");

    if (DRY_RUN) {
      const file = await shot(page, "dry-run");
      return { published: false, postId: null, url: null, screenshot: file,
        note: `DRY RUN — ${what} uploaded${sound ? `, sound “${sound}” added` : ""}, caption and settings filled in, stopped before Post. Screenshot attached: check it looks right.` };
    }

    step = "pressing Post";
    await clearPopups(page);
    // Error-looking text already on the page (help copy, an old banner) must
    // not be read as "the post failed" — that would invite a double post.
    const errorText = /(couldn.t post|could not post|failed to post|try again later|too many requests)/i;
    const errorAlreadyShown = await page.getByText(errorText).first().isVisible().catch(() => false);
    await post.scrollIntoViewIfNeeded().catch(() => {});
    await pause(page, 800, 1600);
    await post.click();
    // TikTok sometimes asks to confirm while its content checks still run.
    const postNow = await firstVisible(page, [(p) => p.getByRole("button", { name: /^post now$/i })], 6_000);
    if (postNow) await postNow.click();

    step = "waiting for TikTok to accept the post";
    const done = await Promise.race([
      page.waitForURL(/tiktokstudio\/content|\/manage|\/creator/i, { timeout: 120_000 }).then(() => "moved"),
      page.getByText(/(your (video|photos?|post) (has|have|is|are) (been |being )?(uploaded|posted|published)|(video|photos?|post) published|posted successfully)/i).first()
        .waitFor({ timeout: 120_000 }).then(() => "toast"),
      ...(errorAlreadyShown ? [] : [page.getByText(errorText).first().waitFor({ timeout: 120_000 }).then(() => "error")]),
    ]).catch(() => null);
    if (done === "error") throw new StepError("TikTok showed an error after Post — CHECK THE ACCOUNT before retrying");
    if (!done) throw new StepError("no confirmation from TikTok within 2 minutes after Post — CHECK THE ACCOUNT before retrying, it may have posted");

    if (sound) rememberSound(sound);
    return { published: true, postId: null, url: null,
      note: `Posted to TikTok as a ${what}${sound ? ` with the sound “${sound}”` : ""} via the website. Add the link with /posted when you see it.` };
  } catch (err) {
    const e = new Error(`tiktok web (${step}): ${err instanceof StepError ? err.message : err.message.split("\n")[0]}`);
    e.screenshot = await shot(page, "failed");
    throw e;
  } finally {
    await ctx.close().catch(() => {});
  }
}
