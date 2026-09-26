#!/usr/bin/env node
/**
 * Argus marketing approval bot.
 *
 *   node bot/bot.mjs
 *
 * Long-polls Telegram, delivers queued slideshows to ONE authorised chat with
 * Approve / Reject / Request changes buttons, and on approval hands the item
 * to a publisher. Rejections and change requests are written to
 * marketing/FEEDBACK.md, which is the input to the next batch's hook library.
 *
 * ── POLLING, NOT WEBHOOKS ────────────────────────────────────────────────
 * Long polling, and a separate process from the Argus backend. Both halves of
 * that were a choice, so here is the reasoning:
 *
 *   1. A webhook needs a public HTTPS endpoint. The only public HTTPS service
 *      this project runs is the Cloud Run instance that holds the Gemini key
 *      and relays every Live session. Adding an inbound, internet-reachable
 *      route that accepts JSON from a third party to THAT service enlarges the
 *      attack surface of the most sensitive thing we run, to save a few
 *      seconds of latency on a human approval.
 *   2. CPU is the binding constraint on that service (#36) — each Live session
 *      base64-decodes ~43KB of audio every second plus a ~150KB frame every
 *      two. Telegram webhook traffic, including image uploads, would share
 *      that CPU with live conversations. The brief for the redirect counter
 *      said a flood must not affect session capacity; the same rule applies
 *      here, and polling satisfies it by not being on that service at all.
 *   3. Polling needs no inbound connectivity whatsoever. It runs from a
 *      laptop, a Pi, or a scale-to-zero job, with no public URL, no TLS cert,
 *      no secret webhook path, and nothing to leave exposed if the process
 *      dies.
 *   4. The workload is human-paced — a handful of approvals a day. The only
 *      thing polling costs is up to ~30s of latency on a button press, which
 *      is invisible for this task.
 *   5. Failure isolation. The marketing bot crashing, being restarted, or
 *      being edited mid-batch must never be able to touch a production Live
 *      session. Separate process, separate lifecycle.
 *
 * The honest counter-argument: a webhook scales better and costs nothing while
 * idle. At one operator and ten posts a batch, neither matters. If this ever
 * became multi-operator and high-volume, the answer would flip — and it should
 * still be its own service, not folded into the relay.
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, validate, describeSecret, OUT_DIR, FEEDBACK_FILE } from "./config.mjs";
import * as tg from "./telegram.mjs";
import { load, save, find, byStatus, transition, summarize, statusIcon } from "./queue.mjs";
import { getPublisher, describeMode } from "./publishers/index.mjs";

validate();
tg.configure(config.botToken);

const CHAT = String(config.allowedChatId);

/* ── authorisation ────────────────────────────────────────────────────────
 * The bot has one user. Telegram bot usernames are discoverable and anyone
 * can start a chat with one, so without this check a stranger who finds it
 * can approve posts to the real accounts. Every inbound update is checked
 * against the single allowed chat id before anything else happens.
 * ------------------------------------------------------------------------ */
function authorised(update) {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  // Both must match: chat id alone would let someone else acting inside the
  // authorised chat (if it were ever a group) press the buttons.
  return String(chatId) === CHAT && String(fromId) === CHAT;
}

let rejectedCount = 0;
function refuse(update) {
  rejectedCount++;
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  console.warn(`  ⛔ ignored update from unauthorised id ${fromId} (total: ${rejectedCount})`);
  if (update.callback_query) {
    tg.answerCallbackQuery(update.callback_query.id, "Not authorised.", true).catch(() => {});
  }
}

/* ── escaping ─────────────────────────────────────────────────────────────
 * Captions are sent with parse_mode HTML, and deck copy contains & and
 * apostrophes. Unescaped, Telegram rejects the whole message with a parse
 * error — which would look like "the bot is broken" rather than "slide 3 has
 * an ampersand".
 * ------------------------------------------------------------------------ */
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ── delivery ─────────────────────────────────────────────────────────── */

