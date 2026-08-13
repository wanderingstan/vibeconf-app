// first-run-permission-prompts.test.mjs
//
// On a fresh install the app used to raise every macOS permission prompt it
// would ever need inside app.whenReady() — microphone, a screen-capture probe,
// and browser-automation AppleScript — all before the user had read a word of
// the setup wizard sitting underneath them. The wizard has a Permissions step
// that names each permission and why it's wanted; that is where the asking
// belongs.
//
// These are source assertions rather than behavioural ones because the failure
// is invisible in every environment we can automate: on a machine where the
// permissions are already granted, prompting costs nothing and looks identical
// to not prompting. It only shows up on someone's first install, which is
// exactly when we can't watch. So pin the shape of the code instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// Everything the wizard defers hangs off this one flag, so it has to stay tied
// to the same condition that decides whether the wizard is shown at all.
test('the wizard-pending flag is what gates showing the wizard', () => {
  assert.match(
    main,
    /const onboardingPending = isDefaultInstance && !store\.get\('onboardingComplete'\);\s*\n\s*if \(onboardingPending\) \{\s*\n\s*createOnboardingWindow\(\);/,
    'onboardingPending must BE the show-the-wizard condition, not a second copy of it that can drift',
  );
});

// Deferring the microphone prompt to the wizard was the first fix. Deleting it
// was the right one: testing showed nothing consumes the permission, so the
// wizard shouldn't offer the row either. See onboarding-flow.test.mjs for the
// evidence. This asserts the app cannot ask for mic or camera AT ALL.
test('nothing in the app ever asks for microphone, camera, or screen recording', () => {
  assert.doesNotMatch(main, /askForMediaAccess\(\s*['"]microphone['"]/);
  assert.doesNotMatch(main, /askForMediaAccess\(\s*['"]camera['"]/);
  const flow = readFileSync(join(root, 'electron-app/onboarding-flow.js'), 'utf8');
  const keys = [...flow.matchAll(/^\s*\{ key: '([a-z]+)'/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ['automation'], 'the wizard offers no mic/camera/screen row');
});

// The whiteboard share captures via Electron's own frame capture
// (webContents.mainFrame), never desktopCapturer, so there is nothing to probe
// or prompt for and no Screen Recording permission is needed at all.
test('the app never probes for Screen Recording permission', () => {
  assert.doesNotMatch(main, /getMediaAccessStatus\('screen'\)/);
  assert.doesNotMatch(main, /desktopCapturer\.getSources\(\{\s*\n?\s*types: \['screen'\]/);
});

test('Apple Events polling does not start under the wizard, and is not lost if setup is abandoned', () => {
  assert.match(main, /if \(!onboardingPending\) startMeetDetection\(\);\s*\n\s*else deferredStarts\.push\(startMeetDetection\);/);
  // Finishing the wizard is the happy path; closing it with the red X is not,
  // and must not leave the app without Meet detection until the next launch.
  const finish = main.slice(main.indexOf("ipcMain.handle('onboarding:finish'"));
  assert.match(finish.slice(0, 400), /runDeferredStarts\(\)/, 'finishing drains the deferred starts');
  assert.match(main, /onboardingWindow\.on\('closed', \(\) => \{[^}]*runDeferredStarts\(\)/, 'closing drains them too');
  // Draining twice must be harmless, since finishing also closes the window.
  assert.match(main, /function startMeetDetection\(\) \{\s*\n\s*if \(meetDetectionInterval\) return;/);
});

test('reading Automation status does not itself raise the Automation prompt', () => {
  // Unlike the media permissions there is no read-only status API: asking costs
  // an Apple Event, and the Apple Event IS the prompt. So the first look must
  // report unknown (which renders a Grant button) rather than probing.
  const h = main.slice(main.indexOf("ipcMain.handle('onboarding:get-permissions'"));
  assert.match(
    h.slice(0, 1400),
    /store\.get\('automationProbed'\) \? await probeBrowserAutomation\(\) : undefined/,
    'get-permissions must not probe before the user has ever been asked',
  );
  // undefined has to land on a row the user can act on, not one that claims denial.
  const { normalizePermission } = require('../electron-app/onboarding-flow.js');
  const row = normalizePermission('automation', undefined);
  assert.equal(row.granted, false);
  assert.equal(row.needsSystemSettings, false, 'unknown must offer Grant, not send them to System Settings');
});

test('the automation-probed flag is machine-level, like the permission it tracks', () => {
  // macOS grants Automation to the app bundle. A second profile has no separate
  // decision to make, so it must not ask again.
  const { isAppLevel } = require('../electron-app/config-scope.js');
  assert.equal(isAppLevel('automationProbed'), true);
});
