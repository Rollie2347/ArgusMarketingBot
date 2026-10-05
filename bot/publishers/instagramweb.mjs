/**
 * Instagram, posted automatically for free WITHOUT a Professional account: a
 * browser bot drives instagram.com's own "Create" dialog in the same real
 * Chrome profile the TikTok bot uses (lib/browser.mjs,
 * `npm run instagram-login`).
 *
 * Why this and not Instagram's API (instagram.mjs): the API only serves
 * Professional (Creator/Business) accounts, and Instagram wouldn't let
 * myargusai switch (2026-10-04). The website posts carousels from a personal
 * account.
 *
 * ⚠️ Against Instagram's terms (automated access), same as the TikTok bot, and
 * Instagram is the stricter of the two about it. See lib/browser.mjs for what
 * keeps the footprint small.
 *
 * ⚠️ The Create dialog is undocumented and changes. Every step looks for the
 * thing it needs in more than one way, and ANY failure throws with a
 * screenshot of the page at that moment (the bot sends it to Telegram).
 *
 * Two formats, from config.json `instagramFormat` (or INSTAGRAM_FORMAT):
 *   "reel"      the slides as a 9:16 slideshow VIDEO with a music track from
 *               assets/music/ mixed in (lib/video.mjs, lib/music.mjs). The
 *               website has no music picker at any step — checked on the real
 *               dialog 2026-10-04 — so sound has to be in the file.
 *   "carousel-sound"  swipeable AND with sound: a 4:5 carousel whose slides
 *               are short video clips of each slide over the music
 *               (lib/video.mjs makeSlideClips). A carousel may hold videos,
 *               and a video carries its own audio.
 *   "carousel"  the slides as a swipeable 4:5 photo post. Silent.
 *
 * Steps: open instagram.com → (logged-out or a security check? fail) → Create
 * → attach the slides → set the crop to 4:5 (the default is a SQUARE crop,
 * which cuts the top and bottom off every slide) → Next → Next → write the
 * caption → AI label ON (when the deck has generated photos) → Share → wait
 * for "Post shared".
 *
 * DRY_RUN=1 does everything except press Share, and returns a screenshot.
 */

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR, OUT_DIR } from "../config.mjs";
import { CONFIG_FILE } from "../../lib/paths.mjs";
import { openBrowser, pause, exclusive } from "../../lib/browser.mjs";
import { makeSlideshowVideo, makeSlideClips } from "../../lib/video.mjs";
import { pickTrack, rememberTrack } from "../../lib/music.mjs";

export const name = "instagramweb";

// Overridable only so bot/test/ can point it at a local imitation of the page.
const HOME_URL = process.env.INSTAGRAM_WEB_URL || "https://www.instagram.com/";
const DRY_RUN = process.env.DRY_RUN === "1";
const REQUIRE_AI_LABEL = process.env.INSTAGRAM_REQUIRE_AI_LABEL !== "0";
// The website's carousel limit (the app's is higher).
const MAX_PHOTOS = 10;

function format() {
  if (process.env.INSTAGRAM_FORMAT) return process.env.INSTAGRAM_FORMAT;
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")).instagramFormat || "carousel"; } catch { return "carousel"; }
}

class StepError extends Error {}

