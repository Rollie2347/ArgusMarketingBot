/**
 * Every directory the pipeline reads or writes, in one place.
 *
 * Locally everything lives in the repo tree, exactly as before. On a server,
 * set MARKETING_DATA_DIR to a persistent volume and every piece of MUTABLE
 * state moves under it — generated decks, images, renders, the approval queue
 * and FEEDBACK.md — while the code, templates, HOOKS.md and the hand-written
 * decks stay in the image. A container restart must never lose the record of
 * what was already published.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MARKETING_ROOT = resolve(HERE, "..");

const DATA = process.env.MARKETING_DATA_DIR ? resolve(process.env.MARKETING_DATA_DIR) : null;
export const DATA_DIR = DATA;

/** Deck JSON files — hand-written ones and the daily writer's output. */
export const DECKS_DIR = DATA ? join(DATA, "decks") : join(MARKETING_ROOT, "decks");
/** Rendered slides, manifests, POST.md, hand-offs. */
export const OUT_DIR = DATA ? join(DATA, "out") : join(MARKETING_ROOT, "out");
/** AI-generated slide images, one folder per deck. */
export const ASSETS_DIR = DATA ? join(DATA, "assets") : join(MARKETING_ROOT, "assets", "generated");
/** The approval queue and the daily-run marker. */
export const STATE_DIR = DATA ? join(DATA, "state") : join(MARKETING_ROOT, "bot", "state");
export const FEEDBACK_FILE = DATA ? join(DATA, "FEEDBACK.md") : join(MARKETING_ROOT, "FEEDBACK.md");

/** Read-only inputs that always come from the repo. */
export const HOOKS_FILE = join(MARKETING_ROOT, "HOOKS.md");
export const SCHEMA_FILE = join(MARKETING_ROOT, "decks", "_SCHEMA.md");
export const CONFIG_FILE = join(MARKETING_ROOT, "config.json");
