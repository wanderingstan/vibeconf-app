// remote-log-keeps-shipping.test.mjs — #619: remote log shipping must survive a
// quiet moment.
//
// The bug: _flushRemote() returned bare when the queue happened to be empty,
// skipping the `finally` that reschedules. The timer that fired to get there was
// spent, and _ensureFlushTimer() bails while _flushTimer is truthy — so the
// FIRST idle tick ended remote shipping for the rest of the process. Silently:
// no error, no retry, no log line, because no attempt was ever made again.
//
// Observed on vibeconf-cloud-ta 2026-08-31 while trying to diagnose an unrelated
// report: 60 lines on the server, all from around startup, against a 1.3 MB
// local log. An hour-long call shipped nothing, with `remoteLogging=true` and a
// valid login. Three weeks earlier #417 hit the same wall.
//
// This is a FUNCTIONAL test on purpose. The failure is in the scheduling loop,
// which no source assertion can see — the old code reads perfectly reasonably.
//
// Run: node --test tests/remote-log-keeps-shipping.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sessionLog = require('../electron-app/session-log.js');

// The queue is fed by the stdout tee that initSessionLog installs — without it
// nothing is ever enqueued and every assertion below would pass vacuously.
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join: pjoin } = await import('node:path');
sessionLog.initSessionLog({ userDataDir: mkdtempSync(pjoin(tmpdir(), 'remote-log-test-')) });

const TICK = 40;               // flush cadence for the test
const QUIET_TICKS = 6;         // long enough to be sure an empty tick happened

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** A backend that records every line it is POSTed. */
async function startSink() {
  const lines = [];
  let posts = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      posts++;
      try {
        const j = JSON.parse(body || '{}');
        for (const l of (j.lines || j.content?.split('\n') || [])) lines.push(l);
      } catch { /* shape doesn't matter here — the COUNT does */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"success":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { lines, server, get posts() { return posts; }, url: `http://127.0.0.1:${server.address().port}` };
}

test('shipping survives an idle gap — the whole bug', async (t) => {
  const sink = await startSink();
  t.after(() => new Promise((r) => sink.server.close(r)));

  sessionLog.configureRemoteLog({
    enabled: true,
    endpointBase: () => sink.url,
    instanceId: 'test--keeps-shipping',
    intervalMs: TICK,
    isActive: () => true,
  });

  // A burst, as at app startup.
  process.stdout.write('first-burst-line\n');
  await sleep(TICK * 3);
  const afterFirst = sink.posts;
  assert.ok(afterFirst > 0, 'the opening burst must ship');

  // Now go quiet. The queue drains and the timer fires on an empty queue —
  // the exact moment shipping used to die.
  await sleep(TICK * QUIET_TICKS);

  // Speak again, as a call does after a lull.
  process.stdout.write('after-the-quiet-line\n');
  await sleep(TICK * 5);

  assert.ok(sink.posts > afterFirst,
    `nothing shipped after the idle gap (${afterFirst} posts before, ${sink.posts} after) — ` +
    'the flush loop stopped rescheduling');
});

test('an unresolvable endpoint pauses shipping, it does not end it', async (t) => {
  // The other bare `return`: no backend URL yet at startup. It must keep the
  // loop alive so shipping begins once the URL resolves, rather than buffering
  // into a queue nobody will ever drain.
  const sink = await startSink();
  t.after(() => new Promise((r) => sink.server.close(r)));

  let base = '';    // not resolvable yet
  sessionLog.configureRemoteLog({
    enabled: true,
    endpointBase: () => base,
    instanceId: 'test--late-url',
    intervalMs: TICK,
    isActive: () => true,
  });

  process.stdout.write('queued-before-the-url-exists\n');
  await sleep(TICK * 4);
  assert.equal(sink.posts, 0, 'nothing can ship without a URL');

  base = sink.url;  // the URL arrives
  await sleep(TICK * 6);
  assert.ok(sink.posts > 0, 'shipping never resumed once the endpoint became resolvable');
});

test('the fired timer handle is cleared before any early return', async () => {
  // Belt and braces on the mechanism, since the two tests above would also pass
  // if someone "fixed" this by removing the _ensureFlushTimer guard instead.
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'electron-app/session-log.js'), 'utf8');

  const fn = src.slice(src.indexOf('async function _flushRemote()'));
  const head = fn.slice(0, fn.indexOf('_flushing = true;'));
  assert.match(head, /_flushTimer = null;/, 'clear the spent handle first');
  assert.ok(head.indexOf('_flushTimer = null;') < head.indexOf('if (_flushing'),
    'it must be cleared BEFORE the first early return, not after');
  // No bare `return;` left in the head — every exit reschedules.
  const bare = head.split('\n').filter((l) => /^\s*(if \(.*\) \{ )?return;/.test(l));
  assert.equal(bare.length, 0, `bare returns skip the reschedule: ${bare.join(' | ')}`);
});
