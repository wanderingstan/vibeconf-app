// session-log-backoff.test.mjs — remote log shipping must back off when the
// backend is failing, and eventually give up on a batch (#221).
//
// This is the amplifier behind the Aug 1 whiteboard outage. The backend
// rate-limited its Redis and began 500ing. Every app instance requeued its batch
// and re-POSTed on a FIXED 3s interval, forever — no counter, no backoff, despite
// a comment claiming it retried "once". Those retries kept the database
// rate-limited, and room-state reads (the whiteboard) failed for as long as it
// went on. The logging was holding down the thing it was waiting for.
//
// Run: node --test tests/session-log-backoff.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'electron-app/session-log.js'), 'utf8');

test('a failing endpoint is backed off, not hammered on a fixed interval', () => {
  // setInterval is the bug: it cannot slow down. Scheduling has to be per-attempt.
  assert.doesNotMatch(src, /setInterval\(_flushRemote/,
    'a fixed interval cannot back off — reschedule per attempt instead');
  assert.match(src, /_flushTimer = setTimeout\(_flushRemote, delay\)/);
  assert.match(src, /Math\.pow\(2, Math\.min\(_failures, 8\)\)/, 'geometric, and bounded');
  assert.match(src, /REMOTE_MAX_BACKOFF_MS/, 'with a ceiling, so it never stops entirely');
});

test('the backoff is armed by failures and disarmed by success', () => {
  assert.match(src, /_failures = 0;\s*\/\/ recovered/, 'a success must restore the normal cadence');
  assert.match(src, /_failures\+\+/);
  // Without this the retry stays slow forever after one blip.
  const delay = src.slice(src.indexOf('const delay = _failures'));
  assert.match(delay.slice(0, 200), /: base;/, 'zero failures means the healthy interval');
});

test('a batch that will never be accepted is eventually dropped', () => {
  // The queue cap bounds MEMORY, which was already handled. What was unbounded
  // was TRAFFIC — and a batch stuck at the head of the queue also blocks every
  // newer line behind it.
  assert.match(src, /if \(_failures <= REMOTE_MAX_ATTEMPTS\)/);
  assert.match(src, /dropping \$\{batch\.length\} lines after/);
});

test('the reschedule runs even when a flush throws', () => {
  // In `finally`, or a thrown flush kills the timer chain outright and remote
  // logging stops silently — worse than the bug being fixed.
  const fin = src.slice(src.indexOf('} finally {'));
  assert.match(fin.slice(0, 200), /_rescheduleFlush\(\)/);
});

test('a 429 drops the batch AND backs off', () => {
  // The gap found while watching production: 429 did not throw, so _failures
  // reset and the client kept its 3s cadence. The server was saying "stop" and
  // the client heard "fine". A 429 that does not change behaviour is just a
  // politer 500.
  const shed = src.slice(src.indexOf('if (resp.status === 429)'));
  assert.ok(shed.length > 0, 'a 429 must be handled distinctly from other 4xx');
  const body = shed.slice(0, 500);
  assert.match(body, /_failures\+\+/, 'must arm the backoff');
  assert.match(body, /return;/, 'and drop the batch rather than requeue it');
  // The reset must come AFTER the 429 branch, or it undoes the backoff.
  // Anchored on the reset's comment: a bare '_failures = 0;' also matches the
  // `let` declaration at the top of the file, which is always earlier and made
  // this assertion fail against correct code.
  assert.ok(src.indexOf('if (resp.status === 429)') < src.indexOf("_failures = 0;   // recovered"),
    'the success reset must not run for a shed request');
});

test('4xx still drops immediately — only 5xx and network errors retry', () => {
  // A rejected payload or bad token can never succeed; retrying it is pure load.
  // (The backend returning 500 rather than 429 for rate-limiting is what put
  // this failure on the retry path at all.)
  assert.match(src, /if \(!resp\.ok && resp\.status >= 500\) throw new Error/);
});

test('idle instances ship on a relaxed cadence (#230)', () => {
  // Where the volume actually was. The app polls the browser for a Meet every
  // 5s while NOT in a call, so the queue was never empty and an idle instance
  // POSTed every 3s forever — ~80 Redis ops/minute doing nothing, on every open
  // app, against the store that also serves live whiteboards.
  assert.match(src, /const REMOTE_IDLE_INTERVAL_MS = 30_000/);
  assert.match(src, /const base = active \? \(_flushIntervalMs \|\| 3000\) : REMOTE_IDLE_INTERVAL_MS/);
});

test('the active check is a getter, and failing it errs toward shipping', () => {
  // Read at schedule time: the call phase changes constantly, and freezing it at
  // configure time would pin the cadence to whatever was true at launch.
  assert.match(src, /isActive: isActive \|\| null/);
  // If the getter throws, ship promptly rather than going quiet — losing a live
  // tail is worse than a few extra requests, and this must never be the reason
  // logs stop.
  const sched = src.slice(src.indexOf('let active = true;'));
  assert.match(sched.slice(0, 300), /catch \{[^}]*\}/);
});

test('joining counts as active, not idle', () => {
  // A join that is failing is the single most likely thing someone is tailing
  // the log for, so `in-call` alone is the wrong test.
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.match(main, /isActive: \(\) => String\(localServer\.callStatus \|\| 'idle'\) !== 'idle'/);
});

test('a successful no-op Meet poll is not logged (#230)', () => {
  // One line every 5s, and the single biggest source of idle log volume. A poll
  // that succeeded and found nothing is not information; a SLOW one is.
  const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
  assert.doesNotMatch(main, /console\.log\(`\[electron\] Meet poll ok/,
    'a successful no-op poll must not be logged');
  assert.match(main, /Meet poll slow/, 'but a slow poll still is — it means a hang or a permission problem');
  assert.match(main, /Meet poll failed/, 'and failures were already logged');
});
