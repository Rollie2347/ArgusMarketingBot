/**
 * End-to-end test for the approval bot, against a fake Bot API.
 *
 * The bot is driven by a real HTTP server standing in for api.telegram.org, so
 * this exercises the actual request bodies, the actual multipart album upload,
 * the actual callback handling and the actual queue transitions — not mocks of
 * them. Nothing here talks to Telegram, Upload-Post, Gemini, or the network.
 *
 * What it proves, in order of how much it would hurt to get wrong:
 *   1. an unauthorised chat cannot approve anything
 *   2. approve runs the publisher (now, or at its slot) and writes the hand-off
 *   3. a publish failure is LOUD and leaves the item retriable, never silent
 *   4. a publish interrupted by a crash comes back loud, not silently re-sent
 *   5. posting slots respect POSTS_PER_DAY per platform
 *   6. a rejection reason reaches FEEDBACK.md
 *   7. Telegram flood control is waited out, not treated as a lost delivery
 *   8. the bot token never appears in an error message
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(HERE, "..");
const MARKETING = join(BOT_DIR, "..");

const TOKEN = "123456:FAKE-TOKEN-DO-NOT-USE";
const CHAT = "999000111";
const STRANGER = "555000555";
const IG_GOOD = "IGAA-GOOD-TEST-TOKEN-0123456789";
const IG_BAD = "IGAA-BAD-TEST-TOKEN-9876543210";

let api, apiPort, sandbox, child;
let sent = [];          // every request the bot made to the fake API
let updateQueue = [];   // what the next getUpdates returns
let nextUpdateId = 1;
let floodOnce = true;   // first album gets a 429, like the real first run

function push(update) {
  updateQueue.push({ update_id: nextUpdateId++, ...update });
}

/** A callback_query as Telegram would deliver it. */
const callback = (data, fromId = CHAT) => ({
  callback_query: {
    id: `cb${Math.random().toString(36).slice(2)}`,
    data,
    from: { id: Number(fromId) },
    message: { message_id: 4242, chat: { id: Number(CHAT) } },
  },
});

const message = (text, fromId = CHAT) => ({
  message: { message_id: Math.floor(Math.random() * 1e6), text, chat: { id: Number(CHAT) }, from: { id: Number(fromId) } },
});

function startFakeApi() {
  return new Promise((resolve) => {
    api = createServer((req, res) => {
      const method = req.url.split("/").pop().split("?")[0];
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        let body = null;
        try { body = JSON.parse(raw.toString("utf8")); } catch { body = { _multipart: true, size: raw.length }; }
        sent.push({ method, body, url: req.url });

        const reply = (result) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        };

        // Stand-in for graph.instagram.com's /me, for the /instagram command.
        if (req.url.startsWith("/v25.0/me")) {
          const ok = req.headers.authorization === `Bearer ${IG_GOOD}`;
          res.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
          return res.end(JSON.stringify(ok
            ? { user_id: "17841400000000001", username: "myargusai", account_type: "MEDIA_CREATOR" }
            : { error: { message: "Invalid OAuth access token - Cannot parse access token", code: 190 } }));
        }
        if (method === "getMe") return reply({ id: 1, username: "argus_approval_test_bot" });
        if (method === "getUpdates") {
          const out = updateQueue;
          updateQueue = [];
          // Answer immediately when there is something; otherwise hold briefly
          // so the bot's loop doesn't spin.
          if (out.length) return reply(out);
          return setTimeout(() => reply([]), 300);
        }
        if (method === "sendMediaGroup") {
          if (floodOnce) {
            floodOnce = false;
            res.writeHead(429, { "content-type": "application/json" });
            return res.end(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } }));
          }
          return reply([{ message_id: 1 }]);
        }
        if (method === "sendMessage") return reply({ message_id: 4242 });
        if (method === "answerCallbackQuery") return reply(true);
        if (method === "editMessageReplyMarkup") return reply({ message_id: 4242 });
        return reply(true);
      });
    });
    api.listen(0, "127.0.0.1", () => { apiPort = api.address().port; resolve(); });
  });
}

// A 1x1 PNG is enough — the album upload path only cares about bytes.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4946484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
const DECKS = ["t1-probe", "t2-deck", "t3-cap", "t4-rej"];

/**
 * A sandbox copy of the marketing tree with tiny rendered decks, so the test
 * does not depend on the real batch being rendered and cannot write to it.
 */
