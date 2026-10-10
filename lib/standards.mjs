/**
 * Rollie's standing rule for every post, as a check instead of a habit.
 *
 *   2026-10-04  "three videos a day with all of them having scrollable slides,
 *                audio, and post to both tiktok and instagram"
 *   2026-10-07  "all videos should have memes as well"
 *
 * Each of those is one setting in bot/.env or config.json, any of which can be
 * changed for a test and left that way — and a batch made under the wrong
 * setting looks fine until it is on the profile with no sound. The daily run
 * calls this first and refuses to make anything if a setting has drifted; the
 * bot reports the reason in Telegram like any other failed batch.
 *
 * What the meme itself has to be (a current caption format, a scene rather
 * than a portrait, no repeats, a rotating look) is enforced deck by deck in
 * scripts/write-decks.mjs.
 */

/**
 * @param {object} config  config.json
 * @param {object} env     process.env
 * @returns {string[]} what is off-standard, in words Rollie can act on; empty means fine
 */
export function standardsProblems(config, env = process.env) {
  const p = [];
  const decks = parseInt(env.DECKS_PER_DAY || "3", 10);
  if (!(decks >= 3)) p.push(`DECKS_PER_DAY is ${env.DECKS_PER_DAY} — the rule is three posts a day (bot/.env)`);

  const platforms = String(env.POST_PLATFORMS || "tiktok,instagram").split(",").map((s) => s.trim()).filter(Boolean);
  for (const need of ["tiktok", "instagram"]) {
    if (!platforms.includes(need)) p.push(`POST_PLATFORMS is "${platforms.join(",")}" — ${need} is paused, and every post goes to both TikTok and Instagram (bot/.env)`);
    if (!(config?.platforms || []).includes(need)) p.push(`config.json "platforms" has no ${need} — its slides would not be rendered`);
  }

  if (config?.memeHook !== true) p.push(`config.json "memeHook" is ${JSON.stringify(config?.memeHook)} — every post opens on a meme`);
  if (config?.tiktokFormat !== "carousel") p.push(`config.json "tiktokFormat" is "${config?.tiktokFormat}" — only "carousel" is swipeable with sound on TikTok`);
  if (config?.instagramFormat !== "carousel-sound") p.push(`config.json "instagramFormat" is "${config?.instagramFormat}" — only "carousel-sound" is swipeable with sound on Instagram`);
  if (env.TIKTOK_REQUIRE_SOUND === "0") p.push(`TIKTOK_REQUIRE_SOUND=0 lets a TikTok post go out silent — every post has audio (bot/.env)`);
  return p;
}
