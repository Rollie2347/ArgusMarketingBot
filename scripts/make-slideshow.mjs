#!/usr/bin/env node
/**
 * Argus slideshow generator.
 *
 *   node scripts/make-slideshow.mjs                       # every deck, every platform
 *   node scripts/make-slideshow.mjs 01-fridge-stare       # one deck
 *   node scripts/make-slideshow.mjs --platform tiktok     # one platform
 *   node scripts/make-slideshow.mjs --safe                # draw safe-zone guides
 *   node scripts/make-slideshow.mjs --fallback            # one Chrome per slide (slow, no CDP)
 *   node scripts/make-slideshow.mjs --check               # validate decks, render nothing
 *
 * Input   decks/<id>.json        (see decks/_SCHEMA.md)
 * Output  out/<id>/<platform>/01.png … NN.png
 *         out/<id>/<platform>/_html/NN.html   (the exact markup screenshotted)
 *         out/<id>/POST.md                    (captions, hashtags, link, checklist)
 *         out/<id>/manifest.json
 *
 * Rendering is headless Chrome driven over the DevTools protocol. Chrome's
 * `--screenshot` CLI flag only takes one shot per launch, which at ~2.5s of
 * process start per slide is ~7 minutes for a 10-deck batch; one persistent
 * browser does the same work in well under a minute. `--fallback` is the CLI
 * path, kept because it has no moving parts and is the thing to reach for if a
 * Chrome update ever breaks the CDP handshake.
 *
 * No npm dependencies, deliberately: this has to still run in a year.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { renderPage, PLATFORMS, SLIDE_TYPES, esc } from "../templates/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DECKS = join(ROOT, "decks");
const OUT = join(ROOT, "out");

/* ==========================================================================
   args
   ========================================================================== */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OPTS = {
  safe: flag("safe"),
  fallback: flag("fallback"),
  check: flag("check"),
  platforms: opt("platform", null)?.split(",").map((s) => s.trim()) ?? null,
  only: argv.filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--platform"),
};

const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
const platforms = OPTS.platforms ?? config.platforms;

for (const p of platforms) {
  if (!PLATFORMS[p]) die(`unknown platform "${p}" — expected one of ${Object.keys(PLATFORMS).join(", ")}`);
}

function die(msg) { console.error(`\n  ✗ ${msg}\n`); process.exit(1); }

/* ==========================================================================
   deck loading + validation
   Validation is strict on purpose. A deck that renders a clipped headline or
   a missing CTA is worse than one that refuses to render, because the former
   gets posted.
   ========================================================================== */

function loadDecks() {
  if (!existsSync(DECKS)) die(`no decks/ directory at ${DECKS}`);
  let files = readdirSync(DECKS).filter((f) => f.endsWith(".json")).sort();
  if (OPTS.only.length) {
    const wanted = new Set(OPTS.only.map((s) => s.replace(/\.json$/, "")));
    files = files.filter((f) => wanted.has(basename(f, ".json")));
    if (!files.length) die(`no deck matched ${[...wanted].join(", ")}`);
  }
  return files.map((f) => {
    const deck = JSON.parse(readFileSync(join(DECKS, f), "utf8"));
    deck.id ??= basename(f, ".json");
    return deck;
  });
}

function validate(deck) {
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
  });

  for (const p of platforms) {
    need(deck.caption?.[p], `missing caption.${p}`);
    need(deck.hashtags?.[p]?.length, `missing hashtags.${p}`);
  }

  // Tripwire for the claim classes that are actually dangerous — a live App
  // Store listing already drifted out of sync with the build this way, which
  // is what this list exists to stop happening to the marketing copy too.
  // NOT a substitute for HOOKS.md's verification table: that is checked by
  // hand against backend/agents.js, and this only catches known phrasings.
  const prose = JSON.stringify(deck).toLowerCase();
  const banned = [
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
  ];
  for (const [needle, why] of banned) {
    if (prose.includes(needle)) e.push(`banned phrase "${needle}" — ${why}`);
  }

  return e;
}

/* ==========================================================================
   Chrome
   ========================================================================== */

function findChrome() {
  if (process.env.ARGUS_CHROME) return process.env.ARGUS_CHROME;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) die("no Chrome/Edge found — set ARGUS_CHROME to a browser binary");
  return hit;
}

