# Argus marketing approval bot

Nothing publishes without Rollie approving it in Telegram.

```bash
cp bot/.env.example bot/.env      # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
node scripts/make-slideshow.mjs   # render the batch
node bot/enqueue.mjs              # load it into the approval queue
node bot/bot.mjs                  # start the bot — it delivers anything pending
```

Then in Telegram: each post arrives as the slide album plus a card with
**✅ Approve / ❌ Reject / ✏️ Changes**.

## What actually happens on approve

| Platform | Today | Why |
|---|---|---|
| **TikTok** | **Manual.** Approved → a ready-to-post file at `out/<deck>/_approved/tiktok.md` | Direct Post needs a **passed app audit**. Unaudited clients are forced to `SELF_ONLY` — visible only to the creator — and capped at 5 posting users per 24h. A SELF_ONLY post has no distribution, so it isn't a post. Photo carousels are also URL-pull only. |
| **Instagram** | **Manual by default.** A complete adapter exists but is off and **unverified** | Needs an IG Business/Creator account, a linked Facebook Page, a Meta app, and a long-lived token. None exist yet. The app owner's own account works in development mode without full App Review, so this is *setup*, not engineering. Meta fetches images server-side, so the PNGs must be on a public HTTPS host first. |

**So right now: both platforms stop at "approved asset, post manually."** That is
a prerequisites problem, not a code problem — see `publishers/index.mjs` for
the full list per platform.

To try Instagram once the account exists:

```bash
PUBLISH_INSTAGRAM=instagram DRY_RUN=1 node bot/bot.mjs   # prints what it WOULD send
```

Read that output before dropping `DRY_RUN`.

## Polling, not webhooks — and a separate service

Both halves were deliberate.

**Long polling** because a webhook needs a public HTTPS endpoint, and the only
public HTTPS service this project runs is the Cloud Run instance holding the
Gemini key and relaying every Live session. Adding an internet-reachable route
that accepts third-party JSON to *that* service enlarges the attack surface of
the most sensitive thing we run, to save a few seconds on a human approval.
Polling needs no inbound connectivity at all — no public URL, no TLS cert, no
secret webhook path, nothing exposed if the process dies.

**A separate process** because CPU is the binding constraint on the backend
(CLAUDE.md #36): each Live session base64-decodes ~43KB of audio a second plus
a ~150KB frame every two. Telegram traffic — including multi-megabyte album
uploads — would share that CPU with live conversations. The same rule that
keeps the `/g/:slug` counter off the Firestore path applies here. It also means
restarting or editing the bot mid-batch can never touch a production session.

The honest counter-argument: webhooks scale better and cost nothing idle. At
one operator and ten posts a batch, neither matters. If this ever became
multi-operator and high-volume the answer flips — and it should *still* be its
own service, not folded into the relay.

## Security

- **One authorised chat.** Every update is checked against `TELEGRAM_CHAT_ID`
  before anything else; both `chat.id` and `from.id` must match. Telegram bot
  usernames are discoverable and anyone can open a chat with one, so without
  this a stranger could approve posts to the real accounts. Unauthorised
  updates are logged and answered with a refusal.
- **Token hygiene.** Telegram puts the bot token in every request *path*, so
  any error echoing a URL leaks it. Every exit path in `telegram.mjs` goes
  through `redact()`, and startup prints the token's **length only** — not a
  prefix, suffix or fingerprint. Same treatment for `IG_ACCESS_TOKEN`, which is
  sent as a form field rather than a query parameter for exactly this reason.
- `bot/.env` and `bot/state/` are gitignored.

## Commands

| | |
|---|---|
| `/queue`, `/status` | everything and its state |
| `/pending` | deliver anything not yet sent |
| `/posted <id> <url>` | record a manually posted item, and get the prefilled TRACKING.md row back |
| `/help` | the above |

## Queue state

`bot/state/queue.json`, one item per **deck per platform** — they're approved,
published and measured separately, which is the whole point of the `-tt`/`-ig`
slug split. Writes are atomic (temp + rename) because the bot can be killed at
any moment and the record of what already published is the one thing that
can't be reconstructed.

```
pending → awaiting → approved → published
                            ↘ publish_failed  (loud, retriable)
             ↘ rejected / changes_requested   (reason → FEEDBACK.md)
```

Every transition is appended to the item's `history`, so "approved at X,
published at Y" stays visible — that gap is exactly where a silent publish
failure would otherwise hide.

## Failure handling

A publisher that throws sends a **🔥 PUBLISH FAILED** message carrying the real
reason and a **🔁 Retry publish** button, and parks the item in
`publish_failed`. Nothing retries on its own. The failure this exists to
prevent is approved content that never posted and nobody noticing for days.

## Feedback loop

Rejections and change requests prompt for a reason, which is appended to
`marketing/FEEDBACK.md` with the angle, hook id and CTA id. **That file is the
input to the next batch's `HOOKS.md`** — a hook rejected three times for the
same reason is one to delete, not rewrite.

## Tests

```bash
node --test bot/test/bot.test.mjs
```

Ten end-to-end tests against a fake Bot API served locally: real request
bodies, real multipart album upload, real callback handling, real queue
transitions. Nothing touches the network. They cover the unauthorised-approval
path, the publish-failure path and the token-leak check.
