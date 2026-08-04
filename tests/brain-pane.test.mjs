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

test('feed text is selectable, against the app-wide rule', () => {
  // The app sets user-select:none globally — it is chrome, not a document, and a
  // slightly-off window drag was selecting the bot's name. This pane is the case
  // that rule is wrong about: it exists to be read and copied out of, and a tool
  // input or error line pasted into an issue is most of its debugging value.
  const css = readFileSync(join(root, 'electron-app/renderer/panel.css'), 'utf8');
  const block = css.slice(css.indexOf('.brain-feed {'));
  const body = block.slice(0, block.indexOf('}'));
  assert.match(body, /user-select: text/);
  assert.match(body, /cursor: text/, 'and it should LOOK selectable');
});

test('reasoning renders as its own kind of line, when there is any', () => {
  // Plumbing for a payload the CLI currently withholds — see the empty-thinking
  // note in agent-transcript.js. Wired anyway because it is nearly free and
  // starts working by itself if that changes.
  const panelJs = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');
  assert.match(panelJs, /'💭': 'l-think'/);
  const css = readFileSync(join(root, 'electron-app/renderer/panel.css'), 'utf8');
  assert.match(css, /\.brain-feed \.l-think/);
});

test('every window title names the BOT, not just the app', () => {
  // The main window has done this since early on, for a stated reason: with
  // several bots open, "Vibeconferencing" repeated across the window menu tells
  // you nothing. The satellite windows never got it — so someone running two
  // bots and comparing their brains had two windows both titled
  // "Vibeconferencing — Brain", which is the same problem one level out.
  assert.match(main, /function windowTitle\(suffix\)/);
  for (const suffix of ['Brain', 'Troubleshooting', "Bot's view", "Bot's-eye view"]) {
    const q = suffix.includes("'") ? `"${suffix}"` : `'${suffix}'`;
    assert.ok(main.includes(`windowTitle(${q})`), `${suffix} window must be named after the bot`);
  }
  // No window should carry a hardcoded bot-agnostic title any more.
  assert.doesNotMatch(main, /title: 'Vibeconferencing — Brain'/);
  assert.doesNotMatch(main, /title: "Vibeconferencing — Bot's view"/);
});

