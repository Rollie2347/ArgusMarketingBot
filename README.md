# Argus marketing pipeline

One concept → a postable slideshow for TikTok photo mode and Instagram carousels, repeatably, with
no manual design work per post.

```bash
node scripts/make-slideshow.mjs --check     # validate every deck, render nothing
node scripts/make-slideshow.mjs             # render everything (~22s for 10 decks / 142 PNGs)
node scripts/make-slideshow.mjs 01-fridge-stare --safe   # one deck, with safe-zone guides drawn
```

**Daily, unattended** (what the bot does at `DAILY_RUN_AT`, or on `/generate`):

```bash
node scripts/daily.mjs     # write 3 decks (Gemini) → photos → render → queue; idempotent
node bot/bot.mjs           # delivers them to Telegram, then posts approved ones at their slots
```

By hand, for the hand-written decks — open `out/index.html` to review the whole batch, then:

```bash
node bot/enqueue.mjs                        # load the rendered batch into the approval queue
node bot/bot.mjs                            # deliver to Telegram, wait for Approve/Reject/Changes
```

**Nothing publishes without an approval in Telegram.** What happens after approval, per platform
(`bot/README.md` has the detail):

| Platform | Status (2026-10-04) |
|---|---|
| **TikTok** | **Automatic, verified live.** `PUBLISH_TIKTOK=tiktokweb`: a browser bot on this PC posts each deck to TikTok's website as a swipeable photo post with a sound from TikTok's picker (`config.json` `tiktokFormat: "carousel"`; `"video"` falls back to a silent slideshow video). Logged out → the bot alerts; send `/tiktoklogin` in Telegram and scan the QR. |
| **Instagram** | **Automatic, verified live.** `PUBLISH_INSTAGRAM=instagramweb`: a browser bot posts each deck through instagram.com's Create dialog from a personal account, as a swipeable 4:5 carousel whose slides are short clips over a track from `assets/music/` (`config.json` `instagramFormat: "carousel-sound"`). Logged out → the bot alerts; run `npm run instagram-login` on the PC. |

## Standing rule (Rollie, 2026-10-04)

