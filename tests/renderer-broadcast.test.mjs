// renderer-broadcast.test.mjs — #229: a window with the right listener must not
// be unable to hear an event.
//
// Main-process events were addressed to a NAMED window (`panelView.webContents
// .send('auth-changed')`), so a renderer could register a perfectly correct
// listener and never receive anything. Nothing errors. The state is right, the
// window just never hears about it — which presents as a broken FEATURE rather
// than a missing message, and is why each instance cost its own debugging
// session: #190, #143, the App Settings sign-in state, and #254, where teardown
// waited on a reply from a window that was never asked and wedged the app.
//
// These pin the fix's shape: ONE registry of renderer windows, and events that
// mean "the app's state changed" go to all of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
// Comments stripped for the "no direct send" checks below: the helper's own docs
// quote the anti-pattern it replaced, and an example inside a comment is not a
// call site.
const mainCode = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const registryBody = (() => {
  const fn = main.slice(main.indexOf('function rendererWindows()'));
  return fn.slice(0, fn.indexOf('\n}'));
})();

test('renderer windows are enumerated in exactly one place', () => {
  // The issue's ask: "a test that a new window is registered in one place rather
  // than in N call sites."
  assert.ok(registryBody, 'rendererWindows() must exist');
  assert.equal((main.match(/function rendererWindows\(\)/g) || []).length, 1);
  assert.match(main, /function broadcastToRenderers\(channel, \.\.\.args\)/);
});

test('the pop-outs are in it — they load panel.html and had been getting nothing', () => {
  // brainWindow and troubleshootingWindow load panel.html?screen=<name>, so they
  // register EVERY listener panel.js has, and received none of the ~32 sends
  // addressed to panelView. That is the same bug, already shipped, just quiet.
  for (const w of ['brainWindow', 'troubleshootingWindow', 'panelPopoutWindow']) {
    assert.ok(registryBody.includes(w), `${w} is a renderer and must be registered`);
  }
  // And the renderer already guards per-screen, which is what makes broadcasting
  // safe rather than noisy.
  assert.match(panel, /IS_POPOUT_WINDOW/);
  assert.match(panel, /screen=/);
});

test('meetView stays addressed, because its sends are commands', () => {
  // ~33 sends telling the injected page to DO something (set the emoji set,
  // start a share, apply a caption language). The destination is part of the
  // meaning there, so broadcasting them would be wrong, not merely wasteful.
  assert.ok(!registryBody.includes('meetView'));
  assert.ok((main.match(/meetView\.webContents\.send\(/g) || []).length > 20,
    'meetView still has its own addressed sends');
});

test('claude-ready is broadcast, not hand-written per window', () => {
  // This was the tell in the issue: the fix for claude-ready had been to write
  // the same send three times, one per window. Correctness by remembering.
  assert.match(main, /broadcastToRenderers\('claude-ready', true\)/);
  const sends = mainCode.match(/\.webContents\.send\('claude-ready'/g) || [];
  assert.equal(sends.length, 0, 'no direct per-window claude-ready sends may come back');
});

test('auth-changed is broadcast, and no direct send can reappear', () => {
  assert.match(main, /broadcastToRenderers\('auth-changed'\)/);
  const direct = mainCode.match(/\.webContents\.send\('auth-changed'/g) || [];
  assert.equal(direct.length, 0, 'sign-in state must never be told to one window');
});

test('one dead window cannot stop the others being told', () => {
  // Every window here is user-closable, so any of them may be gone mid-broadcast.
  const fn = main.slice(main.indexOf('function broadcastToRenderers('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /try \{/);
  assert.match(body, /continue;/);
  assert.match(body, /(wc|webContents)\.isDestroyed\(\)/,
    'a window can outlive its webContents');
});

// --- the full sweep -------------------------------------------------------
// The helper alone wasn't the fix; it was the mechanism. These pin the actual
// classification of all 23 channels main sends to a renderer.
const COMMANDS = [
  'leave-requested',        // panel replies 'leave-meet' → teardown would run 3×
  'new-bot',                // would create three bots
  'menu-call-now',          // would start three calls
  'show-settings',          // navigates the MAIN panel; a pop-out jumping is wrong
  'basic-auth-prompt',      // expects exactly ONE reply per request id
  'navigate-webview-prompt', // would prompt three times per menu click
];

test('every state channel broadcasts, so any window rendering it updates', () => {
  const STATE = ['avatar-emoji', 'bot-view-changed', 'bot-view-visible', 'call-failed',
    'call-status-changed', 'caption-feed', 'caption-state', 'claude-auth-changed',
    'extension-message', 'meet-detected', 'meet-mode-changed', 'meet-status',
    'panel-popout-changed', 'share-window-state', 'slack-huddle-detected',
    'claude-ready', 'auth-changed'];
  for (const ch of STATE) {
    assert.ok(mainCode.includes(`broadcastToRenderers('${ch}'`), `${ch} should broadcast`);
    assert.ok(!mainCode.includes(`panelView.webContents.send('${ch}'`),
      `${ch} must not also be sent to one window`);
  }
});

test('commands stay addressed, and say why', () => {
  // Broadcasting these would cause N actions for one intent. Each carries its
  // reason inline, because the next person will otherwise "finish the job".
  for (const ch of COMMANDS) {
    assert.ok(mainCode.includes(`panelView.webContents.send('${ch}'`),
      `${ch} is a command and must stay addressed`);
    assert.ok(!mainCode.includes(`broadcastToRenderers('${ch}'`), `${ch} must not broadcast`);
    const i = main.indexOf(`panelView.webContents.send('${ch}'`);
    assert.match(main.slice(Math.max(0, i - 420), i), /ADDRESSED, not broadcast \(#229\)/,
      `${ch} needs the reason recorded above its send`);
  }
});

test('no broadcast is gated on one window being alive', () => {
  // The trap when converting: wrapping a fan-out in `if (panelView && ...)`
  // means "tell everyone, but only while the main panel happens to exist".
  // Introduced and caught during the sweep itself.
  const gated = main.split('\n').map((l, i, arr) => {
    if (!l.includes('broadcastToRenderers(')) return null;
    const before = arr.slice(Math.max(0, i - 3), i).join('\n');
    return /if \(panelView && !panelView\.webContents\.isDestroyed\(\)\)/.test(before) ? i + 1 : null;
  }).filter(Boolean);
  assert.deepEqual(gated, [], `broadcasts gated on panelView at line(s) ${gated}`);
});
