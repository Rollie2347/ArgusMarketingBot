/**
 * The default publisher: no API call, a ready-to-post bundle.
 *
 * "Manual" does not mean "does nothing". The failure mode this guards against
 * is an approved post sitting in a folder for a week because nobody knew it
 * was approved, so it writes a dated hand-off file naming exactly what to
 * upload, in what order, with the caption and the bio link already resolved —
 * and records the same fields the API adapters record, so TRACKING.md joins up
 * identically whichever path a post took.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR } from "../config.mjs";

export const name = "manual";

export async function publish(item) {
  const dir = join(OUT_DIR, item.deckId, "_approved");
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString();
  const file = join(dir, `${item.platform}.md`);

  writeFileSync(file, `# READY TO POST — ${item.deckId} → ${item.platform}

Approved ${stamp}

## 1. Upload these, in this order

\`${join(OUT_DIR, item.deckId, item.platform)}\`

${item.slideFiles.map((f, i) => `${String(i + 1).padStart(2, "0")}. ${f}`).join("\n")}

## 2. Caption

\`\`\`
${item.caption}

${item.hashtags.join(" ")}
\`\`\`

## 3. Link

Bio link for this post: **${item.trackingUrl || "(no redirectBase configured — see marketing/TRACKING.md)"}**
Campaign token: \`${item.ct || "—"}\`

## 4. After posting

- [ ] Paste the post URL back to the bot with \`/posted ${item.id} <url>\`
- [ ] Add a row to marketing/TRACKING.md
`, "utf8");

  return {
    published: false,
    postId: null,
    url: null,
    note: `Hand-off written to ${file}`,
  };
}
