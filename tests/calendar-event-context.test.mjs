// calendar-event-context.test.mjs — a calendar-triggered join (#299) hands
// the matched event's title/description/start to the spawned agent via
// get_room_info, instead of it walking into the call cold.
//
// Source assertions rather than a live server/MCP round-trip: same style as
// tests/local-server-auth.test.mjs — the actual plumbing (setRoom clearing
// it, joinMeetUrl threading it through, the HTTP status payload carrying it)
// isn't easily exercised without booting a real Electron app + MCP client.
//
// Run: node --test tests/calendar-event-context.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

test('setRoom clears any prior calendar event context', () => {
  const start = server.indexOf('setRoom(roomId) {');
  assert.ok(start > 0);
  // Window, not the whole file, so this stays an assertion about setRoom. Sized
  // generously: setRoom grew a leading comment block (the rejoin-resume guard,
  // see rejoin-keeps-transcript.test.mjs) and a tight 400-char slice failed on a
  // change that did not touch calendar context at all.
  const body = server.slice(start, start + 2000);
  assert.match(body, /this\.calendarEventContext = null;/);
});

test('setCalendarEventContext exists and stores summary/description/start', () => {
  assert.match(server, /setCalendarEventContext\(event\)/);
  assert.match(server, /summary: event\.summary \|\| null/);
  assert.match(server, /description: event\.description \|\| null/);
  assert.match(server, /start: event\.start \|\| null/);
});

// The end time is what lets an agent say "ten minutes left" — the one thing
// about a meeting's shape that neither the transcript nor the start can tell
// it. It was dropped here for a while even though the event carried it.
test('setCalendarEventContext keeps the event end time', () => {
  assert.match(server, /end: event\.end \|\| null/);
});

test('get_room_info prints End alongside Start', () => {
  assert.match(mcp, /if \(cal\.end\) calLines\.push\(`  End: \$\{cal\.end\}`\)/);
});

test('the /api/sync/:roomId status payload includes calendarEventContext', () => {
  assert.match(server, /calendarEventContext: this\.calendarEventContext \|\| null/);
});

test('joinMeetUrl accepts calendarEvent and forwards it to setCalendarEventContext', () => {
  assert.match(
    main,
    /function joinMeetUrl\(meetUrl, \{ spawnAgent = true, onboardingCall = false, calendarEvent = null \} = \{\}\)/,
  );
  const start = main.indexOf('function joinMeetUrl(meetUrl,');
  assert.ok(start > 0);
  const body = main.slice(start, start + 600);
  assert.match(body, /localServer\.setCalendarEventContext\(calendarEvent\);/);
});

test('performScheduledCalendarJoin passes the matched event through as calendarEvent', () => {
  const start = main.indexOf('function performScheduledCalendarJoin(');
  assert.ok(start > 0);
  // Window widened from 600 in #588, which added the "already in this room"
  // stand-down ahead of the join. Only the slice grew — the assertion below is
  // unchanged, and it is still scoped to this one function's body.
  const body = main.slice(start, start + 1400);
  assert.match(body, /joinMeetUrl\(meetUrl, \{ spawnAgent: true, calendarEvent: event \}\);/);
});

test('get_room_info surfaces a Calendar context section when present', () => {
  assert.match(mcp, /status\.calendarEventContext/);
  assert.match(mcp, /Calendar context: this call was auto-joined from a calendar invite\./);
});
