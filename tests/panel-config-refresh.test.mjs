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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

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
  // Slice each handler's own body rather than a fixed number of characters —
  // the assertion is "this handler notifies", and a fixed window turns any
  // comment added above the call into a failing test about nothing.
  const body = (from) => {
    const rest = main.slice(main.indexOf(from));
    return rest.slice(0, rest.indexOf('\n  },') + 1 || rest.indexOf('\n  });') + 1);
  };
  assert.match(body("ipcMain.handle('set-config'"), /notifyConfigChanged\(key, value\)/, 'set-config (wizard, panel)');
  assert.match(body('applyPref: (key, value) => {'), /notifyConfigChanged\(key, value\)/, 'applyPref (agent set_preference)');
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

// --- the realtime voice toggle (EXPERIMENT) ---------------------------------
//
// This is the ONLY way a tester turns a bot into a realtime bot. It is a
// per-profile preference, and App Settings renders app-level prefs only
// (get-app-settings-schema filters on isAppLevel), so without this control it
// would be reachable only through set_preference or by hand-editing config.json
// — which is not something you hand to a tester.

test('the realtime toggle is readable, writable, and re-read like every other control', () => {
  assert.match(panel, /getElementById\('realtimeVoice'\)/, 'the control is bound');

  // In the get-config list, or it renders unchecked no matter what is stored —
  // which is the exact stale-control bug this file exists for, on a setting
  // whose whole job is to be visible.
  const load = panel.slice(panel.indexOf('function loadConfigIntoControls()'));
  const body = load.slice(0, load.indexOf('\n}'));
  assert.match(body, /'realtimeVoice'/, "must be requested in loadConfigIntoControls' get-config");
  assert.match(body, /realtimeVoiceInput\.checked = !!result\?\.realtimeVoice/, 'and applied to the control');

  assert.match(panel, /realtimeVoiceInput\?\.addEventListener\('change'[\s\S]{0,200}setConfig\('realtimeVoice'/,
    'and written back on change');
});

test('the toggle sits above the voice picker it overrides', () => {
  // A realtime bot never calls ElevenLabs, so a voice chosen below this would
  // silently not be the voice you hear. Ordering is the only thing that says so
  // before the fact.
  const html = readFileSync(new URL('../electron-app/renderer/panel.html', import.meta.url), 'utf8');
  const toggle = html.indexOf('id="realtimeVoice"');
  const picker = html.indexOf('id="unifiedVoice"');
  assert.ok(toggle > 0 && picker > 0, 'both controls exist');
  assert.ok(toggle < picker, 'the realtime toggle must come first');
});

test('there is one Voice control, and it follows the mode', () => {
  // A realtime bot never calls ElevenLabs. Showing both pickers at once offers
  // a choice that will not be used, which is how somebody picks a voice, hears
  // a different one, and reasonably reports it as broken.
  assert.match(panel, /unifiedVoiceField/, 'the ElevenLabs field is addressable');
  const paint = panel.slice(panel.indexOf('function paintRealtimeVoiceField'));
  const body = paint.slice(0, paint.indexOf('\n}'));
  assert.match(body, /realtimeVoiceNameField\.style\.display = realtime \? '' : 'none'/);
  assert.match(body, /unifiedVoiceField\.style\.display = realtime \? 'none' : ''/,
    'the ElevenLabs picker must hide when realtime is on');

  // And it has to repaint when the toggle moves, not only on load.
  assert.match(panel, /realtimeVoiceInput\?\.addEventListener\('change'[\s\S]{0,200}paintRealtimeVoiceField\(\)/);
});

test('an unknown voice name falls back rather than killing the session', () => {
  // A name the API does not know 400s the whole mint, which presents as "the
  // bot has no voice at all" for what is really a typo.
  const { resolveRealtimeConfig } = require('../electron-app/realtime-session.js');
  const store = (o) => ({ get: (k) => o[k] });
  const bad = resolveRealtimeConfig({ store: store({ realtimeVoice: true, realtimeApiKey: 'k', realtimeVoiceName: 'nova' }) });
  assert.equal(bad.voice, 'cedar', 'falls back to the default');
  assert.equal(bad.voiceFallback, 'nova', 'and says what it ignored, so the warning can name it');
});
