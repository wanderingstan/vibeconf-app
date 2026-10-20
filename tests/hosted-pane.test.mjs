// hosted-pane.test.mjs: the bot's pane inside the app window (#301).
//
// Once the bot no longer filled its own window, its full-bleed artwork, centred
// name and gear read as a window squeezed onto a stage. The pane now reads top
// to bottom: name and status, the art as a camera-shaped card with the
// inspectors on it, the link field and two stacked buttons whose green follows
// the field, then About <bot> with the agent, voice and account, and Edit.
// App settings moved to the sidebar's footer, and the app's menu bar carries
// the selected bot's own Bot menu. These pin that wiring.
//
// Run: node --test tests/hosted-pane.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const panel = read('electron-app/renderer/panel.js');
const css = read('electron-app/renderer/panel.css');
const main = read('electron-app/main.js');
const sup = read('electron-app/supervisor-app.js');
const sidebar = read('electron-app/renderer/supervisor.js');

test('the green follows the link field: Add with a link, Start without one', () => {
  const fn = panel.slice(panel.indexOf('function syncCallNowBtn()'));
  assert.match(fn.slice(0, 900), /joinBtn\.classList\.toggle\('primary', hasUrl\);\s*\n\s*callNowBtn\.classList\.toggle\('primary', !hasUrl\);/);
  assert.match(panel, /joinBtn\.textContent = 'Add to this call';/);
  assert.match(fn.slice(0, 900), /'Start a new call'/);
});

test('Add appears only once there is a link to add the bot to', () => {
  assert.match(panel, /joinBtn\.style\.display = url \? '' : 'none';/);
  assert.match(panel, /joinBtn\.disabled = !!url && !isJoinableUrl\(url\);/);
  assert.match(panel, /meetUrlInput\.addEventListener\('input', \(\) => updateJoinBtnState\(\)\);/);
});

test('the inspectors sit on the card, shown by the same rules as before', () => {
  assert.match(panel, /hero\.append\(tools\);/);
  assert.match(css, /html\.joining button\.card-tool\.tool-info \{ display: inline-flex; \}/);
  assert.match(css, /\.hosted \.bot-hero \{\s*\n\s*margin: 0; aspect-ratio: 16 \/ 9;/);
});

test('About lists agent, voice and a Google account only when signed in, and Edit opens the bot\'s settings', () => {
  assert.match(panel, /const AGENT_LABELS = \{ claude: 'Claude Code', codex: 'Codex' \};/);
  assert.match(panel, /hostedAbout\.google\.r\.style\.display = acct\?\.signedIn \? '' : 'none';/);
  assert.match(panel, /edit\.addEventListener\('click', \(\) => document\.getElementById\('openSettingsBtn'\)\?\.click\(\)\);/);
  assert.match(panel, /play\.addEventListener\('click', \(\) => \{ const o = selectedVoiceSample\(\); if \(o\) previewVoiceSample\(o\); \}\);/);
  assert.doesNotMatch(css, /\.about-row \{[^}]*justify-content: space-between/, 'left-aligned, never spread across a wide window');
});

test('Copy command and the Bot menu share one implementation with the bot\'s own menu', () => {
  assert.match(main, /ipcMain\.handle\('copy-chat-command', \(\) => \{\s*\n\s*try \{ return \{ ok: true, command: buildChatCommandForThisBot\(\) \}; \}/);
  assert.match(main, /require\('electron'\)\.clipboard\.writeText\(buildChatCommandForThisBot\(\)\);/);
  assert.match(main, /ipcMain\.removeHandler\('bot-menu-items'\);\s*\n\s*ipcMain\.removeHandler\('bot-menu-click'\);/);
  assert.match(main, /const item = botSubmenu\(\)\.find\(\(i\) => i\.label === label\);/);
});

test('the app window builds its Bot menu from the selected bot and refreshes it on every selection', () => {
  assert.match(sup, /channel: 'bot-menu-items'/);
  assert.match(sup, /channel: 'bot-menu-click', args: \[label\]/);
  assert.match(sup, /\{ label: 'Bot', submenu: botMenu \}/);
  assert.equal((sup.match(/refreshBotMenu\(\);/g) || []).length, 2, 'on select and on deselect');
});

test('App settings: the one gear, in the sidebar footer, and ⌘, in the app menu', () => {
  assert.match(sidebar, /box\.append\(appSettingsGear\(\)\);/);
  assert.match(sup, /ipcMain\.handle\('supervisor:app-settings'/);
  assert.match(sup, /label: 'Settings…', accelerator: 'Command\+,'/);
  assert.match(css, /\.hosted \.hero-top,/, 'the pane has no gear of its own');
  assert.match(main, /presentHeadlessWindow\(appSettingsWindow\);/);
});

test('the account line shows your picture and opens your page on the website', () => {
  assert.match(sup, /avatarUrl: avatar \};/);
  assert.match(sup, /shell\.openExternal\(`\$\{websiteBase\(\)\}\/me`\)/, 'the URL is built in main, not taken from the page');
  assert.match(sidebar, /img\.addEventListener\('error', \(\) => img\.remove\(\)\);/);
  assert.match(sidebar, /api\.invoke\('supervisor:open-account'\)/);
});
