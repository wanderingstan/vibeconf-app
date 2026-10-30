// active-platform.test.mjs — one value says which platform's view is up.
//
// Phase 1, step 1 of the calling-library extraction: main.js had four flags
// (slackProviderMode, zoomProviderMode, teamsProviderMode, callingAppMode) for
// "which kind of view is loaded". Every provider switch had to clear the other
// three, and _openMeetInFreshView cleared only zoom/teams/calling: a Meet call
// started straight after Slack (supervisor join, summoned call, --meet-url,
// guest fallback) kept slackProviderMode set, so its mic/camera/chat/share
// commands went to the stale Slack huddle popup. One activePlatform value
// can't disagree with itself.
//
// Run: node --test tests/active-platform.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const body = (fn) => {
  const start = main.indexOf('function ' + fn + '(');
  assert.ok(start >= 0, fn + ' exists');
  return main.slice(start, main.indexOf('\nfunction ', start + 10));
};

test('the four mode flags are gone', () => {
  for (const flag of ['slackProviderMode', 'zoomProviderMode', 'teamsProviderMode']) {
    assert.doesNotMatch(main, new RegExp('\\b' + flag + '\\s*=[^=]'), flag + ' is still assigned');
  }
  assert.doesNotMatch(main, /\bcallingAppMode\s*=\s*(null|app)\b/, 'callingAppMode is still assigned as a flag');
  assert.match(main, /^let activePlatform = 'meet';$/m);
});

test('each provider switch names its own platform', () => {
  // Phase 1 step 3: every switch goes through activatePlatform(id), the one
  // place activePlatform moves; _openMeetInFreshView rebuilds Meet's own view.
  const want = {
    activateMeetProvider: "activatePlatform('meet'",
    activateSlackProvider: "activatePlatform('slack'",
    activateTeamsProvider: "activatePlatform('teams'",
    activateZoomProvider: "activatePlatform('zoom'",
    activateCallingAppStandby: 'activatePlatform(app',
    activatePlatform: 'activePlatform = id;',
    _openMeetInFreshView: "activePlatform = 'meet'",
  };
  for (const [fn, line] of Object.entries(want)) assert.ok(body(fn).includes(line), `${fn} has ${line}`);
});

test('a fresh Meet view drops a leftover Slack surface', () => {
  const b = body('_openMeetInFreshView');
  const at = b.indexOf("activePlatform = 'meet'");
  assert.ok(at >= 0);
  assert.ok(b.slice(at, at + 200).includes('slackSurface = null'), 'Meet must not inherit the Slack popup handle');
});

test('only a live Slack view routes commands to the huddle popup', () => {
  assert.match(body('callCmdWC'), /activePlatform === 'slack' && slackSurface && SLACK_POPUP_CMDS\.has\(name\)/);
});

test('the panel name and the calling app come from the same value', () => {
  assert.match(body('activeProviderName'), /return activePlatform;/);
  assert.match(body('callingApp'), /CALLING_APP_PLATFORMS\.has\(activePlatform\) \? activePlatform : null/);
  // The set has to match the apps that have a standby.
  const order = main.match(/const CALLING_APP_ORDER = \[([^\]]+)\]/)[1].replace(/['\s]/g, '').split(',').sort();
  const set = main.match(/const CALLING_APP_PLATFORMS = new Set\(\[([^\]]+)\]\)/)[1].replace(/['\s]/g, '').split(',').sort();
  assert.deepEqual(set, order);
});
