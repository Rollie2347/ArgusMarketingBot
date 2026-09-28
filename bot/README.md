# Argus marketing approval bot

Nothing publishes without Rollie approving it in Telegram. Everything else —
writing the decks, generating the photos, rendering, posting at the right
time — runs on its own.

```bash
cp bot/.env.example bot/.env      # fill in the values — see the file
node bot/bot.mjs                  # the one long-running process
```

## Running on this PC (how it runs today)

A scheduled task, **"Argus marketing bot"**, starts `scripts/run-bot.ps1` hidden
at every Windows logon; the runner restarts the bot if it exits and logs to
`bot/state/bot.log`. Sleep or a reboot only delays things: on return the bot
posts anything whose slot passed and runs the day's batch if it hasn't yet.

```powershell
Get-Content marketing\bot\state\bot.log -Tail 40 -Wait                  # watch it
marketing\scripts\stop-bot.ps1                                         # stop
Start-ScheduledTask "Argus marketing bot"                              # start
powershell -ExecutionPolicy Bypass -File marketing\scripts\install-bot-task.ps1           # (re)install
powershell -ExecutionPolicy Bypass -File marketing\scripts\install-bot-task.ps1 -Remove   # uninstall
```

After editing `bot/.env` or any code, restart it (stop, then start) — the
bot reads its settings once, at startup.

## The daily loop

```
DAILY_RUN_AT (or /generate)
  scripts/daily.mjs
    write-decks.mjs   Gemini writes DECKS_PER_DAY decks from HOOKS.md + FEEDBACK.md;
                      strict validation, 2 repair rounds, failures dropped (never posted)
    make-images.mjs   one photo for the hook slide (+ at most one more), cached by prompt
    make-slideshow    TikTok 9:16 + Instagram 4:5, PNG + JPEG
    enqueue           one queue item per deck per platform
  → Telegram: ONE message per deck — the slideshow video exactly as it will post,
      its caption, and "OK to post?"  ✅ Post it · ❌ Don't post
  → ✅ posts it right away (or at the next POST_TIMES slot, if set); one "✅ Posted" line back
  → ❌ is final on the tap; replying with a reason is optional and goes to FEEDBACK.md
  → everything else is silent except failures (🔥 with a screenshot)
  → POST_PLATFORMS limits which platforms are asked about at all (Instagram: paused
    until its token exists — see ../README.md)
  → ❌ / ✏️ reasons → FEEDBACK.md → tomorrow's writer reads them
```

`daily.mjs` is idempotent: a batch that died halfway is finished by running it
again (`/generate`) — the decks, images and queue entries that exist are reused.

## Publishing

**The free setup:** `PUBLISH_TIKTOK=telegram`, `PUBLISH_INSTAGRAM=instagram`.

| `PUBLISH_<PLATFORM>=` | What happens at the slot |
|---|---|
| `telegram` (default) | The slides (album, saves to the camera roll in order), numbered posting steps and a tap-to-copy caption arrive in Telegram. Post from the phone, tap **✅ I posted it**; `/posted <id> <url>` adds the link later. Free, and the only free TikTok path that isn't private-only. |
| `instagram` | **Free and automatic.** Instagram API with Instagram Login — no Facebook Page, no App Review (a development-mode Meta app can post to its own tester account). Slides are uploaded to a public bucket first (`lib/gcs.mjs`) because Instagram fetches images by URL, JPEG only. The token refreshes itself weekly (`igtoken.mjs`). A retry checks the account's recent posts for the same caption first, so a lost reply can't double-post. **Unverified against the live API** — first run with `DRY_RUN=1`. |
| `manual` | Legacy: a hand-off file on the bot machine's disk — invisible on a server. |
| `uploadpost` | Posts through [Upload-Post](https://upload-post.com), which runs already-audited TikTok and Meta apps — so **no TikTok audit on our side** and no public image hosting (files are uploaded). **Unverified against the live API**: first run with `UPLOADPOST_TIKTOK_POST_MODE=MEDIA_UPLOAD` (TikTok gets a draft) or `DRY_RUN=1`. |
| `tiktok` | Always fails: TikTok's API forces posts from an unaudited client to private. Kept so the reason is on record. |

Upload-Post reports an **unconnected platform as "skipped", not failed** —
`publishers/uploadpost.mjs` treats anything but an explicit success as a
failure, so a disconnected account shows up as 🔥 PUBLISH FAILED, never as a
quiet success. Decks with generated photos are posted with the platforms'
AI-generated-content label.

## Generated photos

Mood photographs only — the fridge, the label, the leak. **Never the app, a
phone screen, text or a logo**: a generated Argus screen would be a fabricated
demo. `lib/validate.mjs` refuses a prompt that asks for one and every prompt
carries a no-text/no-screens style suffix, but the approval is the real check —
reject any image that shows an interface.

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
| `/generate` | write, render and deliver today's batch now (or finish one that failed) |
| `/generate more` | an extra batch on top of today's |
| `/schedule` | what's going out, and when |
| `/queue`, `/status` | everything and its state |
| `/pending` | deliver anything not yet sent |
| `/posted <id> <url>` | record a manually posted item, and get the prefilled TRACKING.md row back |
| `/help` | the above |

## Queue state

`bot/state/queue.json` (or `$MARKETING_DATA_DIR/state/` on a server), one item
per **deck per platform** — they're scheduled, published and measured
separately, and reviewed together on one card per deck, which is the whole point of the `-tt`/`-ig`
slug split. Writes are atomic (temp + rename) because the bot can be killed at
any moment and the record of what already published is the one thing that
can't be reconstructed.

```
pending → awaiting → scheduled → approved → published
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

A publish the bot was **killed in the middle of** comes back on restart as
🔥 INTERRUPTED PUBLISH, not as a silent retry — it may already be live, so a
human checks the account before pressing Retry. Upload-Post calls also carry
the item id as an idempotency key, so a retry after a timeout can't double-post.

A failed **daily batch** is reported (🔥 DAILY BATCH FAILED, with the reason)
and not retried automatically — retrying a failing model call every tick is
how a bug spends money. `/generate` resumes it.

Telegram flood control (HTTP 429) is waited out and retried, and albums are
spaced 1.5s apart — the first real delivery lost two decks to it.

## Feedback loop

Rejections and change requests prompt for a reason, which is appended to
`marketing/FEEDBACK.md` with the angle, hook id and CTA id. **The deck writer
reads it on every run** (and it remains the input to `HOOKS.md` edits) — a hook rejected three times for the
same reason is one to delete, not rewrite.

## Tests

```bash
node --test "bot/test/*.test.mjs" "test/*.test.mjs"     # from marketing/
```

- `bot/test/bot.test.mjs` — 16 end-to-end tests against a fake Bot API: real
  request bodies, multipart albums, callbacks and queue transitions. Covers the
  unauthorised-approval path, deck cards, platform-only approval, slots and the
  per-day cap, publish failure, interrupted publish, 429 retry, token leak.
- `bot/test/uploadpost.test.mjs` — the Upload-Post adapter against a fake of
  its API: request shape, skipped-platform-is-a-failure, async polling,
  idempotency keys, key redaction, draft mode.
- `test/pipeline.test.mjs` — strict validation, the deck writer's repair/drop
  loop, image caching and degradation (fake Gemini), and a real Chrome render.

Nothing touches the network. **None of this proves the real Gemini or
Upload-Post APIs behave as documented** — the first live run does.