function cardText(item) {
  return [
    `<b>${esc(item.title)}</b> → <b>${esc(item.platform)}</b>`,
    `${esc(item.angle)} · hook <code>${esc(item.hookId)}</code>${item.ctaId ? ` · cta <code>${esc(item.ctaId)}</code>` : ""}`,
    "",
    `<b>Caption</b>`,
    esc(item.caption),
    "",
    esc(item.hashtags.join(" ")),
    "",
    `🔗 ${esc(item.trackingUrl || "(no redirect configured — marketing/TRACKING.md item 1)")}`,
    `🏷 <code>${esc(item.ct || "—")}</code>`,
    `📦 ${item.slideFiles.length} slides · <code>${esc(item.id)}</code>`,
  ].join("\n");
}

async function deliver(item) {
  const dir = join(OUT_DIR, item.deckId, item.platform);
  const files = item.slideFiles.map((f) => ({ name: f, bytes: readFileSync(join(dir, f)) }));

  // Telegram albums cap at 10. Decks are 6-9 slides, so this only trips if
  // someone raises the deck size limit — in which case truncating silently
  // would be the wrong answer, so it says so on the card.
  const truncated = files.length > 10;
  await tg.sendMediaGroup(CHAT, files.slice(0, 10), `${item.deckId} → ${item.platform}`);

  // Buttons go in a SECOND message: sendMediaGroup does not accept
  // reply_markup. See telegram.mjs.
  const sent = await tg.sendMessage(CHAT, cardText(item) + (truncated ? "\n\n⚠️ more than 10 slides — only the first 10 were previewed" : ""), {
    parse_mode: "HTML",
    reply_markup: tg.keyboard([[
      tg.button("✅ Approve", `a|${item.id}`),
      tg.button("❌ Reject", `r|${item.id}`),
      tg.button("✏️ Changes", `c|${item.id}`),
    ]]),
  });

  return sent.message_id;
}

async function deliverPending() {
  const q = load();
  const pending = byStatus(q, "pending");
  if (!pending.length) return;
  console.log(`  → delivering ${pending.length} pending item(s)`);
  for (const item of pending) {
    try {
      const messageId = await deliver(item);
      item.deliveredMessageId = messageId;
      transition(item, "awaiting", { messageId });
      // Persist after EACH delivery, not once at the end: a crash halfway
      // through a batch must not re-deliver the ones already sent.
      save(q);
      console.log(`    ⏳ ${item.id}`);
    } catch (err) {
      console.error(`    ✗ ${item.id}: ${tg.redact(err.message)}`);
      await tg.sendMessage(CHAT, `⚠️ Could not deliver <code>${esc(item.id)}</code>\n\n${esc(tg.redact(err.message))}`, { parse_mode: "HTML" })
        .catch(() => {});
    }
  }
}

/* ── feedback capture ─────────────────────────────────────────────────────
 * The reason a post was killed is the only signal in this whole loop that
 * says WHY something did not work, as opposed to that it didn't. It goes into
 * a file the next batch's hook library is written from, not just into the
 * queue JSON where nobody would read it.
 * ------------------------------------------------------------------------ */