**Three posts a day, every one with scrollable slides and audio, posted to both TikTok and
Instagram.** In settings: `DECKS_PER_DAY=3`, `POST_PLATFORMS=tiktok,instagram`,
`tiktokFormat: "carousel"` (photo carousel + a sound from TikTok's picker) and
`instagramFormat: "carousel-sound"` (carousel of per-slide clips over a track from `assets/music/`).
Don't switch either platform to a format that drops the swiping or the sound.

## Instagram: why it's a browser bot (history)

Everything on our side is built and tested — `bot/publishers/instagram.mjs` (Instagram API with
Instagram Login, free, allowed by Meta), the public slide bucket (`lib/gcs.mjs`,
`argus-marketing-slides-470515` in `n8n-ai-agents-470515`), weekly token refresh
(`bot/igtoken.mjs`) and the `/instagram <token>` Telegram command that switches it on. **What's
missing is the token**, and getting it has been difficult (2026-09-26/27):

- Meta's setup asked for "business certificates". That is business verification, which is only
  required for apps serving OTHER people's accounts (Advanced Access). For our own account
  (Standard Access, app left in development mode) it is not — skip "connect a business portfolio".
- The account must be a Professional account (Creator is enough, free, no documents).
- Steps: Instagram → switch `myargusai` to Creator → developers.facebook.com → Create app →
  "Manage messaging & content on Instagram" → no business portfolio → Instagram use case →
  "API setup with Instagram login" → Add account (or add as Instagram Tester and accept the invite
  in the Instagram app) → Generate token → send `/instagram <token>` to the bot.

**2026-10-04: Instagram wouldn't let `myargusai` become a Professional account, so the API route is
shelved.** The replacement is `bot/publishers/instagramweb.mjs`: a browser bot on instagram.com like
the TikTok one (against Instagram's terms). Instagram's website has no music picker at any step, so
sound is mixed into the files (`lib/video.mjs`, `lib/music.mjs`, tracks in `assets/music/`).
Live-verified the same day in all three formats: silent photo carousel, Reel with music, and the
current swipeable carousel of per-slide clips with music. Upload-Post
(`bot/publishers/uploadpost.mjs`, paid) uses the same API and needs a Professional account too, so
it is not a way round this.

## Files

| Path | What it is |
|---|---|
| `RESEARCH.md` | Phase 1. Platform mechanics, funnel benchmarks, attribution, cadence — with sources, dates and a confidence tier on every claim. **Read §1.4 before creating any account.** |
| `HOOKS.md` | Hook library by angle, CTA library, and the **capability verification table** — the list of what Argus actually does, checked against `backend/agents.js`. Nothing gets written into a deck that isn't ✅ there. |
| `CALENDAR.md` | Batch plan, posting schedule, the two Phase-2 experiments, and the **readiness check** (currently a hold). |
| `TRACKING.md` | What to log per post, the LTPM metric, the two-layer attribution scheme, and the log table. |
| `config.json` | App id, handle, provider token, redirect base. Three of these are still placeholders — `POST.md` warns about each one until they're set. |
| `decks/*.json` | One file per slideshow. Schema in `decks/_SCHEMA.md`. |
| `templates/theme.css` | The design system. Brand tokens are lifted from the shipping app, not invented. |
| `templates/render.mjs` | Slide object → HTML. Add a slide type here and in `theme.css`. |
| `scripts/make-slideshow.mjs` | The renderer. PNG + JPEG per slide. No npm dependencies. |
| `scripts/write-decks.mjs` | The daily deck writer (Gemini), strict-validated. |
| `lib/trends.mjs` | The trend scout: this week's meme caption formats, by search, phrasing only. Result and reasons in `bot/state/trends.json`. |
| `scripts/make-images.mjs` | Slide photos (Gemini image model), cached by prompt. |
| `scripts/daily.mjs` | write → images → render → enqueue, idempotent. |
| `lib/` | Shared: paths (`MARKETING_DATA_DIR`), validation, Gemini client, `.env` loader. |
| `Dockerfile` | The bot + pipeline as one always-on container, state on a `/data` volume. |
| `bot/` | Telegram approval gate — queue, publishers, tests. See `bot/README.md`. |
| `FEEDBACK.md` | Written by the bot. Every rejection and change request, with its reason. **The input to the next batch's `HOOKS.md`.** |
| `out/` | Generated. Safe to delete and regenerate. |

## Where this lives

This folder is `marketing/` in the Argus repo (`Rollie2347/Argus`) and is also published on its own
as [`Rollie2347/ArgusMarketingBot`](https://github.com/Rollie2347/ArgusMarketingBot) — **public**.
It runs standalone; the one check that needs the app (`backend/agents.js`) skips itself when the
backend tree is absent. Commit in the Argus repo, then publish from the Argus repo root:

```bash
git subtree push --prefix=marketing marketingbot main   # remote: https://github.com/Rollie2347/ArgusMarketingBot.git
```

Secrets (`bot/.env`) and the queue/browser profile (`bot/state/`) are gitignored and must stay that way.

Attribution lives in `backend/server.js` as `GET /g/:slug` — built and tested, not yet deployed.
See `TRACKING.md` §Layer 1 for what it does and the four steps to turn it on.

## How it renders

Headless Chrome, driven over the DevTools protocol from one persistent browser instance. Chrome's
`--screenshot` CLI flag takes one shot per launch (~2.5s of process startup each), which is ~7
minutes for a full batch; the CDP path does the same work in 22 seconds. `--fallback` uses the CLI
path and is the thing to reach for if a Chrome update ever breaks the handshake — it is slower but
has no moving parts. Both are tested.

Chrome is found automatically on Windows/macOS/Linux; override with `ARGUS_CHROME`.

## Guardrails built into the generator

`--check` refuses to render a deck that:

- isn't 6–9 slides, or doesn't start on a `hook` and end on a `cta`
- is missing `angle`, `hookId`, `capabilities` or `ct`
- has a `ct` over 27 chars (Apple caps campaign tokens at 30; a `-tt`/`-ig` suffix is appended)
- is missing a caption or hashtags for a platform being rendered
- contains a banned phrase — Android, any on-device/privacy overclaim, "timer goes off"
  (`cooking_timer` has no alarm), "searches the web" (`web_search` is dormant)

The banned-phrase list is a tripwire, not a safety net. **Check every new claim against
`HOOKS.md`'s verification table, which is checked against `backend/agents.js`.**

## Adding a post

1. Copy an existing deck in `decks/`, rename it (the id becomes the output folder *and* the
   click-tracking slug — don't rename after posting).
2. Pick a hook from `HOOKS.md` and put its id in `hookId`; same for `ctaId`.
3. List the real tools it demonstrates in `capabilities`.
4. Set `ct` to the angle's base token for the current month (`ps-2610`, `dm-2610`, …).
5. `node scripts/make-slideshow.mjs --check`, then render.
