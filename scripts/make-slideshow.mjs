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
import { pathToFileURL } from "node:url";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { renderPage, PLATFORMS, esc, forPlatform, frameFor } from "../templates/render.mjs";
import { validateDeck, noBioLinkPlatforms } from "../lib/validate.mjs";
import { DECKS_DIR as DECKS, OUT_DIR as OUT, ASSETS_DIR, CONFIG_FILE } from "../lib/paths.mjs";

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

const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
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

/**
 * Hand-written decks get the structural checks and the banned-phrase tripwire.
 * Decks written by scripts/write-decks.mjs (they carry a `generated` block)
 * also get strict mode — hook/CTA/capability ids checked against HOOKS.md and
 * copy-length ceilings — because no human read them before this point.
 * The rules themselves live in lib/validate.mjs.
 */
function validate(deck) {
  const e = validateDeck(deck, platforms, { strict: Boolean(deck.generated), noBioLink: noBioLinkPlatforms(config) });
  // An image slot that was never filled would render as a plain slide and look
  // fine, so it is an error rather than a silent downgrade.
  deck.slides?.forEach((sl, i) => {
    if (sl.image && !imagePath(deck, sl)) {
      e.push(`slide ${i + 1}: image not generated yet — run "node scripts/make-images.mjs ${deck.id}"`);
    }
  });
  return e;
}

/** Absolute path of a slide's generated image, or null if it doesn't exist. */
function imagePath(deck, slide) {
  if (!slide.image?.file) return null;
  const p = join(ASSETS_DIR, deck.id, basename(slide.image.file));
  return existsSync(p) ? p : null;
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
  // Containers run Chromium as root, where its sandbox cannot start. Only the
  // marketing Dockerfile sets this; it renders our own templates, nothing
  // fetched from the internet.
  ...(process.env.ARGUS_CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
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
  // A JPEG of the same frame, from the same loaded page. TikTok's photo API
  // accepts JPG/WebP only — not PNG — so the API publishers upload these.
  // Quality 92 is visually lossless on these slides and keeps a 9-slide deck
  // far under every platform's per-image cap.
  const jpg = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 92, captureBeyondViewport: false });
  return { png: Buffer.from(data, "base64"), jpg: Buffer.from(jpg.data, "base64") };
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
    ...(config.tiktokAccount === "personal"
      ? ["Personal account: **no App Store link in bio** — the CTA tells viewers to search “My Argus” (RESEARCH §1.4)",
         "Sound attached — a personal account can use trending sounds"]
      : ["Posted from the **Business** account (personal accounts cannot link to App Store pages — RESEARCH §1.4)",
         "Sound attached from the **Commercial Music Library** (business accounts have no access to trending sounds)"]),
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

${forPlatform(deck.slides, platforms[0]).map((s, i) => `${String(i + 1).padStart(2, "0")}. **${s.type}** — ${(s.headline ?? s.turns?.map((t) => `${t.who}: ${t.text}`).join(" / ") ?? s.items?.map((it) => (typeof it === "string" ? it : it.text)).join(" · ") ?? `${s.before} → ${s.after}`).replace(/\[\[\/?gold\]\]/g, "").replace(/\s*\/\/\s*/g, " ")}`).join("\n")}
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
      const { w, h, layout } = frameFor(platform, config);
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
          imageUrl: slide.image ? pathToFileURL(imagePath(deck, slide)).href : null,
          layout,
          noSwipe: (platform === "tiktok" && config.tiktokFormat === "video") || (platform === "instagram" && config.instagramFormat === "reel"),
        });
        const htmlPath = join(htmlDir, `${n}.html`);
        const pngPath = join(dir, `${n}.png`);
        writeFileSync(htmlPath, html, "utf8");

        if (OPTS.fallback) await shotCli(htmlPath, pngPath, w, h);
        else {
          const shot = await shotCdp(browser.page, htmlPath, w, h);
          writeFileSync(pngPath, shot.png);
          writeFileSync(join(dir, `${n}.jpg`), shot.jpg);
        }
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
      // Drives the AI-generated-content label on TikTok and Instagram.
      aiImages: deck.slides.some((sl) => sl.image),
      generated: deck.generated ?? null,
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
