// onboarding-flow.test.mjs — the pure logic of the first-run wizard.
// Run: node --test tests/   (or `npm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PERMISSIONS, STEPS, normalizePermission, permissionsSummary,
  looksLikeElevenLabsKey, nextStep, prevStep, stepProgress,
} = require('../electron-app/onboarding-flow.js');

test('steps include sign-in and are ordered welcome→done', () => {
  assert.equal(STEPS[0], 'welcome');
  assert.equal(STEPS[STEPS.length - 1], 'done');
  assert.ok(STEPS.includes('signin'), 'has the vibeconferencing.com sign-in step');
  assert.ok(STEPS.includes('permissions') && STEPS.includes('logging') && STEPS.includes('bot'));
});

test('mic + camera are required; screen + automation are optional', () => {
  const req = PERMISSIONS.filter((p) => p.required).map((p) => p.key);
  assert.deepEqual(req.sort(), ['camera', 'microphone']);
  const opt = PERMISSIONS.filter((p) => !p.required).map((p) => p.key).sort();
  assert.deepEqual(opt, ['automation', 'screen']);
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
  const s1 = permissionsSummary({ microphone: 'granted', camera: 'granted', screen: 'denied', automation: 'unknown' });
  assert.equal(s1.allRequiredGranted, true);
  assert.deepEqual(s1.missingRequired, []);
  assert.deepEqual(s1.missingOptional.sort(), ['automation', 'screen']);

  const s2 = permissionsSummary({ microphone: 'granted', camera: 'denied' });
  assert.equal(s2.allRequiredGranted, false);
  assert.deepEqual(s2.missingRequired, ['camera']);

  // empty map → nothing granted → can't finish
  assert.equal(permissionsSummary({}).allRequiredGranted, false);
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
