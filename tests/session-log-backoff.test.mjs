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
