/**
 * Deck validation — shared by the renderer (make-slideshow.mjs) and the daily
 * deck writer (write-decks.mjs).
 *
 * Two levels:
 *
 *   validateDeck(deck, platforms)                   the structural checks and the
 *                                                   banned-phrase tripwire every
 *                                                   deck has always had
 *   validateDeck(deck, platforms, { strict: true }) adds the checks a HUMAN used
 *                                                   to do by hand when writing a
 *                                                   deck, because now a model
 *                                                   writes them unattended
 *
 * Strict mode is what stands between a language model and the real accounts.
 * It cannot prove a claim is true — it proves the deck only points at hooks,
 * CTAs and capabilities that HOOKS.md's verification table already marks ✅,
 * and that the copy fits on the slide. Rollie's approval in Telegram is still
 * the last check.
 */

import { readFileSync } from "node:fs";
import { SLIDE_TYPES, forPlatform } from "../templates/render.mjs";
import { HOOKS_FILE } from "./paths.mjs";

/* ==========================================================================
   the tripwire — every deck, hand-written or generated
   ========================================================================== */

// Tripwire for the claim classes that are actually dangerous — a live App
// Store listing already drifted out of sync with the build this way, which
// is what this list exists to stop happening to the marketing copy too.
// NOT a substitute for HOOKS.md's verification table: that is checked by
// hand against backend/agents.js, and this only catches known phrasings.
export const BANNED = [
  // Platform
  ["android", "iOS-only (hard constraint)"],
  ["google play", "iOS-only"],
  ["play store", "iOS-only"],

  // Privacy. Camera + mic stream to Google's Gemini during a session and
  // Apple requires an in-app consent screen saying so (#26). Marketing that
  // contradicts that disclosure is the one claim class that can cost a
  // rejection AND a trust problem at the same time.
  ["on-device", "privacy overclaim — frames/audio stream to Gemini"],
  ["on device ai", "privacy overclaim"],
  ["stays on your phone", "privacy overclaim"],
  ["never leaves your", "privacy overclaim"],
  ["fully private", "privacy overclaim"],
  ["completely private", "privacy overclaim"],
  ["end-to-end encrypted", "false — there is no E2EE claim the build supports"],
  ["we don't see", "unverifiable and unnecessary; say \"no account, no password\" instead"],
  ["nobody sees it", "privacy overclaim (HOOKS.md rule 3)"],

  // cooking_timer stores an end time and reports remaining minutes only when
  // asked. No alarm, no notification, no proactive fire, and the Map is
  // in-process so it does not survive an instance restart.
  ["timer goes off", "cooking_timer has no alarm (HOOKS.md verification table)"],
  ["timer will go off", "cooking_timer has no alarm"],
  ["tell you when it's done", "cooking_timer has no alarm — it only answers when asked"],
  ["remind you when", "there are no notifications of any kind in the app"],
  ["notify you", "no push notifications exist"],

  // web_search / research_topic are dormant (no declaration points at them)
  // and both depend on Mojeek, which 403s from Cloud Run. Google Search
  // grounding is enabled but has never been observed firing.
  ["searches the web", "web_search is dormant; grounding unproven"],
  ["search the web", "web_search is dormant; grounding unproven"],
  ["web search", "web_search is dormant; grounding unproven"],
  ["google anything", "no general web search ships today"],
  ["look anything up", "no general web search ships today"],

  // The #44 mic gate suppresses mic sends while Argus is speaking, by
  // design, to stop it interrupting itself. Barge-in mid-reply does not work.
  ["interrupt it", "the #44 mic gate means you cannot cut Argus off mid-reply"],
  ["cut it off", "the #44 mic gate means you cannot cut Argus off mid-reply"],
  ["talk over it", "the #44 mic gate means you cannot cut Argus off mid-reply"],
  ["interrupt freely", "the #44 mic gate means you cannot cut Argus off mid-reply"],

  // staysActiveInBackground is false and there is no WS keepalive.
  ["in the background", "staysActiveInBackground is false — no background operation"],
  ["while your screen is off", "no background operation"],
  ["always listening", "sessions are explicit and foreground-only; also a bad privacy claim"],

  // Pricing/claims that are not ours to make.
  ["better than chatgpt", "comparative factual claim about another product"],
  ["better than siri", "comparative factual claim about another product"],

  // HOOKS.md "never use" list — reads as an ad instantly and underperforms.
  ["revolutionary", "HOOKS.md never-use list"],
  ["game-changing", "HOOKS.md never-use list"],
  ["game changer", "HOOKS.md never-use list"],
  ["powered by ai", "HOOKS.md never-use list"],
  ["the future of", "HOOKS.md never-use list"],
  ["you won't believe", "HOOKS.md never-use list"],
];

