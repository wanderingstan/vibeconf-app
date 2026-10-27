// calling-app-standby.test.mjs: a bot that answers calling-app calls stays
// answering them (#843 follow-up).
//
// Live 2026-10-27: a bot in WhatsApp standby, the owner clicked "Sign in to
// Google", which navigated the bot's one view (the standby) to Google's
// sign-in. The sign-in failed, the view sat on accounts.google.com, and every
// WhatsApp call after that went unanswered with nothing said anywhere. These
// pin the decisions that keep standby up, and the wiring in main.js that uses
// them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sb = require('../electron-app/calling-app-standby.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// ── Google sign-in route ────────────────────────────────────────────────────

test('Google sign-in in standby goes to the side window, not the bot view', () => {
  assert.equal(sb.googleSignInRoute({ callStatus: 'idle', callingAppMode: 'whatsapp', standbyWanted: 'whatsapp' }), 'window');
});

test('Google sign-in goes to the side window when standby is wanted but already lost', () => {
  // The view is technically free, but it should be back in standby, not on a
  // sign-in page; the safety net restores it and the login lands either way.
  assert.equal(sb.googleSignInRoute({ callStatus: 'idle', callingAppMode: null, standbyWanted: 'telegram' }), 'window');
});

test('Google sign-in mid-call still goes to the side window', () => {
  for (const callStatus of ['navigating', 'joining', 'waiting-to-be-admitted', 'in-call']) {
    assert.equal(sb.googleSignInRoute({ callStatus, callingAppMode: null, standbyWanted: null }), 'window', callStatus);
  }
});

test('Google sign-in on a plain idle Meet bot still uses the view', () => {
  assert.equal(sb.googleSignInRoute({ callStatus: 'idle', callingAppMode: null, standbyWanted: null }), 'view');
  assert.equal(sb.googleSignInRoute({ callStatus: 'call-complete', callingAppMode: null, standbyWanted: null }), 'view');
});

// ── Google sign-out ─────────────────────────────────────────────────────────

test('sign-out does not navigate the view away from standby', () => {
  assert.equal(sb.signOutMayNavigateView({ callStatus: 'idle', callingAppMode: 'whatsapp', standbyWanted: 'whatsapp' }), false);
  assert.equal(sb.signOutMayNavigateView({ callStatus: 'idle', callingAppMode: null, standbyWanted: 'whatsapp' }), false);
});

test('sign-out does not navigate the view mid-call (that would hang up)', () => {
  assert.equal(sb.signOutMayNavigateView({ callStatus: 'in-call', callingAppMode: null, standbyWanted: null }), false);
});

test('sign-out on a plain idle Meet bot still reloads Meet home', () => {
  assert.equal(sb.signOutMayNavigateView({ callStatus: 'idle', callingAppMode: null, standbyWanted: null }), true);
});

// ── Teardown severity ───────────────────────────────────────────────────────

test('standby torn down outside a call is a warning', () => {
  assert.equal(sb.standbyTeardownSeverity({ callingAppMode: 'whatsapp', standbyWanted: 'whatsapp', callStatus: 'idle' }), 'warn');
  assert.equal(sb.standbyTeardownSeverity({ callingAppMode: 'whatsapp', standbyWanted: 'whatsapp', callStatus: 'call-complete' }), 'warn');
});

test('standby torn down for a call is routine', () => {
  assert.equal(sb.standbyTeardownSeverity({ callingAppMode: 'whatsapp', standbyWanted: 'whatsapp', callStatus: 'idle', forCall: true }), 'call');
  assert.equal(sb.standbyTeardownSeverity({ callingAppMode: 'telegram', standbyWanted: 'telegram', callStatus: 'navigating' }), 'call');
});

test('no standby up, or standby switched off on purpose, is nothing to report', () => {
  assert.equal(sb.standbyTeardownSeverity({ callingAppMode: null, standbyWanted: 'whatsapp', callStatus: 'idle' }), 'none');
  // deactivateCallingAppStandby: the owner turned answering off.
  assert.equal(sb.standbyTeardownSeverity({ callingAppMode: 'whatsapp', standbyWanted: null, callStatus: 'idle' }), 'none');
});

// ── The safety net ──────────────────────────────────────────────────────────

const T0 = 1_000_000_000;

test('standby up or not wanted: ok', () => {
  assert.equal(sb.standbyRecovery({ standbyWanted: 'whatsapp', callingAppMode: 'whatsapp', callStatus: 'idle', now: T0 }).action, 'ok');
  assert.equal(sb.standbyRecovery({ standbyWanted: null, callingAppMode: null, callStatus: 'idle', now: T0 }).action, 'ok');
});

test('a live call or its after-call work is never interrupted', () => {
  for (const callStatus of ['navigating', 'joining', 'waiting-to-be-admitted', 'in-call', 'after-call-work']) {
    const r = sb.standbyRecovery({
      standbyWanted: 'whatsapp', callingAppMode: null, callStatus,
      interruption: { at: T0 - 24 * 3600e3, forCall: false }, now: T0,
    });
    assert.equal(r.action, 'busy', callStatus);
  }
});

