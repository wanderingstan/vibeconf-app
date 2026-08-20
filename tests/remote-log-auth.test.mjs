// remote-log-auth.test.mjs — reading another machine's logs must not depend on
// a hand-distributed shared secret.
//
// The bug, measured 2026-08-18: every remote log read returned "unauthorized",
// and the key had been rotated several times trying to fix it. Two separate
// faults were stacked.
//
//   1. `VIBECONF_LOGS_TOKEN` reaches the MCP server only through the config's
//      `env` block. It was never set there, and it cannot come from ~/.zshrc —
//      the server is spawned by Claude Code, not by an interactive shell. (Same
//      trap CLAUDE.md documents for the Apple notarization creds.)
//   2. Once it WAS set, /api/logs still answered 401. The token path is dead.
//      The session cookie the app already sends beside it answers 200.
//
// So the shared token was never the working credential, and rotating it could
// not have helped. #386 moved remote-log WRITES onto the logged-in user's
// session; these tests pin reads to the same thing.
//
// Scope: this fixes reads for a logged-in human. A bot profile has no
// vc_session at all, which is a separate breakage with its own issue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const sessionLog = readFileSync(join(root, 'electron-app/session-log.js'), 'utf8');

test('remote log reads offer the logged-in user session, not only the shared token', () => {
  assert.match(server, /vc_session=/,
    'reads must send the same credential the write path uses');
  assert.match(server, /function _logAuthHeaders\(\)/);
});

test('both remote-log call sites go through the one auth helper', () => {
  // get_session_log({instance}) and list_log_instances hit the same backend and
  // must not drift apart — a fix applied to one and not the other is how this
  // stayed broken in one direction while appearing fine in the other.
  const calls = server.match(/_logAuthHeaders\(\)/g) || [];
  assert.ok(calls.length >= 3, `expected the helper at both call sites, saw ${calls.length}`);
  assert.doesNotMatch(
    server,
    /vfetch\([^)]*\{\s*headers:\s*\{\s*['"]x-vibe-logs-token['"]/,
    'no call site should hand-roll the token header any more');
});

test('the session is read per request, not captured at startup', () => {
  // An MCP server process routinely lives for DAYS — five on this machine were
  // between three and nine days old when this was written. Caching the session
  // at module load means logging in does not take effect until every one of
  // them is restarted, which is exactly the invisible state that made this hard
  // to diagnose.
  assert.match(server, /function _sessionCookie\(\)/);
  const decl = server.match(/^const .*_sessionCookie.*=.*readFileSync/m);
  assert.equal(decl, null, 'must be a function call per request, not a module-level constant');
});

test('the local app still authorizes by its own per-port token, unchanged', () => {
  // #356: 127.0.0.1 calls carry the local bearer token. The session cookie is
  // for the BACKEND only; sending an app-login credential to a local port would
  // be a different trust boundary.
  assert.match(server, /local-tokens/);
  assert.match(server, /Authorization: `Bearer \$\{tok\}`/);
});

test('an unauthorized read says which credentials were offered', () => {
  // The failure that cost the most time said only "unauthorized", which reads
  // as "your token is wrong" and sends you to rotate a key that was never
  // consulted. Naming what was actually sent points at the real gap.
  assert.match(server, /unauthorized — sent:/);
  assert.match(server, /no credentials/);
  assert.match(server, /Log in to vibeconferencing\.com/);
});

test('the write path still sends both credentials, as the reference behaviour', () => {
  // Reads were modelled on this. If the app ever stops sending the cookie, the
  // assumption underneath this whole change is gone.
  assert.match(sessionLog, /headers\['Cookie'\] = 'vc_session=' \+ _sess/);
  assert.match(sessionLog, /x-vibe-logs-token/);
});
