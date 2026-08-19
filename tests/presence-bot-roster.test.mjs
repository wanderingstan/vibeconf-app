// presence-bot-roster.test.mjs — a peer bot only becomes visible to the
// barge-in check if the website's room presence is merged into the local roster.
//
// Live evidence (call yqo-gufx-bvj, 2026-08-19): Jimmy and Taylor were both in
// the room, both registered on vibeconferencing.com with role='bot', and Jimmy
// still cut Taylor off and logged "human interrupted — backing off: Taylor".
// Two independent reasons, both fixed here:
//
//   1. The local members list is written ONLY by posts to this instance's own
//      local server, so it contained exactly one bot — itself. A peer runs its
//      own local server on its own port and its posts land there. Nothing ever
//      crossed. The sync poll already fetches `members`; it just dropped it.
//
//   2. The bot-name set was keyed on `member.name` alone, while Meet's tile
//      carries the DISPLAY name. Presence holds both and they routinely differ
//      — that call's own log line reads: registered "Jimmy" (display "jimmy
//      bot"). Index both, or the merge above buys nothing.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

function makeServer() {
  const s = new LocalServer({ port: 0, getPref: () => undefined });
  s.setRoom('test-room');
  return s;
}

test('presence from the sync poll puts a peer bot on the roster', () => {
  const s = makeServer();
  assert.equal(s._botNameSet().size, 0, 'roster starts empty — nothing local has posted');

  s.mergeRemoteMembers([
    { name: 'Stan James', role: 'member' },
    { name: 'Taylor', role: 'bot' },
  ]);

  assert.ok(s._botNameSet().has('taylor'), 'the peer bot is now known');
  assert.ok(!s._botNameSet().has('stan james'), 'the human is not');
});

test('a bot is matched by its Meet display name, not just its registered one', () => {
  // The bug that bit us: presence says "Jimmy", the tile everyone sees — and
  // that the speaker tracker reports — says "jimmy bot".
  const s = makeServer();
  s.mergeRemoteMembers([{ name: 'Jimmy', displayName: 'jimmy bot', role: 'bot' }]);

  const bots = s._botNameSet();
  assert.ok(bots.has('jimmy'), 'registered name matches');
  assert.ok(bots.has('jimmy bot'), 'display name matches too — this is the one Meet gives us');
});

test('role bot upgrades, and never downgrades', () => {
  // The sync server holds a bot under BOTH names: a role='bot' row for its
  // registration and a role='member' row minted from its Meet tile. Letting the
  // stale 'member' row win would reinstate the bug on the very next poll.
  const s = makeServer();
  s.mergeRemoteMembers([{ name: 'Taylor', role: 'bot' }]);
  s.mergeRemoteMembers([{ name: 'Taylor', role: 'member' }]);
  assert.ok(s._botNameSet().has('taylor'), 'still a bot after a member-role poll');

  s.mergeRemoteMembers([{ name: 'Pat', role: 'member' }]);
  assert.ok(!s._botNameSet().has('pat'), 'a plain member stays a member');
  s.mergeRemoteMembers([{ name: 'Pat', role: 'bot' }]);
  assert.ok(s._botNameSet().has('pat'), 'but member → bot is allowed: bots register themselves');
});

test('a poll that omits a bot does not drop it from the roster', () => {
  // Presence expires on its own schedule. A bot going briefly missing from one
  // poll must not vanish mid-utterance — that is exactly when the barge-in
  // check needs to know what it is.
  const s = makeServer();
  s.mergeRemoteMembers([{ name: 'Taylor', role: 'bot' }]);
  s.mergeRemoteMembers([{ name: 'Stan James', role: 'member' }]);
  assert.ok(s._botNameSet().has('taylor'), 'still there');
});

test('junk from the wire is ignored rather than thrown on', () => {
  const s = makeServer();
  s.mergeRemoteMembers(null);
  s.mergeRemoteMembers(undefined);
  s.mergeRemoteMembers([null, {}, { role: 'bot' }, { name: '' }]);
  assert.equal(s._botNameSet().size, 0);
});
