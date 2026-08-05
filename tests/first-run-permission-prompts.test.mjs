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

test('the microphone prompt is skipped while the wizard is up', () => {
  // The status READ is fine and should stay — getMediaAccessStatus never
  // prompts, and the local server reports it. It's askForMediaAccess that
  // raises the dialog.
  const block = main.slice(main.indexOf("// Request microphone permission"));
  const guard = block.slice(0, block.indexOf('askForMediaAccess'));
  assert.match(guard, /!onboardingPending/, 'the mic ask must be behind the wizard-pending guard');
});

test('the screen-capture probe is skipped while the wizard is up', () => {
  const i = main.indexOf("Deferring screen-capture probe");
  assert.ok(i > 0, 'expected an explicit deferral branch for the screen probe');
  const branch = main.slice(main.lastIndexOf('if (', i), i);
  assert.match(branch, /onboardingPending/);
  // The denied case pops a BLOCKING showMessageBoxSync. On first run that is a
  // modal telling the user to go to System Settings for a feature they have not
  // heard of yet, so it must be inside the same deferral, not just the probe.
  const after = main.slice(i, i + 2000);
  assert.ok(
    after.indexOf('showMessageBoxSync') > after.indexOf('} else if'),
    'the blocking permission dialog must sit in a later branch, i.e. also deferred',
  );
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
