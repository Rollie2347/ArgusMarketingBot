/**
 * Environment and paths for the approval bot.
 *
 * Every secret is an environment variable, loaded from bot/.env (gitignored)
 * or from the real environment. Nothing here is ever printed — validate()
 * reports the NAME of a missing variable and never its value, and the summary
 * it prints shows only lengths and suffixes.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MARKETING_ROOT = resolve(HERE, "..");
export const OUT_DIR = join(MARKETING_ROOT, "out");
export const STATE_DIR = join(HERE, "state");
export const QUEUE_FILE = join(STATE_DIR, "queue.json");
export const FEEDBACK_FILE = join(MARKETING_ROOT, "FEEDBACK.md");

/**
 * A deliberately small .env reader rather than the dotenv dependency: this is
 * a standalone tool outside backend/, and adding a dependency to read six
 * lines is not worth a node_modules tree here.
 */
function loadDotEnv() {
  const file = join(HERE, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || null,
  // The ONLY chat allowed to operate this bot. An unlocked bot means anyone
  // who finds its username can approve posts to the real accounts.
  allowedChatId: process.env.TELEGRAM_CHAT_ID || null,
  pollTimeoutSec: parseInt(process.env.TELEGRAM_POLL_TIMEOUT_SEC || "30", 10),

  // Publishing. "manual" = mark approved and write a ready-to-post bundle.
  // See publishers/README section in bot/README.md for what it takes to move
  // a platform off manual.
  publishers: {
    tiktok: process.env.PUBLISH_TIKTOK || "manual",
    instagram: process.env.PUBLISH_INSTAGRAM || "manual",
  },

  instagram: {
    userId: process.env.IG_USER_ID || null,
    accessToken: process.env.IG_ACCESS_TOKEN || null,
    // Meta FETCHES image URLs server-side, so the PNGs must already be on a
    // public HTTPS host. Local files cannot be uploaded to this API.
    publicAssetBase: process.env.IG_PUBLIC_ASSET_BASE || null,
    graphVersion: process.env.IG_GRAPH_VERSION || "v21.0",
  },
};

export function validate({ requirePublishing = false } = {}) {
  const missing = [];
  if (!config.botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.allowedChatId) missing.push("TELEGRAM_CHAT_ID");

  if (requirePublishing && config.publishers.instagram === "instagram") {
    if (!config.instagram.userId) missing.push("IG_USER_ID");
    if (!config.instagram.accessToken) missing.push("IG_ACCESS_TOKEN");
    if (!config.instagram.publicAssetBase) missing.push("IG_PUBLIC_ASSET_BASE");
  }

  if (missing.length) {
    console.error(`\n  ✗ missing environment variable(s): ${missing.join(", ")}`);
    console.error(`    Set them in ${join(HERE, ".env")} (gitignored) — see bot/README.md\n`);
    process.exit(1);
  }
}

/**
 * Startup output for a secret. Length only — not a prefix, not a suffix, not a
 * fingerprint. A Telegram token is `<botid>:<secret>` and even four trailing
 * characters is four characters of the secret in a terminal that may be
 * screenshotted or pasted into a transcript. Length is enough to tell "set" from
 * "set to the wrong thing", which is the only question this line has to answer.
 */
export function describeSecret(value) {
  return value ? `set (${value.length} chars)` : "unset";
}
