// session-log-shipping.test.mjs — what the remote log flush ACTUALLY does with
// each HTTP status, exercised rather than grepped for.
//
// The bug this exists for: only 5xx threw, so a 401 fell through to the success
// path. The batch was dropped, added to _sentCount anyway, and _failures reset
// to zero — the app shipped nothing at full cadence while reporting perfect
// health, and wrote no line anywhere saying so.
//
// Measured 2026-08-18: `Stans-MacBook-Pro--Default` held 145 lines covering 96
// SECONDS of a 54-minute call, with remoteLogging still on and the local log at
// 12,529 lines for the same session. Every remote log we have ever tried to
// debug from has been truncated like that.
//
// It survived because the only tests here asserted on source TEXT. A regex
// cannot tell you that _sentCount advanced on a refusal. These drive the real
// function with a stubbed fetch.
//
// Run: node --test tests/session-log-shipping.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const log = require('../electron-app/session-log.js');
const T = log.__testing;

// Stub fetch, wire up a remote config, and hand back what the stub saw.
function harness(responder) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(calls.length);
  };
  T.reset();
  log.configureRemoteLog({
    enabled: true,
    endpointBase: () => 'https://example.invalid',
    instanceId: 'test--profile',
    sessionToken: () => 'fake-session',
    isActive: () => true,
  });
  return calls;
}

const reply = (status) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });

test('an accepted batch counts as sent and clears the failure state', async () => {
  harness(() => reply(200));
  T.enqueue('hello\n');
  await T.flush();
  assert.equal(log.getSentCount(), 1);
  assert.equal(log.getRejectedCount(), 0);
  assert.equal(T.failures(), 0);
});

test('a 401 is NOT counted as sent — the whole bug, in one assertion', async () => {
  harness(() => reply(401));
  T.enqueue('one\ntwo\nthree\n');
  await T.flush();
  assert.equal(log.getSentCount(), 0, 'refused lines must never advance the sent counter');
  assert.equal(log.getRejectedCount(), 3, 'and must be counted as refused');
});

test('a 401 arms the backoff instead of resetting it', async () => {
  harness(() => reply(401));
  T.enqueue('a\n');
  await T.flush();
  assert.ok(T.failures() > 0, 'a refusal must slow the cadence, not keep it at 3s');
});

test('a 401 marks shipping as refused, visibly', async () => {
  harness(() => reply(403));
  T.enqueue('a\n');
  await T.flush();
  assert.equal(log.isShippingRefused(), true);
});

test('a refused batch is dropped, not requeued forever', async () => {
  // Requeuing a batch the backend will always refuse blocks every newer line
  // behind it — the queue head never clears and the live tail dies.
  harness(() => reply(400));
  T.enqueue('a\nb\n');
  await T.flush();
  assert.equal(T.queueLength(), 0, 'a 4xx batch must not go back on the queue');
});

test('a 5xx DOES requeue, so a blip loses nothing', async () => {
  harness(() => reply(503));
  T.enqueue('a\nb\n');
  await T.flush();
  assert.equal(T.queueLength(), 2, 'server-side failures are transient and must be retried');
  assert.equal(log.getSentCount(), 0);
});

test('recovery clears the refused state and resumes counting', async () => {
  const calls = harness((n) => reply(n === 1 ? 401 : 200));
  T.enqueue('first\n');
  await T.flush();
  assert.equal(log.isShippingRefused(), true);
  assert.equal(log.getSentCount(), 0);

  T.enqueue('second\n');
  await T.flush();
  assert.equal(calls.length, 2);
  assert.equal(log.isShippingRefused(), false, 'a success must clear the refusal state');
  assert.equal(log.getSentCount(), 1, 'and resume counting real deliveries');
  assert.equal(log.getRejectedCount(), 0);
  assert.equal(T.failures(), 0, 'and restore the healthy cadence');
});

test('the write carries the user session, which is what the backend accepts', async () => {
  // #386/#439: the shared token path returns 401 from the backend; the session
  // cookie returns 200. If this header ever stops being sent, shipping dies for
  // everyone with no other symptom than a truncated remote log.
  const calls = harness(() => reply(200));
  T.enqueue('a\n');
  await T.flush();
  assert.match(calls[0].opts.headers.Cookie, /^vc_session=/);
});

test('a batch is only POSTed when there is something to send', async () => {
  const calls = harness(() => reply(200));
  await T.flush();
  assert.equal(calls.length, 0, 'an empty queue must not generate traffic');
});
