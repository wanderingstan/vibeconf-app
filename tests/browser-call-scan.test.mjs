// browser-call-scan.test.mjs — finding the calls open in the user's browser.
//
// The AppleScript scan and the parsing of its output moved out of main.js into
// browser-call-scan.js (#301 step 3), so the supervisor can be the machine's
// one scanner and each bot only scans for itself when no supervisor answers.
// Pinned here: the parsing (the huddle-matching rules especially, which used
// to be testable only with a browser), and the bot's supervisor-first order.
//
// Run: node --test tests/browser-call-scan.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseScanOutput, isAutomationDenied, scanBrowsers, SCAN_SCRIPT } = require('../electron-app/browser-call-scan.js');

const out = (...lines) => lines.join('\n') + '\n';

test('Meet rooms are kept; the Meet landing page and other Meet URLs are not', () => {
  const r = parseScanOutput(out(
    'MEET:https://meet.google.com/abc-defg-hij?authuser=1',
    'MEET:https://meet.google.com/landing',
    'MEET:https://meet.google.com/',
    'MEET:https://meet.google.com/xyz-wxyz-xyz',
  ));
  assert.deepEqual(r.meetUrls, ['https://meet.google.com/abc-defg-hij?authuser=1', 'https://meet.google.com/xyz-wxyz-xyz']);
  assert.equal(r.slackHuddleUrl, null);
});

test('empty output is no calls, not an error', () => {
  assert.deepEqual(parseScanOutput(''), { meetUrls: [], slackHuddleUrl: null, slackAmbiguous: null });
  assert.deepEqual(parseScanOutput(undefined).meetUrls, []);
});

test('a huddle popup picks the Slack tab of ITS workspace, not the first one', () => {
  const r = parseScanOutput(out(
    'SLACK:https://app.slack.com/client/T111/C111|||general (Channel) - Other Co - Slack',
    'SLACK:https://app.slack.com/client/T222/C222|||testing (Channel) - Vibeconferencing - Slack',
    'BLANK:Huddle: #testing - Vibeconferencing - Slack 🎤',
  ));
  assert.equal(r.slackHuddleUrl, 'https://app.slack.com/client/T222/C222');
  assert.equal(r.slackAmbiguous, null);
});

test('several Slack tabs and none matching the huddle: no guess, and say why', () => {
  const r = parseScanOutput(out(
    'SLACK:https://app.slack.com/client/T111/C111|||a - One - Slack',
    'SLACK:https://app.slack.com/client/T222/C222|||b - Two - Slack',
    'BLANK:Huddle: #x - Three - Slack',
  ));
  assert.equal(r.slackHuddleUrl, null);
  assert.equal(r.slackAmbiguous.workspace, 'Three');
  assert.equal(r.slackAmbiguous.tabTitles.length, 2);
});

test('a blank window with exactly one Slack tab is that huddle', () => {
  const r = parseScanOutput(out(
    'SLACK:https://app.slack.com/client/T111/C111|||general - One - Slack',
    'BLANK:',
  ));
  assert.equal(r.slackHuddleUrl, 'https://app.slack.com/client/T111/C111');
});

test('a Slack tab with no huddle window is not a huddle', () => {
  const r = parseScanOutput(out('SLACK:https://app.slack.com/client/T111/C111|||general - One - Slack'));
  assert.equal(r.slackHuddleUrl, null);
});

test('Automation-denied is recognised by code and by wording', () => {
  assert.equal(isAutomationDenied('execution error: Not authorized to send Apple events to Google Chrome. (-1743)'), true);
  assert.equal(isAutomationDenied('not authorized to send apple events'), true);
  assert.equal(isAutomationDenied('some other failure'), false);
  assert.equal(isAutomationDenied(undefined), false);
});

test('the script keeps both PERF fixes: no System Events, batched tab reads', () => {
  assert.doesNotMatch(SCAN_SCRIPT, /System Events/);
  assert.match(SCAN_SCRIPT, /if application "Google Chrome" is running then/);
  assert.match(SCAN_SCRIPT, /set tabURLs to URL of tabs of w/);
});

test('scanBrowsers never rejects: a failure resolves with a stable failKey', async () => {
  const failing = (_c, _a, _o, cb) => cb(Object.assign(new Error('boom'), { killed: true }), '', '');
  const r = await scanBrowsers({ execFile: failing });
  assert.equal(r.ok, false);
  assert.equal(r.failKey, 'timeout');

  const denied = (_c, _a, _o, cb) => cb(new Error('x'), '', 'Not authorized to send Apple events (-1743)\n');
  const d = await scanBrowsers({ execFile: denied });
  assert.equal(d.ok, false);
  assert.equal(isAutomationDenied(d.stderr), true);

  const found = (_c, _a, _o, cb) => cb(null, 'MEET:https://meet.google.com/abc-defg-hij\n', '');
  const f = await scanBrowsers({ execFile: found });
  assert.equal(f.ok, true);
  assert.deepEqual(f.meetUrls, ['https://meet.google.com/abc-defg-hij']);
});

// ── The bot asks the supervisor first ──

const main = readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
const detection = main.slice(main.indexOf('function startMeetDetection()'), main.indexOf('meetDetectionInterval = setInterval(pollForMeet'));

test('a bot tries the supervisor before scanning, and only scans when it gets nothing', () => {
  assert.match(detection, /\/api\/detected-calls/);
  assert.match(detection, /return viaSupervisor \|\| scanBrowsers\(\);/);
  // An empty list from a supervisor that could not look is not "no calls".
  assert.match(detection, /body\.scanning !== true\) return null;/);
});

test('a bot shows no "Meet Detected" pop-up for the supervisor\'s answer (one pop-up per tab)', () => {
  assert.match(detection, /const notify = !scan\.fromSupervisor;/);
  const popups = detection.match(/if \(notify && Notification\.isSupported\(\) && !SUPPRESS_NOTIFICATIONS\)/g) || [];
  assert.equal(popups.length, 2, 'both the Meet and the Slack pop-up are gated');
  assert.doesNotMatch(detection, /if \(Notification\.isSupported\(\)/, 'no ungated pop-up left');
});

test('the scan code lives in one place now', () => {
  assert.doesNotMatch(main, /const browserScanBlock/);
  assert.match(main, /require\('\.\/browser-call-scan\.js'\)/);
  const sup = readFileSync(new URL('../electron-app/supervisor-app.js', import.meta.url), 'utf8');
  assert.match(sup, /require\('\.\/browser-call-scan\.js'\)/);
});
