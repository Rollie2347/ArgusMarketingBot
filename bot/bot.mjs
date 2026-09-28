#!/usr/bin/env node
/**
 * Argus marketing approval bot.
 *
 *   node bot/bot.mjs
 *
 * The one long-running process of the marketing pipeline:
 *
 *   1. once a day (DAILY_RUN_AT) or on /generate, runs scripts/daily.mjs —
 *      the model writes the decks, images are generated, slides rendered and
 *      queued
 *   2. delivers each deck to ONE authorised Telegram chat as an album plus a
 *      card: Approve both / TikTok only / Instagram only / Reject / Changes
 *   3. on approval, schedules each platform into its next free posting slot
 *      (POST_TIMES, POSTS_PER_DAY) — or publishes at once if no slots are set
 *   4. at the slot, hands the item to its publisher (Upload-Post, or the
 *      manual hand-off) and reports the result, loudly if it failed
 *
 * Rejections and change requests are written to marketing/FEEDBACK.md, which
 * the next day's deck writer reads — an ❌ with a reason changes tomorrow.
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
 *   3. Polling needs no inbound connectivity whatsoever — no public URL, no
 *      TLS cert, no secret webhook path, and nothing to leave exposed if the
 *      process dies. (It does need to stay RUNNING now: the daily batch and
 *      the posting slots are timers inside this process. An always-on box,
 *      not a scale-to-zero job.)
 *   4. The workload is human-paced — a handful of approvals a day. The only
 *      thing polling costs is up to ~30s of latency on a button press, which
 *      is invisible for this task.
 *   5. Failure isolation. The marketing bot crashing, being restarted, or
 *      being edited mid-batch must never be able to touch a production Live
 *      session. Separate process, separate lifecycle.
 *
 * The honest counter-argument: a webhook scales better and costs nothing while
 * idle. At one operator and a few posts a day, neither matters. If this ever
 * became multi-operator and high-volume, the answer would flip — and it should
 * still be its own service, not folded into the relay.
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { config, validate, describeSecret, OUT_DIR, FEEDBACK_FILE, DAILY_FILE, STATE_DIR, MARKETING_ROOT } from "./config.mjs";
import * as tg from "./telegram.mjs";
import { load, mutate, find, byStatus, transition, summarize } from "./queue.mjs";
import { getPublisher, describeMode } from "./publishers/index.mjs";
import { refreshIfDue } from "./igtoken.mjs";

validate({ requirePublishing: true });
tg.configure(config.botToken);

const CHAT = String(config.allowedChatId);

/* ── publisher choices made from Telegram ────────────────────────────────
 * /instagram <token> switches Instagram to automatic without touching
 * bot/.env; the choice is kept in state/publishers.json so it survives a
 * restart, and it takes precedence over PUBLISH_* in the env (the startup
 * log prints the modes actually in force).
 * ------------------------------------------------------------------------ */
const OVERRIDES_FILE = join(STATE_DIR, "publishers.json");
function loadOverrides() {
  try { return JSON.parse(readFileSync(OVERRIDES_FILE, "utf8")); } catch { return {}; }
}
function setPublisher(platform, mode) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(OVERRIDES_FILE, JSON.stringify({ ...loadOverrides(), [platform]: mode }, null, 2), "utf8");
  config.publishers[platform] = mode;
}
Object.assign(config.publishers, loadOverrides());
const TICK_MS = parseInt(process.env.BOT_TICK_MS || "20000", 10);

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
const clip = (s, n) => { const t = String(s ?? ""); return t.length <= n ? t : `${t.slice(0, n - 1)}…`; };
const say = (text, extra = {}) => tg.sendMessage(CHAT, text, { parse_mode: "HTML", ...extra }).catch((err) => {
  console.error(`  ✗ could not send message: ${tg.redact(err.message)}`);
});

const LABEL = { tiktok: "TikTok", instagram: "Instagram" };
const label = (p) => LABEL[p] || p;

/** "Sat 27 Sep 09:00", in the bot's local time. */
function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/* ── delivery: one card per DECK ──────────────────────────────────────────
 * The queue still holds one item per deck per platform — they are scheduled,
 * published and measured separately — but a deck's copy and slides are the
 * same on both, so it is reviewed once. Three decks a day is three decisions,
 * not six.
 * ------------------------------------------------------------------------ */

function publishModeNote(platform) {
  const mode = config.publishers[platform] || "manual";
  const dry = process.env.DRY_RUN === "1" ? " (DRY RUN)" : "";
  if (mode === "manual") return "manual hand-off";
  if (mode === "telegram") return "sent to you here at its slot, you post it";
  if (mode === "instagram") return `auto-posts via the Instagram API${dry}`;
  if (mode === "tiktokweb") return `auto-posts as a slideshow video (browser bot)${dry}`;
  if (mode === "uploadpost") return `auto-posts via Upload-Post${dry}`;
  return mode;
}

