/**
 * Meme looks: the different ways the hook photo can be made, and which ones
 * today's decks get.
 *
 * One look, however good, is a channel that looks the same every day — ten
 * memes in a row were an animal portrait, and a feed of nothing but flash
 * snapshots of deadpan men would be the same problem a month later (Rollie,
 * 2026-10-09: "constantly iterating on the meme so the channel does not become
 * stale"). So the look is a variable: the code assigns one to each deck,
 * records it on the deck as `memeLook`, and decides tomorrow's from what
 * happened to today's.
 *
 * What it learns from is the only signal this pipeline has: the ✅ / ❌ on
 * each deck in Telegram. Views and swipe rates are not collected (TRACKING.md's
 * log is filled by hand and is empty), so this is "what Rollie keeps
 * approving", not "what gets clicks" — if post analytics are ever read
 * automatically, they belong in `verdict` below.
 *
 * Every look obeys the same frame (FRAME), because the template draws the
 * caption across the top and the headline across the bottom of all of them.
 */

const NO_TEXT = "Absolutely no legible text, letters, numbers, labels, packaging brands, logos, watermarks, signatures, user interfaces or phone screens anywhere in the frame.";

// Say what IS in the top and bottom of the frame, never that they are kept
// free for text: told "the bottom third holds nothing important, because
// caption text will be overlaid", the model painted a blank beige bar there
// and put the face under the caption (2026-10-09).
const FRAME = [
  "Vertical 9:16 image composed from a step further back than feels natural. The main character's face is about two-fifths of the way down the frame, never in the upper quarter: the whole upper quarter is plain background above and behind the head — wall, ceiling, cupboards, sky. The object the scene is about is directly below that face, at the vertical centre of the frame, brightly lit and unmistakable — it is the punchline, and a headline and a dark gradient cover the lower two-fifths (seen 2026-10-09: the carrot in the frosting, down by the knees, disappeared under them). The lower two-fifths is only the rest of the body and the same floor, table or ground carrying on, unbroken, to the bottom edge.",
  "One continuous image covering the entire frame from the top edge to the bottom edge: no borders, picture frames, bands, bars, panels, split frames, blank or solid-colour areas, or blurred padding anywhere.",
  NO_TEXT,
  "Any person is an ordinary, anonymous, invented adult — never a celebrity, public figure, or character from a film, show or game.",
];

/**
 * `brief` is for the deck writer (how to write the image prompt for this look);
 * `style` is appended to that prompt for the image model.
 */
