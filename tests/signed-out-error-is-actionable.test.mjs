// signed-out-error-is-actionable.test.mjs — #346: the "Google is asking the bot
// to confirm its identity" error named a fix and then left you to find it.
//
// The message said "open the bot's view and sign it back in to Google". That is
// the right instruction and it still stranded people, for the same reason #446
// found on the calendar banner: a sentence naming a place is not a way to get
// there, and the obvious in-app guesses (sign out of the app, restart it) touch
// a different credential entirely. The error bar now carries the button.
//
// Two rules this file exists to hold:
//   1. the action REVEALS the bot view, it never navigates it — the bot may be
//      sitting in the guest-fallback call (#347), and navigating meetView is
//      how you hang up;
//   2. the App Settings warning for the same condition must end at a control
//      that is actually on screen.
//
// Run: node --test tests/signed-out-error-is-actionable.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const mainJs = read('electron-app/main.js');
const panelJs = read('electron-app/renderer/panel.js');
const panelHtml = read('electron-app/renderer/panel.html');

test('both identity-challenge errors offer the sign-in action', () => {
  // The hard failure AND the guest-fallback notice. The fallback one matters
  // most: the bot got into the room, so nothing else will prompt anyone to fix
  // the login until the next call fails too.
  const i = mainJs.indexOf("if (landing === 'sign-in')");
  assert.ok(i > -1, 'the sign-in landing branch must still exist');
  const branch = mainJs.slice(i, mainJs.indexOf('// Anything else is not going to fix itself', i));
  const calls = branch.match(/broadcastError\([^)]*\)/g) || [];
  assert.equal(calls.length, 2, 'guest-fallback and hard-failure, both of them');
  for (const call of calls) {
    assert.match(call, /SIGN_BOT_IN_ACTION/,
      `an identity-challenge error with no way to act on it: ${call}`);
  }
});

test('the action reveals the bot view and does not navigate it', () => {
  assert.match(mainJs, /const SIGN_BOT_IN_ACTION = \{ id: 'reveal-bot-view'/);
  const i = mainJs.indexOf("ipcMain.handle('reveal-bot-view'");
  assert.ok(i > -1, 'the panel invokes this channel');
  const handler = mainJs.slice(i, mainJs.indexOf('});', i));
  assert.match(handler, /revealBotViewForSignIn\(\)/);
  // The destructive neighbour: 'meet-sign-in-as-bot' calls navigateMeetView,
  // which mid-call means leaving the call. This handler must not grow that.
  assert.doesNotMatch(handler, /navigateMeetView|loadMeetURL|loadURL/,
    'revealing must never move the view — the bot may be in the guest call');
});

test('main ships the action alongside the message', () => {
  assert.match(mainJs, /function broadcastError\(message, key, errorAction\)/);
  assert.match(mainJs, /action: 'error', message, key, errorAction/);
});

test('the error bar renders the button and runs only known ids', () => {
  assert.match(panelHtml, /<button class="notice-action" id="errorAction"/);
  assert.match(panelJs, /const ERROR_ACTIONS = \{/);
  assert.match(panelJs, /'reveal-bot-view': \(\) => api\.invoke\('reveal-bot-view'\)/);
  // The payload crosses IPC, so an unknown id must render nothing rather than
  // being dispatched blind.
  const render = panelJs.slice(panelJs.indexOf('function _renderErrorBar()'));
  assert.match(render.slice(0, 600), /ERROR_ACTIONS\[top\.action\.id\]/,
    'unknown ids must not paint a button that does nothing');
  assert.match(panelJs, /showError\(message\.message, message\.key, message\.errorAction\)/);
});

test('the action follows the stack, like the message it belongs to', () => {
  // #533 made the bar a stack; an action pinned to the bar rather than to the
  // entry would offer the wrong fix for whatever is showing on top.
  assert.match(panelJs, /_errorStack\.push\(\{ message, key: key \|\| null, action: action \|\| null \}\)/);
  const click = panelJs.slice(panelJs.indexOf("errorActionBtn?.addEventListener('click'"));
  assert.match(click.slice(0, 400), /_errorStack\[_errorStack\.length - 1\]/,
    'the button runs the top entry\'s action, not a remembered one');
});

test('the App Settings warning ends at a visible button', () => {
  // applyMeetMode hides "Sign in to Google as bot" in account mode, and this
  // warning IS the account-mode case where you need it. Pointing at a hidden
  // button is the same dead end in a smaller place.
  const fn = panelJs.slice(panelJs.indexOf('function refreshAccountEmail(mode)'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const bad = body.slice(body.indexOf('no Google session detected'));
  assert.match(bad, /meetSignInBtn\.style\.display = ''/,
    'the signed-out branch must un-hide the sign-in button');
  // ...and the signed-in branches must put it back, since they run after
  // applyMeetMode's synchronous hide.
  for (const marker of ['✓ Signed in as ', '✓ Signed in to Google (could not read']) {
    const b = body.slice(body.indexOf(marker), body.indexOf(marker) + 400);
    assert.match(b, /meetSignInBtn\.style\.display = 'none'/,
      `a signed-in bot must not be offered a sign-in button (${marker.trim()})`);
  }
});