/* ── the ask ─────────────────────────────────────────────────────────────
 * Rollie, 2026-09-27: the bot should only ask "OK to post?" and, on yes, post.
 * So a deck arrives as ONE message: the slideshow exactly as it will go out
 * (the TikTok video itself when it can be built), the caption it will carry,
 * and two buttons. No hook ids, links, schedules or tracking rows — those
 * stay in the queue and the logs.
 * ------------------------------------------------------------------------ */

const PLATFORM_LIST = (items) => items.map((i) => label(i.platform)).join(" + ");
/** Is this platform in POST_PLATFORMS? Everything else is ignored end to end. */
const enabled = (it) => config.postPlatforms.includes(it.platform);

function askText(items) {
  const first = items[0];
  const caption = (items.find((i) => i.platform === "tiktok") || first).caption || "";
  // Video captions cap at 1024 characters, escaped HTML included.
  return `<b>OK to post to ${esc(PLATFORM_LIST(items))}?</b>\n\n${esc(clip(caption, 700))}`;
}

function askButtons(deckId) {
  return tg.keyboard([[tg.button("✅ Post it", `A|${deckId}|*`), tg.button("❌ Don't post", `R|${deckId}`)]]);
}

async function deliverDeck(items) {
  const preview = items.find((i) => i.platform === "tiktok") || items[0];

  // Best: the video TikTok will actually get — reviewing it IS reviewing the
  // post. If it can't be built (no ffmpeg, a missing slide) fall back to the
  // slide images, so a deck is never stuck undelivered.
  if (preview.platform === "tiktok" && config.publishers.tiktok === "tiktokweb") {
    try {
      const { makeSlideshowVideo } = await import("../lib/video.mjs");
      const v = await makeSlideshowVideo(preview);
      const sent = await tg.sendVideo(CHAT, readFileSync(v.path), {
        caption: askText(items), duration: Math.round(v.seconds), width: 1080, height: 1920,
        reply_markup: askButtons(preview.deckId),
      });
      return sent.message_id;
    } catch (err) {
      console.warn(`    ! ${preview.deckId}: video preview failed (${tg.redact(err.message)}) — sending the slides instead`);
    }
  }

  const dir = join(OUT_DIR, preview.deckId, preview.platform);
  const files = preview.slideFiles.map((f) => ({ name: f, bytes: readFileSync(join(dir, f)) }));
  // Telegram albums cap at 10 and can't carry buttons, so the question
  // follows as its own message.
  await tg.sendMediaGroup(CHAT, files.slice(0, 10), "");
  const sent = await tg.sendMessage(CHAT, askText(items), { parse_mode: "HTML", reply_markup: askButtons(preview.deckId) });
  return sent.message_id;
}

let delivering = false;
async function deliverPending() {
  if (delivering) return;
  delivering = true;
  try {
    const pending = byStatus(load(), "pending").filter(enabled);
    if (!pending.length) return;
    const decks = new Map();
    for (const it of pending) decks.set(it.deckId, [...(decks.get(it.deckId) || []), it]);
    console.log(`  → delivering ${decks.size} deck(s)`);

    for (const [deckId, items] of decks) {
      try {
        const messageId = await deliverDeck(items);
        // Persist after EACH deck, not once at the end: a crash halfway
        // through a batch must not re-deliver the ones already sent.
        mutate((q) => {
          for (const { id } of items) {
            const it = find(q, id);
            if (it?.status === "pending") { it.deliveredMessageId = messageId; transition(it, "awaiting", { messageId }); }
          }
        });
        console.log(`    ⏳ ${deckId}`);
      } catch (err) {
        console.error(`    ✗ ${deckId}: ${tg.redact(err.message)}`);
        await say(`⚠️ Could not deliver <code>${esc(deckId)}</code> — it stays pending; /pending retries.\n\n${esc(tg.redact(err.message))}`);
      }
      // Albums are the heaviest thing a bot sends; spacing them keeps a
      // batch under Telegram's per-chat flood limit in the first place.
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    delivering = false;
  }
}

/* ── feedback capture ─────────────────────────────────────────────────────
 * The reason a post was killed is the only signal in this whole loop that
 * says WHY something did not work, as opposed to that it didn't. It goes into
 * a file the next batch's writer reads, not just into the queue JSON where
 * nobody would read it.
 * ------------------------------------------------------------------------ */
function recordFeedback(item, kind, reason, subject = item.id) {
  if (!existsSync(FEEDBACK_FILE)) {
    writeFileSync(FEEDBACK_FILE, `# Approval feedback

Written by the Telegram approval bot. One row per rejection or change request.

**This is the input to the next batch's HOOKS.md — and scripts/write-decks.mjs
reads it on every run.** A hook that gets rejected three times for the same
reason is a hook to delete, not to rewrite again.

| When | Item | Angle | Hook | CTA | Decision | Reason |
|---|---|---|---|---|---|---|
`, "utf8");
  }
  const row = `| ${new Date().toISOString().slice(0, 16).replace("T", " ")} | \`${subject}\` | ${item.angle} | \`${item.hookId}\` | \`${item.ctaId || "—"}\` | ${kind} | ${String(reason).replace(/\|/g, "\\|").replace(/\n/g, " ")} |\n`;
  appendFileSync(FEEDBACK_FILE, row, "utf8");
}

/* ── scheduling ───────────────────────────────────────────────────────────
 * Approval and posting are separate moments: approve three decks over
 * breakfast, and they go out at the slot times, never more than
 * POSTS_PER_DAY per platform per day. All in the process's local time.
 * ------------------------------------------------------------------------ */

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function nextSlot(q, platform, now = new Date()) {
  const { burst } = config.schedule;
  // Everything that has or will occupy a posting slot on this platform.
  const taken = q.items
    .filter((i) => i.platform === platform && ["scheduled", "approved", "published", "publish_failed"].includes(i.status))
    .map((i) => i.scheduledFor || i.postedAt)
    .filter(Boolean)
    .map((t) => new Date(t));

  for (let d = 0; d < 90; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const isBurst = burst && localDate(day) === burst.date;
    const times = isBurst ? burst.times : config.schedule.times;
    const perDay = isBurst ? burst.times.length : config.schedule.perDay;
    const onDay = taken.filter((t) => sameDay(t, day));
    if (onDay.length >= perDay) continue;
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      const slot = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (slot <= now) continue;
      if (onDay.some((x) => x.getTime() === slot.getTime())) continue;
      return slot;
    }
  }
  return null;
}

