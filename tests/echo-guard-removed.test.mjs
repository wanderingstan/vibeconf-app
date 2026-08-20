// echo-guard-removed.test.mjs — the echo guard is gone, and must stay gone (#487).
//
// This replaces echo-guard.test.mjs, which pinned the guard's existence (#245).
//
// The guard suppressed every far-end analyser frame while our own output was
// loud, on the theory that a human on speakers hears the bot's TTS, their mic
// picks it up, and the bot yields to its own voice. Meet's AEC turns out to
// handle that; what the guard reliably did instead was blind the bot to real
// interruptions, since a person talking over it then reached the analyser only
// as fragments in the gaps between our words. The #467 note put the measured
// yield rate against a sustained interrupter at 1 in 6; on 2026-08-20 the guard
// logged 125 suppressed frames across the exact 15s in which the bot talked
// straight over a human.
//
// It is worth a test rather than just a deletion because this bug was ALREADY
// half-fixed and grew back by oversight: #432 reverted the DOM-path twin
// (#378/#421) on 2026-08-18 and everyone believed the guard was gone, while the
// original analyser guard sat untouched in page-inject for another two days.
// The failure mode is a well-meaning reintroduction, so pin the absence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');

test('the far-end verdict is the level test alone — nothing gates it', () => {
  const block = inject.slice(inject.indexOf('farEnd = db > FLOOR_SPEECH_DB'));
  const body = block.slice(0, block.indexOf('noteAudioLevel'));
  assert.doesNotMatch(body, /getAmplitude/,
    'our own output level must not enter the far-end decision');
  assert.doesNotMatch(body, /SELF_LOUD_AMP/,
    'nor the loudness threshold it used');
  assert.doesNotMatch(body, /farEnd\s*=\s*false/,
    'nothing may retract a far-end frame after the level test');
});

test('no suppression counter survives anywhere in the page world', () => {
  assert.doesNotMatch(inject, /noteEchoSuppressed|echo-guard/,
    'the guard and its telemetry are both gone');
});

test('barge-in does not consult our own audio when judging their silence', () => {
  const fn = server.slice(server.indexOf('_floorQuietPerAnalyser('));
  const body = fn.slice(0, fn.indexOf('_analyserStateForLog'));
  assert.doesNotMatch(body, /if \(this\._selfAudioLastLoudAt/,
    '#467\'s gate existed only to compensate for the guard (see #487)');
});

test('the self-audio envelope is still PUBLISHED — it is diagnostic, not a gate', () => {
  // Deliberately kept: #422 scores detection offline against this signal, and
  // removing the publisher would silently degrade those recordings. Its absence
  // from the decision path is what the tests above assert; its presence here is
  // not an oversight.
  assert.match(inject, /action: 'self-audio'/);
  assert.match(server, /setSelfAudioLoud/);
});
