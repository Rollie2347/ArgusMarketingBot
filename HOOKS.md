# Argus hook library

Every hook here is tied to a capability **verified in `backend/agents.js` on 2026-09-20**. The
verification table is at the bottom — read it before writing a new hook, and add to it rather than
inventing a feature.

**Rules that apply to every hook** (derived from `RESEARCH.md` §3, §4):

1. **One idea, legible in under a second.** If the hook slide needs two reads, it's not a hook.
2. **Concrete proof over adjectives.** The Lightreel finding: AI tool marketing that showed the
   artefact beat marketing that described the capability. Never write "AI-powered vision" — write
   the thing it saw.
3. **No privacy overclaim.** Argus streams camera and mic to Google's Gemini during a session and
   discloses this on an in-app consent screen required by Apple. Marketing must not contradict that.
   **Banned phrasings:** "stays on your phone", "never leaves your device", "fully private",
   "on-device AI", "nobody sees it but you". **Allowed, and true:** "no account, no password",
   "delete everything from inside the app", "it isn't recording — it's watching live". If a hook
   needs a privacy angle, the true one is **"no sign-up"**, not "no cloud".
4. **iPhone, and free, said out loud.** iOS-only is a hard constraint; qualifying early is a funnel
   improvement, not a cost (RESEARCH §4.3).
5. **Companion that sees your world, not a chatbot.** If a hook would work identically for ChatGPT,
   it is the wrong hook. The camera is the differentiator, so the camera goes in the hook.

---

## Angle A — Problem / solution

The relatable-problem opener. Works because the viewer self-identifies before they know it's an ad.
Highest-volume angle; also the easiest to make generic, so each one must name a *specific* moment.

| ID | Hook slide | Capability it pays off | Notes |
|---|---|---|---|
| **PS-01** | "Standing in front of an open fridge with no idea what to make" | `get_recipe_suggestion` + `identify_scene` | The single most universal Argus moment. Lead batch 1 with it. |
| **PS-02** | "I can't read this label and I'm not putting my glasses on" | `read_text` | Genuinely useful, zero-AI-hype framing. |
| **PS-03** | "Something under the sink is leaking and I don't know what I'm looking at" | `diagnose_problem` | High emotional stakes, high search intent. |
| **PS-04** | "Which of these two is actually the better buy" | `compare_products` | Supermarket aisle, holding two boxes. |
| **PS-05** | "I have told this app my allergy four times" | `remember_preference` + memory injection | Contrast hook — the problem *is* other AI apps. |
| **PS-06** | "Every recipe app wants me to type 14 ingredients in" | `get_recipe_suggestion` | The friction is typing. Argus's answer is: point the camera. |
| **PS-07** | "I forgot what I needed the second I got in the store" | `manage_shopping_list` (persists across sessions) | |
| **PS-08** | "What did I even eat today" | `get_daily_summary` + `log_daily_activity` | |

## Angle B — Demo the magic

No problem framing. Just show the thing working, in the fewest possible beats. Relies entirely on
the demo being genuinely surprising, so only use it where the capability is visually impressive.

| ID | Hook slide | Capability | Notes |
|---|---|---|---|
| **DM-01** | "I pointed my phone at my fridge and just talked" | `identify_scene` → `get_recipe_suggestion` | |
| **DM-02** | "It saw the burner was still on before I did" | real-time vision (intrinsic) + proactive prompt | ⚠️ Only claim this as *"it can notice things in frame"* — see verification table. Do not script a specific safety save. |
| **DM-03** | "Watch it read a label out loud" | `read_text` | |
| **DM-04** | "It found the restaurant, then read me the actual menu" | `find_places_nearby` → `research_place` | The chain is real and verified end-to-end against real restaurants. Strong, uncommon demo. |
| ~~**DM-05**~~ | ~~"I interrupted it mid-sentence and it just... stopped"~~ | — | ❌ **RETIRED 2026-09-20.** Not true: the #44 mic gate stops the client sending audio at all while Argus speaks, so you cannot cut it off mid-reply. Use DM-06. Never used in a deck. |
| **DM-06** | "No wake word. No button. I just talked." | intrinsic | |

## Angle C — Curiosity gap

Withhold the payoff until slide 2–3. Best swipe-through rates; worst if the payoff underdelivers.
Use sparingly — one per batch — because it trains the audience to expect a reveal.

