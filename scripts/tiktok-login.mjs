#!/usr/bin/env node
/**
 * One-time (and whenever TikTok logs the bot out): opens the posting browser
 * ON-SCREEN at TikTok's login page. Log in as myargusai the normal way —
 * password, QR code, whatever TikTok asks for. The window closes by itself
 * once you're in.
 *
 *   npm run tiktok-login          (from marketing/)
 *
 * Nothing about the login is read or stored by this script; the session lives
 * in the dedicated Chrome profile (lib/browser.mjs), like any browser login.
 * Stop the bot first (scripts/stop-bot.ps1) — one Chrome per profile.
 */

import "../lib/env.mjs";
import { openBrowser } from "../lib/browser.mjs";

const ctx = await openBrowser({ visible: true });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.tiktok.com/login", { waitUntil: "domcontentloaded" });
console.log("\n  A Chrome window is open at TikTok's login page. Log in as myargusai.");
console.log("  Waiting up to 15 minutes…\n");

const deadline = Date.now() + 15 * 60_000;
let ok = false;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies("https://www.tiktok.com");
  if (cookies.some((c) => c.name === "sessionid" && c.value)) { ok = true; break; }
  await page.waitForTimeout(2000).catch(() => {});
  if (!ctx.pages().length) break; // window closed by hand
}

if (ok) {
  // Confirm the upload page is reachable while logged in.
  await page.waitForTimeout(3000);
  await page.goto("https://www.tiktok.com/tiktokstudio/upload", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(4000);
  const onLogin = /\/login/.test(page.url());
  console.log(onLogin ? "  ⚠️ Logged in, but the upload page sent us back to login — try again." : "  ✓ Logged in, and TikTok Studio's upload page opens. The bot can post.");
}
else console.log("  ✗ No login detected — run this again when ready.");
await ctx.close().catch(() => {});
process.exit(ok ? 0 : 1);
