/**
 * Publishing through Upload-Post (upload-post.com) — TikTok photo carousels
 * and Instagram carousels.
 *
 * Why an aggregator instead of our own API apps: TikTok forces every post from
 * an unaudited API client to SELF_ONLY (see tiktok.mjs), and its audit is
 * weeks long with no guarantee for a one-operator internal tool. Upload-Post
 * runs an already-audited TikTok integration and a Meta app, so the accounts
 * are connected once in its dashboard and this file only ever talks to it.
 * The cost is a monthly plan and a third party holding the platform tokens.
 *
 * ⚠️ UNVERIFIED against the live API — written from its published reference
 * (docs.upload-post.com/api/upload-photo, read 2026-09-26) and tested against
 * a local fake. Do the first run with UPLOADPOST_TIKTOK_POST_MODE=MEDIA_UPLOAD
 * (TikTok gets a draft, nothing goes public) or DRY_RUN=1.
 *
 * Request:  POST /api/upload_photos   multipart
 *           Authorization: Apikey <key>
 *           user, platform[], photos[] (+ per-platform fields below)
 * Response: { success, results: { <platform>: { success, url, error? } } }
 *           or, for slow uploads, { success, request_id } → poll
 *           GET /api/uploadposts/status?request_id=…
 *
 * Three behaviours of that API this adapter defends against:
 *   1. An UNCONNECTED platform is reported as "skipped", not as a failure.
 *      Treating that as success is exactly the silent "approved but never
 *      posted" failure the whole approval gate exists to prevent — so anything
 *      other than an explicit success for our platform throws.
 *   2. TikTok photos accept JPG/JPEG/WebP only. PNG is refused, so this posts
 *      the renderer's JPEG twins and throws if they are missing.
 *   3. Uploads over ~59s switch to async on their own, so a reply may carry a
 *      request_id instead of results.
 *
 * One platform per request, even though the API takes several: the TikTok
 * (9:16) and Instagram (4:5) slides are different files, and each platform is
 * approved, scheduled and tracked as its own queue item.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, OUT_DIR } from "../config.mjs";

export const name = "uploadpost";

const DRY_RUN = process.env.DRY_RUN === "1";
const POLL_EVERY_MS = parseInt(process.env.UPLOADPOST_POLL_MS || "5000", 10);
const POLL_FOR_MS = 10 * 60_000;

function scrub(s) {
  const k = config.uploadpost.apiKey;
  const t = String(s ?? "");
  return k ? t.split(k).join("<UPLOADPOST_KEY_REDACTED>") : t;
}

async function request(path, init) {
  const { apiBase, apiKey } = config.uploadpost;
  let res, text;
  try {
    res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Apikey ${apiKey}` },
      signal: AbortSignal.timeout(180_000),
    });
    text = await res.text();
  } catch (err) {
    throw new Error(`upload-post ${path.split("?")[0]}: network failure: ${scrub(err.message)}`);
  }
  let json = null;
  try { json = JSON.parse(text); } catch { /* below */ }
  if (!json) throw new Error(`upload-post ${path.split("?")[0]}: non-JSON reply (HTTP ${res.status})`);
  if (!res.ok || json.success === false) {
    const detail = json.invalid_platforms ? ` ${JSON.stringify(json.invalid_platforms)}` : "";
    throw new Error(`upload-post: ${scrub(json.message || `HTTP ${res.status}`)}${json.error_code ? ` [${json.error_code}]` : ""}${detail} (HTTP ${res.status})`);
  }
  return json;
}

/** Caption + hashtags as one string, the way both platforms display it. */
const fullCaption = (item) => `${item.caption}\n\n${item.hashtags.join(" ")}`.trim();

/** TikTok photo titles cap at 90 chars; use the caption's first sentence. */
function tiktokTitle(item) {
  const first = String(item.caption || item.title).split(/(?<=[.!?])\s|\n/)[0].trim();
  return first.length <= 90 ? first : `${first.slice(0, 87).trimEnd()}…`;
}

