// bot-alone-limit.test.mjs — a bot must not sit in a call by itself forever,
// however it ended up alone (#757).
//
// The reported incident: a bot waited 25 HOURS after the one person invited
// no-showed, and because it still counted as being in a call, the calendar
// auto-join gate in main.js skipped it the next afternoon — so one no-show
// silently ate the following day's meeting too.
//
// The cause was a guard doing exactly its job. #145's auto-leave only arms once
// the bot has seen another participant, so it does not bail out in the seconds
// after admission while Meet's people pane is still populating. Correct — and it
// makes the never-had-company case unreachable, because `_sawOtherParticipant`
// stays false forever. Nothing else capped the call: `realtimeMaxMinutes` is
// realtime-voice-only, so a bot on any other voice had no ceiling at all.
//
// The fix keeps that guard and adds a ceiling on being alone in general. Two
// design choices are load-bearing and each has a test below:
//
//   * It reads a TIMESTAMP on an interval rather than arming a one-shot timer.
//     A room nobody joins produces no participant events to hang a timer off
//     (the emit is edge-triggered on a change to the list), and a roster that
//     flickers would cancel and restart a one-shot forever without it maturing.
//   * The bot's agent is told WHICH ending it was. The MCP server used to report
//     "everyone else left and the bot was alone" for every auto-leave, which for
//     a no-show is untrue — and an agent told that writes up a meeting that
//     never happened instead of following up with whoever did not come.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const { PREFERENCES } = require('../electron-app/preferences-schema.js');

// The pref is a plain number of minutes with no integer constraint, so a
// sub-second value exercises the same arithmetic without a slow test. The
// watchdog ticks at limit/4, floored at 1s, so allow a tick or two.
const QUICK_MIN = 0.004;   // 240ms limit, 1s tick floor
const SETTLE = 1500;

// Every server here goes in-call, and going in-call fires a presence
// registration over HTTP and starts a heartbeat. Left running, those keep the
// test process alive long after the assertions are done, so hand each one back
// at the end. 'call-complete' is the real exit: it stops the presence
// heartbeat and resets the auto-leave state, exactly as a finished call does.
const built = [];
after(() => {
  for (const s of built) {
    try { s.setCallStatus('call-complete'); } catch { /* already torn down */ }
    clearInterval(s._aloneWatchdog);
    clearTimeout(s._autoLeaveTimer);
  }
});

function serverAlone({ prefs = {}, mode = 'active', company = false } = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (u) => spoken.push(u),
    onLeaveCall: () => { s._leaves = (s._leaves || 0) + 1; },
    getPref: (k) => prefs[k],
  });
  s.mode = mode;
  s.setRoom('abc-defg-hij');
  s.setCallStatus('in-call');
  s._spoken = spoken;
  s._seat = (...others) => s.setParticipants([{ name: 'Scripty', isSelf: true }, ...others]);
  s._seat(...(company ? [{ name: 'Christina' }] : []));
  built.push(s);
  return s;
}

const settle = (ms) => new Promise(r => setTimeout(r, ms));

// Capture the payload wait_for_speech would resolve with, which is what
// actually reaches the agent.
function waiterPayload(s) {
  return new Promise((resolve) => {
    s.waiters.push({ resolve, resolved: false, timer: null, silenceTimer: null, tickTimer: null });
  });
}

test('a bot nobody joins gives up once the limit passes', async () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN } });
  assert.ok(s._aloneWatchdog, 'the clock runs from admission, with no participant update to prompt it');
  assert.equal(s._leaves, undefined, 'and it has not fired yet');

  await settle(SETTLE);
  assert.equal(s._leaves, 1, 'the bot gave up and left');
});

test('a bot everyone walked out on also gives up — same ceiling, other route', async () => {
  // The 10s grace normally handles this far sooner. The ceiling is the backstop
  // for when it cannot, and it must not be reachable only by the no-show.
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN }, company: true });
  assert.equal(s._aloneSince, 0, 'not alone yet');
  s.autoLeaveGraceMs = 10_000_000;   // hold off the fast path, exercise the ceiling
  s._seat();                          // everyone leaves

  await settle(SETTLE);
  assert.equal(s._leaves, 1, 'it left on the ceiling rather than sitting there');
});

