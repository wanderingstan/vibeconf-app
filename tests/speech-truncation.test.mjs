// speech-truncation.test.mjs — #360: speak() reports success when barge-in
// truncated playback.
//
// speak answers at DISPATCH time (the floor gate), so a barge-in that cuts the
// utterance 15s in can only be reported after the fact. The fix records the
// truncation server-side — spoken prefix, unheard tail, unheard never-sent
// chunks — and surfaces it once on the next wait_for_speech or speak. A #350
// resume that replays the cut tail folds it back into "spoken" instead of
// telling the agent to repeat what is about to play anyway.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { splitAtWordFraction } = require('../electron-app/tts-chunking.js');
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const pageInject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
const provider = readFileSync(join(root, 'electron-app/google-meet-provider.js'), 'utf8');

// --- splitAtWordFraction --------------------------------------------------

test('splitAtWordFraction cuts at the word boundary nearest the fraction', () => {
  const { head, tail } = splitAtWordFraction('one two three four', 0.5);
  assert.equal(head, 'one two');
  assert.equal(tail, 'three four');
});

test('splitAtWordFraction extremes and degenerate input', () => {
  assert.deepEqual(splitAtWordFraction('hello there', 0), { head: '', tail: 'hello there' });
  assert.deepEqual(splitAtWordFraction('hello there', 1), { head: 'hello there', tail: '' });
  assert.deepEqual(splitAtWordFraction('', 0.5), { head: '', tail: '' });
  // No spaces at all: falls back to a character split rather than throwing.
  const { head, tail } = splitAtWordFraction('abcdefgh', 0.5);
  assert.equal(head + tail, 'abcdefgh');
});

// --- the truncation record on LocalServer ---------------------------------

function makeServer() {
  const s = new LocalServer({ port: 0, getPref: () => undefined });
  s.setRoom('test-room');
  return s;
}

test('a truncation is consumed exactly once, like the #253 playback failure', () => {
  const s = makeServer();
  s.noteSpeechTruncation({ spoken: 'Two things.', unspokenTail: 'First, it exists.', unspokenRest: '', cutSeconds: 14.2 });
  const t = s.takeSpeechTruncation();
  assert.equal(t.spoken, 'Two things.');
  assert.equal(t.unspokenTail, 'First, it exists.');
  assert.equal(t.cutSeconds, 14.2);
  assert.equal(s.takeSpeechTruncation(), null, 'consumed once');
});

test('a stale truncation is not reported', () => {
  const s = makeServer();
  s.noteSpeechTruncation({ spoken: 'a', unspokenTail: 'b', unspokenRest: '', cutSeconds: 1 });
  s._speechTruncation.at = Date.now() - 10 * 60 * 1000;
  assert.equal(s.takeSpeechTruncation(), null, 'ten minutes old is noise, not news');
});

test('a completed resume folds the tail back into spoken and clears the record', () => {
  const s = makeServer();
  s.noteSpeechTruncation({ spoken: 'Heard part.', unspokenTail: 'resumable tail.', unspokenRest: '', cutSeconds: 5 });
  s._speechTruncation.resumed = true;
  // While the resume is in flight the record must NOT be reported — the tail
  // is about to play, and "unheard" would push the agent to repeat it.
  assert.equal(s.takeSpeechTruncation(), null);
  s.noteSpeechPlaybackDrained();
  assert.equal(s._speechTruncation, null, 'fully delivered — nothing left to report');
});

test('a resume cannot recover chunks the synth loop never produced', () => {
  const s = makeServer();
  s.noteSpeechTruncation({ spoken: 'Heard.', unspokenTail: 'tail.', unspokenRest: 'Second sentence, never synthesized.', cutSeconds: 5 });
  s._speechTruncation.resumed = true;
  s.noteSpeechPlaybackDrained();
  const t = s.takeSpeechTruncation();
  assert.equal(t.spoken, 'Heard. tail.', 'the resumed tail counts as heard');
  assert.equal(t.unspokenTail, '');
  assert.equal(t.unspokenRest, 'Second sentence, never synthesized.', 'still unheard — the agent must learn this');
});

test('firing a #350 resume marks the record so the drain can settle it', () => {
  const s = makeServer();
  s.onResumeTts = () => {};
  s.noteSpeechTruncation({ spoken: 'a', unspokenTail: 'b', unspokenRest: '', cutSeconds: 2 });
  s._ttsInterruptedAt = Date.now();
  s._ttsInterruptWordsBaseline = 0;
  assert.equal(s._maybeResumeInterruptedTts(), true);
  assert.equal(s._speechTruncation.resumed, true);
});

test('the record rides resolved waits one-shot, and bare GETs do not consume it', () => {
  const s = makeServer();
  s.noteSpeechTruncation({ spoken: 'a', unspokenTail: 'b', unspokenRest: '', cutSeconds: 2 });
  const bare = s._buildResponse(null, 'Bot', null);
  assert.equal(bare.speechTruncated, null, 'a bare GET must not move the one-shot');
  const resolved = s._buildResponse(null, 'Bot', Date.now());
  assert.equal(resolved.speechTruncated.unspokenTail, 'b');
  const again = s._buildResponse(null, 'Bot', Date.now());
  assert.equal(again.speechTruncated, null, 'one-shot');
});

// --- the reporting chain exists end to end --------------------------------

test('renderer reports how far playback got, and the report reaches main', () => {
  // page-inject: the stop handler must post the played-to measurement instead
  // of only console.logging it (the #360 stranding).
  assert.match(pageInject, /action: 'tts-stopped'/);
  assert.match(pageInject, /droppedTags/);
  // preload relay
  assert.match(provider, /event\.data\.action === 'tts-stopped'/);
  // main pairs tags with chunk texts and hands the split to local-server
  assert.match(main, /ipcMain\.on\('tts-stopped'/);
  assert.match(main, /noteSpeechTruncation/);
  assert.match(main, /noteSpeechPlaybackDrained/);
});

test('the agent is told, in both places it might look', () => {
  // wait_for_speech note...
  assert.match(server, /formatSpeechTruncation/);
  assert.match(server, /CUT OFF — your previous utterance was interrupted/);
  const attached = (server.match(/\$\{truncLine\}/g) || []).length;
  assert.ok(attached >= 2, `expected the note on both wait_for_speech returns, saw ${attached}`);
  // ...and the next speak
  assert.match(server, /previousSpeechTruncated/);
});

test('speak no longer claims delivery it cannot know about', () => {
  assert.ok(server.includes('`Speaking: "${text}"`'),
    'the dispatch-time success line says "Speaking", not "Spoken"');
  assert.ok(!server.includes('`Spoken: "${text}"`'));
});
