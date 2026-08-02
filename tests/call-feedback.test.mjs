// call-feedback.test.mjs — one-click "that was wrong" markers in the session log,
// and the two-column troubleshooting layout they sit above.
//
// The point of the buttons is the TIMESTAMP. Bot misbehaviour is nearly
// impossible to report after the fact — "it kept interrupting" locates nothing —
// but a marker dropped at the moment sits in the session log beside the
// captions, turn state and agent activity for that second, which is enough to
// reconstruct what happened.
//
// Run: node --test tests/call-feedback.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const panelCss = readFileSync(join(root, 'electron-app/renderer/panel.css'), 'utf8');

const tsScreen = panelHtml.slice(
  panelHtml.indexOf('id="troubleshootingScreen"'),
  panelHtml.indexOf('<!-- Persistent footer'),
);

test('the reported behaviours are all present', () => {
  for (const kind of ['interrupting', 'too-timid', 'not-yielding', 'inactive', 'other']) {
    assert.ok(tsScreen.includes(`data-feedback="${kind}"`), `missing feedback button: ${kind}`);
  }
  // "other" matters as much as the named ones: without it, anything unanticipated
  // goes unreported, which is exactly the class of bug worth hearing about.
  assert.ok(tsScreen.includes('data-feedback="other"'));
});

test('a click costs one action and never blocks the call', () => {
  // These are pressed mid-call. A dialog, a confirmation step or a text field
  // would mean the moment is gone before it is recorded.
  const handler = panelJs.slice(panelJs.indexOf("document.querySelectorAll('[data-feedback]')"));
  const body = handler.slice(0, 1200);
  assert.doesNotMatch(body, /confirm\(|prompt\(|showMessageBox/, 'no dialog on the click path');
  assert.match(body, /\.catch\(/, 'a failed write must not surface as an error mid-call');
  // Visible confirmation, since a silent button leaves you unsure it registered.
  assert.match(body, /classList\.add\('logged'\)/);
});

test('the log line is greppable and carries the call context', () => {
  const h = main.slice(main.indexOf("ipcMain.handle('call-feedback'"));
  const body = h.slice(0, 1200);
  assert.match(body, /\[feedback\]/, 'a stable prefix is what makes it findable in a busy log');
  for (const field of ['kind=', 'status=', 'room=', 'call=']) {
    assert.ok(body.includes(field), `the marker needs ${field} to be reconstructable`);
  }
  // Never throws: clicked during a live call.
  assert.match(body, /catch \(err\)/);
  assert.match(body, /String\(kind \|\| 'unspecified'\)\.slice\(0, 40\)/, 'renderer input is bounded');
});

test('feedback goes through a single handler', () => {
  // It is meant to reach the AGENT later so it can adjust mid-call. That should
  // be an addition inside this handler, not a second route with its own format.
  const count = (main.match(/\[feedback\]/g) || []).length;
  assert.ok(count <= 2, `expected one log site (plus its failure path), saw ${count}`);
});

test('the troubleshooting screen is two columns, and degrades to one', () => {
  assert.match(tsScreen, /class="ts-cols"/);
  assert.match(panelCss, /\.ts-cols \{[^}]*grid-template-columns: 1fr 1fr/);
  // The same panel.html renders the NARROW in-app panel, and this window can be
  // resized. Without the collapse, either would clip rather than reflow.
  assert.match(panelCss, /@media \(max-width: 720px\)[^}]*\{[^}]*grid-template-columns: 1fr/);
  assert.match(main, /width: 980,/, 'the pop-out has to be wide enough for two columns');
});

test('no section was dropped in the move', () => {
  // The restructure moved blocks wholesale; these are the ids that would silently
  // break panel.js if one had been lost.
  for (const id of ['callStateDebug', 'rawCaptionText', 'transcriptArea', 'simulateSpeechBtn',
    'shareWhiteboardBtn', 'speakTextBtn', 'copyCurlBtn', 'roomIdField', 'devtoolsBtn', 'websiteUrl']) {
    assert.ok(tsScreen.includes(id), `${id} went missing in the two-column move`);
  }
});

test('the DevTools button says which window it opens', () => {
  // It opens meetView — the bot's Meet view — not this panel. The old label
  // ("Open DevTools") read as "this window".
  assert.match(tsScreen, /Open DevTools for Call Window/);
  const ipc = main.slice(main.indexOf("ipcMain.on('open-devtools'"));
  assert.match(ipc.slice(0, 300), /meetView\.webContents\.openDevTools/, 'the label must match the target');
});

test('the Agent Prompt section and its code are gone', () => {
  // Superseded by MCP: it generated a curl-based prompt for driving a bot by
  // hand, which nothing uses now.
  assert.doesNotMatch(tsScreen, /Agent Prompt/);
  for (const sym of ['agentPromptText', 'copyPromptBtn', 'generateAgentPrompt', 'updateAgentPrompt']) {
    assert.ok(!panelJs.includes(sym), `${sym} left behind — it would throw on a null element`);
  }
});