/* ==========================================================================
   strict-mode inputs
   ========================================================================== */

/** HOOKS.md angle heading → deck `angle` value and campaign-token prefix. */
export const ANGLES = {
  "problem-solution":      { code: "ps", prefix: "PS" },
  "demo-the-magic":        { code: "dm", prefix: "DM" },
  "curiosity-gap":         { code: "cg", prefix: "CG" },
  "before-after":          { code: "ba", prefix: "BA" },
  "things-you-didnt-know": { code: "ty", prefix: "TY" },
  "identity":              { code: "id", prefix: "ID" },
};

/**
 * Tools HOOKS.md's verification table marks ✅, plus "intrinsic" for the
 * live camera + voice loop itself. Deliberately absent:
 *   cooking_timer          — real, but its only honest claim ("ask how long is
 *                            left") is too easy to overstate unattended
 *   web_search, research_topic — dormant, ❌ DO NOT CLAIM
 *   mark_profile_reviewed  — internal bookkeeping, not a feature
 * test/pipeline.test.mjs checks every name here still exists in
 * backend/agents.js, so a renamed tool fails loudly instead of silently.
 */
export const VERIFIED_CAPABILITIES = [
  "intrinsic",
  "identify_scene", "read_text", "get_recipe_suggestion", "diagnose_problem", "compare_products",
  "remember_preference", "forget_memory", "recall_memory", "update_profile",
  "manage_shopping_list", "log_daily_activity", "get_daily_summary",
  "get_weather", "find_places_nearby", "research_place", "read_webpage",
];

/**
 * Hook and CTA ids from HOOKS.md. A table row counts only if it starts
 * `| **XX-NN** |` — a retired hook is struck through (`~~**DM-05**~~`) and
 * therefore never matches.
 */
export function readHookLibrary(file = HOOKS_FILE) {
  const md = readFileSync(file, "utf8");
  const hooks = new Map();
  const ctas = new Map();
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*\*\*([A-Z]{2,3}-\d{2})\*\*\s*\|\s*(.+?)\s*\|/);
    if (!m) continue;
    (m[1].startsWith("CTA-") ? ctas : hooks).set(m[1], m[2].replace(/^"|"$/g, ""));
  }
  return { hooks, ctas };
}

/** Plain text of a copy string: inline markup stripped, `//` as a space. */
export const plain = (s) => String(s ?? "").replace(/\[\[\/?gold\]\]/g, "").replace(/\s*\/\/\s*/g, " ").trim();
const words = (s) => plain(s).split(/\s+/).filter(Boolean).length;

/**
 * Copy ceilings: the longest copy the hand-written batch-1 decks carry, which
 * autofit already renders legibly. _SCHEMA.md's "comfortable" numbers are the
 * target the writer is prompted with; these are the hard stop past which the
 * type shrinks to where nobody reads it at arm's length.
 */
const CEILINGS = {
  hookHeadline: 14,
  headline: 12,
  body: 32,
  turn: 32,
  turns: 4,
  listItems: 5,
};

/**
 * Generated images are mood photographs, never product shots. A generated
 * phone screen or app UI would be a fabricated demo of Argus — the one thing
 * this pipeline must never publish — and image models also garble lettering.
 */