| ID | Hook slide | Capability | Notes |
|---|---|---|---|
| **CG-01** | "Your iPhone camera has been able to do this for a year and nobody told you" | intrinsic | The mild, defensible contrarian claim from RESEARCH §3.2. Defensible because Gemini Live *is* ~a year old. |
| **CG-02** | "There's one thing every AI app gets wrong about your kitchen" | `get_recipe_suggestion` + dietary memory | Payoff: it suggests things you can't eat. |
| **CG-03** | "I asked it what was wrong with my bike. It didn't ask me to describe it." | `diagnose_problem` | Payoff is the *absence* of typing. |
| **CG-04** | "The reason you keep re-explaining yourself to AI" | `remember_preference` / `recall_memory` | Payoff: no persistent memory. |

## Angle D — Before / after

Two-column or two-beat structure. Converts well because the "after" *is* the product demo, so the
CTA is already earned by slide 3.

| ID | Hook slide | Capability | Notes |
|---|---|---|---|
| **BA-01** | "Before: typing 12 ingredients. After: pointing the camera." | `get_recipe_suggestion` | |
| **BA-02** | "Before: 'what was I allergic to again?' After: it already knew." | `remember_preference` | |
| **BA-03** | "Before: three apps to find dinner. After: one conversation." | `find_places_nearby` + `research_place` + `get_weather` | |
| **BA-04** | "Before: describing the broken thing. After: showing it." | `diagnose_problem` | The cleanest statement of the whole product thesis. |

## Angle E — "Things you didn't know your phone could do"

Listicle-shaped. Naturally multi-slide, so it fits the format better than any other angle, and it
front-loads breadth — good for a cold account where nobody knows what Argus is.

| ID | Hook slide | Capability | Notes |
|---|---|---|---|
| **TY-01** | "5 things I stopped Googling once my phone could see" | mixed | |
| **TY-02** | "Things I point my camera at now instead of typing" | mixed | |
| **TY-03** | "4 questions that are faster to *show* than to type" | `read_text`, `diagnose_problem`, `compare_products`, `get_recipe_suggestion` | |
| **TY-04** | "Every AI app I deleted, and the one I kept" | positioning | ⚠️ Comparative claim. Keep it to *"I deleted mine"*, first-person opinion — don't name competitors or state facts about them. |

## Angle F — Identity / niche

Not in the brief's list, but it's the cheapest way to find a beachhead audience, and it converts
harder than broad hooks because the viewer sees themselves. Worth one slot in batch 2.

| ID | Hook slide | Capability |
|---|---|---|
| **ID-01** | "If you cook for someone with an allergy, this is the one" | `remember_preference` + allergy injection into every session |
| **ID-02** | "For anyone who cannot read a nutrition label without squinting" | `read_text` |
| **ID-03** | "For people who ask 'what's the weather' and then don't listen" | `get_weather` |

---

## Hook construction formulas

When writing a new hook, use one of these shapes. They come from RESEARCH §3.3 plus the structural
constraint that the hook slide has ~8 words of legible space.

| Shape | Template | Example |
|---|---|---|
| Relatable moment | *\<physical situation\>, \<the frustration\>* | "Open fridge. No idea." |
| Surprising result first | *It \<did the thing\> before I \<did the normal thing\>* | "It read the label before I found my glasses." |
| Visual contradiction | *\<thing you'd never point a camera at\> + \<useful answer\>* | "I pointed my phone at a leak." |
| Mild contrarian | *\<widely held belief\> is wrong / is over* | "Typing at AI is over." |
| Absence | *No \<expected friction\>. No \<expected friction\>.* | "No wake word. No typing." |
| Numbered | *\<N\> \<things\> I stopped \<doing\>* | "5 things I stopped Googling." |

**Never** use: "Revolutionary", "game-changing", "powered by AI", "the future of", "you won't
believe". These are the patterns the Lightreel report identified as *under*performing — polished
feature announcements — and they also read as an ad instantly, which kills the swipe.

---

## CTA slide library

Given a 3–8% profile-visit→link-tap rate (RESEARCH §4.3), the CTA slide is the highest-leverage
slide in the deck, not the throwaway. Rotate these and track which converts.

| ID | CTA copy | Why |
|---|---|---|
| **CTA-01** | "Argus — free on iPhone. Link in bio." | Baseline. Both objections removed in six words. |
| **CTA-02** | "It's free, it's iPhone-only, and there's no sign-up. Link in bio." | Adds the true privacy-adjacent claim (no account) without overclaiming. |
| **CTA-03** | "Try it on the next thing you can't identify. Free, iPhone. Link in bio." | Gives a specific first action — reduces the "and then what" bounce on the store page. |
| **CTA-04** | "Send this to the person who asks you what's for dinner." | **Instagram only.** Send-shaped, targets sends-per-reach (RESEARCH §2.1). Pair with a bio-link line on the previous slide. |
| **CTA-05** | "Comment ARGUS and I'll DM you the link." | Generates comment volume; DM links are clickable on IG. Manual to fulfil — fine at this volume. |
| **CTA-06** | "Free on the App Store. No account, no password, delete everything in one tap." | Longest; best for the fix-it/label angles where trust is the objection. All three claims verified. |

