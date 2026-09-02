// session-precedence.test.mjs — which vibeconferencing.com login wins when the
// profile's cookie and the app-level shared token disagree.
//
// This file exists because of a bug that left no trace. A year-long session was
// minted for the nightly rig and written to the shared config; starting the app
// once put the old 30-day token straight back, because it was still valid and the
// reconciliation preferred "local and valid" over "shared and valid". Same
// account, still signed in, nothing in any log — the only symptom was an expiry
// date nobody re-read.
//
// So the cases below are mostly about the situation where BOTH tokens work. That
// is the one the original rule got wrong, and it is invisible unless asserted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pickSharedSession, tokenExp } = require('../electron-app/session-precedence.js');

const NOW = 1_800_000_000; // fixed, so these never rot
const day = 86400;

// A syntactically real JWT with the exp we want. Only the payload is read —
// nothing here verifies signatures, which is the server's job.
function jwt(exp, extra = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ userId: 'u1', email: 'bot@example.com', exp, ...extra })}.sig`;
}

test('tokenExp reads exp, and returns null rather than guessing', () => {
  assert.equal(tokenExp(jwt(NOW + day)), NOW + day);
  // Every one of these must be null, NOT 0 — a caller that treated "unknown" as
  // "expired" would throw away a perfectly good login.
  for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b', 'a.!!!.c']) {
    assert.equal(tokenExp(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
  assert.equal(tokenExp(jwt(undefined)), null, 'a payload with no exp is unknown');
});

test('a fresh sign-in still propagates — the #366 behaviour is preserved', () => {
  // The normal case: someone signs in, their new cookie outlives whatever was
  // shared, and every other profile should pick it up.
  const r = pickSharedSession({
    local: jwt(NOW + 30 * day), shared: jwt(NOW + 5 * day),
    localAuthenticated: true, nowSec: NOW,
  });
  assert.equal(r.action, 'donate-up');
});

test('a valid local cookie does NOT displace a longer-lived shared token — the bug', () => {
  // The rig case, exactly: local is a valid 17-days-left token, shared is the
  // minted 365-day one. The old rule donated local up and lost the year.
  const r = pickSharedSession({
    local: jwt(NOW + 17 * day), shared: jwt(NOW + 365 * day),
    localAuthenticated: true, nowSec: NOW,
  });
  assert.equal(r.action, 'seed-cookie');
  assert.match(r.reason, /longer/);
});

test('an EXPIRED shared token never wins, however long its nominal life was', () => {
  // The live cookie beats a dead certificate. Without this, a stale shared token
  // with a distant exp… still has a distant exp, and would win forever.
  const r = pickSharedSession({
    local: jwt(NOW + day), shared: jwt(NOW - day),
    localAuthenticated: true, nowSec: NOW,
  });
  assert.equal(r.action, 'donate-up');
  assert.match(r.reason, /expired/);
});

test('equal lifetimes donate up, so the outcome never depends on tie-breaking noise', () => {
  // DIFFERENT tokens that happen to expire at the same second — the `sid` claim
  // is only there to make them distinguishable. Building them with identical
  // payloads would make this test pass through the `local === shared` shortcut
  // and assert nothing about precedence at all.
  const r = pickSharedSession({
    local: jwt(NOW + 10 * day, { sid: 'a' }), shared: jwt(NOW + 10 * day, { sid: 'b' }),
    localAuthenticated: true, nowSec: NOW,
  });
  assert.equal(r.action, 'donate-up');
});

test('an unparseable token falls back to #366 rather than guessing', () => {
  // A token we cannot read is not evidence. Guessing here would be worse than
  // the bug this module fixes, so the old behaviour stands.
  for (const [local, shared] of [
    ['opaque-token', jwt(NOW + 365 * day)],
    [jwt(NOW + day), 'opaque-token'],
  ]) {
    const r = pickSharedSession({ local, shared, localAuthenticated: true, nowSec: NOW });
    assert.equal(r.action, 'donate-up', `${local} vs ${shared}`);
    assert.match(r.reason, /unknown/);
  }
});

test('a stale local cookie is replaced by the shared login, valid or not', () => {
  const r = pickSharedSession({
    local: jwt(NOW - day), shared: jwt(NOW + 30 * day),
    localAuthenticated: false, nowSec: NOW,
  });
  assert.equal(r.action, 'seed-cookie');
});

test('no local cookie seeds from shared; nothing at all is a no-op', () => {
  assert.equal(pickSharedSession({ local: null, shared: jwt(NOW + day), localAuthenticated: false, nowSec: NOW }).action, 'seed-cookie');
  assert.equal(pickSharedSession({ local: null, shared: null, localAuthenticated: false, nowSec: NOW }).action, 'none');
});

test('identical tokens do nothing — no write, no cookie churn on every launch', () => {
  const t = jwt(NOW + day);
  assert.equal(pickSharedSession({ local: t, shared: t, localAuthenticated: true, nowSec: NOW }).action, 'none');
});

test('a verified local login with nothing shared is donated up', () => {
  const r = pickSharedSession({ local: jwt(NOW + day), shared: null, localAuthenticated: true, nowSec: NOW });
  assert.equal(r.action, 'donate-up');
});
