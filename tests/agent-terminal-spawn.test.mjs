// agent-terminal-spawn.test.mjs — who gets a spawned Claude, and who doesn't.
//
// The app opens a Terminal running Claude to drive the bot. That is right for
// the panel's "Call <bot> now" button: a human pressed it, nothing else is
// attached, and without the spawn the bot is a face in the room with nobody
// behind it.
//
// It is wrong when the request arrived over MCP. An agent asking to start a call
// IS the agent — spawning a second one gives the call two drivers racing for
// wait_for_speech. On 2026-07-29 that displaced the session that made the call:
// it started the call, went to listen, and was told "Session displaced: another
// agent started listening on this call."
//
// main.js and local-server.js are not requirable without an Electron/runtime
// environment, so these pin the decision at the source.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');

// Comments discuss the incident by name; strip them so prose can't satisfy a
// check that is meant to be about code.
const codeOnly = (src) => src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('joinMeetUrl takes a spawnAgent option, defaulting to spawning', () => {
  // Default true: the panel paths pass nothing, and they are the ones that need
  // the terminal. A default of false would silently leave those bots driverless.
  assert.match(main, /function joinMeetUrl\(meetUrl, \{ spawnAgent = true, onboardingCall = false \} = \{\}\)/);
});

test('the terminal launch inside joinMeetUrl is actually gated', () => {
  // The whole bug was an unconditional call here.
  const start = codeOnly(main).indexOf('function joinMeetUrl(');
  assert.ok(start > 0);
  const body = codeOnly(main).slice(start, start + 1200);
  assert.match(body, /if \(spawnAgent\)/, 'launchClaudeTerminal must be conditional');
  const launchAt = body.indexOf('launchClaudeTerminal');
  const guardAt = body.indexOf('if (spawnAgent)');
  assert.ok(guardAt > 0 && guardAt < launchAt, 'the guard must precede the launch');
});

test('createAndJoinMeet threads the flag rather than dropping it', () => {
  assert.match(main, /async function createAndJoinMeet\(\{ openBrowser = true, spawnAgent = true, onboardingCall = false \} = \{\}\)/);
  assert.match(main, /joinMeetUrl\(r\.json\.meetingUri, \{ spawnAgent, onboardingCall \}\)/,
    'the flags must reach joinMeetUrl, or threading them changes nothing');
});

test('the panel button still gets its terminal', () => {
  // It calls createAndJoinMeet with no options (or just onboardingCall for the
  // Setup button), so the spawnAgent default still applies either way. If this
  // ever starts passing spawnAgent:false, the button silently stops working.
  assert.match(main, /ipcMain\.handle\('create-and-join-meet', async \(_e, opts\) => createAndJoinMeet\(opts \|\| \{\}\)\)/);
});

test('/api/call/start defaults to NOT spawning, since its caller is an agent', () => {
  const start = server.indexOf("url.pathname === '/api/call/start'");
  assert.ok(start > 0, 'the start-call route should still exist');
  const route = server.slice(start, start + 1600);
  assert.match(codeOnly(route), /let spawnAgent = false;/,
    'reaching this route means an MCP client asked, and that client is the agent');
  assert.match(codeOnly(route), /onStartCall\(\{ openBrowser, spawnAgent \}\)/,
    'the flag must be passed on');
});

test('/api/call/start can still opt IN to a spawn', () => {
  // A bare curl or a script has no agent behind it; a driverless bot in the room
  // is the worse outcome there.
  const start = server.indexOf("url.pathname === '/api/call/start'");
  const route = codeOnly(server.slice(start, start + 1600));
  assert.match(route, /parsed\.spawnAgent === true.*spawnAgent = true/s,
    'an explicit opt-in must still be honoured');
});
