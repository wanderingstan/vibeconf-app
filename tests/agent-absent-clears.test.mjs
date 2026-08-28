// agent-absent-clears.test.mjs — #533: the "this bot has gone quiet" warning
// outlived the condition it reported.
//
// The error bar had exactly one dismissal path, a click on its close button, so
// the notice survived both the agent recovering and the call ending. From the
// outside a stale warning is indistinguishable from a live one, which makes it
// useless even when it is live: you cannot tell whether you are looking at now
// or at something that fixed itself five minutes ago.
//
// pollAgentLiveness already detected recovery and deliberately said nothing, on
// the sound reasoning that an alert for "everything is fine again" trains people
// to dismiss alerts. But "do not announce recovery" had been implemented as "do
// nothing on recovery", and retracting a warning that is no longer true is not
// an announcement.
//
// Run: node --test tests/agent-absent-clears.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

const poll = (() => {
  const i = main.indexOf('function pollAgentLiveness()');
  return main.slice(i, main.indexOf('\nsetInterval(pollAgentLiveness', i));
})();

test('recovery retracts the notice', () => {
  assert.ok(poll.includes('clearBroadcastError(AGENT_ABSENT_ERROR_KEY)'),
    'the recovery branch must take the warning down');
  const i = poll.indexOf('if (!absent)');
  const j = poll.indexOf('clearBroadcastError');
  assert.ok(i > -1 && j > i, 'it belongs on the not-absent path');
});

test('recovery stays quiet: no alert, no second error', () => {
  // The whole reason recovery said nothing before was that "everything is fine
  // again" alerts train people to dismiss alerts. Retracting is not announcing,
  // and this must not become an announcement by accident.
  const recovery = poll.slice(poll.indexOf('if (!absent)'), poll.indexOf('return;'));
  assert.ok(!/broadcastError\(/.test(recovery), 'recovery must not raise an error of its own');
  assert.ok(!/Notification|playSound|speak/.test(recovery), 'recovery must not alert');
});

test('the warning is raised under a key so it CAN be retracted', () => {
  assert.match(main, /const AGENT_ABSENT_ERROR_KEY = 'agent-absent';/);
  assert.match(poll, /broadcastError\(message, AGENT_ABSENT_ERROR_KEY\)/,
    'all three absence reasons share one key, so recovery clears whichever showed');
});

test('a clear only takes down its OWN message', () => {
  // An unrelated failure that arrived in the meantime is still true. Wiping it
  // because some other condition recovered would lose a real message.
  const fn = panel.slice(panel.indexOf('function clearError(key)'));
  assert.match(fn.slice(0, 500), /if \(!key\) return;/,
    'an unkeyed clear must do nothing at all');
  assert.match(fn.slice(0, 500), /_errorStack\[i\]\.key === key/,
    'only entries under this key come down');
  assert.match(panel, /showError\(message\.message, message\.key\)/,
    'the key has to reach the renderer for the comparison to mean anything');
});

test('an unkeyed error cannot disarm a keyed retraction', () => {
  // THE 2026-08-28 BUG. `_errorKey` was one slot, set on every showError —
  // including the ~15 calls in this file that pass no key (clipboard
  // confirmations, "could not create bot", share failures) and three from
  // google-meet-provider. Any one of them set it to null, and from then on
  // clearError('agent-absent') could never match again for the rest of the
  // session: the "bot has gone quiet" bar stayed up after the bot came back.
  //
  // Seen live with the main process provably sending the retraction — three
  // paired quiet/back transitions in the log, the last six minutes before the
  // bar was still on screen.
  assert.ok(!/let _errorKey\b/.test(panel),
    'one slot is a latch: any unkeyed error disarms every later retraction');
  assert.match(panel, /const _errorStack = \[\]/,
    'keep every raised error, so a keyless one on top cannot lose a keyed one under it');

  // showError must not be able to drop a keyed entry it does not own.
  const show = panel.slice(panel.indexOf('function showError(message, key)'));
  assert.doesNotMatch(show.slice(0, 600), /_errorStack\.length = 0/,
    'raising an error must never clear the ones already known about');

  // Re-raising the same condition replaces rather than duplicates — a flapping
  // bot would otherwise leave N copies, and one clear would retract only one.
  assert.match(show.slice(0, 600), /findIndex\(\(e\) => e\.key === key\)/);
});

test('both directions are logged, so next time the log answers it', () => {
  // Nothing recorded showError or clearError, in either direction. That is why
  // "the warning will not dismiss" could only be argued about: the main process
  // logs its half (🫥 no agent driving / agent back) and the renderer logged
  // nothing at all, so there was no way to tell which side dropped it.
  assert.match(panel, /\[panel\] error shown/);
  assert.match(panel, /\[panel\] error cleared/);
});

test('dismissing by hand drops everything', () => {
  // The user said "I have seen these". Leaving a hidden entry behind to
  // reappear when some unrelated error clears would be a ghost.
  const close = panel.slice(panel.indexOf("getElementById('errorClose')"));
  assert.match(close.slice(0, 500), /_errorStack\.length = 0;/);
});

test('a condition that recurs after recovering notifies again', () => {
  // broadcastError dedupes system notifications by message text. Without
  // dropping that entry on recovery, a bot that goes quiet, recovers, and goes
  // quiet again inside the dedupe window is silently un-warned the second time.
  const fn = main.slice(main.indexOf('function clearBroadcastError(key)'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /recentErrorNotifications\.delete\(m\)/);
  assert.match(body, /_errorKeyForMessage\.delete\(m\)/);
});

test('the key side-map cannot outlive the dedupe map it shadows', () => {
  const i = main.indexOf('recentErrorNotifications.size > 50');
  assert.match(main.slice(i, i + 400), /_errorKeyForMessage\.delete\(k\)/,
    'the best-effort prune must drop both, or the side map grows unbounded');
});