function recordFeedback(item, kind, reason) {
  if (!existsSync(FEEDBACK_FILE)) {
    writeFileSync(FEEDBACK_FILE, `# Approval feedback

Written by the Telegram approval bot. One row per rejection or change request.

**This is the input to the next batch's HOOKS.md.** A hook that gets rejected
three times for the same reason is a hook to delete, not to rewrite again.

| When | Item | Angle | Hook | CTA | Decision | Reason |
|---|---|---|---|---|---|---|
`, "utf8");
  }
  const row = `| ${new Date().toISOString().slice(0, 16).replace("T", " ")} | \`${item.id}\` | ${item.angle} | \`${item.hookId}\` | \`${item.ctaId || "—"}\` | ${kind} | ${String(reason).replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
  appendFileSync(FEEDBACK_FILE, row, "utf8");
}

/* ── publishing ───────────────────────────────────────────────────────── */

async function runPublish(item) {
  const mode = config.publishers[item.platform] || "manual";
  const publisher = getPublisher(mode);

  let result;
  try {
    result = await publisher.publish(item);
  } catch (err) {
    // LOUD. An approved post that silently never published is the failure
    // mode this whole gate exists to prevent, so it gets its own status, its
    // own Telegram message with the real reason, and a Retry button.
    transition(item, "publish_failed", { publisher: mode, error: tg.redact(err.message) });
    item.reason = tg.redact(err.message);
    await tg.sendMessage(CHAT,
      `🔥 <b>PUBLISH FAILED</b> — <code>${esc(item.id)}</code>\n\n` +
      `Publisher: <code>${esc(mode)}</code>\n\n` +
      `${esc(tg.redact(err.message))}\n\n` +
      `It is approved but <b>not posted</b>. Nothing will retry on its own.`,
      { parse_mode: "HTML", reply_markup: tg.keyboard([[tg.button("🔁 Retry publish", `p|${item.id}`)]]) }
    ).catch(() => {});
    return false;
  }

  if (result.published) {
    item.postId = result.postId;
    item.postUrl = result.url;
    item.postedAt = new Date().toISOString();
    transition(item, "published", { publisher: mode, postId: result.postId });
    await tg.sendMessage(CHAT,
      `🚀 <b>Published</b> — <code>${esc(item.id)}</code>\n${esc(result.note)}` +
      (result.url ? `\n${esc(result.url)}` : ""),
      { parse_mode: "HTML" }).catch(() => {});
  } else {
    transition(item, "approved", { publisher: mode, note: result.note });
    await tg.sendMessage(CHAT,
      `✅ <b>Approved</b> — <code>${esc(item.id)}</code>\n\n` +
      `<b>Post this one by hand.</b> ${esc(result.note)}\n\n` +
      `Bio link: ${esc(item.trackingUrl || "(not configured)")}\n\n` +
      `When it's live: <code>/posted ${esc(item.id)} &lt;url&gt;</code>`,
      { parse_mode: "HTML" }).catch(() => {});
  }
  return true;
}

/* ── update handling ──────────────────────────────────────────────────── */

// item id -> what we asked for, so a force_reply can be matched back.
const awaitingReply = new Map();

async function onCallback(cb) {
  const [action, id] = String(cb.data || "").split("|");
  const q = load();
  const item = find(q, id);

  if (!item) { await tg.answerCallbackQuery(cb.id, "That item is no longer in the queue.", true); return; }

  // Guard against a second press on a card that was already decided — the
  // buttons are removed on decision, but a cached client can still fire.
  if (action !== "p" && !["awaiting", "pending"].includes(item.status)) {
    await tg.answerCallbackQuery(cb.id, `Already ${item.status}.`, true);
    return;
  }

  if (action === "a" || action === "p") {
    await tg.answerCallbackQuery(cb.id, "Approving…");
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);
    transition(item, "approved", { by: "telegram" });
    save(q);
    await runPublish(item);
    save(q);
    return;
  }

  if (action === "r" || action === "c") {
    const kind = action === "r" ? "rejected" : "changes_requested";
    await tg.answerCallbackQuery(cb.id, action === "r" ? "Rejecting — send the reason." : "Send the changes.");
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);
    awaitingReply.set(CHAT, { id, kind });
    await tg.sendMessage(CHAT,
      `${action === "r" ? "❌" : "✏️"} <code>${esc(id)}</code> — reply to this message with ${action === "r" ? "why it was rejected" : "what to change"}.\n\n` +
      `<i>It goes into marketing/FEEDBACK.md and shapes the next batch, so be specific — "hook is weak" helps nobody.</i>`,
      { parse_mode: "HTML", reply_markup: { force_reply: true, selective: true } });
    return;
  }

  await tg.answerCallbackQuery(cb.id, "Unknown action.");
}

