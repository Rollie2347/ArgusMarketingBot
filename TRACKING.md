# Tracking

The point of this file is that batch 2 is written from data rather than from whichever post felt
good. Everything here follows from one fact established in `RESEARCH.md` §4: **the funnel's worst
multiplier is profile-visit → link-tap (3–8%), and the second worst is store-page → install
(5–12%).** Views are the best-converting step in the chain and the least worth optimising, so views
are not the headline metric here.

---

## The metric

**LTPM — link taps per 1,000 impressions.**

```
LTPM = (link taps / impressions) × 1000
```

It is the first number downstream of everything the content controls (hook, body, CTA slide) and
upstream of everything it doesn't (store listing, pricing, device). A hook that triples views and
doesn't move LTPM has failed, and LTPM is the column that says so.

Track installs too, but do not rank on them — at the expected volume (0–1 per 10k impressions) the
install count is too noisy per-post to rank anything.

---

## Two layers of attribution, and why one isn't enough

### Layer 1 — our own redirect (the real instrument) ✅ BUILT, ⚠️ NOT DEPLOYED

`GET /g/:slug` in `backend/server.js`. Logs the hit as a structured line and 302s to the App Store.
Covered by `backend/test/redirect.test.js` (12 tests).

**Shape:** `https://argus-798059802495.us-central1.run.app/g/<deck-id>-<tt|ig>?c=<ct>`

How it behaves, and why each choice matters:

- **302 + `Cache-Control: no-store`, never 301.** A cached redirect is a tap nobody ever sees, and
  it would bias LTPM downward over a post's life — silently, in the direction that makes content
  look worse than it was.
- **Never touches Firestore.** A per-click write would put an unauthenticated, floodable write path
  on the same client `reserveGlobalSlot` uses on every WS connect (98–241ms, already the biggest
  Firestore cost in connection-open). A bot hammering a bio link must not be able to slow down
  session setup. Structured stdout costs microseconds and cannot contend.
- **Fully synchronous, no I/O.** It cannot hold an event-loop turn away from the relay, where CPU
  is the binding constraint.
- **Mounted outside the `/api` rate limiter.** That limiter protects claim/profile; applying it
  here would 429 real people from one carrier's CGNAT egress on their way to the App Store.
  Logging has its own budget — exceeding it drops the **log line**, never the redirect.
- **Unknown slugs still redirect.** A typo'd bio link that loses attribution costs one post's data;
  one that 404s in front of every viewer costs the post.
- **No IPs, no user agents.** Not needed for LTPM, and the app's App Privacy answer of "No" to
  tracking is worth not complicating. Referrer is reduced to its **origin** — path and query are
  dropped. Expect it to be null most of the time: a bio-link tap is a top-level navigation from an
  in-app browser and sends no `Referer`. The slug already carries the platform, which is why.
- **`?c=<ct>` is passed through, not hardcoded.** The backend holds no marketing knowledge and
  never needs redeploying for a new batch; the generator puts the campaign token in the link. It is
  charset-validated before interpolation, and dropped entirely if `APPSTORE_PROVIDER_TOKEN` is
  unset, because a `ct` with no `pt` attributes nothing.

**Reading the numbers back:**

```bash
gcloud logging read 'resource.type=cloud_run_revision
  AND resource.labels.service_name=argus
  AND jsonPayload.event="marketing_click"' \
  --project agus-488919 --freshness=7d \
  --format="value(jsonPayload.slug)" | sort | uniq -c | sort -rn
```

Cloud Run retains logs 30 days. That is enough, because the 48h and day-7 readings get copied into
the log table below, which is the durable record.

**To turn it on:**

