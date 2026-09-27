/**
 * Slides → a vertical MP4, for TikTok's website (which cannot make photo
 * carousels — only the phone app can — so the browser bot posts the deck as
 * a short slideshow video instead).
 *
 * Each slide is held about long enough to READ it: 1.0s + 0.2s per word,
 * clamped to 2–5s (a deck lands around 25–35s). A text slideshow that flips
 * faster than it can be read gets swiped away; one that lingers gets swiped
 * too — the first version (0.28s/word, up to 7s) made a 56-second video.
 *
 * H.264 + AAC (a silent stereo track — some uploaders reject video with no
 * audio stream at all), yuv420p, 30 fps, faststart. Cached next to the slides
 * by a hash of the inputs, so a retry doesn't re-encode.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { forPlatform } from "../templates/render.mjs";
import { plain } from "./validate.mjs";
import { DECKS_DIR, OUT_DIR } from "./paths.mjs";

/** FFMPEG_PATH, else PATH, else winget's install location. */
export function findFfmpeg() {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  for (const dir of (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":")) {
    const p = join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (dir && existsSync(p)) return p;
  }
  const la = process.env.LOCALAPPDATA;
  if (la) {
    const link = join(la, "Microsoft", "WinGet", "Links", "ffmpeg.exe");
    if (existsSync(link)) return link;
    const pk = join(la, "Microsoft", "WinGet", "Packages");
    if (existsSync(pk)) {
      for (const d of readdirSync(pk).filter((x) => x.startsWith("Gyan.FFmpeg"))) {
        const inner = join(pk, d);
        for (const b of readdirSync(inner)) {
          const p = join(inner, b, "bin", "ffmpeg.exe");
          if (existsSync(p)) return p;
        }
      }
    }
  }
  throw new Error("ffmpeg not found — install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH");
}

/** Seconds to hold each slide, from the words actually on it. */
export function slideDurations(deck, platform) {
  const slides = forPlatform(deck.slides || [], platform);
  return slides.map((s) => {
    const text = [s.kicker, s.headline, s.sub, s.step, s.body, s.pill, s.fineprint, s.before, s.after,
      ...(s.turns || []).map((t) => t.text), ...(s.items || []).map((i) => (typeof i === "string" ? i : `${i.text} ${i.note || ""}`))]
      .filter(Boolean).map(plain).join(" ");
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.round(Math.min(5, Math.max(2, 1.0 + words * 0.2)) * 10) / 10;
  });
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (b) => { err += b; if (err.length > 20000) err = err.slice(-10000); });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split("\n").slice(-4).join(" | ")}`))));
  });
}

/**
 * @returns {Promise<{path:string, seconds:number}>}
 */
export async function makeSlideshowVideo(item) {
  const dir = join(OUT_DIR, item.deckId, item.platform);
  const files = (item.jpgFiles?.length ? item.jpgFiles : item.slideFiles).map((f) => join(dir, f));
  for (const f of files) if (!existsSync(f)) throw new Error(`missing slide ${f}`);

  const deckFile = join(DECKS_DIR, `${item.deckId}.json`);
  const deck = existsSync(deckFile) ? JSON.parse(readFileSync(deckFile, "utf8")) : { slides: [] };
  let durations = slideDurations(deck, item.platform);
  if (durations.length !== files.length) durations = files.map(() => 3.5);

  const key = createHash("sha256")
    .update(JSON.stringify(durations))
    .update(files.map((f) => `${f}:${statSync(f).size}:${statSync(f).mtimeMs}`).join("|"))
    .digest("hex").slice(0, 10);
  const out = join(dir, `slideshow-${key}.mp4`);
  const seconds = Math.round(durations.reduce((a, b) => a + b, 0) * 10) / 10;
  if (existsSync(out)) return { path: out, seconds };

  // concat demuxer: each image held for its duration. The last file is listed
  // twice because the demuxer ignores the final entry's duration.
  const list = join(dir, `slideshow-${key}.txt`);
  const esc = (p) => p.replace(/\\/g, "/").replace(/'/g, "'\\''");
  writeFileSync(list, [
    ...files.flatMap((f, i) => [`file '${esc(f)}'`, `duration ${durations[i]}`]),
    `file '${esc(files.at(-1))}'`,
  ].join("\n") + "\n", "utf8");

  await run(findFfmpeg(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    // JPEG input is full-range; out_range=tv + yuv420p gives the standard
    // limited-range video every uploader expects (not yuvj420p).
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease:out_range=tv,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
    "-pix_fmt", "yuv420p", "-color_range", "tv",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19",
    "-c:a", "aac", "-b:a", "64k",
    "-t", String(seconds), "-shortest",
    "-movflags", "+faststart",
    out,
  ]);
  return { path: out, seconds };
}
