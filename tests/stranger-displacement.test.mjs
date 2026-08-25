// stranger-displacement.test.mjs — #518: who is allowed to displace whom.
//
// From the 2026-08-24 standup, the first time two bots were brought into one
// call from two terminals. Seth started Buddy in its own terminal; Buddy spoke,
// and the words came out of PEPPER's Meet tile. Buddy diagnosed it out loud:
//
//   "The ports are different. I'm Buddy on 7866, Pepper's on 7865. The real bug
//    is my MCP tools are pointed at Pepper's port."
//
// Two separate defects, and each hid the other. The routing half — how Buddy's
// terminal came to be dialing 7865 at all — is #517, fixed separately in #520 by
// routing on the session's working directory instead of its baked port.
//
// This is the other half, and it is what made the first one so expensive to
// find: the single-agent guard evicted whoever was already long-polling without
// checking who they were. So Pepper's loop exited silently, twice in ten
// minutes, and the symptom was "the bot went quiet" rather than an error naming
// the mistake. Worth having under any routing scheme, and under any future
// architecture — it is about identity, not about ports.
//
// Run: node --test tests/instance-identity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer(botName = 'Pepper') {
  const s = new LocalServer({
    port: 7865,
    getPref: (k) => ({ defaultMaxWaitForSpeechSec: 55, defaultSilenceSeconds: 1.4 })[k],
  });
  s.setRoom('wcj-odpo-wrb');
  s.callStatus = 'in-call';
  s.currentCallBotName = botName;
  return s;
}

// Minimal req/res. The refusal lives inside the HTTP handler, so this exercises
// the shipped path rather than a re-implementation of its decision.
function fakeExchange(botParam) {
  const res = { status: null, body: null,
    writeHead(s) { this.status = s; },
    end(b) { this.body = b ? JSON.parse(b) : null; } };
  const req = { on() {} };
  const url = new URL(`http://127.0.0.1/api/sync/wcj-odpo-wrb?wait=30&bot=${botParam}`);
  return { req, res, url };
}

function startWait(s, botParam) {
  const { req, res, url } = fakeExchange(botParam);
  const done = s._handleGet(req, res, url, 'wcj-odpo-wrb');
  return { res, done };
}

// A parked long-poll holds a 30s timer, which would keep the whole run alive
// for the full wait. Release anything still waiting when a test is done.
function release(s) {
  for (const w of [...s.waiters]) {
    clearTimeout(w.timer); clearTimeout(w.silenceTimer); clearTimeout(w.tickTimer);
    if (!w.resolved) { w.resolved = true; w.resolve({ success: true, transcript: { entries: [] } }); }
  }
  s.waiters = [];
}

test('a DIFFERENT bot is refused, not silently handed the room', async () => {
  const s = makeServer('Pepper');

  startWait(s, 'Pepper');                 // the incumbent, parked in its loop
  assert.equal(s.waiters.length, 1, 'precondition: Pepper is long-polling');

  const { res } = startWait(s, 'Buddy');  // Buddy's tools dialing the wrong port
  await new Promise((r) => setImmediate(r));

  assert.equal(res.status, 409);
  assert.equal(res.body.wrongInstance, true);
  assert.match(res.body.error, /wrong instance/i);
  assert.match(res.body.error, /7865/, 'the error must name the port that answered');
  assert.match(res.body.error, /list_call_instances/, 'and how to find the right one');

  assert.equal(s.waiters.length, 1, 'the incumbent keeps the room');
  assert.equal(s.waiters[0].bot, 'Pepper');
  assert.equal(s.waiters[0].resolved, false, 'Pepper must not be displaced by a stranger');
  release(s);
});

test('the SAME bot still displaces — that is what the guard is for', async () => {
  const s = makeServer('Pepper');

  const first = startWait(s, 'Pepper');
  startWait(s, 'Pepper');                 // a second agent on the same bot
  await new Promise((r) => setImmediate(r));

  const result = await first.done.then(() => first.res.body);
  assert.equal(result.displaced, true, 'a duplicate agent is evicted exactly as before');
  assert.equal(s.waiters.length, 1);
  release(s);
});

test('a caller that sends no name is not treated as a stranger', async () => {
  // Only an affirmative mismatch may refuse. An older agent that sends no `bot`
  // at all has to keep working, so "no idea" falls back to the old behaviour.
  const s = makeServer('Pepper');

  const first = startWait(s, '');
  startWait(s, '');
  await new Promise((r) => setImmediate(r));

  const result = await first.done.then(() => first.res.body);
  assert.equal(result.displaced, true);
  release(s);
});


