// bot-menu.test.mjs — #502: the menu bar is where macOS users expect to find
// out what an app can do, and ours barely used it.
//
// Two items already existed in places nobody would look — Show Bot's View under
// File, and Copy Chat Command parked in Edit by fb6f07aa as a spot fix for one
// command rather than a plan. The rest of what the app can do about a bot was
// reachable only by clicking something in the panel.
//
// The item that matters most, per the issue: opening a window for a DIFFERENT
// bot. Profiles are how one machine runs several bots, but mid-call there was
// no good way to open another one's window, which makes profiles close to
// theoretical in exactly the situation they were built for.
//
// Run: node --test tests/bot-menu.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');

const panel = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

// One top-level menu object, from its label to the close of that entry.
const menuSlice = (label) => {
  const i = main.indexOf(`      label: '${label}',`);
  return main.slice(i, main.indexOf('\n    },\n', i));
};
const botMenu = menuSlice('Bot');
const fileMenu = menuSlice('File');

test('there is a Bot menu, and it sits before Window', () => {
  assert.ok(botMenu.length > 0, 'no Bot menu found');
  assert.ok(main.indexOf("label: 'Bot',") < main.indexOf("label: 'Window',"),
    'a bot is not a window; it belongs before the window menu, not after it');
});

test('the two misfiled items MOVED rather than being duplicated', () => {
  // A second copy would be worse than the original problem: two menu items with
  // one accelerator between them, and only one of them doing anything.
  for (const [label, accel] of [['Show Bot\'s View', 'CmdOrCtrl+Shift+B'],
    ['Copy Chat Command', 'Alt+CmdOrCtrl+C']]) {
    const copies = main.split(`label: ${label.includes("'") ? `"${label}"` : `'${label}'`}`).length - 1;
    assert.equal(copies, 1, `${label} must exist exactly once`);
    assert.ok(botMenu.includes(label), `${label} must be in the Bot menu`);
    assert.ok(botMenu.includes(accel), `${label} must keep its accelerator`);
  }
});

test('the bot windows are reachable from the menu, not only from the panel', () => {
  for (const item of ["Show Bot's Brain", 'Show Troubleshooting']) {
    assert.ok(botMenu.includes(item), `missing: ${item}`);
  }
  // Via the same refs pattern the profile launcher already uses — the menu is
  // built in createMainWindow() and these windows are opened from setupIPC().
  assert.match(main, /let openBrainWindowRef = null;/);
  assert.match(main, /let openTroubleshootingWindowRef = null;/);
});