test('the name goes first, matching the main window', () => {
  // "Jimmy — Brain" not "Brain — Jimmy": the app switcher and window menu
  // truncate from the right, so the distinguishing part has to lead.
  const fn = main.slice(main.indexOf('function windowTitle(suffix)'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /`\$\{n\} — \$\{suffix\}`/);
  assert.match(body, /Vibeconferencing — \$\{suffix\}/, 'and an unnamed bot still gets a sane title');
});

test('renaming a bot retitles the satellites too, not just the main window', () => {
  // Titles are set at window CREATION, so without this a rename mid-session
  // leaves the brain pane labelled with the old name — worse than no name at
  // all, since it now actively misidentifies which bot you are looking at.
  assert.match(main, /function applyAllWindowTitles\(\)/);
  assert.match(main, /if \(key === 'botName'\) applyAllWindowTitles\(\);/);
  const fn = main.slice(main.indexOf('function applyAllWindowTitles()'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  for (const w of ['brainWindow', 'troubleshootingWindow', 'meetPopoutWindow', 'panelPopoutWindow']) {
    assert.ok(body.includes(w), `${w} must be retitled on rename`);
  }
  assert.match(body, /isDestroyed\(\)/, 'a closed window must not throw');
});

test('a pop-out window must not resize the MAIN window', () => {
  // Observed: opening 🧠 during a call grew the main window to ~696px, leaving a
  // large empty band below the avatar — the old bot's-view region reappearing,
  // apparently out of nowhere.
  //
  // Cause: every pop-out loads the SAME panel.html, so each one has the
  // 'panel-content-height' channel and measures its own (tall) content. The
  // renderer guard named the troubleshooting window explicitly, so the brain
  // window — added later — sailed straight past it.
  //
  // Fixed on BOTH sides. The renderer guard is now a class ("is this any
  // pop-out?") rather than a list of names, and main checks the sender, which a
  // future pop-out cannot forget because the check does not live in it.
  assert.match(panelJs, /const IS_POPOUT_WINDOW = new URLSearchParams\(window\.location\.search\)\.has\('screen'\)/);
  const fn = panelJs.slice(panelJs.indexOf('function reportContentHeight'));
  assert.match(fn.slice(0, 400), /if \(IS_POPOUT_WINDOW\) return;/);
  assert.doesNotMatch(fn.slice(0, 400), /IS_TROUBLESHOOTING_WINDOW/,
    'a name list silently omits the next window added');

  const h = main.slice(main.indexOf("ipcMain.on('panel-content-height'"));
  assert.match(h.slice(0, h.indexOf('});')), /event\.sender !== panelView\.webContents/,
    'main must reject height reports from anything but the docked panel');
});

test('closing the main window asks first', () => {
  // The red ✕ sits a few pixels from controls used constantly, and closing the
  // main window quits the app. Mid-call that ends the call and stops the agent,
  // with no undo — an expensive outcome for a slightly-off click.
  assert.match(main, /mainWindow\.on\('close', confirmQuitBeforeClose\)/);
  const fn = main.slice(main.indexOf('function confirmQuitBeforeClose'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /e\.preventDefault\(\)/, "'close' is cancellable; 'closed' is too late");
  // Cancel is the default: a stray Return on a dialog you did not expect should
  // land on the harmless answer, not the irreversible one.
  assert.match(body, /defaultId: 1/);
  assert.match(body, /cancelId: 1/);
  // The stakes differ enormously in and out of a call, so the wording does too.
  assert.match(body, /localServer\.callStatus === 'in-call'/);
  assert.match(body, /is in a call\. Quit anyway\?/);
  // An escape hatch, or the dialog becomes the next thing to complain about.
  assert.match(body, /checkboxLabel: "Don't ask again"/);
  assert.match(body, /quitConfirmed/, 'the confirmed close must not re-prompt itself');
});

test("'don't ask again' plus Cancel means stop nagging, not quit", () => {
  // Ticking the box and then cancelling is a clear instruction, and it must not
  // be read as consent to quit.
  const fn = main.slice(main.indexOf('function confirmQuitBeforeClose'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const ret = body.indexOf('if (response !== 0) return;');
  assert.ok(ret > -1, 'a non-Quit answer must return early');
  assert.ok(ret < body.indexOf('quitConfirmed = true'), 'before anything closes the window');
});

test('the add-to-call toggle is a + that rotates into an ×', () => {
  // What the control reveals is literally "Add <bot> to call", so the glyph can
  // say what it DOES rather than only "there is more below".
  // A DRAWN + (ui-icon-plus), not the text character: that was a different
  // weight in every OS font and read small beside the drawn 👀/🧠 either side of
  // it. As a masked icon it inherits button.join-more's 20px sizing and matches
  // them exactly.
  const row = panelHtml.slice(panelHtml.indexOf('id="manualUrlToggle"'));
  assert.match(row.slice(0, 260), /class="ui-icon ui-icon-plus join-caret"/);
  assert.doesNotMatch(row.slice(0, 260), />\+</, 'no text glyph left behind');

  const css = readFileSync(join(root, 'electron-app/renderer/panel.css'), 'utf8');
  // 45° is the whole trick: a + at 45° IS an ×, so open/close needs no second
  // character. Swapping glyphs makes the control jump — different advance
  // widths and optical weights in the same pill.
  assert.match(css, /button\.join-more\[aria-expanded="true"\] \.join-caret \{ rotate: 45deg; \}/);
  // Anchored on the line start: '.bot-hero .join-caret {' also contains
  // '.join-caret {', and matching that one instead finds a text-shadow rule.
  const block = css.slice(css.indexOf('\n.join-caret {'));
  const body = block.slice(0, block.indexOf('}'));
  assert.match(body, /transition: rotate/, 'it must animate, or the rotation is invisible');
  assert.match(body, /display: inline-block/, 'rotate does not apply to an inline box');
});

test('the quit confirmation cannot hold the app hostage', () => {
  // app.quit() closes every window, firing the same 'close' the confirmation
  // cancels. Without an escape the app could not be terminated by a signal at
  // ALL — and would sit holding a modal dialog through a macOS logout or block
  // the updater's install-on-quit (autoInstallOnAppQuit is true).
  //
  // Found the hard way: SIGTERM stopped killing the dev app. The old instance
  // survived, the NEW one hit the single-instance lock and quit itself, and a
  // port check still reported "running" because the OLD app was answering it.
  assert.match(main, /let appIsQuitting = false;/);
  // Set inside the EXISTING before-quit handler, not a second registration —
  // a duplicate made meet-retire.test's indexOf anchor find the wrong one.
  const bq = main.slice(main.indexOf("app.on('before-quit'"));
  assert.match(bq.slice(0, bq.indexOf('\n});')), /appIsQuitting = true;/);
  assert.equal(main.split("app.on('before-quit'").length - 1, 1,
    'exactly one before-quit registration');
  const fn = main.slice(main.indexOf('function confirmQuitBeforeClose'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(quitConfirmed \|\| appIsQuitting\) return;/,
    'every unambiguous quit path must skip the dialog');
  // Ordering is what makes this correct: clicking ✕ fires 'close' FIRST and
  // before-quit only afterwards, so the flag is still false and the click is
  // still caught. Cmd-Q, signals and shutdown fire before-quit first.
  assert.ok(body.indexOf('appIsQuitting') < body.indexOf('preventDefault'),
    'the escape must be checked before the close is cancelled');
});

test('the guided-setup button looks and reads like the call it is', () => {
  // It starts a real call, but in the muted .popout-btn style it read as a
  // settings action — the one thing it is not.
  const row = panelHtml.slice(panelHtml.indexOf('id="setupCallBtn"'));
  assert.match(row.slice(0, 120), /class="primary"/);
  assert.doesNotMatch(row.slice(0, 120), /popout-btn/);

  // It sits INSIDE the "you can also just ask the bot" note, because the two are
  // one thought: both say "you don't have to fill this form in". Under its own
  // heading further down, the call read as a separate feature — in the one place
  // someone who has already started editing fields will not look.
  const note = panelHtml.slice(panelHtml.indexOf('settings-intro'));
  const block = note.slice(0, note.indexOf('</div>'));
  assert.match(block, /or call our guided setup\./);
  assert.match(block, /id="setupCallBtn"/, 'the button belongs in the note');
  assert.doesNotMatch(panelHtml, /<h2>Guided setup<\/h2>/, 'the heading is gone');
  // Plain form copy, not a callout: the tinted box with an accent border made a
  // sentence ABOUT the page look like a warning about it.
  assert.doesNotMatch(panelHtml, /settings-note/, 'no callout styling left');

  // Same shape as the main button's "Call Jimmy now": verb first, then the bot.
  assert.match(panelJs, /function updateSetupCallBtnLabel\(\)/);
  const fn = panelJs.slice(panelJs.indexOf('function updateSetupCallBtnLabel'));
  assert.match(fn.slice(0, 300), /`Call \$\{currentBotName \|\| 'your bot'\} for setup`/);
});

test('the setup button follows a rename', () => {
  // It lives on the Settings screen — exactly where renames happen. Without
  // this it would sit there offering to call the OLD name on the very page you
  // just renamed the bot on. updateBotNameBig is the existing choke point that
  // already keeps the main button in step.
  const fn = panelJs.slice(panelJs.indexOf('function updateBotNameBig'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /updateSetupCallBtnLabel\(\)/);
  assert.match(body, /updateJoinBtnState\(\)/, 'alongside the main button, not instead of it');
});
