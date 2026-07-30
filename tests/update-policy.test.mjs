// update-policy.test.mjs — the decisions around self-updating.
//
// electron-updater's mechanism isn't ours to test, but WHEN we let it run is,
// and every rule here exists because getting it wrong is expensive: dropping a
// bot mid-call, four bots racing to install into one app bundle, or telling a
// deb user about an update that can never install.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../electron-app/update-policy.js');

test('a packaged mac/windows build can update itself', () => {
  assert.equal(P.canAutoUpdate({ platform: 'darwin', packaged: true }).ok, true);
  assert.equal(P.canAutoUpdate({ platform: 'win32', packaged: true }).ok, true);
});

test('Linux updates only from an AppImage, never from a deb', () => {
  const appimage = P.canAutoUpdate({ platform: 'linux', packaged: true, env: { APPIMAGE: '/tmp/App.AppImage' } });
  assert.equal(appimage.ok, true, 'AppImage sets APPIMAGE and self-updates');

  const deb = P.canAutoUpdate({ platform: 'linux', packaged: true, env: {} });
  assert.equal(deb.ok, false, 'a deb is apt-owned — never rewrite it behind the package manager');
  assert.equal(deb.reason, 'linux-not-appimage');
});

test('a dev checkout never tries to update itself', () => {
  const dev = P.canAutoUpdate({ platform: 'darwin', packaged: false });
  assert.equal(dev.ok, false);
  assert.equal(dev.reason, 'dev-build');
});

const BASE = { platform: 'darwin', packaged: true };
const alive = () => true;
const dead = () => false;

test('any profile may check — a lone named instance is not locked out', () => {
  // The bug this replaced: a shortcut that always launches --profile=bot2 meant
  // no default instance ever ran, so the machine never updated at all.
  const bot2 = P.shouldCheck({ ...BASE, lease: null, profile: 'bot2', pid: 42 });
  assert.equal(bot2.ok, true);
  assert.deepEqual(bot2.lease, { pid: 42, profile: 'bot2', at: bot2.lease.at });
});

test('one updater at a time — a sibling holding a live lease is turned away', () => {
  const held = { pid: 1, profile: 'default', at: 1_000 };
  const other = P.shouldCheck({ ...BASE, lease: held, pid: 2, now: 2_000, isAlive: alive });
  assert.equal(other.ok, false, 'the incumbent is alive and its lease is fresh');
  assert.equal(other.reason, 'another-instance-updating');
  assert.deepEqual(other.lease, held, 'the incumbent is returned, so we can name it');
});

test('the lease holder renews its own lease rather than blocking itself', () => {
  const mine = { pid: 7, profile: 'bot2', at: 1_000 };
  const again = P.shouldCheck({ ...BASE, lease: mine, pid: 7, now: 9_000, isAlive: alive });
  assert.equal(again.ok, true);
  assert.equal(again.lease.at, 9_000, 'renewed to now');
});

test('a crashed holder never wedges the machine — two independent ways out', () => {
  const held = { pid: 1, profile: 'default', at: 1_000 };

  // 1. Its process is gone. No release ever ran, but we can see it died.
  const crashed = P.claimUpdaterLease({ lease: held, pid: 2, now: 2_000, isAlive: dead });
  assert.equal(crashed.ok, true, 'holder is gone');

  // 2. Its pid is somehow still alive (pid reuse, a paused process) but the
  //    lease aged out. Belt and braces: either alone frees it.
  const expired = P.claimUpdaterLease({
    lease: held, pid: 2, now: 1_000 + P.UPDATER_LEASE_MS, isAlive: alive, leaseMs: P.UPDATER_LEASE_MS,
  });
  assert.equal(expired.ok, true, 'lease aged out even though the pid answers');
});

test('a corrupt or absent lease file reads as free, not as blocked', () => {
  for (const lease of [null, undefined, {}, { pid: 'nonsense' }]) {
    assert.equal(P.claimUpdaterLease({ lease, pid: 3 }).ok, true, `${JSON.stringify(lease)} must not wedge it`);
  }
});

test('holding the lease does not override an unupdatable build', () => {
  const deb = P.shouldCheck({ platform: 'linux', packaged: true, env: {}, lease: null, pid: 1 });
  assert.equal(deb.ok, false, 'still a deb');
  assert.equal(deb.reason, 'linux-not-appimage');
});

test('installing waits for the call to end, including while joining', () => {
  assert.equal(P.canInstallNow({ callStatus: 'idle' }).ok, true);
  assert.equal(P.canInstallNow({ callStatus: 'left' }).ok, true, 'the call is over');

  for (const status of ['navigating', 'joining', 'waiting-to-be-admitted', 'in-call']) {
    const r = P.canInstallNow({ callStatus: status });
    assert.equal(r.ok, false, `${status} is live — restarting would drop the bot`);
    assert.equal(r.reason, 'in-call');
  }
});

test('the first check is delayed and jittered, so a fleet does not stampede', () => {
  assert.equal(P.firstCheckDelayMs({ base: 45_000, jitter: 60_000, random: () => 0 }), 45_000);
  assert.equal(P.firstCheckDelayMs({ base: 45_000, jitter: 60_000, random: () => 1 }), 105_000);

  // Distinct instances must not land on the same moment.
  const a = P.firstCheckDelayMs({ random: () => 0.1 });
  const b = P.firstCheckDelayMs({ random: () => 0.9 });
  assert.notEqual(a, b);
});
