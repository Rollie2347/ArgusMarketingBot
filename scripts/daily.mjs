#!/usr/bin/env node
/**
 * One day's batch, end to end, up to the approval gate:
 *
 *   standards check → trend scout → write-decks → make-images → make-slideshow → enqueue
 *
 *   node scripts/daily.mjs            # today's batch (idempotent — re-running resumes it)
 *   node scripts/daily.mjs --force    # an extra batch today
 *
 * The approval bot runs this on its own at DAILY_RUN_AT and on /generate; it
 * can also be run by hand or from any scheduler. Nothing here publishes
 * anything — it ends with the decks queued as `pending`, and the bot delivers
 * them to Telegram.
 *
 * Idempotent by design: a batch that died halfway (network, a Chrome crash)
 * is finished by running this again — the writer sees today's decks already
 * exist, images already generated are reused, and enqueue skips anything
 * already in the queue. A deck that is already in the queue is not rendered
 * again: rendering deletes and rewrites its slide files, and by then the deck
 * may be mid-publish (2026-10-07: a re-run did exactly that and five posts
 * failed on missing slides).
 *
 * The last line of output is `DAILY_RESULT {json}` — the bot parses that
 * rather than scraping the human-readable log.
 */

import "../lib/env.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { MARKETING_ROOT, STATE_DIR, CONFIG_FILE } from "../lib/paths.mjs";
import { standardsProblems } from "../lib/standards.mjs";
import { writeDecks, existingBatch, batchStamp } from "./write-decks.mjs";
import { scoutTrends } from "../lib/trends.mjs";
import { makeImages } from "./make-images.mjs";
import { redact } from "../lib/gemini.mjs";

function run(script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(MARKETING_ROOT, script), ...args], { cwd: MARKETING_ROOT, env: process.env });
    const out = [];
    p.stdout.on("data", (b) => { out.push(String(b)); process.stdout.write(b); });
    p.stderr.on("data", (b) => { out.push(String(b)); process.stderr.write(b); });
    p.on("exit", (code) => resolve({ code, out: out.join("") }));
  });
}

/** Decks that have been through this pipeline already and belong to the bot now. */
function queuedDecks() {
  try { return new Set(JSON.parse(readFileSync(join(STATE_DIR, "queue.json"), "utf8")).items.map((i) => i.deckId)); }
  catch { return new Set(); }
}

export async function daily({ force = false } = {}) {
  const result = { ok: false, decks: [], dropped: [], imageFailures: [], error: null };
  try {
    // Three a day, a meme on slide 1, swipeable, with sound, on both
    // platforms: if a setting has drifted from that, make nothing and say so.
    const off = standardsProblems(JSON.parse(readFileSync(CONFIG_FILE, "utf8")));
    if (off.length) throw new Error(`the posting settings are off Rollie's standing rule — nothing was made:\n${off.map((o) => `• ${o}`).join("\n")}`);

    // What people are captioning things with this week — before the writer,
    // which reads the result. A failed scout never fails the day (the writer
    // falls back to the last good list, then to the evergreen formats), and a
    // resumed run whose decks are already written doesn't scout at all.
    if (force || !existingBatch(batchStamp().yymmdd).length) await scoutTrends();

    const w = await writeDecks({ force });
    result.decks = w.written;
    result.dropped = w.dropped;
    if (!w.written.length) throw new Error(`no deck survived validation (${w.dropped.length} dropped)`);

    const queued = queuedDecks();
    const fresh = w.written.filter((id) => !queued.has(id));
    if (fresh.length < w.written.length) console.log(`  · ${w.written.length - fresh.length} deck(s) already queued — not rendered again`);

    const img = await makeImages(fresh);
    result.imageFailures = img.failed;

    const render = fresh.length ? await run("scripts/make-slideshow.mjs", fresh) : { code: 0, out: "" };
    if (render.code !== 0) throw new Error(`render failed:\n${render.out.trim().split("\n").slice(-8).join("\n")}`);

    const enq = await run("bot/enqueue.mjs", w.written);
    if (enq.code !== 0) throw new Error(`enqueue failed:\n${enq.out.trim().split("\n").slice(-8).join("\n")}`);

    result.ok = true;
  } catch (err) {
    result.error = redact(err.message);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const res = await daily({ force: process.argv.includes("--force") });
  if (res.error) console.error(`\n  ✗ ${res.error}\n`);
  console.log(`DAILY_RESULT ${JSON.stringify(res)}`);
  process.exit(res.ok ? 0 : 1);
}
