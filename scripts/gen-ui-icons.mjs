#!/usr/bin/env node
// gen-ui-icons.mjs — build renderer/ui-icons.css from the bundled OpenMoji art.
//
// The panel's chrome icons (gear, eyes, construction…) used to be literal emoji
// characters in the markup, so every OS drew them differently: Apple's glossy
// 3D gear next to Windows' flat one, at sizes we don't control. This turns a
// fixed set of them into monochrome inline SVG instead.
//
// The art comes from emoji/openmoji/, which we already ship for the bot's face.
// Those files are the COLOUR build, but each one also carries a <g id="line">
// with the same glyph as pure outline — that group IS OpenMoji's black variant,
// so we can cut it out locally rather than vendoring a second download.
//
// Output is CSS, not <img>: each icon is a mask painted with `currentColor`, so
// it inherits the button's text colour and hover/disabled states for free. An
// <img> data URI would be stuck at whatever colour the file says (#000), which
// is invisible on this panel's dark chrome.
//
// Run:  node scripts/gen-ui-icons.mjs
// tests/ui-icons.test.mjs re-runs this and fails if the committed CSS drifts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(root, 'electron-app', 'emoji', 'openmoji');
const OUT = path.join(root, 'electron-app', 'renderer', 'ui-icons.css');

// The chrome icons, by CSS name → codepoint. Deliberately NOT every emoji the
// app draws — three groups are left alone on purpose, and tests/ui-icons.test.mjs
// pins each one so nobody "finishes the job" later:
//   · the 🟢🔴🟡⚪ status dots stay emoji — colour is their entire meaning, and a
//     monochrome dot would say nothing
//   · the bot's face (🙂 😐 …) stays emoji — the user picks its set themselves
//   · → ↗ ▸ ▾ stay text glyphs — they're typography rather than pictures, and ▸
//     in particular is ROTATED by CSS to point up, which a mask can't be
export const ICONS = {
  eyes: '1F440', // 👀 what the bot sees
  construction: '1F6A7', // 🚧 troubleshooting
  screen: '1F5A5', // 🖥  show/hide the shared window
  speaker: '1F50A', // 🔊 voice-is-off notice
  folder: '1F4C2', // 📂 open bot profiles folder
  clipboard: '1F4CB', // 📋 open call logs folder
  brain: '1F9E0',     // 🧠 the agent's activity feed — sibling to 👀 (the bot's eyes)
};

// Two glyphs are drawn by hand rather than lifted from OpenMoji, because
// OpenMoji has nothing suitable: ✕ (U+2715) simply isn't in the set, and its
// neighbours there are emoji in their own right — ❌ is a big red cross, ✖️ a
// heavy multiplication sign. Neither reads as "close this".
//
// They're still OS-independent art, which is the whole point, and they follow
// the same stroke idiom as the Bot Settings done-checkmark: round caps, weight
// ~2.6 on a 24px canvas, which matches OpenMoji's 2-on-72 at these sizes.
const DRAWN = {
  close: '<path d="M5 5 L19 19 M19 5 L5 19"/>', // ✕ put the bot's view away
  check: '<path d="M4 12 L9.5 17.5 L20 6"/>', // ✓ copied / confirmed
};

