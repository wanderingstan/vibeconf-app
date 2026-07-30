// rejoin-guard.test.mjs — when a second join_call must be ignored (#26).
//
// The bug this guards: honouring a duplicate join tore down a HEALTHY call,
// hung forever on Meet's "Getting ready…" screen, and reported it to the agent
// as "the bot couldn't enter the Meet (denied or removed)" — blaming Meet for
// something we did. The cases below are the ones that must not regress.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldIgnoreRejoin } = require('../electron-app/rejoin-guard.js');

const ROOM = 'abc-defg-hij';

test('a repeat join for the room we are IN is ignored — the #26 bug', () => {
  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM, currentRoom: ROOM, callStatus: 'in-call',
  }), true);
});

test('a repeat join while still JOINING that room is also ignored', () => {
  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM, currentRoom: ROOM, callStatus: 'joining',
  }), true, 'the retry that races the first join is the common case');
});

test('a repeat join while still NAVIGATING (the instant right after setRoom) is also ignored', () => {
  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM, currentRoom: ROOM, callStatus: 'navigating',
  }), true, 'navigating is the same in-progress join, just before Meet DOM confirms joining');
});

test('a DIFFERENT room is a real call switch, never ignored', () => {
  assert.equal(shouldIgnoreRejoin({
    requestedRoom: 'zzz-zzzz-zzz', currentRoom: ROOM, callStatus: 'in-call',
  }), false);
});

test('force rebuilds even for the same room — the wedged-session escape hatch', () => {
  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM, currentRoom: ROOM, callStatus: 'in-call', force: true,
  }), false);
});

test('from idle or left, nothing is protected, so join proceeds', () => {
  for (const callStatus of ['idle', 'left']) {
    assert.equal(shouldIgnoreRejoin({
      requestedRoom: ROOM, currentRoom: ROOM, callStatus,
    }), false, `${callStatus}: a bot that dropped out must be able to come back`);
  }
});

test('waiting-to-be-admitted still proceeds — it is not yet a session worth saving', () => {
  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM, currentRoom: ROOM, callStatus: 'waiting-to-be-admitted',
  }), false);
});

test('missing room ids never block a join', () => {
  assert.equal(shouldIgnoreRejoin({ currentRoom: ROOM, callStatus: 'in-call' }), false);
  assert.equal(shouldIgnoreRejoin({ requestedRoom: ROOM, callStatus: 'in-call' }), false);
  assert.equal(shouldIgnoreRejoin({}), false, 'no arguments at all must not swallow a join');
});
