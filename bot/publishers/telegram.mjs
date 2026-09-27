/**
 * The free TikTok path: at the posting slot, the bot sends the finished slides
 * and a tap-to-copy caption to Telegram, and a human posts them from the phone
 * (about a minute). Then one tap on "✅ I posted it" records it.
 *
 * Why not the TikTok API for free: an unaudited API client can only post
 * SELF_ONLY (private), and the draft-to-inbox route needs a TikTok developer
 * app plus a verified domain to pull photos from — setup that saves maybe 30
 * seconds per post over this. See publishers/tiktok.mjs.
 *
 * Works for any platform; it is the default publisher, replacing "manual",
 * whose hand-off was a file on whatever machine runs the bot — invisible when
 * that machine is a server.
 *
 * Photos go as an album (not as files) so they save to the camera roll in one
 * action, in slide order. Telegram recompresses them lightly; TikTok and
 * Instagram recompress everything anyway.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, OUT_DIR, MARKETING_ROOT } from "../config.mjs";
import * as tg from "../telegram.mjs";

/** config.json tiktokAccount: "personal" (no bio link, full sound library) or "business". */
function tiktokAccount() {
  try { return JSON.parse(readFileSync(join(MARKETING_ROOT, "config.json"), "utf8")).tiktokAccount || "business"; }
  catch { return "business"; }
}

export const name = "telegram";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STEPS = {
  tiktok: (item) => [
    "Long-press the album → <b>Save</b> (keeps slide order)",
    "TikTok → <b>+</b> → Upload → pick the slides <b>in order</b> → it becomes a photo post",
    tiktokAccount() === "personal"
      ? "Add a <b>trending sound</b> (personal account — the full library is yours)"
      : "Add a sound — Business accounts only get the <b>Commercial Music Library</b>",
    "Tap the caption below to copy it, paste it in",
    ...(item.aiImages ? ["<b>More options → AI-generated content: ON</b> (the photos are generated)"] : []),
    ...(tiktokAccount() === "personal" ? [] : ["Post from the <b>Business</b> account"]),
  ],
  instagram: (item) => [
    "Long-press the album → <b>Save</b> (keeps slide order)",
    "Instagram → <b>+</b> → Post → select the slides <b>in order</b> (4:5)",
    "Tap the caption below to copy it, paste it in",
    ...(item.aiImages ? ["Advanced settings → <b>Add AI label: ON</b>"] : []),
    "Same day: share to your Story with a <b>link sticker</b> (RESEARCH §2.3)",
  ],
};

export async function publish(item) {
  const chat = String(config.allowedChatId);
  const files = (item.jpgFiles?.length ? item.jpgFiles : item.slideFiles)
    .map((f) => ({ name: f, bytes: readFileSync(join(OUT_DIR, item.deckId, item.platform, f)) }));
  const platform = item.platform === "tiktok" ? "TikTok" : item.platform === "instagram" ? "Instagram" : item.platform;

  await tg.sendMediaGroup(chat, files.slice(0, 10), `📲 ${item.deckId} → ${platform}`);

  const steps = (STEPS[item.platform] || STEPS.instagram)(item);
  await tg.sendMessage(chat, [
    `📲 <b>Post to ${esc(platform)} now</b> — <code>${esc(item.id)}</code>`,
    "",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    item.platform === "tiktok" && tiktokAccount() === "personal"
      ? "No bio link on TikTok — the slides tell viewers to search “My Argus”."
      : `Bio link: ${esc(item.trackingUrl || "(not configured)")}`,
  ].join("\n"), { parse_mode: "HTML" });

  // Its own message, nothing else in it: <pre> is tap-to-copy on mobile, and
  // this way the copy is exactly the caption.
  await tg.sendMessage(chat, `<pre>${esc(`${item.caption}\n\n${item.hashtags.join(" ")}`.trim())}</pre>`, {
    parse_mode: "HTML",
    reply_markup: tg.keyboard([[tg.button("✅ I posted it", `P|${item.id}`)]]),
  });

  return {
    published: false,
    handedOff: true,
    postId: null,
    url: null,
    note: "Sent to Telegram for posting by hand.",
  };
}