async function onMessage(msg) {
  const text = String(msg.text || "").trim();

  // A pending reason/changes reply takes priority over command parsing.
  const pendingReply = awaitingReply.get(CHAT);
  if (pendingReply && text && !text.startsWith("/")) {
    const q = load();
    const item = find(q, pendingReply.id);
    awaitingReply.delete(CHAT);
    if (!item) { await tg.sendMessage(CHAT, "That item vanished from the queue."); return; }
    item.reason = text.slice(0, 500);
    transition(item, pendingReply.kind, { reason: item.reason });
    save(q);
    recordFeedback(item, pendingReply.kind === "rejected" ? "reject" : "changes", item.reason);
    await tg.sendMessage(CHAT, `Logged against <code>${esc(item.id)}</code> and appended to FEEDBACK.md.`, { parse_mode: "HTML" });
    return;
  }

  if (text === "/queue" || text === "/status") {
    await tg.sendMessage(CHAT, `<pre>${esc(summarize(load()))}</pre>`, { parse_mode: "HTML" });
    return;
  }

  if (text === "/pending") {
    await deliverPending();
    return;
  }

  if (text.startsWith("/posted")) {
    const [, id, url] = text.split(/\s+/);
    const q = load();
    const item = find(q, id);
    if (!item) { await tg.sendMessage(CHAT, `No queue item ${id ? `\`${id}\`` : "given"}.`); return; }
    item.postUrl = url || null;
    item.postedAt = new Date().toISOString();
    transition(item, "published", { by: "manual /posted", url: url || null });
    save(q);
    await tg.sendMessage(CHAT,
      `🚀 Recorded <code>${esc(item.id)}</code> as posted.\n\n` +
      `Add the TRACKING.md row:\n<pre>${esc(trackingRow(item))}</pre>`,
      { parse_mode: "HTML" });
    return;
  }

  if (text === "/help" || text === "/start") {
    await tg.sendMessage(CHAT, [
      "Argus marketing approval bot.",
      "",
      "/queue — everything and its status",
      "/pending — deliver anything not yet sent",
      "/posted <id> <url> — record a manually posted item",
      "",
      "Approve / Reject / Changes are the buttons on each card.",
    ].join("\n"));
  }
}

/** The row TRACKING.md wants, pre-filled with everything the bot already knows. */
function trackingRow(item) {
  const d = (item.postedAt || "").slice(0, 10);
  return `| | ${d} | ${item.deckId} | ${item.platform === "tiktok" ? "TT" : "IG"} | ${item.angle} | ${item.hookId} | ${item.ctaId || ""} | carousel | | | | | | | | | | ${item.trackingUrl || ""} |`;
}

/* ── main loop ────────────────────────────────────────────────────────── */

let offset = 0;
let running = true;

async function main() {
  const me = await tg.getMe();
  console.log(`\n  🤖 @${me.username}`);
  console.log(`     token           ${describeSecret(config.botToken)}`);
  console.log(`     authorised chat ${CHAT}`);
  console.log(`     ${describeMode("tiktok", config.publishers.tiktok)}`);
  console.log(`     ${describeMode("instagram", config.publishers.instagram)}`);
  console.log(`     polling (no public endpoint, nothing inbound)\n`);

  await deliverPending();

  while (running) {
    let updates;
    try {
      updates = await tg.getUpdates(offset, config.pollTimeoutSec);
    } catch (err) {
      // A poll failure is normal (network blips, Telegram 502s). Back off and
      // carry on — the queue is on disk, nothing is lost by waiting.
      const wait = err.retryAfter ? err.retryAfter * 1000 : 5000;
      console.warn(`  ! poll failed: ${tg.redact(err.message)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    for (const u of updates) {
      offset = u.update_id + 1;
      if (!authorised(u)) { refuse(u); continue; }
      try {
        if (u.callback_query) await onCallback(u.callback_query);
        else if (u.message) await onMessage(u.message);
      } catch (err) {
        console.error(`  ✗ handling update ${u.update_id}: ${tg.redact(err.message)}`);
        await tg.sendMessage(CHAT, `⚠️ Error handling that: ${esc(tg.redact(err.message))}`).catch(() => {});
      }
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { console.log("\n  stopping\n"); running = false; process.exit(0); });
}

main().catch((err) => {
  console.error(`\n  ✗ ${tg.redact(err.message)}\n`);
  process.exit(1);
});
