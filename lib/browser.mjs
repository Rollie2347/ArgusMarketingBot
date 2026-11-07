/**
 * The posting browser: the real Chrome installed on this PC, with its OWN
 * profile (STATE_DIR/chrome-social — separate from your everyday Chrome) that
 * you log into TikTok with once (`npm run tiktok-login`). The session cookie
 * lives in that profile, so the bot never sees or stores a password.
 *
 * Headed, not headless: headless Chrome is the easiest automation for a site
 * to spot. The window opens OFF-SCREEN during a post (set SOCIAL_SHOW_BROWSER=1
 * to watch it), with background throttling off so an off-screen window still
 * runs at full speed.
 *
 * ⚠️ Automating a website is against TikTok's terms (automated access), and
 * an account can be flagged for it. This keeps the footprint small — your own
 * logged-in browser, a real Chrome build, one post at a time, human pacing —
 * but it cannot make the risk zero. Decided with that in mind on 2026-09-26.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.mjs";

export const PROFILE_DIR = join(STATE_DIR, "chrome-social");

export function findChrome() {
  if (process.env.ARGUS_CHROME && existsSync(process.env.ARGUS_CHROME)) return process.env.ARGUS_CHROME;
  const hit = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((p) => p && existsSync(p));
  if (!hit) throw new Error("Google Chrome not found — install it or set ARGUS_CHROME");
  return hit;
}

/**
 * @param {{visible?: boolean}} opts  visible: on-screen (for logging in)
 * @returns {Promise<import("playwright-core").BrowserContext>}
 */
export async function openBrowser({ visible = process.env.SOCIAL_SHOW_BROWSER === "1" } = {}) {
  const { chromium } = await import("playwright-core");
  mkdirSync(PROFILE_DIR, { recursive: true });
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: findChrome(),
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--window-size=1280,900",
        visible ? "--window-position=80,60" : "--window-position=-2600,-2600",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
  } catch (err) {
    if (/ProcessSingleton|profile.*in use|user data directory is already in use/i.test(err.message)) {
      throw new Error("the posting browser is already open (a login window or another post) — close it and retry");
    }
    throw err;
  }
}

/**
 * One posting-browser job at a time inside this process: Chrome allows one
 * instance per profile, so a /tiktoklogin arriving mid-post must wait for the
 * post, not crash it. Everything that opens the browser goes through here.
 */
let chain = Promise.resolve();
export function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Is the posting profile logged in to TikTok (session cookie present)? */
export async function tiktokSession(ctx) {
  const cookies = await ctx.cookies("https://www.tiktok.com");
  return cookies.some((c) => c.name === "sessionid" && c.value);
}

/**
 * Does TikTok itself accept the session? The cookie alone can't say: TikTok
 * revokes sessions server-side and leaves the cookie in place, unexpired
 * (2026-11-04). Opens TikTok Studio's upload page and checks it didn't bounce
 * to /login.
 */
export async function tiktokSessionLive(page) {
  await page.goto("https://www.tiktok.com/tiktokstudio/upload", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  return !/\/login/.test(page.url());
}

/** Morning check: open the posting browser just long enough to ask TikTok. */
export async function checkTiktokLogin() {
  return exclusive(async () => {
    const ctx = await openBrowser();
    try {
      return await tiktokSessionLive(ctx.pages()[0] || (await ctx.newPage()));
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/** Drop TikTok's cookies so a dead session can't pass for a fresh login. */
export async function clearTiktokSession(ctx) {
  await ctx.clearCookies({ domain: /(^|\.)tiktok\.com$/ });
}

/** Is the posting profile logged in to Instagram (session cookie present)? */
export async function instagramSession(ctx) {
  const cookies = await ctx.cookies("https://www.instagram.com");
  return cookies.some((c) => c.name === "sessionid" && c.value);
}

/**
 * Log the posting browser in to TikTok by QR code, from anywhere: the QR is
 * handed to onQr (the bot sends it to Telegram) and scanned with the TikTok
 * app. Re-sends a fresh QR if TikTok's expires. Resolves true once the
 * session cookie appears.
 *
 * @param {(png: Buffer, n: number) => Promise<void>} onQr
 */
export async function tiktokQrLogin(onQr, { timeoutMs = 5 * 60_000 } = {}) {
  return exclusive(async () => {
    const ctx = await openBrowser();
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      if (await tiktokSessionLive(page)) return "already";
      // Revoked session: its cookie would make the wait below succeed at once.
      await clearTiktokSession(ctx);
      await page.goto("https://www.tiktok.com/login/qrcode", { waitUntil: "domcontentloaded" });
      const qr = page.locator('[data-e2e="qr-code"] canvas, [data-e2e="qr-code"] img').first();
      await qr.waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForTimeout(1500); // let the canvas finish drawing
      let sent = 0;
      await onQr(await page.locator('[data-e2e="qr-code"]').first().screenshot(), ++sent);

      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (await tiktokSession(ctx)) {
          await page.waitForTimeout(3000);
          if (await tiktokSessionLive(page)) return true;
          throw new Error("the scan went through, but TikTok Studio's upload page still sends the posting browser to login");
        }
        // An expired QR shows a refresh control; click it and send the new one.
        const refresh = page.getByText(/refresh|qr code expired|expired/i).first();
        if (await refresh.isVisible().catch(() => false)) {
          await refresh.click().catch(() => {});
          await page.waitForTimeout(2500);
          if (sent < 4) await onQr(await page.locator('[data-e2e="qr-code"]').first().screenshot(), ++sent);
        }
        await page.waitForTimeout(2000);
      }
      return false;
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/** Human-ish pause. */
export const pause = (page, min = 400, max = 1200) => page.waitForTimeout(min + Math.floor(Math.random() * (max - min)));
