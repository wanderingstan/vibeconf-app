// guest-fallback-is-anonymous.test.mjs: #795, the #347 guest fallback walked
// straight back into the identity challenge it exists to route around.
//
// GUEST_PARTITION is a persist: partition, so it outlives the app. Once someone
// signed in to Google on a page shown inside a guest view, the guest jar held
// master-auth cookies. From then on every fallback read "signed in" from it,
// skipped the identity-cache clear, pinned the bot's blocked account via
// ?authuser=, and landed on the same confirmidentifier page. The retry guard
// stopped a loop, but nothing reported the dead end: the bot sat at
// 'navigating' with no error anywhere.
//
// Three rules this file holds:
//   1. every guest fallback wipes the guest jar before it reads sign-in state;
//   2. the authuser pin is never applied on the guest fallback, whatever the
//      cookies say;
//   3. a guest attempt that ALSO lands on sign-in fails the join for real
//      (the 'Error:' path, which resets callStatus) and says so to the agent.
//
// Run: node --test tests/guest-fallback-is-anonymous.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

function bodyOf(signature) {
  const i = main.indexOf(signature);
  assert.ok(i > 0, `expected to find ${signature}`);
  const rest = main.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n'));
}

test('the guest partition is wiped whole, and only the guest partition', () => {
  const body = bodyOf('async function resetGuestPartition(');
  // Named literally: a wipe that followed a variable could one day be handed
  // the home partition and sign the profile out of Google and Slack at once.
  assert.match(body, /session\.fromPartition\(GUEST_PARTITION\)/);
  assert.doesNotMatch(body, /SESSION_PARTITION|activeMeetPartition/);
  // Unscoped: cookies included. An origin- or storage-filtered clear is how the
  // Google auth cookies on .google.com would survive (see clearMeetIdentityCache).
  assert.match(body, /clearStorageData\(\)/);
});

test('every guest fallback wipes the jar BEFORE reading sign-in state', () => {
  const body = bodyOf('async function _openMeetInFreshView(meetUrl');
  const wipe = body.indexOf('if (guestFallback) await resetGuestPartition();');
  assert.ok(wipe > 0, 'the fallback must wipe unconditionally, not only when cookies are seen');
  const read = body.indexOf('await isSignedInToGoogle(');
  assert.ok(read > wipe, 'wipe first, or the read still sees the stale login');
  const view = body.indexOf('createMeetView(activeMeetPartition)');
  assert.ok(view > wipe, 'wipe before the view exists, so no page is bound to the jar');
  // After the view teardown, so no live page can re-seed the jar mid-wipe.
  assert.ok(wipe > body.indexOf('destroyProviderView();'));
});

test('the authuser pin is gated on !guestFallback', () => {
  const body = bodyOf('async function _openMeetInFreshView(meetUrl');
  const line = body.split('\n').find((l) => /const boundEmail =/.test(l));
  assert.ok(line, 'expected the boundEmail assignment');
  assert.match(line, /!guestFallback && signedIn === true/,
    'a guest must never carry the bot account on the URL, even if the wipe failed');
  // And the pin reads only boundEmail, so the gate above covers it.
  assert.match(body, /const urlToLoad = boundEmail \? pinAuthUser\(meetUrl, boundEmail\) : meetUrl;/);
});

