#!/usr/bin/env node
/**
 * The daily deck writer: a language model drafts N slideshow decks from the
 * hook library, and every one of them has to pass strict validation before it
 * is written to decks/.
 *
 *   node scripts/write-decks.mjs                 # today's batch (DECKS_PER_DAY, default 3)
 *   node scripts/write-decks.mjs --count 1       # just one
 *   node scripts/write-decks.mjs --force         # write another batch even if today's exists
 *   node scripts/write-decks.mjs --dry-run       # print what it would write, write nothing
 *
 * What the model is given:
 *   HOOKS.md          — the whole thing, including the capability verification
 *                       table. It may only pick hook/CTA ids and capabilities
 *                       that table allows (lib/validate.mjs strict mode).
 *   decks/_SCHEMA.md  — the slide types and copy ceilings
 *   two real decks    — as style examples
 *   FEEDBACK.md       — every rejection and change request, with reasons.
 *                       This is how an ❌ in Telegram shapes tomorrow's batch.
 *   recent hook ids   — so the same hook doesn't run twice in a week
 *
 * What the model does NOT decide: the deck id, the campaign token, or the
 * handle. Those are attribution plumbing and are set here deterministically.
 *
 * A deck that fails validation goes back to the model with the exact errors,
 * up to twice. One that still fails is dropped and reported — never written.
 */

import "../lib/env.mjs";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DECKS_DIR, FEEDBACK_FILE, HOOKS_FILE, SCHEMA_FILE, CONFIG_FILE } from "../lib/paths.mjs";
import { validateDeck, readHookLibrary, ANGLES, VERIFIED_CAPABILITIES, noBioLinkPlatforms } from "../lib/validate.mjs";
import { generateJson, TEXT_MODEL, redact } from "../lib/gemini.mjs";

const RECENT_DAYS = parseInt(process.env.HOOK_REPEAT_DAYS || "7", 10);
const MAX_REPAIRS = 2;

/* ── dates ─────────────────────────────────────────────────────────────────
 * Local time (set TZ on a server). The batch prefix is the date the batch is
 * FOR, which is also what sorts decks/ chronologically.
 * ------------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, "0");
export function batchStamp(d = new Date()) {
  const yy = pad(d.getFullYear() % 100), mm = pad(d.getMonth() + 1), dd = pad(d.getDate());
  return { yymmdd: `${yy}${mm}${dd}`, yymm: `${yy}${mm}`, iso: `${d.getFullYear()}-${mm}-${dd}` };
}

function slugify(s) {
  return String(s || "deck").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "") || "deck";
}

/* ── context ───────────────────────────────────────────────────────────── */

function readDecks() {
  if (!existsSync(DECKS_DIR)) return [];
  return readdirSync(DECKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return { id: f.slice(0, -5), ...JSON.parse(readFileSync(join(DECKS_DIR, f), "utf8")) }; }
      catch { return null; }
    })
    .filter(Boolean);
}

export function existingBatch(yymmdd) {
  return readDecks().filter((d) => d.generated?.batch === yymmdd).map((d) => d.id).sort();
}

/**
 * Hook ids used by generated decks whose BATCH date is within the last
 * RECENT_DAYS days of `now` — the day a deck is for, not the moment it was
 * written (a batch written ahead, or re-run, must count on its own day).
 */
function recentHooks(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const batchDay = (b) => new Date(2000 + Number(b.slice(0, 2)), Number(b.slice(2, 4)) - 1, Number(b.slice(4, 6))).getTime();
  return [...new Set(readDecks()
    .filter((d) => /^\d{6}$/.test(d.generated?.batch || ""))
    .filter((d) => { const age = (today - batchDay(d.generated.batch)) / 86400_000; return age >= 0 && age <= RECENT_DAYS; })
    .map((d) => d.hookId))];
}

/** The last ~40 feedback rows — the table body only, header stripped. */
function feedbackRows() {
  if (!existsSync(FEEDBACK_FILE)) return [];
  return readFileSync(FEEDBACK_FILE, "utf8").split(/\r?\n/)
    .filter((l) => l.startsWith("| 2"))
    .slice(-40);
}

function exampleDecks() {
  // Two hand-written decks with different shapes: a problem/solution arc with
  // a quote slide, and a before/after. Read from the repo, not DECKS_DIR, so a
  // server's data volume can't change the examples.
  const dir = join(fileURLToPath(new URL("..", import.meta.url)), "decks");
  return ["01-fridge-stare", "08-show-dont-describe"]
    .filter((id) => existsSync(join(dir, `${id}.json`)))
    .map((id) => readFileSync(join(dir, `${id}.json`), "utf8"));
}

/* ── prompt ────────────────────────────────────────────────────────────── */

