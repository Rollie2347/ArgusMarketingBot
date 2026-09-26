# Batch production plan and posting cadence

Built on `RESEARCH.md` §6 (warming + cadence) and §4 (where the funnel leaks). Dates are
placeholders anchored on **Day 1** — set Day 1 only after reading the readiness check at the bottom,
which is currently a **hold**.

---

## The loop this is meant to become

```
  pick an angle from HOOKS.md
        ↓
  write decks/NN-name.json          ~20 min per deck
        ↓
  node scripts/make-slideshow.mjs --check     (validates claims + structure)
        ↓
  node scripts/make-slideshow.mjs             (~2s per deck, both platforms)
        ↓
  review out/index.html
        ↓
  post from out/<id>/POST.md (captions, hashtags, link, checklist)
        ↓
  log the row in TRACKING.md
        ↓
  after 10 posts: read the LTPM column, keep the top 2 angles, cut the bottom 2
```

The only manual steps are writing copy and pressing post. Everything between them is one command.

---

## Phase 0 — Before Day 1 (blocking)

These are prerequisites, not tasks to do alongside posting. Each one, left undone, invalidates the
whole batch.

| # | Task | Why it blocks |
|---|---|---|
| 1 | **Register the TikTok account as a Business account** | Personal/creator accounts cannot link to an App Store page at all (RESEARCH §1.4). Posting first and converting later wastes the warm-up. |
| 2 | **Verify the App Store link actually saves in the TikTok bio** | The only primary source for the block is from 2023. Two minutes to check; the entire funnel depends on it. |
| 3 | **Set `handle` in `config.json` and regenerate** | The placeholder `@argus.app` is printed on all 142 slides. |
| 4 | **Confirm pricing is Free in ASC** | Every CTA in batch 1 says "free". `APP_STORE_LISTING.md` flags pricing as unconfirmed. |
| 5 | ~~Build the `/g/:slug` redirect~~ → **DONE. Now: deploy it.** | Built and tested in `backend/server.js` (12 tests), but not on the live revision. Four steps in TRACKING.md §Layer 1. Until it's deployed there is no per-post link-tap number and ASC reports nothing at this volume. |
| 6 | **Check whether ASC's Campaigns tab exists yet**, and if so generate the provider token into `config.json` | `pt` cannot be invented; Apple gates the tab on the app having analytics data. |
| 7 | ~~Fix the "Search and look things up" line~~ → **DONE in `APP_STORE_LISTING.md`. Now: apply it in ASC.** | The file is corrected; the **live listing is not**. Description text is only editable while a version sits in *Prepare for Submission* — v1.0.5 is, right now, so this is free today and costs a version train once 1.0.5 goes live. |
| 8 | **Resolve the first-run bug — see the readiness check below** | |
| 9 | **Set up the Telegram bot** (`@BotFather` → token, `@userinfobot` → chat id) into `bot/.env` | The approval gate is built and tested but needs its two secrets. Nothing else blocks it. |

---

## Phase 1 — Warm-up, Days 1–10

Post **one deck per day**, TikTok in the morning and the same deck to Instagram the same day. One
post per platform per day, not more: a new account gets a limited early test window and splitting it
across several same-day uploads is the most-repeated mechanistic warning in the warm-up literature
(RESEARCH §6.1).

Alongside, for the first 7–14 days: use both apps like a person for a few minutes a day — scroll,
watch to the end, follow cooking / DIY / iPhone-tips accounts. This is the cheap half of warming and
it costs nothing.

| Day | Deck | Angle | Hook | `ct` base |
|---|---|---|---|---|
| 1 | `01-fridge-stare` | problem-solution | PS-01 | `ps-2609` |
| 2 | `05-no-wake-word` | demo-the-magic | DM-06 | `dm-2609` |
| 3 | `02-label-squint` | problem-solution | PS-02 | `ps-2609` |
| 4 | `07-camera-year` | curiosity-gap | CG-01 | `cg-2609` |
| 5 | `03-under-the-sink` | problem-solution | PS-03 | `ps-2609` |
| 6 | `08-show-dont-describe` | before-after | BA-04 | `ba-2609` |
| 7 | `04-menu-read` | demo-the-magic | DM-04 | `dm-2609` |
| 8 | `06-stop-repeating` | curiosity-gap | CG-04 | `cg-2609` |
| 9 | `10-two-boxes` | problem-solution | PS-04 | `ps-2609` |
| 10 | `09-four-questions` | things-you-didn't-know | TY-03 | `ty-2609` |

**The order is deliberate.** Angles alternate rather than running in blocks, so an early algorithmic
cold streak hits every angle roughly equally instead of burying one of them. If days 1–4 all did
badly and they were all problem-solution, you would learn nothing about problem-solution.

