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

test('roomCodeFromUrl: a valid local-server slug ([a-z0-9-]+)', () => {
  assert.equal(TEAMS.roomCodeFromUrl(PERSONAL), 'teams-9356141248380');
  const classic = TEAMS.roomCodeFromUrl(WORK_CLASSIC);
  assert.equal(classic, 'teams-nzq5zmy0y2qtyme5ny00');
  for (const u of [PERSONAL, WORK_MEET, WORK_CLASSIC]) assert.match(TEAMS.roomCodeFromUrl(u), /^[a-z0-9-]+$/);
  assert.equal(TEAMS.roomCodeFromUrl('https://teams.live.com/'), null);
});
