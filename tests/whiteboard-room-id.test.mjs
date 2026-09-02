// whiteboard-room-id.test.mjs — a whiteboard write for ANOTHER room must fail
// loudly instead of landing on ours (#586).
//
// The bug: update_whiteboard, set_whiteboard_style and read_whiteboard all take
// a room_id, and every one of their descriptions said "Room/Meet code. Uses
// VIBECONF_ROOM_ID env var if not provided." — which reads as "this selects the
// room". Nothing downstream read it. The tools POST to /api/sync/<room_id>, but
// _handlePost wrote this.whiteboard (the room we're IN) and main.js's
// onWhiteboardUpdate re-read localServer.roomId for the push, so the room in
// the URL was discarded twice over.
//
// What that cost, on the 2026-08-28 call: asked to pre-style ANOTHER room's
// board before a meeting, the bot styled it, wrote an agenda onto it, and was
// told "Whiteboard updated (version 1)" — while the content overwrote the live
// board the room was looking at, mid-call, in front of the person who asked.
// The target room had total=0 versions on the sync server the whole time. So
// this is not merely a no-op with a bad message: it silently performs a
// DIFFERENT, destructive action and reports success for the one requested.
//
// The fix refuses the write rather than honouring it. Honouring it would mean
// writing to a room this app never joined, and nobody has confirmed the sync
// server authorises that — plus the share window can't preview such a board
// (it hits the website's sign-in wall, which is exactly why an empty target
// board and an unauthorised one looked identical during the diagnosis).
//
// Run: node --test tests/whiteboard-room-id.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
// local-server.js publishes itself on globalThis rather than module.exports
// (it predates being importable) — same contract as room-adoption.test.mjs.
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const mcp = readFileSync(new URL('../mcp-server/server.js', import.meta.url), 'utf8');

const OURS = 'xpk-ogsr-tfw';    // the room we were in
const THEIRS = 'xnj-qzwg-nkw';  // the room that was asked for, and stayed empty

// _handlePost reads the body off the request stream and answers through the
// response, so drive it with the smallest stand-ins that satisfy both.
const reqOf = (body) => Readable.from([JSON.stringify(body)]);
const resSpy = () => {
  const res = {
    status: null,
    body: null,
    writeHead(status) { res.status = status; },
    end(payload) { res.body = payload ? JSON.parse(payload) : null; },
  };
  return res;
};

// A server that has joined OURS and records every push it is asked to make, so
// a test can tell "refused" from "refused, but only after the damage".
const inRoom = () => {
  const pushed = { boards: [], styles: [] };
  const s = new LocalServer({
    port: 0,
    onWhiteboardUpdate: async (content) => { pushed.boards.push(content); return { delivered: true }; },
    onWhiteboardStyle: (css) => { pushed.styles.push(css); },
  });
  s.setRoom(OURS);
  return { s, pushed };
};

test('a board write for another room is refused, and names both rooms', async () => {
  const { s, pushed } = inRoom();
  const res = resSpy();

  await s._handlePost(reqOf({ sender: 'Alice', whiteboard: { content: '# agenda for the other meeting' } }),
    res, THEIRS);

  assert.equal(res.status, 409, 'a conflict, not a 200 with a cheerful version number');
  assert.equal(res.body.success, false);
  // Both codes, because the whole failure is that the two were confused. An
  // error that names only one leaves the bot unable to say what went wrong.
  assert.match(res.body.error, new RegExp(OURS));
  assert.match(res.body.error, new RegExp(THEIRS));
  assert.equal(res.body.roomId, OURS);
  assert.equal(res.body.requestedRoomId, THEIRS);
});

test('the refused write leaves OUR board exactly as it was', async () => {
  // This is the part that hurt. The old path mutated this.whiteboard before it
  // did anything else, so the room's own content was gone by the time any error
  // could have been raised — and this.whiteboard is what read_whiteboard and
  // get_room_info serve, so nothing downstream could tell it had happened.
  const { s, pushed } = inRoom();
  s.whiteboard.content = '# Studio sessions — dry run';
  s.whiteboard.version = 1;

  await s._handlePost(reqOf({ sender: 'Alice', whiteboard: { content: '# agenda for the other meeting' } }),
    resSpy(), THEIRS);

  assert.equal(s.whiteboard.content, '# Studio sessions — dry run', 'the live board must survive');
  assert.equal(s.whiteboard.version, 1, 'and not gain a version for a write that never happened');
  assert.deepEqual(pushed.boards, [], 'nothing may be pushed to the sync server either');
});

