// claude-cli-liveness.test.mjs — installed ≠ usable (#645)
//
// The phase-two preflight used to pass `claude CLI available` off a resolved path.
// On the Mac mini that same path answered every invocation with "Not logged in ·
// Please run /login", so six dispatched agents died on their first turn under a
// green preflight. These tests pin the distinction the check now makes: a probe
// that runs the CLI, and that names WHICH failure it hit, because "not installed",
// "not logged in" and "erroring" are three different jobs for whoever reads the
// morning digest.
//
// Driven through fake `claude` executables in a temp dir — same seam as
// claude-auth-detect.test.mjs, and for the same reason: nothing here may depend on
// whether the machine running the tests happens to be signed in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeClaudeCli, LIVENESS_PROMPT } from '../scripts/claude-cli-liveness.mjs';

const dir = mkdtempSync(join(tmpdir(), 'vc-claude-liveness-'));
const fakeClaude = (name, body) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

const BINS = {
  live: fakeClaude('live', 'echo OK'),
  loggedOut: fakeClaude('logged-out', "echo 'Not logged in · Please run /login' >&2\nexit 1"),
  // The observed failure is a message, not an exit code, so a CLI that says it
  // while exiting 0 must still fail the check.
  loggedOutZero: fakeClaude('logged-out-zero', "echo 'Not logged in · Please run /login'"),
  broken: fakeClaude('broken', "echo 'API Error: 500 upstream connect error' >&2\nexit 1"),
  silent: fakeClaude('silent', 'exit 0'),
  hang: fakeClaude('hang', 'sleep 30'),
  echoArgs: fakeClaude('echo-args', 'echo "$@"'),
};

test('a working CLI passes, and says what it heard back', () => {
  const r = probeClaudeCli(BINS.live);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'live');
  assert.match(r.detail, /OK/);
});

test('no binary at all is reported as missing, not as an error', () => {
  const r = probeClaudeCli(null);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'missing');
  assert.match(r.detail, /not found/);
});

test('the #645 failure: resolves, runs, and is not logged in', () => {
  const r = probeClaudeCli(BINS.loggedOut);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unauthenticated');
  // Whoever reads the digest has to know a human must sit at that keyboard.
  assert.match(r.detail, /\/login/);
});

test('not-logged-in is caught even when the CLI exits 0', () => {
  assert.equal(probeClaudeCli(BINS.loggedOutZero).state, 'unauthenticated');
});

test('any other non-zero exit is an error, quoting the first line', () => {
  const r = probeClaudeCli(BINS.broken);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'error');
  assert.match(r.detail, /500 upstream/);
});

test('exit 0 with no output is not a pass', () => {
  const r = probeClaudeCli(BINS.silent);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'silent');
});

test('a hung CLI times out instead of stalling the nightly', () => {
  const r = probeClaudeCli(BINS.hang, { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'timeout');
});

test('a binary that cannot be executed is an error, not a pass', () => {
  const r = probeClaudeCli(join(dir, 'does-not-exist'));
  assert.equal(r.ok, false);
  assert.equal(r.state, 'error');
});

test('the probe is one non-interactive turn — nothing that can raise a prompt', () => {
  const r = probeClaudeCli(BINS.echoArgs);
  assert.equal(r.ok, true);
  assert.match(r.detail, /-p /);
  assert.match(r.detail, /--max-turns 1/);
  assert.match(r.detail, new RegExp(LIVENESS_PROMPT));
});

test('the preflight check asserts liveness, not a resolved path', () => {
  const src = readFileSync(new URL('../scripts/bot-pr-pipeline.mjs', import.meta.url), 'utf8');
  assert.match(src, /probeClaudeCli\(claudeBin\)/, 'the pipeline must run the probe');
  assert.doesNotMatch(src, /check\('claude CLI available', !!claudeBin/,
    'the presence-only check is what #645 was about; it must not come back');
});