/* ── publishing ───────────────────────────────────────────────────────── */

/**
 * Runs the publisher for one item. The network call happens OUTSIDE any
 * queue mutation (see queue.mjs mutate()); only the result is written back.
 */
async function publishNow(id) {
  const item = find(load(), id);
  if (!item) return;
  const mode = config.publishers[item.platform] || "manual";

  let result = null, error = null, screenshot = null;
  try {
    result = await getPublisher(mode).publish(item);
    screenshot = result?.screenshot || null;
  } catch (err) {
    error = tg.redact(err.message);
    screenshot = err.screenshot || null;
  }

  const it = mutate((q) => {
    const x = find(q, id);
    if (!x) return null;
    if (error) {
      // LOUD. An approved post that silently never published is the failure
      // mode this whole gate exists to prevent, so it gets its own status, its
      // own Telegram message with the real reason, and a Retry button.
      transition(x, "publish_failed", { publisher: mode, error });
      x.reason = error;
    } else if (result.published) {
      x.postId = result.postId;
      x.postUrl = result.url;
      x.postedAt = new Date().toISOString();
      transition(x, "published", { publisher: mode, postId: result.postId });
    } else {
      if (result.handedOff) x.handedOffAt = new Date().toISOString();
      transition(x, "approved", { publisher: mode, note: result.note });
    }
    return x;
  });
  if (!it) return;
  // The telegram publisher already sent the slides, steps and caption.
  if (!error && result.handedOff) return;

  // The browser bot's view of the page — on failure, what went wrong; on a
  // dry run, what it would have posted.
  if (screenshot && existsSync(screenshot)) {
    await tg.sendPhoto(CHAT, readFileSync(screenshot), `${error ? "🔥" : "🧪"} ${id} — what the posting browser saw`)
      .catch((e) => console.error(`  ✗ screenshot send failed: ${tg.redact(e.message)}`));
  }

  if (error) {
    await say(
      `🔥 <b>PUBLISH FAILED</b> — <code>${esc(id)}</code>\n\n` +
      `Publisher: <code>${esc(mode)}</code>\n\n${esc(error)}\n\n` +
      `It is approved but <b>not posted</b>. Nothing will retry on its own.`,
      { reply_markup: tg.keyboard([[tg.button("🔁 Retry publish", `p|${id}`)]]) });
  } else if (result.published) {
    // One line, as a reply to the deck it came from. (The TRACKING.md row is
    // in the queue; /posted <id> <url> still adds a link.)
    await say(`✅ Posted to ${esc(label(it.platform))}.${result.url ? ` ${esc(result.url)}` : ""}`,
      it.deliveredMessageId ? { reply_to_message_id: it.deliveredMessageId, allow_sending_without_reply: true } : {});
  } else {
    await say(
      `✅ <b>Ready to post</b> — <code>${esc(id)}</code>\n\n` +
      `<b>Post this one by hand now.</b> ${esc(result.note)}\n\n` +
      `Bio link: ${esc(it.trackingUrl || "(not configured)")}\n\n` +
      `When it's live: <code>/posted ${esc(id)} &lt;url&gt;</code>`);
  }
}

