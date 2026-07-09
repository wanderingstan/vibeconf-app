// stash-replay.test.mjs — the barge-in stash must actually replay.
//
// Before this, replay was attempted ONLY from _resolveWaiter(reason='silence'),
// which requires an agent parked in wait_for_speech. Agents spend much of a call
// outside that long-poll (composing, running tools). Measured on one real
// 30-minute call: 13 stashes, 0 replays. The bot raised its hand, held the
// thought, and threw it away — then re-derived it from scratch on the next turn.
//
// The fix moves replay onto the room's own speech-stop edge, where it belongs.
// These tests pin that: a stash replays with ZERO waiters, and the relevance
// guards still get the last word.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const SILENCE_S = 0.02; // 20ms silence gate, so tests don't sleep for seconds

function makeServer(prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text) => spoken.push(text),
    getPref: (k) => ({
      defaultSilenceSeconds: SILENCE_S,
      bargeInStashMaxAgeMs: 45_000,
      bargeInStashRedeliverMaxNewWords: 15,
      probeFiring: false,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.spoken = spoken;
  return s;
}

// Drive the speech-stop edge the way setParticipants does: someone was
// speaking, now nobody is.
function stopSpeaking(s) {
  s.anyoneSpeaking = true;
  s.setParticipants([{ name: 'Stan', speaking: false, isSelf: false }]);
}

function startSpeaking(s) {
  s.anyoneSpeaking = false;
  s.setParticipants([{ name: 'Stan', speaking: true, isSelf: false }]);
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function stash(s, text, { wordsAtStash = 0, ageMs = 0 } = {}) {
  s.bargeInStash = {
    entries: [{ text }],
    at: Date.now() - ageMs,
    wordsAtStash,
  };
  s._setBotState('yielding', { reason: 'user-speaking' }, { force: true });
}

test('a stash replays on a floor opening with NO waiter parked — the whole point', async () => {
  const s = makeServer();
  stash(s, 'The fast model was solving the wrong second.');
  assert.equal(s.waiters.length, 0, 'precondition: agent is off-loop');

  stopSpeaking(s);
  await settle();

  assert.deepEqual(s.spoken, ['The fast model was solving the wrong second.']);
  assert.equal(s.bargeInStash, null, 'stash consumed');
  assert.deepEqual(s._lastReplayedStash, ['The fast model was solving the wrong second.'],
    'agent must learn on its next resolve that the thought already went out');
});

test('the raised hand stays up while the stash waits for its opening', () => {
  const s = makeServer();
  stash(s, 'held thought');
  assert.equal(s.botState, 'yielding');

  // Interrupter stops. Before the fix this immediately dropped to idle/listening,
  // so the hand fell even though a thought was still queued.
  stopSpeaking(s);
  assert.equal(s.botState, 'yielding', 'hand stays up until the stash resolves');
});

test('the hand comes down when the guards discard the stash', async () => {
  const s = makeServer();
  stash(s, 'stale thought', { ageMs: 90_000 }); // past the 45s bar
  stopSpeaking(s);
  await settle();

  assert.deepEqual(s.spoken, [], 'nothing spoken');
  assert.equal(s.bargeInStash, null, 'discarded');
  assert.notEqual(s.botState, 'yielding', 'hand lowered — nothing is queued anymore');
});

test('a stash older than bargeInStashMaxAgeMs is discarded, not spoken', async () => {
  const s = makeServer({ bargeInStashMaxAgeMs: 1000 });
  stash(s, 'too old', { ageMs: 5000 });
  stopSpeaking(s);
  await settle();
  assert.deepEqual(s.spoken, []);
  assert.equal(s.bargeInStash, null);
});

test('a stash survives a false opening and replays on the next real one', async () => {
  const s = makeServer();
  stash(s, 'patient thought');

  stopSpeaking(s);          // floor opens...
  startSpeaking(s);         // ...and closes again before the gate elapses
  await settle();
  assert.deepEqual(s.spoken, [], 'must not talk over the resumed speaker');
  assert.ok(s.bargeInStash, 'stash survives — it re-arms on the next stop');

  stopSpeaking(s);          // a real opening this time
  await settle();
  assert.deepEqual(s.spoken, ['patient thought']);
});

test('the bot never replays over someone who is still talking', async () => {
  const s = makeServer();
  stash(s, 'should not fire');
  stopSpeaking(s);
  s.anyoneSpeaking = true; // someone resumed inside the gate window
  await settle();
  assert.deepEqual(s.spoken, []);
  assert.ok(s.bargeInStash, 'still held, not discarded');
});

test('silent mode holds the stash rather than speaking it', async () => {
  const s = makeServer();
  s.mode = 'silent';
  stash(s, 'unspoken');
  stopSpeaking(s);
  await settle();
  assert.deepEqual(s.spoken, [], 'silent mode acts but never speaks');
});

test('overwriting an unplayed stash is logged, not silent', () => {
  const s = makeServer();
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    s.bargeInStash = { entries: [{ text: 'first thought' }], at: Date.now(), wordsAtStash: 0 };
    s.pendingBotSpeech = [{ text: 'second thought' }];
    s._performBackOff('user-speaking');
  } finally {
    console.log = orig;
  }
  assert.ok(
    lines.some((l) => /overwriting an unplayed stash/.test(l)),
    'a discarded thought must leave a trace in the log'
  );
});