**Expectation setting, so a normal result is not misread as failure:**
- A first post on a warmed account landing at **150–300 views** is healthy (RESEARCH §6.1).
- At published rates, **10,000 impressions produces roughly 0–1 installs** (RESEARCH §4.2).
- Across all ten posts, a plausible total is **single-digit installs**. That is the baseline the
  next batch improves on, not a verdict on the product.

---

## Phase 2 — Days 11–30: settle to 4–5/week and start testing format

Drop to **4–5 posts/week on TikTok**, **3–5 feed posts + 2 Reels/week on Instagram** (RESEARCH §6.2).

Two experiments run in this window. Both exist because RESEARCH could not settle them:

**Experiment A — do carousels actually out-distribute video?** The "5x reach" claim has no traceable
source. Cut **2 Reels** from decks that already performed well in batch 1: pan/cut the existing PNGs
at 20–40s with a voiceover reading the slide copy (the `## Slide copy` block in each `POST.md` is
written for exactly this). Compare views and — more importantly — LTPM against the carousel version
of the same deck.

**Experiment B — typographic template vs real footage.** The Mosseri memo reportedly favours "raw,
real human content" over AI-generated material through 2026 (RESEARCH §2.1), which is an awkward
signal for an AI app posting designed slides. Shoot **2 posts as real screen-recordings** of Argus
working — an actual fridge, an actual label — using the same hook and CTA copy. Same angle, same
hook, different production. If the raw ones win on LTPM, the template becomes the frame and real
footage becomes the content, which is what HOOKS.md §3.2 already recommends.

---

## Phase 3 — Day 30 onward: read the data, then write batch 2

By day 30 there should be ~10 carousels + ~10 more posts + the two experiments.

**The decision rule, set in advance so it isn't rationalised later:**

1. Rank all posts by **LTPM (link taps per 1,000 impressions)** — not views, not engagement rate.
2. Keep the **top 2 angles**. Write 6 of batch 2's 10 decks in those angles.
3. Cut the **bottom 2 angles** entirely unless their sample is under ~3 posts.
4. The remaining 4 decks test something genuinely new — Angle F (identity/niche) from HOOKS.md is
   the obvious next one, because it converts harder when it lands and batch 1 deliberately contains
   none of it.
5. If **every** angle sits near zero LTPM, the problem is not the angle — it is either the CTA slide
   or the bio link, and those get tested directly (rotate CTA-01 through CTA-06 on a single
   repeated hook) before writing any more decks.

---

## Batch production timings, measured

From the real runs building batch 1:

| Step | Cost |
|---|---|
| Writing one deck (copy, hooks, captions, hashtags) | ~20 min |
| `--check` validation | instant |
| Render, 1 deck, both platforms | ~2.2s |
| Render, full 10-deck batch, 142 PNGs | **22s** |
| Render via `--fallback` (one Chrome per slide) | ~0.8s/slide — ~2 min for the batch |

So a batch of 10 is **about three and a half hours of writing and under a minute of machine time.**
Copy is the bottleneck, which is the correct place for it to be.

---

## ⚠️ Readiness check — recommendation: HOLD

Checked against `CLAUDE.md`'s open issues on 2026-09-20.

### The blocker

**Issue #57 — the app can appear dead on first speak, and only a full app kill fixes it.** The
brief describes this as open. It is more nuanced than that, and the nuance matters:

- The **root cause was found and fixed** in commit `de135ac`: the mic mute toggle persisted across
  reconnects while its on-screen switch was unmounted, so a session could come back muted with no
  visible control and no error. Camera, greeting and status badge all behaved normally — the
  session just never heard anything. The fix resets mute on every connect and renders a red
  "Mic muted — tap Mic to talk" badge so the state can never again be invisible.
