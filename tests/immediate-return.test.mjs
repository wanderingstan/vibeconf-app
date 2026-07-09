// immediate-return.test.mjs — wait_for_speech's "speech already finished while
// you were away" fast path.
//
// Two problems, both invisible because the path logs nothing and never creates
// a waiter (so none of the [resolve] lines fire):
//
//   1. It measured silence from `timestamp` = firstSeen, i.e. when the speaker
//      STARTED the turn. Any utterance longer than the silence bar therefore
//      returned INSTANTLY, mid-sentence, handing the agent a half-finished
//      caption. This is the "it processed my speech literally while I was in
//      the middle of a sentence" report.
//
//   2. It never checked anyoneSpeaking, so it would fire while a human still
//      had the floor.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const SILENCE_S = 1.4;

function makeServer() {
  const s = new LocalServer({
    port: 0,
    getPref: (k) => ({ defaultMaxWaitForSpeechSec: 55, defaultSilenceSeconds: SILENCE_S })[k],
  });
  s.setRoom('r');
  s.callStatus = 'in-call';
  return s;
}

// Add a caption turn: started `startedMsAgo` ago, last grew `grewMsAgo` ago.
function addTurn(s, { text = 'a fairly long sentence that is still going', startedMsAgo, grewMsAgo }) {
  const now = Date.now();
  s.turns.set('t1', {
    id: 't1', speaker: 'Stan', text, settled: false,
    firstSeen: now - startedMsAgo,
    lastUpdated: now - grewMsAgo,
  });
}

// The fast-path decision, isolated from HTTP. Calls the SAME _quietMsSince the
// handler uses, so this test cannot silently drift from the shipped logic.
function wouldReturnImmediately(s) {
  const existing = s._entriesSince(null, 'jimmy');
  if (existing.length === 0 || s.anyoneSpeaking) return false;
  return s._quietMsSince(existing) >= SILENCE_S * 1000;
}

test('a long, STILL-GROWING turn does not trigger an immediate return', () => {
  const s = makeServer();
  // Speaker started 20s ago; last caption arrived 200ms ago. They are mid-sentence.
  addTurn(s, { startedMsAgo: 20_000, grewMsAgo: 200 });
  assert.equal(wouldReturnImmediately(s), false,
    'firstSeen is 20s old, but the speaker is still talking — must wait');
});

test('a finished turn DOES trigger an immediate return', () => {
  const s = makeServer();
  // Speaker started 20s ago and stopped 3s ago — genuinely past the bar.
  addTurn(s, { startedMsAgo: 20_000, grewMsAgo: 3_000 });
  assert.equal(wouldReturnImmediately(s), true);
});

test('the boundary is measured from the last word, not the first', () => {
  const s = makeServer();
  addTurn(s, { startedMsAgo: 60_000, grewMsAgo: SILENCE_S * 1000 - 100 }); // just inside
  assert.equal(wouldReturnImmediately(s), false);
  addTurn(s, { startedMsAgo: 60_000, grewMsAgo: SILENCE_S * 1000 + 100 }); // just past
  assert.equal(wouldReturnImmediately(s), true);
});

test('never returns immediately while someone still holds the floor', () => {
  const s = makeServer();
  addTurn(s, { startedMsAgo: 20_000, grewMsAgo: 5_000 }); // stale caption...
  s.anyoneSpeaking = true;                                 // ...but audio says otherwise
  assert.equal(wouldReturnImmediately(s), false,
    'a frozen caption tracker must not let the bot cut in');
});

test('entries sorted by firstSeen: the freshest is not always last', () => {
  const s = makeServer();
  const now = Date.now();
  // Alice started FIRST but is still talking; Bob started later and finished.
  s.turns.set('a', { id: 'a', speaker: 'Alice', text: 'i was saying that', settled: false,
    firstSeen: now - 30_000, lastUpdated: now - 100 });
  s.turns.set('b', { id: 'b', speaker: 'Bob', text: 'right.', settled: true,
    firstSeen: now - 10_000, lastUpdated: now - 9_000 });
  const entries = s._entriesSince(null, 'jimmy');
  assert.equal(entries[entries.length - 1].participantName, 'Bob',
    'sorted by firstSeen, so the LAST entry is the stale one');
  assert.equal(wouldReturnImmediately(s), false,
    'taking the max lastUpdated keeps us from cutting off Alice');
});

test('no undelivered entries means no immediate return', () => {
  const s = makeServer();
  assert.equal(wouldReturnImmediately(s), false);
});

test('bot-speech entries have no lastUpdated and fall back to timestamp', () => {
  const s = makeServer();
  s.transcripts.push({
    participantName: 'jimmy', role: 'bot', text: 'here you go',
    timestamp: new Date(Date.now() - 5_000).toISOString(),
  });
  // Filtered out for bot='jimmy', so nothing to deliver.
  assert.equal(wouldReturnImmediately(s), false);
  // For a different bot name it is deliverable, and the fallback must not throw.
  const entries = s._entriesSince(null, 'someone-else');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lastUpdated, undefined);
});