export const LOOKS = {
  "flash-snapshot": {
    brief: "a PERSON caught in the act by a friend's phone flash: an ordinary adult, from the waist up, mid-way through the dumb thing, holding the object up at chest height, staring down the lens with total seriousness. Describe their clothes and the room; one detail is wrong (the suit, the hour, the floor they are sitting on).",
    style: [
      "A candid snapshot taken on a phone with the on-camera flash on, the kind a friend texts you without comment: hard direct flash, slightly imperfect framing, true-to-life colour, sharp focus on the subject. Never a polished stock, studio or wildlife photograph.",
      "One person caught in the middle of doing something, framed from about the waist up together with the object they are dealing with, so the action, the object and the face all read instantly at thumbnail size. The person shows one exaggerated, unmistakable emotion and is completely serious — the comedy is how seriously they are taking it.",
    ],
  },
  "animal-on-the-job": {
    brief: "an ANIMAL doing the human task as its job: dressed and equipped for it (apron, hard hat, reading glasses, lanyard, tiny tool belt), in the human place, paws on the actual object from the caption, concentrating like a professional who has seen worse. Never an animal just looking at the camera — it is working. Name the species, the outfit, the object and what it is doing to it.",
    style: [
      "A sharp, bright, true-to-life photograph in ordinary daylight, as if a bystander took it in disbelief: a real animal, at its real size, in a real human room, wearing real human work gear that fits it.",
      "The animal is in the middle of doing a human job with the object in its paws, framed from about the waist up so the outfit, the object and its face all read instantly at thumbnail size. Its expression is grave professional concentration — the comedy is how competent it thinks it is.",
    ],
  },
  "oil-painting": {
    brief: "the small modern moment painted as a solemn OLD-MASTER OIL PAINTING: one figure in period dress (ruff, velvet, armour, a monk's habit) holding the modern object from the caption with tragic, historic gravity, lit by a single candle or window. Describe the costume, the pose, the modern object and the grief or awe on the face.",
    style: [
      "A seventeenth-century Dutch or Italian baroque oil painting, museum quality: deep chiaroscuro from a single light source, visible brushwork and craquelure, rich dark background, the dignity of a historical portrait. A painting, not a photograph — and the painted canvas fills the whole image with no frame, wall or gallery around it.",
      "One figure in period dress, from about the waist up, holding one plainly modern everyday object, painted in the same old-master manner, as though it were a relic. The figure's face shows one grave, unmistakable emotion — the comedy is the reverence.",
    ],
  },
  "wildlife-doc": {
    brief: "a PERSON filmed like a wild animal by a nature documentary crew: seen from a distance through leaves, a doorway or the gap between shelves, unaware of the camera, absorbed in the dumb thing with the object from the caption. Describe what we are peering through, the 'habitat' (kitchen, aisle, garage), the person's posture and the object.",
    style: [
      "A still from a nature documentary shot on a long telephoto lens from a hide: the subject is sharp, and out-of-focus leaves, a door edge or shelf edges blur softly along the left and right sides of the frame as if the camera is peering through them. Natural light, compressed perspective, the patient feel of wildlife footage — but the habitat is an ordinary indoor human place.",
      "One person, from about the waist up, unaware of being watched and wholly absorbed in handling the object, which is held up in front of their chest. Their face shows one unmistakable emotion — the comedy is that they are being observed like a rare animal.",
    ],
  },
  "pov-judged": {
    brief: "the VIEWER'S OWN POV being silently judged: someone (a cat on the counter, a toddler, a grandmother, a cashier) stares straight into the lens with one unmistakable emotion — disappointment, pity, alarm — while the viewer's own two hands hold up the object from the caption in the foreground. Describe the judge, their expression, the hands and the object.",
    style: [
      "A first-person photograph, exactly what the viewer's own eyes see, bright true-to-life colour, sharp from the foreground hands to the face beyond them.",
      "Facing the camera, a little way off, is one onlooker staring directly into the lens with one exaggerated, unmistakable judgement on their face. In the foreground, entering from the bottom of the frame and held up below the onlooker's face, are the viewer's own two hands holding the object. The comedy is being caught.",
    ],
  },
};

export const DEFAULT_LOOK = "flash-snapshot";

/** The image-model style for a look. An unknown or missing look (decks written before looks existed) gets the default. */
export function memeStyle(look) {
  return [...(LOOKS[look] ?? LOOKS[DEFAULT_LOOK]).style, ...FRAME].join(" ");
}

/** A look loses this much of its score the day after it ran, so equally good looks take turns. */
const REST_PENALTY = 0.15;

/**
 * Which look each of `want` decks gets.
 *
 * All but the last slot go to the looks with the best record — approval rate,
 * smoothed so one ❌ doesn't bury a look and one ✅ doesn't crown it, less a
 * small penalty for having run yesterday. The last slot is always the look
 * that has been tried least: without it, an early lucky look would be all the
 * channel ever showed, and a new look would never get a turn.
 *
 * @param {number} want
 * @param {{ look: string, age: number, verdict?: boolean|null }[]} history
 *   one entry per past deck: days since its batch, and true (✅) / false (❌) /
 *   null (not decided, or not judged on its merits)
 * @returns {string[]} `want` look names; the experiment is last
 */
export function pickLooks(want, history = [], names = Object.keys(LOOKS)) {
  const stat = new Map(names.map((n, i) => [n, { name: n, i, uses: 0, yes: 0, no: 0, last: Infinity }]));
  for (const h of history) {
    const s = stat.get(h.look);
    if (!s) continue;
    s.uses++;
    if (h.verdict === true) s.yes++;
    if (h.verdict === false) s.no++;
    s.last = Math.min(s.last, h.age);
  }
  const all = [...stat.values()];
  const score = (s) => (s.yes + 1) / (s.yes + s.no + 2) - (s.last <= 1 ? REST_PENALTY : 0);
  const explore = [...all].sort((a, b) => a.uses - b.uses || b.last - a.last || a.i - b.i)[0];
  const ranked = all.filter((s) => s !== explore).sort((a, b) => score(b) - score(a) || b.last - a.last || a.i - b.i);
  const order = [...ranked.slice(0, Math.max(0, want - 1)), explore, ...ranked.slice(Math.max(0, want - 1))];
  const picked = [...ranked.slice(0, Math.max(0, Math.min(want, names.length) - 1)), explore];
  // More decks than looks: go round again, best first.
  for (let k = 0; picked.length < want; k++) picked.push(order[k % order.length]);
  return picked.slice(0, want).map((s) => s.name);
}