/**
 * Approve a set of items: into a posting slot if POST_TIMES is set,
 * otherwise straight to the publisher.
 */
async function approve(ids) {
  const immediate = !config.schedule.times.length;
  const outcome = mutate((q) => ids.map((id) => {
    const it = find(q, id);
    if (!it || !["awaiting", "pending"].includes(it.status)) return { id, skipped: it?.status || "missing" };
    if (immediate) { transition(it, "approved", { by: "telegram" }); return { id }; }
    const slot = nextSlot(q, it.platform);
    if (!slot) { transition(it, "approved", { by: "telegram", note: "no free slot in 90 days — publishing now" }); return { id }; }
    it.scheduledFor = slot.toISOString();
    transition(it, "scheduled", { by: "telegram", scheduledFor: it.scheduledFor });
    return { id, scheduledFor: it.scheduledFor, platform: it.platform };
  }));

  // With posting times set, say once when it will go out; with none (the
  // default now), it posts straight away and the "Posted" line is the answer.
  const scheduled = outcome.filter((o) => o.scheduledFor);
  if (scheduled.length) {
    await say(`👍 Will post to ${scheduled.map((o) => `${esc(label(o.platform))} at ${esc(when(o.scheduledFor))}`).join(", ")}.`);
  }
  for (const o of outcome) {
    if (o.skipped) continue; // a stale button — the callback already said so
    if (!o.scheduledFor) await publishNow(o.id);
  }
}

/* ── the tick: posting slots and the daily batch ──────────────────────── */

let ticking = false;
let lastIgCheck = 0;
let lastIgWarnDay = null;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    // Due posts. Claim each (scheduled → approved) before publishing, so a
    // slow publish can never be picked up twice by the next tick.
    const now = Date.now();
    const due = mutate((q) => q.items
      .filter((i) => i.status === "scheduled" && Date.parse(i.scheduledFor) <= now && enabled(i))
      .map((i) => { transition(i, "approved", { by: "schedule" }); return i.id; }));
    for (const id of due) await publishNow(id);

    // Instagram token upkeep, checked a few times a day (igtoken.mjs decides
    // when a refresh is actually due). Warnings go to Telegram once a day.
    if (Object.values(config.publishers).includes("instagram") && Date.now() - lastIgCheck > 6 * 3600_000) {
      lastIgCheck = Date.now();
      const { refreshed, warning } = await refreshIfDue();
      if (refreshed) console.log("  ✓ Instagram token refreshed");
      if (warning && localDate(new Date()) !== lastIgWarnDay) {
        lastIgWarnDay = localDate(new Date());
        await say(`⚠️ ${esc(warning)}`);
      }
    }

    if (config.dailyRunAt && !dailyRunning) {
      const d = new Date();
      const today = localDate(d);
      const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      if (hhmm >= config.dailyRunAt && readDaily().lastRunDate !== today) {
        runDaily({ reason: `scheduled ${config.dailyRunAt}` }).catch((err) => console.error(`  ✗ daily: ${tg.redact(err.message)}`));
      }
    }
  } catch (err) {
    console.error(`  ✗ tick: ${tg.redact(err.message)}`);
  } finally {
    ticking = false;
  }
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function readDaily() {
  try { return JSON.parse(readFileSync(DAILY_FILE, "utf8")); } catch { return {}; }
}
function writeDaily(v) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(DAILY_FILE, JSON.stringify(v, null, 2), "utf8");
}

let dailyRunning = false;
async function runDaily({ force = false, reason }) {
  if (dailyRunning) { await say("A batch is already being generated."); return; }
  dailyRunning = true;
  // Marked at the START: a batch that fails is reported, not retried every
  // tick — retrying a failing model call every 20s is how a bug spends money.
  writeDaily({ ...readDaily(), lastRunDate: localDate(new Date()), startedAt: new Date().toISOString() });
  try {
    // Silent when it runs on its own schedule — the decks arriving is the
    // message. Only a /generate you typed gets an acknowledgement.
    if (!/scheduled/.test(reason)) await say("🛠 Making new slideshows — they'll arrive here in a few minutes.");
    const { code, out } = await new Promise((resolve) => {
      const p = spawn(process.execPath, [join(MARKETING_ROOT, "scripts", "daily.mjs"), ...(force ? ["--force"] : [])], { cwd: MARKETING_ROOT, env: process.env });
      const chunks = [];
      p.stdout.on("data", (b) => { chunks.push(String(b)); process.stdout.write(b); });
      p.stderr.on("data", (b) => { chunks.push(String(b)); process.stderr.write(b); });
      p.on("exit", (c) => resolve({ code: c, out: chunks.join("") }));
    });

    const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("DAILY_RESULT "));
    let res = null;
    try { res = line ? JSON.parse(line.slice("DAILY_RESULT ".length)) : null; } catch { /* below */ }
    writeDaily({ ...readDaily(), finishedAt: new Date().toISOString(), ok: Boolean(res?.ok) });

    if (!res?.ok) {
      const tail = tg.redact(res?.error || out.trim().split(/\r?\n/).slice(-8).join("\n"));
      await say(`🔥 <b>DAILY BATCH FAILED</b> (exit ${code})\n\n<pre>${esc(clip(tail, 3000))}</pre>\n\nFix it, then /generate to resume — finished steps are not redone.`);
      return;
    }

    // The batch summary goes to the log, not the chat: the "OK to post?"
    // messages that follow are the only thing that needs you.
    console.log(`  🗂 ${res.decks.length} deck(s) ready: ${res.decks.join(", ")}`);
    for (const d of res.dropped || []) console.log(`  ✗ dropped ${d.slug} — failed validation twice: ${d.errors.join("; ")}`);
    for (const f of res.imageFailures || []) console.log(`  ⚠️ ${f.deckId} slide ${f.slide}: no image (${f.error})`);
    await deliverPending();
  } finally {
    dailyRunning = false;
  }
}

