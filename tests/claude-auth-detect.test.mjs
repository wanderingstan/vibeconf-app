// claude-auth-detect.test.mjs — installed ≠ signed in (#137)
//
// Found live on the Jul 29 call: a user cold-installed, clicked Join, and his bot tile
// appeared and then did nothing for minutes. The spawned Terminal was sitting at Claude
// Code's login prompt. From inside the call an unauthenticated agent is indistinguishable
// from a crashed one, so the room debugged the wrong thing — on air.
//
// The detector's whole job is to be RIGHT or SILENT. A wrong "please sign in" shown to
// someone already signed in is worse than saying nothing, because it trains people to
// ignore the warning. Hence tri-state, and hence these tests: every degraded path must
// produce null, never false.
//
// Everything is driven through a fake $SHELL, which is the seam the detector uses
// (`$SHELL -lc 'claude auth status'`). Note you cannot test this by manipulating PATH:
// `-l` re-sources /etc/profile and macOS's path_helper puts the real PATH back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { detectClaudeAuth } = require(join(root, 'electron-app/claude-install.js'));

const dir = mkdtempSync(join(tmpdir(), 'vc-auth-test-'));
const fakeShell = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

// Each fake shell ignores its -lc argument and just prints what a real one would.
const SHELLS = {
  signedIn: fakeShell('in', `echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'`),
  signedOut: fakeShell('out', `echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'`),
  noisy: fakeShell('noisy', `echo 'Node Version Manager loaded'\necho '{"loggedIn":true,"authMethod":"api_key"}'`),
  missing: fakeShell('missing', `echo 'sh: claude: command not found' >&2\nexit 127`),
  garbage: fakeShell('garbage', `echo 'some banner, definitely not json'`),
  empty: fakeShell('empty', `exit 0`),
  hang: fakeShell('hang', `sleep 30`),
  halfJson: fakeShell('half', `echo '{"loggedIn":'`),
  wrongType: fakeShell('wrong', `echo '{"loggedIn":"yes"}'`),
};

async function underShell(path, opts) {
  const prev = process.env.SHELL;
  process.env.SHELL = path;
  try { return await detectClaudeAuth(opts); } finally { process.env.SHELL = prev; }
}

test('a signed-in user is reported signed in', async () => {
  const r = await underShell(SHELLS.signedIn);
  assert.equal(r.authed, true);
  assert.equal(r.method, 'claude.ai');
});

test('a signed-out user is reported signed out — this is the whole point', async () => {
  const r = await underShell(SHELLS.signedOut);
  assert.equal(r.authed, false);
});

test('exit code is NOT the signal — `claude auth status` exits 0 either way', async () => {
  // Both fixtures exit 0; only the parsed `loggedIn` distinguishes them.
  assert.equal((await underShell(SHELLS.signedIn)).authed, true);
  assert.equal((await underShell(SHELLS.signedOut)).authed, false);
});

test('login-shell noise before the JSON does not break parsing', async () => {
  assert.equal((await underShell(SHELLS.noisy)).authed, true);
});

// ── everything below must be null: unknown, never an accusation ──────────────

test('claude missing → null, not false', async () => {
  assert.equal((await underShell(SHELLS.missing)).authed, null);
});

test('unparseable output → null', async () => {
  assert.equal((await underShell(SHELLS.garbage)).authed, null);
});

test('no output at all → null', async () => {
  assert.equal((await underShell(SHELLS.empty)).authed, null);
});

test('truncated JSON → null', async () => {
  assert.equal((await underShell(SHELLS.halfJson)).authed, null);
});

test('loggedIn of the wrong type → null (a future CLI must not flip us to false)', async () => {
  assert.equal((await underShell(SHELLS.wrongType)).authed, null);
});

test('a hang times out to null rather than blocking the join', async () => {
  const t = Date.now();
  const r = await underShell(SHELLS.hang, { timeoutMs: 1200 });
  assert.equal(r.authed, null);
  assert.ok(Date.now() - t < 5000, 'must not block the join path');
});

// ── the call site ────────────────────────────────────────────────────────────

test('the join path warns only on an explicit false, and skips when already ready', async () => {
  const main = require('node:fs').readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('async function launchClaudeTerminal'));
  const block = fn.slice(0, fn.indexOf('buildTerminalCommand'));
  assert.match(block, /if\s*\(!claudeReady\)/, 'a proven-ready session must skip the check');
  assert.match(block, /auth\.authed === false/, 'must warn only on an explicit false, never on null');
  assert.doesNotMatch(block, /if\s*\(!auth\.authed\)/, 'truthiness would nag on unknown — the exact thing to avoid');
});