const IMAGE_PROMPT_BANNED = /\b(argus|apps?|ui|interface|screenshots?|screens?|displays?|logos?|text|captions?|words?|letters?|typography|brand(ed|ing)?)\b/i;

/* ==========================================================================
   validateDeck
   ========================================================================== */

/**
 * Platforms whose account cannot link to the App Store from its bio.
 * config.json `tiktokAccount: "personal"` → ["tiktok"]: TikTok blocks App
 * Store links for personal accounts (RESEARCH §1.4), so "link in bio" on a
 * TikTok post would send viewers to a link that isn't there.
 */
export function noBioLinkPlatforms(config) {
  return config?.tiktokAccount === "personal" ? ["tiktok"] : [];
}

const BIO_LINK = /\b(in|on) (my |the |our )?bio\b|\bbio link\b|\blink below\b/i;

/**
 * @param {object}   opts
 * @param {boolean}  opts.strict      the generated-deck checks
 * @param {string[]} opts.noBioLink   platforms whose copy must not point to a bio link
 * @returns {string[]} human-readable errors; empty means valid
 */
export function validateDeck(deck, platforms, { strict = false, library = null, noBioLink = [] } = {}) {
  const e = [];
  const need = (cond, msg) => { if (!cond) e.push(msg); };

  need(deck.angle, "missing `angle`");
  need(deck.hookId, "missing `hookId` (must exist in HOOKS.md)");
  need(Array.isArray(deck.capabilities) && deck.capabilities.length,
       "missing `capabilities` — list the verified backend/agents.js tools this deck claims");
  need(deck.ct, "missing `ct` (campaign token base — angle + month, see TRACKING.md)");
  // A 3-char platform suffix is appended at link time; Apple's cap is 30.
  need(deck.ct && deck.ct.length <= 27, `ct "${deck.ct}" is ${deck.ct?.length} chars; max 27 (a "-tt"/"-ig" suffix is appended, Apple caps at 30)`);

  const s = deck.slides ?? [];
  // 5–10 slides is the published sweet spot (RESEARCH §1.1); the brief asks for
  // hook + 4–7 body + CTA, which lands in 6–9.
  need(s.length >= 6 && s.length <= 9, `has ${s.length} slides; want 6–9 (hook + 4–7 body + CTA)`);
  need(s[0]?.type === "hook", "first slide must be type `hook`");
  need(s.at(-1)?.type === "cta", "last slide must be type `cta`");
  s.forEach((sl, i) => {
    need(SLIDE_TYPES.includes(sl.type), `slide ${i + 1}: unknown type "${sl.type}"`);
    if (sl.type === "quote") need(sl.turns?.length, `slide ${i + 1}: quote needs turns[]`);
    if (sl.type === "list") need(sl.items?.length, `slide ${i + 1}: list needs items[]`);
    if (sl.type === "split") need(sl.before && sl.after, `slide ${i + 1}: split needs before and after`);
    if (sl.image !== undefined) {
      need(sl.image && typeof sl.image.prompt === "string" && sl.image.prompt.trim().length >= 12,
           `slide ${i + 1}: image needs a descriptive \`prompt\``);
      const hit = String(sl.image?.prompt || "").match(IMAGE_PROMPT_BANNED);
      need(!hit, `slide ${i + 1}: image prompt mentions "${hit?.[0]}" — generated images must be plain photographs: no app, no screens, no text, no logos`);
    }
  });

  for (const p of platforms) {
    need(deck.caption?.[p], `missing caption.${p}`);
    need(deck.hashtags?.[p]?.length, `missing hashtags.${p}`);
  }

  // Image prompts are not published copy, so they are left out of the
  // phrase scan (a prompt may legitimately describe "a leaking pipe in the
  // background").
  const prose = JSON.stringify({ ...deck, slides: s.map(({ image, ...rest }) => rest) }).toLowerCase();
  for (const [needle, why] of BANNED) {
    if (prose.includes(needle)) e.push(`banned phrase "${needle}" — ${why}`);
  }

  for (const p of noBioLink.filter((x) => platforms.includes(x))) {
    const text = JSON.stringify(forPlatform(s.map(({ image, ...rest }) => rest), p));
    if (BIO_LINK.test(text)) e.push(`${p} slides point to a bio link, but the ${p} account can't link to the App Store — give that field a per-platform value, e.g. {"${p}": "Search “My Argus” on the App Store", "instagram": "Link in bio"}`);
    if (BIO_LINK.test(deck.caption?.[p] || "")) e.push(`caption.${p} points to a bio link, but the ${p} account can't link to the App Store — tell viewers to search "My Argus" on the App Store`);
  }

  if (strict) {
    // Copy ceilings apply to what each platform actually shows.
    const lib = library ?? readHookLibrary();
    for (const p of platforms.length ? platforms : [null]) {
      const view = p ? { ...deck, slides: forPlatform(s, p) } : deck;
      for (const err of strictChecks(view, lib)) if (!e.includes(err)) e.push(err);
    }
  }
  return e;
}