test('it leaves silently — there is nobody in the room to hear a goodbye', async () => {
  // The ordinary auto-leave says "Looks like I'm the only one here, signing
  // off", which is addressed to people who were there and have gone. Said into
  // a room that was empty the whole time it is only a line in the recording.
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN }, mode: 'active' });
  await settle(SETTLE);
  assert.equal(s._leaves, 1, 'it still left');
  assert.deepEqual(s._spoken, [], 'and said nothing on the way out');
});

test('the agent is told nobody came, not that everyone left', async () => {
  // The distinction the after-call work turns on: chase the no-show, or write
  // up the meeting. Reporting the wrong one produces confident fiction.
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN } });
  const data = await waiterPayload(s);
  assert.equal(data.autoLeft, true);
  assert.equal(data.autoLeftReason, 'no-show', 'a meeting nobody came to is its own ending');
});

test('and told the truth in the other direction too', async () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN }, company: true });
  s.autoLeaveGraceMs = 10_000_000;
  const payload = waiterPayload(s);
  s._seat();
  const data = await payload;
  assert.equal(data.autoLeftReason, 'left-alone', 'this one really was "everyone left"');
});

test('a call that ends under the bot is a third thing, not a no-show', async () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN }, company: true });
  const payload = waiterPayload(s);
  s.handleCallEnded('in-call UI collapsed');
  const data = await payload;
  assert.equal(data.autoLeftReason, 'call-ended');
});

test('somebody arriving stops the clock', async () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN } });
  s._seat({ name: 'Christina' });
  assert.equal(s._aloneSince, 0, 'the alone clock stops the moment the call is real');
  assert.equal(s._sawOtherParticipant, true);
  assert.equal(s.aloneForMs(), 0);

  await settle(SETTLE);
  assert.equal(s._leaves, undefined, 'and the bot is still in the call');
});

test('a late arrival, after the clock started but before the limit, is not stood up', async () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: 0.05 } });   // 3s
  await settle(600);
  s._seat({ name: 'Christina' });
  await settle(3500);
  assert.equal(s._leaves, undefined, 'someone who turns up late still gets their meeting');
});

test('a flickering roster does not keep resetting the clock', () => {
  // The reason this is a polled timestamp and not a cancellable timer. Under a
  // one-shot, a list that drops and restores every few seconds cancels the
  // timer before it ever matures, and the bot waits forever again by a second
  // route. Only a genuine sighting moves the clock forward.
  const s = serverAlone({ prefs: { botAloneLimitMinutes: 10 } });
  const startedAt = s._aloneSince;
  assert.ok(startedAt, 'alone from the start');

  s._seat();            // still alone — a redundant update, not a sighting
  s._seat();
  assert.equal(s._aloneSince, startedAt, 'repeated empty updates must not restart the wait');

  s._seat({ name: 'Christina' });
  assert.equal(s._aloneSince, 0, 'an actual sighting does reset it');
});

test('the #145 guard survives: the SHORT grace timer never arms before company', () => {
  // The ceiling must not become a backdoor into auto-leaving during admission,
  // which is the failure #145's guard exists to prevent.
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN } });
  assert.equal(s._autoLeaveTimer, null,
    'the 10s alone-grace timer stays unarmed until somebody has been seen');
});

test('0 means wait indefinitely — the old behaviour, kept as a choice', async () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: 0 } });
  assert.equal(s._aloneWatchdog, null, 'nothing armed');
  await settle(SETTLE);
  assert.equal(s._leaves, undefined, 'and nothing fired');
});

test('leaving the call stops the watchdog', () => {
  const s = serverAlone({ prefs: { botAloneLimitMinutes: QUICK_MIN } });
  assert.ok(s._aloneWatchdog);
  s.setCallStatus('call-complete');
  assert.equal(s._aloneWatchdog, null, 'a finished call must not drag a timer into the next one');
  assert.equal(s._aloneSince, 0);
});

test('the default is ten minutes, not never', () => {
  // The regression that mattered was an unbounded default, so the default is
  // the thing worth pinning.
  assert.equal(PREFERENCES.botAloneLimitMinutes.default, 10);
  assert.ok(PREFERENCES.botAloneLimitMinutes.default > 0, 'an unset pref must still cap the wait');

  const s = serverAlone({ prefs: {} });
  assert.ok(s._aloneWatchdog, 'a bot with no preferences set still gives up eventually');
  clearInterval(s._aloneWatchdog);
});
