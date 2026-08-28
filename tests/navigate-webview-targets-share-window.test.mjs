// navigate-webview-targets-share-window.test.mjs
//
// "Navigate Webview…" (⌘⇧L) used to drive meetView. The Meet view IS the call,
// so navigating it away hangs up — which made the command unusable during the
// one situation anyone reaches for it: fixing a Slack/Google login mid-call.
//
// It now drives the SHARE window, which is created on the same SESSION_PARTITION
// (see createWhiteboardWindow) and therefore shares one cookie jar with meetView:
// a login completed there is live for the bot, and the call is untouched.
//
// Source assertions, not behaviour: the handler needs an Electron main process to
// run. What is pinned is the target, because getting the target wrong is the
// whole bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panel = fs.readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

function handlerBody() {
  const i = main.indexOf("ipcMain.handle('navigate-webview'");
  assert.ok(i > 0, 'the navigate-webview handler still exists');
  return main.slice(i, i + 2200);
}

test('the handler navigates the share window, never meetView', () => {
  const body = handlerBody();
  assert.match(body, /whiteboardWindow\.loadURL\(url\)/,
    'it drives the share window');
  assert.doesNotMatch(body, /meetView\.webContents\.loadURL/,
    'driving meetView here would hang up the call — that is the bug this fixed');
});

test('a missing share window is created rather than erroring', () => {
  // Out of a call the share window does not exist yet. Refusing there would make
  // the command work only in the one state where it is least needed.
  const body = handlerBody();
  // createWhiteboardWindow loads the URL itself, so the two cases are exclusive:
  // create-with-url when it is missing, loadURL when it already exists. Doing
  // both on the create path would be a wasted navigation and a visible flash.
  assert.match(
    body,
    /if \(!whiteboardWindow \|\| whiteboardWindow\.isDestroyed\(\)\) \{[^}]*createWhiteboardWindow\(url\);?\s*\} else \{\s*whiteboardWindow\.loadURL\(url\);?\s*\}/,
    'create-if-missing, else loadURL — never both',
  );
});

test('the window is shown afterwards, without stealing focus', () => {
  // The share window is normally hidden. Navigating it somewhere and leaving it
  // hidden gives the operator nothing to look at, and seeing where the browser
  // landed is the point of the command.
  const body = handlerBody();
  assert.match(body, /whiteboardWindow\.showInactive\(\)/);
  assert.doesNotMatch(body, /whiteboardWindow\.show\(\)/,
    'show() would steal focus from the prompt, or from Meet mid-call');
});

test('presenting is surfaced to the operator, not blocked', () => {
  // While presenting, this window is on screen to the whole call — a sign-in
  // page typed here is watched live. Warn, but allow: fixing a broken share is
  // a real reason to navigate mid-presentation.
  const i = main.indexOf("label: 'Navigate Webview…'");
  assert.ok(i > 0);
  const item = main.slice(i, i + 3500);
  assert.match(item, /const sharing = !!\(localServer && localServer\.sharing\)/);
  assert.match(item, /send\('navigate-webview-prompt', \{ currentUrl, sharing \}\)/);

  const j = panel.indexOf("api.on('navigate-webview-prompt'");
  assert.ok(j > 0);
  const handler = panel.slice(j, j + 1400);
  assert.match(handler, /data && data\.sharing/);
  assert.match(handler, /YOU ARE PRESENTING/);
  // Warned, not refused: there must still be exactly one prompt-and-go path.
  assert.match(handler, /await inlinePrompt\(/);
  assert.doesNotMatch(handler, /if \(sharing\) return/);
});

test('the prompt prefills from the share window, not the Meet view', () => {
  // Prefilling from meetView would show a Meet URL as the starting point for a
  // window that is not the Meet view — and inviting someone to press Enter on a
  // Meet URL is how you get a second copy of the call in the shared window.
  const i = main.indexOf("label: 'Navigate Webview…'");
  const item = main.slice(i, i + 3500);
  assert.match(item, /currentUrl = whiteboardWindow\.webContents\.getURL\(\)/);
  assert.doesNotMatch(item, /currentUrl = meetView\.webContents\.getURL\(\)/);
});

test('a multi-line prompt title actually renders its line breaks', () => {
  // The warning puts a blank line between itself and the ask. textContent alone
  // collapses that, so the style has to opt in — and it must stay textContent,
  // since the title is operator- and calendar-adjacent text, never HTML.
  const i = panel.indexOf('function inlinePrompt');
  const fn = panel.slice(i, i + 1600);
  assert.match(fn, /white-space:pre-line/);
  assert.match(fn, /t\.textContent = title/);
  assert.doesNotMatch(fn, /t\.innerHTML/);
});
