// no-show-leave.test.mjs — a bot that joins a call nobody ever turns up to has
// to give up eventually (#757).
//
// The reported incident: a bot sat in a call for 25 HOURS after the one person
// invited no-showed, and because it still counted as being in a call, the
// calendar auto-join gate in main.js skipped it the next afternoon — so one
// no-show silently ate the following day's meeting too.
//
// The cause was a guard doing exactly its job. #145's auto-leave only arms once
// the bot has seen another participant, so it does not bail out in the seconds
// after admission while Meet's people pane is still populating. Correct — and it
// makes the never-had-company case unreachable, because `_sawOtherParticipant`
// stays false forever. Nothing else capped the call: `realtimeMaxMinutes` is
// realtime-voice-only, so a bot on any other voice had no ceiling at all.
//
// The fix keeps that guard and gives the no-show its own, far longer countdown.
// These tests hold both halves: the new timer fires, and the old guard still
// refuses to arm the short one early.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const { PREFERENCES } = require('../electron-app/preferences-schema.js');

// 0.02 min = 1.2s of real waiting is too slow to pay on every run; the pref is
// a plain number of minutes with no integer constraint, so a sub-second value
// exercises the same arithmetic.
const QUICK_MIN = 0.004;   // 240ms

function serverAlone({ prefs = {}, mode = 'active' } = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (u) => spoken.push(u),
    onLeaveCall: () => { s._leftAt = Date.now(); s._leaves = (s._leaves || 0) + 1; },
    getPref: (k) => prefs[k],
  });
  s.mode = mode;
  s.setRoom('abc-defg-hij');
  s.setCallStatus('in-call');
  // Only the bot itself is in the room — the shape of a no-show.
  s.setParticipants([{ name: 'Scripty', isSelf: true }]);
  s._spoken = spoken;
  return s;
}

const settle = (ms) => new Promise(r => setTimeout(r, ms));

test('a bot nobody joins leaves once the no-show window passes', async () => {
  const s = serverAlone({ prefs: { noShowLeaveMinutes: QUICK_MIN } });
  assert.ok(s._noShowTimer, 'the countdown arms on admission, with no participant update to prompt it');
  assert.equal(s._leaves, undefined, 'and it has not fired yet');

  await settle(400);
  assert.equal(s._leaves, 1, 'the bot gave up and left');
});

test('it leaves silently — there is nobody in the room to hear a goodbye', async () => {
  // The ordinary auto-leave says "Looks like I'm the only one here, signing
  // off", which is addressed to people who were there and have gone. Said into
  // a room that was empty the whole time it is only a line in the recording.
  const s = serverAlone({ prefs: { noShowLeaveMinutes: QUICK_MIN }, mode: 'active' });
  await settle(400);
  assert.equal(s._leaves, 1, 'it still left');
  assert.deepEqual(s._spoken, [], 'and said nothing on the way out');
});

test('somebody arriving cancels the countdown', async () => {
  const s = serverAlone({ prefs: { noShowLeaveMinutes: QUICK_MIN } });
  s.setParticipants([{ name: 'Scripty', isSelf: true }, { name: 'Christina' }]);
  assert.equal(s._noShowTimer, null, 'the no-show clock stops the moment the call is real');
  assert.equal(s._sawOtherParticipant, true);

  await settle(400);
  assert.equal(s._leaves, undefined, 'and the bot is still in the call');
});

test('a late arrival, after the timer was armed but before it fires, is not stood up', async () => {
  const s = serverAlone({ prefs: { noShowLeaveMinutes: QUICK_MIN } });
  await settle(120);
  s.setParticipants([{ name: 'Scripty', isSelf: true }, { name: 'Christina' }]);
  await settle(400);
  assert.equal(s._leaves, undefined, 'someone who turns up five minutes late still gets their meeting');
});

test('the #145 guard survives: the SHORT grace timer never arms before company', () => {
  // The no-show fix must not be a backdoor into auto-leaving during admission,
  // which is the failure #145's guard exists to prevent.
  const s = serverAlone({ prefs: { noShowLeaveMinutes: QUICK_MIN } });
  assert.equal(s._autoLeaveTimer, null,
    'the 10s alone-grace timer stays unarmed until somebody has been seen');
});

test('0 means wait indefinitely — the old behaviour, kept as a choice', async () => {
  const s = serverAlone({ prefs: { noShowLeaveMinutes: 0 } });
  assert.equal(s._noShowTimer, null, 'nothing armed');
  await settle(400);
  assert.equal(s._leaves, undefined, 'and nothing fired');
});

test('leaving the call clears the countdown', () => {
  const s = serverAlone({ prefs: { noShowLeaveMinutes: QUICK_MIN } });
  assert.ok(s._noShowTimer);
  s.setCallStatus('call-complete');
  assert.equal(s._noShowTimer, null, 'a finished call must not drag a timer into the next one');
});

test('the default is ten minutes, not never', () => {
  // The regression that mattered was an unbounded default, so the default is
  // the thing worth pinning.
  assert.equal(PREFERENCES.noShowLeaveMinutes.default, 10);
  assert.ok(PREFERENCES.noShowLeaveMinutes.default > 0, 'an unset pref must still cap the wait');

  const s = serverAlone({ prefs: {} });
  assert.ok(s._noShowTimer, 'a bot with no preferences set still gives up eventually');
  clearTimeout(s._noShowTimer);
});