test('Open Bot lists profiles under File, rebuilt from disk each time', () => {
  // Opening a window is a File verb. It also replaced "New Window", which only
  // ever opened whichever profile happened to be free.
  assert.ok(fileMenu.includes("label: 'Open Bot'"), 'Open Bot belongs in File');
  assert.ok(!botMenu.includes('Open Bot'), 'it must have MOVED, not been copied');
  assert.ok(!main.includes("label: 'New Window'"), 'Open Bot subsumes New Window');
  // The HANDLER must be gone, not every mention of the name: #489's unresponsive-
  // panel comment refers to `open-next-available-window` while explaining why a
  // native dialog is the only way out of a wedged renderer. A bare substring test
  // failed on prose, which is the wrong thing to be strict about.
  assert.doesNotMatch(main, /ipcMain\.(on|handle)\(\s*'open-next-available-window'/,
    'New Window\'s handler is unreachable once the item is gone');
  assert.match(fileMenu, /submenu: botProfileMenuItems\(\)/,
    'called at build time so a profile created mid-session appears without a relaunch');

  const fn = main.slice(main.indexOf('function botProfileMenuItems()'));
  const body = fn.slice(0, fn.indexOf('\n  }\n') + 4);
  assert.match(body, /profileManager\.listProfiles\(PROFILES_ROOT\)/,
    'read off disk — no running instance required');
  assert.match(body, /prof\.botName \|\| prof\.name/,
    'an unnamed bot is still a window you might want to open');
  assert.match(body, /launchOrFocusProfileRef\(prof\.name\)/,
    'address by PROFILE, which is the unique name; botName can collide');
  assert.match(body, /No other bots/, 'an empty list still has to say something');
  assert.match(body, /catch \{/, 'an unreadable profiles dir must not take the whole menu down');
});

test('Hang Up is guarded in the handler as well as by enabled:', () => {
  // `enabled:` is only honest because the menu is now rebuilt on every
  // call-status change; between the status flipping and the rebuild landing the
  // item can be stale, and requestCleanLeave does real teardown.
  const item = botMenu.slice(botMenu.indexOf("label: 'Hang Up'"));
  assert.match(item, /if \(!localServer \|\| localServer\.callStatus === 'idle'\) return;/,
    'requestCleanLeave does real teardown; it must not run when there is no call');
});

test('Call Now pairs with Hang Up, and exactly one of them is live', () => {
  const i = botMenu.indexOf("label: 'Call Now'");
  const j = botMenu.indexOf("label: 'Hang Up'");
  assert.ok(i > -1 && j > i, 'Call Now sits directly above Hang Up');
  assert.ok(!botMenu.slice(i, j).includes("type: 'separator'"),
    'they are one pair, not two groups');
  assert.match(botMenu.slice(i, j),
    /enabled: !localServer \|\| localServer\.callStatus === 'idle'/);
  assert.match(botMenu.slice(j),
    /enabled: !!localServer && localServer\.callStatus !== 'idle'/);
});

test('Call Now presses the panel button rather than reimplementing it', () => {
  // The button is "Call <bot> now" or "Add <bot> to call" depending on what was
  // detected, and the second form needs the URL beside it. Only the button
  // knows which it is; a menu item with its own opinion could join the wrong
  // thing. So main sends, and the renderer clicks.
  assert.match(botMenu, /panelView\.webContents\.send\('menu-call-now'\)/);
  assert.match(panel, /api\.on\('menu-call-now'/);
  const handler = panel.slice(panel.indexOf("api.on('menu-call-now'"));
  assert.match(handler.slice(0, 600), /joinBtn\.click\(\)/,
    'press the real control, do not duplicate its logic');
  assert.match(handler.slice(0, 600), /showScreen\(mainScreen\)/,
    'the button only exists on the main screen');
});

test('the menu is rebuilt when the call status changes', () => {
  // Without this the `enabled:` flags above would be frozen at their startup
  // value — permanently greyed out, which is worse than an item that does
  // nothing.
  assert.match(main, /let refreshAppMenuRef = null;/);
  assert.match(main, /refreshAppMenuRef = refreshAppMenu;/);
  const i = main.indexOf("broadcastToRenderers('call-status-changed'");
  assert.match(main.slice(i, i + 700), /refreshAppMenuRef && refreshAppMenuRef\(\)/,
    'rebuild on the same status change the panel is told about');
});

test('the three ways to look inside the bot read as one group', () => {
  // One verb, one subject, no separators between them. "Brain Pane" named a
  // window rather than an act, and "Troubleshooting…" promised a modal that
  // never existed.
  const labels = ["Show Bot's View", "Show Bot's Brain", 'Show Troubleshooting'];
  const at = labels.map((l) => botMenu.indexOf(l));
  assert.ok(at.every((n) => n > -1), `missing one of: ${labels}`);
  assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'they must stay in order');
  assert.ok(!botMenu.slice(at[0], at[2]).includes("type: 'separator'"),
    'one group means no separators inside it');
  for (const dead of ['Brain Pane', 'Troubleshooting…']) {
    assert.ok(!main.includes(`label: '${dead}'`), `${dead} was renamed, not kept`);
  }
});

test("Navigate Webview moved to Bot, since it drives THIS bot's webview", () => {
  assert.ok(botMenu.includes("label: 'Navigate Webview…'"), 'it belongs under Bot');
  assert.ok(!fileMenu.includes('Navigate Webview'), 'it must have MOVED, not been copied');
  assert.equal(main.split("label: 'Navigate Webview…'").length - 1, 1);
  assert.ok(botMenu.includes("accelerator: 'CmdOrCtrl+Shift+L'"), 'it keeps its accelerator');
});

test('Bot Settings moved out of the app menu, where it read as a second Settings', () => {
  // Machine-wide Settings (⌘,) stays in the app menu. This one configures THIS
  // bot — name, voice, avatar — which is the line the Bot menu is drawn on.
  assert.ok(botMenu.includes("label: 'Bot Settings…'"), 'it belongs under Bot');
  assert.equal(main.split("label: 'Bot Settings…'").length - 1, 1, 'moved, not copied');
  assert.ok(botMenu.includes("accelerator: 'CmdOrCtrl+Shift+,'"), 'it keeps ⇧⌘,');
  assert.ok(main.includes("accelerator: 'CmdOrCtrl+,'"),
    'the machine-wide Settings keeps ⌘, and stays where macOS users expect it');
  assert.ok(botMenu.indexOf("label: 'Bot Settings…'") < botMenu.indexOf("Show Bot's View"),
    'first item: it is the one you open before a bot is any good');
});
