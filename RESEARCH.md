# Argus marketing research — Phase 1

**Compiled 2026-09-20.** Everything below was searched fresh; nothing is from general knowledge.
Re-verify anything marked ⚠️ before betting money on it.

---

## 0. Read this before you read anything else: source quality

Searching "TikTok photo mode 2026" / "Instagram carousel 2026" returns a results page that is
**almost entirely SEO content farms** — `reelbase.io`, `instacarousel.com`, `ghostshorts.com`,
`alici.ai`, `posteverywhere.ai`, `carouselmaker.co`, `tokportal.com` and two dozen others. These
sites exist to sell a carousel-generator subscription. They cite each other, they quote numbers with
no methodology, and several of the most-repeated figures ("5x more reach", "70% less reach without
audio") **could not be traced to any primary source or dataset**.

So this document splits everything into three confidence tiers:

| Tier | Meaning |
|---|---|
| **HARD** | Primary source — Apple developer docs, TikTok legal/policy pages, TechCrunch reporting on a named policy change. Act on it. |
| **SOFT** | Named analytics vendor with a stated sample size (Socialinsider, Buffer, AppTweak). Directionally trustworthy, exact number is not. |
| ⚠️ **FOLKLORE** | Repeated everywhere, sourced nowhere. Treat as a hypothesis to test, not a fact. |

The practical consequence for Argus: **the first batch is the measurement instrument.** Do not
optimise against the numbers in section 4 — optimise against your own numbers once the first 10
posts have run. Section 4 exists to tell you roughly where the drop-off *should* be so you notice
when yours is somewhere else.

---

## 1. TikTok photo mode (carousels) — distribution, specs, conventions

### 1.1 Specs — HARD-ish (consistent across every source, and matches TikTok's own export behaviour)

| Spec | Value |
|---|---|
| Dimensions | **1080 × 1920 (9:16)** |
| Max photos per post | **35** |
| Recommended slide count | **5–10** |
| File format | JPG or PNG, RGB |
| Safe zone | Keep content out of roughly the top 120px, bottom 380px, right 160px — TikTok's UI (caption, username, action rail) overlays those |
| Text size | 28px+ at 1080-wide minimum for phone legibility |

Sources: [wavegen.ai](https://wavegen.ai/tiktok-slideshow-size), [OpenClip](https://openclip.app/learn/tiktok-slideshow-size), [AttentionClaw](https://www.attentionclaw.com/blog/tiktok-slideshow-limits-and-specs), [Moda](https://moda.app/resources/sizes/tiktok), [Metricool](https://metricool.com/tiktok-slideshow/).

The safe-zone numbers vary by ±40px between sources. The templates in `templates/` use a deliberately
conservative margin so a slide is legible under any of them.

### 1.2 Does photo mode out-distribute video? — ⚠️ FOLKLORE, but with a credible mechanism

The universally repeated claim is "**photo mode gets 5x the reach of video**"
([ReelBase](https://reelbase.io/blog/tiktok-photo-mode-algorithm-explained),
[ghostshorts](https://ghostshorts.com/blog/tiktok-photo-mode-algorithm-2026),
[instacarousel](https://instacarousel.com/blog/tiktok-carousel-photo-mode-2026/)). **No primary
source exists for that number.** Treat it as marketing for carousel tools.

What is more plausible, and is at least argued mechanistically rather than asserted:

- **Carousels accumulate more dwell time per impression.** A 10-second video watched twice is 20
  seconds. A 7-slide carousel that someone actually reads is 25–60 seconds
  ([influencers-time](https://www.influencers-time.com/carousel-style-tiktoks-why-slideshows-beat-video-on-watch-ti/)).
  Since watch time is a confirmed ranking input on both platforms (§2.1), this is a real edge, not
  an invented one.
- **Each swipe is an explicit engagement event.** Video gives the ranker one continuous signal;
  a carousel gives it N discrete ones.
- **Less saturated.** Most creators still default to video, so the carousel supply pool is smaller.

**Contested between sources:** one analysis of ~700,000 posts claims carousels get **81% more
engagement** but are **shared 33% less** than video. Shares are exactly the signal that drives cold
distribution to non-followers. So the honest read is: **carousels likely win on depth (saves, dwell,
profile visits), video likely wins on breadth (shares, cold reach)**. That is not a contradiction,
and it maps cleanly onto our goal — we want profile visits and link taps, not raw impressions. It
also means carousels are the *right* primary format for install intent even if the "5x" is fiction.

### 1.3 Audio — treat as mandatory

Claim: **photo mode without audio gets ~70% less reach** — ⚠️ FOLKLORE, untraceable. But every
source agrees on the direction, and the downside of attaching a sound is zero. **Always attach
audio.** See §1.4 for the Business-account catch, which is the real decision here.

### 1.4 🚨 THE SINGLE MOST IMPORTANT FINDING IN THIS DOCUMENT

**TikTok blocks App Store links from personal/creator account bios. Only Business accounts can link
to an app store page.** — **HARD.**

> "Personal creator accounts will no longer have the ability to link to app store pages. However,
> they will be able to link out to websites, as before."
> — TikTok, quoted in [TechCrunch, 2023-03-08](https://techcrunch.com/2023/03/08/tiktok-begins-blocking-links-to-app-store-pages-from-creators-bios/)

The block extends to Linktree and other link-in-bio services pointing at an app store. Business
accounts additionally get a "Download app" button.

**And here is the trap:** a TikTok **Business account is restricted to the Commercial Music Library**
(CML). The general Sound Library — i.e. every trending sound — is not shown, and **it is not a
toggle you can override**. Mainstream chart music is licensed in a way that excludes commercial use.
Sources: [TikTok's own CML user terms](https://www.tiktok.com/legal/page/global/commercial-music-library-user-terms/en),
[Soundstripe](https://www.soundstripe.com/blogs/why-can-i-only-use-commercial-sounds-on-tiktok),
[Status](https://brands.joinstatus.com/tiktok-commerical-music-library).

So the two things every guide tells you to do are **mutually exclusive on TikTok**:

| | Personal/Creator account | Business account |
|---|---|---|
| Trending sounds | ✅ full library | ❌ CML only (~1M tracks, indie/licensed-for-brands) |
| App Store link in bio | ❌ blocked | ✅ allowed, plus a "Download app" button |

**Recommendation: Business account.** Reasoning — the brief says *install conversion, not views*. An
account that cannot link to the App Store has no funnel at all; a trending-sound boost on a post
that dead-ends is worth nothing. The CML is over a million tracks and is perfectly adequate for
ambient/atmospheric backing under a text carousel, which is what our format needs anyway. We are not
doing a dance trend.

**The workaround if you want both** (documented, not recommended for batch 1 — it doubles the work
and splits the algorithm's read of your account): run the Business account as the linked home base,
and if a personal account is ever spun up for trending-sound content, it drives to the Business
profile by handle, not by link.

⚠️ **Verify this yourself before committing** — it's a 2023 policy and TikTok changes these. Concrete
test: on the account you intend to use, try to save `https://apps.apple.com/app/id6761696821` in the
profile Website field. If it saves and clicks through, the policy has loosened.

### 1.5 Bio link eligibility — contested

- Historically: personal accounts needed 1,000 followers for a clickable Website field.
- Several 2026 sources say TikTok **dropped the follower threshold in mid-2024** for personal
  accounts ([stan.store](https://stan.store/blog/tiktok-link-bio-requirements-2026-guide/), [UniLink](https://unil.ink/blog/tiktok-link-in-bio-requirements-2026)).
- Others still state the 1,000-follower rule as current ([socialrails](https://socialrails.com/blog/how-to-add-link-tiktok-bio-complete-guide)).

⚠️ **Genuinely contested.** Irrelevant if we go Business (no threshold either way), which is another
argument for Business.

### 1.6 Links in captions/comments — HARD

TikTok does not make URLs in captions or comments clickable, at all, for anyone. Bio is the only
outbound path. This is structural, not algorithmic — which also means the common fear that
"mentioning link in bio tanks your reach" has no mechanism behind it on TikTok
([Social Media Today](https://www.socialmediatoday.com/news/heres-each-big-social-platform-stand-external-links/733946/)).
Say "link in bio" freely.

---

## 2. Instagram — carousels vs Reels, and outbound links

### 2.1 Ranking signals — SOFT (widely and consistently attributed to Mosseri)

Three signals, in order:

1. **Watch time** — the dominant signal across surfaces.
2. **Sends per reach** (DM shares) — **the strongest signal for reaching non-followers.** Reported
   as carrying ~3–5× the weight of a like for cold distribution.
3. **Likes per reach** — still counts, weighted below the other two.

Sources: [dataslayer](https://www.dataslayer.ai/blog/instagram-algorithm-2025-complete-guide-for-marketers),
[Blck Alpaca](https://blckalpaca.at/en/knowledge-base/social-media/social-media-algorithms-distribution/instagram-algorithm-2026),
[Socialync](https://www.socialync.io/blog/adam-mosseri-shares-instagram-algorithm-2026).

**Actionable consequence, and it changes our copy:** the highest-leverage thing a slide can do on
Instagram is make someone *send the post to a specific person*. "Tag the person in your house who
asks what's for dinner" outperforms "save this" as a CTA for **reach**. Batch 1 should carry a
send-oriented prompt on at least one slide of every IG carousel. This is a cheap, testable edit and
it is the one place where IG strategy should diverge from TikTok.

Also reported: **Mosseri's Dec 2025 year-end memo emphasised rewarding "raw, real human content"
over AI-generated material through 2026.** ⚠️ unverified primary, but if directionally true it is
awkward for an AI app marketed with slick generated slides. Mitigation: batch 1's templates are
typographic, not AI-imagery; and real screen-recorded footage of Argus working should be the second
format we test (see CALENDAR.md).

### 2.2 Carousel vs Reel — SOFT, and the answer is "both, for different jobs"

- Buffer's 2026 analysis (**52M+ posts**): carousels get **+109% more engagement than Reels** on
  Instagram; carousels are the strongest format at **6.90% engagement**.
- Socialinsider's 2026 benchmark (**70M+ posts**): TikTok average engagement **3.70%**, up 49% YoY
  by one methodology; **2.60%** and down 10% YoY by another. Their own two figures disagree —
  a useful reminder of how soft this whole field is.
  ([Socialinsider](https://www.socialinsider.io/social-media-benchmarks), [IQFluence](https://iqfluence.io/public/blog/social-media-benchmarks))
- Repeated consensus: **Reels reach non-followers better; carousels engage existing followers
  better.** ([contentdrips](https://contentdrips.com/blog/2026/06/instagram-reels-vs-carousels-2026-guide/), [eclincher](https://www.eclincher.com/articles/how-the-instagram-algorithm-works-in-2026))
- One figure worth noting for us: above 50K followers carousels edge Reels on engagement (0.52% vs
  0.50%) and get **3–4× more saves**. We are nowhere near 50K, which means **on Instagram, from a
  cold account, Reels are the discovery mechanism and carousels are not.**

**Consequence for Argus, stated plainly:** the brief specifies carousels as the primary format. That
is well-matched to TikTok, where photo mode has genuine cold distribution. **It is a weaker fit for
Instagram from a zero-follower start.** The honest plan is: carousels are the production system (one
concept → both platforms, near-zero marginal cost), TikTok photo mode is where they're expected to
actually acquire, and Instagram gets the same carousels *plus* a Reel repurpose of the same slides
(Ken Burns pan over the PNGs, 12–18s) to get cold reach. The generator in `scripts/` emits the PNGs
either way; making a Reel from them is one extra step and is in CALENDAR.md.

### 2.3 Instagram link mechanics 2026 — HARD-ish

| Surface | Clickable? |
|---|---|
| **Bio** | ✅ up to **5 links**, each with a custom display title. Profile → Edit Profile → Links → Add External Link |
| **Story link sticker** | ✅ **all accounts, no follower minimum** (the old 10K rule is gone) |
| **DMs** | ✅ any pasted URL auto-links |
| **Feed/carousel caption** | ❌ plain text, not clickable |
| **Reels** | ❌ unless **Meta Verified** (Plus: 2 linked Reels/mo, Premium: 4, Max: 6) |

Sources: [Inrō](https://www.inro.social/blog/meta-verified-clickable-links-instagram-reels-pricing),
[itechguides](https://www.itechguides.com/5-ways-to-add-clickable-links-on-instagram-stories-bio-dms-video-posts-and-reels/),
[paperbell](https://paperbell.com/blog/how-to-add-a-link-to-instagram-posts/).

⚠️ A caption-links test for some Meta Verified subscribers was reported March 2026 but is **not a
general feature**. Don't plan around it.

**Consequence:** the IG funnel is `post → profile → bio link`, same as TikTok, with one extra lever
TikTok doesn't have — **the Story link sticker, available to us today with zero followers.** Every
carousel should be re-shared to Story with a link sticker on the same day. That is the shortest
path from impression to App Store we have on either platform, and it costs about 20 seconds.

**Also cheap and worth doing:** the comment-to-DM play. "Comment ARGUS and I'll send you the link" →
reply in DM with the App Store URL. DM links are clickable, it creates comment volume (a ranking
signal), and the DM itself is a send-shaped interaction. Manual at our volume; fine.

---

## 3. Hook patterns that convert for consumer AI apps

### 3.1 The structural rule — SOFT, unanimous

**The first 1.5 seconds / first slide decides watch-through.** Every source agrees. A slow intro is
the single most common failure. The hook must either state the payoff, state the problem, or create
a visual contradiction — and it must be legible in under one second, which means **short, high
contrast, one idea.**

### 3.2 What's actually working for AI/prosumer tools right now — SOFT

The most useful finding in this section, from an August 2026 report tracking AI prosumer tool
marketing on TikTok ([Lightreel](https://lightreel.ai/blogs/ai-prosumer-tools-on-tiktok)):

> AI prosumer marketing is shifting **from generic "save time with AI" claims toward concrete
> proof**. Replit, Gamma, Lovable and Figma generated clear momentum, while **creator-native
> demonstrations and controversy-led utility hooks consistently outperformed polished feature
> announcements.**

Unpacked into rules we can actually apply:

1. **Show the artefact, not the adjective.** "Argus read the label and caught the thing I'd have
   missed" beats "AI-powered vision assistant."
2. **Creator-native beats polished.** A slightly rough phone screenshot outperforms a designed
   mockup. This is a real tension with a consistent-brand-template system — resolved in
   `templates/` by keeping the *frame* branded and the *content* raw (real screenshots, real camera
   photos, real transcript text).
3. **Controversy-led utility hooks.** Not manufactured outrage — a mild, defensible contrarian
   claim: "Your phone camera has been able to do this for a year and nobody told you."
4. **Concrete proof > feature list.** Which is also the safest legally, and lines up with the
   "don't overclaim" constraint.

### 3.3 Hook phrasings named as effective — SOFT

From the TikTok growth playbooks ([Stackmatix](https://www.stackmatix.com/blog/tiktok-growth-strategies-2026),
[STORMY](https://stormy.ai/blog/tiktok-organic-strategy-viral-app-growth),
[SEM Nexus](https://semnexus.com/tiktok-organic-and-paid-a-2026-app-growth-playbook)):

- "Most people get this wrong…"
- "Here's the fastest way to X"
- Lead with **the surprising result**, **the relatable problem**, or **the visual contradiction**
- Formats that scale: **slideshows, B-roll + text overlay, screen recordings, story-based edits**

Note the qualifier on these playbooks: they are agency content-marketing, so the advice is generic
by construction. The Lightreel finding in §3.2 is more specific and more useful, and `HOOKS.md` is
built primarily on it.

### 3.5 Meme hooks — what makes one get shared (added 2026-10-07)

**Nobody publishes click data for meme hooks on slideshows.** Every page that claims to is a
carousel-tool vendor (§0). What exists is one academic study of the images, one meta-analysis of
humour in ads, a theory of why things are funny, and case studies. `memeHook` is therefore a
hypothesis: the test is our own slide-1 → slide-2 swipe rate against the pre-10-07 decks.

| Finding | Tier | What we do with it |
|---|---|---|
| Viral image memes are more likely to be a **close-up**, to contain a **character**, and to show a **clear positive or negative emotion**. Memes with **no clear subject** or **long text** are the ones that don't get re-shared. ([Ling et al., CSCW 2021](https://www.arxiv.org/pdf/2101.06535) — codebook built on 100 hand-annotated memes, classifier AUC 0.866, then picked 19 of the 20 most popular Twitter/Reddit memes of 2016–18. Sample is 4chan /pol/, so the visual findings transfer better than anything about content.) | **SOFT**, but the only peer-reviewed evidence there is | `MEME_STYLE`: tight close-up, one subject, one emotion. Caption ≤ 10 words asked, 12 enforced. |
| Humour's largest measured effects in advertising are on **attention** and **attitude toward the ad** — not on recall of the claim or on purchase. ([Eisend 2009 meta-analysis, 38 usable studies, via Marketing Week](https://marketingweek.com/three-ways-humour-helps-brands-sell)) | **SOFT** | The joke goes on slide 1 only, where attention is the whole job. The claim slides stay straight. |
| **Benign violation**: something is funny when it is wrong and harmless at the same moment. ([McGraw & Warren, CU Boulder Humor Research Lab](https://www.colorado.edu/today/node/34307)) | Theory, well supported | The joke is an overreaction — tiny stakes taken with total seriousness — and the photo is the punchline, never an illustration of the caption. |
| A slideshow-led app (Stronger, 700k users) opened on **a person in a situation plus a 2–4 word hook that is mildly contentious inside the niche** ("Grandpa was right", "Skipping legs…"). ([Shortimize](https://shortimize.com/blog/the-slideshow-strategy-that-generated-700000-users-in-275-days) — 725 posts, 11 over 1M views; no failure data, vendor blog.) | ⚠️ one case | Supports very short text over a face. Headline on a meme hook cut to ≤ 6 words. |
| "Posts with memes get 60% more engagement", "POV posts draw more comments per view", "under 8 words". | ⚠️ **FOLKLORE** — vendor blogs, no traceable dataset | The POV / "me:" / "nobody:" formats are used because they are instantly read as a joke, not because of these numbers. |

### 3.4 Format length — SOFT, and note it's about video not carousels

"Medium-length videos (20–40s) pull ~2M views on average with 4.06% engagement." ⚠️ The "2M average"
is not a credible average of anything. The 20–40s band is repeated widely enough to use as the
target length for the Reel repurpose in §2.2.

---

## 4. The funnel — where the drop-off actually is

This is the section the brief cares most about, so here is the honest version: **a complete,
end-to-end, sourced impression→install funnel for organic social does not exist in public data.**
Each stage is benchmarked by a different vendor, on a different population, with different
definitions. Chaining them produces a number with false precision. What follows is assembled from
the best available per-stage figures, with the joins flagged.

### 4.1 Per-stage benchmarks

| Stage | Rate | Confidence | Source |
|---|---|---|---|
| Impression → engagement (TikTok) | **2.6–4.9%** | SOFT — Socialinsider's own two methodologies disagree (3.70% vs 2.60%) | [Socialinsider](https://www.socialinsider.io/social-media-benchmarks), [WebFX](https://www.webfx.com/blog/social-media/tiktok-benchmarks/) |
| Impression → engagement (IG carousel) | **~6.9%** | SOFT — Buffer, 52M posts | [Buffer via IQFluence](https://iqfluence.io/public/blog/social-media-benchmarks) |
| **Profile view → bio link tap** | **3–8%** (>10% excellent) | SOFT | [Tapmy](https://tapmy.store/blog/link-in-bio-click-through-rate-benchmarks-by-platform-2026-data), [crescitaly](https://blog.crescitaly.com/tiktok-link-in-bio-strategy-profile-visits-sales-2026/) |
| TikTok in-feed ad CTR (proxy for tap intent) | **~0.84% avg**, >1% good | SOFT | [Lebesgue](https://lebesgue.io/tiktok-ads/tiktok-ads-benchmarks-for-ctr-cr-and-cpm) |
| **App Store page view → install (all traffic)** | **~25%** iOS | SOFT — AppTweak | [kirro](https://kirro.io/app-store-conversion-rate) |
| App Store tap-through → install | **33.4%** iOS | SOFT — AppTweak | [kirro](https://kirro.io/mobile-app-conversion-rate) |
| App Store page view → install (organic search) | **5–12%**, median ~8% | SOFT | [SEM Nexus](https://semnexus.com/app-store-conversion-funnel-impression-to-install-benchmarks-2026) |
| App Store page view → install (paid/referral) | **2–6%** | SOFT | same |

⚠️ **The 25% figure and the 5–12% figure are not compatible** and are both presented as "App Store
conversion rate." The 25% is almost certainly dominated by high-intent branded search (someone
typed the app's name); the 5–12% is generic keyword traffic. **Social referral behaves like the
low-intent bucket, not the high-intent one** — a viewer who tapped a link out of curiosity is
closer to a paid click than to someone searching your brand. **Plan on 5–12%, hope for more.**

### 4.2 The assembled funnel, per 10,000 TikTok impressions

Stated as a range, because a point estimate here would be fake:

| Step | Rate used | Remaining |
|---|---|---|
| Impressions | — | 10,000 |
| Swipe-through / engaged | 3–5% | 300–500 |
| → Profile visit | ~10–25% of engaged | 30–125 |
| → Bio link tap | 3–8% of profile views | **1–10** |
| → App Store page view | ~85–95% (some drop on redirect) | 1–9 |
| → Install | 5–12% | **0–1** |

**Read that bottom row carefully. At 10,000 impressions you should expect roughly 0–1 installs.**

That is not pessimism, it's arithmetic on published rates, and it is the most important number in
this document because it sets expectations correctly. **Organic social → app install is a
low-single-digit-per-10k business.** A post doing 50k views and producing 3 installs is a *normal*
outcome, not a failure.

### 4.3 Where the drop-off is, and therefore what the content must optimise

Multiply it out. The two stages that destroy the funnel are:

**① Profile visit → link tap (3–8%).** This is the worst multiplier in the chain and the one we
control most directly.
**② App Store page view → install (5–12%).** Second worst, and it is **not a content problem — it's
an App Store listing problem.** Screenshots, subtitle, first three lines of description.

The stages people obsess over — impressions, engagement rate — are the *best*-converting steps in
the chain and the least worth optimising.

**So, concretely, what batch 1 must do differently from generic advice:**

- **The CTA slide is not an afterthought, it is the product.** Most creators spend their effort on
  the hook and let the last slide say "link in bio 🔗". Given a 3–8% link-tap rate, the last slide
  deserves as much iteration as the first. Templates treat it as a first-class slide type with its
  own design.
- **Give a reason to tap that is specific to the post.** "Link in bio" converts worse than "it's
  free, iPhone only, link in bio" — the latter pre-qualifies and removes the two objections that
  cause a bounce on the App Store page (cost, platform).
- **Name the platform in the post.** iOS-only is a hard constraint (§6). An Android user who taps is
  a wasted tap *and* a frustrated person. Saying "iPhone" up front costs us the Android portion of
  the audience at the link-tap stage instead of at the App Store stage — which is strictly better,
  because it doesn't pollute our product-page conversion rate.
- **The hook's job is to earn the swipe; the body's job is to earn the profile visit; only the CTA's
  job is the tap.** A hook that triples views and doesn't move taps is a failure — the brief says
  this and the numbers back it.

### 4.4 The metric that actually matters

**Link taps per 1,000 impressions (LTPM)**, not views and not engagement rate. It is the first
metric in the chain that is downstream of everything we control and upstream of everything we don't.
`TRACKING.md` makes it the primary column.

---

## 5. Attribution — App Store campaign tokens

### 5.1 How it works — HARD (Apple's own docs)

Source: [Apple, "Campaign links"](https://developer.apple.com/help/app-store-connect-analytics/acquisition/campaign-links/), [SKStoreProductParameterCampaignToken](https://developer.apple.com/documentation/storekit/skstoreproductparametercampaigntoken)

Link shape:

```
https://apps.apple.com/app/apple-store/id6761696821?pt=<PROVIDER>&ct=<CAMPAIGN>&mt=8
```

| Param | Meaning |
|---|---|
| `pt` | **Provider token.** Identifies the developer account. Generated automatically the first time you create a campaign link in ASC. **You cannot make one up.** Same across all campaigns. |
| `ct` | **Campaign token.** Up to **30 alphanumeric characters and spaces**, plus `[ ] / \ - ~ + = <> : ; , . _ ' " * & $ % # @ ? ! \| { } ( )`. Cannot start or end with a space. |
| `mt` | Media type, `8` for apps. |

Where the data shows up: **App Analytics → Sources → Campaigns.**

### 5.2 🚨 Three limits that break this for us right now — HARD

1. > "The Campaigns tab and add button appear only after your app has generated analytics data."

   Argus has approximately one real user. **The Campaigns tab may not exist in ASC yet**, which
   means the provider token cannot be generated, which means campaign links cannot be built. **This
   is the first thing to check, and it is a prerequisite for the whole tracking plan.**

2. > "Minimum threshold of 5" — each metric needs at least 5 in the date range to display.

   Per §4.2 we expect 0–1 installs per 10k impressions. **Per-post `ct` tokens will almost
   certainly report nothing** for months. Apple also withholds or combines small rows for privacy.

3. **24-hour minimum** before a campaign appears, and the first-time-download attribution window is
   **24 hours from the click.**

### 5.3 What to actually do — the two-layer scheme

Because ASC attribution is blind below 5 events, **the per-post signal has to come from our own
redirect**, with `ct` as the second layer for when volume arrives.

**Layer 1 — our own redirect, per post (this is the real instrument).**
Every post gets a unique short URL that 302s to the App Store campaign link. The redirect is what
gives us a **per-post link-tap count** — the LTPM metric from §4.4 — at any volume, including one
tap. Options, cheapest first:

- **Argus's own backend.** `server.js` already serves `GET /privacy` and `GET /about` off Cloud Run.
  A `GET /g/:slug` route that logs the slug and 302s to the App Store link is ~15 lines, costs
  nothing, needs no third party, and the logs are already something we know how to read
  (`gcloud logging read`). **Recommended.** Not built in this pass — it's a backend change and the
  brief scoped this to the marketing pipeline — but it is the top item in `TRACKING.md`.
- A link-in-bio tool with per-link click analytics (Linktree/Stan/etc.) — works, adds a dependency,
  and on TikTok risks the app-store-link block in §1.4 applying to the *destination*.

**Layer 2 — `ct` tokens, grouped not per-post.** Given the threshold-of-5, do **not** mint a token
per post. Mint one per **hook angle per platform per month**, e.g. `tt-kitchen-2609`,
`ig-labelread-2609`. That aggregates enough events to clear the threshold while still answering the
question that matters: *which angle converts*.

**Naming convention** (fits the 30-char limit):

```
<platform>-<angle>-<YYMM>      e.g.  tt-fridge-2609   ig-fixit-2609
```

`TRACKING.md` holds the full scheme.

### 5.4 What we are NOT doing

No MMP (AppsFlyer/Adjust/Branch). They need an SDK in the app; the app has **no analytics SDK at
all** and its App Privacy declaration says **"Do you or your third-party partners collect data from
this app to track users?" → No**, which is why there's no ATT prompt. Adding an attribution SDK
would change that answer, require an ATT prompt, and mean re-doing the privacy nutrition label.
**Not worth it at this volume.** The redirect-counter approach adds nothing to the app and changes
no privacy answer.

---

## 6. Posting cadence and account warming

### 6.1 Warming a cold account — SOFT/⚠️, and note who's writing it

Almost all "account warming" content is written for **bulk/burner account operations** (clipping
farms, proxy sellers — `ipfoxy`, `duoplus`, `reel.farm`, `cut.pro`). Their advice is optimised
against *shadowban risk from automation*, which is not our situation: one real account, one real
person, real content. Discount it accordingly. The non-crazy parts:

- **7–14 day warm-up** before/while starting to post: use the app like a person — scroll, watch,
  like, follow accounts in the niche. Consistent with everything else known about cold-start
  ranking.
- **Max 1 post/day at the start.** Stated reason is worth repeating because it's mechanistic: the
  algorithm gives a new account a limited early test window, and **posting several times a day
  splits that window between your own uploads.**
- **A healthy first-post result on a warmed account is 150–300 views.** Useful expectation-setting —
  if post #1 does 200 views that is *normal*, not a failure.
- **Day 30** is roughly when you stop being a new account and start optimising.

Sources: [followr](https://followr.ai/blog/how-to-warm-up-your-social-media-account), [Ssemble](https://www.ssemble.com/blog/account-warmup-guide-2026), [TokPortal](https://www.tokportal.com/learn/account-warming-strategy-tiktok-instagram-brand-accounts).

### 6.2 Cadence once warm — SOFT

- **TikTok:** the app-growth playbooks converge on **3–5 organic posts/week from the brand account**
  as the floor for learning anything. One playbook frames it as: below ~20 pieces of content a week
  across organic + creator + paid, "neither side gets enough volume to learn"
  ([SEM Nexus](https://semnexus.com/tiktok-organic-and-paid-a-2026-app-growth-playbook)). That total
  is for funded UA teams; the **3–5/week brand-account number is the one that applies to us.**
- **Instagram:** Mosseri is cited as suggesting **~2 Reels + 3–5 feed posts per week.**

### 6.3 What that means for Argus

10 slideshows (batch 1) at 1/day = 10 days of TikTok. Cross-posted to IG, that's 10 IG carousels +
10 Stories. That lands almost exactly on "1/day during warm-up, 3–5/week after" if the first week is
daily and it eases to 4–5/week. `CALENDAR.md` lays out the dates.

---

## 7. Everything above, compressed into decisions

1. **TikTok Business account.** Non-negotiable — it's the only way to link to the App Store. Accept
   the Commercial Music Library; our format doesn't need chart music. (§1.4)
2. **Carousels are the production system; expect TikTok to be where they acquire.** On IG from zero
   followers, add a Reel repurpose of the same slides for cold reach. (§2.2)
3. **The CTA slide gets as much iteration as the hook slide.** Link tap is the worst multiplier in
   the funnel. (§4.3)
4. **Say "free" and "iPhone" in the post**, not on the App Store page. Qualify early. (§4.3)
5. **Every IG carousel gets a same-day Story with a link sticker.** Shortest impression→store path
   available to a zero-follower account. (§2.3)
6. **At least one slide per IG carousel carries a send-shaped CTA** ("send this to…"), because sends
   per reach is the cold-distribution signal. (§2.1)
7. **Build a `/g/:slug` redirect on the Argus backend before posting.** Without per-post tap counts
   this whole programme is unmeasurable, and ASC will report nothing at our volume. (§5.3)
8. **`ct` tokens per angle per platform per month, not per post.** Threshold of 5. (§5.3)
9. **Track LTPM (link taps per 1,000 impressions), not views.** (§4.4)
10. **Expect 0–1 installs per 10,000 impressions.** Set expectations now so a normal result doesn't
    read as a failure and trigger a strategy change that isn't warranted. (§4.2)

---

## 8. Open questions this research could not settle

| Question | Why it's open | How to close it |
|---|---|---|
| Is the TikTok app-store-link-in-bio block still live in 2026? | Only primary source is 2023 | Try saving the App Store URL in a Business profile Website field |
| Does the Campaigns tab exist in ASC for Argus yet? | Apple gates it on "analytics data" | Log into ASC → App Analytics → Sources |
| Does photo mode genuinely out-distribute video? | "5x" has no traceable source | Post 8 carousels + 2 Reels in batch 1; compare (CALENDAR.md builds this in) |
| Does the "raw human content > AI content" memo affect an AI app's posts? | Unverified primary, and self-referentially weird | Compare typographic-template posts vs real-screenshot posts within batch 1 |
| Real profile-visit rate from a carousel | No credible benchmark found at all | TikTok analytics reports it natively; measure from post 1 |
