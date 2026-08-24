// ack-volume-by-pool.test.mjs — a murmur is quiet; taking the floor is not.
//
// ackVolume (0.35) was one knob for both ack pools. Raised live 2026-08-24:
// turning the murmurs down to stop them reading as interruptions ALSO buried
// "Let me think about that." — which is a different speech act. A short ack is
// backchannel and does not ask for the floor, so quiet is right. A long ack
// announces the floor has changed hands and the bot is going away to answer;
// something taking the floor at a third of normal volume is just hard to hear.
//
// Run: node --test tests/ack-volume-by-pool.test.mjs

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

test('main gives long acks full volume and short acks ackVolume', () => {
  assert.match(main, /ackResult\.pool === 'long' \? undefined : Number\(prefValue\('ackVolume'\)\)/);
});

test('the triage-gated ack site makes the SAME split', () => {
  // It had its own copy of the pool choice and passed no volume at all, so both
  // pools were full volume there. Two sites, one rule.
  const site = main.slice(main.indexOf('(triage-gated) Playing'));
  assert.match(site.slice(0, 600), /if \(isLong\) speakText\(phrase\);/);
  assert.match(site.slice(0, 600), /volume: Number\(prefValue\('ackVolume'\)\)/);
});

test('the preference says it applies to SHORT acks only', () => {
  // The description is the only place a user learns which acks the knob moves.
  assert.match(PREFERENCES.ackVolume.description, /SHORT/);
  assert.match(PREFERENCES.ackVolume.description, /LONG acks .* NOT affected|always play at full volume/s);
});
