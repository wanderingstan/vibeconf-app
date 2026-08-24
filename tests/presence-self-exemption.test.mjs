// presence-self-exemption.test.mjs — #222's guard must recognise its own ghost.
//
// The duplicate-name guard refuses a join when the name is already in the room,
// and exempts you when the entry is your own (`_everJoinedAs`) — your presence
// may not have expired yet. But the name is PUBLISHED by the presence
// heartbeat, which starts on any route into setRoom, while _everJoinedAs was
// recorded only by the MCP join handler. Every other route published a name the
// guard could not recognise as its own.
//
// Observed 2026-08-24: the app restarted (clearing _everJoinedAs), auto-joined
// qqe-cvyg-mtm via --meet-url, published "Jimmy" at 07:34:54, and then refused
// its own join twice at 07:35:35 and 07:35:40. Only force:true got in.
//
// Run: node --test tests/presence-self-exemption.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

// _registerPresence POSTs; we only care that it recorded the published name.
const serverWithFetch = (prefs = { announceAsBot: true }) => {
  const calls = [];
  const s = new LocalServer({
    port: 0,
    getPref: (k) => prefs[k],
    getWebsiteUrl: () => 'https://vibeconferencing.com',
    getConfiguredBotName: () => 'Jimmy',
  });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({}) };
  };
  return { s, calls };
};

test('publishing presence records the name as our own', () => {
  const { s, calls } = serverWithFetch();
  assert.equal(s._everJoinedAs, null, 'a fresh process has published nothing');
  // Set the room directly rather than via setRoom, so this exercises the
  // publish itself without the heartbeat setRoom would start.
  s.roomId = 'qqe-cvyg-mtm';

  s._registerPresence();

  assert.equal(calls.length, 1, 'the name went to the remote room');
  assert.equal(calls[0].body.name, 'Jimmy');
  assert.equal(s._everJoinedAs, 'Jimmy',
    'so a later join under that name is exempt from the #222 collision guard');
});

test('setRoom ALONE claims the name — this is the route that broke', () => {
  // The exact failing path: --meet-url / detected-Meet / start-sync never touch
  // the MCP join handler. setRoom moves the status to 'navigating', which is
  // active, which starts the heartbeat and fires beat() immediately — so the
  // name is published before any join request is made. Before the fix this left
  // _everJoinedAs null and the process could not recognise its own entry.
  const { s, calls } = serverWithFetch();
  s.setRoom('qqe-cvyg-mtm');

  assert.ok(calls.some((c) => c.body.name === 'Jimmy'), 'setRoom published the name');
  assert.equal(s._everJoinedAs, 'Jimmy', 'and claimed it, with no MCP join involved');
});

test('an unannounced instance publishes nothing, so claims nothing', () => {
  // announceAsBot=false (#471) deliberately keeps this instance out of the room's
  // bot list. Nothing is published, so there is no entry to exempt.
  const { s, calls } = serverWithFetch({ announceAsBot: false });
  s.roomId = 'qqe-cvyg-mtm';

  s._registerPresence();

  assert.equal(calls.length, 0, 'nothing was published');
  assert.equal(s._everJoinedAs, null, 'and nothing is claimed as ours');
});

test('a restart is what made this reachable: the field does not survive the process', () => {
  const { s } = serverWithFetch();
  s.roomId = 'qqe-cvyg-mtm';
  s._registerPresence();
  assert.equal(s._everJoinedAs, 'Jimmy');

  // The remote entry has a 5-minute TTL and outlives a crash/auto-update; a new
  // process starts with an empty field. That asymmetry is the whole bug.
  const { s: restarted } = serverWithFetch();
  assert.equal(restarted._everJoinedAs, null);
});
