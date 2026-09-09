// pre-test-check.test.mjs — the 19:00 readiness check.
//
// Guards the two things that were wrong in its first draft, both of which are
// silent failures: reading the preflight's `status` field (an earlier version
// tested a boolean `ok` that never exists, so every preflight failure was
// swallowed), and counting only MAIN app processes (helper children were being
// reported as extra nameless instances).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/pre-test-check.mjs');

// A throwaway "repo" whose ecosystem-preflight is a stub we control.
function repoWithPreflight(json) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'pretest-'));
  fs.mkdirSync(join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(join(dir, 'scripts/ecosystem-preflight.mjs'),
    `console.log(${JSON.stringify(JSON.stringify(json))});\n`);
  return dir;
}

const run = (repo) => JSON.parse(execFileSync('node', [script, '--json'], {
  encoding: 'utf8',
  env: { ...process.env, VIBECONF_REPO: repo, VIBECONF_NOTIFY_CHAT: '' },
}));

test('a down preflight check becomes a blocking finding', () => {
  const repo = repoWithPreflight({ ok: false, checks: [
    { name: 'redis (whiteboard state)', status: 'down', detail: 'read failed' },
  ] });
  const out = run(repo);
  const hit = out.findings.find((f) => f.title.startsWith('Preflight: redis'));
  assert.ok(hit, `expected a preflight finding, got: ${out.findings.map((f) => f.title).join(', ')}`);
  assert.equal(hit.level, 'red');
  assert.match(hit.detail, /read failed/);
});

test('a warn preflight check is advisory, not blocking', () => {
  const repo = repoWithPreflight({ ok: true, checks: [
    { name: 'vibeconferencing.com session', status: 'warn', detail: 'expires in 3 days' },
  ] });
  const hit = run(repo).findings.find((f) => f.title.startsWith('Preflight: vibeconferencing.com'));
  assert.ok(hit);
  assert.equal(hit.level, 'warn');
});

test('an all-ok preflight contributes nothing', () => {
  const repo = repoWithPreflight({ ok: true, checks: [{ name: 'website', status: 'ok', detail: 'HTTP 200' }] });
  assert.equal(run(repo).findings.filter((f) => f.title.startsWith('Preflight:')).length, 0);
});

test('helper processes are not counted as running instances', () => {
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /!\/Helper\/\.test\(l\)/, 'must exclude "… Helper" children when counting instances');
});

test('it never exits non-zero, whatever it finds', () => {
  // A wrapper (or a human) must never read this check as the night being broken.
  const repo = repoWithPreflight({ ok: false, checks: [{ name: 'x', status: 'down', detail: 'y' }] });
  const r = execFileSync('node', [script], {
    encoding: 'utf8', env: { ...process.env, VIBECONF_REPO: repo, VIBECONF_NOTIFY_CHAT: '' },
  });
  assert.match(r, /blocking/);
});

test('it refuses to send without an explicit chat id', () => {
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /if \(!CHAT\)/, 'no chat id must mean no send — never a default group');
});
