// name-mention-fast-resolve.test.mjs — #359: a name mention anywhere in an
// utterance shortens the wait_for_speech silence gate (_checkWaiters), the
// same rule and the same pref (nameMentionSilenceSeconds) that also shortens
// the barge-in stash-opening wait (see stash-replay.test.mjs).
//
// Before #359 this only fired when the name landed at the END of the
// utterance, to avoid cutting off a still-talking speaker ("hey Jimmy, how's
// it going?"). That restriction is gone: position in an utterance is an
// unreliable signal (more so across languages), and the check only ever
// SHORTENS an already silence-gated wait — it never skips the wait outright
// — so there was never actually a speaker to cut off.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const T = (turnId, speaker, text, isBottommost = true) => ({ turnId, speaker, text, isBottommost });

function makeServer(prefs = {}) {
  const s = new LocalServer({
    port: 0,
    getPref: (k) => ({
      defaultSilenceSeconds: 9999,
      nameMentionSilenceSeconds: 0,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  return s;
}

// Bypass the HTTP wait_for_speech plumbing and push a waiter object directly
// — _checkWaiters only cares about the shape below.
function pushWaiter(s, { bot, silence = 9999 } = {}) {
  const resolved = [];
  const waiter = {
    resolve: (r) => resolved.push(r),
    since: null,
    bot,
    silence,
    startTime: Date.now(),
    resolved: false,
    silenceTimer: null,
    tickTimer: null,
    timer: setTimeout(() => {}, 100_000),
  };
  s.waiters.push(waiter);
  return { waiter, resolved };
}

// _checkWaiters arms waiter.silenceTimer (and possibly tickTimer) as a side
// effect even when it doesn't resolve — with the huge defaultSilenceSeconds
// used below, that timer's delay is ~hours, which leaves an open handle and
// hangs the test runner if not cleared.
function cleanupWaiter(waiter) {
  clearTimeout(waiter.timer);
  clearTimeout(waiter.silenceTimer);
  clearTimeout(waiter.tickTimer);
}

test('#359: a name mention at the START of an utterance still fast-resolves', () => {
  const s = makeServer();
  s.anyoneSpeaking = false;
  s.lastSpeechStoppedAt = Date.now() - 10_000; // long enough ago to already clear a 0s gate
  s.updateTurns([T(1, 'Stan', 'Jimmy, go ahead')]);
  const { waiter, resolved } = pushWaiter(s, { bot: 'Jimmy' });

  s._checkWaiters();

  assert.equal(resolved.length, 1,
    'name-mention (anywhere) should fast-resolve despite a huge default silence — ' +
    'before #359 this required the name at the END and would still be waiting');
  cleanupWaiter(waiter);
});

test('#359: a name mention mid-sentence also fast-resolves', () => {
  const s = makeServer();
  s.anyoneSpeaking = false;
  s.lastSpeechStoppedAt = Date.now() - 10_000;
  s.updateTurns([T(1, 'Stan', 'so Jimmy do you think we should ship this today or wait')]);
  const { waiter, resolved } = pushWaiter(s, { bot: 'Jimmy' });

  s._checkWaiters();

  assert.equal(resolved.length, 1, 'mid-sentence mention must fast-resolve too');
  cleanupWaiter(waiter);
});

test('no name mention keeps the full (slow) wait', () => {
  const s = makeServer();
  s.anyoneSpeaking = false;
  s.lastSpeechStoppedAt = Date.now() - 10_000;
  s.updateTurns([T(1, 'Stan', 'sure, sounds good to me')]);
  const { waiter, resolved } = pushWaiter(s, { bot: 'Jimmy' });

  s._checkWaiters();

  assert.equal(resolved.length, 0, 'without a mention the huge defaultSilenceSeconds gate must still be open');
  cleanupWaiter(waiter);
});