/* ── update handling ──────────────────────────────────────────────────── */

// What a force_reply is waiting for: the item ids a reason applies to.
const awaitingReply = new Map();

const deckItems = (q, deckId) => q.items.filter((i) => i.deckId === deckId);

async function onCallback(cb) {
  const parts = String(cb.data || "").split("|");
  const action = parts[0];
  const q = load();

  // ── deck-level buttons (A / R / C) ──
  if (["A", "R", "C"].includes(action)) {
    const deckId = parts[1];
    const open = deckItems(q, deckId).filter((i) => ["awaiting", "pending"].includes(i.status) && enabled(i));
    if (!open.length) {
      const states = deckItems(q, deckId).map((i) => `${label(i.platform)} ${i.status}`).join(", ");
      await tg.answerCallbackQuery(cb.id, states ? `Already decided: ${states}.` : "That deck is no longer in the queue.", true);
      return;
    }
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);

    if (action === "A") {
      const platform = parts[2];
      const chosen = platform === "*" ? open : open.filter((i) => i.platform === platform);
      const others = open.filter((i) => !chosen.includes(i));
      await tg.answerCallbackQuery(cb.id, "Posting…");
      if (others.length) {
        // "TikTok only" is a decision about the other platform too — it must
        // not sit awaiting forever. Not written to FEEDBACK.md: it says
        // nothing about the copy.
        mutate((qq) => others.forEach((o) => {
          const it = find(qq, o.id);
          it.reason = `not approved for ${label(it.platform)} (approved ${label(platform)} only)`;
          transition(it, "rejected", { by: "telegram", reason: it.reason });
        }));
      }
      await approve(chosen.map((i) => i.id));
      return;
    }

    if (action === "R") {
      // "Don't post" is final on the tap — no reason demanded. One line back,
      // and an OPTIONAL reply still reaches FEEDBACK.md, which the deck
      // writer reads, so a "why" still makes tomorrow's decks better.
      await tg.answerCallbackQuery(cb.id, "Not posting it.");
      const first = mutate((qq) => {
        let f = null;
        for (const o of open) {
          const it = find(qq, o.id);
          it.reason = "declined in Telegram (no reason given)";
          transition(it, "rejected", { by: "telegram", reason: it.reason });
          f ??= it;
        }
        return f;
      });
      if (first) recordFeedback(first, "reject", "(no reason given)", deckId);
      awaitingReply.set(CHAT, { ids: open.map((i) => i.id), subject: deckId, kind: "reason", until: Date.now() + 30 * 60_000 });
      await say("👌 Not posted. <i>Optional: reply with why, and future slideshows will learn from it.</i>",
        cb.message ? { reply_to_message_id: cb.message.message_id, allow_sending_without_reply: true } : {});
      return;
    }

    const kind = "changes_requested";
    await tg.answerCallbackQuery(cb.id, "Send the changes.");
    awaitingReply.set(CHAT, { ids: open.map((i) => i.id), subject: deckId, kind });
    await say(
      `${action === "R" ? "❌" : "✏️"} <code>${esc(deckId)}</code> — reply to this message with ${action === "R" ? "why it was rejected" : "what to change"}.\n\n` +
      `<i>It goes into FEEDBACK.md and tomorrow's writer reads it, so be specific — "hook is weak" helps nobody.</i>`,
      { reply_markup: { force_reply: true, selective: true } });
    return;
  }

  // ── per-item buttons: cards delivered before deck-level approval existed,
  // the Retry button on a failed publish, and "I posted it" on a hand-off ──
  const id = parts[1];
  const item = find(q, id);
  if (!item) { await tg.answerCallbackQuery(cb.id, "That item is no longer in the queue.", true); return; }

  if (action === "P") {
    if (item.status !== "approved") { await tg.answerCallbackQuery(cb.id, `Already ${item.status}.`, true); return; }
    await tg.answerCallbackQuery(cb.id, "Recorded 🚀");
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);
    const it = mutate((qq) => {
      const x = find(qq, id);
      x.postedAt = new Date().toISOString();
      transition(x, "published", { by: "telegram I-posted-it" });
      return x;
    });
    await say(`🚀 <code>${esc(id)}</code> recorded as posted.\n\nAdd the post link for tracking: <code>/posted ${esc(id)} &lt;url&gt;</code>\n\nTRACKING.md row:\n<pre>${esc(trackingRow(it))}</pre>`);
    return;
  }

  if (action === "p") {
    // Retry is only for a failed publish. Anything else — especially
    // published — must never be re-sent to a publisher by a stale button.
    if (item.status !== "publish_failed") { await tg.answerCallbackQuery(cb.id, `Already ${item.status}.`, true); return; }
    await tg.answerCallbackQuery(cb.id, "Retrying…");
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);
    mutate((qq) => transition(find(qq, id), "approved", { by: "telegram retry" }));
    await publishNow(id);
    return;
  }

  // Guard against a second press on a card that was already decided — the
  // buttons are removed on decision, but a cached client can still fire.
  if (!["awaiting", "pending"].includes(item.status)) {
    await tg.answerCallbackQuery(cb.id, `Already ${item.status}.`, true);
    return;
  }

  if (action === "a") {
    await tg.answerCallbackQuery(cb.id, "Approving…");
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);
    await approve([id]);
    return;
  }

  if (action === "r" || action === "c") {
    const kind = action === "r" ? "rejected" : "changes_requested";
    await tg.answerCallbackQuery(cb.id, action === "r" ? "Rejecting — send the reason." : "Send the changes.");
    if (cb.message) await tg.editMessageReplyMarkup(CHAT, cb.message.message_id, null);
    awaitingReply.set(CHAT, { ids: [id], subject: id, kind });
    await say(
      `${action === "r" ? "❌" : "✏️"} <code>${esc(id)}</code> — reply to this message with ${action === "r" ? "why it was rejected" : "what to change"}.\n\n` +
      `<i>It goes into FEEDBACK.md and tomorrow's writer reads it, so be specific — "hook is weak" helps nobody.</i>`,
      { reply_markup: { force_reply: true, selective: true } });
    return;
  }

  await tg.answerCallbackQuery(cb.id, "Unknown action.");
}

