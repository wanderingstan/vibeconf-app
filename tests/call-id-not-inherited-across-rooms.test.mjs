// call-id-not-inherited-across-rooms.test.mjs — a new room gets a new call id.
//
// The mirror of rejoin-keeps-transcript.test.mjs. That one pins the SAME-room
// rejoin: after-call-work deliberately keeps `callId` alive (see the isFinished()
// guard in setCallStatus), so redialling the same room is one call with an
// interruption in the middle, and the transcript must survive.
//
// This one pins the other half, which was never guarded. Joining a DIFFERENT
// room while that id is still live — which is exactly what a calendar auto-join
// during after-call-work does — left `callId` set, so setCallStatus's
// `activeState && !this.callId` never re-minted it and the new call wore the
// previous call's name.
//
// Observed 2026-08-26: left zks-dygt-quq, auto-joined dcw-goqf-ypa ~90s later,
// and get_room_info reported
//     Room: dcw-goqf-ypa   Call id: zks-dygt-quq-20260826T165732Z
// Both calls' artifacts then landed in one calls/<id>/ folder. The media
// survived (the recorder suffixes -2), but speaking-events.jsonl is appended to
// with no boundary marker — so #422's turn-taking tuning would score two calls
// in two rooms as one continuous session.
//
// Run: node --test tests/call-id-not-inherited-across-rooms.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

// What after-call-work leaves standing: the bot has left the Meet, but its
// agent is still writing the call up, so the call keeps its identity.
const inAfterCallWork = (s, room, id) => {
  s.setRoom(room);
  s.callId = id;
  s.callStartedAt = '2026-08-26T16:57:32.217Z';
};

test('a different room during after-call-work does NOT inherit the call id', () => {
  const s = new LocalServer({ port: 0 });
  inAfterCallWork(s, 'zks-dygt-quq', 'zks-dygt-quq-20260826T165732Z');

  s.setRoom('dcw-goqf-ypa');

  assert.equal(s.callId, null,
    'a genuinely new call must mint its own id, not wear the last one\'s');
  assert.equal(s.callStartedAt, null,
    'and its start time must not be the previous call\'s either');
});

test('the same room during after-call-work still keeps the id — the resume case is untouched', () => {
  const s = new LocalServer({ port: 0 });
  inAfterCallWork(s, 'rfw-bmqi-ogb', 'rfw-bmqi-ogb-20260824T025635Z');

  s.setRoom('rfw-bmqi-ogb');

  assert.equal(s.callId, 'rfw-bmqi-ogb-20260824T025635Z',
    'one folder across a leave/rejoin — see rejoin-keeps-transcript.test.mjs');
  assert.equal(s.callStartedAt, '2026-08-26T16:57:32.217Z', 'and its start time survives');
});

test('clearing the id lets setCallStatus mint a fresh one for the new room', () => {
  // The bug was never in setRoom's own state — it was that a stale id made
  // setCallStatus's `activeState && !this.callId` false, so the mint never ran.
  // This asserts the end-to-end result: a new room yields an id naming THAT room.
  const s = new LocalServer({ port: 0 });
  inAfterCallWork(s, 'zks-dygt-quq', 'zks-dygt-quq-20260826T165732Z');

  s.setRoom('dcw-goqf-ypa');
  s.setCallStatus('in-call');

  assert.ok(s.callId, 'an id was minted');
  assert.match(s.callId, /^dcw-goqf-ypa-/,
    `the id must name the room actually joined, got ${s.callId}`);
});

test('a room change with no call in flight is unaffected', () => {
  const s = new LocalServer({ port: 0 });
  s.setRoom('zks-dygt-quq');
  s.callId = null; // idle / call-complete already cleared it

  s.setRoom('dcw-goqf-ypa');

  assert.equal(s.callId, null);
});
