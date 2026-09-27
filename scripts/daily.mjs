#!/usr/bin/env node
/**
 * One day's batch, end to end, up to the approval gate:
 *
 *   write-decks → make-images → make-slideshow → enqueue
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
 * already in the queue.
 *
 * The last line of output is `DAILY_RESULT {json}` — the bot parses that
 * rather than scraping the human-readable log.
 */

import "../lib/env.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { MARKETING_ROOT } from "../lib/paths.mjs";
import { writeDecks } from "./write-decks.mjs";
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

export async function daily({ force = false } = {}) {
  const result = { ok: false, decks: [], dropped: [], imageFailures: [], error: null };
  try {
    const w = await writeDecks({ force });
    result.decks = w.written;
    result.dropped = w.dropped;
    if (!w.written.length) throw new Error(`no deck survived validation (${w.dropped.length} dropped)`);

    const img = await makeImages(w.written);
    result.imageFailures = img.failed;

    const render = await run("scripts/make-slideshow.mjs", w.written);
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