async function onMessage(msg) {
  const text = String(msg.text || "").trim();

  // A pending reason/changes reply takes priority over command parsing.
  let pendingReply = awaitingReply.get(CHAT);
  if (pendingReply?.until && Date.now() > pendingReply.until) { awaitingReply.delete(CHAT); pendingReply = null; }

  // The optional "why" after a "Don't post" — the deck is already rejected,
  // this only adds the reason for the deck writer.
  if (pendingReply?.kind === "reason" && text && !text.startsWith("/")) {
    awaitingReply.delete(CHAT);
    const reason = text.slice(0, 500);
    const first = mutate((q) => {
      let f = null;
      for (const id of pendingReply.ids) {
        const it = find(q, id);
        if (!it) continue;
        it.reason = reason;
        (it.history ||= []).push({ status: it.status, at: new Date().toISOString(), reason });
        f ??= it;
      }
      return f;
    });
    if (first) recordFeedback(first, "reject", reason, pendingReply.subject);
    await say("Thanks — noted for the next ones.");
    return;
  }

  if (pendingReply && text && !text.startsWith("/")) {
    awaitingReply.delete(CHAT);
    const reason = text.slice(0, 500);
    const first = mutate((q) => {
      let firstItem = null;
      for (const id of pendingReply.ids) {
        const it = find(q, id);
        if (!it || !["awaiting", "pending"].includes(it.status)) continue;
        it.reason = reason;
        transition(it, pendingReply.kind, { reason });
        firstItem ??= it;
      }
      return firstItem;
    });
    if (!first) { await say("That deck was already decided — nothing changed."); return; }
    recordFeedback(first, pendingReply.kind === "rejected" ? "reject" : "changes", reason, pendingReply.subject);
    await say(`Logged against <code>${esc(pendingReply.subject)}</code> and appended to FEEDBACK.md.`);
    return;
  }

  if (text === "/queue" || text === "/status") {
    await say(`<pre>${esc(clip(summarize(load()), 3800))}</pre>`);
    return;
  }

  if (text === "/pending") {
    await deliverPending();
    return;
  }

  if (text === "/generate" || text === "/generate more") {
    // "/generate" runs (or finishes) today's batch; "/generate more" writes an
    // extra batch on top of it.
    runDaily({ force: text.endsWith("more"), reason: text.endsWith("more") ? "an extra batch, on request" : "on request" })
      .catch((err) => say(`🔥 ${esc(tg.redact(err.message))}`));
    return;
  }

  if (text === "/schedule") {
    const s = byStatus(load(), "scheduled").sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
    await say(s.length
      ? `🗓 <b>Scheduled</b>\n${s.map((i) => `${esc(when(i.scheduledFor))} · ${esc(label(i.platform))} · <code>${esc(i.deckId)}</code>`).join("\n")}`
      : "Nothing scheduled.");
    return;
  }

  if (text.startsWith("/posted")) {
    const [, id, url] = text.split(/\s+/);
    const it = mutate((q) => {
      const x = find(q, id);
      if (!x) return null;
      x.postUrl = url || x.postUrl || null;
      // Adding a link to something already recorded keeps its original time.
      if (x.status !== "published") {
        x.postedAt = new Date().toISOString();
        transition(x, "published", { by: "manual /posted", url: url || null });
      } else {
        (x.history ||= []).push({ status: "published", at: new Date().toISOString(), note: "post URL added", url: url || null });
      }
      return x;
    });
    if (!it) { await say(`No queue item ${id ? `<code>${esc(id)}</code>` : "given"}.`); return; }
    await say(`🚀 Recorded <code>${esc(it.id)}</code> as posted.\n\nAdd the TRACKING.md row:\n<pre>${esc(trackingRow(it))}</pre>`);
    return;
  }

  if (text === "/tiktoklogin") {
    // Runs in the background so the bot keeps answering while you scan.
    await say("Opening TikTok's QR login on the posting browser…");
    import("../lib/browser.mjs")
      .then(({ tiktokQrLogin }) => tiktokQrLogin(async (png, n) => {
        await tg.sendPhoto(CHAT, png, n === 1
          ? "Scan this with the TikTok app, logged in as myargusai: tap Search, then the scan icon at the right of the search bar, and confirm on the phone."
          : "That code expired — here's a fresh one.");
      }))
      .then((r) => say(r === "already" ? "✓ TikTok is already logged in on the posting browser — nothing to do."
        : r ? "✓ <b>TikTok logged in.</b> Automatic TikTok posting works again. If a post failed while logged out, press its 🔁 Retry."
        : "✗ No scan within 5 minutes. Send /tiktoklogin to try again."))
      .catch((err) => say(`🔥 TikTok login failed: ${esc(tg.redact(err.message))}`));
    return;
  }

  if (text.startsWith("/instagram")) {
    const arg = text.split(/\s+/)[1] || "";
    if (!arg) {
      await say([
        `Instagram is <b>${esc(publishModeNote("instagram"))}</b>.`,
        "",
        "To make it automatic, send <code>/instagram YOUR_TOKEN</code> — the token from your Meta app (Instagram → API setup with Instagram login → Generate token). I check it with Instagram, save it, delete your message, and switch Instagram to automatic.",
        "<code>/instagram off</code> goes back to sending you the post by hand.",
      ].join("\n"));
      return;
    }
    if (arg === "off") {
      setPublisher("instagram", "telegram");
      await say("Instagram is back to hand-offs: at each slot I'll send you the slides to post.");
      return;
    }
    // The message carries a live token — remove it from the chat first.
    await tg.deleteMessage(CHAT, msg.message_id);
    if (!process.env.MARKETING_GCS_BUCKET || !process.env.MARKETING_GCS_KEY_B64) {
      await say("🔥 Can't switch Instagram on: the slide bucket isn't configured (MARKETING_GCS_BUCKET / MARKETING_GCS_KEY_B64 in bot/.env). Instagram fetches images by URL, so it needs them.");
      return;
    }
    try {
      const { verifyToken, setToken } = await import("./igtoken.mjs");
      const acct = await verifyToken(arg);
      setToken({ token: arg, userId: acct.userId, username: acct.username });
      setPublisher("instagram", "instagram");
      await say(`✓ <b>Instagram connected</b> as @${esc(acct.username || acct.userId)}${acct.accountType ? ` (${esc(acct.accountType.toLowerCase())} account)` : ""}. I deleted your message.\n\nApproved decks now post to Instagram automatically at their slots. The token renews itself every week.`);
    } catch (err) {
      await say(`✗ ${esc(tg.redact(err.message))}\n\nI deleted your message; nothing was changed. Instagram stays on hand-offs.`);
    }
    return;
  }

  if (text === "/help" || text === "/start") {
    await tg.sendMessage(CHAT, [
      "Argus marketing approval bot.",
      "",
      "/generate — write, render and deliver today's decks now",
      "/generate more — an extra batch on top of today's",
      "/schedule — what's going out, and when",
      "/queue — everything and its status",
      "/pending — deliver anything not yet sent",
      "/posted <id> <url> — record a manually posted item",
      "/tiktoklogin — log TikTok in again (QR code to scan)",
      "/instagram <token> — make Instagram automatic",
      "",
      "Approve / Reject / Changes are the buttons on each deck.",
    ].join("\n"));
  }
}

