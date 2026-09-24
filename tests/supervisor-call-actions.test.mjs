// supervisor-call-actions.test.mjs — the supervisor's "Call" and "Add" (#301).
//
// The supervisor window puts a bot into a call through that bot's own local
// API, the way its panel buttons do. Two pieces are pinned here:
//
//   detectedCalls   merges the Meet tabs the running bots report into one list,
//                   which is what "Add" targets.
//   /api/call/join  the bot route behind "Add": the panel's Join, reachable
//                   over HTTP, which (unlike the agent's join) can bring up the
//                   bot's agent terminal.
//
// Run: node --test tests/supervisor-call-actions.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectedCalls } = require('../electron-app/supervisor.js');
// local-server.js publishes itself on globalThis (see rejoin-guard-adoption.test.mjs).
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const meet = (code, q = '') => `https://meet.google.com/${code}${q}`;

// ── detectedCalls ──

test('one tab reported by several bots is one call', () => {
  const calls = detectedCalls([
    { callStatus: 'idle', detectedMeetUrls: [meet('abc-defg-hij')] },
    { callStatus: 'idle', detectedMeetUrls: [meet('abc-defg-hij', '?authuser=1')] },
  ]);
  assert.deepEqual(calls, [{ code: 'abc-defg-hij', url: meet('abc-defg-hij') }]);
});

test('an in-call bot\'s list is ignored: it stopped scanning when it joined', () => {
  const calls = detectedCalls([
    { callStatus: 'in-call', detectedMeetUrls: [meet('old-tabs-now')] },
    { callStatus: 'idle', detectedMeetUrls: [meet('abc-defg-hij')] },
  ]);
  assert.deepEqual(calls.map((c) => c.code), ['abc-defg-hij']);
});

test('first-seen order is kept, so the picked call does not jump between refreshes', () => {
  const calls = detectedCalls([
    { callStatus: 'idle', detectedMeetUrls: [meet('bbb-bbbb-bbb'), meet('aaa-aaaa-aaa')] },
    { callStatus: 'idle', detectedMeetUrls: [meet('aaa-aaaa-aaa'), meet('ccc-cccc-ccc')] },
  ]);
  assert.deepEqual(calls.map((c) => c.code), ['bbb-bbbb-bbb', 'aaa-aaaa-aaa', 'ccc-cccc-ccc']);
});

test('junk and missing lists are skipped, not thrown on', () => {
  assert.deepEqual(detectedCalls([
    null,
    { callStatus: 'idle' },
    { callStatus: 'idle', detectedMeetUrls: ['https://meet.google.com/landing', 'not a url'] },
  ]), []);
  assert.deepEqual(detectedCalls(undefined), []);
});

// ── /api/call/join ──

// The bot's handler behind a throwaway server. LocalServer.start() is avoided on
// purpose: it writes a token file into the real ~/.vibeconferencing.
async function withBot(opts, fn) {
  const prev = process.env.VIBECONF_REQUIRE_TOKEN;
  process.env.VIBECONF_REQUIRE_TOKEN = '0';
  const bot = new LocalServer({ port: 0, ...opts });
  const server = http.createServer((req, res) => bot._handleRequest(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const post = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/call/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  try { await fn(bot, post); }
  finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.VIBECONF_REQUIRE_TOKEN; else process.env.VIBECONF_REQUIRE_TOKEN = prev;
  }
}

test('join hands main a clean Meet URL and the caller\'s spawnAgent', async () => {
  const seen = [];
  await withBot({ onJoinMeet: async (a) => { seen.push(a); return { ok: true }; } }, async (_bot, post) => {
    const r = await post({ url: meet('abc-defg-hij', '?authuser=me@x.test&hs=1'), spawnAgent: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { success: true, roomId: 'abc-defg-hij' });
  });
  assert.deepEqual(seen, [{ url: meet('abc-defg-hij'), spawnAgent: true }]);
});

test('spawnAgent defaults to false, like /api/call/start', async () => {
  const seen = [];
  await withBot({ onJoinMeet: async (a) => { seen.push(a); return { ok: true }; } }, async (_bot, post) => {
    await post({ url: meet('abc-defg-hij') });
  });
  assert.equal(seen[0].spawnAgent, false);
});

test('a URL that is not a Meet room is refused without touching the bot', async () => {
  let called = false;
  await withBot({ onJoinMeet: async () => { called = true; return { ok: true }; } }, async (_bot, post) => {
    const r = await post({ url: 'https://meet.google.com/landing' });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'bad-url');
  });
  assert.equal(called, false);
});

test('re-joining the room the bot is already in is a no-op (#26)', async () => {
  let called = false;
  await withBot({ onJoinMeet: async () => { called = true; return { ok: true }; } }, async (bot, post) => {
    bot.setRoom('abc-defg-hij');
    bot.callStatus = 'in-call';
    const r = await post({ url: meet('abc-defg-hij'), spawnAgent: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.alreadyInCall, true);
  });
  assert.equal(called, false, 'loadMeetURL on the live room tears the session down');
});

test('a failed join reports the reason, not a bare error', async () => {
  await withBot({ onJoinMeet: async () => ({ ok: false, code: 'nope', detail: 'because' }) }, async (_bot, post) => {
    const r = await post({ url: meet('abc-defg-hij') });
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, code: 'nope', detail: 'because' });
  });
});
