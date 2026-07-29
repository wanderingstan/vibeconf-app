// onboarding-flow.test.mjs — the pure logic of the first-run wizard.
// Run: node --test tests/   (or `npm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PERMISSIONS, STEPS, permissionsFor, normalizePermission, permissionsSummary,
  looksLikeElevenLabsKey, nextStep, prevStep, stepProgress,
} = require('../electron-app/onboarding-flow.js');

test('steps include sign-in and are ordered welcome→done', () => {
  assert.equal(STEPS[0], 'welcome');
  assert.equal(STEPS[STEPS.length - 1], 'done');
  assert.ok(STEPS.includes('signin'), 'has the vibeconferencing.com sign-in step');
  assert.ok(STEPS.includes('permissions') && STEPS.includes('logging') && STEPS.includes('bot'));
  assert.ok(STEPS.includes('claude'), 'has the Claude Code install step');
  assert.ok(STEPS.indexOf('claude') < STEPS.indexOf('done'), 'claude comes before done');
});

test('mic + camera are required; screen + automation are optional', () => {
  const req = PERMISSIONS.filter((p) => p.required).map((p) => p.key);
  assert.deepEqual(req.sort(), ['camera', 'microphone']);
  const opt = PERMISSIONS.filter((p) => !p.required).map((p) => p.key).sort();
  assert.deepEqual(opt, ['automation', 'screen']);
});

// Every permission row must be one the OS can actually answer. A row we can't
// evaluate either states something untrue or sits permanently indeterminate,
// and the user has no way to tell which — both were seen on Windows in beta4.
test('permissions are filtered to the platforms that can answer them', () => {
  assert.deepEqual(permissionsFor('darwin').map((p) => p.key),
    ['microphone', 'camera', 'screen', 'automation'], 'macOS answers all four');

  const win = permissionsFor('win32').map((p) => p.key);
  assert.deepEqual(win, ['microphone', 'camera']);
  assert.ok(!win.includes('screen'),
    'getMediaAccessStatus always returns granted for screen on Windows — a constant, not a grant');
  assert.ok(!win.includes('automation'),
    'the automation probe shells osascript, which does not exist on Windows');

  assert.deepEqual(permissionsFor('linux'), [], 'no media permission API on Linux');
});

test('a platform with no answerable permissions does not wedge the wizard', () => {
  // The failure this prevents: rows that can never be granted would leave
  // allRequiredGranted false forever, so Finish never unlocks.
  const linux = permissionsSummary({}, { platform: 'linux' });
  assert.deepEqual(linux.rows, []);
  assert.equal(linux.allRequiredGranted, true, 'nothing required is missing, so finishing is allowed');
});

test('Windows summary reports only mic + camera', () => {
  const win = permissionsSummary(
    { microphone: 'granted', camera: 'granted', screen: 'granted', automation: 'unknown' },
    { platform: 'win32' },
  );
  assert.deepEqual(win.rows.map((r) => r.key), ['microphone', 'camera']);
  assert.equal(win.allRequiredGranted, true);
  assert.deepEqual(win.missingOptional, [], 'the optional rows are absent, not merely ungranted');
});

test('normalizePermission: granted vs needs-System-Settings vs promptable', () => {
  assert.equal(normalizePermission('microphone', 'granted').granted, true);
  const denied = normalizePermission('camera', 'denied');
  assert.equal(denied.granted, false);
  assert.equal(denied.needsSystemSettings, true, 'denied requires a System Settings trip');
  const fresh = normalizePermission('screen', 'not-determined');
  assert.equal(fresh.granted, false);
  assert.equal(fresh.needsSystemSettings, false, 'not-determined can still be prompted');
  // missing/undefined status defaults to not-determined, not a crash
  assert.equal(normalizePermission('automation', undefined).status, 'not-determined');
});

test('permissionsSummary: can finish only when both required are granted', () => {
  const D = { platform: 'darwin' };  // pin: these assertions are about the macOS row set
  const s1 = permissionsSummary({ microphone: 'granted', camera: 'granted', screen: 'denied', automation: 'unknown' }, D);
  assert.equal(s1.allRequiredGranted, true);
  assert.deepEqual(s1.missingRequired, []);
  assert.deepEqual(s1.missingOptional.sort(), ['automation', 'screen']);

  const s2 = permissionsSummary({ microphone: 'granted', camera: 'denied' }, D);
  assert.equal(s2.allRequiredGranted, false);
  assert.deepEqual(s2.missingRequired, ['camera']);

  // empty map → nothing granted → can't finish
  assert.equal(permissionsSummary({}, D).allRequiredGranted, false);
});

test('looksLikeElevenLabsKey: empty ok (skip → macOS TTS), sk_ ok, junk not', () => {
  assert.equal(looksLikeElevenLabsKey(''), true);
  assert.equal(looksLikeElevenLabsKey('   '), true);
  assert.equal(looksLikeElevenLabsKey('sk_0123456789abcdef'), true);
  assert.equal(looksLikeElevenLabsKey('not-a-key'), false);
  assert.equal(looksLikeElevenLabsKey('sk_short'), false);
});

test('step navigation is clamped at both ends', () => {
  assert.equal(nextStep('welcome'), 'permissions');
  assert.equal(prevStep('permissions'), 'welcome');
  assert.equal(prevStep('welcome'), 'welcome', 'clamped at start');
  assert.equal(nextStep('done'), 'done', 'clamped at end');
  assert.equal(nextStep('bogus'), STEPS[STEPS.length - 1]);

  const p = stepProgress('welcome');
  assert.equal(p.index, 0); assert.equal(p.isFirst, true); assert.equal(p.total, STEPS.length);
  assert.equal(stepProgress('done').isLast, true);
});
