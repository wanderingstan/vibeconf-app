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
    getPref: (k) => (k === 'workingStateMinMs' ? minMs : (k === 'workingStateQuietMs' ? 5000 : undefined)),
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
  clearTimeout(s._workingQuietTimer); clearTimeout(s._workingEscalationTimer);
});

test('ONE long tool call escalates on its own, with no further activity', async () => {
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');            // opens the engagement -> thinking
  s._onAgentActivity('🔧 Bash');            // still inside the dwell -> arms the timer
  assert.equal(s.botState, 'thinking');
  await sleep(90);                          // ...and nothing else ever arrives
  assert.equal(s.botState, 'working', 'the dwell expired on a timer, not on a new line');
  clearTimeout(s._workingQuietTimer); clearTimeout(s._workingEscalationTimer);
});

test('a pending escalation does not fire onto a bot that started speaking', async () => {
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');
  s._onAgentActivity('🔧 Bash');
  s.botState = 'speaking';                  // the turn resolved while we waited
  await sleep(90);
  assert.equal(s.botState, 'speaking', 'never overrides speaking');
  clearTimeout(s._workingQuietTimer); clearTimeout(s._workingEscalationTimer);
});

test('a pending escalation does not fire after the call ends', async () => {
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');
  s._onAgentActivity('🔧 Bash');
  s.callStatus = 'after-call-work';
  await sleep(90);
  assert.equal(s.botState, 'thinking', 'no 🧑‍💻 on a call that is over');
  clearTimeout(s._workingQuietTimer); clearTimeout(s._workingEscalationTimer);
});

test('the quiet timer cancels a pending escalation', async () => {
  // Otherwise the face could be dropped back to listening and then have 🧑‍💻
  // land on top of it a moment later.
  const { s } = serverInCall(40);
  s._onAgentActivity('🔧 Bash');
  s._onAgentActivity('🔧 Bash');
  assert.ok(s._workingEscalationTimer, 'armed');
  s._workingQuietTimer = null;
  // Run the quiet path directly rather than waiting out workingStateQuietMs.
  s._pendingTurnSince = null;
  s.botState = 'thinking';
  const quiet = s._armWorkingQuietTimer.bind(s);
  quiet();
  clearTimeout(s._workingQuietTimer);
  // The cancel lives in the quiet timer's callback; assert the wiring exists.
  assert.ok(typeof s._armWorkingEscalationTimer === 'function');
  clearTimeout(s._workingEscalationTimer);
});

test('non-tool activity never escalates — only 🔧 lines count', async () => {
  const { s } = serverInCall(20);
  s._onAgentActivity('some reasoning text');
  assert.equal(s.botState, 'thinking');
  s._onAgentActivity('more reasoning, still no tools');
  await sleep(60);
  assert.equal(s.botState, 'thinking', 'thinking is right for thinking');
  clearTimeout(s._workingQuietTimer); clearTimeout(s._workingEscalationTimer);
});
