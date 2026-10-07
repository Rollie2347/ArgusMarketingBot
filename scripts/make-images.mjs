#!/usr/bin/env node
/**
 * Generates the photograph for every slide that asks for one.
 *
 *   node scripts/make-images.mjs <deckId> [<deckId> …]
 *   node scripts/make-images.mjs --all          # every deck with an unfilled image slot
 *
 * A slide asks with  "image": { "prompt": "…" }.  This fills in
 *                    "image": { "prompt": "…", "file": "01-3fa9c2d1.png", "model": "…" }
 * and saves the file under ASSETS_DIR/<deckId>/. The filename carries a hash
 * of the prompt, so re-running is free: an image whose prompt hasn't changed
 * is never generated (or paid for) twice, and editing a prompt makes a new one.
 *
 * Every prompt gets STYLE appended. It is where "no text, no screens, no
 * logos" is enforced a second time — the first is lib/validate.mjs refusing a
 * prompt that asks for them. A generated phone screen would be a fabricated
 * demo of Argus, which is the one thing this pipeline must never publish.
 *
 * A failed image does not fail the deck: the slot is removed and the slide
 * renders on the plain brand background, with a note in deck.generated so
 * the Telegram card can say so. The image is atmosphere, not the message.
 *
 * Cost guard: MAX_IMAGES_PER_RUN (default 12) caps generations per run, so a
 * bug that loops cannot spend more than a dollar or so.
 */

import "../lib/env.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { DECKS_DIR, ASSETS_DIR } from "../lib/paths.mjs";
import { generateImage, IMAGE_MODEL, redact } from "../lib/gemini.mjs";

const MAX_IMAGES_PER_RUN = parseInt(process.env.MAX_IMAGES_PER_RUN || "12", 10);

const NO_TEXT = "Absolutely no legible text, letters, numbers, labels, packaging brands, logos, watermarks, user interfaces or phone screens anywhere in the frame.";

export const STYLE = [
  "Photorealistic editorial photograph, shot on a phone camera, natural available light, shallow depth of field, muted warm tones, a little grain.",
  "Vertical 9:16 composition: the subject sits in the upper half; the lower half is quieter and darker, because headline text will be overlaid there.",
  NO_TEXT,
  "No identifiable faces.",
].join(" ");

/**
 * A meme hook's photo is the punchline, not atmosphere: a close-up of one
 * subject showing one emotion, bright enough to read at thumbnail size —
 * close-up scale, a character and visible emotion are the three image traits
 * shared memes have in common (RESEARCH.md §3.5). Faces are allowed
 * here — the reaction is the joke — but only invented ones. The caption is
 * drawn by the template, never by the image model.
 */
export const MEME_STYLE = [
  "Candid, funny, instantly readable reaction photo, shot on a phone camera, bright natural light, sharp focus on the subject, true-to-life colour.",
  "A tight close-up of one subject caught mid-reaction: the face fills the centre of the frame and shows one exaggerated, unmistakable emotion, played completely straight — the comedy is how seriously the subject is taking it.",
  "Vertical 9:16 composition: the face sits in the middle third of the frame, eyes just above centre; the top quarter and the bottom third hold nothing important, because caption text will be overlaid there.",
  "One continuous full-bleed photograph that fills the whole frame edge to edge: no borders, bands, bars, panels, split frames or blurred padding — the real background simply continues, out of focus, above and below the subject.",
  NO_TEXT,
  "Any person is an ordinary, anonymous, invented adult — never a celebrity, public figure, or character from a film, show or game.",
].join(" ");

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

/**
 * @returns {{ generated: number, reused: number, failed: {deckId, slide, error}[] }}
 */
export async function makeImages(deckIds, { log = console.log } = {}) {
  let generated = 0, reused = 0;
  const failed = [];

  for (const deckId of deckIds) {
    const file = join(DECKS_DIR, `${deckId}.json`);
    if (!existsSync(file)) { failed.push({ deckId, slide: null, error: "deck file not found" }); continue; }
    const deck = JSON.parse(readFileSync(file, "utf8"));
    const dir = join(ASSETS_DIR, deckId);
    let changed = false;

    for (const [i, slide] of (deck.slides || []).entries()) {
      if (!slide.image?.prompt) continue;
      const n = String(i + 1).padStart(2, "0");
      const style = slide.meme ? MEME_STYLE : STYLE;
      const h = hash(`${IMAGE_MODEL}\n${slide.image.prompt}\n${style}`);

      // Already generated for exactly this prompt?
      const existing = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${n}-${h}.`)) : null;
      if (existing) {
        if (slide.image.file !== existing) { slide.image.file = existing; changed = true; }
        reused++;
        continue;
      }

      if (generated >= MAX_IMAGES_PER_RUN) {
        failed.push({ deckId, slide: i + 1, error: `MAX_IMAGES_PER_RUN (${MAX_IMAGES_PER_RUN}) reached` });
        dropImage(deck, slide, i, "image cap reached");
        changed = true;
        continue;
      }

      try {
        const img = await generateImage(`${slide.image.prompt.trim()}\n\n${style}`, { aspectRatio: "9:16" });
        const ext = EXT[img.mimeType] || "png";
        mkdirSync(dir, { recursive: true });
        const name = `${n}-${h}.${ext}`;
        writeFileSync(join(dir, name), img.bytes);
        slide.image.file = name;
        slide.image.model = IMAGE_MODEL;
        generated++;
        changed = true;
        log(`  🖼  ${deckId} slide ${n}  ${(img.bytes.length / 1024).toFixed(0)} KB`);
      } catch (err) {
        const msg = redact(err.message);
        log(`  ✗ ${deckId} slide ${n}: ${msg} — rendering it without an image`);
        failed.push({ deckId, slide: i + 1, error: msg });
        dropImage(deck, slide, i, msg);
        changed = true;
      }
    }

    if (changed) writeFileSync(file, JSON.stringify(deck, null, 2) + "\n", "utf8");
  }

  return { generated, reused, failed };
}

function dropImage(deck, slide, i, why) {
  delete slide.image;
  deck.generated ??= {};
  (deck.generated.notes ??= []).push(`slide ${i + 1}: no image (${why.slice(0, 160)})`);
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  let ids = argv.filter((a) => !a.startsWith("--"));
  if (argv.includes("--all")) {
    ids = readdirSync(DECKS_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
      .filter((id) => JSON.parse(readFileSync(join(DECKS_DIR, `${id}.json`), "utf8")).slides?.some((s) => s.image?.prompt && !s.image.file));
  }
  if (!ids.length) { console.error("\n  usage: node scripts/make-images.mjs <deckId>… | --all\n"); process.exit(1); }
  const res = await makeImages(ids);
  console.log(`\n  ${res.generated} generated, ${res.reused} reused, ${res.failed.length} failed\n`);
  if (res.failed.length && !res.generated && !res.reused) process.exit(1);
}
