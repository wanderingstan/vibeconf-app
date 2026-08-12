// share-state-honesty.test.mjs — status.sharing must be HONEST: true only when the
// provider confirms we are actually presenting, never optimistically pre-set (#282).
//
// The bug: on Meet, `sharing` was set true the instant a share was requested, then
// reconciled to false ~0.8s later because "Present now" had not engaged yet. So
// status.sharing flickered true→false during spin-up — an agent (or the
// whiteboard-e2e harness) polling it saw a share that was not on screen. Worse, a
// second variable (selfPresentingConfirmed) existed purely to give the retry loop a
// signal it COULD trust, since `sharing` could not be. Two names for one fact.
//
// The fix: one honest published state (`sharing`, driven only by the confirmed
// selfPresenting DOM read) plus one internal intent flag (`shareIntended`). The
// confirmed-presenting var is deleted; the retry loop reads `sharing` directly.
//
// Run: node --test tests/share-state-honesty.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The whiteboard/screen share handler, bounded by the next handler.
const shareBlock = main.slice(
  main.indexOf('onShareWhiteboard:'),
  main.indexOf('onStopSharing:'),
);

test('the share request does not optimistically pre-set status.sharing', () => {
  assert.ok(shareBlock.length > 0, 'onShareWhiteboard handler must exist');
  assert.doesNotMatch(shareBlock, /setSharing\(true\)/,
    'sharing must not be set true up front — it lies about a share that has not engaged (#282)');
});

test('intent is tracked separately from the published sharing state', () => {
  assert.match(shareBlock, /shareIntended = true/,
    'a share request records INTENT, distinct from the confirmed `sharing` flag');
});

test('no code path sets status.sharing true optimistically', () => {
  // The only writers of true should be the confirmed selfPresenting path
  // (setSharing(!!presenting) / setSharing(presenting)); a bare setSharing(true)
  // is by definition optimistic.
  assert.doesNotMatch(main, /setSharing\(true\)/,
    'setSharing(true) is always optimistic — sharing may only go true on a confirmed present');
});

test('the redundant confirmed-presenting variable is gone', () => {
  assert.ok(!main.includes('selfPresentingConfirmed'),
    'sharing is now the single source of truth; the parallel confirmed var must be deleted');
});

test('the Present-now retry loop gates on the honest sharing flag', () => {
  // It used to read selfPresentingConfirmed because `sharing` could not be
  // trusted. Now it reads `sharing` directly — proving `sharing` is the real
  // engagement signal on both platforms.
  assert.match(shareBlock, /if \(localServer\.sharing\) \{[\s\S]*?stopping retries/,
    'the retry loop must stop on localServer.sharing, the confirmed engagement signal');
});

test('intent is cleared when the share ends or is abandoned', () => {
  // Leave, stop, and give-up must all drop intent so nothing keeps believing a
  // present is pending after it is over.
  const clears = (main.match(/shareIntended = false/g) || []).length;
  assert.ok(clears >= 3,
    `intent must be cleared on leave, stop, and give-up (found ${clears} clears)`);
});
