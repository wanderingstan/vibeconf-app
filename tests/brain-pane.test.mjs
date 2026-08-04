// brain-pane.test.mjs — the 🧠 window: a read-only view of what the agent is
// thinking and doing (#242).
//
// Deliberately a surface over an EXISTING signal, not a new pipeline. The app
// already tails the Claude session's own transcript and formats it into
// 🗣 said / 🔧 ran a tool / 💬 was asked (agent-transcript.js), lands it in
// localServer.agentLog, and serves it over get-call-state. Until now the only
// place it surfaced was a line in the troubleshooting screen.
//
// Read-only is a constraint, not a preference: Terminal.app owns the agent
// process, so the app has no stdin to it. Input needs #242's headless spawn
// first, where we own the pipe.
//
// Run: node --test tests/brain-pane.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
const panelHtml = readFileSync(join(root, 'electron-app/renderer/panel.html'), 'utf8');
const iconsCss = readFileSync(join(root, 'electron-app/renderer/ui-icons.css'), 'utf8');

test('the 🧠 button sits beside 👀, and uses the drawn icon set', () => {
  // Panel chrome uses OS-independent SVG icons — the emoji exception is the
  // troubleshooting feedback row only.
  assert.match(panelHtml, /id="openBrainBtn"/);
  assert.match(panelHtml, /ui-icon-brain/);
  assert.match(iconsCss, /\.ui-icon-brain/, 'the icon must be generated, not a literal glyph');
  // Same row and same class as the eyes/troubleshooting buttons, so it inherits
  // their sizing rather than introducing a third button style.
  // 🧠 sits immediately LEFT of 👀 — both are "look inside the bot", so they
  // pair; 🚧 is a different kind of control and should not sit between them.
  assert.ok(panelHtml.indexOf('openBrainBtn') < panelHtml.indexOf('botViewToggleBtn'),
    'the brain button belongs to the left of the eyes');
  const row = panelHtml.slice(panelHtml.indexOf('openBrainBtn'), panelHtml.indexOf('openTroubleshootingBtn'));
  assert.match(row, /botview-toggle-btn/, 'and adjacent to it, in the same row');
  assert.match(panelHtml, /<button id="openBrainBtn" class="join-more"/);
});

test('it opens as its own window, so it can sit beside the call', () => {
  // The point is watching the agent WHILE the call runs. A screen inside the
  // panel would replace the thing you are watching it against.
  assert.match(main, /ipcMain\.handle\('open-brain-window'/);
  assert.match(main, /search: 'screen=brain'/);
  assert.match(panelJs, /IS_BRAIN_WINDOW/);
  // Reuses the existing window, rather than stacking a new one per click.
  const h = main.slice(main.indexOf("ipcMain.handle('open-brain-window'"));
  assert.match(h.slice(0, 400), /if \(brainWindow && !brainWindow\.isDestroyed\(\)\)/);
});

test('it polls rather than relying on broadcasts', () => {
  // A second webContents does not receive panelView.webContents.send(...). That
  // is exactly how the curl helper came to be permanently dead in the pop-out
  // window — a control driven only by broadcasts is inert there.
  const poll = panelJs.slice(panelJs.indexOf('if (IS_BRAIN_WINDOW) {', panelJs.indexOf('setInterval')));
  assert.match(poll.slice(0, 300), /api\.invoke\('get-call-state'\)/);
  assert.match(poll.slice(0, 300), /renderBrain/);
});

test('a live feed must not fight the reader', () => {
  // Two ways this goes wrong: re-rendering identical content (which resets
  // selection), and yanking the view to the bottom while someone is reading
  // something further up.
  const fn = panelJs.slice(panelJs.indexOf('function renderBrain'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /joined === _brainLastRendered/, 'unchanged content must not re-render');
  assert.match(body, /const atBottom =/);
  assert.match(body, /if \(atBottom\) feed\.scrollTop = feed\.scrollHeight/, 'follow only when already at the end');
});

test('agent output is escaped before it reaches innerHTML', () => {
  // These lines carry model output and tool inputs verbatim. Straight into
  // innerHTML they would render as markup.
  const fn = panelJs.slice(panelJs.indexOf('function renderBrain'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /replace\(\/&\/g, '&amp;'\)/);
  assert.match(body, /replace\(\/</);
});

test('the empty state explains itself', () => {
  // "No agent session yet" with no reason reads as broken — and this feed was in
  // fact broken and empty for three days (the hook 401 from #201) with nobody
  // noticing, precisely because nothing said what should fill it.
  const fn = panelJs.slice(panelJs.indexOf('function renderBrain'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /No agent session yet/);
  assert.match(body, /transcript/, 'say where the content comes from');
});
