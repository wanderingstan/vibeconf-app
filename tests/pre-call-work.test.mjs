// pre-call-work.test.mjs — start the agent before the call, not at join time (#639).
//
// The feature is one sentence: spawn the agent a few minutes early so its slow
// work (compaction above all) happens while nobody is waiting, then let it join
// the call it was started for. Two things about that sentence can break in ways
// no unit test of a pure function would catch, and both are bad:
//
//   1. The pre-call spawn JOINS instead of preparing — a silent bot sitting in
//      an empty room five minutes before the meeting.
//   2. The join spawns a SECOND agent on top of the pre-call one — two drivers
//      fighting over wait_for_speech, the 2026-07-29 failure.
//
// Neither lives in a pure module: they are properties of how main.js wires the
// timers to the launcher. So these read the source, in the same spirit as
// calendar-event-context.test.mjs, and are scoped to the functions they name.
//
// Run: node --test tests/pre-call-work.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const skill = readFileSync(join(root, 'mcp-server/pre-call-work-skill.md'), 'utf8');
const {
  msUntilPreCallWork, msUntilStart, DEFAULT_PRECALL_LEAD_MS, DEFAULT_LOOKAHEAD_MS,
} = require('../electron-app/calendar-auto-join.js');

// The FULL body of a named function, by brace matching from its declaration.
//
// Deliberately not `slice(start, start + N)`. Every fixed window in this repo's
// source-reading tests has eventually failed for the wrong reason: the function
// grew, the target slid past the Nth character, and the assertion reported a
// missing guarantee that was in fact still there. It happened twice while this
// feature was being written — once in agent-mcp-config.test.mjs, where adding a
// single parameter pushed a match out of range. A brace walk cannot drift.
const bodyOf = (name) => {
  const decl = `function ${name}(`;
  const start = main.indexOf(decl);
  assert.ok(start > 0, `${name} not found in main.js`);
  const open = main.indexOf('{', start);
  assert.ok(open > 0, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < main.length; i++) {
    const ch = main[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return main.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces walking ${name}`);
  return '';
};

// One MCP tool registration, from its name to the start of the next one.
const toolOf = (name) => {
  const start = mcp.indexOf(`"${name}",`);
  assert.ok(start > 0, `${name} not registered in server.js`);
  const next = mcp.indexOf('\nserver.tool(', start);
  return mcp.slice(start, next > 0 ? next : mcp.length);
};

// The same body with `//` comments removed. Needed for the NEGATIVE assertions
// below: this codebase explains itself in prose, and performPreCallWork's own
// comment says "No activateMeetProvider(), no loadMeetURL, no setRoom" — which
// a naive source match reads as the very call it is promising not to make. A
// test that fails on a comment saying the right thing is worse than no test.
const codeOf = (name) => bodyOf(name)
  .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// ── The timing contract ────────────────────────────────────────────────────

test('the poller notices an event before its pre-call work is due', () => {
  // The trap this feature sets for itself: the lead time is honoured by a timer
  // that only ever gets armed if the POLLER saw the event first. A lead time at
  // or beyond the lookahead means the spawn is scheduled for a moment that has
  // already passed by the time anything notices, and the feature is silently
  // inert for exactly the bots that asked for the longest lead.
  assert.ok(DEFAULT_LOOKAHEAD_MS > DEFAULT_PRECALL_LEAD_MS,
    'the lookahead must open strictly before pre-call work is due');
  // And with room to spare for a poll tick (~60s), not by a hair.
  assert.ok(DEFAULT_LOOKAHEAD_MS - DEFAULT_PRECALL_LEAD_MS >= 60_000,
    'leave at least one poll tick between noticing an event and preparing for it');
});

test('pre-call work is due strictly before the join it precedes', () => {
  const now = Date.parse('2026-09-17T10:00:00Z');
  const event = { id: 'e', start: '2026-09-17T10:08:00Z' };
  assert.ok(msUntilPreCallWork(event, now) < msUntilStart(event, now),
    'preparing must happen before joining, never at the same moment');
});

// ── The spawn prepares; it does not join ───────────────────────────────────

test('performPreCallWork does not join, navigate, or set the room', () => {
  const code = codeOf('performPreCallWork');
  assert.equal(/joinMeetUrl\(/.test(code), false, 'pre-call work must not join the call');
  assert.equal(/activateMeetProvider\(/.test(code), false, 'pre-call work must not bring up the Meet view');
  assert.equal(/localServer\.setRoom\(/.test(code), false, 'pre-call work must not enter the room');
  // What it MUST do: spawn, flagged as pre-call.
  assert.match(code, /launchClaudeTerminal\(meetCode, \{ calendarEvent: event, preCall: true \}\)/);
});

test('the pre-call agent is told what it is preparing for', () => {
  // Without the calendar context set this early, the skill's own first
  // instruction returns a bare "Not in a call" and there is nothing to prepare
  // against.
  assert.match(bodyOf('performPreCallWork'), /localServer\.setCalendarEventContext\(event\)/);
  // ...and get_room_info has to render it while NOT in a call, which is the
  // one state where that used to be a dead end.
  assert.match(mcp, /formatCalendarContext\(data\.status\?\.calendarEventContext/);
});

test('performPreCallWork stands down when the world has moved on', () => {
  const body = bodyOf('performPreCallWork');
  // Armed minutes ago; any of these can have become true since.
  assert.match(body, /callStatus === 'in-call'/, 'must not spawn while already in a call');
  assert.match(body, /agentIsRunning\(\)/, 'must not spawn on top of a live agent');
  assert.match(body, /scheduledCalendarJoins\.has\(key\)/, 'must not prepare for a join that is gone');
});

// ── The join does not double-spawn ─────────────────────────────────────────

test('the join skips spawning when a pre-call agent is already running', () => {
  const body = bodyOf('performScheduledCalendarJoin');
  assert.match(body, /const agentAlreadyRunning = preCallAgentsStarted\.delete\(key\)/);
  assert.match(body, /joinMeetUrl\(meetUrl, \{ spawnAgent: !agentAlreadyRunning, calendarEvent: event \}\)/);
});

test('the pre-call set is cleared on every exit, not just the joining one', () => {
  // #588's stand-down returns early. A read-and-clear below it would leak one
  // entry per skipped join, forever.
  const body = bodyOf('performScheduledCalendarJoin');
  const clearAt = body.indexOf('preCallAgentsStarted.delete(key)');
  const firstReturn = body.indexOf('return;');
  assert.ok(clearAt > 0 && firstReturn > 0);
  assert.ok(clearAt < firstReturn, 'clear the pre-call entry before any early return');
});

test('arming order: the join is scheduled before the pre-call work that checks for it', () => {
  // performPreCallWork treats a scheduled join as proof the event is still
  // live. With a zero delay (an event first seen inside its own lead window)
  // the spawn fires synchronously, so arming in the other order would have it
  // check a map that has not been written yet.
  const body = bodyOf('scheduleCalendarJoin');
  const setJoin = body.indexOf('scheduledCalendarJoins.set(key, timer)');
  const armPre = body.indexOf('schedulePreCallWork(event, meetUrl)');
  assert.ok(setJoin > 0 && armPre > 0);
  assert.ok(setJoin < armPre, 'the join must be in the map before pre-call work is armed');
});

test('the lead time is read when the timer is armed, not baked in at startup', () => {
  // Same live-settable contract as afterCallWorkSeconds: changing the
  // preference should affect the next meeting, not require a restart.
  assert.match(bodyOf('schedulePreCallWork'), /preCallWorkLeadMs\(\)/);
});

test('a zero lead time turns the feature off rather than firing immediately', () => {
  assert.match(bodyOf('schedulePreCallWork'), /if \(leadMs <= 0\) return;/);
});

// ── The agent's side of the contract ───────────────────────────────────────

test('wait_for_call_start exists and is capped like wait_for_speech', () => {
  const body = toolOf('wait_for_call_start');
  // The cap is what makes a killed pre-call session noticeable rather than a
  // process parked forever on a meeting that was cancelled.
  assert.match(body, /Math\.min\(55,/);
  // A returning "not yet" must read as normal, or the agent treats the first
  // timeout as a failure and stops waiting.
  assert.match(body, /Not started yet/);
});

test('the skill forbids the two things that ruin a pre-call window', () => {
  // Speaking queues audio that plays on join — the meeting opens with a
  // sentence from five minutes ago.
  assert.match(skill, /has NOT joined anything/);
  // And calling join_call from a session the app is already joining for is
  // the duplicate-participant failure.
  assert.match(skill, /Do NOT call `join_call`/);
});

test('the skill is installed like the other bundled skills', () => {
  assert.match(main, /skills', 'pre-call-work'/);
  assert.match(main, /pre-call-work-skill\.md/);
});

// ── The three bugs the first live run found, 2026-09-18 ────────────────────
//
// All three were invisible to the unit tests above, which is the point of
// having run it. Each of these fails if the fix is reverted.

test('the no-room status carries the calendar context', () => {
  // Bug 1. The pre-call window is the only time an agent runs with no room, so
  // /api/sync/no-room is the only payload it can read — and it did not carry
  // this. The agent's own receipt read "NO CALENDAR CONTEXT".
  const start = server.indexOf("url.pathname === '/api/sync/no-room'");
  assert.ok(start > 0);
  const handler = server.slice(start, start + 3000);
  assert.match(handler, /calendarEventContext: this\.calendarEventContext \|\| null/);
});

test('wait_for_call_start returns on a transition, not on a status already true', () => {
  // Bug 3. It saw 'navigating' on its first poll and announced the meeting had
  // begun, at T-4m35s.
  const body = toolOf('wait_for_call_start');
  assert.match(body, /let baseline = null/);
  assert.match(body, /status !== baseline \|\| status === 'in-call'/);
  // An app already mid-join before the wait began is a fault to report, not a
  // start to greet.
  assert.match(body, /was ALREADY/);
});

test('the skill tells the agent never to name a room during the pre-call window', () => {
  // Bug 2's second line of defence. The first is structural (no meet code is
  // passed at all — see agent-spawn.test.mjs); this is the reason, written
  // where an agent will read it.
  assert.match(skill, /Call `get_room_info` with NO arguments/);
  assert.match(skill, /adopt that room and start joining it/);
});

// ── Busy without being in a call ───────────────────────────────────────────

test('agentBusyState covers both windows that bracket a call', () => {
  const body = bodyOf('agentBusyState');
  assert.match(body, /kind: 'pre-call'/);
  assert.match(body, /kind: 'after-call'/);
  assert.match(body, /callStatus === 'after-call-work'/);
});

test('the pre-call busy flag is cleared on every path that ends the window', () => {
  // A flag that can stick leaves the panel permanently refusing to place a
  // call, which is worse than the hole it closes.
  assert.match(bodyOf('performScheduledCalendarJoin'), /setPreCallWork\(null\)/);
  // Cleared at the TOP of performPreCallWork too, so a stand-down cannot
  // inherit a previous window's state.
  const pre = bodyOf('performPreCallWork');
  const clear = pre.indexOf('setPreCallWork(null)');
  const set = pre.indexOf('setPreCallWork({');
  assert.ok(clear > 0 && set > 0 && clear < set, 'clear before any early return, set only on the spawn');
});

test('the panel refuses a new call while the bot is busy, and says why', () => {
  assert.match(panel, /if \(agentBusy\) \{/);
  assert.match(panel, /joinBtn\.disabled = true/);
  // ...but Chat stays available: it reaches the session that is busy rather
  // than starting a rival one, so the Option-held branch must come first.
  const busyAt = panel.indexOf('if (agentBusy) {');
  const optionAt = panel.indexOf('if (optionHeld) {');
  assert.ok(optionAt > 0 && busyAt > optionAt,
    'Option-held "Chat with <bot>" must be checked before the busy gate');
});
