// auth-broadcast.test.mjs — signing in must update every window that shows
// sign-in state, not just the main panel.
//
// The bug: `auth-changed` was sent to panelView only. Signing in from App
// Settings updated the main window's footer while the settings window you were
// actually looking at went on saying you were signed out. Both renderers already
// had listeners; only one was ever sent to — so this read as a broken login
// rather than a missing message.
//
// Same family as #190/#143 (the panel showing a boot-time config snapshot): the
// state was right, the window just never heard about it.
//
// Run: node --test tests/auth-broadcast.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

// Comment-stripped, so prose about the old behaviour can't satisfy or break the
// checks below.
const code = main.replace(/^\s*\/\/.*$/gm, '');

test('auth changes go through one broadcast, not per-window sends', () => {
  assert.match(code, /function broadcastAuthChanged\(\)/);
  // The bug shape: a direct send to a single window. If this reappears, some
  // window is being updated and the others silently are not.
  assert.doesNotMatch(code, /panelView\.webContents\.send\('auth-changed'\)/,
    "send via broadcastAuthChanged so every window is covered");
});

test('every window that displays sign-in state is a target', () => {
  // #229 moved the target list out of this function and into ONE registry, so
  // follow it there. The point is unchanged: a window showing sign-in state must
  // be told. The old hand-kept list was already missing the pop-outs, which load
  // panel.html and register the very same 'auth-changed' listener.
  assert.match(code, /function broadcastAuthChanged\(\) \{[\s\S]{0,400}?broadcastToRenderers\('auth-changed'\)/);
  const reg = code.slice(code.indexOf('function rendererWindows()'));
  const body = reg.slice(0, reg.indexOf('\n}'));
  for (const w of ['panelView', 'appSettingsWindow', 'onboardingWindow',
                   'brainWindow', 'troubleshootingWindow', 'panelPopoutWindow']) {
    assert.ok(body.includes(w), `${w} is a renderer and must be in the registry`);
  }
  // meetView is deliberately NOT a renderer target: its sends are page-injection
  // commands where the destination is part of the meaning.
  assert.ok(!body.includes('meetView'), 'meetView stays addressed, not broadcast');
});

test('both login and logout use it', () => {
  // Logout has the same failure mode in reverse: signing out would leave the
  // settings window claiming you were still signed in.
  const calls = code.match(/broadcastAuthChanged\(\)/g) || [];
  assert.ok(calls.length >= 3, `expected the definition plus both call sites, got ${calls.length}`);
});

test('a destroyed window cannot break the broadcast', () => {
  // These are user-closable windows, so any of them may be gone mid-broadcast.
  // One dead window must not stop the others being told. Now guarded once, in
  // the shared helper, instead of once per hand-written fan-out.
  const fn = code.slice(code.indexOf('function broadcastToRenderers('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  // Both checks must be present: the WINDOW may be destroyed, and the window can
  // also outlive its webContents. Matched on the invariant rather than on one
  // spelling of it — `w.webContents.isDestroyed()` and `const wc = w.webContents;
  // wc.isDestroyed()` are the same guard.
  assert.match(body, /w\.isDestroyed\?\.\(\)|w\.isDestroyed\(\)/, 'the window itself');
  assert.match(body, /(wc|webContents)\.isDestroyed\(\)/, 'the view can outlive its webContents');
  assert.match(body, /try \{/, 'and a throw must not abort the remaining targets');
  assert.match(body, /continue;/, 'skip the dead one, keep going');
});
