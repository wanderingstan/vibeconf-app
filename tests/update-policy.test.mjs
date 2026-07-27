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

test('only the default instance checks — N bots must not race into one bundle', () => {
  const base = { platform: 'darwin', packaged: true };
  assert.equal(P.shouldCheck({ ...base, isDefaultInstance: true }).ok, true);

  const named = P.shouldCheck({ ...base, isDefaultInstance: false });
  assert.equal(named.ok, false);
  assert.equal(named.reason, 'not-default-instance');
});

test('being the default instance does not override an unupdatable build', () => {
  const deb = P.shouldCheck({ platform: 'linux', packaged: true, env: {}, isDefaultInstance: true });
  assert.equal(deb.ok, false, 'still a deb');
  assert.equal(deb.reason, 'linux-not-appimage');
});

test('installing waits for the call to end, including while joining', () => {
  assert.equal(P.canInstallNow({ callStatus: 'idle' }).ok, true);
  assert.equal(P.canInstallNow({ callStatus: 'left' }).ok, true, 'the call is over');

  for (const status of ['joining', 'waiting-to-be-admitted', 'in-call']) {
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
