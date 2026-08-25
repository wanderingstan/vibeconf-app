// calendar-reconnect.test.mjs — #446: the broken-calendar warning has to offer
// the fix, not just the news.
//
// The warning itself landed in 902c7f22 and already said the right sentence:
// "Calendar connection broken: auto-join has stopped. Re-connect Google Calendar
// by signing in again at vibeconferencing.com."
//
// Being right did not stop people getting stuck. Calendar authorization lives
// with the WEBSITE login, and the two obvious in-app moves — sign out and back
// in, restart the app — both touch a different credential. Each was tried for a
// day before anyone worked out that the sentence meant a browser.
//
// Run: node --test tests/calendar-reconnect.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

test('the warning carries a button, styled like the other actionable notice', () => {
  assert.match(panelHtml, /id="calendarReconnectBtn" class="notice-action"/,
    'the voice banner already established this affordance — not a bespoke control');
  assert.match(panelHtml, /id="calendarReconnectBtn"[^>]*style="display:none"/,
    'hidden until the banner is actually carrying the warning');
});

test('it reuses the existing sign-in rather than inventing a second route', () => {
  // The credential that expired IS the website's, so this is the same flow the
  // ordinary sign-in uses. A second path to the site could drift from it.
  assert.match(panelJs,
    /calendarReconnectBtn'\)\?\.addEventListener\('click', \(\) => api\.invoke\('login'\)\)/);
  assert.match(readFileSync(join(root, 'electron-app/main.js'), 'utf8'),
    /ipcMain\.handle\('login'/, 'the IPC it calls has to exist');
});

test('the button appears only on the error path', () => {
  // Otherwise a stale "Sign in again" would sit on top of an ordinary
  // "4:30 PM meeting: …" notice, which reads as though that were broken too.
  const fn = panelJs.slice(panelJs.indexOf('function paintCalendarUpcoming'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(error\) \{[\s\S]*calendarReconnectBtn\.style\.display = ''/);
  assert.match(body, /if \(calendarReconnectBtn\) calendarReconnectBtn\.style\.display = 'none';/);
  // And the sentence itself must survive — the button is an addition to it, not
  // a replacement. Someone reading the log or a screenshot still needs the why.
  assert.match(body, /Calendar connection broken/);
  assert.match(body, /vibeconferencing\.com/);
});