/** The row TRACKING.md wants, pre-filled with everything the bot already knows. */
function trackingRow(item) {
  const d = (item.postedAt || "").slice(0, 10);
  return `| | ${d} | ${item.deckId} | ${item.platform === "tiktok" ? "TT" : "IG"} | ${item.angle} | ${item.hookId} | ${item.ctaId || ""} | carousel | | | | | | | | | | ${item.trackingUrl || ""} |`;
}

/**
 * An item claimed for publishing (status approved, no publisher result yet)
 * when the process died. It may or may not have reached the platform, so it
 * is NOT silently retried — that could double-post — and NOT left as
 * "approved", which would look finished. It becomes a loud publish_failed
 * with a Retry button, for a human to check the account first.
 */
async function recoverInterrupted() {
  const stuck = mutate((q) => q.items
    .filter((i) => i.status === "approved" && !("publisher" in (i.history?.at(-1) || {})))
    .map((i) => {
      i.reason = "the bot stopped while this was being published — check the account before retrying, it may already be live";
      transition(i, "publish_failed", { error: i.reason });
      return i.id;
    }));
  for (const id of stuck) {
    await say(`🔥 <b>INTERRUPTED PUBLISH</b> — <code>${esc(id)}</code>\n\nThe bot stopped mid-publish. <b>Check the account first</b> — it may already be live. Retry only if it isn't.`,
      { reply_markup: tg.keyboard([[tg.button("🔁 Retry publish", `p|${id}`)]]) });
  }
}

