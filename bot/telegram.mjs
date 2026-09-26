/**
 * Minimal Telegram Bot API client. No dependencies — Node 20+ has fetch,
 * FormData and Blob built in, and this needs six methods.
 *
 * ⚠️ THE TOKEN IS IN EVERY REQUEST URL.
 * Telegram puts the bot token in the path: https://api.telegram.org/bot<TOKEN>/method
 * So any error that echoes a URL leaks the token, and an unhandled fetch
 * rejection in Node prints the URL by default. This repo has already shipped a
 * placeholder WS_SHARED_SECRET to production and leaked a GEMINI_API_KEY into a
 * transcript, so every exit path here goes through redact() and no function
 * returns, throws or logs a raw URL.
 */

// Overridable so bot/test/ can stand up a fake Bot API locally and exercise the
// real request/response paths. Never point this at anything but Telegram or a
// local test server — the bot token is in the request path.
const API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

let TOKEN = null;

export function configure(token) {
  TOKEN = token;
}

/** Strips the bot token out of anything on its way to a log or an exception. */
export function redact(s) {
  const text = String(s ?? "");
  if (!TOKEN) return text;
  return text.split(TOKEN).join("<BOT_TOKEN_REDACTED>");
}

function url(method) {
  if (!TOKEN) throw new Error("telegram.configure(token) was never called");
  return `${API}/bot${TOKEN}/${method}`;
}

/** Never include `method` output or the response body verbatim without redact(). */
async function call(method, body, { timeoutMs = 20_000, isForm = false } = {}) {
  let res;
  try {
    res = await fetch(url(method), {
      method: "POST",
      ...(isForm ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A network-level failure. err.message can contain the URL.
    throw new Error(`telegram ${method} failed: ${redact(err.message)}`);
  }

  let json;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { throw new Error(`telegram ${method}: non-JSON reply (HTTP ${res.status})`); }

  if (!json.ok) {
    const err = new Error(`telegram ${method}: ${redact(json.description || "unknown error")} (HTTP ${res.status})`);
    err.telegramCode = json.error_code;
    err.retryAfter = json.parameters?.retry_after ?? null;
    throw err;
  }
  return json.result;
}

export async function getMe() {
  return call("getMe");
}

/**
 * Long poll. `timeout` is Telegram's server-side hold, so the HTTP timeout has
 * to exceed it or every poll aborts just before the server would have answered.
 */
export async function getUpdates(offset, timeout = 30) {
  return call("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message", "callback_query"],
  }, { timeoutMs: (timeout + 15) * 1000 });
}

export async function sendMessage(chatId, text, extra = {}) {
  return call("sendMessage", { chat_id: chatId, text, ...extra });
}

/**
 * A carousel, as a Telegram album. Caption goes on the first item only —
 * that is how Telegram renders an album caption.
 *
 * ⚠️ sendMediaGroup does NOT accept reply_markup. Inline buttons therefore
 * have to arrive as a separate message right after the album; there is no way
 * to attach them to the photos themselves. This is a Bot API limitation, not
 * a design choice, and it is why deliver() sends two messages.
 */
export async function sendMediaGroup(chatId, files, caption) {
  const form = new FormData();
  form.set("chat_id", String(chatId));

  const media = files.map((f, i) => ({
    type: "photo",
    media: `attach://f${i}`,
    ...(i === 0 && caption ? { caption: caption.slice(0, 1024), parse_mode: "HTML" } : {}),
  }));
  form.set("media", JSON.stringify(media));
  files.forEach((f, i) => form.set(`f${i}`, new Blob([f.bytes]), f.name));

  // Albums are slower than text; 10 photos over a slow uplink can take a while.
  return call("sendMediaGroup", form, { isForm: true, timeoutMs: 120_000 });
}

export async function answerCallbackQuery(id, text, showAlert = false) {
  try {
    return await call("answerCallbackQuery", { callback_query_id: id, text, show_alert: showAlert });
  } catch (err) {
    // A stale callback (older than ~15 min) can't be answered. That is not a
    // reason to drop the action the user just took, so this never rethrows.
    console.warn(`  ! could not answer callback: ${redact(err.message)}`);
    return null;
  }
}

/** Removes the buttons from a delivered card so a decision can't be double-submitted. */
export async function editMessageReplyMarkup(chatId, messageId, markup = null) {
  try {
    return await call("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId,
      ...(markup ? { reply_markup: markup } : {}),
    });
  } catch (err) {
    console.warn(`  ! could not clear buttons: ${redact(err.message)}`);
    return null;
  }
}

export const keyboard = (rows) => ({ inline_keyboard: rows });
export const button = (text, data) => ({ text, callback_data: data });