function systemPrompt() {
  return `You write short-form slideshow ads (TikTok photo mode and Instagram carousels) for Argus, a free iPhone app: a real-time AI companion that sees through the phone's camera and talks with you by voice.

You are writing for a real brand account. Every claim you make must be TRUE of the shipping app. The hook library below contains a capability verification table: ONLY claim capabilities marked ✅. Never claim anything marked ❌ — in particular: no web search, no timers that alert, no notifications, no background operation, no interrupting Argus mid-reply, no Android, nothing about data staying on the device. If a deck idea needs a capability that isn't ✅, pick a different idea.

Follow the hook library's rules exactly (one idea per hook, concrete over adjectives, no privacy overclaim, say iPhone and free, the camera is the differentiator). Never use: "revolutionary", "game-changing", "powered by AI", "the future of", "you won't believe".

Write like a person talking, not like an ad. Specific moments beat general benefits. Short sentences.

===== HOOK LIBRARY (HOOKS.md) =====
${readFileSync(HOOKS_FILE, "utf8")}

===== DECK SCHEMA (decks/_SCHEMA.md) =====
${readFileSync(SCHEMA_FILE, "utf8")}

===== TWO REAL DECKS, FOR STYLE (match this voice and quality) =====
${exampleDecks().join("\n\n")}
`;
}

function batchPrompt({ count, avoidHooks, feedback, noBioLink }) {
  const angleList = Object.keys(ANGLES).map((a) => `"${a}" (hook ids ${ANGLES[a].prefix}-NN)`).join(", ");
  return `Write ${count} new slideshow deck${count > 1 ? "s" : ""}.

Hard requirements for every deck:
- "angle": one of ${angleList}. Use a DIFFERENT angle for each deck in this batch.
- "hookId": an existing, non-retired hook id from HOOKS.md belonging to that angle. Each deck in this batch uses a different hook.${avoidHooks.length ? `\n- Do NOT use these hook ids (posted in the last ${RECENT_DAYS} days): ${avoidHooks.join(", ")}.` : ""}
- The hook slide's headline must express that hook's idea in fresh words (don't copy the library line verbatim), ≤ 8 words ideally, never more than 12.
- "ctaId": a CTA id from the CTA library; the final "cta" slide's copy must match that CTA.
- "capabilities": only from this list: ${VERIFIED_CAPABILITIES.join(", ")}. List every tool the deck's claims depend on.
- 7 or 8 slides. First slide type "hook", last slide type "cta". Use at least one "quote" slide (a realistic spoken exchange, "you" and "argus") and vary the middle slide types.
- Copy lengths within the schema's "comfortable" column.
- "image": give the HOOK slide an "image": {"prompt": "..."} and at most ONE other slide. The prompt describes a PHOTOGRAPH of the real-world scene (e.g. "an open refrigerator at night, half a lemon and a carton of eggs on the shelf, soft light spilling out"). NEVER mention the app, a phone screen, any interface, text, labels you can read, logos or brand names. Hands are fine; avoid faces.
- "caption": {"tiktok": "...", "instagram": "..."}. Each says it is free and on iPhone. TikTok: 1–3 short sentences. Instagram: a few short lines ending with a send-shaped prompt ("send this to…").
${noBioLink.length ? `- IMPORTANT — the ${noBioLink.join(" and ")} account has NO link in its bio. Never write "link in bio" (or any bio link) in ${noBioLink.join("/")} copy. Instead tell viewers to search "My Argus" on the App Store (it has a gold ring icon). Where the slides say "link in bio" for Instagram, make that field per-platform: e.g. "pill": {"tiktok": "Search “My Argus” on the App Store", "instagram": "Link in bio"}. Any copy field may be a {"tiktok": "...", "instagram": "..."} object like this.
- The Instagram caption points to the link in bio.` : `- Both captions point to the link in bio.`}
- "hashtags": {"tiktok": [...], "instagram": [...]}: 5–10 each, lowercase, no "#", no spaces.
- "slug": 2–4 lowercase words joined by hyphens naming the deck's idea (e.g. "fridge-stare").
- "title": a short human-readable title.
${feedback.length ? `
Every deck is reviewed by a human before it posts. These are past rejections and change requests from that review — they are the most important input you have. Do not repeat these mistakes:
${feedback.join("\n")}
` : ""}
Return JSON: {"decks": [ { "slug", "title", "angle", "hookId", "ctaId", "capabilities", "slides", "caption", "hashtags" }, ... ]}`;
}

function repairPrompt(deck, errors) {
  return `This deck failed validation. Fix every error below and change nothing else unless a fix requires it.

Errors:
${errors.map((e) => `- ${e}`).join("\n")}

Deck:
${JSON.stringify(deck, null, 2)}

Return JSON: {"deck": { ...the corrected deck... }}`;
}

/* ── writer ────────────────────────────────────────────────────────────── */

/**
 * @returns {{ written: string[], dropped: {slug:string, errors:string[]}[], skipped?: boolean }}
 */
