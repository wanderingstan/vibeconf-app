// meet-poll-noise.test.mjs — the Meet/Slack auto-detect poll must not log a
// persistent failure on every tick, and must not run at all where it cannot work.
//
// The poll is AppleScript: `osascript` scanning Chrome/Safari/Brave tabs for an
// open Meet. Off macOS there is no osascript, so every tick failed with ENOENT
// and logged a line — every 5 seconds, forever. On the always-on Linux TA box
// that is ~12 lines a minute, ~17k a day, from a subsystem that cannot succeed
// by construction. It buried the [calendar] poll lines (the ones you actually
// need when a scheduled auto-join misbehaves) at roughly 12:1:
//
//   03:07:45 [electron] Meet poll failed (0.0s): spawn osascript ENOENT
//   03:07:50 [electron] Meet poll failed (0.0s): spawn osascript ENOENT
//   03:07:51 [calendar] Poll saw 2 event(s): ...          <- the useful line
//   03:07:55 [electron] Meet poll failed (0.0s): spawn osascript ENOENT
//
// Two fixes, both pinned here: don't start the poller off macOS, and on macOS
// log a given failure once rather than repeating it while the cause persists.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The body of startMeetDetection, so these assertions can't be satisfied by
// some unrelated platform check elsewhere in a very large file.
function startMeetDetectionBody() {
  const i = src.indexOf('function startMeetDetection()');
  assert.ok(i !== -1, 'startMeetDetection not found — renamed?');
  // Must reach past setInterval(pollForMeet, …) at the end of the function —
  // an earlier cutoff made the ordering assertion below pass VACUOUSLY by
  // simply not finding the call it was supposed to be ordered against.
  const body = src.slice(i, i + 16000);
  assert.ok(body.includes('setInterval(pollForMeet'),
    'slice is too small to contain setInterval — assertions below would be vacuous');
  return body;
}

test('the poller does not start off macOS', () => {
  const body = startMeetDetectionBody();
  const guard = /if \(process\.platform !== 'darwin'\)[\s\S]{0,400}?return;/.test(body);
  assert.ok(guard, 'startMeetDetection must bail out early when platform is not darwin');

  // The guard has to come BEFORE the interval is armed, or it bails too late
  // and the poll runs anyway.
  const guardAt = body.search(/if \(process\.platform !== 'darwin'\)/);
  const intervalAt = body.search(/setInterval\(pollForMeet/);
  assert.ok(guardAt !== -1 && intervalAt !== -1, 'both the guard and setInterval must be present');
  assert.ok(guardAt < intervalAt,
    'the non-darwin guard must precede setInterval(pollForMeet)');
});

test('a repeated identical failure is logged once, not every tick', () => {
  const body = startMeetDetectionBody();
  // The failure log must be conditional on the message having changed.
  assert.ok(/lastMeetPollFailure/.test(body),
    'expected a remembered last-failure key to suppress duplicates');
  assert.ok(/if \(failKey !== lastMeetPollFailure\)/.test(body),
    'the failure log must be gated on the message differing from the last one');

  // The log must sit INSIDE that gate. Matching "is there an unconditional
  // console.log" by shape does not work — the line reads identically whether or
  // not it is wrapped in an if — so assert on ORDER and proximity instead: the
  // gate immediately precedes the log it guards.
  const gateAt = body.search(/if \(failKey !== lastMeetPollFailure\)/);
  const logAt = body.search(/console\.log\(`\[electron\] Meet poll failed/);
  assert.ok(gateAt !== -1 && logAt !== -1, 'gate and failure log must both exist');
  assert.ok(gateAt < logAt, 'the failure log must come after its gate, not before');
  assert.ok(logAt - gateAt < 200,
    `the failure log should be inside the gate, but sits ${logAt - gateAt} chars after it`);
});

test('a different failure still gets through, and recovery re-arms', () => {
  const body = startMeetDetectionBody();
  // Keyed by message, so ENOENT following a timeout is still reported.
  assert.ok(/const failKey = /.test(body), 'failures should be keyed by message, not a boolean');
  // Cleared on success — otherwise the first failure silences that message
  // for the process lifetime, including a genuine recurrence hours later.
  assert.ok(/lastMeetPollFailure = null/.test(body),
    'a successful poll must clear the suppression so a recurrence is reported');
});

test('the non-darwin path says why, so the absence is explainable', () => {
  const body = startMeetDetectionBody();
  const m = body.match(/if \(process\.platform !== 'darwin'\)[\s\S]{0,500}?return;/);
  assert.ok(m, 'guard not found');
  assert.ok(/console\.log/.test(m[0]),
    'the guard should log once — "auto-detect silently missing" is its own support ticket');
  assert.ok(/AppleScript|macOS-only/i.test(m[0]),
    'the log should name the reason (AppleScript / macOS-only)');
});
