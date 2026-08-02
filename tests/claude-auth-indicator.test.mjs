// claude-auth-indicator.test.mjs — the sign-in check is warmed in advance and
// surfaced persistently, and never sits in front of a join (#137).
//
// Why the ordering matters: detectClaudeAuth spawns a LOGIN SHELL, because auth
// can come from environment variables and a GUI app has launchd's minimal env
// rather than the user's. A login shell sources .zprofile/.zshrc, so on a machine
// with nvm/conda/pyenv it costs seconds. Awaiting that before opening the agent's
// Terminal would put the slowest thing in the app in front of the most
// latency-sensitive thing it does — to report a once-ever setup step.
//
// Run: node --test tests/claude-auth-indicator.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');

test('the join path never awaits the auth check', () => {
  // The bug being prevented: `await detectClaudeAuth()` before the Terminal
  // spawns. It reads harmlessly and delays the window by however long the user's
  // shell profile takes.
  // Scoped to the join path: refreshClaudeAuth() awaits it legitimately, which
  // is the whole point — the cost is paid somewhere nobody is waiting.
  const fn = main.slice(main.indexOf('async function launchClaudeTerminal'));
  const block = fn.slice(0, fn.indexOf('buildTerminalCommand'));
  assert.doesNotMatch(block, /await detectClaudeAuth\(\)/,
    'the join path must read the cache, not pay for a login shell');
  assert.match(main, /if \(claudeAuthState\.authed === false\) notifyClaudeSignInNeeded\(\)/);
});

test('warnings fire only on an explicit false', () => {
  // Tri-state: null is "couldn't tell". A wrong "please sign in" shown to
  // someone already signed in teaches people the banner is noise, which costs
  // more than never warning.
  assert.doesNotMatch(main, /if \(!claudeAuthState\.authed\)/, 'null must not read as signed-out');
  assert.match(panelJs, /state\?\.authed === false/);
  assert.doesNotMatch(panelJs, /!state\?\.authed/, 'the panel must not treat unknown as signed-out');
});

test('the answer is warmed at startup and kept warm on a slow timer', () => {
  assert.match(main, /refreshClaudeAuth\(\)\.catch\(\(\) => \{\}\);/, 'warmed at startup, unawaited');
  assert.match(main, /const CLAUDE_AUTH_POLL_MS = 15 \* 60_000/);
  assert.match(main, /setInterval\(\(\) => \{ refreshClaudeAuth\(\)\.catch/);
  // unref so a background poll can't hold the process open at quit.
  assert.match(main, /claudeAuthTimer\.unref/);
});

test('on-demand refreshes are throttled', () => {
  // Window focus is user-triggered and fires in bursts when someone alt-tabs.
  // Without a floor, each one would spawn a login shell.
  assert.match(main, /const CLAUDE_AUTH_FOCUS_MAX_AGE_MS = 60_000/);
  assert.match(main, /refreshClaudeAuth\(\{ maxAgeMs: CLAUDE_AUTH_FOCUS_MAX_AGE_MS \}\)/);
  assert.match(main, /if \(maxAgeMs && Date\.now\(\) - claudeAuthState\.checkedAt < maxAgeMs\) return claudeAuthState/);
});

test('a connected agent counts as proof, and clears the indicator at once', () => {
  // An agent that reached us has DEMONSTRATED sign-in — better evidence than the
  // CLI's own answer. It also lands the instant the user finishes the login we
  // asked for, so the banner clears then rather than up to 15 minutes later.
  const mark = main.slice(main.indexOf('function markClaudeReady'));
  const body = mark.slice(0, mark.indexOf('\n}'));
  assert.match(body, /claudeAuthState = \{ authed: true, method: 'proven'/);
  assert.match(body, /broadcastClaudeAuth\(\)/);
  // And the refresh short-circuits rather than spending a shell to re-learn it.
  assert.match(main, /if \(claudeReady\) \{[\s\S]{0,200}authed: true, method: 'proven'/);
});

test('the panel carries the state persistently, not as a one-shot dialog', () => {
  assert.match(panelHtml, /id="claudeAuthBanner"/);
  assert.match(panelJs, /api\.on\('claude-auth-changed', paintClaudeAuth\)/, 'pushed updates');
  assert.match(panelJs, /window\.addEventListener\('focus', \(\) => refreshClaudeAuthBanner\(true\)\)/);
  // No dismiss control: this is a live state, and a dismissable banner would go
  // away while the problem stayed.
  const banner = panelHtml.slice(panelHtml.indexOf('id="claudeAuthBanner"'));
  assert.doesNotMatch(banner.slice(0, 600), /dismiss|×|close/i);
});
