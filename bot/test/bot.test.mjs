/**
 * End-to-end test for the approval bot, against a fake Bot API.
 *
 * The bot is driven by a real HTTP server standing in for api.telegram.org, so
 * this exercises the actual request bodies, the actual multipart album upload,
 * the actual callback handling and the actual queue transitions — not mocks of
 * them. Nothing here talks to Telegram, Instagram, or the network.
 *
 * What it proves, in order of how much it would hurt to get wrong:
 *   1. an unauthorised chat cannot approve anything
 *   2. approve runs the publisher and writes the hand-off
 *   3. a publish failure is LOUD and leaves the item retriable, never silent
 *   4. a rejection reason reaches FEEDBACK.md
 *   5. the bot token never appears in an error message
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = join(HERE, "..");
const MARKETING = join(BOT_DIR, "..");

const TOKEN = "123456:FAKE-TOKEN-DO-NOT-USE";
const CHAT = "999000111";
const STRANGER = "555000555";

let api, apiPort, sandbox, child;
let sent = [];          // every request the bot made to the fake API
let updateQueue = [];   // what the next getUpdates returns
let nextUpdateId = 1;

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

        if (method === "getMe") return reply({ id: 1, username: "argus_approval_test_bot" });
        if (method === "getUpdates") {
          const out = updateQueue;
          updateQueue = [];
          // Answer immediately when there is something; otherwise hold briefly
          // so the bot's loop doesn't spin.
          if (out.length) return reply(out);
          return setTimeout(() => reply([]), 300);
        }
        if (method === "sendMediaGroup") return reply([{ message_id: 1 }]);
        if (method === "sendMessage") return reply({ message_id: 4242 });
        if (method === "answerCallbackQuery") return reply(true);
        if (method === "editMessageReplyMarkup") return reply({ message_id: 4242 });
        return reply(true);
      });
    });
    api.listen(0, "127.0.0.1", () => { apiPort = api.address().port; resolve(); });
  });
}

/**
 * A sandbox copy of the marketing tree with ONE tiny deck, so the test does
 * not depend on the real batch being rendered and cannot write to it.
 */
