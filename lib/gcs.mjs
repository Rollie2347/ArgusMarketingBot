/**
 * Uploads slide JPEGs to a public-read Cloud Storage bucket, so Instagram can
 * fetch them. Instagram's API takes image URLs only — it will not accept a
 * file upload for photos — so a public host is the price of posting for free.
 *
 * The bucket (MARKETING_GCS_BUCKET, created 2026-09-26 in n8n-ai-agents-470515):
 *   - allUsers: roles/storage.legacyObjectReader — anyone can GET an object
 *     by exact name, nobody can LIST the bucket
 *   - lifecycle: objects deleted after 14 days (Instagram keeps its own copy
 *     once a post is published)
 *   - the uploader service account has roles/storage.objectCreator on this
 *     one bucket and nothing else: it can add objects, not read, overwrite or
 *     delete them, and has no access to any other resource
 *
 * Object names carry a random segment, so a slide isn't guessable before it
 * posts. Everything uploaded here is public by design — never put anything
 * but finished slides in it.
 *
 * No SDK: a service-account JWT is signed with node:crypto and exchanged for
 * an access token (RFC 7523), cached until shortly before it expires.
 */

import { createSign, randomBytes } from "node:crypto";

const UPLOAD_BASE = process.env.GCS_UPLOAD_BASE || "https://storage.googleapis.com/upload/storage/v1";
const PUBLIC_BASE = process.env.GCS_PUBLIC_BASE || "https://storage.googleapis.com";

let cached = null; // { token, exp }

function serviceAccount() {
  const b64 = process.env.MARKETING_GCS_KEY_B64;
  if (!b64) throw new Error("MARKETING_GCS_KEY_B64 is not set — the uploader's service-account key (see bot/.env.example)");
  try {
    const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (!sa.client_email || !sa.private_key) throw new Error("missing fields");
    return sa;
  } catch {
    throw new Error("MARKETING_GCS_KEY_B64 is not a base64 service-account key JSON");
  }
}

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

async function accessToken() {
  if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/devstorage.read_write",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // The error body never contains the key; the assertion is not echoed.
    throw new Error(`gcs auth failed: HTTP ${res.status} ${json.error || ""} ${json.error_description || ""}`.trim());
  }
  cached = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return cached.token;
}

/** A short random path segment, so uploads aren't guessable before posting. */
export const randomSegment = () => randomBytes(9).toString("base64url");

/**
 * @param {Buffer} bytes
 * @param {string} name   object name, e.g. "ig/<deck>/<rand>/01.jpg"
 * @returns {Promise<string>} the public HTTPS URL
 */
export async function uploadPublic(bytes, name, contentType = "image/jpeg") {
  const bucket = process.env.MARKETING_GCS_BUCKET;
  if (!bucket) throw new Error("MARKETING_GCS_BUCKET is not set");
  const token = await accessToken();
  const url = `${UPLOAD_BASE}/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(`gcs upload ${name}: network failure: ${err.message}`);
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`gcs upload ${name}: HTTP ${res.status} ${j.error?.message || ""}`.trim());
  }
  return `${PUBLIC_BASE}/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}`;
}
