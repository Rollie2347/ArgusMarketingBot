/**
 * The Instagram access token, kept alive.
 *
 * An Instagram-Login long-lived token lasts 60 days. It can be refreshed (for
 * another 60) once it is at least 24 hours old, and a refreshed token REPLACES
 * the old one — so the new value has to be stored somewhere the next restart
 * reads. That is bot/state/ig-token.json (gitignored, on the /data volume on a
 * server): IG_ACCESS_TOKEN in the environment seeds it once, and after that
 * the stored token wins whenever it is newer.
 *
 * The bot calls refreshIfDue() once a day. A refresh that fails is not fatal
 * — the current token keeps working until it expires — but it is reported,
 * and so is a token within 10 days of expiry, because an expired token turns
 * every Instagram post into a PUBLISH FAILED until a human pastes a new one.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config.mjs";

const FILE = join(STATE_DIR, "ig-token.json");
const GRAPH = process.env.IG_GRAPH_BASE || "https://graph.instagram.com";
const REFRESH_EVERY_MS = 7 * 86400_000;

function stored() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return null; }
}

function store(v) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(`${FILE}.tmp`, JSON.stringify(v, null, 2), "utf8");
  renameSync(`${FILE}.tmp`, FILE);
}

/** The token to use right now. */
export function currentToken() {
  const env = process.env.IG_ACCESS_TOKEN || null;
  const s = stored();
  // A new token pasted into the env (e.g. after an expiry) must win over the
  // stored one — detect it by it simply being different from what seeded it.
  if (env && (!s || s.seed !== env)) {
    store({ ...(s || {}), token: env, seed: env, refreshedAt: null, expiresAt: null });
    return env;
  }
  return s?.token || null;
}

/** The Instagram account id to publish as: env, else the one /instagram stored. */
export function currentUserId() {
  return process.env.IG_USER_ID || stored()?.userId || null;
}

/**
 * Checks a token against Instagram before anything is stored: GET /me with it
 * (in the Authorization header) must return the account. Resolves the
 * account's publishing id and username, or throws with Instagram's reason.
 */
export async function verifyToken(token, graphVersion = process.env.IG_GRAPH_VERSION || "v25.0") {
  let res, json;
  try {
    res = await fetch(`${GRAPH}/${graphVersion}/me?fields=user_id,username,account_type`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    throw new Error(`couldn't reach Instagram: ${String(err.message).split(token).join("<token>")}`);
  }
  if (!res.ok || !json || json.error) {
    const why = String(json?.error?.message || `HTTP ${res.status}`).split(token).join("<token>");
    throw new Error(`Instagram rejected the token: ${why}`);
  }
  const userId = json.user_id || json.id;
  if (!userId) throw new Error("Instagram accepted the token but returned no account id");
  return { userId: String(userId), username: json.username || null, accountType: json.account_type || null };
}

/** Store a verified token (sent via /instagram) as the one to use from now on. */
export function setToken({ token, userId, username }) {
  const s = stored();
  store({
    token, userId, username,
    // Keep the env-seed marker, so this token isn't replaced by an older env value.
    seed: s?.seed ?? process.env.IG_ACCESS_TOKEN ?? null,
    refreshedAt: null, expiresAt: null, setAt: new Date().toISOString(),
  });
}

export const scrubToken = (text) => {
  let t = String(text ?? "");
  for (const tok of [process.env.IG_ACCESS_TOKEN, stored()?.token]) if (tok) t = t.split(tok).join("<IG_TOKEN_REDACTED>");
  return t;
};

/**
 * @returns {Promise<{refreshed:boolean, warning:string|null}>}
 */
export async function refreshIfDue(now = Date.now()) {
  const token = currentToken();
  if (!token) return { refreshed: false, warning: null };
  const s = stored();
  const last = s?.refreshedAt ? Date.parse(s.refreshedAt) : 0;
  if (now - last < REFRESH_EVERY_MS) return { refreshed: false, warning: expiryWarning(s, now) };

  let json = null, status = 0;
  try {
    // The refresh endpoint takes the token as a query parameter — the one
    // place it appears in a URL. Nothing here logs the URL, and errors pass
    // through scrubToken().
    const res = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(30_000) });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch (err) {
    return { refreshed: false, warning: `Instagram token refresh failed: ${scrubToken(err.message)}` };
  }
  if (!json?.access_token) {
    const why = scrubToken(json?.error?.message || `HTTP ${status}`);
    // "too new" is the normal answer for a token under 24h old — not a warning.
    if (/24 hours|too new|not old enough/i.test(why)) return { refreshed: false, warning: null };
    return { refreshed: false, warning: `Instagram token refresh failed: ${why}. ${expiryWarning(s, now) || ""}`.trim() };
  }
  store({ token: json.access_token, seed: s?.seed ?? process.env.IG_ACCESS_TOKEN ?? null, refreshedAt: new Date(now).toISOString(), expiresAt: new Date(now + (json.expires_in || 5184000) * 1000).toISOString() });
  return { refreshed: true, warning: null };
}

function expiryWarning(s, now) {
  if (!s?.expiresAt) return null;
  const days = Math.floor((Date.parse(s.expiresAt) - now) / 86400_000);
  return days <= 10 ? `Instagram token expires in ${days} day(s) — generate a new one in the Meta app dashboard and set IG_ACCESS_TOKEN.` : null;
}
