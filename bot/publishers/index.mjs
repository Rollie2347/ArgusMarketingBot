/**
 * Publisher adapters.
 *
 * A publisher takes an approved queue item and either posts it or hands it
 * back as a ready-to-post bundle. Every adapter returns the same shape:
 *
 *   { published: boolean, postId: string|null, url: string|null, note: string }
 *
 * or throws. A throw is treated as a LOUD failure: the item goes to
 * publish_failed, Telegram is told why, and a Retry button appears.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS ACTUALLY AUTOMATED TODAY: NOTHING. Both platforms are "manual".
 * ─────────────────────────────────────────────────────────────────────────
 *
 * TikTok — blocked, and not by code.
 *   The Content Posting API's Direct Post path requires a separate app audit
 *   on top of developer signup. Until that audit passes, every post from an
 *   unaudited client is forced to SELF_ONLY (only the creator can see it) and
 *   the client is capped at 5 posting users per 24h. A SELF_ONLY post is not
 *   a post. Photo carousels are also URL-pull only — the API will not accept
 *   an upload, so the PNGs must be on a public HTTPS host first.
 *   Prerequisites: developer account, app, OAuth of the Business account,
 *   video.publish scope, AND a passed audit. None of these exist.
 *
 * Instagram — closest to reachable, still not reachable today.
 *   Content Publishing needs an IG Business/Creator account linked to a
 *   Facebook Page, a Meta developer app, and instagram_content_publish.
 *   App Review (2-4 weeks) is required for production beyond a small set of
 *   test users — but the app owner's OWN account works in development mode,
 *   which is exactly our case. Meta also FETCHES image URLs server-side, so
 *   the carousel PNGs must be publicly reachable over HTTPS first.
 *   Prerequisites: IG Business account, linked FB Page, Meta app, long-lived
 *   token, public asset hosting. None of these exist either — but all of them
 *   are setup, not engineering.
 *
 * So instagram.mjs is written and complete, and is DEFAULT OFF and UNVERIFIED:
 * it has never been run against the real API. Turning it on is
 * PUBLISH_INSTAGRAM=instagram plus the IG_* variables. Do the first one with
 * DRY_RUN=1 and read what it would have sent.
 */

import * as manual from "./manual.mjs";
import * as instagram from "./instagram.mjs";
import * as tiktok from "./tiktok.mjs";
import * as uploadpost from "./uploadpost.mjs";
import * as telegram from "./telegram.mjs";
import * as tiktokweb from "./tiktokweb.mjs";

// The free setup (2026-09-26): PUBLISH_TIKTOK=telegram (hand-off to the
// phone) and PUBLISH_INSTAGRAM=instagram (instagram.mjs, Instagram Login +
// the public slide bucket). uploadpost stays available as the paid way to
// automate TikTok too.
// Fully automatic and free (2026-09-26): PUBLISH_TIKTOK=tiktokweb (a browser
// bot on TikTok's website, posting a photo carousel with sound — against TikTok's
// terms, accepted) and PUBLISH_INSTAGRAM=instagram once a token exists.
const ADAPTERS = { manual, instagram, tiktok, uploadpost, telegram, tiktokweb };

export function getPublisher(name) {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown publisher "${name}" — expected one of ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}

export function describeMode(platform, mode) {
  if (mode === "manual") return `${platform}: manual hand-off (approved asset, post by hand)`;
  if (mode === "telegram") return `${platform}: sent to Telegram at the slot, posted by hand`;
  if (mode === "tiktokweb") return `${platform}: auto-posts via the browser bot (photo carousel + sound)${process.env.DRY_RUN === "1" ? " (DRY_RUN)" : ""}`;
  if (mode === "instagram") return `${platform}: auto-posts via the Instagram API${process.env.DRY_RUN === "1" ? " (DRY_RUN)" : ""}`;
  if (mode === platform) return `${platform}: API publishing ENABLED (unverified — watch the first run)`;
  if (mode === "uploadpost") return `${platform}: publishing via Upload-Post${process.env.DRY_RUN === "1" ? " (DRY_RUN)" : ""}`;
  return `${platform}: ${mode}`;
}
