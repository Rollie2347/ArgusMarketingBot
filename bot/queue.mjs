/**
 * The approval queue.
 *
 * One item = one deck on one platform. A deck rendered for TikTok and
 * Instagram produces two items, because they are approved, published and
 * measured separately — the whole point of the `-tt` / `-ig` slug split.
 *
 * Storage is a single JSON file under bot/state/ (gitignored). Not Firestore:
 * this is marketing workflow metadata on an operator's machine, it has no
 * multi-writer story, and putting it in Firestore would add a credential and a
 * network dependency to a tool whose entire job is to run unattended for
 * days. A crashed bot must come back to exactly the state it left.
 *
 * Writes are atomic (temp file + rename) because the bot can be killed at any
 * moment, and a half-written queue would lose the record of what was already
 * published — which is the one piece of state that cannot be reconstructed.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { QUEUE_FILE, STATE_DIR } from "./config.mjs";

/**
 * pending           created, not yet sent to Telegram
 * awaiting          delivered, buttons live, waiting on a decision
 * approved          approved, publish not yet attempted
 * published         publisher reported success
 * publish_failed    approved but the publisher errored — LOUD, retriable
 * rejected          killed, with a reason
 * changes_requested sent back, with notes
 */
export const STATUSES = ["pending", "awaiting", "approved", "published", "publish_failed", "rejected", "changes_requested"];

function empty() { return { version: 1, items: [] }; }

export function load() {
  if (!existsSync(QUEUE_FILE)) return empty();
  try {
    const q = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (!Array.isArray(q.items)) return empty();
    return q;
  } catch (err) {
    // Refuse rather than silently starting from an empty queue: an empty queue
    // looks exactly like "everything is published" and would re-deliver or
    // lose records without anyone noticing.
    throw new Error(`queue file at ${QUEUE_FILE} is unreadable (${err.message}). Fix or move it — refusing to start from an empty queue.`);
  }
}

export function save(q) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(q, null, 2), "utf8");
  renameSync(tmp, QUEUE_FILE);
}

export function itemId(deckId, platform) { return `${deckId}:${platform}`; }

export function find(q, id) { return q.items.find((i) => i.id === id) || null; }

export function add(q, item) {
  const existing = find(q, item.id);
  if (existing) return { item: existing, added: false };
  q.items.push(item);
  return { item, added: true };
}

/**
 * Every status change is appended to the item's history rather than
 * overwriting a single timestamp. The history is what TRACKING.md joins
 * against later, and "when was this approved vs when did it actually publish"
 * is exactly the gap a silent publish failure hides in.
 */
export function transition(item, status, detail = {}) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status "${status}"`);
  item.status = status;
  item.updatedAt = new Date().toISOString();
  item.history = item.history || [];
  item.history.push({ status, at: item.updatedAt, ...detail });
  return item;
}

export const byStatus = (q, ...statuses) => q.items.filter((i) => statuses.includes(i.status));

/** One line per item, for the bot's /queue command and the CLI. */
export function summarize(q) {
  if (!q.items.length) return "Queue is empty.";
  const counts = {};
  for (const i of q.items) counts[i.status] = (counts[i.status] || 0) + 1;
  const head = STATUSES.filter((s) => counts[s]).map((s) => `${s}: ${counts[s]}`).join("  ·  ");
  const lines = q.items.map((i) => `${statusIcon(i.status)} ${i.id}  (${i.angle}/${i.hookId})${i.reason ? ` — "${i.reason}"` : ""}`);
  return `${head}\n\n${lines.join("\n")}`;
}

export function statusIcon(s) {
  return {
    pending: "·", awaiting: "⏳", approved: "✔", published: "🚀",
    publish_failed: "🔥", rejected: "✖", changes_requested: "✎",
  }[s] || "?";
}
