#!/usr/bin/env node
/**
 * Checks the Upload-Post setup before anything is posted through it:
 *
 *   node scripts/check-uploadpost.mjs
 *
 * - the API key works
 * - the profile in UPLOADPOST_USER exists
 * - TikTok and Instagram are both connected to it, and under which usernames
 *   (they should be myargusai — a wrong account connected would post there)
 *
 * Read-only: posts nothing, changes nothing.
 */

import "../lib/env.mjs";
import { checkConnection } from "../bot/publishers/uploadpost.mjs";

const r = await checkConnection(["tiktok", "instagram"]);
if (r.error) {
  console.error(`\n  ✗ ${r.error}\n`);
  process.exit(1);
}
for (const [p, name] of Object.entries(r.connected)) console.log(`  ✓ ${p.padEnd(9)} connected as ${name}`);
for (const p of r.missing) console.log(`  ✗ ${p.padEnd(9)} NOT connected — connect it in app.upload-post.com under profile "${process.env.UPLOADPOST_USER}"`);
console.log(r.ok ? "\n  ready — set PUBLISH_TIKTOK=uploadpost and PUBLISH_INSTAGRAM=uploadpost, then restart the bot\n" : "");
process.exit(r.ok ? 0 : 1);