async function shot(page, tag) {
  const dir = join(STATE_DIR, "screenshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `instagram-${new Date().toISOString().replace(/[:.]/g, "-")}-${tag}.png`);
  try { await page.screenshot({ path: file }); return file; } catch { return null; }
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

/** Instagram's buttons are mostly <div role="button">; some are real buttons. */
const button = (scope, re) => scope.locator('button, [role="button"]').filter({ hasText: re });

/**
 * "Turn on notifications", "Save your login info?" and the like, which sit on
 * top of the page after a login. Only ever presses a declining button.
 */
async function clearPopups(page) {
  for (let round = 0; round < 3; round++) {
    const btn = await firstVisible(page, [(p) => button(p, /^not now$/i)], 1_200);
    if (!btn) break;
    await btn.click().catch(() => {});
    await page.waitForTimeout(800);
  }
}

export async function publish(item) {
  // One browser job at a time (a TikTok post or a login may be running).
  return exclusive(() => publishNow(item));
}

async function publishNow(item) {
  const reel = format() === "reel";
  const clips = format() === "carousel-sound";
  let photos = [], video = null, track = null;
  if (reel) {
    track = pickTrack();
    video = await makeSlideshowVideo(item, { music: track.path });
  } else if (clips) {
    track = pickTrack();
    // The dialog takes videos and photos through the same input.
    photos = (await makeSlideClips(item, { music: track.path })).paths;
    if (photos.length > MAX_PHOTOS) throw new Error(`Instagram's website takes at most ${MAX_PHOTOS} slides per post — this deck has ${photos.length}`);
  } else {
    const dir = join(OUT_DIR, item.deckId, item.platform);
    photos = (item.jpgFiles?.length ? item.jpgFiles : item.slideFiles).map((f) => join(dir, f));
    for (const f of photos) if (!existsSync(f)) throw new Error(`missing slide ${f}`);
    if (photos.length > MAX_PHOTOS) throw new Error(`Instagram's website takes at most ${MAX_PHOTOS} photos per post — this deck has ${photos.length}`);
  }
  const what = reel ? `${video.seconds}s reel with the music “${track.name}”`
    : clips ? `${photos.length}-slide swipeable carousel with the music “${track.name}”` : photos.length > 1 ? `${photos.length}-photo carousel` : "photo";
  // A reel is the full 9:16 frame; a carousel is 4:5. Either way the default
  // is a SQUARE crop, which cuts the slides.
  const CROP = reel ? "9:16" : "4:5";
  const caption = `${item.caption}\n\n${item.hashtags.join(" ")}`.trim();

  const ctx = await openBrowser();
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(30_000);
  let step = "opening Instagram";
  try {
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pause(page, 2500, 4000);
    if (/\/(challenge|accounts\/suspended|accounts\/disabled)/.test(page.url())) {
      throw new StepError("Instagram is asking for a security check on the posting browser — run `npm run instagram-login` on the PC and finish it there, then Retry.");
    }
    const loggedOut = /\/accounts\/login/.test(page.url()) ||
      (await page.locator('input[name="username"]').first().isVisible().catch(() => false));
    if (loggedOut) {
      throw new StepError("Instagram isn't logged in on the posting browser — run `npm run instagram-login` on the PC and log in as myargusai, then Retry.");
    }
    await clearPopups(page);

    step = "opening the Create dialog";
    const create = await firstVisible(page, [
      (p) => p.locator('a, [role="link"], [role="button"]').filter({ has: p.locator('svg[aria-label="New post"]') }),
      (p) => p.getByRole("link", { name: /^(new post|create)$/i }),
      (p) => p.locator('a, [role="link"], [role="button"]').filter({ hasText: /^create$/i }),
    ], 30_000);
    if (!create) throw new StepError("couldn't find the Create (New post) button in Instagram's sidebar");
    await create.click();
    const input = page.locator('[role="dialog"] input[type="file"]').first();
    // Create sometimes opens a small menu (Post / Live video / Ad) first.
    if (!(await input.waitFor({ state: "attached", timeout: 4_000 }).then(() => true, () => false))) {
      const post = await firstVisible(page, [
        (p) => p.locator('a, [role="link"], [role="button"], [role="menuitem"]').filter({ has: p.locator('svg[aria-label="Post"]') }),
        (p) => p.locator('a, [role="link"], [role="button"], [role="menuitem"]').filter({ hasText: /^post$/i }),
      ], 6_000);
      if (post) await post.click();
    }

    step = reel ? "attaching the video" : clips ? "attaching the slide clips" : "attaching the photos";
    await input.waitFor({ state: "attached", timeout: 30_000 });
    await input.setInputFiles(reel ? video.path : photos);
    if (reel || clips) {
      // "Video posts are now shared as reels" — a one-button notice.
      const ok = await firstVisible(page, [(p) => button(p.locator('[role="dialog"]'), /^ok$/i)], 6_000);
      if (ok) { await ok.click().catch(() => {}); await pause(page); }
    }
    const dialog = page.locator('[role="dialog"]').filter({ has: page.locator('button, [role="button"]') }).last();
    const next = () => firstVisible(page, [(p) => button(p.locator('[role="dialog"]'), /^next$/i)], 60_000);
    if (!(await next())) throw new StepError(`Instagram didn't move on to the crop step after the ${reel ? "video was" : "photos were"} attached`);
    await pause(page, 1200, 2200);

    step = `setting the crop to ${CROP}`;
    // Without this every slide is cropped square. The choice applies to the
    // whole carousel.
    const cropBtn = await firstVisible(page, [
      (p) => p.locator('[role="dialog"]').locator('button, [role="button"]').filter({ has: p.locator('svg[aria-label="Select crop"], svg[aria-label="Select Crop"]') }),
      (p) => p.locator('[role="dialog"] [aria-label="Select crop" i]'),
    ], 15_000);
    if (!cropBtn) throw new StepError("couldn't find the crop button — refusing to post, the default square crop would cut the slides");
    await cropBtn.click();
    // On the real page (2026-10-04) the options are plain text + an icon, not buttons.
    const ratio = await firstVisible(page, [
      (p) => button(p.locator('[role="dialog"]'), new RegExp(`^${CROP}$`)),
      (p) => p.locator('[role="dialog"]').getByText(CROP, { exact: true }),
    ], 8_000);
    if (!ratio) throw new StepError(`the crop menu has no ${CROP} option — refusing to post, the default square crop would cut the slides`);
    await ratio.click();
    await pause(page);

    step = "moving on to the caption";
    const captionBox = () => firstVisible(page, [
      (p) => p.locator('[role="dialog"] [aria-label="Write a caption..." i]'),
      (p) => p.locator('[role="dialog"] [contenteditable="true"]'),
      (p) => p.locator('[role="dialog"] textarea'),
    ], 2_500);
    let editor = null;
    // Crop → Edit (filters) → caption: two Nexts today; allow one more.
    for (let i = 0; i < 3 && !editor; i++) {
      const n = await next();
      if (!n) break;
      await n.click();
      await pause(page, 1200, 2200);
      editor = await captionBox();
    }
    if (!editor) throw new StepError("never reached the caption step");

    step = "writing the caption";
    await editor.click();
    // Hashtags typed one at a time: each "#" opens Instagram's suggestion
    // list, and a space after the word closes it without picking a suggestion.
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
    }
    await pause(page);
    const typed = ((await editor.innerText().catch(() => "")) || (await editor.inputValue().catch(() => ""))).replace(/\s+/g, " ");
    const want = body.split("\n")[0].slice(0, 30).replace(/\s+/g, " ");
    if (!typed.includes(want)) throw new StepError(`the caption didn't take (expected it to start "${want}")`);

    let labelled = false;
    if (item.aiImages) {
      step = "turning on the AI label";
      // Seen on the real page 2026-10-04: a row "Add AI label" ("required for
      // realistic photos and videos made with AI") holding
      // <input role="switch" type="checkbox" aria-checked>.
      const text = page.getByText("Add AI label", { exact: true });
      const sw = page.locator('[role="dialog"] div').filter({ has: text }).filter({ has: page.locator('input[role="switch"]') })
        .last().locator('input[role="switch"]').first();
      const on = async () => (await sw.getAttribute("aria-checked").catch(() => null)) === "true" || (await sw.isChecked().catch(() => false));
      if (await sw.count().catch(() => 0)) {
        await sw.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
        if (!(await on())) {
          await sw.click({ timeout: 5_000 }).catch(() => sw.click({ force: true, timeout: 5_000 }).catch(() => {}));
          await pause(page);
        }
        if (!(await on())) throw new StepError("the AI label switch wouldn't turn on");
        labelled = true;
      } else if (REQUIRE_AI_LABEL) {
        throw new StepError("couldn't find the Add AI label switch, and this deck has generated photos (Instagram requires the label). Set INSTAGRAM_REQUIRE_AI_LABEL=0 only if you'll add it by hand.");
      }
    }

    const share = await firstVisible(page, [(p) => button(p.locator('[role="dialog"]'), /^share$/i)], 10_000);
    if (!share) throw new StepError("couldn't find the Share button");

    if (DRY_RUN) {
      const file = await shot(page, "dry-run");
      return { published: false, postId: null, url: null, screenshot: file,
        note: `DRY RUN — ${what} attached, cropped to ${CROP}, caption filled in${labelled ? ", AI label on" : ""}, stopped before Share. Screenshot attached: check it looks right.` };
    }

    step = "pressing Share";
    await pause(page, 800, 1600);
    await share.click();

    step = "waiting for Instagram to accept the post";
    // A video is uploaded and processed after Share, so it takes longer.
    const SHARE_WAIT = reel || clips ? 480_000 : 180_000;
    const done = await Promise.race([
      page.getByText(/((post|reel) shared|your (post|reel) has been shared)/i).first().waitFor({ timeout: SHARE_WAIT }).then(() => "shared"),
      dialog.getByText(/(couldn.t be shared|could not be shared|post couldn.t|try again later|something went wrong)/i).first()
        .waitFor({ timeout: SHARE_WAIT }).then(() => "error"),
    ]).catch(() => null);
    if (done === "error") throw new StepError("Instagram showed an error after Share — CHECK THE ACCOUNT before retrying");
    if (!done) throw new StepError(`no confirmation from Instagram within ${SHARE_WAIT / 60_000} minutes after Share — CHECK THE ACCOUNT before retrying, it may have posted`);

    if (track) rememberTrack(track.name);
    return { published: true, postId: null, url: null,
      note: `Posted to Instagram as a ${what} via the website. Add the link with /posted when you see it.` };
  } catch (err) {
    const e = new Error(`instagram web (${step}): ${err instanceof StepError ? err.message : err.message.split("\n")[0]}`);
    e.screenshot = await shot(page, "failed");
    throw e;
  } finally {
    await ctx.close().catch(() => {});
  }
}