function buildSandbox() {
  sandbox = mkdtempSync(join(tmpdir(), "argus-bot-test-"));
  const botDir = join(sandbox, "bot");
  cpSync(BOT_DIR, botDir, { recursive: true, filter: (src) => !src.includes(`${sep()}state`) && !src.endsWith(".env") });

  const deckId = "t1-probe";
  for (const platform of ["tiktok", "instagram"]) {
    const dir = join(sandbox, "out", deckId, platform);
    mkdirSync(dir, { recursive: true });
    // A 1x1 PNG is enough — the album upload path only cares about bytes.
    const png = Buffer.from("89504e470d0a1a0a0000000d4946484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
    writeFileSync(join(dir, "01.png"), png);
    writeFileSync(join(dir, "02.png"), png);
  }
  writeFileSync(join(sandbox, "out", deckId, "manifest.json"), JSON.stringify({
    id: deckId, title: "Probe deck", angle: "problem-solution", hookId: "PS-01", ctaId: "CTA-01",
    capabilities: ["read_text"], ct: "ps-2609", slides: 2, platforms: ["tiktok", "instagram"],
    links: {
      tiktok: { ct: "ps-2609-tt", bio: "https://example.test/g/t1-probe-tt", store: "https://apps.apple.com/x" },
      instagram: { ct: "ps-2609-ig", bio: "https://example.test/g/t1-probe-ig", store: "https://apps.apple.com/x" },
    },
  }), "utf8");

  mkdirSync(join(sandbox, "decks"), { recursive: true });
  writeFileSync(join(sandbox, "decks", `${deckId}.json`), JSON.stringify({
    caption: { tiktok: "tt caption & copy", instagram: "ig caption" },
    hashtags: { tiktok: ["a"], instagram: ["b"] },
  }), "utf8");
}

const sep = () => (process.platform === "win32" ? "\\" : "/");

before(async () => {
  await startFakeApi();
  buildSandbox();

  // Queue the sandbox deck.
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

function startBot(extraEnv = {}) {
  child = spawn(process.execPath, [join(sandbox, "bot", "bot.mjs")], {
    cwd: sandbox,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TELEGRAM_CHAT_ID: CHAT,
      TELEGRAM_API_BASE: `http://127.0.0.1:${apiPort}`,
      TELEGRAM_POLL_TIMEOUT_SEC: "1",
      ...extraEnv,
    },
    stdio: "pipe",
  });
  const out = [];
  child.stdout.on("data", (b) => out.push(String(b)));
  child.stderr.on("data", (b) => out.push(String(b)));
  return out;
}

const settle = (ms = 1200) => new Promise((r) => setTimeout(r, ms));
const queue = () => JSON.parse(readFileSync(join(sandbox, "bot", "state", "queue.json"), "utf8"));
const item = (id) => queue().items.find((i) => i.id === id);

test("enqueue built both platform items from one rendered deck", () => {
  assert.equal(queue().items.length, 2);
  assert.ok(item("t1-probe:tiktok"));
  assert.equal(item("t1-probe:tiktok").ct, "ps-2609-tt");
  assert.equal(item("t1-probe:instagram").ct, "ps-2609-ig");
});

test("bot delivers pending items as an album plus a button message", async () => {
  const out = startBot();
  await settle(2000);

  const albums = sent.filter((s) => s.method === "sendMediaGroup");
  assert.equal(albums.length, 2, "one album per queued item");
  assert.ok(albums[0].body._multipart, "album must be multipart, not JSON");

  const cards = sent.filter((s) => s.method === "sendMessage" && s.body.reply_markup?.inline_keyboard);
  assert.equal(cards.length, 2, "buttons arrive as a separate message — sendMediaGroup can't carry them");
  const labels = cards[0].body.reply_markup.inline_keyboard[0].map((b) => b.text).join(" ");
  assert.match(labels, /Approve/);
  assert.match(labels, /Reject/);
  assert.match(labels, /Changes/);

  assert.equal(item("t1-probe:tiktok").status, "awaiting");
  assert.ok(out.join("").includes("argus_approval_test_bot"));
});

test("an unauthorised user cannot approve anything", async () => {
  const before = item("t1-probe:tiktok").status;
  push(callback("a|t1-probe:tiktok", STRANGER));
  await settle();

  assert.equal(item("t1-probe:tiktok").status, before, "a stranger's approval must not change state");
  const alerts = sent.filter((s) => s.method === "answerCallbackQuery" && s.body.show_alert);
  assert.ok(alerts.some((a) => /not authorised/i.test(a.body.text)), "stranger should be told no");
});

test("approve runs the publisher and writes a hand-off file", async () => {
  push(callback("a|t1-probe:tiktok"));
  await settle(1500);

  const it = item("t1-probe:tiktok");
  assert.equal(it.status, "approved", "manual publisher approves without publishing");
  assert.equal(it.history.at(-1).status, "approved");

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
  await settle();
  assert.equal(item("t1-probe:instagram").status, "rejected", "a second press must not override the decision");
});

test("/queue reports status without changing anything", async () => {
  sent = [];
  push(message("/queue"));
  await settle();
  const reply = sent.find((s) => s.method === "sendMessage" && /t1-probe/.test(s.body.text || ""));
  assert.ok(reply, "expected a queue summary");
  assert.match(reply.body.text, /approved|rejected/);
});

test("/posted records a manual post and hands back a TRACKING.md row", async () => {
  sent = [];
  push(message("/posted t1-probe:tiktok https://tiktok.com/@x/photo/123"));
  await settle();

  const it = item("t1-probe:tiktok");
  assert.equal(it.status, "published");
  assert.equal(it.postUrl, "https://tiktok.com/@x/photo/123");
  assert.ok(it.postedAt);

  const reply = sent.find((s) => s.method === "sendMessage" && /TT/.test(s.body.text || ""));
  assert.ok(reply, "expected a prefilled tracking row");
  assert.match(reply.body.text, /PS-01/);
});

test("a publish failure is loud, retriable, and never silent", async () => {
  child.kill();
  await settle(300);

  // TikTok's adapter always throws — it is the documented "not available"
  // path, which makes it the honest way to exercise failure handling.
  sent = [];
  const q = queue();
  const it = q.items.find((i) => i.id === "t1-probe:tiktok");
  it.status = "awaiting";
  writeFileSync(join(sandbox, "bot", "state", "queue.json"), JSON.stringify(q, null, 2));

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

test("the bot token never appears in anything the bot says", async () => {
  const everything = JSON.stringify(sent);
  // The URL path legitimately contains the token (that is Telegram's API
  // shape); what must never happen is the token appearing in a message BODY
  // that gets logged or forwarded.
  const bodies = JSON.stringify(sent.map((s) => s.body));
  assert.ok(!bodies.includes(TOKEN), "token leaked into a message body");
  assert.ok(everything.includes("bot"), "sanity: requests were actually captured");
});
