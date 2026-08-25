// ack-volume.test.mjs — a murmur is quiet; taking the floor is not.
//
// ackVolume (0.35) was one knob for both ack pools. 06553b47 split it by POOL:
// short acks quiet, long acks full, on the reasoning that a short ack is
// backchannel and does not ask for the floor.
//
// #534: right about backchannel, wrong about how to detect it. Backchannel is
// defined by TIMING — it overlaps the speaker, which is why it does not need
// volume. Observed live: a short ack landing ~1.4s AFTER the speaker stopped,
// into a silent room, at a third of normal volume, backchannelling nothing. In
// silence the bot is taking the floor, which is the case the long pool was
// raised to full volume for.
//
// So quiet needs BOTH: a murmur, and someone to murmur under.
//
// Run: node --test tests/ack-volume.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const { PREFERENCES } = require('../electron-app/preferences-schema.js');

// decide() is async and reaches for ../completeness; exercise poolOf through it.
const ack = require('../electron-app/ack/index.js');

const prefsFor = (store) => store;

test('decide reports which pool the phrase came from', async () => {
  const store = { get: (k) => PREFERENCES[k]?.default };
  const long = await ack.decide({
    text: 'A properly finished sentence that runs well past the long threshold, '
      + 'with enough words in it to clear fifty and a full stop at the end.',
    wordCount: 60, addressivity: 'me-1on1', mode: 'active', recentTranscript: [], store,
  });
  assert.equal(long.pool, 'long', long.phrase);
  assert.ok(PREFERENCES.ackLongPhrases.default.includes(long.phrase));

  const short = await ack.decide({
    text: 'A shortish thing said in passing that is over twenty words but nowhere '
      + 'near fifty, so it draws a murmur.',
    wordCount: 25, addressivity: 'me-1on1', mode: 'active', recentTranscript: [], store,
  });
  assert.equal(short.pool, 'short', short.phrase);
});

test('an unknown phrase counts as short, not long', async () => {
  // An LLM-authored ack is covering latency, not claiming the floor. Defaulting
  // it to `long` would give every generated filler full volume.
  const store = { get: (k) => (k === 'ackLongPhrases' ? ['ONLY-THIS'] : PREFERENCES[k]?.default) };
  const r = await ack.decide({
    text: 'Anything at all.', wordCount: 25, addressivity: 'me-1on1',
    mode: 'active', recentTranscript: [], store,
  });
  assert.equal(r.pool, 'short');
});

test('a user who edits the pools cannot desync the volume from them', async () => {
  // poolOf tests MEMBERSHIP of the live pools rather than a flag computed
  // elsewhere, so a custom long pool still gets full volume.
  const store = { get: (k) => (k === 'ackLongPhrases' ? ['Hang on, thinking.'] : PREFERENCES[k]?.default) };
  const r = await ack.decide({
    text: 'A properly finished sentence that runs well past the long threshold, '
      + 'with enough words in it to clear fifty and a full stop at the end.',
    wordCount: 60, addressivity: 'me-1on1', mode: 'active', recentTranscript: [], store,
  });
  assert.equal(r.phrase, 'Hang on, thinking.');
  assert.equal(r.pool, 'long');
});

// --- the rule itself ------------------------------------------------------
const V = 0.35;
const vol = (o) => ack.speakOptionsFor({ ackVolume: V, ...o });

test('a murmur under a live speaker is quiet: the one case quiet is for', () => {
  assert.deepEqual(vol({ pool: 'short', anyoneSpeaking: true }), { volume: V });
});

test('the bug: a short ack landing in SILENCE plays at full volume', () => {
  // ~1.4s after the speaker stopped, backchannelling nothing. With nobody to
  // murmur under, the bot is taking the floor and wants to be heard.
  assert.equal(vol({ pool: 'short', anyoneSpeaking: false }), undefined);
});

test('a long ack is full volume whatever else is true', () => {
  // Announcing that the floor has changed hands is never backchannel, so the
  // timing test does not get to make it quiet.
  assert.equal(vol({ pool: 'long', anyoneSpeaking: true }), undefined);
  assert.equal(vol({ pool: 'long', anyoneSpeaking: false }), undefined);
});

test('an unusable ackVolume means full, not silent', () => {
  // Number(undefined) is NaN, and a NaN gain is a bot nobody can hear.
  assert.equal(ack.speakOptionsFor({ pool: 'short', anyoneSpeaking: true }), undefined);
  assert.equal(ack.speakOptionsFor({ pool: 'short', anyoneSpeaking: true, ackVolume: 'x' }), undefined);
  assert.deepEqual(ack.speakOptionsFor({ pool: 'short', anyoneSpeaking: true, ackVolume: 0 }), { volume: 0 });
});

test('both ack sites call the ONE rule, rather than keeping a copy', () => {
  // Duplicated ack logic has needed the same fix in two places repeatedly; the
  // pool split itself had to be applied twice. There is one function now.
  const calls = main.split('speakOptionsFor(').length - 1;
  assert.equal(calls, 2, 'both ack sites, and nowhere else');
  assert.ok(!/ackResult\.pool === 'long' \?/.test(main), 'the old inline rule is gone');
  const site = main.slice(main.indexOf('(triage-gated) Playing'));
  assert.match(site.slice(0, 800), /speakOptionsFor\(\{/, 'including the triage-gated one');
  assert.ok(!/if \(isLong\) speakText\(phrase\);/.test(main), 'its copy of the split is gone');
});

test('anyoneSpeaking is read at play time, from the live server', () => {
  // The question is about the moment the ack plays, so a value captured earlier
  // in the turn would answer the wrong question.
  const hits = main.split('anyoneSpeaking: localServer.anyoneSpeaking').length - 1;
  assert.equal(hits, 2, 'both sites read it live');
});

test('the preference says which acks the knob actually moves', () => {
  // The description is the only place a user learns this.
  const d = PREFERENCES.ackVolume.description;
  assert.match(d, /SHORT/);
  assert.match(d, /WHILE someone is still speaking/,
    'the timing condition is now half the rule and has to be stated');
  assert.match(d, /SILENCE/, 'and so does the case that changed');
});