const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--force-color-profile=srgb",
  "--disable-lcd-text",          // greyscale AA: subpixel fringing is visible on a dark bg
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--mute-audio",
];

/* ---- CDP over one persistent browser ------------------------------------ */

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(`${m.error.message} (${m.error.code})`)) : res(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) || []).forEach((fn) => fn(m.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method} timed out`)); }, 30_000);
    });
  }
  once(method) {
    return new Promise((res) => {
      const list = this.handlers.get(method) || [];
      const fn = (p) => { this.handlers.set(method, (this.handlers.get(method) || []).filter((f) => f !== fn)); res(p); };
      this.handlers.set(method, [...list, fn]);
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }
}

async function launchBrowser() {
  const profile = join(tmpdir(), `argus-slides-${process.pid}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const proc = spawn(findChrome(), [
    ...CHROME_FLAGS,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });

  // Chrome writes the chosen port to DevToolsActivePort once it is listening.
  const portFile = join(profile, "DevToolsActivePort");
  let port = null;
  for (let i = 0; i < 120 && port === null; i++) {
    await sleep(100);
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (first) port = first;
    }
  }
  if (!port) { proc.kill(); throw new Error("Chrome never reported a DevTools port"); }

  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await Cdp.open(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await Cdp.open(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await page.send("Page.enable");

  return {
    page,
    async close() {
      try { await browser.send("Browser.close"); } catch { proc.kill(); }
      // Windows holds locks on the profile for a moment after the process
      // exits, so this is best-effort: a leftover temp dir is not worth
      // failing a render that already succeeded.
      for (let i = 0; i < 10; i++) {
        try { rmSync(profile, { recursive: true, force: true }); return; }
        catch { await sleep(200); }
      }
    },
  };
}

async function shotCdp(page, htmlPath, w, h) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url: pathToFileURL(htmlPath).href });
  await loaded;
  // Fonts resolve asynchronously; screenshotting before they land renders the
  // fallback face and silently changes every measurement autofit just made.
  await page.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  return Buffer.from(data, "base64");
}

/* ---- fallback: one Chrome process per slide ------------------------------ */

function shotCli(htmlPath, pngPath, w, h) {
  return new Promise((res, rej) => {
    const p = spawn(findChrome(), [
      ...CHROME_FLAGS,
      `--window-size=${w},${h}`,
      `--screenshot=${pngPath}`,
      pathToFileURL(htmlPath).href,
    ], { stdio: "ignore" });
    p.on("exit", (code) => (existsSync(pngPath) ? res() : rej(new Error(`chrome exited ${code} without writing ${pngPath}`))));
  });
}

/* ==========================================================================
   post copy
   ========================================================================== */

/** Short platform suffix. Kept out of the deck file so a deck stays platform-neutral. */
const PLATFORM_TAG = { tiktok: "tt", instagram: "ig" };

/**
 * Two layers, per RESEARCH.md §5.3:
 *   bio   — our own redirect, slugged per deck AND per platform. This is the
 *           only thing that yields a per-post tap count at our volume.
 *   store — the App Store campaign link. `ct` is deliberately the deck's ANGLE
 *           + month, not the deck id, so several posts aggregate into one token
 *           and clear Apple's minimum-of-5 reporting threshold.
 */
function linkFor(deck, platform) {
  const { appStoreUrl, providerToken, redirectBase } = config;
  const ct = `${deck.ct}-${PLATFORM_TAG[platform]}`;
  const store = providerToken
    ? `${appStoreUrl}?pt=${providerToken}&ct=${encodeURIComponent(ct)}&mt=8`
    : appStoreUrl;
  const bio = redirectBase ? `${redirectBase}/${deck.id}-${PLATFORM_TAG[platform]}` : null;
  return { ct, store, bio, tracked: Boolean(providerToken), counted: Boolean(bio) };
}

/**
 * Every platform, not just the ones this run rendered. POST.md is the
 * permanent record for a post and a `--platform tiktok` re-render must not
 * silently drop the Instagram half of it.
 */
function linksFor(deck) {
  return Object.fromEntries(Object.keys(PLATFORM_TAG).map((p) => [p, linkFor(deck, p)]));
}

/** Per-platform posting checklist. The items are the ones that are easy to get
 *  wrong and expensive to discover afterwards, not a generic to-do list. */