export async function writeDecks({ count = parseInt(process.env.DECKS_PER_DAY || "3", 10), force = false, dryRun = false, now = new Date(), log = console.log } = {}) {
  const stamp = batchStamp(now);
  const already = existingBatch(stamp.yymmdd);
  if (already.length && !force) {
    log(`  · batch ${stamp.yymmdd} already written (${already.join(", ")}) — pass --force for another`);
    return { written: already, dropped: [], skipped: true };
  }

  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  const platforms = config.platforms;
  const library = readHookLibrary();
  const avoidHooks = recentHooks(now);
  const system = systemPrompt();

  log(`  ✎ asking ${TEXT_MODEL} for ${count} deck(s)${avoidHooks.length ? `, avoiding ${avoidHooks.join(" ")}` : ""}`);
  const noBioLink = noBioLinkPlatforms(config);
  const reply = await generateJson(batchPrompt({ count, avoidHooks, feedback: feedbackRows(), noBioLink }), { system });
  const drafts = Array.isArray(reply?.decks) ? reply.decks.slice(0, count) : [];
  if (!drafts.length) throw new Error(`${TEXT_MODEL} returned no decks`);

  // Batch number continues after any decks already written today (--force).
  let seq = already.length;
  const usedHooks = new Set();
  const written = [];
  const dropped = [];

  for (const draft of drafts) {
    let deck = finalize(draft, stamp, ++seq);
    let errors = check(deck, platforms, library, usedHooks, noBioLink);

    for (let attempt = 1; errors.length && attempt <= MAX_REPAIRS; attempt++) {
      log(`  ↻ ${deck.id}: ${errors.length} validation error(s), repair ${attempt}/${MAX_REPAIRS}`);
      try {
        const fixed = await generateJson(repairPrompt(strip(deck), errors), { system, temperature: 0.4 });
        deck = finalize(fixed?.deck ?? fixed, stamp, seq, deck.id);
        errors = check(deck, platforms, library, usedHooks, noBioLink);
      } catch (err) {
        errors = [...errors, `repair call failed: ${redact(err.message)}`];
        break;
      }
    }

    if (errors.length) {
      log(`  ✗ dropped ${deck.id}:`);
      errors.forEach((e) => log(`      ${e}`));
      dropped.push({ slug: deck.id, errors });
      seq--; // keep ids contiguous
      continue;
    }

    usedHooks.add(deck.hookId);
    if (!dryRun) {
      mkdirSync(DECKS_DIR, { recursive: true });
      writeFileSync(join(DECKS_DIR, `${deck.id}.json`), JSON.stringify(deck, null, 2) + "\n", "utf8");
    }
    written.push(deck.id);
    log(`  ✓ ${deck.id}  ${deck.angle}/${deck.hookId}  ${deck.slides.length} slides${dryRun ? "  (dry run — not written)" : ""}`);
  }

  return { written, dropped };
}

/** The fields the model does not get to choose. */
function finalize(draft, stamp, seq, forcedId = null) {
  const d = draft && typeof draft === "object" ? draft : {};
  const angle = ANGLES[d.angle];
  const id = forcedId || `${stamp.yymmdd}-${seq}-${slugify(d.slug || d.title)}`;
  const { slug, id: _ignored, ct: _ct, generated: _g, ...rest } = d;
  return {
    title: rest.title || slug || id,
    ...rest,
    id,
    // Per angle per month, like the hand-written decks — Apple suppresses
    // campaign metrics under 5 events, so per-post tokens would never report.
    ct: angle ? `${angle.code}-${stamp.yymm}` : undefined,
    generated: { by: TEXT_MODEL, at: new Date().toISOString(), batch: stamp.yymmdd },
  };
}

/** What goes back to the model for a repair: its own fields only. */
function strip(deck) {
  const { id, ct, generated, ...rest } = deck;
  return rest;
}

function check(deck, platforms, library, usedHooks, noBioLink = []) {
  const errors = validateDeck(deck, platforms, { strict: true, library, noBioLink });
  if (usedHooks.has(deck.hookId)) errors.push(`hookId ${deck.hookId} is already used by another deck in this batch — pick a different hook`);
  if (!deck.slides?.[0]?.image) errors.push("the hook slide needs an \"image\": {\"prompt\": \"...\"}");
  const images = (deck.slides || []).filter((s) => s.image).length;
  if (images > 2) errors.push(`${images} slides have images; max 2 (the hook plus one)`);
  return errors;
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--count");
  try {
    const res = await writeDecks({
      count: i >= 0 ? parseInt(argv[i + 1], 10) : undefined,
      force: argv.includes("--force"),
      dryRun: argv.includes("--dry-run"),
    });
    console.log(`\n  ${res.written.length} written, ${res.dropped.length} dropped\n`);
    if (!res.written.length) process.exit(1);
  } catch (err) {
    console.error(`\n  ✗ ${redact(err.message)}\n`);
    process.exit(1);
  }
}
