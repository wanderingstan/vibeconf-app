// rejoin-guard-adoption.test.mjs — the first /join-call after launch must not
// be dropped by the rejoin guard (#105).
//
// The bug: two correct behaviours collided.
//
//   #26  added a guard so an agent's duplicate join_call can't tear down a
//        healthy call. It decides by asking "am I already in this room?" —
//        reading this.roomId and this.callStatus.
//   #87  made adoption of an unknown room go through setRoom() instead of a
//        bare `this.roomId = roomId`, because only setRoom builds the room's
//        whiteboard/transcript state.
//
// setRoom also calls setCallStatus (originally 'joining', now 'navigating' —
// see the callStatus finer-state split below). So from beta3 on, the FIRST
// join_call after launch adopted the room on its way in — writing both values
// the guard inspects — and then matched its own footprint and was ignored.
// Reported ok:true/alreadyInCall:true, so the agent believed it had joined
// while nothing ever navigated. Cost ~an hour of the Jul 28 standup.
//
// Deterministic, not flaky: it fires exactly once per launch, on the first
// join, because adoption is gated on `if (!this.roomId)`. Any later join sees
// genuine prior state and behaves correctly — which is why clicking the app's
// own join button appeared to "fix" it.
//
// Fix: hand the guard the room/status as they were BEFORE adoption.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// local-server.js publishes itself on globalThis rather than module.exports
// (it predates being importable) — same contract as room-adoption.test.mjs.
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;
const { shouldIgnoreRejoin } = require('../electron-app/rejoin-guard.js');

const ROOM = 'abc-defg-hij';
const fresh = () => new LocalServer({ port: 0 });

test('adopting a room sets callStatus to navigating — the side effect behind the bug', () => {
  const s = fresh();
  assert.equal(s.roomId, null);
  assert.equal(s.callStatus, 'idle');

  s.setRoom(ROOM); // what handleRequest does for an unknown room

  assert.equal(s.callStatus, 'navigating',
    'setRoom announces a join in progress; the guard must not read this as evidence of an EARLIER join');
});

test('feeding the guard LIVE state after adoption drops the join — the #105 bug', () => {
  const s = fresh();
  s.setRoom(ROOM); // adoption, same request

  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM,
    currentRoom: s.roomId,        // set moments ago by THIS request
    callStatus: s.callStatus,     // ditto
  }), true, 'kept as the counter-example: this is precisely what shipped in beta3');
});

test('feeding the guard PRE-adoption state lets the first join through — the fix', () => {
  const s = fresh();
  const preAdoption = { roomId: s.roomId, callStatus: s.callStatus }; // captured first
  s.setRoom(ROOM);

  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM,
    currentRoom: preAdoption.roomId,      // null on a fresh launch
    callStatus: preAdoption.callStatus,   // 'idle'
  }), false, 'a first-ever join has no prior session to protect and must proceed');
});

test('the fix does not weaken the #26 protection it was built for', () => {
  const s = fresh();
  s.setRoom(ROOM);
  s.setCallStatus('in-call');           // a real, established call

  // A duplicate join now arrives. roomId is already set, so adoption is skipped
  // and pre-adoption state IS the live state — the guard still sees the truth.
  const preAdoption = { roomId: s.roomId, callStatus: s.callStatus };

  assert.equal(shouldIgnoreRejoin({
    requestedRoom: ROOM,
    currentRoom: preAdoption.roomId,
    callStatus: preAdoption.callStatus,
  }), true, 'the duplicate join that #26 exists to stop is still stopped');
});

test('a genuine call switch still proceeds after the fix', () => {
  const s = fresh();
  s.setRoom(ROOM);
  s.setCallStatus('in-call');
  const preAdoption = { roomId: s.roomId, callStatus: s.callStatus };

  assert.equal(shouldIgnoreRejoin({
    requestedRoom: 'zzz-zzzz-zzz',
    currentRoom: preAdoption.roomId,
    callStatus: preAdoption.callStatus,
  }), false, 'joining a different room is a switch, never a duplicate');
});