1. Deploy: `gcloud run deploy argus --source C:\Users\Custom\dev\Argus --clear-base-image`
   (absolute path — see CLAUDE.md #51).
2. Verify: `curl -sI https://argus-798059802495.us-central1.run.app/g/test` → expect `302` and a
   `location:` of `https://apps.apple.com/...`. Also re-check `curl -s <url>/ | grep -c WS_SECRET`
   is non-zero, per the standing deploy smoke test.
3. Set `redirectBase` in `marketing/config.json` to
   `https://argus-798059802495.us-central1.run.app/g`.
4. Re-run `node scripts/make-slideshow.mjs` so every `POST.md` carries the real link.

Until step 3, each `POST.md` prints a warning that taps are uncounted.

### Layer 2 — App Store Connect campaign tokens

Link shape (`RESEARCH.md` §5.1):

```
https://apps.apple.com/app/apple-store/id6761696821?pt=<PROVIDER>&ct=<CAMPAIGN>&mt=8
```

**`pt` is not in `config.json` yet** and cannot be invented — Apple generates it the first time a
campaign link is created in ASC, and the Campaigns tab only appears once the app has analytics data.
Check for it; if it exists, paste it into `config.json` and regenerate.

**`ct` is per angle per month, NOT per post.** This is the one non-obvious decision in the scheme.
Apple requires **at least 5** of a metric in the date range before it will display anything, and
withholds small rows for privacy. Per-post tokens would report nothing for months. Grouping by angle
aggregates ~2–4 posts per token per month, which has a chance of clearing the threshold, and it
answers the question that actually drives batch 2: *which angle converts.*

| Base token | Angle |
|---|---|
| `ps-YYMM` | problem-solution |
| `dm-YYMM` | demo-the-magic |
| `cg-YYMM` | curiosity-gap |
| `ba-YYMM` | before-after |
| `ty-YYMM` | things-you-didn't-know |
| `id-YYMM` | identity/niche (batch 2) |

The generator appends the platform: `ps-2609-tt`, `ps-2609-ig`. Max length is 30 characters, so the
deck's `ct` field is capped at 27 and validation enforces it.

Data appears in **App Analytics → Sources → Campaigns**, no sooner than 24h after first use. The
first-time-download attribution window is 24h from the click.

### Explicitly not doing: an MMP

No AppsFlyer / Adjust / Branch. They require an SDK, which would flip the app's App Privacy answer
on tracking from **No** to **Yes**, trigger an ATT prompt, and require redoing the privacy nutrition
label — all to measure a few dozen installs. The redirect counter adds nothing to the binary and
changes no privacy answer.

---

## What to log per post

Fill one row per post per platform, within 48h and again at day 7 (most of a carousel's reach
arrives after day 1, unlike a Reel).

| Field | Where it comes from |
|---|---|
| Date, time posted | you |
| Deck id | `out/<id>/` |
| Platform | |
| Angle | deck's `angle` |
| Hook id | deck's `hookId` — **the variable being tested** |
| CTA id | deck's `ctaId` — **the second variable** |
| Format | carousel / reel / real-footage — for the Phase 2 experiments |
| Slides | deck length |
| Sound used | CML track name (TikTok) |
| Impressions / views | platform analytics |
| Swipe-through or completion | TikTok photo mode reports it; IG reports reach + interactions |
| Saves | |
| **Sends / shares** | IG's cold-reach signal — worth its own column |
| **Profile visits** | TikTok reports natively; the first stage we control |
| **Link taps** | the `/g/:slug` log count |
| **LTPM** | computed |
| Store page views | ASC → Sources |
| Installs attributed | ASC → Sources → Campaigns (often blank — that's expected, not broken) |
| Notes | anything unusual |

---

## Log

Newest at the bottom. Add a row per post per platform.

| # | Date | Deck | Plat | Angle | Hook | CTA | Format | Impr. | Swipe% | Saves | Sends | Profile | Taps | **LTPM** | Store views | Installs | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | |

---

## Reading the log

**Do not draw conclusions from one post.** Angles need ~3 posts before the difference between them
is bigger than the noise, which is why batch 1 puts 2–4 posts into each of five angles rather than
one post into ten.

**The three questions the log has to answer, in priority order:**

1. **Which angle has the highest LTPM?** → decides 6 of batch 2's 10 decks.
2. **Does the CTA slide move LTPM independently of the hook?** → compare posts sharing an angle but
   using different `ctaId`s. If CTA matters more than angle, batch 2 should hold the hook constant
   and rotate CTAs instead, which is a completely different experiment.
3. **Do carousels beat Reels on LTPM (not on views)?** → Phase 2 Experiment A. This is the one that
   could change the format of the whole programme, and the published "5x reach" claim it rests on is
   unsourced (RESEARCH §1.2).

**Traps worth naming in advance:**

- **A post with huge views and flat taps is a failure**, and it will not feel like one. Rank by
  LTPM, not by the number that shows up in the notification.
- **Blank install columns are the expected state**, not a broken pipeline. Apple suppresses under 5.
  Do not "fix" attribution in response to blanks — check the tap count instead, which is ours and
  has no threshold.
- **Don't compare LTPM across platforms as if it were one number.** TikTok and Instagram count an
  impression differently and the tap paths differ (bio vs bio + Story sticker). Compare TikTok to
  TikTok.
- **Day-1 numbers under-report carousels.** Carousel reach accumulates for days. A Reel's day-1
  number is closer to final. Comparing a day-1 carousel to a day-1 Reel systematically favours the
  Reel — hence the day-7 second reading.

---

## Where the rows come from

The approval bot fills most of a row for you. When a post goes out, `/posted <id> <url>` returns
the row pre-populated with date, deck, platform, angle, hook id, CTA id and the tracking URL — the
fields that are knowable before the post exists. Only the measured columns are left to fill in at
48h and day 7.

The bot's `bot/state/queue.json` also holds `postId`, `postedAt`, `ct` and `trackingUrl` per item,
so if a row goes missing here it can be reconstructed from there.

## Setup checklist

- [x] `GET /g/:slug` redirect route written and tested in `backend/server.js`, outside the `/api/*` rate limiter
- [ ] **Backend deployed** so the route is actually live (`curl -sI <url>/g/test` → 302)
- [ ] `redirectBase` set in `config.json` and the batch regenerated
- [ ] ASC checked for the Campaigns tab; `providerToken` set in `config.json` if it exists
- [ ] Real `handle` set in `config.json` and the batch regenerated (it is on every slide)
- [ ] Pricing confirmed Free in ASC (every CTA in batch 1 says so)
- [ ] TikTok **Business** account created and the App Store link confirmed saveable in the bio
- [ ] Instagram bio link set (up to 5 links, each with a display title)
- [ ] A log row template copied for the first post
