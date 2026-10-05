/**
 * The soundtrack for an Instagram Reel.
 *
 * Instagram's website has no music picker (checked on the real Create dialog,
 * 2026-10-04 — music is phone-app only), so the track is mixed into the video
 * file itself (lib/video.mjs). That rules out trending or commercial songs:
 * Instagram mutes or removes uploads carrying copyrighted audio. The tracks
 * are the audio files in assets/music/ — put only music you may use there
 * (see assets/music/README.md for where the current ones came from).
 *
 * Picks a track not used in the last few posts, so the feed doesn't play the
 * same thing every day.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MARKETING_ROOT, STATE_DIR } from "./paths.mjs";

export const MUSIC_DIR = process.env.MARKETING_MUSIC_DIR || join(MARKETING_ROOT, "assets", "music");
const RECENT_FILE = join(STATE_DIR, "instagram-music.json");

function recent() {
  try { return JSON.parse(readFileSync(RECENT_FILE, "utf8")); } catch { return []; }
}

export function tracks() {
  if (!existsSync(MUSIC_DIR)) return [];
  return readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)).sort();
}

/** @returns {{name: string, path: string}} — throws when there is no music at all. */
export function pickTrack() {
  const all = tracks();
  if (!all.length) throw new Error(`no music in ${MUSIC_DIR} — add at least one audio file you may use`);
  // Avoid as many of the latest picks as the library allows.
  const used = all.length > 1 ? recent().slice(-(all.length - 1)) : [];
  const fresh = all.filter((t) => !used.includes(t));
  const pool = fresh.length ? fresh : all;
  const name = pool[Math.floor(Math.random() * pool.length)];
  return { name, path: join(MUSIC_DIR, name) };
}

export function rememberTrack(name) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(RECENT_FILE, JSON.stringify([...recent(), name].slice(-20), null, 2), "utf8");
  } catch { /* only costs a repeat */ }
}