test('a guest attempt that also hits sign-in fails loudly instead of sitting at navigating', () => {
  const i = main.indexOf("if (landing === 'sign-in')");
  assert.ok(i > 0, 'expected the #346 sign-in landing branch');
  const branch = main.slice(i, main.indexOf('// Anything else is not going to fix itself', i));
  const g = branch.indexOf('if (activeMeetPartition === GUEST_PARTITION) {');
  assert.ok(g > 0, 'expected a guest dead-end branch');
  // After the one-shot fallback, so the first sign-in landing still retries.
  assert.ok(g > branch.indexOf('loadMeetURL(currentMeetUrl, { guestFallback: true })'));
  const dead = branch.slice(g, branch.indexOf('\n      }\n', g));
  // The agent hears it (get_room_info / wait_for_speech)...
  assert.match(dead, /localServer\.addError\(/);
  // ...and the 'Error:' path runs: resolves waiters, clearRoom → idle, and
  // resets the panel. That is what gets callStatus off 'navigating'.
  assert.match(dead, /handleMeetStatusUpdate\(`Error: /);
  // #764's actionable surface, reused.
  assert.match(dead, /SIGN_BOT_IN_ACTION/);
  // The button must reveal a HOME-partition sign-in page. Signing in on the
  // guest view would re-pollute the guest jar and leave the real login broken.
  assert.match(dead, /activeMeetPartition = SESSION_PARTITION;/);
  assert.match(dead, /navigateMeetView\(MEET_SIGN_IN_URL\)/);
  assert.ok(dead.indexOf('destroyProviderView()') < dead.indexOf('activeMeetPartition = SESSION_PARTITION'),
    'tear the guest view down before stepping back home');
});

test("the 'Error' path can carry the #764 action", () => {
  const i = main.indexOf('function handleMeetStatusUpdate(status, errorAction)');
  assert.ok(i > 0, 'handleMeetStatusUpdate takes an optional errorAction');
  assert.match(main.slice(i, i + 600), /broadcastError\(status, null, errorAction\)/);
});

test("the panel's call-failed copy keeps the action, so the button is not hidden", () => {
  // call-failed re-shows the same message on top of the error stack; the bar
  // renders only the top entry's action, so dropping it here hides the button.
  const i = main.indexOf('function handleMeetStatusUpdate(status, errorAction)');
  assert.match(main.slice(i, i + 2500), /broadcastToRenderers\('call-failed', \{ message: status, errorAction \}\)/);
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.match(panel, /showError\(data\.message, null, data\.errorAction\)/);
});

// ---------------------------------------------------------------------------
// Signing the bot back in without hanging up the guest call.
//
// The guest-fallback notice's button used to reveal the Meet view, which by
// then IS the guest call; the only sign-in route from there navigated that view,
// ending the call and dropping the login into the guest jar. The fix is a
// separate window on the profile's real jar.

test('the sign-in window rides the HOME partition, named literally', () => {
  const body = bodyOf('function openBotSignInWindow(');
  assert.match(body, /partition: SESSION_PARTITION/);
  assert.doesNotMatch(body, /activeMeetPartition|GUEST_PARTITION/,
    'a login here must land in the jar the next join reads');
  assert.match(body, /ensureMeetSessionConfigured\(SESSION_PARTITION\)/,
    'needs the Chrome UA, or Google refuses the embedded sign-in');
  assert.match(body, /loadURL\(MEET_SIGN_IN_URL\)/);
  // It must never move the call view.
  assert.doesNotMatch(body, /meetView|navigateMeetView|loadMeetURL/);
});

test('finishing the sign-in closes the window and retracts the guest notice', () => {
  const body = bodyOf('function openBotSignInWindow(');
  assert.match(body, /hostname/);
  assert.match(body, /meet\.google\.com/);
  assert.match(body, /clearBroadcastError\(GOOGLE_SIGN_IN_ERROR_KEY\)/);
  assert.match(body, /broadcastAuthChanged\(\)/);
});

test('the panel can run the new action, and main answers it', () => {
  const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.match(main, /const OPEN_BOT_SIGN_IN_ACTION = \{ id: 'open-bot-sign-in'/);
  assert.match(panel, /'open-bot-sign-in': \(\) => api\.invoke\('open-bot-sign-in'\)/);
  const i = main.indexOf("ipcMain.handle('open-bot-sign-in'");
  assert.ok(i > 0);
  assert.match(main.slice(i, main.indexOf('});', i)), /openBotSignInWindow\(\)/);
});

test('"Sign in to Google as bot" mid-call signs in on the side instead of hanging up', () => {
  const i = main.indexOf("ipcMain.handle('meet-sign-in-as-bot'");
  const body = main.slice(i, main.indexOf('\n  });', i));
  const gate = body.indexOf('if (isInCall(localServer.callStatus))');
  assert.ok(gate > 0, 'must check for a call in flight first');
  assert.ok(body.indexOf('openBotSignInWindow()') > gate);
  assert.ok(body.indexOf('navigateMeetView(') > body.indexOf('openBotSignInWindow()'),
    'navigating the call view is only for when no call is in flight');
});