- **The fix is not on anyone's phone.** It shipped in build 52, which Apple refused at upload
  (issue #58 — closed version train, fourth occurrence). `app.json` was bumped to 1.0.5 and
  **build 53 is the one that carries it.** Action item 9 says build 53 still has to be manually
  selected for review on App Store Connect's **App Store** tab — a separate step that has already
  caused Apple to review a months-old build once (#23).

  > **Verified, not taken from CLAUDE.md.** That file warns its own build claims have been wrong
  > four times, so this one was checked directly. `eas build:list --platform ios` reports
  > **build 53, appVersion 1.0.5, gitCommitHash `983dfb64`, FINISHED 2026-09-13T22:16Z**, and
  > `git merge-base --is-ancestor de135ac 983dfb6` confirms the mute fix is an ancestor of that
  > commit. So build 53 genuinely carries the fix. **What could not be checked from here is whether
  > build 53 has been selected for review or approved** — that is App Store Connect account state
  > and needs Rollie's login. If it is already live, the blocker below is cleared and Day 1 can be
  > this week.
- Measured base rate of the bug: **2 of 122 real sessions (~3%)** over 30 days, both from the same
  tester. That is low. But it is ~3% of *sessions*, and the failure mode is specifically
  "app appears completely broken on first use" — which is precisely the session a new install is.

### The other open items, in order of how much they'd hurt a new user

| Issue | Effect on a first-run install | Severity |
|---|---|---|
| **#57 dead mic on reconnect** (fixed in build 53, not yet reviewed/released) | App looks broken; only force-quit recovers | **High** |
| **No crash reporting** (action item 12) | A surge of installs produces crash reports we cannot see at all. Every client-side failure this project has diagnosed was inferred from *backend* logs. Posting into this is flying blind exactly when data matters most. | **High, and it compounds the others** |
| **`web_search` dormant / grounding unproven** (HOOKS.md table, CLAUDE.md #52) | The App Store description promises "Search and look things up". A user who tries it finds it missing. | **Medium** — a listing-copy fix, not a code fix |
| **No background operation / no WS keepalive** | Backgrounding the phone mid-session can drop it. Surfaces as a toast now, not a silent death. | Medium |
| **Mic gate discards speech during long replies** (#44) | User talks during a long answer, isn't heard, has to repeat. Reads as "slow". | Medium |
| **~1.8s median response latency** (#42) | Architectural floor, not a bug. Noticeable, not broken. | Low |
| **`WS_SHARED_SECRET` is a guessable placeholder** (#34, action item 8) | Not a user-facing bug. But the only real bound on Gemini spend is a global session cap and a **budget alert, not a hard cap**. A genuine install surge with an unprotected WS endpoint is a cost-exposure question, not just a quality one. | **Worth a decision before volume** |

### Recommendation

**Hold. Do not start posting until build 53 is live on the App Store.**

The reasoning, plainly:

1. **The cost of posting early is permanent and the cost of waiting is not.** A 1-star review that
   says "doesn't respond, had to force quit" stays on the product page forever and depresses the
   product-page→install rate — which RESEARCH §4.3 identifies as the *second worst multiplier in
   the entire funnel*. Ten posts delayed by a week cost roughly a week.
2. **The fix already exists.** This isn't a hold on engineering work; it's a hold on one manual
   click in App Store Connect plus Apple's review. That is the cheapest possible blocker to clear.
3. **We would not be able to see the damage.** With no crash reporting, a wave of installs hitting a
   first-run failure produces no signal we can read. We'd learn about it from the reviews.
4. **The funnel is not built yet anyway.** Phase 0 items 5 and 6 — the redirect counter and the
   provider token — are not done. Posting before them means the first ten posts, the ones that are
   supposed to be the experiment that decides batch 2, produce no per-post data. **Posting now
   would waste the batch even if the app were perfect.**

**What to do during the hold, in order:**

1. **Confirm in App Store Connect whether build 53 has been selected for review**, and select it if
   not. This is account state that cannot be read from here — `eas build:list` proves the build
   exists and `git merge-base` proves it carries the #57 fix, but neither says anything about
   review status.
2. **Deploy the backend** so `/g/:slug` goes live, then set `redirectBase` in `config.json` and
   regenerate. Four steps in TRACKING.md §Layer 1. Highest-value remaining item.
3. **Apply the corrected App Store description** while v1.0.5 is still in *Prepare for Submission*
   — the corrections are already in `mobile/APP_STORE_LISTING.md`. After 1.0.5 goes live this costs
   a whole version train.
4. Set the real handle in `config.json`, regenerate, confirm Free pricing.
5. Create the Telegram bot and fill `bot/.env`.
6. Register the TikTok **Business** account and start the passive warming — **this does not need
   the app to be fixed** and burns down the 7–14 day warm-up in parallel with Apple's review.
7. Decide on `WS_SHARED_SECRET` (action item 8) — it must be sequenced with a build anyway, and
   build 53 is a build.

Item 5 means the hold costs close to nothing in calendar time: warming runs concurrently with
review. Realistically **Day 1 lands about a week out**, gated on Apple.

**This is Rollie's call, not mine.** If the decision is to post anyway, the version that loses least
is: post to Instagram only, keep the bio link pointed at the `/about` page rather than the App Store
until build 53 ships, and use the batch to test hooks against *profile-visit rate* rather than
installs. That gets the angle data without pointing installs at a broken first run.
