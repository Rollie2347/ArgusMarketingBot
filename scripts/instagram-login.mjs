#!/usr/bin/env node
/**
 * One-time (and whenever Instagram logs the bot out or asks for a security
 * check): opens the posting browser ON-SCREEN at Instagram's login page. Log
 * in as myargusai the normal way — password, code, whatever Instagram asks
 * for. The window closes by itself once you're in.
 *
 *   npm run instagram-login          (from marketing/)
 *
 * Nothing about the login is read or stored by this script; the session lives
 * in the dedicated Chrome profile (lib/browser.mjs), like any browser login.
 * It fails with "already open" if the bot is mid-post — wait a minute and
 * run it again.
 */

import "../lib/env.mjs";
import { openBrowser, instagramSession } from "../lib/browser.mjs";

const ctx = await openBrowser({ visible: true });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded" });
console.log("\n  A Chrome window is open at Instagram's login page. Log in as myargusai.");
console.log("  Waiting up to 15 minutes…\n");

const deadline = Date.now() + 15 * 60_000;
let ok = false;
while (Date.now() < deadline) {
  // The cookie appears before a two-factor or "is this you?" step is done, so
  // also wait until Instagram has left its login and challenge pages.
  if ((await instagramSession(ctx)) && !/\/(accounts\/login|challenge|two_factor)/.test(page.url())) { ok = true; break; }
  await page.waitForTimeout(2000).catch(() => {});
  if (!ctx.pages().length) break; // window closed by hand
}

if (ok) {
  await page.waitForTimeout(4000); // let Instagram finish writing its cookies
  console.log("  ✓ Logged in. Rehearse a post with: node scripts/instagram-dry-run.mjs");
}
else console.log("  ✗ No login detected — run this again when ready.");
await ctx.close().catch(() => {});
process.exit(ok ? 0 : 1);