---

## Capability verification table

Checked against `backend/agents.js` (the live `TOOLS` array and `handleToolCall` switch) and
`backend/server.js` on **2026-09-20**. **Only claim things marked ✅.**

| Marketing claim | Backing | Status |
|---|---|---|
| Sees through the camera live and answers about what's there | Live session streams JPEG frames to Gemini; `identify_scene` | ✅ |
| Natural spoken conversation, no wake word, no button | Continuous mic stream, server VAD | ✅ |
| You can interrupt it | The client stops sending mic audio entirely while Argus is speaking (#44), by design, to stop it interrupting itself. | ❌ **DO NOT CLAIM.** **You cannot cut Argus off mid-reply today.** Hardened 2026-09-20: the generator now refuses any deck containing "interrupt it", "cut it off", "talk over it" or "interrupt freely". The App Store description's "interrupt freely" line is corrected in `mobile/APP_STORE_LISTING.md` and still needs applying in ASC. **DM-05 is retired** — use DM-06 ("no wake word, no button"), which is the real differentiator and is true. |
| Suggests a recipe from what it sees in your fridge | `get_recipe_suggestion` (takes visible ingredients, honours dietary prefs) | ✅ |
| Reads labels, signs, documents out loud | `read_text` | ✅ |
| Diagnoses a visible broken thing and talks you through it | `diagnose_problem` | ✅ |
| Compares two products you're holding | `compare_products` | ✅ |
| Remembers your allergies / preferences across sessions | `remember_preference`, `forget_memory`, `recall_memory`; globals injected into every session's system instruction | ✅ |
| Remembers your name and the people in your life | `update_profile` → `people[]`, injected globally | ✅ |
| Persistent shopping list across sessions | `manage_shopping_list` (Firestore) | ✅ |
| Logs your day and recaps it | `log_daily_activity`, `get_daily_summary` | ✅ |
| Local weather for your actual location | `get_weather` (Open-Meteo) + IP geo + geocoded home city | ✅ |
| Finds real businesses near you with real distances | `find_places_nearby` (OpenStreetMap Overpass) | ✅ |
| Opens a restaurant's site and reads the actual menu | `research_place` (follows the menu link itself) | ✅ Verified against real restaurants in CLAUDE.md #47 |
| Reads a web page you point it at | `read_webpage` | ✅ |
| Speaks first when you connect | `greet` path in `server.js` | ✅ |
| **Sets a cooking timer that goes off** | `cooking_timer` stores an end time and reports remaining minutes **only when asked**. There is **no alarm, no notification, no proactive fire.** Also in-process memory — it does not survive an instance restart. | ❌ **DO NOT CLAIM.** "Set a timer and it'll tell you when it's done" is false. Allowed: "ask it how long is left on the pasta". |
| **Searches the web** | `web_search` and `research_topic` are **dormant** — no tool declaration points at them, so the model cannot call them. Both also call **Mojeek, which 403s from Cloud Run** (#52), so re-declaring them would ship a tool that reliably errors. Google Search grounding is enabled but **has never been observed firing**, and cannot be verified from a script: `server.js` accepts only `audio`/`greet`/`image` from clients, so nothing can make a session ask a factual question without a real device. | ❌ **DO NOT CLAIM.** **RESOLVED 2026-09-20: cut the claim, don't wire the tools up.** `mobile/APP_STORE_LISTING.md` is corrected and carries the full reasoning; the **live listing still needs the edit applied in ASC**. Demo the place lookups instead — `find_places_nearby`, `research_place`, `read_webpage` are real and verified. |
| Works in the background / while the screen is off | `staysActiveInBackground` is false; no WS keepalive | ❌ **DO NOT CLAIM.** |
| Android | No Android build exists | ❌ **DO NOT CLAIM.** |
| Anything about data staying on-device | Camera + mic stream to Google Gemini; disclosed on a mandatory consent screen | ❌ **DO NOT CLAIM.** See rule 3. |
| "No account, no password" | True — random on-device identifier, no sign-in | ✅ |
| "Delete everything from inside the app" | `DELETE /api/user/:userId` behind a per-device secret; wired to a settings screen | ✅ |
| Free | Assumed Free in `APP_STORE_LISTING.md`, flagged there as "confirm" | ⚠️ **Rollie: confirm pricing is set to Free in ASC before any post says "free".** Every CTA in batch 1 says it. |
