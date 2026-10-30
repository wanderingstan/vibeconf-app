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
const ua = require('../packages/calls/hosts/electron/slack-ua.js');

test('main.js takes the Meet UA from slack-ua.js, at the engine\'s version, not its own pinned copy', () => {
  const main = src('main.js');
  // ENGINE_UA, not UA: Meet's bot check turns a guest away when the claimed
  // Chrome runs far ahead of the engine (Chrome/150 on Chromium 130, 2026-10-29).
  assert.match(main, /const CHROME_UA = require\('@vibeconferencing\/calls\/hosts\/electron\/slack-ua'\)\.ENGINE_UA;/);
  assert.doesNotMatch(main, /Chrome\/131\.0\.0\.0/);
});

test('configureMeetSession installs the Sec-CH-UA* header spoof itself, not only via Teams/Zoom', () => {
  const main = src('main.js');
  const body = main.slice(main.indexOf('function configureMeetSession(sess)'));
  const end = body.indexOf('\n}\n');
  assert.match(body.slice(0, end), /require\('@vibeconferencing\/calls\/hosts\/electron\/slack-ua'\)\.installHeaderSpoof\(sess\)/);
});

test('the header spoof sends Chrome brands that match the string', () => {
  let listener = null;
  ua.installHeaderSpoof({ webRequest: { onBeforeSendHeaders: (fn) => { listener = fn; } } });
  const send = (headers) => { let out = null; listener({ requestHeaders: headers }, (r) => { out = r.requestHeaders; }); return out; };
  const out = send({ 'User-Agent': ua.UA, 'sec-ch-ua': '"Chromium";v="130"', Accept: '*/*' });
  assert.equal(out['sec-ch-ua'], undefined, 'Electron\'s own lower-case header is dropped, not sent twice');
  assert.match(out['Sec-CH-UA'], new RegExp(`"Google Chrome";v="${ua.CHROME}"`));
  assert.ok(ua.UA.includes(`Chrome/${ua.CHROME}.0.0.0`));
  assert.equal(out.Accept, '*/*');
  // One partition serves the Meet view (engine version) and Teams/Zoom views
  // (current Chrome): each request's hints follow the string it carries.
  const meet = send({ 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' });
  assert.match(meet['Sec-CH-UA'], /"Google Chrome";v="130"/);
  assert.doesNotMatch(meet['Sec-CH-UA-Full-Version-List'], new RegExp(`v="${ua.CHROME}`));
});

test('the Meet identity is Chrome at the engine\'s own version', () => {
  assert.ok(ua.ENGINE_UA.includes(`Chrome/${ua.ENGINE}.0.0.0`));
  assert.equal(ua.majorOf(ua.ENGINE_UA), ua.ENGINE);
  assert.equal(ua.majorOf('Mozilla/5.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36'), '130');
});

test('navigator.userAgentData is shimmed in the Meet view and in the bot\'s Google sign-in window', () => {
  assert.match(src('preload-meet.js'), /require\('@vibeconferencing\/calls\/hosts\/electron\/slack-ua'\)\.installClientHintsShim\(\)/);
  assert.match(src('preload-google-sign-in.js'), /require\('@vibeconferencing\/calls\/hosts\/electron\/slack-ua'\)\.installClientHintsShim\(\)/);
  const main = src('main.js');
  const win = main.slice(main.indexOf('function openBotSignInWindow()'), main.indexOf('win.loadURL(MEET_SIGN_IN_URL)'));
  assert.match(win, /preload: path\.join\(__dirname, 'preload-google-sign-in\.js'\)/);
  // The shim must run in the page's world, so the preload shares it.
  assert.match(win, /contextIsolation: false/);
  assert.match(win, /nodeIntegration: false/);
});
