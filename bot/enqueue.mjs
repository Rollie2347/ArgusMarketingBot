#!/usr/bin/env node
/**
 * Load rendered decks into the approval queue.
 *
 *   node bot/enqueue.mjs                      # every rendered deck, every platform
 *   node bot/enqueue.mjs 01-fridge-stare      # one deck
 *   node bot/enqueue.mjs --platform tiktok    # one platform
 *   node bot/enqueue.mjs --list               # show the queue, change nothing
 *   node bot/enqueue.mjs --reset-rejected     # put rejected/changes items back to pending
 *
 * Reads out/<deck>/manifest.json, which make-slideshow.mjs writes. It does not
 * read decks/*.json — the queue is built from what was actually RENDERED, so
 * an edited deck that has not been regenerated cannot be queued by accident.
 *
 * Re-running is safe: an item that already exists is left exactly as it is,
 * whatever its status. Nothing here can re-deliver or un-publish anything.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR, DECKS_DIR } from "./config.mjs";
import { load, save, add, find, itemId, transition, summarize } from "./queue.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const optVal = (f) => { const i = argv.indexOf(`--${f}`); return i >= 0 ? argv[i + 1] : null; };
const onlyPlatform = optVal("platform");
const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--platform");

const q = load();

if (has("list")) {
  console.log(`\n${summarize(q)}\n`);
  process.exit(0);
}

// Items not yet decided pick up the deck's CURRENT copy and slide files —
// after a deck is edited and re-rendered (e.g. the 2026-09-26 switch of the
// TikTok CTA away from "link in bio"). Anything approved or later is left
// exactly as it was: that is the record of what was actually posted.
if (has("refresh")) {
  let n = 0;
  for (const item of q.items) {
    if (!["pending", "awaiting"].includes(item.status)) continue;
    const deckSrc = join(DECKS_DIR, `${item.deckId}.json`);
    const dir = join(OUT_DIR, item.deckId, item.platform);
    if (!existsSync(deckSrc) || !existsSync(dir)) { console.warn(`  ! ${item.id}: deck or render missing, left as is`); continue; }
    const deck = JSON.parse(readFileSync(deckSrc, "utf8"));
    const slideFiles = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    const jpgFiles = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();
    item.caption = deck.caption?.[item.platform] || item.caption;
    item.hashtags = (deck.hashtags?.[item.platform] || []).map((t) => (t.startsWith("#") ? t : `#${t}`));
    item.slideFiles = slideFiles;
    item.jpgFiles = jpgFiles.length === slideFiles.length ? jpgFiles : [];
    item.history.push({ status: item.status, at: new Date().toISOString(), note: "copy and slides refreshed from the current deck" });
    n++;
  }
  save(q);
  console.log(`\n  ✓ refreshed ${n} undecided item(s)\n`);
  process.exit(0);
}

if (has("reset-rejected")) {
  let n = 0;
  for (const item of q.items) {
    if (item.status === "rejected" || item.status === "changes_requested") {
      transition(item, "pending", { note: "reset by enqueue --reset-rejected" });
      n++;
    }
  }
  save(q);
  console.log(`\n  ✓ reset ${n} item(s) to pending\n`);
  process.exit(0);
}

if (!existsSync(OUT_DIR)) {
  console.error(`\n  ✗ no out/ directory — run "node scripts/make-slideshow.mjs" first\n`);
  process.exit(1);
}

const deckDirs = readdirSync(OUT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((d) => (names.length ? names.includes(d) : true))
  .sort();

if (!deckDirs.length) {
  console.error(`\n  ✗ no rendered decks matched${names.length ? ` ${names.join(", ")}` : ""}\n`);
  process.exit(1);
}

let added = 0, skipped = 0;

for (const deckId of deckDirs) {
  const manifestPath = join(OUT_DIR, deckId, "manifest.json");
  if (!existsSync(manifestPath)) { console.warn(`  ! ${deckId}: no manifest.json, skipping`); continue; }
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));

  // manifest.json holds captions only by reference, so read the deck source
  // for the copy. It is the one thing the manifest deliberately does not
  // duplicate, to avoid two copies of the caption drifting apart.
  const deckSrc = join(DECKS_DIR, `${deckId}.json`);
  const deck = existsSync(deckSrc) ? JSON.parse(readFileSync(deckSrc, "utf8")) : null;
  if (!deck) { console.warn(`  ! ${deckId}: decks/${deckId}.json missing, skipping`); continue; }

  for (const platform of m.platforms) {
    if (onlyPlatform && platform !== onlyPlatform) continue;

    const dir = join(OUT_DIR, deckId, platform);
    if (!existsSync(dir)) { console.warn(`  ! ${deckId}/${platform}: not rendered, skipping`); continue; }
    const slideFiles = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    if (!slideFiles.length) { console.warn(`  ! ${deckId}/${platform}: no PNGs, skipping`); continue; }
    // JPEG twins, for the API publishers (TikTok's photo API refuses PNG).
    // Absent for decks rendered before they existed or with --fallback;
    // publishers/uploadpost.mjs fails loudly rather than guessing.
    const jpgFiles = readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort();

    const link = m.links?.[platform] || {};
    const id = itemId(deckId, platform);

    const { added: wasAdded } = add(q, {
      id,
      deckId,
      platform,
      title: m.title || deckId,
      angle: m.angle,
      hookId: m.hookId,
      ctaId: m.ctaId || null,
      capabilities: m.capabilities || [],

      slideFiles,
      jpgFiles: jpgFiles.length === slideFiles.length ? jpgFiles : [],
      // Generated photographs → the platforms' AI-generated-content label.
      aiImages: Boolean(m.aiImages),
      // Written by the daily writer; notes say e.g. which image failed.
      generated: m.generated || null,
      caption: deck.caption?.[platform] || "",
      hashtags: (deck.hashtags?.[platform] || []).map((t) => (t.startsWith("#") ? t : `#${t}`)),

      // Attribution, carried from render through approval to the tracking log.
      ct: link.ct || null,
      trackingUrl: link.bio || null,
      storeUrl: link.store || null,

      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [{ status: "pending", at: new Date().toISOString() }],

      // Filled in later by the bot / the /posted command.
      deliveredMessageId: null,
      postId: null,
      postUrl: null,
      postedAt: null,
      reason: null,
    });

    if (wasAdded) { added++; console.log(`  + ${id}  (${m.angle}/${m.hookId}, ${slideFiles.length} slides)`); }
    else { skipped++; }
  }
}

save(q);
console.log(`\n  ✓ ${added} queued, ${skipped} already present\n`);
if (added) console.log(`  Start the bot to deliver them:  node bot/bot.mjs\n`);