// Icons vendored from another set, verbatim. OpenMoji's ⚙ is a hairline outline
// with a fussy toothed rim that turns to mush at 24px — Octicons' gear is drawn
// FOR that size, so the gear comes from there instead.
//
// Octicons (MIT, https://github.com/primer/octicons), icons/gear-24.svg. Copied
// in rather than fetched: the build must not depend on the network, and the art
// is two paths. Fills, not strokes, which the mask handles the same way — it
// only cares which pixels are opaque.
const VENDORED = {
  gear:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path d="M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm-1.5 0a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>' +
    '<path d="M12 1c.266 0 .532.009.797.028.763.055 1.345.617 1.512 1.304l.352 1.45c.019.078.09.171.225.221.247.089.49.19.728.302.13.061.246.044.315.002l1.275-.776c.603-.368 1.411-.353 1.99.147.402.349.78.726 1.128 1.129.501.578.515 1.386.147 1.99l-.776 1.274c-.042.069-.058.185.002.315.112.238.213.481.303.728.048.135.142.205.22.225l1.45.352c.687.167 1.249.749 1.303 1.512.038.531.038 1.063 0 1.594-.054.763-.616 1.345-1.303 1.512l-1.45.352c-.078.019-.171.09-.221.225-.089.248-.19.491-.302.728-.061.13-.044.246-.002.315l.776 1.275c.368.603.353 1.411-.147 1.99-.349.402-.726.78-1.129 1.128-.578.501-1.386.515-1.99.147l-1.274-.776c-.069-.042-.185-.058-.314.002a8.606 8.606 0 0 1-.729.303c-.135.048-.205.142-.225.22l-.352 1.45c-.167.687-.749 1.249-1.512 1.303-.531.038-1.063.038-1.594 0-.763-.054-1.345-.616-1.512-1.303l-.352-1.45c-.019-.078-.09-.171-.225-.221a8.138 8.138 0 0 1-.728-.302c-.13-.061-.246-.044-.315-.002l-1.275.776c-.603.368-1.411.353-1.99-.147-.402-.349-.78-.726-1.128-1.129-.501-.578-.515-1.386-.147-1.99l.776-1.274c.042-.069.058-.185-.002-.314a8.606 8.606 0 0 1-.303-.729c-.048-.135-.142-.205-.22-.225l-1.45-.352c-.687-.167-1.249-.749-1.304-1.512a11.158 11.158 0 0 1 0-1.594c.055-.763.617-1.345 1.304-1.512l1.45-.352c.078-.019.171-.09.221-.225.089-.248.19-.491.302-.728.061-.13.044-.246.002-.315l-.776-1.275c-.368-.603-.353-1.411.147-1.99.349-.402.726-.78 1.129-1.128.578-.501 1.386-.515 1.99-.147l1.274.776c.069.042.185.058.315-.002.238-.112.481-.213.728-.303.135-.048.205-.142.225-.22l.352-1.45c.167-.687.749-1.249 1.512-1.304C11.466 1.01 11.732 1 12 1Zm-.69 1.525c-.055.004-.135.05-.161.161l-.353 1.45a1.832 1.832 0 0 1-1.172 1.277 7.147 7.147 0 0 0-.6.249 1.833 1.833 0 0 1-1.734-.074l-1.274-.776c-.098-.06-.186-.036-.228 0a9.774 9.774 0 0 0-.976.976c-.036.042-.06.131 0 .228l.776 1.274c.314.529.342 1.18.074 1.734a7.147 7.147 0 0 0-.249.6 1.831 1.831 0 0 1-1.278 1.173l-1.45.351c-.11.027-.156.107-.16.162a9.63 9.63 0 0 0 0 1.38c.004.055.05.135.161.161l1.45.353a1.832 1.832 0 0 1 1.277 1.172c.074.204.157.404.249.6.268.553.24 1.204-.074 1.733l-.776 1.275c-.06.098-.036.186 0 .228.301.348.628.675.976.976.042.036.131.06.228 0l1.274-.776a1.83 1.83 0 0 1 1.734-.075c.196.093.396.176.6.25a1.831 1.831 0 0 1 1.173 1.278l.351 1.45c.027.11.107.156.162.16a9.63 9.63 0 0 0 1.38 0c.055-.004.135-.05.161-.161l.353-1.45a1.834 1.834 0 0 1 1.172-1.278 6.82 6.82 0 0 0 .6-.248 1.831 1.831 0 0 1 1.733.074l1.275.776c.098.06.186.036.228 0 .348-.301.675-.628.976-.976.036-.042.06-.131 0-.228l-.776-1.275a1.834 1.834 0 0 1-.075-1.733c.093-.196.176-.396.25-.6a1.831 1.831 0 0 1 1.278-1.173l1.45-.351c.11-.027.156-.107.16-.162a9.63 9.63 0 0 0 0-1.38c-.004-.055-.05-.135-.161-.161l-1.45-.353c-.626-.152-1.08-.625-1.278-1.172a6.576 6.576 0 0 0-.248-.6 1.833 1.833 0 0 1 .074-1.734l.776-1.274c.06-.098.036-.186 0-.228a9.774 9.774 0 0 0-.976-.976c-.042-.036-.131-.06-.228 0l-1.275.776a1.831 1.831 0 0 1-1.733.074 6.88 6.88 0 0 0-.6-.249 1.835 1.835 0 0 1-1.173-1.278l-.351-1.45c-.027-.11-.107-.156-.162-.16a9.63 9.63 0 0 0-1.38 0Z"/>' +
    '</svg>',
};

function drawnSvg(body) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    `<g fill="none" stroke="#000" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${body}</g>` +
    '</svg>'
  );
}

// OpenMoji keeps U+FE0F in some filenames but not all, the same split
// emoji-assets.js works around.
function readGlyph(cp) {
  for (const name of [`${cp}.svg`, `${cp}-FE0F.svg`]) {
    const full = path.join(SRC_DIR, name);
    if (fs.existsSync(full)) return fs.readFileSync(full, 'utf8');
  }
  throw new Error(`no bundled OpenMoji art for U+${cp}`);
}

