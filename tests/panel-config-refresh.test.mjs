// panel-config-refresh.test.mjs — the panel must show what is actually stored (#190, #143).
//
// The bug: the panel read config ONCE at startup and never again, so it showed a
// boot-time snapshot forever. Anything written afterwards — the onboarding
// wizard, an agent's set_preference, another window — left the controls stale.
//
// That produced a convincing illusion of data loss. Someone named their bot in
// the wizard, saw "Unnamed bot" in Bot Settings, and reasonably concluded the
// save had failed. It hadn't: the value was stored correctly and the bot used it
// in calls. Only the panel was wrong.
//
// The same shape was reported in #143 for emojiSet changed mid-call: the change
// took effect on the virtual camera, and the settings page kept showing the old
// value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

test('the config load is a function, not a one-shot call', () => {
  // It has to be re-runnable — that is the entire fix.
  assert.match(panel, /function loadConfigIntoControls\(\)/);
  assert.match(panel, /^loadConfigIntoControls\(\);$/m, 'still runs at startup');
});

test('the panel re-reads when config changes', () => {
  assert.match(panel, /message\?\.action !== 'config-updated'/);
  assert.match(panel, /loadConfigIntoControls\(\)/);
});

test('BOTH write paths notify the panel', () => {
  // Previously only applyPref's botName branch sent this — and see the next test
  // for why even that did nothing. The wizard writes through set-config, which
  // told the panel nothing at all.
  assert.match(main, /function notifyConfigChanged\(key, value\)/);
  const setConfig = main.slice(main.indexOf("ipcMain.handle('set-config'"));
  assert.match(setConfig.slice(0, 600), /notifyConfigChanged\(key, value\)/, 'set-config (wizard, panel)');
  const applyPref = main.slice(main.indexOf('applyPref: (key, value) => {'));
  assert.match(applyPref.slice(0, 600), /notifyConfigChanged\(key, value\)/, 'applyPref (agent set_preference)');
});

test('the notification is not limited to one key', () => {
  // The old code only ever announced botName, so every other pref the panel
  // displays was invisible to it. Both callers now fire for whatever changed.
  const applyPref = main.slice(main.indexOf('applyPref: (key, value) => {'));
  const body = applyPref.slice(0, applyPref.indexOf("} else if (key === 'studioSound')"));
  assert.ok(!/action: 'config-updated'/.test(body),
    "the botName-only broadcast should be gone — notifyConfigChanged covers every key");
});

test('a re-read never repaints under the user', () => {
  // A re-read rewrites EVERY control, including the ack-phrase textareas. Without
  // this, changing the emoji dropdown would echo back and could wipe a half-typed
  // phrase in a different field.
  const fn = panel.slice(panel.indexOf("message?.action !== 'config-updated'"));
  const body = fn.slice(0, fn.indexOf('\n});'));
  assert.match(body, /document\.activeElement/);
  assert.match(body, /INPUT|TEXTAREA|SELECT/);
  assert.match(body, /if \(editing\) return;/);
});

test('the panel also catches up when the window regains focus', () => {
  // The wizard and App Settings are separate windows, and an agent can write at
  // any time — including while the panel is in the background, where it would
  // never see the message-driven refresh land in a useful order.
  assert.match(panel, /window\.addEventListener\('focus', \(\) => \{ loadConfigIntoControls\(\); \}\)/);
});

test('re-reading everything, rather than applying the payload', () => {
  // A targeted update needs a key → control mapping, and that mapping rots
  // silently as prefs are added: the pref still saves, the control still shows
  // the old value, and it looks exactly like this bug all over again.
  const fn = panel.slice(panel.indexOf("message?.action !== 'config-updated'"));
  const body = fn.slice(0, fn.indexOf('\n});'));
  assert.ok(!/payload\.(key|value)/.test(body), 'should not branch on which key changed');
});
