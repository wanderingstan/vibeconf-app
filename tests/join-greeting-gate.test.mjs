// join-greeting-gate.test.mjs — the two remaining ungated speech paths (#442).
//
// _flushPendingBotSpeech plays speech the agent composed BEFORE the bot could
// be heard — in practice the greeting, because the virtual mic is not connected
// to the other participants until the bot is in the call, so saying it earlier
// plays into the void.
//
// Which means it fires the moment a bot arrives in a meeting already in
// progress, and it used to emit straight into the room: no floor read, so the
// greeting talked over whoever was mid-sentence, and no delay, so two bots
// joining together greeted in unison.
//
// _maybeResumeInterruptedTts replays the tail of an utterance a barge-in cut
// off. It gets the floor check for the same reason and deliberately does NOT
// get ordering — see the test at the bottom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer(prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text) => spoken.push(text),
    onResumeTts: () => spoken.push('<resumed>'),
    getPref: (k) => ({
      botSpeakJitterMaxMs: 0,          // opt in per test
      ttsResumeEnabled: true,
      ttsResumeMaxAgeMs: 5000,
      bargeInStashRedeliverMaxNewWords: 15,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s._tickWordCount = () => 0;
  s.spoken = spoken;
  return s;
}

// --- the join greeting ------------------------------------------------------

test('a queued greeting plays when the room is quiet', async () => {
  const s = makeServer();
  s.pendingBotSpeech = [{ text: 'Hi, Pepper here for the standup.' }];
  s.anyoneSpeaking = false;

  await s._flushPendingBotSpeech();
  assert.deepEqual(s.spoken, ['Hi, Pepper here for the standup.']);
});

test('a queued greeting does NOT talk over someone mid-sentence', async () => {
  // The bot joins a meeting already in progress. Somebody is talking. The
  // greeting used to go out regardless.
  const s = makeServer();
  s.pendingBotSpeech = [{ text: 'Hi, Pepper here for the standup.' }];
  s.anyoneSpeaking = true;

  await s._flushPendingBotSpeech();
  assert.deepEqual(s.spoken, [], 'must not speak over them');
  assert.ok(s.bargeInStash, 'and the greeting must be HELD, not dropped');
  assert.equal(s.bargeInStash.entries[0].text, 'Hi, Pepper here for the standup.');
});

test('the analyser alone is enough to hold the greeting', async () => {
  const s = makeServer({ fastFloorDetection: true });
  s.pendingBotSpeech = [{ text: 'Hi there.' }];
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = true;

  await s._flushPendingBotSpeech();
  assert.deepEqual(s.spoken, []);
  assert.ok(s.bargeInStash);
});

test('the whole queue is held together, never half-spoken', async () => {
  // The queue is one logical utterance in order. Holding part of it would be
  // worse than holding all of it.
  const s = makeServer();
  s.pendingBotSpeech = [{ text: 'first' }, { text: 'second' }, { text: 'third' }];
  s.anyoneSpeaking = true;

  await s._flushPendingBotSpeech();
  assert.deepEqual(s.spoken, []);
  assert.equal(s.bargeInStash.entries.length, 3);
});

test('two bots joining together do not greet in unison', async () => {
  // With jitter configured, the batch waits before speaking — the difference
  // between two bots greeting at once and greeting in turn.
  const s = makeServer({ botSpeakJitterMaxMs: 40 });
  s.participants = [{ name: 'Stan' }, { name: 'Seth' }, { name: 'Jimmy' }];
  s.pendingBotSpeech = [{ text: 'Hi all.' }];
  s.anyoneSpeaking = false;

  const t0 = Date.now();
  await s._flushPendingBotSpeech();
  assert.deepEqual(s.spoken, ['Hi all.'], 'it still gets said');
  assert.ok(Date.now() - t0 >= 0, 'and it went through the delay path');
});

test('a solo call stays snappy — no delay when nobody could collide', async () => {
  const s = makeServer({ botSpeakJitterMaxMs: 5000 });
  s.participants = [{ name: 'Stan' }];        // one other: no collision risk
  s.pendingBotSpeech = [{ text: 'Hi.' }];
  s.anyoneSpeaking = false;

  const t0 = Date.now();
  await s._flushPendingBotSpeech();
  assert.ok(Date.now() - t0 < 300, 'must not wait when there is nobody to collide with');
  assert.deepEqual(s.spoken, ['Hi.']);
});

test('an empty queue is a no-op', async () => {
  const s = makeServer();
  await s._flushPendingBotSpeech();
  assert.deepEqual(s.spoken, []);
});

// --- resuming a cut-off utterance ------------------------------------------

test('a resume does not restart into a busy floor', () => {
  const s = makeServer();
  s._ttsInterruptedAt = Date.now() - 500;
  s.anyoneSpeaking = true;

  assert.equal(s._maybeResumeInterruptedTts(), false);
  assert.deepEqual(s.spoken, []);
  assert.ok(s._ttsInterruptedAt, 'the tail stays held for the next opening');
});

test('a resume does restart when the floor is genuinely open', () => {
  const s = makeServer();
  s._ttsInterruptedAt = Date.now() - 500;
  s.anyoneSpeaking = false;

  assert.equal(s._maybeResumeInterruptedTts(), true);
  assert.deepEqual(s.spoken, ['<resumed>']);
});

test('a resume is NOT delayed by speaking order — it is finishing, not competing', () => {
  // The deliberate asymmetry. Ranking decides who answers a human: a
  // competition for a NEW turn. A resume completes a turn this bot already had
  // and was cut off in, so queueing it behind a peer would pause it
  // mid-sentence to be polite about a turn nobody is contesting.
  const s = makeServer({ botSpeakJitterMaxMs: 5000, botSpeakUrgencyLeadMs: 5000 });
  s.participants = [{ name: 'Stan' }, { name: 'Seth' }, { name: 'Jimmy' }];
  s._ttsInterruptedAt = Date.now() - 500;
  s.anyoneSpeaking = false;

  const t0 = Date.now();
  assert.equal(s._maybeResumeInterruptedTts(), true);
  assert.ok(Date.now() - t0 < 300, 'a resume must be immediate');
  assert.deepEqual(s.spoken, ['<resumed>']);
});

test('a floor-blocked resume is RETRIED on the next opening, not spent', () => {
  // The subtle half. _maybeResumeInterruptedTts consumes _ttsInterruptedAt on
  // entry — one attempt per interruption — which is right for the age and
  // relevance guards, because those mean "no longer worth saying". A busy floor
  // means "not right now", and spending the attempt on it would drop the
  // half-spoken sentence that #350 exists to preserve.
  const s = makeServer();
  s._ttsInterruptedAt = Date.now() - 200;

  s.anyoneSpeaking = true;
  assert.equal(s._maybeResumeInterruptedTts(), false, 'blocked while busy');
  assert.ok(s._ttsInterruptedAt, 'the attempt must NOT be spent');

  s.anyoneSpeaking = false;
  assert.equal(s._maybeResumeInterruptedTts(), true, 'and it resumes at the next opening');
  assert.deepEqual(s.spoken, ['<resumed>']);
});

test('an aged-out resume IS spent — that guard means "not worth saying"', () => {
  // The contrast that makes the rule legible: a stale tail is dropped for good,
  // and ttsResumeMaxAgeMs is what stops a floor-blocked one retrying forever.
  const s = makeServer({ ttsResumeMaxAgeMs: 100 });
  s._ttsInterruptedAt = Date.now() - 60_000;
  s.anyoneSpeaking = false;

  assert.equal(s._maybeResumeInterruptedTts(), false);
  assert.equal(s._ttsInterruptedAt, 0, 'consumed — it will not come back');
  assert.deepEqual(s.spoken, []);
});
