#!/usr/bin/env node
// detect-test.mjs — open a Meet URL in the browser and assert the app's
// AppleScript tab-scan detection catches it (#267 step 1).
//
// Watches the app's detection the honest way: opens a real Meet URL in Chrome,
// then polls the bot's /api/sync/no-room for detectedMeetUrls. (Slack-huddle
// detection needs a live about:blank huddle popup, which can't be synthesized
// from a script — that stays a manual check.)
//
// PREREQ: a bot app running AND macOS Automation permission granted to it for
// the browser (so its tab scan works), and the bot NOT in a call (detection is
// suppressed mid-call):
//   scripts/spawn-test-fleet.sh 1
//
// Run:
//   node scripts/detect-test.mjs --bots Jimmy:7901
//   node scripts/detect-test.mjs --bots Jimmy:7901 --url https://meet.google.com/abc-defg-hij
//
// Exit non-zero if the URL isn't detected within the timeout.

import { execFile } from 'child_process';
import { Bot, sleep, report, record } from './meet-test-lib.mjs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const [name, port] = arg('bots', 'Jimmy:7901').split(',')[0].split(':');
const bot = new Bot(name, Number(port), 'no-room');
// Default to the open guest test meet (no sign-in / admission needed).
const MEET_URL = arg('url', 'https://meet.google.com/paz-sqoa-npe');
const code = (MEET_URL.match(/meet\.google\.com\/([a-z]+-[a-z]+-[a-z]+)/) || [])[1] || MEET_URL;

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message || '').trim())) : resolve(stdout));
  });
}

async function run() {
  // Open the Meet URL in a new Chrome tab.
  try {
    await osascript(
      'tell application "Google Chrome"\n' +
      '  if (count of windows) = 0 then make new window\n' +
      `  tell window 1 to make new tab with properties {URL:"${MEET_URL}"}\n` +
      '  activate\n' +
      'end tell');
    record(bot.name, 'openedBrowserTab', true, MEET_URL);
  } catch (e) {
    record(bot.name, 'openedBrowserTab', false, 'osascript failed — Chrome running + Automation permission? ' + e.message);
    return;
  }

  // The app scans tabs every ~5s; poll the bot's detection state.
  let detected = false;
  for (let i = 0; i < 24 && !detected; i++) {
    await sleep(1000);
    try { detected = (await bot.detected()).meetUrls.some((u) => u.includes(code)); } catch { /* retry */ }
  }
  record(bot.name, 'meetUrlDetected', detected, detected ? code : `NOT detected after ~24s (${code}) — Automation permission for the app?`);

  // Cleanup: close the tab(s) we opened.
  try {
    await osascript(`tell application "Google Chrome" to close (every tab of every window whose URL contains "${code}")`);
  } catch { /* best effort */ }
}

run()
  .catch((err) => { console.error('detect-test error:', err && err.message); })
  .finally(() => { const r = report(); process.exit(r.fails > 0 ? 1 : 0); });