test('a style change for another room is refused too', async () => {
  // set_whiteboard_style went through the same door and had the same effect:
  // on 2026-08-28 the other room was "styled" first, and that restyled OURS.
  const { s, pushed } = inRoom();
  s.whiteboardCss = 'background:#fafaf5; color:#222';
  const res = resSpy();

  await s._handlePost(reqOf({ sender: 'Alice', whiteboardStyle: 'background:#000; color:#0f0' }),
    res, THEIRS);

  assert.equal(res.status, 409);
  assert.equal(s.whiteboardCss, 'background:#fafaf5; color:#222', 'our board keeps its own styling');
  assert.deepEqual(pushed.styles, [], 'and nothing is relayed to the remote room');
});

test('an empty style string is still a write, so it is refused as well', async () => {
  // Empty CSS means "reset to default" — a real, visible change to whoever is
  // looking at the board. A truthiness check on data.whiteboardStyle would let
  // exactly that one through, which is the worst case: a cross-room call that
  // WIPES our styling.
  const { s } = inRoom();
  const res = resSpy();

  await s._handlePost(reqOf({ sender: 'Alice', whiteboardStyle: '' }), res, THEIRS);

  assert.equal(res.status, 409, 'reset-to-default is a change, not a no-op');
});

test('writes to the room we are actually in still work', async () => {
  // The guard has to be narrow enough to leave the normal path alone — the
  // overwhelmingly common call passes no room_id at all, or passes ours.
  const { s, pushed } = inRoom();
  const res = resSpy();

  await s._handlePost(reqOf({ sender: 'Alice', whiteboard: { content: '# hello' } }), res, OURS);

  assert.equal(res.status, 200);
  assert.equal(res.body.results.whiteboard.ok, true);
  assert.equal(s.whiteboard.content, '# hello');
  assert.deepEqual(pushed.boards, ['# hello']);
});

test('a write during room adoption is not refused', async () => {
  // Before any room is adopted this.roomId is null, and handleRequest adopts
  // whatever room the first request names (see room-adoption.test.mjs). Refusing
  // on a null current room would break that first write — the app would reject
  // the very request that told it which room it is in.
  const s = new LocalServer({ port: 0, onWhiteboardUpdate: async () => ({ delivered: true }) });
  s.setRoom(THEIRS); // what handleRequest does for an unknown room, before _handlePost
  const res = resSpy();

  await s._handlePost(reqOf({ sender: 'Alice', whiteboard: { content: '# first' } }), res, THEIRS);

  assert.equal(res.status, 200);
  assert.equal(s.whiteboard.content, '# first');
});

test('read_whiteboard does not answer with this room under another room name', () => {
  // read_whiteboard had the same defect from the other direction: it probes the
  // app for its active room and OVERWRITES roomId with it. Correcting a stale
  // env var that way is fine; overruling an argument the caller typed is not —
  // it returns our board labelled as theirs. That mattered more than a wrong
  // read usually would, because reading the board back is how a bot would check
  // whether its cross-room write landed: both tools lied in the same direction.
  const tool = mcp.slice(mcp.indexOf('"read_whiteboard",'));
  const probe = tool.slice(0, tool.indexOf('History mode'));
  assert.match(probe, /if \(room_id && room_id !== probeData\.roomId\)/,
    'an explicit, mismatched room_id must be caught before the override');
  assert.ok(probe.indexOf('if (room_id && room_id !== probeData.roomId)') < probe.indexOf('roomId = probeData.roomId'),
    'the check has to come BEFORE the reassignment, or it can never fire');
  const refusal = probe.slice(probe.indexOf('if (room_id && room_id !== probeData.roomId)'));
  assert.match(refusal.slice(0, 700), /Nothing was read/,
    'say plainly that no board was read — a silent fallback is the bug');
});

test('the whiteboard tools stop advertising room_id as a room selector', () => {
  // The descriptions actively invited the mistake: every one said "Room/Meet
  // code. Uses VIBECONF_ROOM_ID env var if not provided.", which reads as "this
  // is how you pick the room". An agent reading that has no way to know the
  // argument is inert. Scoped to the three whiteboard tools — the rest of the
  // tools share the wording but are out of #586's scope.
  const misleading = 'Room/Meet code. Uses VIBECONF_ROOM_ID env var if not provided.';
  for (const name of ['update_whiteboard', 'set_whiteboard_style', 'read_whiteboard']) {
    const tool = mcp.slice(mcp.indexOf(`  "${name}",`));
    const schema = tool.slice(0, tool.indexOf('  async ({'));
    assert.ok(schema.includes('room_id:'), `${name} still takes room_id`);
    assert.ok(!schema.includes(misleading),
      `${name}'s room_id description still claims to select the room`);
    assert.match(schema, /does NOT/, `${name} must say what room_id will not do`);
  }
});
