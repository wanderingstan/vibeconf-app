// #499: Google refused the bot's sign-in ("This browser or app may not be
// secure") because the Meet session spoofed only the legacy UA string, at a
// stale Chrome/131, while Electron's Sec-CH-UA* headers and
// navigator.userAgentData still described Electron. The full identity was only
// installed on that partition as a side effect of a Teams/Zoom/calling-app
// sign-in, so a fresh profile (a new user on the Mac mini, 2026-10-27) never
// had it. These pin all three layers on the Meet session and its sign-in window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (f) => readFileSync(join(root, 'electron-app', f), 'utf8');
const ua = require('../electron-app/slack-ua.js');

test('one Chrome identity: main.js takes its UA string from slack-ua.js, not its own pinned copy', () => {
  const main = src('main.js');
  assert.match(main, /const CHROME_UA = require\('\.\/slack-ua'\)\.UA;/);
  assert.doesNotMatch(main, /Chrome\/131\.0\.0\.0/);
});

test('configureMeetSession installs the Sec-CH-UA* header spoof itself, not only via Teams/Zoom', () => {
  const main = src('main.js');
  const body = main.slice(main.indexOf('function configureMeetSession(sess)'));
  const end = body.indexOf('\n}\n');
  assert.match(body.slice(0, end), /require\('\.\/slack-ua'\)\.installHeaderSpoof\(sess\)/);
});

test('the header spoof sends Chrome brands that match the string', () => {
  let listener = null;
  ua.installHeaderSpoof({ webRequest: { onBeforeSendHeaders: (fn) => { listener = fn; } } });
  let out = null;
  listener({ requestHeaders: { 'sec-ch-ua': '"Chromium";v="130"', Accept: '*/*' } }, (r) => { out = r.requestHeaders; });
  assert.equal(out['sec-ch-ua'], undefined, 'Electron\'s own lower-case header is dropped, not sent twice');
  assert.match(out['Sec-CH-UA'], new RegExp(`"Google Chrome";v="${ua.CHROME}"`));
  assert.ok(ua.UA.includes(`Chrome/${ua.CHROME}.0.0.0`));
  assert.equal(out.Accept, '*/*');
});

test('navigator.userAgentData is shimmed in the Meet view and in the bot\'s Google sign-in window', () => {
  assert.match(src('preload-meet.js'), /require\('\.\/slack-ua'\)\.installClientHintsShim\(\)/);
  assert.match(src('preload-google-sign-in.js'), /require\('\.\/slack-ua'\)\.installClientHintsShim\(\)/);
  const main = src('main.js');
  const win = main.slice(main.indexOf('function openBotSignInWindow()'), main.indexOf('win.loadURL(MEET_SIGN_IN_URL)'));
  assert.match(win, /preload: path\.join\(__dirname, 'preload-google-sign-in\.js'\)/);
  // The shim must run in the page's world, so the preload shares it.
  assert.match(win, /contextIsolation: false/);
  assert.match(win, /nodeIntegration: false/);
});
