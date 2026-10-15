// teams-selectors.test.mjs — unit tests for the pure Microsoft Teams URL helpers:
// invite-link detection, the meeting key, and the room code.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { TEAMS } = require('../electron-app/teams-selectors.js');

const PERSONAL = 'https://teams.live.com/meet/9356141248380?p=BCVZW8Nwpa0dZ6Vzr7'; // verified live
const WORK_MEET = 'https://teams.microsoft.com/meet/27389117658431?p=AbCdEf123';
const WORK_CLASSIC = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ5ZmY0Y2QtYmE5Ny00@thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d';

test('isTeamsUrl: personal and work invite forms', () => {
  assert.equal(TEAMS.isTeamsUrl(PERSONAL), true);
  assert.equal(TEAMS.isTeamsUrl(WORK_MEET), true);
  assert.equal(TEAMS.isTeamsUrl(WORK_CLASSIC), true);
  assert.equal(TEAMS.isTeamsUrl('https://teams.microsoft.com/v2/'), false); // app, not a meeting
  assert.equal(TEAMS.isTeamsUrl('https://notteams.live.com/meet/9356141248380'), false);
  assert.equal(TEAMS.isTeamsUrl('https://zoom.us/j/81234567890'), false);
  assert.equal(TEAMS.isTeamsUrl('not a url'), false);
});

test('meetingKeyFromUrl: the /meet/ code or the meetup-join thread id', () => {
  assert.equal(TEAMS.meetingKeyFromUrl(PERSONAL), '9356141248380');
  assert.equal(TEAMS.meetingKeyFromUrl(WORK_MEET), '27389117658431');
  assert.equal(TEAMS.meetingKeyFromUrl(WORK_CLASSIC), 'NzQ5ZmY0Y2QtYmE5Ny00');
  assert.equal(TEAMS.meetingKeyFromUrl('https://teams.live.com/'), null);
});

test('lightMeetingUrl: the guest light client, coords matching what a browser lands on', () => {
  const light = new URL(TEAMS.lightMeetingUrl(PERSONAL));
  assert.equal(light.origin + light.pathname, 'https://teams.live.com/light-meetings/launch');
  assert.equal(light.searchParams.get('p'), 'BCVZW8Nwpa0dZ6Vzr7');
  assert.equal(light.searchParams.get('anon'), 'true');
  assert.equal(light.searchParams.get('agent'), 'web');
  // Decoded from the URL Chrome reached on 2026-10-15 for this same meeting.
  assert.deepEqual(JSON.parse(Buffer.from(light.searchParams.get('coords'), 'base64').toString('utf8')), {
    meetingUrl: 'https://teams.live.com/meet/9356141248380?p=BCVZW8Nwpa0dZ6Vzr7&anon=true',
    meetingCode: '9356141248380',
    passcode: 'BCVZW8Nwpa0dZ6Vzr7',
  });
  assert.equal(TEAMS.lightMeetingUrl(WORK_CLASSIC), null); // no /meet/ code: use the launcher
  assert.equal(TEAMS.lightMeetingUrl('https://zoom.us/j/1'), null);
});

test('mcp-server join_call derives the same Teams room id as the app (#708: it cannot import teams-selectors)', async () => {
  const { readFileSync } = await import('fs');
  const src = readFileSync(new URL('../mcp-server/server.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const teamsKey ='), src.indexOf('if (teamsKey) {'));
  assert.ok(block.includes('teams\\.(live|microsoft)\\.com'), 'join_call Teams parser not found');
  // Evaluate the inline parser against the same links the app parses.
  const mcpRoom = new Function('room_id', block.replace('const teamsKey =', 'const teamsKey =') +
    "return teamsKey ? 'teams-' + teamsKey[1].toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40) : null;");
  for (const url of [PERSONAL, WORK_MEET, WORK_CLASSIC, 'https://teams.live.com/', 'https://zoom.us/j/81234567890']) {
    const app = TEAMS.isTeamsUrl(url) ? TEAMS.roomCodeFromUrl(url) : null;
    assert.equal(mcpRoom(url), app, url);
  }
});

test('roomCodeFromUrl: a valid local-server slug ([a-z0-9-]+)', () => {
  assert.equal(TEAMS.roomCodeFromUrl(PERSONAL), 'teams-9356141248380');
  const classic = TEAMS.roomCodeFromUrl(WORK_CLASSIC);
  assert.equal(classic, 'teams-nzq5zmy0y2qtyme5ny00');
  for (const u of [PERSONAL, WORK_MEET, WORK_CLASSIC]) assert.match(TEAMS.roomCodeFromUrl(u), /^[a-z0-9-]+$/);
  assert.equal(TEAMS.roomCodeFromUrl('https://teams.live.com/'), null);
});
