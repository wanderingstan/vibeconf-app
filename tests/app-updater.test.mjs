// app-updater.js: checking for and installing updates, now owned by the app
// window rather than every bot process (#301). Driven here with a fake
// electron-updater and fake dialogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAppUpdater } = require('../electron-app/app-updater.js');

function harness({ latest = '9.9.9', blocked = null, packaged = true } = {}) {
  const dialogs = [];
  const answers = [];
  const calls = [];
  const fake = Object.assign(new EventEmitter(), {
    checkForUpdates: async () => ({ updateInfo: { version: latest } }),
    quitAndInstall: () => calls.push('quitAndInstall'),
  });
  const appEvents = new EventEmitter();
  const app = { isPackaged: packaged, getVersion: () => '1.0.0', on: (e, f) => appEvents.on(e, f), focus: () => {} };
  const u = createAppUpdater({
    app,
    baseUserData: fs.mkdtempSync(path.join(os.tmpdir(), 'app-updater-')),
    profile: 'app window',
    installBlocked: async () => (typeof blocked === 'function' ? blocked() : blocked),
    beforeInstall: async () => { calls.push('beforeInstall'); },
    bringForward: () => calls.push('bringForward'),
    getAutoUpdater: () => fake,
    getElectron: () => ({
      dialog: { showMessageBox: async (...a) => { const opts = a[a.length - 1]; dialogs.push({ parent: a.length > 1 ? a[0] : null, ...opts }); return { response: answers.shift() ?? 0 }; } },
      shell: { openExternal: () => {} },
    }),
    log: () => {}, warn: () => {},
  });
  return { u, fake, dialogs, answers, calls };
}

test('a manual check says an update was found the moment it is, before the download', async () => {
  const { u, dialogs } = harness();
  await u.check({ silentWhenCurrent: false });
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /Update available: Vibeconferencing 9\.9\.9/);
});

test('a manual check on the current build says so; a background one says nothing', async () => {
  const a = harness({ latest: '1.0.0' });
  await a.u.check({ silentWhenCurrent: false });
  assert.match(a.dialogs[0].message, /1\.0\.0 is up to date/);
  const b = harness({ latest: '1.0.0' });
  await b.u.check();
  assert.equal(b.dialogs.length, 0);
});

test('with no window to attach to, a dialog stands alone and the app comes forward (no invisible sheet)', async () => {
  const { u, dialogs, calls } = harness();
  await u.check({ silentWhenCurrent: false });
  assert.equal(dialogs[0].parent, null);
  assert.ok(calls.includes('bringForward'));
});

test('a staged build waits while a bot is in a call, then installs after stopping the bots', async () => {
  let inCall = true;
  const { u, fake, dialogs, calls } = harness({ blocked: () => (inCall ? 'in-call' : null) });
  u.start();
  fake.emit('update-downloaded', { version: '9.9.9' });
  await new Promise((r) => setImmediate(r));
  assert.equal(dialogs.length, 0, 'not offered mid-call');
  inCall = false;
  await u.offerStaged();
  assert.match(dialogs[0].message, /9\.9\.9 is ready to install/);
  assert.deepEqual(calls.filter((c) => c !== 'bringForward'), ['beforeInstall', 'quitAndInstall'], 'bots stopped before the installer quits the app');
});

test('"Later" does not install, and the same version is not offered again', async () => {
  const { u, fake, dialogs, answers, calls } = harness();
  u.start();
  answers.push(1);
  fake.emit('update-downloaded', { version: '9.9.9' });
  await new Promise((r) => setImmediate(r));
  await u.offerStaged();
  assert.equal(dialogs.length, 1);
  assert.ok(!calls.includes('quitAndInstall'));
});

test('a dev build never checks, and a manual check explains why', async () => {
  const { u, dialogs } = harness({ packaged: false });
  assert.equal(u.start(), false);
  await u.check({ silentWhenCurrent: false });
  assert.match(dialogs[0].detail, /development build/);
});