// Cut out <g id="line">…</g>, counting nested <g> so a glyph whose outline is
// grouped internally doesn't get truncated at the first closing tag.
export function lineGroup(svg) {
  const start = svg.indexOf('<g id="line"');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < svg.length; i++) {
    if (svg.startsWith('<g', i)) depth++;
    else if (svg.startsWith('</g>', i) && --depth === 0) return svg.slice(start, i + 4);
  }
  return null;
}

// OpenMoji draws 👀 looking to its left, which on the panel means the eyes look
// away from the button they belong to. Mirrored, they look INTO "Call now" —
// the thing they're offering to show you.
//
// Mirrored here rather than with a CSS transform so the asset is simply correct:
// nothing downstream has to remember to flip it, and it can't be double-flipped
// by a second rule later.
const MIRRORED = new Set(['eyes']);

// A standalone 72x72 SVG holding just the outline. Whitespace is collapsed
// because the whole thing has to survive as a single-line CSS url().
export function iconSvg(cp, { mirror = false } = {}) {
  const g = lineGroup(readGlyph(cp));
  if (!g) throw new Error(`U+${cp} has no <g id="line"> outline`);
  const body = g.replace(/<!--.*?-->/gs, '').replace(/\s+/g, ' ').trim();
  // translate-then-scale: scale(-1,1) alone reflects about x=0 and takes the
  // glyph off the left edge of the canvas, so it has to be pushed back by the
  // full 72 width.
  const art = mirror ? `<g transform="translate(72,0) scale(-1,1)">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">${art}</svg>`;
}

// Only the characters that would break out of a double-quoted CSS url() need
// escaping; leaving the rest literal keeps the file readable and much smaller
// than a full encodeURIComponent would.
export function cssUrl(svg) {
  return `url("data:image/svg+xml,${svg
    .replace(/%/g, '%25')
    .replace(/"/g, "'")
    .replace(/#/g, '%23')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\n/g, '')}")`;
}

export function buildCss() {
  const rules = [
    ...Object.entries(ICONS).map(([name, cp]) => [name, iconSvg(cp, { mirror: MIRRORED.has(name) })]),
    ...Object.entries(VENDORED),
    ...Object.entries(DRAWN).map(([name, body]) => [name, drawnSvg(body)]),
  ]
    .map(([name, svg]) => `.ui-icon-${name} { --ui-icon: ${cssUrl(svg)}; }`)
    .join('\n');

  return `/* ui-icons.css — GENERATED by scripts/gen-ui-icons.mjs. Do not edit by hand.
 *
 * OpenMoji outline art (CC BY-SA 4.0, https://openmoji.org), extracted from the
 * colour set we already bundle for the bot's face. Replaces the literal emoji
 * characters that used to sit in the panel's buttons, which every OS drew
 * differently and at a size we couldn't control.
 *
 * The gear is the exception: it comes from Octicons (MIT,
 * https://github.com/primer/octicons), whose art is drawn for this size.
 *
 * Each icon is a MASK, not an image: the glyph shape is punched out of
 * \`currentColor\`, so an icon takes the colour of whatever button holds it and
 * follows its hover and disabled states without a second asset.
 */

.ui-icon {
  display: inline-block;
  width: 1.15em;
  height: 1.15em;
  vertical-align: -0.2em;
  /* OpenMoji's outlines are hairlines at button size (2px on a 72px canvas), so
     the box is set a shade larger than the surrounding text to keep them legible. */
  background-color: currentColor;
  -webkit-mask: var(--ui-icon) center / contain no-repeat;
  mask: var(--ui-icon) center / contain no-repeat;
  flex: none;
}

/* An icon that IS the button's whole label needs no gap. One that leads a text
   label ("Show share") does — as an explicit modifier rather than a sibling
   selector, because the label is usually a bare text node, which \`+\` can't match.
   Double dash so it can never collide with a generated .ui-icon-<name>. */
.ui-icon--lead {
  margin-right: 0.4em;
}

${rules}
`;
}

export { DRAWN, drawnSvg, MIRRORED, VENDORED };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const css = buildCss();
  fs.writeFileSync(OUT, css);
  const kb = (Buffer.byteLength(css) / 1024).toFixed(1);
  console.log(`wrote ${path.relative(root, OUT)} — ${Object.keys(ICONS).length + Object.keys(VENDORED).length + Object.keys(DRAWN).length} icons, ${kb} KB`);
}
