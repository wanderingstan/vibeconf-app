// meet-room.test.mjs — join_call must accept a pasted Meet URL, not only a code (#314).
//
// The failure this locks down is not a crash. Before the fix, a URL was POSTed
// verbatim as the room id and died further down as an unrecognised room, so the
// integrator's first impression was "join_call is broken" rather than "that
// argument wanted a code". Every non-Claude-Code client hits this, because the
// URL→code extraction used to live only in the /join-call skill.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeetRoomId } from '../mcp-server/meet-room.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('a bare meet code passes through unchanged', () => {
  assert.deepEqual(parseMeetRoomId('abc-defg-hij'), { ok: true, roomId: 'abc-defg-hij' });
  // Real room ids from the test fixtures, so a regex tightened too far fails here.
  assert.deepEqual(parseMeetRoomId('paz-sqoa-npe'), { ok: true, roomId: 'paz-sqoa-npe' });
  assert.deepEqual(parseMeetRoomId('mmb-tyzj-oue'), { ok: true, roomId: 'mmb-tyzj-oue' });
});

test('a full Meet URL yields the code', () => {
  for (const url of [
    'https://meet.google.com/abc-defg-hij',
    'http://meet.google.com/abc-defg-hij',
    'https://www.meet.google.com/abc-defg-hij',
    'meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij/',
    '  https://meet.google.com/abc-defg-hij  ',
  ]) {
    assert.deepEqual(parseMeetRoomId(url), { ok: true, roomId: 'abc-defg-hij' }, url);
  }
});

test('query strings and fragments are stripped', () => {
  // These are what a real paste carries — Google appends authuser/pli routinely.
  assert.deepEqual(parseMeetRoomId('https://meet.google.com/abc-defg-hij?authuser=0'),
    { ok: true, roomId: 'abc-defg-hij' });
  assert.deepEqual(parseMeetRoomId('https://meet.google.com/abc-defg-hij?pli=1&foo=bar'),
    { ok: true, roomId: 'abc-defg-hij' });
  assert.deepEqual(parseMeetRoomId('https://meet.google.com/abc-defg-hij#anchor'),
    { ok: true, roomId: 'abc-defg-hij' });
});

test('codes are normalised to lowercase', () => {
  assert.deepEqual(parseMeetRoomId('ABC-DEFG-HIJ'), { ok: true, roomId: 'abc-defg-hij' });
  assert.deepEqual(parseMeetRoomId('https://meet.google.com/ABC-DEFG-HIJ'),
    { ok: true, roomId: 'abc-defg-hij' });
});

test('non-Meet room ids are left ALONE', () => {
  // This is the load-bearing case. room_id also carries Slack room ids (join_call
  // mirrors slack-<team>-<channel> back for the rest of the conversation loop)
  // and the literal 'no-room' used by status probes. Mangling either would break
  // paths that have nothing to do with #314.
  assert.deepEqual(parseMeetRoomId('slack-t0bcx7n0ra6-c0bcz4e3q49'),
    { ok: true, roomId: 'slack-t0bcx7n0ra6-c0bcz4e3q49' });
  assert.deepEqual(parseMeetRoomId('no-room'), { ok: true, roomId: 'no-room' });
  assert.deepEqual(parseMeetRoomId('https://app.slack.com/client/T123/C456'),
    { ok: true, roomId: 'https://app.slack.com/client/T123/C456' });
});

test('a Meet URL with no readable code explains itself', () => {
  // meet.google.com/lookup/<hash> resolves to a code only by following a browser
  // redirect. Saying so beats POSTing the URL as a room id and failing later.
  const r = parseMeetRoomId('https://meet.google.com/lookup/abcd1234');
  assert.equal(r.ok, false);
  assert.match(r.error, /meet code/i);
});

test('empty input is rejected with a usable message', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const r = parseMeetRoomId(empty);
    assert.equal(r.ok, false, JSON.stringify(empty));
    assert.match(r.error, /Meet code|Meet URL/i);
  }
});

test('join_call actually calls the parser', () => {
  // The module is only worth anything if it is on the join path. A unit test on
  // a helper nobody calls is exactly the shape of this bug's original cause —
  // correct parsing that lived somewhere the tool never reached.
  const src = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
  assert.match(src, /import \{ parseMeetRoomId \} from ["']\.\/meet-room\.js["']/);
  assert.match(src, /parseMeetRoomId\(room_id\)/);
});