const CHECKLIST = {
  tiktok: (deck) => [
    "Posted from the **Business** account (personal accounts cannot link to App Store pages — RESEARCH §1.4)",
    "Sound attached from the **Commercial Music Library** (business accounts have no access to trending sounds)",
    `Slides uploaded in order from \`out/${deck.id}/tiktok/\``,
    "Bio link set to the redirect URL above",
  ],
  instagram: (deck) => [
    `Carousel posted from \`out/${deck.id}/instagram/\` (4:5 — IG forces every slide to match slide 1)`,
    "Re-shared to **Story with a link sticker** same day (the only clickable path available to a zero-follower account — RESEARCH §2.3)",
    "Caption or a slide carries a **send-shaped** prompt (\"send this to…\") — sends-per-reach is the cold-reach signal (RESEARCH §2.1)",
  ],
};

function postMd(deck) {
  const links = linksFor(deck);
  const any = Object.values(links)[0];
  const tags = (p) => (deck.hashtags?.[p] || []).map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");

  const section = (p) => {
    const l = links[p];
    const title = p === "tiktok" ? "TikTok" : p[0].toUpperCase() + p.slice(1);
    return `## ${title}

- **Put this in the bio:** ${l.bio ?? "_no redirectBase configured — use the store link below directly_"}
- **Destination:** ${l.store}
- **Campaign token:** \`${l.ct}\`

**Caption**

\`\`\`
${deck.caption[p]}

${tags(p)}
\`\`\`

**Checklist**
${CHECKLIST[p](deck).map((c) => `- [ ] ${c}`).join("\n")}
- [ ] Logged a row in TRACKING.md

---
`;
  };

  const sections = Object.keys(PLATFORM_TAG)
    .filter((p) => deck.caption?.[p])
    .map(section)
    .join("\n");

  const warn = [];
  if (!any.tracked) warn.push("⚠️ **No `pt` provider token in config.json** — the links below are the bare App Store URL, so App Store Connect will not attribute anything to a campaign. See RESEARCH.md §5.2.");
  if (!any.counted) warn.push("⚠️ **No `redirectBase` in config.json** — there is no per-post link-tap counter, which is the one metric that actually works at our volume. See TRACKING.md item 1.");
  if (config.handle === "@argus.app") warn.push("⚠️ **Handle is still the placeholder `@argus.app`** and it is printed on every slide footer. Set `handle` in config.json and regenerate before posting.");

  return `# ${deck.id} — ${deck.title ?? deck.hookId}

| | |
|---|---|
| Angle | ${deck.angle} |
| Hook | \`${deck.hookId}\` (HOOKS.md) |
| CTA | \`${deck.ctaId ?? "—"}\` |
| Capabilities claimed | ${deck.capabilities.map((c) => `\`${c}\``).join(", ")} |
| Campaign token base | \`${deck.ct}\` (per angle + month, not per post — Apple suppresses metrics under 5) |
| Slides | ${deck.slides.length} |

${warn.length ? warn.join("\n\n") + "\n" : ""}
---

${sections}
## Slide copy (for reference / re-cutting as a Reel)

${deck.slides.map((s, i) => `${String(i + 1).padStart(2, "0")}. **${s.type}** — ${(s.headline ?? s.turns?.map((t) => `${t.who}: ${t.text}`).join(" / ") ?? s.items?.map((it) => (typeof it === "string" ? it : it.text)).join(" · ") ?? `${s.before} → ${s.after}`).replace(/\[\[\/?gold\]\]/g, "").replace(/\s*\/\/\s*/g, " ")}`).join("\n")}
`;
}

/**
 * A contact sheet over everything that was just rendered.
 *
 * Deliberately generated from the same PNGs rather than re-rendering sample
 * markup into a hand-written preview page: a second copy of the markup is a
 * second source of truth, and it drifts the first time a template changes.
 */
