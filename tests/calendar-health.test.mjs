// calendar-health.test.mjs — #324: can an unattended box tell you whether it
// will actually turn up to its next scheduled meeting?
//
// The cloud TA bot's entire job is joining scheduled calls with nobody at the
// keyboard. When calendar auto-join breaks, the bot just never appears — which
// from outside is indistinguishable from a quiet calendar. The app already
// detects the break and already says so, but it says so in a panel banner, and
// on an AWS box nothing renders that banner and nobody would be looking at it.
//
// Two ways out, both tested here: put the state in the payloads an agent can
// fetch, and re-log it on a slow cadence so `tail app.log` on a box that has
// been sick for hours still says what is wrong. State-change-only logging is
// right for a laptop and useless to anyone who arrives after the change.
//
// Run: node --test tests/calendar-health.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const poll = mainJs.slice(mainJs.indexOf('function recordCalendarHealth'),
  mainJs.indexOf('console.log(\'[electron] Calendar auto-join polling started\')'));

function makeServer() {
  const s = new LocalServer({ port: 7865, getPref: () => undefined });
  s.setRoom('r');
  return s;
}

test('never having polled is reported as unknown, not as healthy', () => {
  // The dangerous default. If a box whose poller never started reported
  // "armed", the one question this exists to answer would be answered wrong in
  // exactly the case that most deserves an alarm.
  const s = makeServer();
  assert.equal(s.calendarHealth, null);
  assert.equal(s.getCallStateSnapshot().calendarHealth, null);
});

test('health rides along on both the panel snapshot and get_room_info', () => {
  const s = makeServer();
  s.calendarHealth = { state: 'ok', autoJoinArmed: true, message: null };

  assert.equal(s.getCallStateSnapshot().calendarHealth.autoJoinArmed, true);
  // get_room_info is the surface an agent ON the box (or driving it from a Mac)
  // can actually reach — the panel snapshot is IPC and never leaves the app.
  assert.equal(s._buildResponse(null, 'Jimmy', Date.now()).status.calendarHealth.autoJoinArmed, true);
});

test('a broken calendar is answerable as a boolean, not just a state string', () => {
  const s = makeServer();
  s.calendarHealth = {
    state: 'google-api-error',
    message: 'Google API error: token refresh failed',
    autoJoinArmed: false,
  };
  const status = s._buildResponse(null, 'Jimmy', Date.now()).status;
  assert.equal(status.calendarHealth.autoJoinArmed, false);
  assert.match(status.calendarHealth.message, /token refresh failed/,
    'and it must carry WHY, or the answer is not actionable from a shell');
});

test('every poll outcome records health, not only the logged ones', () => {
  // The bug this guards against: logging is gated on a state CHANGE, so wiring
  // health into the log sites would inherit that gate and leave the payload
  // frozen at whatever it said when the state last flipped.
  for (const call of [/recordCalendarHealth\('ok'\)/,
    /recordCalendarHealth\(state, message\)/,
    /recordCalendarHealth\('error', err && err\.message\)/]) {
    assert.match(poll, call, `missing health record: ${call}`);
  }
  const okBranch = poll.slice(poll.indexOf('r.status === 200'));
  const recordAt = okBranch.indexOf('recordCalendarHealth');
  const gateAt = okBranch.indexOf("lastCalendarPollState !== 'ok'");
  assert.ok(recordAt > -1 && recordAt < gateAt,
    'health must be recorded before the state-change log gate, not inside it');
});

test('a persistently broken calendar re-logs on a slow cadence', () => {
  const decl = mainJs.slice(mainJs.indexOf('const CALENDAR_RELOG_MS'));
  assert.match(decl.slice(0, 80), /30 \* 60 \* 1000/, 'slow enough not to spam an idle box');
  // Healthy polls must reset it, or the first failure after a long healthy
  // stretch would wait out the remainder of a stale window before saying so.
  assert.match(poll, /if \(state === 'ok'\) \{ calendarLastReLogAt = 0; return; \}/);
  assert.match(poll, /still not armed after \$\{mins\}m/);
  assert.match(poll, /Scheduled calls will be missed/,
    'the line has to say what it costs, or it reads as noise');
});

test('the broken-calendar warning offers the fix, not just the diagnosis', () => {
  // #446: the sentence was already right and people still got stuck. Signing
  // out of the app and restarting it were both tried for a day; neither touches
  // the credential, because calendar authorization lives with the WEBSITE
  // login. A button removes the guessing.
  const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
  const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

  assert.match(panelHtml, /id="calendarReconnectBtn" class="notice-action"/,
    'same affordance as the other actionable banner, not a bespoke control');
  assert.match(panelHtml, /id="calendarReconnectBtn"[^>]*style="display:none"/,
    'hidden until the banner is actually carrying the warning');

  // It must reuse the existing sign-in, not invent a second route to the site.
  assert.match(panelJs, /calendarReconnectBtn'\)\?\.addEventListener\('click', \(\) => api\.invoke\('login'\)\)/);

  // Shown on the error path and hidden on every other, or a stale button would
  // sit on top of an ordinary "next meeting at 4:30" notice.
  const fn = panelJs.slice(panelJs.indexOf('function paintCalendarUpcoming'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(error\) \{[\s\S]*calendarReconnectBtn\.style\.display = ''/);
  assert.match(body, /if \(calendarReconnectBtn\) calendarReconnectBtn\.style\.display = 'none';/);
});