function buildSandbox() {
  sandbox = mkdtempSync(join(tmpdir(), "argus-bot-test-"));
  cpSync(BOT_DIR, join(sandbox, "bot"), { recursive: true, filter: (src) => !src.includes(`${sep}state`) && !src.endsWith(".env") });
  cpSync(join(MARKETING, "lib"), join(sandbox, "lib"), { recursive: true });
  // lib/video.mjs (TikTok browser publisher) imports the renderer's helpers.
  cpSync(join(MARKETING, "templates"), join(sandbox, "templates"), { recursive: true });
  writeFileSync(join(sandbox, "config.json"), readFileSync(join(MARKETING, "config.json")));
  mkdirSync(join(sandbox, "decks"), { recursive: true });

  for (const deckId of DECKS) {
    for (const platform of ["tiktok", "instagram"]) {
      const dir = join(sandbox, "out", deckId, platform);
      mkdirSync(dir, { recursive: true });
      for (const n of ["01", "02"]) {
        writeFileSync(join(dir, `${n}.png`), PNG);
        writeFileSync(join(dir, `${n}.jpg`), PNG);
      }
    }
    writeFileSync(join(sandbox, "out", deckId, "manifest.json"), JSON.stringify({
      id: deckId, title: `Probe ${deckId}`, angle: "problem-solution", hookId: "PS-01", ctaId: "CTA-01",
      capabilities: ["read_text"], ct: "ps-2609", slides: 2, platforms: ["tiktok", "instagram"],
      aiImages: deckId === "t2-deck",
      links: {
        tiktok: { ct: "ps-2609-tt", bio: `https://example.test/g/${deckId}-tt`, store: "https://apps.apple.com/x" },
        instagram: { ct: "ps-2609-ig", bio: `https://example.test/g/${deckId}-ig`, store: "https://apps.apple.com/x" },
      },
    }), "utf8");
    writeFileSync(join(sandbox, "decks", `${deckId}.json`), JSON.stringify({
      caption: { tiktok: "tt caption & copy", instagram: "ig caption" },
      hashtags: { tiktok: ["a"], instagram: ["b"] },
    }), "utf8");
  }
}

