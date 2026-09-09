// fleet-lock.test.mjs — one holder at a time for the shared test fleet (#720).
//
// The nightly and the CI app-health smoke both spawn test-meet-guest-1 on port
// 7901; GitHub's `concurrency:` cannot see a launchd job, so the mutual
// exclusion has to live here. The cases below are the ones that decide whether
// this helps or hurts: a lock nobody releases would cancel every future night,
// which is worse than the collision it prevents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/fleet-lock.mjs');

let n = 0;
const freshLock = () => join(fs.mkdtempSync(join(os.tmpdir(), `flock-${n++}-`)), 'fleet.lock');
function run(lock, args) {
  try {
    const stdout = execFileSync('node', [script, ...args], {
      encoding: 'utf8', env: { ...process.env, VIBECONF_FLEET_LOCK: lock }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) { return { code: e.status, stdout: e.stdout || '' }; }
}

test('a second holder cannot take a live lock, and times out', () => {
  const lock = freshLock();
  assert.equal(run(lock, ['acquire', 'nightly', '--pid', String(process.pid)]).code, 0);
  const second = run(lock, ['acquire', 'ci-smoke', '--pid', String(process.pid), '--wait', '1']);
  assert.equal(second.code, 75, 'contending caller must exit 75 (EX_TEMPFAIL), not 0');
});

test('a lock whose holder died is broken, not honoured', () => {
  // The nightly watchdog SIGKILLs a wedged run; the runner cancels a step
  // mid-flight. Either leaves the file behind, and honouring it would silently
  // cancel every subsequent night.
  const lock = freshLock();
  fs.writeFileSync(lock, JSON.stringify({ owner: 'dead', pid: 999999, startedAt: new Date().toISOString() }));
  assert.equal(run(lock, ['acquire', 'nightly', '--pid', String(process.pid)]).code, 0);
});

test('a lock held far too long is broken even if its pid is alive', () => {
  // Guards pid reuse and a genuinely hung holder.
  const lock = freshLock();
  fs.writeFileSync(lock, JSON.stringify({ owner: 'hung', pid: process.pid, startedAt: '2020-01-01T00:00:00Z' }));
  assert.equal(run(lock, ['acquire', 'nightly', '--pid', String(process.pid)]).code, 0);
});

test('only the owner may release', () => {
  const lock = freshLock();
  run(lock, ['acquire', 'nightly', '--pid', String(process.pid)]);
  run(lock, ['release', 'ci-smoke', '--pid', '12345']);
  assert.ok(fs.existsSync(lock), 'a non-owner must not be able to hand the fleet to someone else');
  run(lock, ['release', 'nightly', '--pid', String(process.pid)]);
  assert.ok(!fs.existsSync(lock), 'the owner must be able to release');
});

test('the lock path is fixed, never TMPDIR', () => {
  // macOS gives each process a private per-user TMPDIR; a launchd job and the
  // Actions runner would take two different "shared" locks and never meet.
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /VIBECONF_FLEET_LOCK \|\| '\/tmp\/vibeconf-fleet\.lock'/);
  assert.doesNotMatch(src, /TMPDIR/i.test(src) ? /process\.env\.TMPDIR/ : /$^/);
});

test('both callers take the lock, and the nightly releases it on exit', () => {
  const wrapper = fs.readFileSync(join(root, 'scripts/scheduled-meet-test.sh'), 'utf8');
  const workflow = fs.readFileSync(join(root, '.github/workflows/smoke.yml'), 'utf8');
  assert.match(wrapper, /fleet-lock\.mjs"? acquire nightly/);
  assert.match(wrapper, /release_fleet_lock/);
  // Released from the EXIT trap, so a bailing or watchdog-killed run still frees it.
  for (const m of wrapper.match(/trap 'send_digest.*?' EXIT/gs) || []) {
    assert.match(m, /release_fleet_lock/, 'every EXIT trap must release the lock');
  }
  assert.match(workflow, /fleet-lock\.mjs"? acquire ci-smoke/);
  assert.match(workflow, /fleet-lock\.mjs"? release ci-smoke/);
});

test('the nightly gate reads node\'s exit status, not a pipeline\'s', () => {
  // `if ! node … | tee` tests TEE, which is always 0, so the gate silently never
  // fires and a locked-out run walks straight into the suite — which is exactly
  // what happened the first time this was wired.
  const wrapper = fs.readFileSync(join(root, 'scripts/scheduled-meet-test.sh'), 'utf8');
  assert.doesNotMatch(wrapper, /if ! node "\$REPO\/scripts\/fleet-lock\.mjs"[^\n]*\| tee/,
    'the lock gate must not take its status from a pipeline');
  assert.match(wrapper, /_lock_rc=\$\?/, 'capture the acquire exit code directly');
  assert.match(wrapper, /if \(\( _lock_rc != 0 \)\); then/);
});
