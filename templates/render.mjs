/**
 * Argus slide templates — slide object -> HTML document.
 *
 * This file is the *design* half of the pipeline; scripts/make-slideshow.mjs is
 * the orchestration half. Editing a template here changes every post ever
 * regenerated, which is the point: one visual identity across the whole feed.
 *
 * Adding a slide type:
 *   1. add a case to renderStage()
 *   2. add its CSS under "slide type:" in theme.css
 *   3. add it to SLIDE_TYPES so validation accepts it
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SLIDE_TYPES = ["hook", "body", "quote", "list", "split", "cta"];

export const PLATFORMS = {
  tiktok:    { w: 1080, h: 1920, label: "TikTok photo mode 9:16" },
  instagram: { w: 1080, h: 1350, label: "Instagram carousel 4:5" },
};

/** Cached so a 100-slide batch reads the stylesheet once. */
let THEME = null;
function theme() {
  if (THEME === null) THEME = readFileSync(join(HERE, "theme.css"), "utf8");
  return THEME;
}

/* --------------------------------------------------------------------------
   escaping
   Copy is authored in JSON by a human, so it may contain & < > " and — via the
   *intentional* inline markup below — nothing else. Everything is escaped
   first, then a tiny allowlist is re-expanded:
       [[gold]]...[[/gold]]   emphasis in brand gold
       //                     line break
   -------------------------------------------------------------------------- */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rich(s) {
  return esc(s)
    .replace(/\[\[gold\]\]/g, '<span class="gold">')
    .replace(/\[\[\/gold\]\]/g, "</span>")
    .replace(/\s*\/\/\s*/g, "<br>");
}

/* --------------------------------------------------------------------------
   per-platform copy
   Any copy string may instead be { "tiktok": "…", "instagram": "…" }. Used
   where the platforms genuinely differ — the TikTok account is a personal
   one and cannot link to the App Store, so its CTA says "search My Argus"
   while Instagram's says "link in bio".
   -------------------------------------------------------------------------- */

const isPlatformMap = (v) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length > 0 && Object.keys(v).every((k) => k in PLATFORMS);

/** A slide (or any value) with every per-platform map resolved for `platform`. */
export function forPlatform(v, platform) {
  if (isPlatformMap(v)) return v[platform] ?? "";
  if (Array.isArray(v)) return v.map((x) => forPlatform(x, platform));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, forPlatform(x, platform)]));
  return v;
}

/* --------------------------------------------------------------------------
   furniture
   -------------------------------------------------------------------------- */

function topbar(slide, ctx) {
  const left = slide.eyebrow
    ? `<div class="eyebrow">${rich(slide.eyebrow)}</div>`
    : `<div class="mark"><span class="ring" style="--ring:44px"></span><span class="wordmark">Argus</span></div>`;
  // No swipe cue when the slides become a video (TikTok via the browser bot).
  const right = ctx.index === 0 && !ctx.noSwipe
    ? `<div class="swipe"><span>Swipe</span><span class="arrow">&rsaquo;</span></div>`
    : "";
  return `<div class="topbar">${left}${right}</div>`;
}

function footer(slide, ctx) {
  // The last slide is the CTA; a slide counter there competes with the ask.
  const counter = ctx.isLast ? "" : `<span>${String(ctx.index + 1).padStart(2, "0")} / ${String(ctx.total).padStart(2, "0")}</span>`;
  return `<div class="footer"><span class="handle">${esc(ctx.handle)}</span>${counter}</div>`;
}

/* --------------------------------------------------------------------------
   slide types
   -------------------------------------------------------------------------- */

