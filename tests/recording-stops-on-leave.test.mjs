// recording-stops-on-leave.test.mjs — #326: a leave must end the recording,
// whichever way the leave was asked for.
//
// The failure, from the 2026-08-11 stand-up (room muw-osma-bkz): the panel's
// "Leave Call" button was clicked, the session logged "Call teardown complete
// (via panel) — status idle", and 24 seconds later the recording was still
// running — it only ended because someone pressed Stop on the indicator window.
//
// The cause was a fork in the leave routes. Agent leave_call / auto-leave /
// host-ended-meeting all go through onLeaveCall, which stops the recording. The
// panel button goes 'leave-meet' → performLeaveTeardown, which did not. So the
// fix is not "add a second call site" but "put it on the path they SHARE" —
// which is what these pin, because a future leave route added next to the panel
// one would otherwise reintroduce exactly this bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

function teardownBody() {
  const fn = main.slice(main.indexOf('function performLeaveTeardown'));
  return fn.slice(0, fn.indexOf('\n}\n'));
}

test('the shared teardown path stops the recording', () => {
  assert.match(teardownBody(), /stopCallRecording\(\)/,
    'performLeaveTeardown is where every leave route converges — the stop belongs here');
});

test('the recording stops before the Meet view is navigated away', () => {
  // showIdle() loads the idle page into meetView, which destroys the audio
  // tracks being recorded. Stopping after that finalizes a recording whose
  // last seconds captured nothing.
  const body = teardownBody();
  assert.ok(body.indexOf("step('stopCallRecording'") < body.indexOf("step('showIdle'"),
    'stopCallRecording must run before showIdle navigates the tracks away');
  // ...but still after clearRoom, which is what sets 'idle' (#254).
  assert.ok(body.indexOf("step('clearRoom'") < body.indexOf("step('stopCallRecording'"),
    'clearRoom sets idle and must stay first');
});

test('the stop cannot block or break teardown', () => {
  const body = teardownBody();
  // Wrapped in step() like every other teardown action, so a throw is logged
  // rather than stranding the steps after it...
  assert.match(body, /step\('stopCallRecording'/);
  // ...and fire-and-forget with a .catch, because stopCallRecording is async
  // (the video stop and the ffmpeg merge are real work) and reaching idle must
  // never wait on it.
  assert.match(body, /stopCallRecording\(\)\s*\.catch\(/,
    'must be fire-and-forget with a rejection handler, not awaited');
  assert.ok(!/await stopCallRecording/.test(body),
    'awaiting would make teardown hang on a slow merge');
});

test('the panel button still reaches teardown', () => {
  // The whole bug was this route skipping the stop; if the route itself is
  // rewired, this test should be the thing that notices.
  assert.match(main, /ipcMain\.on\('leave-meet', \(\) => performLeaveTeardown\('panel'\)\)/);
});
