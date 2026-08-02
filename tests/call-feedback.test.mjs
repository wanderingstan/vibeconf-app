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
  // Sliced to the handler's closing brace rather than a character count — a
  // fixed window silently stops covering the end of the function the moment a
  // comment is added, which is exactly how this drifted.
  const body = h.slice(0, h.indexOf('\n  });') + 6);
  assert.match(body, /\[feedback\]/, 'a stable prefix is what makes it findable in a busy log');
  // bot= and othersSpeaking= are what separate the reports from each other:
  // "interrupted" while the bot was speaking is a different bug from the same
  // click while it was listening, and "frozen" only means something next to
  // whether anyone was actually talking. Without them the marker needs ten
  // lines of context either side to interpret.
  for (const field of ['kind=', 'status=', 'bot=', 'othersSpeaking=', 'room=', 'call=']) {
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

test('the feedback row stays a single line at full width', () => {
  // They are a scanning target during a call. Wrapping to a second line moves
  // buttons between clicks, so the row shrinks instead of wrapping — and
  // flex-basis:0 keeps the seven evenly sized regardless of label length, so it
  // stays a stable grid of targets rather than shuffling with the text.
  assert.match(panelCss, /\.ts-feedback \.fb-row \{[^}]*flex-wrap: nowrap/);
  assert.match(panelCss, /\.ts-feedback button \{[^}]*flex: 1 1 0/);
  // Below the two-column breakpoint, squeezing seven buttons is worse than
  // wrapping them.
  assert.match(panelCss, /@media \(max-width: 720px\) \{[\s\S]{0,200}flex-wrap: wrap/);
});

test('the simulated speaker is fixed, not a field', () => {
  // A stray or blank value silently changed who the bot thought had spoken,
  // which is the one thing about an injected turn that must be unambiguous when
  // you read it back.
  assert.match(panelJs, /const SIMULATED_SPEAKER = 'Troubleshooting User'/);
  assert.ok(!panelJs.includes('simulateSpeaker'), 'the element reference must go too');
  assert.ok(!tsScreen.includes('simulateSpeaker'), 'and the orphaned input');
});

test('the copy-curl command targets something that will accept it', () => {
  // It pointed at http://127.0.0.1:7865 by default. That endpoint is real, so
  // the command looked right — and it has 401'd since the local control API
  // began requiring a bearer token (#201). The website takes these posts
  // unauthenticated and is the useful target anyway: the point is driving the
  // bot from somewhere else.
  assert.ok(!panelJs.includes("syncBaseUrl || 'http://127.0.0.1:7865'"),
    'the local fallback makes the copied command unusable');
  assert.match(panelJs, /let syncBaseUrl = 'https:\/\/vibeconferencing\.com'/);
});

test('Debug Override sits at the foot of the right column', () => {
  const cols = tsScreen.slice(tsScreen.indexOf('ts-cols'));
  assert.ok(cols.includes('Debug Override'), 'it belongs inside the columns, not below them');
  // Last thing in its column: it is machine-wide and persistent, unlike
  // everything else here, which acts on this call.
  assert.ok(cols.indexOf('Debug Override') > cols.indexOf('devtoolsBtn'));
});

test('the curl helper works in the pop-out window, not just the panel', () => {
  // The pop-out is a SECOND webContents. panelView.webContents.send(...)
  // broadcasts — meet-detected, call-status-changed — never reach it, so a
  // control driven only by those events is dead there. This one was: disabled
  // permanently, in a call or out of one, with nothing explaining why.
  //
  // The 1s call-state poll runs in both windows, so it is the right driver.
  const poll = panelJs.slice(panelJs.indexOf("api.invoke('get-call-state')"));
  assert.match(poll.slice(0, 400), /updateCurlCommand\(s && s\.roomId\)/,
    'the poll must drive it, or the pop-out never enables the button');

  // And the empty state has to say something. A greyed-out button with no
  // explanation is indistinguishable from a broken one — which is exactly how
  // this was reported.
  const fn = panelJs.slice(panelJs.indexOf('function updateCurlCommand'));
  assert.match(fn.slice(0, 700), /if \(!meetCode\)/);
  assert.match(fn.slice(0, 700), /Available once the bot is in a call/);
});

test('each button carries a distinct emoji, sized to be the target', () => {
  // System emoji here on purpose: this is the troubleshooting window, where
  // colour and instant recognition beat the OS-independent SVG set used for the
  // main UI chrome. Someone clicking these mid-call is matching a feeling to a
  // picture in about a second — so the glyph is the target and the word only
  // confirms it, which is why it is stacked above and much larger.
  const row = tsScreen.slice(tsScreen.indexOf('class="fb-row"'), tsScreen.indexOf('feedbackStatus'));
  const glyphs = [...row.matchAll(/<span class="fb-emoji">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.equal(glyphs.length, 7, 'all seven still carry an emoji');
  // Two buttons sharing a glyph would defeat the point of having them.
  assert.equal(new Set(glyphs).size, 7, `duplicate emoji: ${glyphs.join(' ')}`);
  for (const g of glyphs) assert.doesNotMatch(g, /\p{L}/u, `${g} is not an emoji`);

  // Bigger than the label, or it is decoration rather than the thing being read.
  assert.match(panelCss, /\.ts-feedback \.fb-emoji \{[^}]*font-size: 24px/);
  assert.match(panelCss, /\.ts-feedback \.fb-label \{[^}]*font-size: 11px/);
  assert.match(panelCss, /\.ts-feedback button \{[^}]*flex-direction: column/);

  // The label element is read directly for the log, rather than stripping emoji
  // out of textContent — `kind=` is the machine key and emoji in a grep is noise.
  assert.match(panelJs, /btn\.querySelector\('\.fb-label'\)/);
});