function renderStage(slide) {
  switch (slide.type) {
    case "hook":
      return `
        ${slide.kicker ? `<div class="eyebrow">${rich(slide.kicker)}</div>` : ""}
        <h1 class="hook-head" data-fit>${rich(slide.headline)}</h1>
        ${slide.sub ? `<p class="sub">${rich(slide.sub)}</p>` : ""}`;

    case "body":
      return `
        ${slide.step ? `<div class="step">${rich(slide.step)}</div>` : ""}
        <h2 class="head" data-fit>${rich(slide.headline)}</h2>
        ${slide.body ? `<p class="body ${slide.wide ? "wide" : ""}">${rich(slide.body)}</p>` : ""}`;

    case "quote": {
      const turns = (slide.turns || [])
        .map((t) => `
          <div class="turn ${t.who === "argus" ? "argus" : "you"}">
            <span class="who">${esc(t.who === "argus" ? "Argus" : "You")}</span>
            ${rich(t.text)}
          </div>`)
        .join("");
      return `
        ${slide.headline ? `<h2 class="head" data-fit>${rich(slide.headline)}</h2><div class="rule"></div>` : ""}
        <div class="turns">${turns}</div>`;
    }

    case "list": {
      const items = (slide.items || [])
        .map((it, i) => {
          const text = typeof it === "string" ? it : it.text;
          const note = typeof it === "string" ? null : it.note;
          return `<div class="item">
            <span class="n">${String(i + 1).padStart(2, "0")}</span>
            <span class="t">${rich(text)}${note ? `<em>${rich(note)}</em>` : ""}</span>
          </div>`;
        })
        .join("");
      return `
        ${slide.headline ? `<h2 class="head" data-fit>${rich(slide.headline)}</h2><div class="rule"></div>` : ""}
        <div class="items">${items}</div>`;
    }

    case "split":
      return `
        ${slide.headline ? `<h2 class="head" data-fit>${rich(slide.headline)}</h2><div class="rule"></div>` : ""}
        <div class="panels">
          <div class="panel"><span class="tag">${esc(slide.beforeTag || "Before")}</span><div class="txt">${rich(slide.before)}</div></div>
          <div class="panel after"><span class="tag">${esc(slide.afterTag || "After")}</span><div class="txt">${rich(slide.after)}</div></div>
        </div>`;

    case "cta":
      return `
        <span class="ring"></span>
        <div class="wordmark-lg">Argus</div>
        <h2 class="head" data-fit>${rich(slide.headline)}</h2>
        ${slide.body ? `<p class="body">${rich(slide.body)}</p>` : ""}
        ${slide.pill ? `<div class="pill">${rich(slide.pill)}</div>` : ""}
        ${slide.fineprint ? `<p class="fineprint">${rich(slide.fineprint)}</p>` : ""}`;

    default:
      throw new Error(`unknown slide type "${slide.type}" (expected one of ${SLIDE_TYPES.join(", ")})`);
  }
}

/* --------------------------------------------------------------------------
   autofit
   Copy is written in a text editor, not a layout tool, so a headline that is
   four words too long would silently clip at the safe-zone edge. This shrinks
   any [data-fit] element, and then the stage as a whole, until it fits — so a
   long hook degrades into smaller type rather than into a cropped word.
   It runs in the page before the screenshot is taken.
   -------------------------------------------------------------------------- */

const AUTOFIT = `
(function () {
  function fits(el) { return el.scrollHeight <= el.clientHeight + 1; }
  var stage = document.querySelector('.stage');
  if (!stage) return;

  document.querySelectorAll('[data-fit]').forEach(function (el) {
    var size = parseFloat(getComputedStyle(el).fontSize);
    var floor = size * 0.58;
    while (size > floor && el.scrollWidth > el.clientWidth + 1) {
      size -= 2; el.style.fontSize = size + 'px';
    }
  });

  // Whole-stage overflow: walk every sized element down together so the
  // hierarchy between headline and body survives the shrink.
  var guard = 0;
  while (!fits(stage) && guard++ < 60) {
    stage.querySelectorAll('h1,h2,p,div,span').forEach(function (el) {
      var s = parseFloat(getComputedStyle(el).fontSize);
      el.style.fontSize = (s * 0.97) + 'px';
    });
  }
  document.documentElement.setAttribute('data-fit-done', guard > 0 ? String(guard) : '0');
})();`;

/* --------------------------------------------------------------------------
   document
   -------------------------------------------------------------------------- */

/**
 * @param {object} slide  one entry from a script's slides[]
 * @param {object} ctx    { platform, index, total, isLast, handle, safe, imageUrl? }
 *
 * imageUrl, when set, is a file:// URL to a generated photograph for this slide
 * (scripts/make-images.mjs). It sits full-bleed behind a scrim so the copy on
 * top stays legible — the image is atmosphere, never the message.
 */
export function renderPage(slide, ctx) {
  if (!PLATFORMS[ctx.platform]) throw new Error(`unknown platform "${ctx.platform}"`);
  slide = forPlatform(slide, ctx.platform);
  return `<!doctype html>
<html lang="en" data-platform="${ctx.platform}"${ctx.safe ? ' data-safe="1"' : ""}${ctx.imageUrl ? ' data-image="1"' : ""}>
<head>
<meta charset="utf-8">
<title>${esc(ctx.deckId || "argus")} ${ctx.index + 1}</title>
<style>${theme()}</style>
</head>
<body>
<div class="slide" data-type="${esc(slide.type)}">
  ${ctx.imageUrl ? `<img class="bgimg" src="${esc(ctx.imageUrl)}" alt=""><div class="scrim"></div>` : ""}
  ${topbar(slide, ctx)}
  <div class="stage">${renderStage(slide)}</div>
  ${footer(slide, ctx)}
</div>
<script>${AUTOFIT}</script>
</body>
</html>`;
}

export { esc, rich };
