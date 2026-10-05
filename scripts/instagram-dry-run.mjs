#!/usr/bin/env node
/**
 * Rehearses an Instagram post on the REAL site without posting: attaches the
 * slides in the posting browser, sets the crop, fills in the caption, then
 * stops before Share and saves a screenshot.
 *
 *   node scripts/instagram-dry-run.mjs                     # the newest Instagram item
 *   node scripts/instagram-dry-run.mjs <deckId>:instagram  # a specific one
 *   SOCIAL_SHOW_BROWSER=1 node scripts/instagram-dry-run.mjs   # watch it happen
 *
 * Closing the dialog unshared discards it — nothing is published. Touches no
 * queue state.
 */

process.env.DRY_RUN = "1"; // before the publisher is imported — it reads this once
await import("../lib/env.mjs");
const { load, find } = await import("../bot/queue.mjs");
const { publish } = await import("../bot/publishers/instagramweb.mjs");

const q = load();
const id = process.argv[2];
const item = id ? find(q, id) : q.items
  .filter((i) => i.platform === "instagram")
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
if (!item) { console.error(`\n  ✗ no ${id ? `item ${id}` : "Instagram item"} found\n`); process.exit(1); }

console.log(`\n  rehearsing ${item.id} (nothing will be posted)…`);
try {
  const r = await publish(item);
  console.log(`  ✓ ${r.note}\n  screenshot: ${r.screenshot}\n`);
} catch (err) {
  console.error(`  ✗ ${err.message}\n  screenshot: ${err.screenshot || "(none)"}\n`);
  process.exit(1);
}
