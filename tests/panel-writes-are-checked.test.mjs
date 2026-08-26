// panel-writes-are-checked.test.mjs — the settings pane may not fail silently.
//
// #557. Every write from the bot-settings pane used to be fire-and-forget:
//
//     dangerousModeInput.addEventListener('change', () => {
//       api.invoke('set-config', 'dangerousMode', dangerousModeInput.checked);
//     });
//
// No await, no catch. A rejected invoke there is an unhandled promise rejection
// in the renderer — nothing logged, nothing shown — and the control still LOOKS
// correct afterwards, because a checkbox reflects its own DOM state whether or
// not anything reached disk.
//
// Observed live 2026-08-26 on the cloud-TA box: emojiSet, dangerousMode and the
// personality file all read back as saved in the pane and none of them ever
// reached the store. `set_preference` over the local-server API wrote fine
// throughout, so the store, the disk and the IPC handler were never at fault.
// It cost ~40 minutes of a pre-demo hour, and the only way to find out was to
// stat the file on the box.
//
// Source assertions rather than a live renderer: panel.js needs a DOM, a
// preload bridge and a live main process to run at all. Same style as
// calendar-event-context.test.mjs.
//
// Run: node --test tests/panel-writes-are-checked.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// The helper's own call, and the cautionary example in its doc comment, are the
// only two places the raw channel name may still appear.
const ALLOWED_RAW_INVOKES = 2;

test('no bare fire-and-forget set-config remains — they all go through setConfig', () => {
  const raw = panel.match(/api\.invoke\('set-config'/g) || [];
  assert.equal(raw.length, ALLOWED_RAW_INVOKES,
    `every set-config must go through setConfig(); found ${raw.length} raw uses `
    + `(expected only the helper itself and its doc-comment example)`);
  // And the wrapper is actually used, in quantity — this pane has ~20 writes.
  const wrapped = panel.match(/setConfig\(/g) || [];
  assert.ok(wrapped.length > 15,
    `expected the pane's writes to be routed through setConfig, saw ${wrapped.length}`);
});

test('setConfig catches, rather than leaving an unhandled rejection', () => {
  const i = panel.indexOf('async function setConfig(key, value)');
  assert.ok(i > 0, 'setConfig exists');
  const body = panel.slice(i, i + 400);
  assert.match(body, /await api\.invoke\('set-config', key, value\)/, 'it awaits the call');
  assert.match(body, /catch/, 'and catches the rejection');
  assert.match(body, /reportSettingFailure\(/, 'and reports it rather than swallowing it');
});

test('a failed write is reported to the user, the console AND the main process', () => {
  const i = panel.indexOf('function reportSettingFailure');
  assert.ok(i > 0, 'reportSettingFailure exists');
  const body = panel.slice(i, i + 500);
  assert.match(body, /console\.error/, 'renderer console');
  assert.match(body, /api\.send\('renderer-error'/, 'main process, so it reaches the session log');
  assert.match(body, /showSettingsError\(/, 'and the human looking at the pane');
});

test('main logs renderer-error, so a headless box leaves a trace', () => {
  assert.match(main, /ipcMain\.on\('renderer-error'/,
    'without this the panel shouts into a void on a machine nobody is sitting at');
  const i = main.indexOf("ipcMain.on('renderer-error'");
  assert.match(main.slice(i, i + 400), /console\.warn/, 'and it actually writes a line');
});

test('the error banner does not clear itself', () => {
  const i = panel.indexOf('function showSettingsError');
  const body = panel.slice(i, i + 900);
  assert.doesNotMatch(body, /setTimeout/,
    'a self-clearing error is how the original "Save failed" went unnoticed');
});

test('the personality save surfaces WHY it failed, not just that it did', () => {
  const i = panel.indexOf("api.invoke('save-agent-claudemd'");
  assert.ok(i > 0);
  const body = panel.slice(i, i + 900);
  assert.doesNotMatch(body, /catch\(\(\) => \(\{ ok: false \}\)\)/,
    'the old catch threw away every cause');
  assert.match(body, /err && err\.message/, 'the real message is kept');
  assert.match(body, /reportSettingFailure\(/, 'and routed through the same reporting path');
});

test('only the success message self-clears, never the failure', () => {
  const i = panel.indexOf("api.invoke('save-agent-claudemd'");
  const body = panel.slice(i, i + 900);
  const timeout = body.indexOf('setTimeout');
  assert.ok(timeout > 0, 'success still clears itself');
  assert.match(body.slice(Math.max(0, timeout - 120), timeout), /r\?\.ok/,
    'the self-clear must be gated on success');
});
