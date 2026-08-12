// avatar-settling.test.mjs — 🫤 for the gap between "you stopped talking" and
// "the turn resolved".
//
// That window is roughly defaultSilenceSeconds (~1.4s), and the face used to
// hold 😐 through it. Honest, but it says nothing — and the bot is measurably
// slower to answer than a human, so those seconds are exactly where the room
// most needs a sign that it is on the case. Measured from real logs: median
// 1202ms between the last 😐 and the first 🤔.
//
// Run: node --test tests/avatar-settling.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');

test('the settling face is 🫤, and distinct from hearing', () => {
  const m = inject.match(/static SETTLING_EMOJI = '([^']+)'/);
  assert.ok(m, 'the settling face needs its own constant');
  assert.equal(eval(`'${m[1]}'`), '\u{1FAE4}', 'diagonal mouth — reads as "are you done?"');
  const h = inject.match(/static HEARING_EMOJI = '([^']+)'/);
  assert.notEqual(m[1], h[1], 'the whole point is telling the two halves apart');
});

test('it fires only after speech stops, never while someone is talking', () => {
  // Same attentive window as before, split on anyoneSpeaking. Getting this
  // backwards would show "are you done?" AT someone mid-sentence.
  const block = inject.slice(inject.indexOf('const attentive ='), inject.indexOf('const activityEmoji'));
  assert.match(block, /this\.anyoneSpeaking \? VirtualCamera\.HEARING_EMOJI : VirtualCamera\.SETTLING_EMOJI/);
});

test('it inherits every existing suppression', () => {
  // silent mode, bot speaking, and the thinking/speaking/yielding states all
  // already outrank the attentive face. Splitting it in two must not smuggle a
  // new face past those — a 🫤 appearing while the bot is mid-sentence would be
  // worse than the flat 😐 it replaced.
  const block = inject.slice(inject.indexOf('const attentive ='), inject.indexOf('const hearing = attentive'));
  for (const guard of ["mode !== 'silent'", '!this.speaking', "state !== 'thinking'", "state !== 'speaking'", "state !== 'yielding'"]) {
    assert.ok(block.includes(guard), `lost the ${guard} guard`);
  }
});

test('the log says which half it is', () => {
  // The transition analysis that found this was done entirely from these lines,
  // so a face that cannot be told apart in the log cannot be audited later.
  assert.match(inject, /settling \(speech stopped, awaiting turn\)/);
  assert.match(inject, /hearing \(anyoneSpeaking=true\)/);
});

test('the grace window still bounds it', () => {
  // Without the timeout a bot would sit on 🫤 indefinitely after any utterance
  // that never resolves into a turn.
  assert.match(inject, /const HEARING_GRACE_MS = \d+/);
  assert.match(inject, /stillInGrace = !this\.anyoneSpeaking/);
});
