// emoji-assets.test.mjs — the bundled emoji graphics resolve, and the Node-side
// filename rules stay in lockstep with page-inject's copy.
//
// page-inject.js is eval'd into the PAGE world where `require` doesn't exist, so
// it carries its own EMOJI_SETS. Two copies of a fiddly convention (upper vs
// lower hex, `-` vs `_`, whether U+FE0F is dropped, .svg vs .png) WILL drift —
// and the failure is silent: a wrong path just falls back to the native glyph,
// so the panel and the camera quietly stop matching. Pin them together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../electron-app/emoji-assets.js');
const EMOJI_DIR = join(process.cwd(), 'electron-app', 'emoji');

// A spread of shapes: plain BMP, one that carries U+FE0F, and a multi-codepoint
// sequence — the three cases the conventions disagree about.
const SAMPLES = ['\u{1F642}', '\u{1F614}', '\u{1F610}', '⚡️'];

test('every set resolves the resting face to a file that actually ships', () => {
  for (const set of Object.keys(A.EMOJI_SETS)) {
    const rel = A.relPathFor(set, '\u{1F642}'); // 🙂
    assert.ok(rel, `${set}: produced a path`);
    assert.ok(existsSync(join(EMOJI_DIR, rel)), `${set}: ${rel} exists on disk`);
  }
});

test('the resting face resolves to a usable data URI in every set', () => {
  for (const set of Object.keys(A.EMOJI_SETS)) {
    const uri = A.dataUriFor(set, '\u{1F642}', join(process.cwd(), 'electron-app'));
    assert.match(uri || '', /^data:image\/(png;base64,|svg\+xml;utf8,)/, `${set}: data URI`);
  }
});

test("'native' and unknown sets resolve to null, so callers fall back to the OS glyph", () => {
  assert.equal(A.relPathFor('native', '\u{1F642}'), null);
  assert.equal(A.relPathFor('nope', '\u{1F642}'), null);
  assert.equal(A.dataUriFor('native', '\u{1F642}'), null);
});

test('path traversal in a relative path is stripped', () => {
  assert.equal(A.dataUriForRelPath('../../etc/passwd'), null);
});

// Re-run page-inject's own EMOJI_SETS definition and compare it to ours. We pull
// the literal out of the source rather than importing (page-inject is a page
// script with no exports and side effects on `window`).
test('page-inject filename rules match emoji-assets, for every set and shape', () => {
  const src = readFileSync(join(process.cwd(), 'electron-app', 'page-inject.js'), 'utf-8');

  const hexFn = src.match(/function _emojiHex\([\s\S]*?\n  \}/);
  assert.ok(hexFn, 'found _emojiHex in page-inject');
  const canonLine = src.match(/const _canon = [^;]+;/);
  assert.ok(canonLine, 'found _canon in page-inject');
  const setsLit = src.match(/const EMOJI_SETS = \{[\s\S]*?\n  \};/);
  assert.ok(setsLit, 'found EMOJI_SETS in page-inject');

  // eslint-disable-next-line no-new-func
  const pageSets = new Function(`
    ${hexFn[0]}
    ${canonLine[0]}
    ${setsLit[0]}
    return EMOJI_SETS;
  `)();

  assert.deepEqual(
    Object.keys(pageSets).sort(),
    Object.keys(A.EMOJI_SETS).sort(),
    'the same sets exist on both sides',
  );

  for (const set of Object.keys(A.EMOJI_SETS)) {
    assert.equal(pageSets[set].dir, A.EMOJI_SETS[set].dir, `${set}: same directory`);
    for (const emoji of SAMPLES) {
      assert.equal(
        pageSets[set].dir + '/' + pageSets[set].file(emoji),
        A.relPathFor(set, emoji),
        `${set}: same filename for ${JSON.stringify(emoji)}`,
      );
    }
  }
});
