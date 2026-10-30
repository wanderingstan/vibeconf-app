// slack-switch-device.test.mjs: the "You're in this huddle on a different
// device" modal must be dismissed in BOTH Slack surfaces. It used to render only
// in the huddle popup; Slack now also shows it over the channel (main view) right
// after the Huddle click, where nothing clicked it, so a bot Slack still counted
// in the huddle (a killed test bot, say) could never rejoin.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../electron-app/slack-surface.js', import.meta.url), 'utf8');
const clicks = (target) =>
  new RegExp(`clickButtonByTextRepeating\\(${target}, 'Switch to this device'`).test(src);

test('popup: clicks "Switch to this device"', () => {
  assert.ok(clicks('win\\.webContents'));
});

test('main view: clicks "Switch to this device" on every page load', () => {
  assert.ok(clicks('view\\.webContents'));
  const loadHandlers = src.split("view.webContents.on('did-finish-load'").slice(1);
  assert.ok(loadHandlers.some((h) => /^[\s\S]*?\n {2}\}\);/.exec(h)[0].includes("'Switch to this device'")),
    'the main-view clicker must be re-armed in a did-finish-load handler');
});

// The clickers run on page timers, which Chromium throttles to about once a
// minute in a hidden view. Both Slack surfaces are hidden on a bot, so both opt
// out, as Meet's view does (#424).
test('neither Slack surface is background-throttled', () => {
  assert.match(src, /preload-slack-main\.js'[\s\S]{0,400}backgroundThrottling: false/);
  assert.match(src, /preload-slack-huddle\.js'[^}]*backgroundThrottling: false/);
});
