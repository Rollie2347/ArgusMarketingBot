/**
 * Environment and paths for the approval bot.
 *
 * Every secret is an environment variable, loaded from bot/.env (gitignored)
 * or from the real environment. Nothing here is ever printed — validate()
 * reports the NAME of a missing variable and never its value, and the summary
 * it prints shows only lengths.
 */

import { join } from "node:path";
import { ENV_FILE } from "../lib/env.mjs";
import { STATE_DIR, OUT_DIR, FEEDBACK_FILE, MARKETING_ROOT, DECKS_DIR } from "../lib/paths.mjs";

export { STATE_DIR, OUT_DIR, FEEDBACK_FILE, MARKETING_ROOT, DECKS_DIR };
export const QUEUE_FILE = join(STATE_DIR, "queue.json");
/** Records which day's batch already ran, so a restart doesn't run it twice. */
export const DAILY_FILE = join(STATE_DIR, "daily.json");

/** "13:00, 09:00" → ["09:00", "13:00"]; anything that isn't HH:MM is dropped. */
function times(v) {
  return String(v || "").split(",").map((t) => t.trim())
    .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).sort();
}

export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || null,
  // The ONLY chat allowed to operate this bot. An unlocked bot means anyone
  // who finds its username can approve posts to the real accounts.
  allowedChatId: process.env.TELEGRAM_CHAT_ID || null,
  pollTimeoutSec: parseInt(process.env.TELEGRAM_POLL_TIMEOUT_SEC || "30", 10),

  // Publishing, per platform:
  //   "telegram"   (default) slides + caption sent to Telegram at the slot, you post by hand
  //   "instagram"  free, automatic: Instagram API with Instagram Login + the public bucket
  //   "uploadpost" paid aggregator, automatic on both platforms
  //   "manual"     hand-off file on the bot's own disk (legacy)
  //   "tiktok"     always fails — TikTok's API needs our own passed audit
  publishers: {
    tiktok: process.env.PUBLISH_TIKTOK || "telegram",
    instagram: process.env.PUBLISH_INSTAGRAM || "telegram",
  },

  // Upload-Post (upload-post.com) publishes to TikTok and Instagram through
  // its own already-audited API apps. See publishers/uploadpost.mjs.
  uploadpost: {
    apiKey: process.env.UPLOADPOST_API_KEY || null,
    // The Upload-Post profile the TikTok and Instagram accounts are connected under.
    user: process.env.UPLOADPOST_USER || null,
    // DIRECT_POST publishes. MEDIA_UPLOAD sends TikTok a draft to finish in
    // the app — the safe setting for the very first run.
    tiktokPostMode: process.env.UPLOADPOST_TIKTOK_POST_MODE || "DIRECT_POST",
    // Business accounts only get the Commercial Music Library (RESEARCH §1.4);
    // auto music picks from what the account is allowed to use.
    tiktokAutoMusic: process.env.UPLOADPOST_TIKTOK_AUTO_MUSIC !== "0",
    apiBase: process.env.UPLOADPOST_API_BASE || "https://api.upload-post.com",
  },

  // Instagram API with Instagram Login. The token is refreshed by the bot and
  // the refreshed value lives in state/ig-token.json (igtoken.mjs); the env
  // var only seeds it. Slides are hosted in MARKETING_GCS_BUCKET (lib/gcs.mjs).
  instagram: {
    userId: process.env.IG_USER_ID || null,
    accessToken: process.env.IG_ACCESS_TOKEN || null,
    graphVersion: process.env.IG_GRAPH_VERSION || "v25.0",
  },

  // When approved posts go out, in the process's local time (set TZ on a
  // server). POST_TIMES unset = publish the moment you approve.
  schedule: {
    times: times(process.env.POST_TIMES),
    // Per platform per day. 1 during the ~10-day account warm-up
    // (CALENDAR.md, RESEARCH §6.1); raise to 3 once the accounts are warm.
    perDay: Math.max(1, parseInt(process.env.POSTS_PER_DAY || "1", 10) || 1),
    // One-day override: on BURST_DATE (YYYY-MM-DD, local) the slots are
    // BURST_TIMES and the cap is one post per burst time — e.g. a launch day.
    // Every other day uses the normal times and cap, so it needs no undoing.
    burst: /^\d{4}-\d{2}-\d{2}$/.test(process.env.BURST_DATE || "") && times(process.env.BURST_TIMES).length
      ? { date: process.env.BURST_DATE, times: times(process.env.BURST_TIMES) }
      : null,
  },

  // The bot runs scripts/daily.mjs once a day at this local time.
  // Unset = only on /generate.
  dailyRunAt: times(process.env.DAILY_RUN_AT)[0] || null,
};

export function validate({ requirePublishing = false } = {}) {
  const missing = [];
  if (!config.botToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.allowedChatId) missing.push("TELEGRAM_CHAT_ID");

  if (requirePublishing && Object.values(config.publishers).includes("uploadpost")) {
    if (!config.uploadpost.apiKey) missing.push("UPLOADPOST_API_KEY");
    if (!config.uploadpost.user) missing.push("UPLOADPOST_USER");
  }

  if (requirePublishing && config.publishers.instagram === "instagram") {
    // IG_USER_ID / IG_ACCESS_TOKEN may instead come from the /instagram
    // Telegram command (state/ig-token.json), so they aren't required here;
    // the publisher fails loudly if neither exists.
    if (!process.env.MARKETING_GCS_BUCKET) missing.push("MARKETING_GCS_BUCKET");
    if (!process.env.MARKETING_GCS_KEY_B64) missing.push("MARKETING_GCS_KEY_B64");
  }

  if (missing.length) {
    console.error(`\n  ✗ missing environment variable(s): ${missing.join(", ")}`);
    console.error(`    Set them in ${ENV_FILE} (gitignored) or the real environment — see bot/README.md\n`);
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
