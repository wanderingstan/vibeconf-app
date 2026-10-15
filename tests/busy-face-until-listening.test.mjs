// busy-face-until-listening.test.mjs — #824: 🧑‍💻 stays up until the bot listens.
//
// 2026-10-15, call suc-skmh-yqt-20261015T201805Z: the bot spent about four
// minutes merging seven PRs. The activity feed produced one line per long tool
// call (`gh pr merge` + `sleep`), 15-25s apart. The 8s quiet timer read every
// gap as "done" and dropped the face to 😔 idle, the next line restarted the
// 🤔 dwell from zero, and the escalation (armed only by a SECOND tool line
// inside the window) never fired. Stan spoke and the face said 😐 "hearing",
// then 🫥 once the HTTP-silence inference called the agent away.
//
// Stan's rule: stay on 🧑‍💻 for as long as the bot is not listening.
//
// Run: node --test tests/busy-face-until-listening.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MIN_MS = 2500;
const STALE_MS = 15 * 60_000;
const NOW = Date.parse('2026-10-15T20:21:09Z'); // mocked Date must not start at 0 (falsy = 'never attached')

function serverInCall() {
  const states = [];
  const s = new LocalServer({
    port: 0,
    getPref: (k) => ({
      workingStateMinMs: MIN_MS,
      workingStateStaleMs: STALE_MS,
      defaultMaxWaitForSpeechSec: 55,
      defaultSilenceSeconds: 1.4,
    })[k],
    onBotStateChange: (state) => states.push(state),
  });
  s.setRoom('suc-skmh-yqt');
  s.callStatus = 'in-call';
  s.botState = 'listening';
  // The bot spoke its "merging now" reply already — nothing pending.
  s._pendingTurnSince = null;
  return { s, states };
}

// The agent's next wait_for_speech, through the shipped HTTP handler.
function startWait(s) {
  const res = { writeHead() {}, end() {} };
  const req = { on() {} };
  const url = new URL('http://127.0.0.1/api/sync/suc-skmh-yqt?wait=30');
  s._handleGet(req, res, url, 'suc-skmh-yqt');
}

function release(s) {
  for (const w of [...s.waiters]) {
    clearTimeout(w.timer); clearTimeout(w.silenceTimer); clearTimeout(w.tickTimer);
    if (!w.resolved) { w.resolved = true; w.resolve({ success: true, transcript: { entries: [] } }); }
  }
  s.waiters = [];
  s._endWorkingEngagement();
}

test('the 2026-10-15 merge run: one line every ~20s for four minutes stays 🧑‍💻 throughout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s, states } = serverInCall();
  s._onAgentActivity('🔧 Bash: gh pr merge 812 --squash --admin && sleep 10');
  assert.equal(s.botState, 'thinking');
  t.mock.timers.tick(MIN_MS);
  assert.equal(s.botState, 'working', 'escalated on the timer armed by the FIRST line');
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(20_000); // longer than the old 8s quiet window, every time
    assert.equal(s.botState, 'working', `still working after gap ${i + 1}`);
    s._onAgentActivity(`🔧 Bash: gh pr merge ${813 + i} --squash --admin && sleep 10`);
  }
  assert.ok(!states.includes('idle') && !states.includes('listening'),
    'never dropped to idle/listening mid-work: ' + states.join(' → '));
  release(s);
});

test('no timer drop during a single long tool call (ten silent minutes)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s._onAgentActivity('🔧 Bash: pnpm build');
  t.mock.timers.tick(10 * 60_000);
  assert.equal(s.botState, 'working');
  release(s);
});

test('returning to wait_for_speech ends working', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s._onAgentActivity('🔧 Bash: gh pr merge 812');
  t.mock.timers.tick(MIN_MS);
  assert.equal(s.botState, 'working');
  startWait(s);
  assert.equal(s.botState, 'listening', 'the long-poll IS the "back listening" signal');
  assert.equal(s._workingStaleTimer, null, 'safety net disarmed with the engagement');
  // The wait_for_speech call itself lands in the feed a beat later. It must
  // not re-open an engagement on a bot that is parked listening.
  s._onAgentActivity('🔧 wait_for_speech');
  s._onAgentActivity('🗣 a late line while the poll is open');
  assert.equal(s.botState, 'listening');
  release(s);
});

