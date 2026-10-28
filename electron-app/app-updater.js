// app-updater.js — checking for, downloading and installing app updates.
//
// The mechanism is electron-updater's; the decisions (is this build updatable,
// is this process the one that checks, is it safe to restart) are
// update-policy.js. This is the part in between, and it used to live in
// main.js, which meant every BOT process ran it. With one app window running
// the bots as its children (#301), that was backwards: an update is a property
// of the installed app, not of a bot, and the window's menu had no "Check for
// Updates…" at all because the code that answers it was in the children.
//
// Now the app window owns it (supervisor-app.js), and a bot it hosts does not
// check. A bot launched on its own (classic mode, the test fleet) still runs
// it; the machine-wide lease in update-policy.js keeps that to one at a time.
//
// Everything that differs between the two hosts is injected:
//   dialogParent()   the window a dialog attaches to, or null for a free-standing one
//   bringForward()   make a free-standing dialog visible (it is another process's click)
//   installBlocked() a reason not to restart now ('in-call'), or null
//   beforeInstall()  last thing before quitAndInstall (stop bots, mark the quit intended)
'use strict';

const fs = require('fs');
const path = require('path');
const updatePolicy = require('./update-policy');

function createAppUpdater({
  app,
  baseUserData,
  profile = null,
  updateChannel = () => 'release',
  dialogParent = () => null,
  bringForward = () => {},
  installBlocked = async () => null,
  beforeInstall = async () => {},
  log = (...a) => console.log('[updates]', ...a),
  warn = (...a) => console.warn('[updates]', ...a),
  getAutoUpdater = () => require('electron-updater').autoUpdater,
  getElectron = () => require('electron'),
  repo = process.env.VIBECONF_UPDATE_REPO || 'wanderingstan/vibeconf-app',
  platform = process.platform,
  env = process.env,
} = {}) {
  let checkInFlight = false;
  let downloaded = null;      // the info of a build staged and waiting to install
  let notifiedFor = null;     // don't re-nag about a version already declined
  let manualPending = false;  // a menu-triggered check is waiting to hear back

  function showDialog(opts) {
    const { dialog } = getElectron();
    const parent = dialogParent();
    if (parent && !parent.isDestroyed()) return dialog.showMessageBox(parent, opts);
    try { bringForward(); } catch { /* best effort */ }
    return dialog.showMessageBox(opts);
  }

  // A menu "Check for Updates…" must give feedback the MOMENT an update is found,
  // not after the whole build finishes downloading (autoDownload is on, so a
  // plain menu check would otherwise sit silent through the entire download and
  // look dead). Fired from 'update-available' (right after the check, before the
  // download) AND, as a fallback, from check()'s found branch, whichever comes
  // first. Idempotent via manualPending, so the background check stays quiet.
  function announceManualDownloading(version) {
    if (!manualPending) return;
    manualPending = false;
    showDialog({
      type: 'info',
      message: `Update available: Vibeconferencing ${version}`,
      detail: "It's downloading in the background now. You'll get a prompt to install "
        + "when it's ready, and you can keep working until then.",
      buttons: ['OK'],
    });
  }

  let instance = null;
  function autoUpdater() {
    if (instance) return instance;
    instance = getAutoUpdater();
    instance.logger = { info: (m) => log(m), warn: (m) => warn(m), error: (m) => warn(m), debug: () => {} };
    // We ship CLEAN SEMVER (0.8.10, 0.8.11, …), so electron-updater never turns
    // prereleases on by itself; the 'candidate' channel (Stan + Seth) opts into
    // the GitHub prereleases that are tested before promotion. 'release' (real
    // users) sees only promoted builds. Fail safe to 'release'.
    try { instance.allowPrerelease = updateChannel() === 'candidate'; } catch { instance.allowPrerelease = false; }
    // Stage the download, but never restart on our own: installing is gated on
    // not being in a call, and the user gets the last word either way.
    instance.autoDownload = true;
    instance.autoInstallOnAppQuit = true;
    return instance;
  }

  // The lease lives in the app-level directory every profile shares; one in a
  // per-profile directory would be invisible to the processes it coordinates.
  const leasePath = () => path.join(baseUserData, 'updater-lease.json');
  function readLease() {
    try { return JSON.parse(fs.readFileSync(leasePath(), 'utf8')); } catch { return null; }
  }
  function writeLease(lease) {
    try { fs.writeFileSync(leasePath(), JSON.stringify(lease)); } catch (err) { warn('could not write lease:', err.message); }
  }
  // Drop the lease on a clean quit so another process takes over at once rather
  // than waiting out the expiry, which is what covers an unclean exit.
  function releaseLease() {
    const held = readLease();
    if (held && held.pid === process.pid) {
      try { fs.unlinkSync(leasePath()); } catch { /* already gone */ }
    }
  }
  const context = () => ({ platform, packaged: app.isPackaged, env, lease: readLease(), profile });

  // Offer the staged build. Called when a download finishes and again when a
  // call ends, since the usual sequence is "update arrives mid-call, install after".
  async function offerStaged() {
    if (!downloaded) return;
    const version = downloaded.version;
    if (notifiedFor === version) return;
    const blocked = await installBlocked();
    if (blocked) { log(`${version} staged; waiting (${blocked})`); return; }
    notifiedFor = version;

    const { response } = await showDialog({
      type: 'info',
      message: `Vibeconferencing ${version} is ready to install.`,
      detail: 'It has already downloaded. Restarting takes a few seconds, or it '
        + 'will install by itself the next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;
    // Re-check: the dialog is not modal to the world, and a call can start
    // while it sits open.
    const stillBlocked = await installBlocked();
    if (stillBlocked) { log(`install cancelled: ${stillBlocked} started while asking`); return; }
    try { await beforeInstall(); } catch (err) { warn('beforeInstall failed:', err.message); }
    autoUpdater().quitAndInstall();
  }

  async function check({ silentWhenCurrent = true } = {}) {
    if (checkInFlight) return;
    const { shell } = getElectron();
    const allowed = updatePolicy.shouldCheck(context());
    if (!allowed.ok) {
      log(`skipped (${allowed.reason})`);
      // A manual check should say something even when it can't run: silence
      // would look broken.
      if (!silentWhenCurrent) {
        if (allowed.reason === 'another-instance-updating') {
          const who = allowed.lease && allowed.lease.profile;
          await showDialog({
            type: 'info',
            message: 'Updates are already being checked.',
            detail: `${who ? `The "${who}" bot` : 'Another copy of the app'} is checking for this machine. `
              + 'Only one does at a time, so the same build is never downloaded twice. '
              + 'Quit it and this one takes over.',
            buttons: ['OK'],
          });
          return;
        }
        const DETAIL = {
          'dev-build': 'This is a development build, so there is nothing to update.',
          'linux-not-appimage': 'This copy was installed from a .deb, which your package '
            + 'manager owns. Download new builds from the Releases page (or use the AppImage, '
            + 'which updates itself).',
        };
        const buttons = allowed.reason === 'linux-not-appimage' ? ['Open Releases Page', 'OK'] : ['OK'];
        const { response } = await showDialog({
          type: 'info',
          message: 'Automatic updates are not available for this build.',
          detail: DETAIL[allowed.reason] || allowed.reason,
          buttons,
          defaultId: buttons.length - 1,
          cancelId: buttons.length - 1,
        });
        if (buttons[response] === 'Open Releases Page') shell.openExternal(`https://github.com/${repo}/releases`);
      }
      return;
    }

    // Claimed: record it before any slow work, so another process checking a
    // second later sees the lease rather than starting its own download.
    writeLease(allowed.lease);
    // Already staged: re-offer instead of downloading it twice.
    if (downloaded) { notifiedFor = null; await offerStaged(); return; }

    checkInFlight = true;
    manualPending = !silentWhenCurrent;
    const current = app.getVersion();
    try {
      const result = await autoUpdater().checkForUpdates();
      const found = result && result.updateInfo && result.updateInfo.version !== current;
      if (found) {
        announceManualDownloading(result.updateInfo.version);
      } else if (!silentWhenCurrent) {
        manualPending = false;
        await showDialog({ type: 'info', message: `Vibeconferencing ${current} is up to date.`, buttons: ['OK'] });
      }
    } catch (err) {
      warn('check failed:', err.message);
      manualPending = false;
      if (!silentWhenCurrent) {
        const { response } = await showDialog({
          type: 'error',
          message: 'Could not check for updates.',
          detail: `${err.message}\n\nYou can always download the latest build from the Releases page.`,
          buttons: ['Open Releases Page', 'OK'],
          defaultId: 1,
          cancelId: 1,
        });
        if (response === 0) shell.openExternal(`https://github.com/${repo}/releases`);
      }
    } finally {
      checkInFlight = false;
    }
  }

  // Check on a delay after launch, then every few hours. The delay is jittered
  // so several processes starting together don't hit GitHub in one burst.
  function start() {
    // Only the STATIC question here: can this build ever update itself? Which
    // process checks is decided per check (the lease holder can quit any time).
    const updatable = updatePolicy.canAutoUpdate(context());
    if (!updatable.ok) { log(`automatic checks off (${updatable.reason})`); return false; }
    app.on('will-quit', releaseLease);
    const updater = autoUpdater();
    updater.on('update-available', (info) => announceManualDownloading(info.version));
    updater.on('update-downloaded', (info) => {
      downloaded = info;
      notifiedFor = null;
      log(`${info.version} downloaded and staged`);
      offerStaged();
    });
    updater.on('error', (err) => {
      warn('updater error:', err && err.message);
      manualPending = false; // don't leave a manual check armed after a failed download
    });
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const first = setTimeout(() => {
      check();
      const timer = setInterval(() => check(), SIX_HOURS);
      if (timer.unref) timer.unref();
    }, updatePolicy.firstCheckDelayMs());
    if (first.unref) first.unref();
    return true;
  }

  return { start, check, offerStaged, releaseLease, get staged() { return downloaded; } };
}

module.exports = { createAppUpdater };
