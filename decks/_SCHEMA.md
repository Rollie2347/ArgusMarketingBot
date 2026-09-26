# Deck file schema

One JSON file per slideshow, in `decks/`. Filename (minus `.json`) is the deck id and is used for
the output folder and the per-post redirect slug, so keep it short, lowercase and stable —
**renaming a deck after it's posted orphans its click data.**

```jsonc
{
  "title": "Human-readable, for POST.md only",
  "angle": "problem-solution",        // must match an angle heading in HOOKS.md
  "hookId": "PS-01",                  // must exist in HOOKS.md
  "ctaId": "CTA-01",                  // must exist in HOOKS.md's CTA library
  "capabilities": ["get_recipe_suggestion"],   // tools in backend/agents.js this deck claims
  "ct": "tt-kitchen-2609",            // campaign token, ≤30 chars, see TRACKING.md

  "slides": [ /* 6–9 of them: hook first, cta last */ ],

  "caption":  { "tiktok": "…", "instagram": "…" },
  "hashtags": { "tiktok": ["…"], "instagram": ["…"] }
}
```

## Inline markup, usable in any copy string

| Syntax | Effect |
|---|---|
| `[[gold]]…[[/gold]]` | emphasis in brand gold |
| `//` | forced line break |

Everything else is escaped. There is no raw HTML.

## Slide types

```jsonc
{ "type": "hook",  "kicker": "eyebrow line", "headline": "the hook", "sub": "optional" }

{ "type": "body",  "step": "01", "headline": "…", "body": "…", "wide": false }

{ "type": "quote", "headline": "optional",
  "turns": [ { "who": "you",   "text": "what's in here?" },
             { "who": "argus", "text": "eggs, a lemon, half a bunch of parsley…" } ] }

{ "type": "list",  "headline": "optional",
  "items": [ "plain string", { "text": "with a", "note": "sub-line" } ] }

{ "type": "split", "headline": "optional",
  "beforeTag": "Before", "before": "…",
  "afterTag":  "After",  "after":  "…" }

{ "type": "cta",   "headline": "…", "body": "…", "pill": "Free on the App Store",
  "fineprint": "…" }
```

## Validation the generator enforces

- 6–9 slides; slide 1 is `hook`; last slide is `cta`
- `angle`, `hookId`, `capabilities`, `ct` all present; `ct` ≤ 30 chars
- a caption **and** hashtags for every platform being rendered
- a banned-phrase tripwire for the claim classes that actually matter: Android, any
  on-device/privacy overclaim, "timer goes off" (`cooking_timer` has no alarm), "searches the web"
  (`web_search` is dormant). **This is a tripwire, not a substitute for HOOKS.md's verification
  table** — check every new claim against `backend/agents.js` by hand.

Run `node scripts/make-slideshow.mjs --check` to validate without rendering.

## Copy length

Autofit shrinks type until it fits rather than clipping, so nothing breaks — but a headline that
has been shrunk to 60% is a headline nobody reads at arm's length. Rough ceilings that stay at full
size:

| Field | Comfortable |
|---|---|
| `hook.headline` | ≤ 8 words |
| `body.headline` | ≤ 10 words |
| `body.body` | ≤ 26 words |
| `quote.turns[].text` | ≤ 24 words, 2–3 turns per slide |
| `list.items` | 3–5 items |

Render with `--safe` to draw the platform safe zones and eyeball the margins.
