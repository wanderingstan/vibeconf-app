// app-login-calendar-optin.test.mjs — #754: the app's sign-in has to be ABLE to
// ask for calendar access.
//
// The website makes calendar an opt-in, via `?calendar=1` on /api/auth/google
// (api/auth/google.ts), and its sign-in PAGE carries the checkbox that sets it.
// The app never loads that page — it builds the OAuth URL itself — so every
// app-side sign-in silently dropped the scope. The symptom was the worst kind:
// no error anywhere, just calendar auto-join that did nothing, forever.
//
// The fix is only as good as its coverage, and that is what this file guards.
// #754's first pass fixed App Settings alone and left three other sign-in
// buttons bare, which would have shipped the same bug to everyone who signed in
// through the first-run wizard. So: enumerate the call sites and assert each
// one is deliberate. A FIFTH sign-in button added later fails this test rather
// than quietly reintroducing the bug.
//
// Run: node --test tests/app-login-calendar-optin.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const mainJs = read('electron-app/main.js');
const onboardingJs = read('electron-app/renderer/onboarding.js');
const onboardingHtml = read('electron-app/renderer/onboarding.html');
const appSettingsJs = read('electron-app/renderer/app-settings.js');
const appSettingsHtml = read('electron-app/renderer/app-settings.html');
const panelJs = read('electron-app/renderer/panel.js');

test('main plumbs the opt-in all the way onto the OAuth URL', () => {
  // The renderer's choice is worthless if it stops at the IPC boundary.
  assert.match(mainJs, /ipcMain\.handle\('login', \(_event, opts\) => \{/);
  assert.match(mainJs, /openGoogleLogin\(opts \|\| \{\}\)/);
  assert.match(mainJs, /function openGoogleLogin\(opts = \{\}\)/);
  assert.match(mainJs, /opts && opts\.calendar \? '&calendar=1' : ''/);
  assert.match(mainJs, /\$\{baseUrl\}\/api\/auth\/google\?electron_callback=\$\{encodeURIComponent\(callbackUrl\)\}\$\{calendarParam\}/);
});

// The two sign-in points a user actually reaches to grant calendar for the
// first time. Both need the checkbox, because the scope is fixed at consent
// time — there is no way to add it to a session that already exists.
for (const [label, js, html, chk, row] of [
  ['the first-run wizard', onboardingJs, onboardingHtml, 'calendarChk', 'calendarRow'],
  ['App Settings', appSettingsJs, appSettingsHtml, 'userCalendarChk', 'userCalendarRow'],
]) {
  test(`${label} offers the opt-in and passes it through`, () => {
    assert.match(html, new RegExp(`type="checkbox" id="${chk}"`),
      'a checkbox, matching the website sign-in page it stands in for');
    // Read the actual <input> tag, not a byte window around the id: the
    // surrounding comment says "Unchecked by default", so a window wide enough
    // to catch a real `checked` attribute also catches that word, and the test
    // fails on a comment edit while saying the checkbox defaults to on.
    const tag = html.slice(html.indexOf(`<input type="checkbox" id="${chk}"`));
    assert.doesNotMatch(tag.slice(0, tag.indexOf('>') + 1), /\schecked\b/,
      'unchecked by default — #299 decided calendar is opt-in, not a default grant');
    assert.match(js, new RegExp(`invoke\\('login', \\{ calendar: .*${chk}.*\\.checked \\}\\)`),
      'the checkbox has to reach the IPC, or it is decoration');
    // Hidden once signed in: the control would be a lie there, since re-ticking
    // it cannot widen a token that has already been issued.
    assert.match(js, new RegExp(`${row}.*\\.style\\.display = signedIn \\? 'none' : 'flex'`),
      'the row is only meaningful next to the sign-in button');
  });
}

test('the calendar reconnect hardcodes the scope, with no checkbox', () => {
  // Not a policy choice: the button exists only for people who already granted
  // calendar and whose grant broke. Asking them to re-tick a box to get back
  // what they had is the bug, not the fix. (Fuller reasoning in
  // calendar-reconnect.test.mjs.)
  assert.match(panelJs, /calendarReconnectBtn'\)\?\.addEventListener\('click', \(\) => api\.invoke\('login', \{ calendar: true \}\)\)/);
});

test('the panel footer sign-in stays bare, on purpose and in writing', () => {
  // The one remaining bare call. It sits in a single-line footer with no room
  // for a checkbox, and `calendar: true` here would grant the scope to everyone
  // who ever signs in from the footer — exactly what #299 ruled out. The
  // comment matters as much as the code: without it this reads as an oversight
  // and someone "fixes" it.
  const at = panelJs.indexOf("userSignInMainBtn?.addEventListener");
  assert.ok(at > 0, 'the footer sign-in button still exists');
  assert.match(panelJs.slice(at - 700, at), /#754: deliberately a plain sign-in/,
    'the exception has to be documented where the next reader will look');
});

test('no sign-in call site is left undeclared', () => {
  // The backstop. Every `invoke('login'...)` in the renderer must be one of the
  // four reasoned-about sites above; a new one fails here until someone decides
  // which it is.
  const dir = 'electron-app/renderer';
  const found = [];
  for (const f of readdirSync(join(root, dir))) {
    if (!f.endsWith('.js')) continue;
    const src = read(`${dir}/${f}`);
    for (const line of src.split('\n')) {
      if (/invoke\('login'/.test(line)) found.push(`${f}: ${line.trim()}`);
    }
  }
  assert.equal(found.length, 4,
    `expected exactly the 4 known sign-in call sites, got:\n${found.join('\n')}`);
  const bare = found.filter((l) => /invoke\('login'\)/.test(l));
  assert.equal(bare.length, 1,
    `only the documented panel-footer sign-in may be bare, got:\n${bare.join('\n')}`);
  assert.match(bare[0], /^panel\.js:/);
});