export async function publish(item) {
  const { apiKey, user, tiktokPostMode, tiktokAutoMusic } = config.uploadpost;
  if (!apiKey || !user) throw new Error("UPLOADPOST_API_KEY and UPLOADPOST_USER must both be set to publish through Upload-Post");
  if (!["tiktok", "instagram"].includes(item.platform)) throw new Error(`upload-post adapter does not handle platform "${item.platform}"`);

  const files = item.jpgFiles || [];
  if (!files.length || files.length !== item.slideFiles.length) {
    throw new Error(`${item.id} has no JPEG slides (TikTok refuses PNG). Re-render with scripts/make-slideshow.mjs (not --fallback), then re-enqueue.`);
  }
  const dir = join(OUT_DIR, item.deckId, item.platform);
  for (const f of files) if (!existsSync(join(dir, f))) throw new Error(`missing slide ${join(item.deckId, item.platform, f)}`);

  const form = new FormData();
  form.set("user", user);
  form.append("platform[]", item.platform);
  for (const f of files) form.append("photos[]", new Blob([readFileSync(join(dir, f))], { type: "image/jpeg" }), f);
  form.set("external_id", item.id);

  if (item.platform === "tiktok") {
    form.set("title", tiktokTitle(item));
    form.set("tiktok_title", tiktokTitle(item));
    form.set("tiktok_description", fullCaption(item));
    form.set("post_mode", tiktokPostMode);
    form.set("privacy_level", "PUBLIC_TO_EVERYONE");
    form.set("auto_add_music", String(tiktokAutoMusic));
    form.set("photo_cover_index", "0");
    // TikTok requires realistic AI-generated content to be labelled. The
    // slides' photographs are generated, so decks that use them say so.
    if (item.aiImages) form.set("tiktok_is_ai_generated", "true");
  } else {
    form.set("title", fullCaption(item));
    form.set("instagram_title", fullCaption(item));
    if (item.aiImages) form.set("is_ai_generated", "true");
  }

  if (DRY_RUN) {
    return {
      published: false, postId: null, url: null,
      note: `DRY_RUN — would upload ${files.length} JPEG slides to ${item.platform} for Upload-Post user "${user}"` +
            `${item.platform === "tiktok" ? ` (${tiktokPostMode}, music ${tiktokAutoMusic ? "auto" : "none"})` : ""}` +
            `${item.aiImages ? ", labelled AI-generated" : ""}. Caption ${fullCaption(item).length} chars.`,
    };
  }

  // The item id as the idempotency key: a retry after a timeout — where the
  // upload may actually have gone through — must not double-post. The
  // attempt suffix changes only after an explicit failure reply, so "Retry
  // publish" after a real error is a genuine new attempt.
  const attempt = (item.history || []).filter((h) => h.status === "publish_failed" && !/network failure/.test(h.error || "")).length;
  let json = await request("/api/upload_photos", {
    method: "POST",
    headers: { "idempotency-key": `${item.id}#${attempt}` },
    body: form,
  });

  if (!json.results && json.request_id) json = await poll(json.request_id);

  const r = json.results?.[item.platform];
  if (!r) throw new Error(`upload-post returned no result for ${item.platform} — is the ${item.platform} account connected to Upload-Post user "${user}"?`);
  if (r.success !== true) {
    throw new Error(`upload-post ${item.platform}: ${scrub(r.error || r.message || r.status || JSON.stringify(r).slice(0, 200))}`);
  }

  const draft = item.platform === "tiktok" && tiktokPostMode === "MEDIA_UPLOAD";
  return {
    published: !draft,
    postId: r.post_id || r.id || r.publish_id || null,
    url: r.url || null,
    note: draft
      ? "Sent to TikTok as a DRAFT (MEDIA_UPLOAD) — open TikTok, finish and post it, then /posted."
      : `Published via Upload-Post${r.url ? "" : " (no URL returned yet)"}.`,
  };
}

/**
 * Is the key valid, and are the platforms we publish to actually connected?
 * Run at bot startup and by scripts/check-uploadpost.mjs — a disconnected
 * account should be one warning, not a PUBLISH FAILED at every slot.
 * GET /api/uploadposts/users/{profile} → profile.social_accounts.<platform>
 * is an object when connected, null/"" when not.
 *
 * @returns {Promise<{ok:boolean, connected:Object<string,string>, missing:string[], error?:string}>}
 */
export async function checkConnection(platforms = ["tiktok", "instagram"]) {
  const { apiKey, user } = config.uploadpost;
  if (!apiKey || !user) return { ok: false, connected: {}, missing: platforms, error: "UPLOADPOST_API_KEY and UPLOADPOST_USER are not both set" };
  try {
    const json = await request(`/api/uploadposts/users/${encodeURIComponent(user)}`, { method: "GET" });
    const accounts = json.profile?.social_accounts || {};
    const connected = {};
    const missing = [];
    for (const p of platforms) {
      const a = accounts[p];
      if (a && typeof a === "object") connected[p] = a.username || a.display_name || "(connected)";
      else missing.push(p);
    }
    return { ok: missing.length === 0, connected, missing };
  } catch (err) {
    return { ok: false, connected: {}, missing: platforms, error: scrub(err.message) };
  }
}

async function poll(requestId) {
  const until = Date.now() + POLL_FOR_MS;
  let last = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    last = await request(`/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`, { method: "GET" });
    const done = last.status && !["processing", "pending", "queued", "in_progress"].includes(String(last.status).toLowerCase());
    if (done || (last.total && last.completed >= last.total)) return last;
  }
  throw new Error(`upload-post request ${requestId} still ${last?.status || "unknown"} after ${POLL_FOR_MS / 60000} min — check the Upload-Post dashboard before retrying, it may still post`);
}