function contactSheet(rendered) {
  const card = (r) => `
    <section>
      <h2>${esc(r.id)} <small>${esc(r.angle)} · ${esc(r.hookId)}</small></h2>
      ${r.platforms.map((p) => `
        <h3>${esc(p)}</h3>
        <div class="row">${r.files[p].map((f) => `<a href="${f}"><img src="${f}" loading="lazy"></a>`).join("")}</div>`).join("")}
      <p><a href="${esc(r.id)}/POST.md">POST.md</a></p>
    </section>`;
  return `<!doctype html><meta charset="utf-8"><title>Argus batch contact sheet</title>
<style>
 body{background:#08080c;color:#e8e0d0;font:15px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;padding:40px}
 h1{color:#c9a84c;letter-spacing:2px;font-size:22px}
 h2{color:#c9a84c;font-size:18px;margin:48px 0 4px;border-top:1px solid #201c14;padding-top:24px}
 h2 small{color:#6b6558;font-weight:400;letter-spacing:.06em;text-transform:uppercase;font-size:12px;margin-left:10px}
 h3{color:#6b6558;font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:600;margin:20px 0 10px}
 .row{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}
 img{height:300px;border-radius:8px;border:1px solid #201c14;display:block}
 a{color:#c9a84c}
</style>
<h1>◉ Argus — batch contact sheet</h1>
<p style="color:#9e978a">${rendered.length} deck(s) <em>in this run</em> · ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z — a partial run (<code>--platform</code> or a named deck) overwrites this page with just what it rendered; re-run with no arguments for the whole batch</p>
${rendered.map(card).join("")}`;
}

/* ==========================================================================
   main
   ========================================================================== */

const decks = loadDecks();

let bad = 0;
for (const d of decks) {
  const errs = validate(d);
  if (errs.length) {
    bad++;
    console.error(`\n  ✗ ${d.id}`);
    errs.forEach((e) => console.error(`      ${e}`));
  }
}
if (bad) die(`${bad} deck(s) failed validation — nothing rendered`);
console.log(`  ✓ ${decks.length} deck(s) valid`);

if (OPTS.check) { console.log("  (--check: stopping before render)\n"); process.exit(0); }

let browser = null;
if (!OPTS.fallback) {
  try {
    browser = await launchBrowser();
    console.log("  ✓ chrome up (CDP)");
  } catch (err) {
    console.warn(`  ! CDP unavailable (${err.message}); falling back to one Chrome per slide`);
    OPTS.fallback = true;
  }
}

const started = Date.now();
let shots = 0;
const rendered = [];

try {
  for (const deck of decks) {
    const deckOut = join(OUT, deck.id);
    mkdirSync(deckOut, { recursive: true });

    for (const platform of platforms) {
      const { w, h } = PLATFORMS[platform];
      const dir = join(deckOut, platform);
      const htmlDir = join(dir, "_html");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(htmlDir, { recursive: true });

      for (const [i, slide] of deck.slides.entries()) {
        const n = String(i + 1).padStart(2, "0");
        const html = renderPage(slide, {
          platform,
          index: i,
          total: deck.slides.length,
          isLast: i === deck.slides.length - 1,
          handle: config.handle,
          deckId: deck.id,
          safe: OPTS.safe,
        });
        const htmlPath = join(htmlDir, `${n}.html`);
        const pngPath = join(dir, `${n}.png`);
        writeFileSync(htmlPath, html, "utf8");

        if (OPTS.fallback) await shotCli(htmlPath, pngPath, w, h);
        else writeFileSync(pngPath, await shotCdp(browser.page, htmlPath, w, h));
        shots++;
      }
      console.log(`  ✓ ${deck.id}/${platform}  ${deck.slides.length} slides  ${w}×${h}`);
    }

    writeFileSync(join(deckOut, "POST.md"), postMd(deck), "utf8");
    writeFileSync(join(deckOut, "manifest.json"), JSON.stringify({
      id: deck.id,
      title: deck.title,
      angle: deck.angle,
      hookId: deck.hookId,
      ctaId: deck.ctaId,
      capabilities: deck.capabilities,
      ct: deck.ct,
      slides: deck.slides.length,
      platforms,
      links: linksFor(deck),
      generatedAt: new Date().toISOString(),
    }, null, 2), "utf8");

    rendered.push({
      id: deck.id,
      angle: deck.angle,
      hookId: deck.hookId,
      platforms,
      files: Object.fromEntries(platforms.map((p) => [
        p, deck.slides.map((_, i) => `${deck.id}/${p}/${String(i + 1).padStart(2, "0")}.png`),
      ])),
    });
  }
} finally {
  if (browser) await browser.close();
}

writeFileSync(join(OUT, "index.html"), contactSheet(rendered), "utf8");

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n  ${shots} PNGs in ${secs}s → ${OUT}`);
console.log(`  review them all at  ${join(OUT, "index.html")}\n`);
