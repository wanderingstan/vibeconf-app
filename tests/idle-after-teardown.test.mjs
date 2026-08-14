// idle-after-teardown.test.mjs — #254: reaching 'idle' must not be conditional.
//
// The failure, from Bethany Crystal's Aug 4 session (her third real call of the
// day, external host, 0.8.15): Meet's "Your screen is still visible to others"
// dialog blocked the hangup, so the panel never completed teardown. Only the
// panel's reply ran clearRoom(), and clearRoom() is what sets 'idle' — so the
// session stuck at 'call-complete'. Joins only navigate from a settled state,
// so SEVEN join_call requests for a new meeting were accepted and silently
// dropped, each one telling her agent the app was navigating. join force:true,
// leave_call and end_session all failed to recover it; only quit + relaunch did.
//
// The dialog itself is fixed (#141, a4f83b56, shipped 0.8.16). These pin the
// fragility it exposed, which outlives that one dialog: a state machine whose
// progress depends on a specific renderer answering a message (#229's shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

test('teardown is a main-process function, not only the tail of a renderer round trip', () => {
  assert.match(main, /function performLeaveTeardown\(via\)/);
  // The IPC handler must DELEGATE to it rather than owning the steps, or the
  // two copies drift and only one of them gets fixed next time.
  assert.match(main, /ipcMain\.on\('leave-meet', \(\) => performLeaveTeardown\('panel'\)\)/);
  // The steps that actually settle the session.
  const fn = main.slice(main.indexOf('function performLeaveTeardown'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const s of ['clearRoom', 'closeClaudeTerminal', 'showIdle']) {
    assert.ok(body.includes(s), `teardown must still do ${s}`);
  }
});

test('one failing teardown step cannot strand the others', () => {
  // clearRoom() is what sets 'idle', so it must run first AND be insulated:
  // before this, a throw anywhere in the handler left the session unjoinable.
  const fn = main.slice(main.indexOf('function performLeaveTeardown'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const step = \(name, fn\) => \{\s*\n\s*try \{ fn\(\); \} catch/);
  assert.ok(body.indexOf("step('clearRoom'") < body.indexOf("step('closeClaudeTerminal'"),
    'clearRoom sets idle, so it must run before anything that could throw');
});

test('a watchdog forces idle when the panel never replies', () => {
  const fn = main.slice(main.indexOf('function finishCall()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /_idleWatchdog = setTimeout/);
  assert.match(body, /performLeaveTeardown\('watchdog'\)/);
  // The user must be told, not silently rescued — the Meet view may still be
  // showing the old call even though the session is joinable again.
  assert.match(body, /addError\(/);
  assert.match(main, /const IDLE_WATCHDOG_MS = \d+/);
});

test('no panel means teardown happens immediately, not after the timeout', () => {
  // panelView being destroyed is the case where waiting is provably pointless:
  // there is nobody to send 'leave-requested' to.
  const fn = main.slice(main.indexOf('function finishCall()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /\} else \{[\s\S]*performLeaveTeardown\('no-panel'\)/);
});

test('teardown is idempotent, because the watchdog and the panel reply race', () => {
  const fn = main.slice(main.indexOf('function performLeaveTeardown'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(_teardownDone\) return;\s*\n\s*_teardownDone = true;/);
  // ...and the latch must be re-armed per call, or the SECOND call of the app's
  // life would never tear down.
  const finish = main.slice(main.indexOf('function finishCall()'));
  assert.match(finish.slice(0, finish.indexOf('\n}\n')), /_teardownDone = false;/);
});

test('a join finishes an unfinished teardown instead of being dropped', () => {
  // Bethany's seven dropped joins. A join is the loudest possible signal that
  // the previous call is over, so it should not have to wait out the watchdog.
  const i = main.indexOf('Join arrived with teardown unfinished');
  assert.ok(i > 0, 'expected the join path to recover a stranded teardown');
  const guard = main.slice(i - 400, i);
  assert.match(guard, /callStatus === 'call-complete' && !_teardownDone/);
  assert.match(main.slice(i, i + 300), /performLeaveTeardown\('join'\)/);
});

test('a failed Meet navigation is reported, not swallowed', () => {
  // Every caller invokes loadMeetURL fire-and-forget, so before the wrapper a
  // rejection was an unhandled promise rejection: join had already said ok.
  // Signature matched loosely past `meetUrl`: the wrapper grew an options bag
  // for #347's guest fallback, and the point of this test is the try/await/
  // report shape, not the parameter list.
  assert.match(main, /async function loadMeetURL\(meetUrl[^)]*\) \{\s*\n\s*try \{\s*\n\s*await _openMeetInFreshView\(meetUrl/);
  const w = main.slice(main.indexOf('async function loadMeetURL'));
  const body = w.slice(0, w.indexOf('\n}\n'));
  assert.match(body, /addError\(/, 'the agent must learn the bot is NOT in the call');
  assert.match(body, /setCallStatus\('idle'\)/, 'a failed join must leave a joinable state');
  // The real implementation must still exist under its new name.
  assert.match(main, /async function _openMeetInFreshView\(meetUrl/);
});
