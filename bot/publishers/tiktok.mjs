/**
 * TikTok publishing — deliberately NOT implemented.
 *
 * This file exists so that setting PUBLISH_TIKTOK=tiktok fails immediately
 * with the real reason, instead of someone writing the integration and
 * discovering the blocker after the code is done.
 *
 * The blocker is not technical:
 *
 *   - Direct Post (publishes to the account) requires a separate APP AUDIT on
 *     top of developer signup. Until that audit passes, every post from an
 *     unaudited client is forced to SELF_ONLY — visible only to the creator —
 *     and the client is capped at 5 posting users per 24 hours. A SELF_ONLY
 *     post has no distribution, so it is not a post.
 *   - The Upload path sends content to the creator's inbox as a DRAFT for
 *     manual editing and posting. That still needs a developer app and OAuth,
 *     and it still ends in a human pressing post — which is what the manual
 *     adapter already does, without the OAuth.
 *   - Photo carousels are URL-PULL ONLY. The API will not accept a file
 *     upload for photos, so the PNGs would have to be on a public HTTPS host
 *     before any of this could run.
 *
 * Prerequisites before this file is worth writing:
 *   1. TikTok developer account + registered app
 *   2. OAuth of the Argus Business account, video.publish scope
 *   3. A PASSED content-posting audit
 *   4. Public HTTPS hosting for the slide PNGs
 *
 * Until (3) exists, the manual adapter is strictly better: it produces the
 * same outcome (a human posts it) with none of the setup.
 */

export const name = "tiktok";

export async function publish() {
  throw new Error(
    "TikTok API publishing is not available. Direct Post requires a passed app audit; " +
    "without it every post is forced SELF_ONLY and has no distribution. " +
    "Set PUBLISH_TIKTOK=manual (the default) — see bot/publishers/tiktok.mjs for the full reason."
  );
}
