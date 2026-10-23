// bot-menu-merge.test.mjs: a bot's row menu (Show in Finder, Stop, Delete) and
// merging a bot into a call already going, like a phone's "merge calls".
//
// Run: node --test tests/bot-menu-merge.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeTargets } = require('../electron-app/supervisor.js');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('merge targets: calls bots are in, and calls open in the browser, one per call', () => {
  const t = mergeTargets({
    instances: [
      { profile: 'bot2', botName: 'Charlie', callStatus: 'in-call', currentUrl: 'https://meet.google.com/abc-defg-hij?authuser=bot@x.com' },
      { profile: 'bot3', botName: 'Bob', callStatus: 'joining', currentUrl: 'https://meet.google.com/zzz-zzzz-zzz' },
      { profile: 'bot4', botName: 'Rosie', callStatus: 'idle', currentUrl: null },
    ],
    detected: [{ code: 'abc-defg-hij', url: 'https://meet.google.com/abc-defg-hij' }, { code: 'xyf-ouxt-efk', url: 'https://meet.google.com/xyf-ouxt-efk' }],
  });
  assert.deepEqual(t.map((x) => [x.label, x.bot]), [["Charlie's call", 'bot2'], ['Meet xyf-ouxt-efk', null]],
    'the browser tab Charlie is in is Charlie\'s call, once; a bot still joining is not a call to merge into yet');
});

test('merge targets: nothing to merge into, nothing offered; only https links', () => {
  assert.deepEqual(mergeTargets({}), []);
  assert.deepEqual(mergeTargets({ instances: [{ profile: 'b', callStatus: 'in-call', currentUrl: 'file:///etc/passwd' }] }), []);
});

test('the sidebar offers merge only for calls the bot is not in, and only when there is one', () => {
  const js = read('electron-app/renderer/supervisor.js');
  assert.match(js, /const targets = inCall\(bot\) \? \[\] : \(merge \|\| \[\]\)\.filter\(\(t\) => t\.bot !== bot\.name\);/);
  assert.match(js, /if \(targets\.length\) \{/);
  assert.match(js, /api\.invoke\('supervisor:add', bot\.name, target\.url\)/, 'the existing Add path, which starts a closed bot first');
});

test('delete moves the folder to the Trash, after asking, never the default bot or one in a call', () => {
  const sup = read('electron-app/supervisor-app.js');
  const fn = sup.slice(sup.indexOf('async function deleteBot('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /if \(name === paths\.defaultProfile\) return \{ ok: false/);
  assert.match(body, /isBusy\(inst\.callStatus\)\) return \{ ok: false/);
  assert.match(body, /dialog\.showMessageBox\(/);
  assert.ok(body.indexOf('showMessageBox') < body.indexOf('trashItem'), 'asks before anything moves');
  assert.match(body, /await shell\.trashItem\(path\.join\(paths\.profilesRoot, name\)\);/);
  assert.doesNotMatch(body, /rmSync|rm\(|unlink/, 'trash, never erase');
  // A running bot is stopped, and confirmed gone, before its folder moves.
  assert.ok(body.indexOf('await stopBot(') < body.indexOf('trashItem'));
  assert.match(body, /would not stop, so nothing was deleted/);
});

test('the pane\'s Delete goes to the app window, for the bot on the stage only', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /ipcMain\.handle\('relay:delete-bot', async \(e\) => \{\s*\n\s*if \(!fromPanel\(e\)\) throw/);
  assert.match(sup, /return deleteBot\(relay\.name\);/);
  assert.match(read('electron-app/preload-panel-relay.js'), /deleteBot: \(\) => ipcRenderer\.invoke\('relay:delete-bot'\)/);
  assert.match(read('electron-app/renderer/panel.js'), /if \(!can\?\.ok\) return;/, 'not shown for the default bot');
});

test('Show in Finder takes a profile name, never a path', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /ipcMain\.handle\('supervisor:reveal', \(_e, name\) => \{\s*\n\s*\/\/[^\n]*\n\s*if \(!profileManager\.isValidProfileName\(name\)\) return/);
});

test('a bot\'s current call reaches the window but not the agents\' directory', () => {
  const sup = read('electron-app/supervisor-app.js');
  assert.match(sup, /currentUrl: typeof body\?\.currentMeetUrl === 'string' \? body\.currentMeetUrl : null,/);
  assert.match(sup, /\(\{ detectedMeetUrls, currentUrl, \.\.\.inst \}\) => inst/);
});

test('the … menu closes on a second click of its button, and when the bot pane is clicked', () => {
  const js = read('electron-app/renderer/supervisor.js');
  assert.match(js, /if \(openMenu && openMenu\.__anchor === anchor\) \{ closeMenu\(\); return; \}/);
  assert.match(js, /window\.addEventListener\('blur', closeMenu\);/, 'the pane is another page: this one only sees focus leave');
});

test('a bot from an older build can be restarted from the stage, never mid-call', () => {
  const sup = read('electron-app/supervisor-app.js');
  const fn = sup.slice(sup.indexOf('async function restartOutdatedBot('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /isBusy\(inst\.callStatus\)\) return \{ ok: false/);
  assert.match(body, /if \(!pid \|\| pid === process\.pid\) return \{ ok: false/, 'never signals the app itself');
  assert.match(body, /process\.kill\(pid, 'SIGTERM'\)/);
  assert.match(body, /return openBot\(name\);/, 'comes back as this window\'s child, on the stage');
  const js = read('electron-app/renderer/supervisor.js');
  assert.match(js, /action: busy \? null : \{ label: `Restart \$\{label\}`/);
});

test('after a call the agent\'s write-up reads as that, not as still in the call or Ready', () => {
  const js = read('electron-app/renderer/supervisor.js');
  assert.match(js, /bot\.phase === 'wrapping' \? 'wrap' : 'call'/);
  assert.match(read('electron-app/renderer/supervisor.html'), /\.sub \.state\.wrap \{ color: var\(--dim\);/);
  const panel = read('electron-app/renderer/panel.js');
  assert.match(panel, /wrappingUp = status === 'after-call-work';/);
  assert.match(panel, /joiningNow \? 'Joining…' : wrappingUp \? 'Wrapping up…' : 'Ready'/);
});
