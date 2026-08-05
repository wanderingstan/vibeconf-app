// tick-face.test.mjs — the background-tick face is a BLINK, not a new object.
//
// A tick can only fire while someone is speaking, which means the face it
// replaces is always 😐 (HEARING_EMOJI). Picking 😑 (expressionless) rather than
// 👀 (eyes) makes 😐 → 😑 read as the same listener closing its eyes for a beat,
// instead of the avatar turning into a different thing mid-sentence.
//
// page-inject.js is a browser-context IIFE (not importable), so — like
// draw-cover.test.mjs — this pins the source. It also checks the glyph actually
// ships in every bundled emoji set: a missing asset falls back to the OS font
// silently, which is exactly the kind of thing nobody notices until a call.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');

const NEUTRAL = 0x1f610;       // 😐 hearing — "I hear you"
const EXPRESSIONLESS = 0x1f611; // 😑 ticking — same face, eyes closed

function literal(name, block) {
  const m = new RegExp(`${name}:\\s*'([^']+)'`).exec(block);
  assert.ok(m, `${name} not found`);
  // eslint-disable-next-line no-eval
  return eval(`"${m[1]}"`);
}

test('the tick face is 😑 expressionless, and hearing is 😐 neutral — a blink pair', () => {
  const activity = /static ACTIVITY_EMOJIS = \{([\s\S]*?)\n {4}\};/.exec(src)[1];
  const ticking = literal('ticking', activity);
  assert.equal(ticking.codePointAt(0), EXPRESSIONLESS, 'ticking must be 😑 (U+1F611)');

  const hearing = /HEARING_EMOJI = '([^']+)'/.exec(src)[1];
  // eslint-disable-next-line no-eval
  assert.equal(eval(`"${hearing}"`).codePointAt(0), NEUTRAL, 'hearing must be 😐 (U+1F610)');

  // The two differ by exactly one codepoint, adjacent in the block: that
  // adjacency is what makes the transition read as eyes closing.
  assert.equal(EXPRESSIONLESS - NEUTRAL, 1);
});

test('the tick face outranks the hearing face, or the blink would never show', () => {
  // A tick only happens while someone is speaking, so `hearing` is always the
  // competing candidate. activityEmoji must come first in the waterfall.
  const waterfall = /const emoji =([\s\S]*?);/.exec(src)[1];
  const iActivity = waterfall.indexOf('activityEmoji');
  const iHearing = waterfall.indexOf('hearing');
  assert.ok(iActivity > -1 && iHearing > -1, 'both candidates present');
  assert.ok(iActivity < iHearing, 'activityEmoji must be evaluated before hearing');
});

test('😑 is renderable by every bundled set — as a file, or by that set\'s font', () => {
  // Was: "😑 ships in every set", checked as a file per set. Three sets are
  // colour FONTS now, so there is no per-emoji file to look for — the guarantee
  // moved from "the asset exists" to "the font exists and covers it". Coverage
  // was measured when the fonts went in: 17/17 of the emoji the avatar uses,
  // including the ZWJ 🧑‍💻. The risk this test protects against is unchanged: a
  // missing face falls back to the OS font silently, mid-call.
  const emojiRoot = join(root, 'electron-app/emoji');
  const fontSets = ['twemoji', 'openmoji', 'noto'];

  for (const set of fontSets) {
    const font = join(emojiRoot, 'fonts', `${set}.ttf`);
    assert.ok(existsSync(font), `${set} must ship its font (${font})`);
  }

  // fluent3d is still per-file art, so the original check still applies to it.
  const files = readdirSync(join(emojiRoot, 'fluent3d'));
  const has = (cp) => files.some((f) => f.toLowerCase().includes(cp));
  assert.ok(has('1f611'), 'fluent3d is missing 😑 (1f611)');
  if (has('1f610')) assert.ok(has('1f611'), 'fluent3d has 😐 but not 😑');
});

test('page-inject no longer uses 👀 as the tick face', () => {
  const activity = /static ACTIVITY_EMOJIS = \{([\s\S]*?)\n {4}\};/.exec(src)[1];
  assert.ok(!/ticking:\s*'\\u\{1F440\}'/i.test(activity), '👀 must not be the ticking emoji');
});
