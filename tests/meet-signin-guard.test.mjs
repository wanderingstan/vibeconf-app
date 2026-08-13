// meet-signin-guard.test.mjs — the sign-in check must never let "I couldn't
// tell" authorise deleting the bot's Google session.
//
// The hazard, in one sentence: clearMeetIdentityCache() deletes every
// .google.com path=/ cookie, which IS the Google master-auth set
// (SID/SSID/HSID/SAPISID/__Secure-1PSID), and its only caller runs it when
// isSignedInToGoogle() says "not signed in" — which that function also returned
// on a THROWN cookie read. So a transient failure of the check performed the
// exact destruction the check exists to prevent, silently (#250).
//
// isSignedInToGoogle lives in main.js, which can't be imported without Electron,
// so the guard is pinned at the source level. That is the right altitude anyway:
// what must not regress is the RELATIONSHIP between the check's error value and
// the branch that deletes cookies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');

function fnBody(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} exists`);
  return main.slice(start, main.indexOf('\n}', start));
}

test('a failed cookie read is UNKNOWN (null), not "logged out"', () => {
  const body = fnBody('isSignedInToGoogle');
  const c = body.indexOf('catch');
  assert.ok(c > -1, 'has a catch');
  const tail = body.slice(c);
  assert.match(tail, /return null/, 'returns null on error');
  assert.doesNotMatch(tail, /return false/, 'must NOT report a definite logged-out on an error');
});

test('only a POSITIVE logged-out reading may clear the identity cache', () => {
  // The single destructive call site must be gated on `=== false`. Truthiness
  // here is the whole bug: `if (!signedIn)` treats null as permission to delete.
  const line = main.split('\n').findIndex((l) => /await clearMeetIdentityCache\(/.test(l));
  assert.ok(line > -1, 'clearMeetIdentityCache is still called somewhere');
  const window = main.split('\n').slice(Math.max(0, line - 6), line + 1).join('\n');
  assert.match(window, /if \(signedIn === false\)/,
    'the clear is gated on an explicit `signedIn === false`, never on truthiness');
});

test('there is still exactly one caller that can delete the session', () => {
  // The guard above protects one call site. A second, ungated caller would walk
  // straight past it — so the count is part of the invariant.
  const calls = main.split('\n').filter((l) => /clearMeetIdentityCache\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  const invocations = calls.filter((l) => !/^async function|function clearMeetIdentityCache/.test(l.trim()));
  assert.equal(invocations.length, 1, `expected 1 invocation, found ${invocations.length}:\n${invocations.join('\n')}`);
});

test('authuser is pinned only on a KNOWN session', () => {
  // Pinning ?authuser=<email> on an unknown read would assert an identity we
  // could not verify at that moment.
  assert.match(main, /const boundEmail = signedIn === true && store/,
    'boundEmail requires signedIn === true');
});

test('an expired session notifies, and says which account to restore', () => {
  const body = fnBody('notifyMeetSignInNeeded');
  assert.match(body, /showMessageBox/, 'actually surfaces a dialog');
  assert.match(body, /\$\{email\}/, 'names the account rather than saying "an account"');
});

test('the expiry alert fires only for a profile that REMEMBERS an account', () => {
  // A guest-by-design profile (the whole test-meet-guest-* fleet) has no bound
  // account and must never see this. And the #347 guest fallback is a deliberate
  // downgrade that already reports its own lobby notice — alerting there too
  // would train everyone to ignore the alert.
  const i = main.indexOf('notifyMeetSignInNeeded(rememberedAccount)');
  assert.ok(i > -1, 'the alert is wired up');
  const guard = main.slice(Math.max(0, i - 400), i);
  assert.match(guard, /signedIn === false/, 'only on a definite logged-out');
  assert.match(guard, /rememberedAccount/, 'only when an account is remembered');
  assert.match(guard, /!guestFallback/, 'not on the deliberate #347 guest fallback');
});
