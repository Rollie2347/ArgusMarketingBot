#!/usr/bin/env node
/**
 * Rehearses a TikTok post on the REAL site without posting: builds the video,
 * uploads it in the posting browser, fills in the caption and the AI label,
 * then stops before Post and saves a screenshot.
 *
 *   node scripts/tiktok-dry-run.mjs                  # next scheduled TikTok post
 *   node scripts/tiktok-dry-run.mjs <deckId>:tiktok  # a specific one
 *   SOCIAL_SHOW_BROWSER=1 node scripts/tiktok-dry-run.mjs   # watch it happen
 *
 * TikTok keeps an unposted upload as a draft in TikTok Studio at most —
 * nothing is published. Touches no queue state.
 */

process.env.DRY_RUN = "1"; // before the publisher is imported — it reads this once
await import("../lib/env.mjs");
const { load, find } = await import("../bot/queue.mjs");
const { publish } = await import("../bot/publishers/tiktokweb.mjs");

const q = load();
const id = process.argv[2];
const item = id ? find(q, id) : q.items
  .filter((i) => i.platform === "tiktok" && i.status === "scheduled")
  .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor))[0];
if (!item) { console.error(`\n  ✗ no ${id ? `item ${id}` : "scheduled TikTok item"} found\n`); process.exit(1); }

console.log(`\n  rehearsing ${item.id} (nothing will be posted)…`);
try {
  const r = await publish(item);
  console.log(`  ✓ ${r.note}\n  screenshot: ${r.screenshot}\n`);
} catch (err) {
  console.error(`  ✗ ${err.message}\n  screenshot: ${err.screenshot || "(none)"}\n`);
  process.exit(1);
}
