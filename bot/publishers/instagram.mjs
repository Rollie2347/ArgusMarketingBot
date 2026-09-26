/**
 * Instagram carousel publishing via the Instagram Graph API.
 *
 * ⚠️ UNVERIFIED. This has never been executed against the real API, because
 * the prerequisites do not exist yet (no IG Business account, no linked
 * Facebook Page, no Meta app, no token). It is written from the documented
 * flow and is DEFAULT OFF. Run the first one with DRY_RUN=1.
 *
 * The documented flow, three steps:
 *   1. POST /{ig-user-id}/media  per slide, is_carousel_item=true  -> child ids
 *   2. POST /{ig-user-id}/media  media_type=CAROUSEL, children=[...] -> parent id
 *   3. POST /{ig-user-id}/media_publish  creation_id=<parent>      -> post id
 *
 * Two constraints that bite:
 *   - Meta FETCHES image_url server-side. Local files cannot be uploaded here,
 *     so the PNGs must already be on a public HTTPS host. IG_PUBLIC_ASSET_BASE
 *     is that host, and the URL is built as
 *     <base>/<deckId>/<platform>/<NN>.png
 *   - Carousel children are cropped to match the FIRST image's aspect ratio.
 *     Every slide the generator emits for a platform is identical in size, so
 *     this is satisfied by construction — but it is why you must never mix a
 *     tiktok/ 9:16 slide into an instagram/ 4:5 carousel.
 *
 * Rate limit: 100 API-published posts per rolling 24h. A carousel counts as
 * one. Irrelevant at our volume, noted so nobody re-derives it.
 */

import { config } from "../config.mjs";

export const name = "instagram";

const DRY_RUN = process.env.DRY_RUN === "1";

function graph(path) {
  return `https://graph.facebook.com/${config.instagram.graphVersion}/${path}`;
}

/**
 * The access token must never reach a log. It is sent as a form field rather
 * than a query parameter so it does not end up in any URL string that an error
 * or a stack trace could echo.
 */
async function post(path, params) {
  const body = new URLSearchParams({ ...params, access_token: config.instagram.accessToken });
  let res, text;
  try {
    res = await fetch(graph(path), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    text = await res.text();
  } catch (err) {
    throw new Error(`instagram ${path} network failure: ${scrub(err.message)}`);
  }

  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`instagram ${path}: non-JSON reply (HTTP ${res.status})`); }
  if (json.error) throw new Error(`instagram ${path}: ${scrub(json.error.message)} (code ${json.error.code}${json.error.error_subcode ? `/${json.error.error_subcode}` : ""})`);
  if (!res.ok) throw new Error(`instagram ${path}: HTTP ${res.status}`);
  return json;
}

function scrub(s) {
  const t = String(s ?? "");
  const tok = config.instagram.accessToken;
  return tok ? t.split(tok).join("<IG_TOKEN_REDACTED>") : t;
}

export async function publish(item) {
  const { userId, publicAssetBase } = config.instagram;
  const base = publicAssetBase.replace(/\/+$/, "");
  const imageUrls = item.slideFiles.map((f) => `${base}/${item.deckId}/${item.platform}/${f}`);

  const fullCaption = `${item.caption}\n\n${item.hashtags.join(" ")}`;

  if (DRY_RUN) {
    return {
      published: false,
      postId: null,
      url: null,
      note: `DRY_RUN — would publish ${imageUrls.length} slides as a carousel to IG user ${userId}.\n` +
            `First image: ${imageUrls[0]}\nCaption length: ${fullCaption.length} chars`,
    };
  }

  // 1. child containers
  const children = [];
  for (const image_url of imageUrls) {
    const child = await post(`${userId}/media`, { image_url, is_carousel_item: "true" });
    children.push(child.id);
  }

  // 2. parent container
  const parent = await post(`${userId}/media`, {
    media_type: "CAROUSEL",
    children: children.join(","),
    caption: fullCaption,
  });

  // 3. publish
  const published = await post(`${userId}/media_publish`, { creation_id: parent.id });

  return {
    published: true,
    postId: published.id,
    url: null, // media_publish returns an id, not a permalink; fetch permalink separately if ever needed
    note: `Published carousel (${children.length} slides), media id ${published.id}`,
  };
}
