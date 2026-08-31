// settings-flush-on-close.test.mjs — #628: a typed setting is lost if the
// window is closed while the field still has focus.
//
// Text inputs commit on 'change', and 'change' fires only on blur or Enter. ⌘W
// straight after typing destroys the window with the edit still only in the
// DOM — silently, and looking exactly like a successful save.
//
// Needs a real BrowserWindow to exercise, so the wiring is pinned by source
// assertions. The properties that matter are: something remembers the unsaved
// value, the close waits for it, and the wait is BOUNDED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = fs.readFileSync(join(root, 'electron-app/renderer/app-settings.js'), 'utf8');
const main = fs.readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const settingsClose = (() => {
  const i = main.indexOf("appSettingsWindow.on('close'");
  return main.slice(i, main.indexOf("appSettingsWindow.on('closed'", i));
})();

test('every text field remembers what is unsaved', () => {
  // Both text paths — the <select> and the free-text input — plus the TTS key.
  const inputs = [...renderer.matchAll(/addEventListener\('input',/g)];
  assert.ok(inputs.length >= 3, `expected each editable field to track: found ${inputs.length}`);
  assert.match(renderer, /const _pending = new Map\(\)/);
});

test('a committed value stops being pending', () => {
  // Otherwise the flush re-writes settled values on every close — harmless but
  // noisy, and it would mask a genuinely failing write.
  assert.match(renderer, /function commitNow\([^)]*\) \{ _pending\.delete/);
  assert.match(renderer, /_pending\.delete\('__ttsApiKey'\)/);
});

test('the flush answers, always — even when a write throws', () => {
  // main is holding the window open waiting for this. A flush that throws
  // before replying would trap the settings window on screen, which is a worse
  // bug than the one being fixed.
  const i = renderer.indexOf("api.on('flush-settings'");
  const handler = renderer.slice(i, i + 700);
  assert.match(handler, /try \{/);
  assert.match(handler, /catch \{/);
  const send = handler.indexOf("api.send('settings-flushed')");
  const cat = handler.indexOf('catch {');
  assert.ok(send > cat, 'the reply must be AFTER the catch, so it happens either way');
});

test('the TTS key goes through its own channel, not set-config', () => {
  // It is the worst field to lose — pasted, long, secret, nothing to retype
  // from — and it is saved by a different handler.
  assert.match(renderer, /__ttsApiKey/);
  const i = renderer.indexOf("api.on('flush-settings'");
  const handler = renderer.slice(i, i + 700);
  assert.match(handler, /update-tts-config/);
});

test('the close waits for the flush', () => {
  assert.match(settingsClose, /e\.preventDefault\(\)/);
  assert.match(settingsClose, /send\('flush-settings'\)/);
  assert.match(settingsClose, /ipcMain\.once\('settings-flushed'/);
});

test('and the wait is BOUNDED — the window always closes', () => {
  // A settings window that refuses to shut because a write is wedged is worse
  // than a lost keystroke.
  assert.match(settingsClose, /setTimeout\(/);
  const m = settingsClose.match(/\}, (\d+)\);/);
  assert.ok(m, 'the timeout needs a literal duration');
  assert.ok(Number(m[1]) <= 2000, `${m[1]}ms is too long to hold a window on a local IPC`);
  // And the timeout path must actually close, not merely log.
  const timeoutBlock = settingsClose.slice(settingsClose.indexOf('setTimeout('));
  assert.match(timeoutBlock, /finish\(\)/);
});

test('closing is idempotent — no recursion, no double-close', () => {
  // finish() calls close() again, which re-enters this same handler. Without a
  // guard that is an infinite loop; with a guard it is one clean close.
  assert.match(settingsClose, /if \(settingsFlushed/, 'guard on re-entry');
  assert.match(settingsClose, /settingsFlushed = true;/);
  const finish = settingsClose.slice(settingsClose.indexOf('const finish'));
  assert.ok(finish.indexOf('settingsFlushed = true') < finish.indexOf('.close()'),
    'set the flag BEFORE closing, or the re-entrant call preventDefaults again');
  assert.match(settingsClose, /removeListener\('settings-flushed'/, 'no listener left behind');
});

test('a destroyed window is not asked to flush', () => {
  assert.match(settingsClose, /isDestroyed\(\)/);
  assert.match(settingsClose, /try \{ appSettingsWindow\.webContents\.send/, 'send can throw on teardown');
});