test('speaking ends the engagement; a pending escalation does not land afterwards', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s._onAgentActivity('🔧 Bash: git status');
  s._setBotState('speaking');
  t.mock.timers.tick(MIN_MS * 2);
  assert.equal(s.botState, 'speaking');
  release(s);
});

test('the call ending drops 🧑‍💻', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s._onAgentActivity('🔧 Bash: gh pr merge 812');
  t.mock.timers.tick(MIN_MS);
  assert.equal(s.botState, 'working');
  s.setCallStatus('left');
  assert.equal(s.botState, 'idle');
  release(s);
});

test('safety net: an agent that dies mid-tool does not leave 🧑‍💻 forever', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s._onAgentActivity('🔧 Bash: pnpm build');
  t.mock.timers.tick(STALE_MS - 1);
  assert.equal(s.botState, 'working', 'still inside the window');
  t.mock.timers.tick(2);
  assert.equal(s.botState, 'idle', 'dropped once the safety net expires');
  release(s);
});

test('a busy bot is not called away by HTTP silence', (t) => {
  // An agent deep in Bash makes no MCP calls, so the 90s inference flagged it
  // 🫥 mid-merge. 🧑‍💻 (bounded by the safety net) or a recent feed line is
  // proof it is still there.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s.lastAgentActivityAt = Date.now();
  s._onAgentActivity('🔧 Bash: gh pr merge 812');
  t.mock.timers.tick(5 * 60_000);
  assert.equal(s.botState, 'working');
  assert.equal(s.agentState(), 'busy');
  assert.equal(s.agentAbsentInCall(), false);
  // A dropped socket is still a fact and still wins.
  s.agentSocketLost = true;
  assert.equal(s.agentState(), 'away');
  release(s);
});

test('a resting bot with a quiet feed is still called away (the inference is intact)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const { s } = serverInCall();
  s.lastAgentActivityAt = Date.now();
  s.botState = 'idle';
  t.mock.timers.tick(5 * 60_000);
  assert.equal(s.agentState(), 'away');
});

test('hearing does not override working or thinking on the face', () => {
  // page-inject.js is a browser IIFE, so pin the source like the other avatar
  // tests do. Two layers: the attentive (😐/🫤) face is suppressed outright
  // while busy, and the activity face outranks it in the waterfall regardless.
  const inject = readFileSync(join(root, 'electron-app/page-inject.js'), 'utf8');
  const block = inject.slice(inject.indexOf('const attentive ='), inject.indexOf('const hearing = attentive'));
  assert.ok(block.includes("state !== 'working'"), 'working suppresses hearing/settling');
  assert.ok(block.includes("state !== 'thinking'"), 'thinking suppresses hearing/settling');
  const waterfall = /const emoji =([\s\S]*?);/.exec(inject)[1];
  assert.ok(waterfall.indexOf('activityEmoji') < waterfall.indexOf('hearing'));
  // And the log names what it actually rendered: a 🫥 for an absent agent was
  // logged as "hearing (anyoneSpeaking=true)" on 2026-10-15.
  const reason = inject.slice(inject.indexOf('const reason = notOnLine'), inject.indexOf("hearing ? (this.anyoneSpeaking"));
  assert.match(reason, /agentAbsentEmoji \?/);
});

test('the old 8s quiet pref is gone, replaced by a minutes-scale safety net', () => {
  const schema = require('../electron-app/preferences-schema.js');
  const prefs = schema.PREFERENCES;
  assert.equal(prefs.workingStateQuietMs, undefined);
  assert.ok(prefs.workingStateStaleMs.default >= 10 * 60_000);
});
