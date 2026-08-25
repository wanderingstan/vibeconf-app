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

// The Bot menu object, from its label to the close of that top-level entry.
const botMenu = (() => {
  const i = main.indexOf("      label: 'Bot',");
  return main.slice(i, main.indexOf('\n    },\n', i));
})();

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
  for (const item of ['Brain Pane', 'Troubleshooting…']) {
    assert.ok(botMenu.includes(item), `missing: ${item}`);
  }
  // Via the same refs pattern the profile launcher already uses — the menu is
  // built in createMainWindow() and these windows are opened from setupIPC().
  assert.match(main, /let openBrainWindowRef = null;/);
  assert.match(main, /let openTroubleshootingWindowRef = null;/);
});

test('Open Bot Window lists profiles, rebuilt from disk each time', () => {
  assert.ok(botMenu.includes("label: 'Open Bot Window'"));
  assert.match(botMenu, /submenu: botProfileMenuItems\(\)/,
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

test('Hang Up is guarded in the handler, not by a stale enabled flag', () => {
  // refreshAppMenu() runs at startup and on integration install/uninstall only.
  // An `enabled:` computed from callStatus would be frozen at its startup value
  // — permanently greyed out, which is worse than an item that does nothing.
  const item = botMenu.slice(botMenu.indexOf("label: 'Hang Up'"));
  assert.ok(!item.slice(0, 400).includes('enabled:'),
    'a menu that is never rebuilt cannot carry a live enabled flag');
  assert.match(item, /if \(!localServer \|\| localServer\.callStatus === 'idle'\) return;/,
    'requestCleanLeave does real teardown; it must not run when there is no call');
});

test('there is no Call item to pair with Hang Up', () => {
  // Deliberate. Hanging up means one thing from a menu; starting a call does
  // not — the panel's button is "Call <bot> now" or "Add <bot> to call"
  // depending on what was detected, and it needs the URL field beside it.
  assert.ok(!/label: 'Call(…| |')/.test(botMenu),
    'a menu item that sometimes meant "join the thing I found" would be worse than none');
});
