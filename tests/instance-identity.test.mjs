// instance-identity.test.mjs — #517/#518: which app instance is a session
// actually driving, and who is allowed to displace whom.
//
// From the 2026-08-24 standup, the first time two bots were brought into one
// call from two terminals. Seth started Buddy in its own terminal; Buddy spoke,
// and the words came out of PEPPER's Meet tile. Buddy diagnosed it out loud:
//
//   "The ports are different. I'm Buddy on 7866, Pepper's on 7865. The real bug
//    is my MCP tools are pointed at Pepper's port."
//
// Two separate defects, and each hid the other:
//
//   #517 — a hand-started terminal inherits a machine-wide fallback port that
//          looked like an explicit pin, so it drove the primary app for life.
//   #518 — the single-agent guard evicted whoever was already long-polling
//          without checking who they were, so Pepper's loop exited silently
//          instead of Buddy's mistake surfacing as an error.
//
// Run: node --test tests/instance-identity.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const serverJs = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

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

test('addressing a foreign instance is said out loud, once', () => {
  // Buddy only worked it out by asking get_room_info which profile answered.
  // That should not take detective work — but it is a warning, not a refusal,
  // because a display name and a configured name can legitimately differ.
  const s = makeServer('Pepper');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    s._warnIfForeignCaller('Buddy');
    s._warnIfForeignCaller('Buddy');
    s._warnIfForeignCaller('Pepper');
  } finally { console.warn = realWarn; }

  const foreign = warnings.filter((w) => w.includes('[instance]'));
  assert.equal(foreign.length, 1, 'once per foreign name, not once per poll');
  assert.match(foreign[0], /Buddy is calling Pepper's app/);
  assert.match(foreign[0], /7865/);
});

test('only the app-written per-profile config counts as a pin', () => {
  // #517's root cause: BOTH the per-profile config and the user-scoped
  // ~/.claude.json set VIBECONF_BASE_URL, and the MCP server could not tell a
  // real pin from the machine-wide fallback aimed at the primary app.
  assert.match(mainJs, /VIBECONF_INSTANCE_PIN: '1'/,
    'the app must mark the config it writes for a specific profile');

  // The marker belongs to the per-profile config only. The user-scoped writer
  // uses DEFAULT_PORT, and marking that would restore the bug.
  const userScoped = mainJs.slice(mainJs.indexOf('claudeJson.mcpServers.vibeconferencing = {'));
  assert.ok(!userScoped.slice(0, 500).includes('VIBECONF_INSTANCE_PIN'),
    'the machine-wide fallback must never claim to be a pin');

  const pin = serverJs.slice(serverJs.indexOf('const PINNED_PORT'));
  assert.match(pin.slice(0, 260), /if \(!process\.env\.VIBECONF_INSTANCE_PIN\) return null;/,
    'an unmarked VIBECONF_BASE_URL is a fallback, so it must not pin');
});
