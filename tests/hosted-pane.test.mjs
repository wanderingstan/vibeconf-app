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

test('Copy command and the terminal use the bot\'s existing chat-session handlers', () => {
  assert.match(panel, /api\.invoke\('chat-session:copy'\)/);
  assert.doesNotMatch(main, /copy-chat-command/, 'no second copy of chatCommandForBot');
  assert.match(main, /ipcMain\.removeHandler\('bot-menu-items'\);\s*\n\s*ipcMain\.removeHandler\('bot-menu-click'\);/);
  assert.match(main, /const item = botSubmenu\(\)\.find\(\(i\) => i\.label === label\);/);
});

test('Show terminal: an open agent terminal is brought forward, not opened again', () => {
  const open = panel.slice(panel.indexOf('async function openChatSession()'));
  assert.match(open.slice(0, 400), /const shown = await api\.invoke\('chat-session:show'\)[\s\S]{0,60}if \(shown\?\.ok\) return;/);
  assert.match(panel, /running \? 'Show terminal' : 'Open terminal'/);
  assert.match(main, /ipcMain\.handle\('chat-session:status', async \(\) => \(\{ running: \(await openAgentTerminalIds\(\)\)\.length > 0 \}\)\);/);
  // Never launches Terminal just to ask, and never closes a terminal you opened.
  assert.match(main, /if application "Terminal" is running then/);
  assert.match(main, /let chatTerminalWindowIds = \[\];/);
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

test('collapsed, the rail still shows the account stacked on the App Settings gear', () => {
  assert.match(sidebar, /renderAccountRail\(document\.getElementById\('railAccount'\), a\);/);
  const rail = sidebar.slice(sidebar.indexOf('function renderAccountRail('));
  assert.match(rail.slice(0, 1800), /me\.append\(el\('span', 'me-ring'\)\);/, 'signed out: a hollow ring that signs in');
  assert.match(rail.slice(0, 1800), /box\.append\(appSettingsGear\(\)\);/);
  assert.match(read('electron-app/renderer/supervisor.html'), /<div class="rail-foot" id="railAccount"><\/div>/);
});

test('a click on the picture pulls a random face, from every face, never in a call', () => {
  const faces = panel.slice(panel.indexOf('const SURPRISE_FACES = ['), panel.indexOf('const SURPRISE_HOLD_MS'));
  assert.ok((faces.match(/0x[0-9A-F]{4,5}/g) || []).length >= 100, 'the whole face set, not a handful');
  assert.match(panel, /if \(callActive \|\| liveFaceEmoji \|\| inCall \|\| document\.documentElement\.classList\.contains\('joining'\)\) return;/);
  // Only faces the bot's own set can draw, so an image set never falls back to the OS glyph.
  assert.match(panel, /if \(drawsAll \|\| await emojiUriFor\(set, face\)\) return face;/);
  // Blink and mood stand aside while it shows.
  assert.match(panel, /if \(surpriseEmoji\) return false;/);
  assert.match(panel, /return liveFaceEmoji \|\| surpriseEmoji \|\| RESTING_EMOJI;/);
});

test('on air: the pane goes dark from joining until the bot has left, with a live call timer', () => {
  const sync = panel.slice(panel.indexOf('const syncStatus = () => {'));
  // From the bot's own status, not only the joining class, which can lag.
  assert.match(sync.slice(0, 1500), /const joiningNow = !inCallNow && \(joiningStatus \|\| !!phase\);/);
  assert.match(sync.slice(0, 1500), /classList\.toggle\('on-air', inCallNow \|\| joiningNow\);/);
  assert.match(sync.slice(0, 1500), /`In a call · \$\{elapsed\(Date\.now\(\) - callSince\)\}`/);
  // A panel opened mid-call times the call from when the bot started it.
  assert.match(read('electron-app/local-server.js'), /callStartedAt: this\.callStartedAt,\s*\n\s*mode: this\.mode,/);
  assert.match(panel, /if \(Number\.isFinite\(started\)\) hostedCallStartedAt = started;/);
});

test('on air uses the website\'s call palette, on the main screen only', () => {
  const rule = css.slice(css.indexOf('html.on-air #mainScreen {'));
  assert.match(rule.slice(0, 300), /--cream: #202124;/, 'the site\'s darkTheme.ts background');
  assert.match(rule.slice(0, 300), /--paper: #2d2e30;/);
  assert.doesNotMatch(css, /html\.on-air body \{/, 'Settings, another screen, stays light');
  assert.match(css, /html\.on-air #mainScreen button\.primary:not\(\.danger\) \{ color: #202124; \}/, 'green keeps a dark label');
});

test('Open call opens the bot\'s own call in your browser, https only', () => {
  const main2 = read('electron-app/main.js');
  assert.match(main2, /ipcMain\.handle\('open-current-call', \(\) => \{\s*\n\s*const url = currentMeetUrl \|\| \(localServer && localServer\.currentUrl\) \|\| '';\s*\n\s*if \(!\/\^https:\\\/\\\/\/i\.test\(url\)\)/);
  assert.match(panel, /const openCall = el\('button', 'hosted-open-call', 'Open call'\);/);
  assert.match(panel, /if \(leaveRow\) leaveRow\.after\(openCall\);/, 'under Leave, the more common act');
  assert.match(panel, /if \(share\) \{ share\.classList\.add\('card-share'\); hero\.append\(share\); \}/, 'share toggle on the card');
});

test('the Meeting link field says when its link came from the browser, and clears in one click', () => {
  assert.match(panel, /span\.textContent = ' \(found in browser\)';/);
  // Only while the link is the detected call, unedited.
  assert.match(panel, /value && detectedCallUrl && value === detectedCallUrl\.trim\(\) \? '' : 'none'/);
  // The ⓧ is the same dismissal as emptying the field, so the scan doesn't refill it.
  assert.match(panel, /btn\.addEventListener\('click', \(\) => \{ dismissCallUrl\(\); meetUrlInput\.focus\(\); \}\);/);
  assert.match(panel, /if \(meetUrlClear\) meetUrlClear\.style\.display = value \? '' : 'none';/);
});
