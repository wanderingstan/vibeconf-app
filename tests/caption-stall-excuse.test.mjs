// caption-stall-excuse.test.mjs — the bot's own speech may excuse a caption
// stall only for as long as that speech could explain it (#265).
//
// The old rule, `now - lastSpokeAloudAt < ageMs`, excused the WHOLE stall if
// the bot had spoken at any point since the last remote caption. Stall age only
// grows, so one sentence at minute 1 excused minute 44 (2026-08-28, 2656s),
// and Taylor's 622s deaf window on Sep 18 was waved off the same way.
//
// Run: node --test tests/caption-stall-excuse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { stallExplainedByOwnSpeech, OWN_SPEECH_GRACE_MS } = require('../electron-app/caption-stall-excuse.js');

const NOW = 10_000_000;
const MIN = 60_000;

test('excused while the bot is speaking aloud', () => {
  assert.equal(stallExplainedByOwnSpeech({ speakingAloud: true, lastSpokeAloudAt: 0, now: NOW }), true);
});

test('excused just after the bot stops — captions need a moment to resume', () => {
  assert.equal(stallExplainedByOwnSpeech({ speakingAloud: false, lastSpokeAloudAt: NOW - 5000, now: NOW }), true);
});

test('#265 one sentence at minute 1 does NOT excuse a stall at minute 44', () => {
  // Old rule: now - lastSpokeAloudAt (43 min) < ageMs (44 min) → excused. Wrong.
  const lastSpokeAloudAt = NOW - 43 * MIN;
  const ageMs = 44 * MIN;
  assert.equal(NOW - lastSpokeAloudAt < ageMs, true, 'sanity: the old rule excused this');
  assert.equal(stallExplainedByOwnSpeech({ speakingAloud: false, lastSpokeAloudAt, now: NOW }), false);
});

test('#265 Taylor, Sep 18: a few short sentences cannot explain a 622s stall', () => {
  // The bot last spoke ~2 min ago; captions have been frozen for 622s.
  assert.equal(stallExplainedByOwnSpeech({ speakingAloud: false, lastSpokeAloudAt: NOW - 2 * MIN, now: NOW }), false);
});

test('a bot that never spoke never gets the excuse', () => {
  assert.equal(stallExplainedByOwnSpeech({ speakingAloud: false, lastSpokeAloudAt: 0, now: NOW }), false);
});

test('the grace window matches the provider stall threshold', () => {
  const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');
  const m = /const STALL_MS = (\d+);/.exec(provider);
  assert.ok(m, 'STALL_MS not found in the provider');
  assert.equal(OWN_SPEECH_GRACE_MS, Number(m[1]),
    'if the detector threshold moves, the excuse window should move with it');
});

test('main.js uses the helper, not the old whole-stall comparison', () => {
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /stallExplainedByOwnSpeech\(/);
  assert.ok(!/lastSpokeAloudAt \|\| 0\)\) < \(info\?\.ageMs/.test(main), 'the old "< ageMs" excuse is back');
});
