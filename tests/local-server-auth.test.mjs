// local-server-auth.test.mjs — the local control server requires its bearer token
// by default (#356 built it, #201 turned it on).
//
// Why this matters enough to pin: 127.0.0.1 is machine-wide on macOS, but each
// user account assigns profile ports from its OWN registry. So an agent in a
// second user account can reach — and drive — the first account's app. With no
// auth that failure is SILENT: the agent joins and speaks into the wrong app
// while the bot in front of the user sits mute, and neither side logs anything.
// The token turns that into a 401.
//
// Source assertions rather than a live server: enforcement is read from the
// environment inside _handleRequest, so booting a real server here would test
// this process's env, not the shipped default.
//
// Run: node --test tests/local-server-auth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');

test('auth is ON unless explicitly disabled', () => {
  // The bug this pins: it used to be `!!process.env.VIBECONF_REQUIRE_TOKEN`,
  // which is off unless someone opts in — and nobody does, so every install ran
  // an open control server.
  assert.match(server, /const requireAuth = process\.env\.VIBECONF_REQUIRE_TOKEN !== '0'/);
  assert.doesNotMatch(server, /const requireAuth = !!process\.env\.VIBECONF_REQUIRE_TOKEN/);
});

test('discovery stays open, so instance scanning still works', () => {
  // GET /api/sync/no-room must NOT require the token: it is how the MCP and the
  // join-call skill find a running app, and it returns only coarse status. Lock
  // it and every discovery path breaks at once.
  assert.match(server, /reqPath === '\/api\/sync\/no-room'/);
  // /asset/<token> carries its own per-asset capability token in the path (#157).
  assert.match(server, /reqPath\.startsWith\('\/asset\/'\)/);
});

test('the token is compared in constant time', () => {
  assert.match(server, /timingSafeEqual/);
  // A length check has to come first — timingSafeEqual throws on mismatched
  // lengths, which would turn a wrong-length token into a 500, not a 401.
  const gate = server.slice(server.indexOf('const presented'));
  assert.ok(gate.indexOf('presented.length === this.authToken.length') < gate.indexOf('timingSafeEqual'),
    'length must be checked before timingSafeEqual, or a short token throws');
});

test('the MCP reads the token per port, not once at startup', () => {
  // The token is per-launch and per-port. Caching it would break the moment the
  // app restarts, and — more to the point here — reading it by PORT is what
  // makes a foreign instance fail: another user account's app has a different
  // token in a different home directory, so nothing we hold will match it.
  assert.match(mcp, /local-tokens", `\$\{port\}\.token`/);
});
