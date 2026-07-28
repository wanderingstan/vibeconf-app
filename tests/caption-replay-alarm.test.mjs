// caption-replay-alarm.test.mjs — tests for the #12 REGRESSION ALARM, not for
// the fix itself (that's caption-replay.test.mjs).
//
// Why this exists: #402 closed an earlier set of replay paths on 2026-07-08 and
// looked healthy for two weeks, because nobody was watching. The 2026-07-22
// call showed it had been recurring the whole time. The symptom — a bot
// answering the same thing twice — reads as chattiness rather than a data bug,
// so human observation is not a reliable detector.
//
// Invariant under test: a turn's lastUpdated may only advance when its
// NORMALIZED text actually changed. lastUpdated is what _entriesSince(since)
// filters on, so bumping it without new words is what re-qualifies replayed
// history as fresh speech.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

function makeServer() {
  const s = new LocalServer({ port: 0 });
  s.setRoom('test-room');
  return s;
}

const T = (turnId, speaker, text, isBottommost = false) => ({ turnId, speaker, text, isBottommost });

test('new speech raises no alarm', () => {
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);
  s.updateTurns([T(2, 'Seth', 'And publish the receipts to YouTube.')]);
  assert.equal(s.replayAlarmCount, 0);
  assert.equal(s.errors.length, 0);
});

test('a caption still being typed raises no alarm', () => {
  // Growing text SHOULD move lastUpdated and re-surface to waiters — that's the
  // designed behaviour, and the alarm must not fire on it.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file', true)]);
  s.updateTurns([T(1, 'Stan', 'Can you file that', true)]);
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?', true)]);
  assert.equal(s.replayAlarmCount, 0, 'text growth is legitimate re-surfacing');
  assert.equal(s.errors.length, 0);
});

test('a healthy container re-render raises no alarm', () => {
  // The real #402/#12 scenario against FIXED code: history replays under fresh
  // scraper ids with cosmetic deltas. The fix absorbs it without touching
  // lastUpdated, so the alarm must stay silent.
  const s = makeServer();
  s.updateTurns([
    T(1, 'Stan', 'Can you file that as an issue?'),
    T(2, 'Seth', 'And publish the receipts to YouTube.'),
    T(3, 'Stan', 'Yeah, and check the accessibility contrast too.'),
  ]);
  s.updateTurns([
    T(101, 'Stan', 'Can you file that as an issue'),
    T(102, 'Seth', 'And publish the receipts to YouTube'),
    T(103, 'Stan', 'Yeah, and check the accessibility contrast too'),
  ]);
  assert.equal(s.turns.size, 3, 'replay must not create new turns');
  assert.equal(s.replayAlarmCount, 0, 'an absorbed replay is not a regression');
  assert.equal(s.errors.length, 0);
});

test('lastUpdated advancing on unchanged text trips the alarm', () => {
  // The regression itself, injected directly: whatever future code path causes
  // it, the outcome is a turn re-qualifying for `since` while saying nothing
  // new. Checking the outcome (not the `if (textChanged)` branch) is what makes
  // the alarm robust to a NEW path appearing.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);
  assert.equal(s.replayAlarmCount, 0);

  s.turns.get(1).lastUpdated = Date.now() + 5000;  // bumped, text untouched
  s.updateTurns([T(2, 'Seth', 'Anything else?')]);  // next batch runs the check

  assert.equal(s.replayAlarmCount, 1);
});

test('a cosmetic-only revision that bumps lastUpdated is caught', () => {
  // Path 1 of the beta-66 fix, reproduced: same words, different punctuation
  // and case. Normalization must see through the cosmetic delta, or the alarm
  // would miss the exact regression it exists to catch.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);

  const turn = s.turns.get(1);
  turn.text = 'can you file that as an issue';   // cosmetic only
  turn.lastUpdated = Date.now() + 5000;
  s.updateTurns([T(2, 'Seth', 'Anything else?')]);

  assert.equal(s.replayAlarmCount, 1, 'punctuation and case are not new speech');
});

test('the alarm reports once per session but keeps counting', () => {
  // A bad call must not flood the 10-entry ring buffer and evict every other
  // error, but the running total still has to be visible.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);
  for (let i = 1; i <= 4; i++) {
    s.turns.get(1).lastUpdated = Date.now() + i * 1000;
    s.updateTurns([T(100 + i, 'Seth', `filler ${i}`)]);
  }
  assert.equal(s.replayAlarmCount, 4, 'every violation counts');
  assert.equal(s.errors.length, 1, 'but only one entry reaches Recent Errors');
  assert.match(s.errors[0].message, /caption replay regression \(#12\)/);
});

test('the alarm surfaces through the Recent Errors channel', () => {
  // The point of addError() over a bare console.warn: get_room_info renders it,
  // so the bot driving the call sees it live.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);
  s.turns.get(1).lastUpdated = Date.now() + 5000;
  s.updateTurns([T(2, 'Seth', 'Anything else?')]);

  assert.equal(s.errors.length, 1);
  assert.ok(s.errors[0].timestamp, 'errors carry a timestamp');
  assert.match(s.errors[0].message, /capture the session log/, 'says what to do next');
});

test('repeated polling with an unchanged cursor is not a replay', () => {
  // Regression guard on the alarm itself. An earlier draft checked at DELIVERY
  // and treated "same `since` returns the same entries" as a replay — which is
  // correct behaviour, and made the alarm fire on healthy calls.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);
  const since = new Date(0).toISOString();
  s._buildResponse(since, 'Jimmy');
  s._buildResponse(since, 'Jimmy');
  s._buildResponse(since, 'Jimmy');
  assert.equal(s.replayAlarmCount, 0, 're-polling an unchanged cursor is legitimate');
  assert.equal(s.errors.length, 0);
});

test('leaving the room clears the alarm state', () => {
  // Stale state across calls would carry one call's count into the next.
  const s = makeServer();
  s.updateTurns([T(1, 'Stan', 'Can you file that as an issue?')]);
  s.turns.get(1).lastUpdated = Date.now() + 5000;
  s.updateTurns([T(2, 'Seth', 'Anything else?')]);
  assert.equal(s.replayAlarmCount, 1);

  s.setRoom('a-different-room');
  assert.equal(s.replayAlarmCount, 0);
  assert.equal(s._replayAlarmFired, false);
});