function strictChecks(deck, { hooks, ctas }) {
  const e = [];
  const need = (cond, msg) => { if (!cond) e.push(msg); };

  const angle = ANGLES[deck.angle];
  need(angle, `angle "${deck.angle}" is not one of ${Object.keys(ANGLES).join(", ")}`);
  need(hooks.has(deck.hookId), `hookId "${deck.hookId}" is not a live hook in HOOKS.md`);
  if (angle && deck.hookId) need(deck.hookId.startsWith(`${angle.prefix}-`), `hookId "${deck.hookId}" does not belong to angle "${deck.angle}" (expected ${angle.prefix}-NN)`);
  need(ctas.has(deck.ctaId), `ctaId "${deck.ctaId}" is not in HOOKS.md's CTA library`);

  for (const c of deck.capabilities ?? []) {
    need(VERIFIED_CAPABILITIES.includes(c), `capability "${c}" is not on the verified list — only claim ✅ rows of HOOKS.md's verification table`);
  }

  (deck.slides ?? []).forEach((sl, i) => {
    const n = `slide ${i + 1}`;
    if (sl.type === "hook") need(words(sl.headline) <= CEILINGS.hookHeadline, `${n}: hook headline is ${words(sl.headline)} words; max ${CEILINGS.hookHeadline}`);
    else if (sl.headline) need(words(sl.headline) <= CEILINGS.headline, `${n}: headline is ${words(sl.headline)} words; max ${CEILINGS.headline}`);
    if (sl.body) need(words(sl.body) <= CEILINGS.body, `${n}: body is ${words(sl.body)} words; max ${CEILINGS.body}`);
    for (const t of sl.turns ?? []) need(words(t.text) <= CEILINGS.turn, `${n}: a quote turn is ${words(t.text)} words; max ${CEILINGS.turn}`);
    if (sl.turns) need(sl.turns.length <= CEILINGS.turns, `${n}: ${sl.turns.length} quote turns; max ${CEILINGS.turns}`);
    if (sl.items) need(sl.items.length <= CEILINGS.listItems, `${n}: ${sl.items.length} list items; max ${CEILINGS.listItems}`);
  });

  // Caption limits: TikTok photo descriptions cap at 4000, IG captions at
  // 2200 and 30 hashtags. Well under both is the norm; this is the hard stop.
  if (deck.caption?.instagram) need(deck.caption.instagram.length <= 2000, `caption.instagram is ${deck.caption.instagram.length} chars; max 2000`);
  if (deck.caption?.tiktok) need(deck.caption.tiktok.length <= 2000, `caption.tiktok is ${deck.caption.tiktok.length} chars; max 2000`);
  for (const [p, tags] of Object.entries(deck.hashtags ?? {})) {
    need(tags.length <= 15, `hashtags.${p} has ${tags.length}; max 15`);
    for (const t of tags) need(/^#?[\p{L}\p{N}_]+$/u.test(t), `hashtags.${p}: "${t}" is not a single hashtag`);
  }

  return e;
}