before(async () => {
  await startFakeApi();
  buildSandbox();

  // Queue the sandbox decks.
  const enq = spawn(process.execPath, [join(sandbox, "bot", "enqueue.mjs")], {
    cwd: sandbox,
    env: { ...process.env, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    stdio: "pipe",
  });
  await new Promise((r) => enq.on("exit", r));
});

after(async () => {
  if (child) child.kill();
  if (api) api.close();
  // Windows keeps a lock on the child's cwd for a moment after it exits, so
  // this is best-effort: a leftover temp dir must not fail a suite that
  // already passed.
  for (let i = 0; i < 10 && sandbox; i++) {
    try { rmSync(sandbox, { recursive: true, force: true }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
});

let out = [];
function startBot(extraEnv = {}) {
  if (child) child.kill();
  child = spawn(process.execPath, [join(sandbox, "bot", "bot.mjs")], {
    cwd: sandbox,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT,
      TELEGRAM_API_BASE: `http://127.0.0.1:${apiPort}`,
      TELEGRAM_POLL_TIMEOUT_SEC: "1",
      BOT_TICK_MS: "300",
      // None of these may leak in from the developer's shell. "manual" keeps
      // the original tests' hand-off-file assertions; the telegram publisher
      // (the real default) has its own test below.
      POST_TIMES: "", POSTS_PER_DAY: "", DAILY_RUN_AT: "", PUBLISH_TIKTOK: "manual", PUBLISH_INSTAGRAM: "manual", DRY_RUN: "",
      ...extraEnv,
    },
    stdio: "pipe",
  });
  out = [];
  child.stdout.on("data", (b) => out.push(String(b)));
  child.stderr.on("data", (b) => out.push(String(b)));
  return out;
}

async function stopBot() {
  if (!child) return;
  const c = child;
  child = null;
  c.kill();
  await new Promise((r) => (c.exitCode !== null ? r() : c.on("exit", r)));
}

const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
const QUEUE_FILE = () => join(sandbox, "bot", "state", "queue.json");
const queue = () => JSON.parse(readFileSync(QUEUE_FILE(), "utf8"));
const item = (id) => queue().items.find((i) => i.id === id);
function editItem(id, fn) {
  const q = queue();
  fn(q.items.find((i) => i.id === id));
  writeFileSync(QUEUE_FILE(), JSON.stringify(q, null, 2));
}
const messages = () => sent.filter((s) => s.method === "sendMessage").map((s) => s.body.text || "");

test("enqueue built one item per deck per platform, with JPEG twins", () => {
  assert.equal(queue().items.length, DECKS.length * 2);
  assert.equal(item("t1-probe:tiktok").ct, "ps-2609-tt");
  assert.equal(item("t1-probe:instagram").ct, "ps-2609-ig");
  assert.deepEqual(item("t1-probe:tiktok").jpgFiles, ["01.jpg", "02.jpg"]);
  assert.equal(item("t2-deck:tiktok").aiImages, true);
});

test("bot delivers ONE album and ONE card per deck, and waits out a 429", async () => {
  startBot();
  await settle(DECKS.length * 1700 + 2500);

  const albums = sent.filter((s) => s.method === "sendMediaGroup");
  assert.equal(albums.length, DECKS.length + 1, "one album per deck, plus the one retried after the 429");
  assert.ok(albums[0].body._multipart, "album must be multipart, not JSON");

  const cards = sent.filter((s) => s.method === "sendMessage" && s.body.reply_markup?.inline_keyboard);
  assert.equal(cards.length, DECKS.length, "buttons arrive as a separate message — sendMediaGroup can't carry them");
  const labels = cards[0].body.reply_markup.inline_keyboard.flat().map((b) => b.text).join(" ");
  assert.match(labels, /Approve both/);
  assert.match(labels, /TikTok only/);
  assert.match(labels, /Instagram only/);
  assert.match(labels, /Reject/);
  assert.match(labels, /Changes/);
  assert.match(cards[0].body.text, /TikTok[\s\S]*Instagram/, "the card shows both platforms' captions");

  for (const d of DECKS) {
    assert.equal(item(`${d}:tiktok`).status, "awaiting");
    assert.equal(item(`${d}:instagram`).status, "awaiting");
  }
  assert.ok(out.join("").includes("argus_approval_test_bot"));
  assert.ok(out.join("").includes("rate limited"), "the 429 should be logged and waited out");
});

test("an unauthorised user cannot approve anything", async () => {
  push(callback("A|t1-probe|*", STRANGER));
  push(callback("a|t1-probe:tiktok", STRANGER));
  await settle();

  assert.equal(item("t1-probe:tiktok").status, "awaiting", "a stranger's approval must not change state");
  assert.equal(item("t1-probe:instagram").status, "awaiting");
  const alerts = sent.filter((s) => s.method === "answerCallbackQuery" && s.body.show_alert);
  assert.ok(alerts.some((a) => /not authorised/i.test(a.body.text)), "stranger should be told no");
});

test("approve (per-item button, no slots) runs the publisher and writes a hand-off file", async () => {
  push(callback("a|t1-probe:tiktok"));
  await settle(1500);

  const it = item("t1-probe:tiktok");
  assert.equal(it.status, "approved", "manual publisher approves without publishing");
  assert.equal(it.history.at(-1).publisher, "manual");

  const handoff = join(sandbox, "out", "t1-probe", "_approved", "tiktok.md");
  assert.ok(existsSync(handoff), "manual publisher must leave a ready-to-post file");
  const text = readFileSync(handoff, "utf8");
  assert.match(text, /01\.png/);
  assert.match(text, /https:\/\/example\.test\/g\/t1-probe-tt/, "the tracking link must be in the hand-off");
});

test("a rejection reason is captured and lands in FEEDBACK.md", async () => {
  push(callback("r|t1-probe:instagram"));
  await settle();
  assert.equal(item("t1-probe:instagram").status, "awaiting", "still awaiting until the reason arrives");

  push(message("Hook is a rerun of PS-01, and slide 4 buries the payoff"));
  await settle();

  const it = item("t1-probe:instagram");
  assert.equal(it.status, "rejected");
  assert.match(it.reason, /buries the payoff/);

  const feedback = readFileSync(join(sandbox, "FEEDBACK.md"), "utf8");
  assert.match(feedback, /buries the payoff/);
  assert.match(feedback, /PS-01/, "the hook id must be in the row — that's what makes it actionable");
});

test("a decided item cannot be re-decided by a stale button press", async () => {
  push(callback("a|t1-probe:instagram"));
  push(callback("A|t1-probe|*"));
  await settle();
  assert.equal(item("t1-probe:instagram").status, "rejected", "a second press must not override the decision");
});

test("/queue reports status without changing anything", async () => {
  sent = [];
  push(message("/queue"));
  await settle();
  const reply = messages().find((t) => /t1-probe/.test(t));
  assert.ok(reply, "expected a queue summary");
  assert.match(reply, /approved|rejected/);
});

test("/posted records a manual post and hands back a TRACKING.md row", async () => {
  sent = [];
  push(message("/posted t1-probe:tiktok https://tiktok.com/@x/photo/123"));
  await settle();

  const it = item("t1-probe:tiktok");
  assert.equal(it.status, "published");
  assert.equal(it.postUrl, "https://tiktok.com/@x/photo/123");
  assert.ok(it.postedAt);

  const reply = messages().find((t) => /TT/.test(t));
  assert.ok(reply, "expected a prefilled tracking row");
  assert.match(reply, /PS-01/);
});

test("a publish failure is loud, retriable, and never silent", async () => {
  await stopBot();
  // TikTok's own adapter always throws — it is the documented "not available"
  // path, which makes it the honest way to exercise failure handling.
  editItem("t1-probe:tiktok", (it) => { it.status = "awaiting"; });
  sent = [];
  startBot({ PUBLISH_TIKTOK: "tiktok" });
  await settle(1500);

  push(callback("a|t1-probe:tiktok"));
  await settle(1500);

  assert.equal(item("t1-probe:tiktok").status, "publish_failed");
  const alarm = sent.find((s) => s.method === "sendMessage" && /PUBLISH FAILED/.test(s.body.text || ""));
  assert.ok(alarm, "a publish failure must be announced in Telegram");
  assert.match(alarm.body.text, /audit/i, "the message must carry the real reason");
  assert.ok(alarm.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("p|"),
    "a failed publish must offer a retry");
});

test("Retry never re-sends something that isn't a failed publish", async () => {
  push(callback("p|t1-probe:instagram")); // rejected, not failed
  await settle();
  assert.equal(item("t1-probe:instagram").status, "rejected");
});

test("'TikTok only' schedules TikTok into a slot and closes Instagram without feedback", async () => {
  await stopBot();
  sent = [];
  startBot({ POST_TIMES: "09:00,13:00", POSTS_PER_DAY: "1" });
  await settle(1500);

  const before = readFileSync(join(sandbox, "FEEDBACK.md"), "utf8");
  push(callback("A|t2-deck|tiktok"));
  await settle(1500);

  const tt = item("t2-deck:tiktok");
  assert.equal(tt.status, "scheduled");
  assert.ok(Date.parse(tt.scheduledFor) > Date.now(), "a slot is always in the future");
  assert.match(new Date(tt.scheduledFor).toTimeString(), /^(09|13):00/, "slots come from POST_TIMES");

  const ig = item("t2-deck:instagram");
  assert.equal(ig.status, "rejected");
  assert.match(ig.reason, /TikTok only/);
  assert.equal(readFileSync(join(sandbox, "FEEDBACK.md"), "utf8"), before, "a platform choice is not copy feedback");
  assert.ok(messages().some((t) => /Approved[\s\S]*TikTok/.test(t)), "approval reports when it will post");
});

test("POSTS_PER_DAY holds: a second TikTok never lands on the same day", async () => {
  push(callback("A|t3-cap|*"));
  await settle(1500);
  const first = new Date(item("t2-deck:tiktok").scheduledFor);
  const second = new Date(item("t3-cap:tiktok").scheduledFor);
  assert.equal(item("t3-cap:tiktok").status, "scheduled");
  assert.notEqual(second.toDateString(), first.toDateString(), "1 per day per platform");
  assert.equal(item("t3-cap:instagram").status, "scheduled", "Instagram has its own daily allowance");
});

test("a burst day takes one post per burst time, then the normal cap resumes", async () => {
  await stopBot();
  const d = new Date(Date.now() + 5 * 86400_000);
  const burstDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Park everything already scheduled far away, so only the burst logic decides.
  for (const id of ["t2-deck:tiktok", "t3-cap:tiktok", "t3-cap:instagram"]) editItem(id, (it) => { it.scheduledFor = new Date(Date.now() + 200 * 86400_000).toISOString(); });
  // Fill every normal day up to the burst day, so the next free slot IS the burst.
  const q = queue();
  for (let k = 0; k < 5; k++) {
    const day = new Date(Date.now() + k * 86400_000);
    q.items.push({ id: `filler${k}:tiktok`, deckId: `filler${k}`, platform: "tiktok", status: "scheduled", scheduledFor: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59).toISOString(), history: [] });
  }
  q.items.push({ ...q.items.find((i) => i.id === "t4-rej:tiktok"), id: "t4-burst:tiktok", deckId: "t4-burst", status: "awaiting", history: [] });
  writeFileSync(QUEUE_FILE(), JSON.stringify(q, null, 2));

  startBot({ POST_TIMES: "09:00,13:00,19:00", POSTS_PER_DAY: "1", BURST_DATE: burstDate, BURST_TIMES: "08:00,20:00" });
  await settle(1500);
  push(callback("a|t4-burst:tiktok"));
  await settle(1500);
  const s = new Date(item("t4-burst:tiktok").scheduledFor);
  assert.equal(s.getDate(), d.getDate(), "lands on the burst day even though the day before was full");
  assert.equal(s.getHours(), 8, "burst days use BURST_TIMES");
  assert.ok(out.join("").includes("burst day"), "startup says the burst is armed");

  // Remove the fillers so later tests see the queue as before.
  const q2 = queue(); q2.items = q2.items.filter((i) => !/^(filler|t4-burst)/.test(i.id)); writeFileSync(QUEUE_FILE(), JSON.stringify(q2, null, 2));
});

test("a due slot publishes on its own", async () => {
  sent = [];
  editItem("t2-deck:tiktok", (it) => { it.scheduledFor = new Date(Date.now() - 60_000).toISOString(); });
  await settle(2000);

  const it = item("t2-deck:tiktok");
  assert.equal(it.status, "approved", "manual publisher ran at the slot");
  assert.equal(it.history.at(-1).publisher, "manual");
  assert.ok(existsSync(join(sandbox, "out", "t2-deck", "_approved", "tiktok.md")));
  assert.ok(messages().some((t) => /Ready to post/.test(t) && /t2-deck:tiktok/.test(t)));
});

test("deck-level reject applies to both platforms and writes ONE feedback row", async () => {
  push(callback("R|t4-rej"));
  await settle();
  push(message("Slide 2 claims a timer alarm, which doesn't exist"));
  await settle();

  assert.equal(item("t4-rej:tiktok").status, "rejected");
  assert.equal(item("t4-rej:instagram").status, "rejected");
  const rows = readFileSync(join(sandbox, "FEEDBACK.md"), "utf8").split("\n").filter((l) => l.includes("timer alarm"));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /`t4-rej`/);
});

test("a publish interrupted by a crash comes back loud, not silently retried", async () => {
  await stopBot();
  editItem("t3-cap:instagram", (it) => {
    it.status = "approved";
    it.history.push({ status: "approved", at: new Date().toISOString(), by: "schedule" });
  });
  sent = [];
  startBot();
  await settle(1500);

  assert.equal(item("t3-cap:instagram").status, "publish_failed");
  assert.ok(messages().some((t) => /INTERRUPTED PUBLISH/.test(t)));
});

test("telegram hand-off: slides + steps + tap-to-copy caption, then 'I posted it' records it", async () => {
  await stopBot();
  editItem("t4-rej:tiktok", (it) => { it.status = "awaiting"; it.aiImages = true; });
  sent = [];
  startBot({ PUBLISH_TIKTOK: "telegram", PUBLISH_INSTAGRAM: "telegram" });
  await settle(1500);

  push(callback("a|t4-rej:tiktok"));
  await settle(3500);

  const it = item("t4-rej:tiktok");
  assert.equal(it.status, "approved", "handed off, not yet posted");
  assert.equal(it.history.at(-1).publisher, "telegram");
  assert.ok(it.handedOffAt);

  assert.ok(sent.some((s) => s.method === "sendMediaGroup"), "the slides are sent to save and post");
  const steps = messages().find((t) => /Post to TikTok now/.test(t));
  assert.ok(steps, "posting steps are sent");
  assert.match(steps, /AI-generated content: ON/, "AI photos → the label step is included");
  // config.json tiktokAccount: "personal" → full sound library, no bio link.
  assert.match(steps, /trending sound/);
  assert.match(steps, /No bio link on TikTok/);
  const captionMsg = sent.find((s) => s.method === "sendMessage" && /^<pre>/.test(s.body.text || ""));
  assert.match(captionMsg.body.text, /tt caption &amp; copy/, "caption is escaped and tap-to-copy");
  assert.equal(captionMsg.body.reply_markup.inline_keyboard[0][0].callback_data, "P|t4-rej:tiktok");
  assert.ok(!messages().some((t) => /Ready to post/.test(t)), "no duplicate hand-off message from the bot");

  push(callback("P|t4-rej:tiktok"));
  await settle();
  assert.equal(item("t4-rej:tiktok").status, "published");
  const postedAt = item("t4-rej:tiktok").postedAt;

  push(message("/posted t4-rej:tiktok https://tiktok.com/@x/photo/9"));
  await settle();
  assert.equal(item("t4-rej:tiktok").postUrl, "https://tiktok.com/@x/photo/9", "the link can be added afterwards");
  assert.equal(item("t4-rej:tiktok").postedAt, postedAt, "adding the link keeps the real post time");

  push(callback("P|t4-rej:tiktok"));
  await settle();
  assert.equal(item("t4-rej:tiktok").history.filter((h) => h.by === "telegram I-posted-it").length, 1, "a second tap is refused");
});

test("/instagram <token>: checked with Instagram, stored, message deleted, Instagram switched to automatic", async () => {
  await stopBot();
  sent = [];
  startBot({ IG_GRAPH_BASE: `http://127.0.0.1:${apiPort}`, IG_ACCESS_TOKEN: "", IG_USER_ID: "", MARKETING_GCS_BUCKET: "test-bucket", MARKETING_GCS_KEY_B64: "e30=" });
  await settle(1500);

  // A bad token: rejected, message still deleted, nothing switched.
  push(message(`/instagram ${IG_BAD}`));
  await settle(1500);
  assert.ok(sent.some((s) => s.method === "deleteMessage"), "the token message is removed from the chat");
  assert.ok(messages().some((t) => /rejected the token/.test(t)));
  assert.ok(!existsSync(join(sandbox, "bot", "state", "publishers.json")), "a bad token switches nothing");

  // A good one.
  sent = [];
  push(message(`/instagram ${IG_GOOD}`));
  await settle(1500);
  assert.ok(sent.some((s) => s.method === "deleteMessage"));
  assert.ok(messages().some((t) => /Instagram connected[\s\S]*myargusai/.test(t)));
  const pubs = JSON.parse(readFileSync(join(sandbox, "bot", "state", "publishers.json"), "utf8"));
  assert.equal(pubs.instagram, "instagram");
  const tok = JSON.parse(readFileSync(join(sandbox, "bot", "state", "ig-token.json"), "utf8"));
  assert.equal(tok.token, IG_GOOD);
  assert.equal(tok.userId, "17841400000000001");

  // The choice survives a restart.
  await stopBot();
  startBot({ IG_GRAPH_BASE: `http://127.0.0.1:${apiPort}`, IG_ACCESS_TOKEN: "", IG_USER_ID: "", MARKETING_GCS_BUCKET: "test-bucket", MARKETING_GCS_KEY_B64: "e30=" });
  await settle(1500);
  assert.match(out.join(""), /instagram: auto-posts via the Instagram API/);

  push(message("/instagram off"));
  await settle();
  assert.equal(JSON.parse(readFileSync(join(sandbox, "bot", "state", "publishers.json"), "utf8")).instagram, "telegram");

  const bodies = JSON.stringify(sent.map((s) => s.body));
  assert.ok(!bodies.includes(IG_GOOD) && !bodies.includes(IG_BAD), "an Instagram token leaked into something the bot sent");
});

test("the bot token never appears in anything the bot says", async () => {
  const everything = JSON.stringify(sent);
  // The URL path legitimately contains the token (that is Telegram's API
  // shape); what must never happen is the token appearing in a message BODY
  // that gets logged or forwarded.
  const bodies = JSON.stringify(sent.map((s) => s.body));
  assert.ok(!bodies.includes(TOKEN), "token leaked into a message body");
  assert.ok(everything.includes("bot"), "sanity: requests were actually captured");
  await stopBot();
});
