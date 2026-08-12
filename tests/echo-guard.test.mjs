// echo-guard.test.mjs — the bot must not yield to its own voice (#245).
//
// Measured live on 2026-08-04: the bot's TTS came out of a participant's
// speakers, back into their microphone, and arrived on THEIR stream 503ms later,
// loud enough to clear the -35dB floor. The bot yielded to a human who had not
// spoken. Nothing about the source identifies it as ours — it is genuinely their
// stream, and Meet's own echo cancellation did not remove it at speaker volume.
//
// Level cannot separate the two: echo at speaker volume is as loud as speech.
// CORRELATION can — echo tracks our output envelope, a person does not.
//
// Run: node --test tests/echo-guard.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');

test('far-end audio only counts while our own output is quiet', () => {
  const block = inject.slice(inject.indexOf('let farEnd = db > FLOOR_SPEECH_DB'));
  const body = block.slice(0, block.indexOf('noteAudioLevel'));
  assert.match(body, /mic\.getAmplitude\(\)/, 'the discriminator is our OWN level');
  assert.match(body, /own > SELF_LOUD_AMP/);
  assert.match(body, /farEnd = false/);
});

test('the threshold opens at word gaps, not just between sentences', () => {
  // Too high and echo slips through; too low and the guard never opens, which
  // would disable barge-in rather than protect it. 0.10 of the smoothed 0..1 TTS
  // amplitude sits above gap noise and well below speech.
  const m = inject.match(/const SELF_LOUD_AMP = ([\d.]+)/);
  assert.ok(m, 'the bar needs to be a named constant, not inline');
  const v = Number(m[1]);
  assert.ok(v > 0.02 && v < 0.3, `${v} is outside the usable band`);
});

test('it does not touch STT gating', () => {
  // -55dB still decides what gets TRANSCRIBED. That question is "is there audio
  // worth hearing", which is not the same as "is someone taking the floor from
  // the bot" — conflating them is what caused the keystroke problem this file
  // already carries a comment about.
  assert.match(inject, /this\.speaking = db > -55/, 'the STT gate must stay independent');
  const block = inject.slice(inject.indexOf('let farEnd = db > FLOOR_SPEECH_DB'));
  assert.doesNotMatch(block.slice(0, 600), /this\.speaking =/, 'the guard must not rewrite the STT decision');
});

test('suppression is counted and reported, not silent', () => {
  // Without a number we would be guessing whether the guard is protecting
  // barge-in or quietly disabling it — and a guard that silently swallows real
  // interruptions is worse than the bug it fixes.
  assert.match(inject, /function noteEchoSuppressed\(\)/);
  assert.match(inject, /\[echo-guard\] suppressed/);
  // Sampled, because this runs every animation frame.
  assert.match(inject, /now - _echoLastLogAt < 15000/);
});

test('it can be turned off without an edit to the detection path', () => {
  // If this suppresses real barge-in in a way we cannot immediately diagnose,
  // the escape hatch has to be one flag, not surgery on the level check.
  assert.match(inject, /const ECHO_GUARD_ENABLED = /);
  assert.match(inject, /if \(farEnd && ECHO_GUARD_ENABLED\)/);
});
