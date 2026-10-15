// working-face-on-long-tools.test.mjs — 🧑‍💻 for ONE long tool call (#339 gap).
//
// The 🤔→🧑‍💻 dwell was only ever checked inline, on arrival of a tool line. That
// works for a burst of quick calls: each new line re-checks the clock, so the
// face escalates on whichever one crosses workingStateMinMs.
//
// A SINGLE long tool call produces one line and then silence. Nothing re-checks,
// and the avatar sits on 🤔 for the whole thing — exactly backwards, since a
// five-minute build is when the bot is least able to reply and the room most
// needs to see it is heads-down. Reported 2026-08-24 as "a minor annoyance for a
// long time".
//
// Run: node --test tests/working-face-on-long-tools.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const serverInCall = (minMs = 40) => {
  const states = [];
  const s = new LocalServer({
    port: 0,
    getPref: (k) => (k === 'workingStateMinMs' ? minMs : (k === 'workingStateStaleMs' ? 60_000 : undefined)),
    onBotStateChange: (state) => states.push(state),
  });
  s.callStatus = 'in-call';
  s.botState = 'listening';
  return { s, states };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a burst of tool lines still escalates (the case that already worked)', async () => {
  const { s } = serverInCall(30);
  s._onAgentActivity('🔧 Bash');
  assert.equal(s.botState, 'thinking', 'first activity opens the engagement');
  await sleep(50);
  s._onAgentActivity('🔧 Bash');           // a second line re-checks the clock
  assert.equal(s.botState, 'working');
  clearTimeout(s._workingStaleTimer); clearTimeout(s._workingEscalationTimer);
});

test('ONE long tool call escalates on its own, with no further activity', async () => {
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');            // opens the engagement -> thinking
  s._onAgentActivity('🔧 Bash');            // still inside the dwell -> arms the timer
  assert.equal(s.botState, 'thinking');
  await sleep(90);                          // ...and nothing else ever arrives
  assert.equal(s.botState, 'working', 'the dwell expired on a timer, not on a new line');
  clearTimeout(s._workingStaleTimer); clearTimeout(s._workingEscalationTimer);
});

test('a pending escalation does not fire onto a bot that started speaking', async () => {
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');
  s._onAgentActivity('🔧 Bash');
  s.botState = 'speaking';                  // the turn resolved while we waited
  await sleep(90);
  assert.equal(s.botState, 'speaking', 'never overrides speaking');
  clearTimeout(s._workingStaleTimer); clearTimeout(s._workingEscalationTimer);
});

test('a pending escalation does not fire after the call ends', async () => {
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');
  s._onAgentActivity('🔧 Bash');
  s.callStatus = 'after-call-work';
  await sleep(90);
  assert.equal(s.botState, 'thinking', 'no 🧑‍💻 on a call that is over');
  clearTimeout(s._workingStaleTimer); clearTimeout(s._workingEscalationTimer);
});

test('ending the engagement cancels a pending escalation', async () => {
  // Otherwise the face could return to listening and then have 🧑‍💻 land on
  // top of it a moment later. Since #824 the engagement ends on the agent
  // going back to listening (or speaking), not on a quiet timer.
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');
  assert.ok(s._workingEscalationTimer, 'armed by the first line');
  s._setBotState('listening', undefined, { force: true });
  assert.equal(s._workingEscalationTimer, null, 'cancelled with the engagement');
  assert.equal(s._workingStaleTimer, null, 'and so is the safety net');
  await sleep(70);
  assert.equal(s.botState, 'listening');
});

test('any non-conversation activity escalates, whatever its glyph (#824)', async () => {
  // Before #824 only 🔧 lines could escalate, and only a SECOND one inside the
  // window. An engagement of reasoning/text lines, or of one line per window,
  // sat on 🤔 indefinitely.
  const { s } = serverInCall(20);
  s._onAgentActivity('🗣 checking the merge order');
  assert.equal(s.botState, 'thinking');
  await sleep(60);
  assert.equal(s.botState, 'working', 'the dwell expired on its own');
  clearTimeout(s._workingStaleTimer); clearTimeout(s._workingEscalationTimer);
});

test('the bot\'s own speak / wait_for_speech lines are not work', async () => {
  // `speak` is the reply and wait_for_speech is the return to listening; both
  // used to count as tool lines, flashing 🧑‍💻 right as the bot re-engaged.
  const { s } = serverInCall(20);
  s._onAgentActivity('🔧 wait_for_speech');
  s._onAgentActivity('🔧 speak');
  assert.equal(s.botState, 'listening', 'neither opens an engagement');
  assert.equal(s._workingEscalationTimer, null);
});