test('the live bug: idle on a sign-in page, nobody looking, past the grace: restore', () => {
  const r = sb.standbyRecovery({
    standbyWanted: 'whatsapp', callingAppMode: null, callStatus: 'idle',
    interruption: { at: T0, forCall: false }, viewRevealed: false, now: T0 + sb.STANDBY_GRACE_MS,
  });
  assert.equal(r.action, 'restore');
});

test('inside the grace period: wait', () => {
  const r = sb.standbyRecovery({
    standbyWanted: 'whatsapp', callingAppMode: null, callStatus: 'idle',
    interruption: { at: T0, forCall: false }, now: T0 + sb.STANDBY_GRACE_MS - 1,
  });
  assert.equal(r.action, 'wait');
});

test('a teardown for a call that has not started yet gets the longer grace', () => {
  const base = { standbyWanted: 'whatsapp', callingAppMode: null, callStatus: 'idle', interruption: { at: T0, forCall: true } };
  assert.equal(sb.standbyRecovery({ ...base, now: T0 + sb.STANDBY_GRACE_MS * 2 }).action, 'wait');
  assert.equal(sb.standbyRecovery({ ...base, now: T0 + sb.STANDBY_CALL_GRACE_MS }).action, 'restore');
});

test('an owner mid sign-in in the revealed view is not yanked', () => {
  const r = sb.standbyRecovery({
    standbyWanted: 'whatsapp', callingAppMode: null, callStatus: 'idle',
    interruption: { at: T0, forCall: false }, viewRevealed: true,
    lastViewActivityAt: T0 + 3 * 60e3, now: T0 + 4 * 60e3,
  });
  assert.equal(r.action, 'wait');
});

test('a revealed view left untouched long enough is reclaimed', () => {
  const r = sb.standbyRecovery({
    standbyWanted: 'whatsapp', callingAppMode: null, callStatus: 'idle',
    interruption: { at: T0, forCall: false }, viewRevealed: true,
    lastViewActivityAt: T0 + 60e3, now: T0 + 60e3 + sb.STANDBY_ABANDON_MS,
  });
  assert.equal(r.action, 'restore');
});

test('an unrecorded loss is timed from when the safety net first saw it', () => {
  const base = { standbyWanted: 'telegram', callingAppMode: null, callStatus: 'idle', interruption: null, firstSeenAt: T0 };
  assert.equal(sb.standbyRecovery({ ...base, now: T0 + 1000 }).action, 'wait');
  assert.equal(sb.standbyRecovery({ ...base, now: T0 + sb.STANDBY_GRACE_MS }).action, 'restore');
});

test('sitting in the wrong calling app counts as standby lost', () => {
  const r = sb.standbyRecovery({
    standbyWanted: 'telegram', callingAppMode: 'whatsapp', callStatus: 'idle',
    interruption: null, firstSeenAt: T0, now: T0 + sb.STANDBY_GRACE_MS,
  });
  assert.equal(r.action, 'restore');
});

// ── Wiring in main.js ───────────────────────────────────────────────────────

function handlerBody(channel) {
  const start = main.indexOf(`ipcMain.handle('${channel}'`);
  assert.ok(start >= 0, channel + ' handler exists');
  const next = main.indexOf('ipcMain.', start + 20);
  return main.slice(start, next);
}

test('meet-sign-in-as-bot asks googleSignInRoute before touching the view', () => {
  const body = handlerBody('meet-sign-in-as-bot');
  assert.match(body, /googleSignInRoute\(/);
  assert.ok(body.indexOf('openBotSignInWindow()') < body.indexOf('navigateMeetView('),
    'the side-window branch comes first');
});

test('meet-sign-out-bot only navigates when signOutMayNavigateView allows it', () => {
  const body = handlerBody('meet-sign-out-bot');
  assert.match(body, /signOutMayNavigateView\(/);
});

test('every provider switch reports a standby it tears down', () => {
  for (const fn of ['activateMeetProvider', 'activateSlackProvider', 'activateTeamsProvider', 'activateZoomProvider', '_openMeetInFreshView']) {
    const start = main.indexOf('function ' + fn + '(');
    assert.ok(start >= 0, fn + ' exists');
    const end = main.indexOf('\nfunction ', start + 10);
    const body = main.slice(start, end);
    const note = body.indexOf('noteCallingAppStandbyTeardown(');
    const clear = body.indexOf('callingAppMode = null');
    assert.ok(note >= 0, fn + ' calls noteCallingAppStandbyTeardown');
    assert.ok(clear < 0 || note < clear, fn + ' reports before clearing callingAppMode');
  }
});

test('re-entering standby retracts the "not answering calls" warning', () => {
  const start = main.indexOf('function activateCallingAppStandby(');
  const body = main.slice(start, main.indexOf('\nfunction ', start + 10));
  assert.match(body, /clearBroadcastError\(CALLING_APP_STANDBY_ERROR_KEY\)/);
});

test('the safety net runs on a timer and restores through activateCallingAppStandby', () => {
  const start = main.indexOf('function checkCallingAppStandby(');
  assert.ok(start >= 0);
  const body = main.slice(start, main.indexOf('\nfunction ', start + 10));
  assert.match(body, /standbyRecovery\(/);
  assert.match(body, /activateCallingAppStandby\(/);
  assert.match(main, /setInterval\(checkCallingAppStandby/);
});
