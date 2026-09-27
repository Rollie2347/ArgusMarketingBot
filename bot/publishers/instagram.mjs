/**
 * Instagram carousel publishing — free, direct, via the Instagram API with
 * Instagram Login (graph.instagram.com). No Facebook Page, no Meta App Review:
 * a Meta app in development mode can publish to accounts that hold a role on
 * it, which is exactly one account here — ours.
 *
 * ⚠️ UNVERIFIED against the live API until the first real post — written from
 * developers.facebook.com/docs/instagram-platform/content-publishing (read
 * 2026-09-26) and tested against a local fake. First run with DRY_RUN=1.
 *
 * Flow:
 *   0. upload the JPEG slides to the public bucket (lib/gcs.mjs) — Instagram
 *      takes image URLs only, and JPEG only
 *   1. POST /{ig-user-id}/media  image_url, is_carousel_item=true   per slide
 *   2. POST /{ig-user-id}/media  media_type=CAROUSEL, children, caption
 *   3. GET  /{container}?fields=status_code  until FINISHED
 *   4. POST /{ig-user-id}/media_publish  creation_id
 *   5. GET  /{media-id}?fields=permalink
 *
 * The token goes in an Authorization header, never a URL, and every error
 * passes through scrubToken(). It is refreshed by the bot (igtoken.mjs).
 *
 * Instagram has no idempotency key, so a retry after a publish whose reply
 * was lost could double-post. Before publishing, this checks the account's
 * last few posts for the same caption within the last hour and, if found,
 * reports THAT post instead of posting again.
 *
 * Limits: 100 API posts / 24h (a carousel is one), 10 slides per carousel,
 * every slide cropped to the first one's aspect ratio (ours are all 4:5).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, OUT_DIR } from "../config.mjs";
import { currentToken, currentUserId, scrubToken } from "../igtoken.mjs";
import { uploadPublic, randomSegment } from "../../lib/gcs.mjs";

export const name = "instagram";

const GRAPH = process.env.IG_GRAPH_BASE || "https://graph.instagram.com";
const DRY_RUN = process.env.DRY_RUN === "1";
const POLL_MS = parseInt(process.env.IG_POLL_MS || "3000", 10);

const api = (path) => `${GRAPH}/${config.instagram.graphVersion}/${path}`;

async function call(method, path, params = null) {
  const token = currentToken();
  if (!token) throw new Error("no Instagram access token — set IG_ACCESS_TOKEN (see bot/.env.example)");
  let res, text;
  try {
    const url = method === "GET" && params ? `${api(path)}?${new URLSearchParams(params)}` : api(path);
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: method === "POST" ? new URLSearchParams(params || {}) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    text = await res.text();
  } catch (err) {
    throw new Error(`instagram ${path}: network failure: ${scrubToken(err.message)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`instagram ${path}: non-JSON reply (HTTP ${res.status})`); }
  if (json.error) {
    const e = json.error;
    const hint = e.code === 190 ? " — the access token is invalid or expired; generate a new one and set IG_ACCESS_TOKEN" : "";
    throw new Error(`instagram ${path}: ${scrubToken(e.message)} (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})${hint}`);
  }
  if (!res.ok) throw new Error(`instagram ${path}: HTTP ${res.status}`);
  return json;
}

const fullCaption = (item) => `${item.caption}\n\n${item.hashtags.join(" ")}`.trim();

async function waitFinished(containerId) {
  const until = Date.now() + 5 * 60_000;
  let status = null;
  while (Date.now() < until) {
    ({ status_code: status } = await call("GET", containerId, { fields: "status_code" }));
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`instagram container ${containerId} is ${status} — usually an image Instagram could not fetch or accept`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`instagram container ${containerId} still ${status} after 5 min`);
}

/** Already posted within the hour with this exact caption? (lost-reply guard) */
async function findRecentDuplicate(userId, caption) {
  try {
    const { data = [] } = await call("GET", `${userId}/media`, { fields: "id,caption,permalink,timestamp", limit: "5" });
    const hourAgo = Date.now() - 3600_000;
    return data.find((m) => m.caption?.trim() === caption.trim() && Date.parse(m.timestamp) >= hourAgo) || null;
  } catch {
    return null; // the guard is best-effort; never block a post on it
  }
}

export async function publish(item) {
  // From the env, or stored by the /instagram Telegram command.
  const userId = currentUserId();
  if (!userId) throw new Error("no Instagram account set up — send /instagram <token> to the bot (see bot/README.md)");
  const files = item.jpgFiles || [];
  if (!files.length || files.length !== item.slideFiles.length) {
    throw new Error(`${item.id} has no JPEG slides (Instagram accepts JPEG only). Re-render with scripts/make-slideshow.mjs (not --fallback), then re-enqueue.`);
  }
  if (files.length > 10) throw new Error(`${item.id} has ${files.length} slides; Instagram carousels take at most 10`);
  const dir = join(OUT_DIR, item.deckId, item.platform);
  for (const f of files) if (!existsSync(join(dir, f))) throw new Error(`missing slide ${join(item.deckId, item.platform, f)}`);

  const caption = fullCaption(item);
  if (caption.length > 2200) throw new Error(`caption is ${caption.length} chars; Instagram's limit is 2200`);

  if (DRY_RUN) {
    return {
      published: false, postId: null, url: null,
      note: `DRY_RUN — would upload ${files.length} JPEGs to gs://${process.env.MARKETING_GCS_BUCKET || "(MARKETING_GCS_BUCKET unset)"} and publish a carousel to IG user ${userId}. Caption ${caption.length} chars.`,
    };
  }

  const dup = await findRecentDuplicate(userId, caption);
  if (dup) {
    return { published: true, postId: dup.id, url: dup.permalink || null, note: "Already on Instagram (same caption, posted within the hour) — recorded it rather than posting twice." };
  }

  // 0. host the slides
  const prefix = `ig/${item.deckId}/${randomSegment()}`;
  const urls = [];
  for (const f of files) urls.push(await uploadPublic(readFileSync(join(dir, f)), `${prefix}/${f}`));

  // 1. one container per slide
  const children = [];
  for (const image_url of urls) {
    const child = await call("POST", `${userId}/media`, { image_url, is_carousel_item: "true" });
    children.push(child.id);
  }

  // 2–3. the carousel container, once Instagram has fetched everything
  const parent = await call("POST", `${userId}/media`, { media_type: "CAROUSEL", children: children.join(","), caption });
  await waitFinished(parent.id);

  // 4. publish
  const published = await call("POST", `${userId}/media_publish`, { creation_id: parent.id });

  // 5. the permalink, for TRACKING.md — best-effort; the post is already live
  let permalink = null;
  try { ({ permalink = null } = await call("GET", published.id, { fields: "permalink" })); } catch { /* keep going */ }

  return {
    published: true,
    postId: published.id,
    url: permalink,
    note: `Published carousel (${children.length} slides).${item.aiImages ? " Contains AI-generated photos — if Meta doesn't auto-label it, add the AI label in the app." : ""}`,
  };
}