/* ── main loop ────────────────────────────────────────────────────────── */

let offset = 0;
let running = true;

async function main() {
  const me = await tg.getMe();
  console.log(`\n  🤖 @${me.username}`);
  console.log(`     token           ${describeSecret(config.botToken)}`);
  console.log(`     authorised chat ${CHAT}`);
  for (const p of ["tiktok", "instagram"]) {
    console.log(`     ${config.postPlatforms.includes(p) ? describeMode(p, config.publishers[p]) : `${p}: PAUSED (not in POST_PLATFORMS — not asked about, not posted)`}`);
  }
  console.log(`     posting slots   ${config.schedule.times.length ? `${config.schedule.times.join(", ")} · ${config.schedule.perDay}/day per platform` : "none — publish on approval"}`);
  if (config.schedule.burst) console.log(`     burst day       ${config.schedule.burst.date}: ${config.schedule.burst.times.length} slots per platform (${config.schedule.burst.times[0]}–${config.schedule.burst.times.at(-1)})`);
  console.log(`     daily batch     ${config.dailyRunAt ? `at ${config.dailyRunAt}` : "off (use /generate)"}`);
  console.log(`     local time      ${new Date().toString()}`);
  console.log(`     polling (no public endpoint, nothing inbound)\n`);

  // Upload-Post connection check: a disconnected account is one warning now,
  // not a PUBLISH FAILED at every slot later.
  const viaUploadPost = Object.entries(config.publishers).filter(([, m]) => m === "uploadpost").map(([p]) => p);
  if (viaUploadPost.length) {
    const { checkConnection } = await import("./publishers/uploadpost.mjs");
    const c = await checkConnection(viaUploadPost);
    for (const [p, name] of Object.entries(c.connected)) console.log(`     upload-post     ${p} connected as ${name}`);
    if (!c.ok) {
      const why = c.error || `${c.missing.join(" and ")} not connected to Upload-Post profile "${config.uploadpost.user}"`;
      console.warn(`  ⚠️ upload-post: ${why}`);
      await say(`⚠️ <b>Upload-Post isn't ready</b>: ${esc(why)}.\n\nPosts will fail at their slots until it's fixed — check with <code>node scripts/check-uploadpost.mjs</code>.`);
    }
  }

  await recoverInterrupted();
  await deliverPending();
  await tick();
  setInterval(() => { tick(); }, TICK_MS).unref?.();

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

// Log WHICH signal stopped us. The bot has been killed from outside twice with
// no trace; on Windows a closed console arrives as SIGHUP, Ctrl+Break as
// SIGBREAK, Ctrl+C as SIGINT — naming it narrows the cause next time.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => { console.log(`\n  [${new Date().toISOString()}] stopping on ${sig}\n`); running = false; process.exit(0); });
}
process.on("exit", (code) => { try { appendFileSync(join(STATE_DIR, "launches.log"), `[${new Date().toISOString()}]   node pid=${process.pid} exit code=${code}\n`); } catch { /* best effort */ } });

// Heartbeat: the last minute the bot was alive, for when it dies silently.
setInterval(() => { try { writeFileSync(join(STATE_DIR, "heartbeat"), new Date().toISOString()); } catch { /* best effort */ } }, 60_000).unref?.();

main().catch((err) => {
  console.error(`\n  ✗ ${tg.redact(err.message)}\n`);
  process.exit(1);
});
