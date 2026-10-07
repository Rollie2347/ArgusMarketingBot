/**
 * Minimal Gemini API client for the marketing pipeline: one call for JSON text,
 * one for an image. No SDK — this directory has no npm dependencies on purpose.
 *
 * ⚠️ USE A SEPARATE KEY FROM THE ARGUS BACKEND.
 * MARKETING_GEMINI_API_KEY, from its own GCP project with its own budget
 * alert. The backend's GEMINI_API_KEY carries every Live session; a runaway
 * image loop on the same key would spend the budget that keeps the app
 * working, and a billing problem on it kills every session instantly (the
 * 1008 "dunning" incident). The two must be able to fail independently.
 *
 * The key goes in the x-goog-api-key header, never in the URL, so no error
 * message or stack trace can echo it; every error still passes through
 * redact() as a second line of defence.
 */

const API = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";

/** Current as of 2026-09. Both overridable without a code change. */
export const TEXT_MODEL = process.env.MARKETING_TEXT_MODEL || "gemini-3.8-flash";
export const IMAGE_MODEL = process.env.MARKETING_IMAGE_MODEL || "gemini-3.1-flash-image";

function key() {
  const k = process.env.MARKETING_GEMINI_API_KEY;
  if (!k) throw new Error("MARKETING_GEMINI_API_KEY is not set — see bot/.env.example");
  return k;
}

export function redact(s) {
  const k = process.env.MARKETING_GEMINI_API_KEY;
  const t = String(s ?? "");
  return k ? t.split(k).join("<GEMINI_KEY_REDACTED>") : t;
}

async function generate(model, body, { timeoutMs }) {
  const url = `${API}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastErr;
  // Two retries, only for the failures that are worth retrying: rate limits
  // and server errors. A 400 is our bug and retrying it just spends money.
  for (let attempt = 0; attempt < 3; attempt++) {
    let res, text;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      // A timeout is the model still working, not the network: say which, or
      // the report sends whoever reads it to check the wrong thing.
      lastErr = err?.name === "TimeoutError"
        ? new Error(`gemini ${model}: no reply within ${Math.round(timeoutMs / 1000)}s (tried ${attempt + 1}×) — the request is too slow, not the network`)
        : new Error(`gemini ${model}: network failure: ${redact(err.message)}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (res.ok && json) return json;

    const msg = json?.error?.message || text.slice(0, 300);
    lastErr = new Error(`gemini ${model}: HTTP ${res.status}: ${redact(msg)}`);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw lastErr;
}

/** Why a response carried no usable content — the answer is never "nothing". */
function emptyReason(json) {
  const c = json?.candidates?.[0];
  if (json?.promptFeedback?.blockReason) return `prompt blocked: ${json.promptFeedback.blockReason}`;
  if (!c) return "no candidates in response";
  return `finishReason ${c.finishReason || "unknown"}`;
}

/**
 * JSON text generation. Returns the parsed object, or throws with the reason.
 */
export async function generateJson(prompt, { system = null, temperature = 0.9, model = TEXT_MODEL } = {}) {
  const json = await generate(model, {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", temperature },
  }, { timeoutMs: 180_000 });

  const text = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error(`gemini ${model}: empty reply (${emptyReason(json)})`);
  try {
    return JSON.parse(text);
  } catch {
    // Some replies wrap JSON in a fence despite the MIME type.
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) return JSON.parse(m[1]);
    throw new Error(`gemini ${model}: reply was not JSON (${text.length} chars)`);
  }
}

/**
 * One image. Returns { bytes: Buffer, mimeType }.
 * aspectRatio: "9:16" for our slides (the 4:5 Instagram cut is a CSS crop).
 */
export async function generateImage(prompt, { aspectRatio = "9:16", model = IMAGE_MODEL } = {}) {
  const json = await generate(model, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio },
    },
  }, { timeoutMs: 180_000 });

  for (const part of json?.candidates?.[0]?.content?.parts || []) {
    const d = part.inlineData || part.inline_data;
    if (d?.data) return { bytes: Buffer.from(d.data, "base64"), mimeType: d.mimeType || d.mime_type || "image/png" };
  }
  throw new Error(`gemini ${model}: no image in reply (${emptyReason(json)})`);
}
