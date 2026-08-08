// onboarding-flow.test.mjs — the pure logic of the first-run wizard.
// Run: node --test tests/   (or `npm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  PERMISSIONS, STEPS, permissionsFor, normalizePermission, permissionsSummary,
  looksLikeElevenLabsKey, nextStep, prevStep, stepProgress,
} = require('../electron-app/onboarding-flow.js');

test('steps include sign-in and are ordered welcome→done', () => {
  assert.equal(STEPS[0], 'welcome');
  assert.equal(STEPS[STEPS.length - 1], 'done');
  assert.ok(STEPS.includes('signin'), 'has the vibeconferencing.com sign-in step');
  assert.ok(STEPS.includes('permissions') && STEPS.includes('logging'));
  assert.ok(!STEPS.includes('bot'), 'bot name/emoji are now set live in the guided onboarding call, not the wizard');
  assert.ok(STEPS.includes('claude'), 'has the Claude Code install step');
  assert.ok(STEPS.indexOf('claude') < STEPS.indexOf('done'), 'claude comes before done');
});

// Microphone and Camera were removed after testing them rather than assuming.
// On a signed build with Camera reset and Microphone explicitly DENIED, the bot
// joined a Meet, rendered its avatar and was heard speaking by a human: the
// virtual mic is an AudioContext and the virtual camera is a <canvas>, and
// getUserMedia is intercepted before Chromium ever opens a device. Two prompts
// that bought nothing, shown to a first-time user before the wizard had
// explained anything. Don't add them back without repeating that test.
test('no permission is required, and mic/camera are gone entirely', () => {
  assert.deepEqual(PERMISSIONS.filter((p) => p.required).map((p) => p.key), []);
  assert.deepEqual(PERMISSIONS.map((p) => p.key).sort(), ['automation', 'screen']);
});

// Every permission row must be one the OS can actually answer. A row we can't
// evaluate either states something untrue or sits permanently indeterminate,
// and the user has no way to tell which — both were seen on Windows in beta4.
test('permissions are filtered to the platforms that can answer them', () => {
  assert.deepEqual(permissionsFor('darwin').map((p) => p.key), ['screen', 'automation']);

  // Both survivors are macOS-only, so every other platform now has an EMPTY
  // list. That's correct, not a bug: getMediaAccessStatus always returns
  // 'granted' for screen on Windows (a constant, not a grant), and the
  // automation probe shells osascript, which Windows doesn't have.
  assert.deepEqual(permissionsFor('win32'), []);
  assert.deepEqual(permissionsFor('linux'), [], 'no media permission API on Linux');
});

// An empty list must render as a sentence, not as a blank step that looks broken.
test('the wizard has an empty-state for platforms with nothing to grant', () => {
  const js = readFileSync(join(root, 'electron-app/renderer/onboarding.js'), 'utf8');
  const fn = js.slice(js.indexOf('async function loadPermissions'));
  assert.match(fn.slice(0, 900), /if \(!state\.rows\.length\)/);
});

test('a platform with no answerable permissions does not wedge the wizard', () => {
  // The failure this prevents: rows that can never be granted would leave
  // allRequiredGranted false forever, so Finish never unlocks.
  const linux = permissionsSummary({}, { platform: 'linux' });
  assert.deepEqual(linux.rows, []);
  assert.equal(linux.allRequiredGranted, true, 'nothing required is missing, so finishing is allowed');
});

test('Windows summary is empty, and says so rather than inventing rows', () => {
  const win = permissionsSummary(
    { screen: 'granted', automation: 'unknown' },
    { platform: 'win32' },
  );
  assert.deepEqual(win.rows, []);
  assert.equal(win.allRequiredGranted, true);
  assert.deepEqual(win.missingOptional, [], 'the rows are absent, not merely ungranted');
});

test('normalizePermission: granted vs needs-System-Settings vs promptable', () => {
  assert.equal(normalizePermission('screen', 'granted').granted, true);
  const denied = normalizePermission('automation', 'denied');
  assert.equal(denied.granted, false);
  assert.equal(denied.needsSystemSettings, true, 'denied requires a System Settings trip');
  const fresh = normalizePermission('screen', 'not-determined');
  assert.equal(fresh.granted, false);
  assert.equal(fresh.needsSystemSettings, false, 'not-determined can still be prompted');
  // missing/undefined status defaults to not-determined, not a crash
  assert.equal(normalizePermission('automation', undefined).status, 'not-determined');
});

test('permissionsSummary: nothing is required, so setup never blocks on a permission', () => {
  const D = { platform: 'darwin' };  // pin: these assertions are about the macOS row set
  const s1 = permissionsSummary({ screen: 'denied', automation: 'unknown' }, D);
  assert.equal(s1.allRequiredGranted, true);
  assert.deepEqual(s1.missingRequired, []);
  assert.deepEqual(s1.missingOptional.sort(), ['automation', 'screen']);

  // Even granting nothing at all must leave the wizard finishable. Every
  // permission left is a convenience: without screen recording the bot can't
  // share its whiteboard, without automation it can't spot an open Meet tab,
  // and it joins, speaks and listens either way.
  assert.equal(permissionsSummary({}, D).allRequiredGranted, true);
  assert.deepEqual(permissionsSummary({}, D).missingRequired, []);
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
