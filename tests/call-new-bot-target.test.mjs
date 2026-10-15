// call-new-bot-target.test.mjs — which call does /call-new-bot send a new bot to?
//
// Stan, 2026-10-15: there was no way to summon a fresh bot into a call that is
// ALREADY going, and /join-call with an unknown name renames the one running
// bot instead. The order is: explicit target > a call a running bot is in > a
// Meet open in the browser > a fresh Meet. Several distinct calls → ask.
//
// Run: node --test tests/call-new-bot-target.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { resolveNewBotTarget, parseCallTarget, roomIdToJoinUrl } = require('../electron-app/new-bot-target.js');
const { buildAgentArgs, buildInteractiveAgentArgs, joinSlashCommand } = require('../electron-app/agent-spawn.js');

const inCall = (profile, roomId, callStatus = 'in-call') => ({ profile, port: 7865, callStatus, roomId });
const idle = (profile) => ({ profile, port: 7866, callStatus: 'idle', roomId: null });

// --- the order ---------------------------------------------------------------

test('an explicit target wins over a call in progress and a browser tab', () => {
  const r = resolveNewBotTarget({
    explicit: 'https://meet.google.com/xyz-abcd-efg?authuser=0',
    instances: [inCall('default', 'aaa-bbbb-ccc')],
    browserMeetUrls: ['https://meet.google.com/ddd-eeee-fff'],
  });
  assert.equal(r.action, 'join');
  assert.equal(r.source, 'explicit');
  assert.equal(r.roomId, 'xyz-abcd-efg');
  assert.equal(r.url, 'https://meet.google.com/xyz-abcd-efg');
});

test('a call in progress wins over a browser tab', () => {
  const r = resolveNewBotTarget({
    instances: [inCall('default', 'aaa-bbbb-ccc'), idle('bot2')],
    browserMeetUrls: ['https://meet.google.com/ddd-eeee-fff'],
  });
  assert.equal(r.action, 'join');
  assert.equal(r.source, 'in-progress');
  assert.equal(r.url, 'https://meet.google.com/aaa-bbbb-ccc');
  assert.deepEqual(r.profiles, ['default']);
});

test('with no instance in a call, a Meet in the browser is used', () => {
  const r = resolveNewBotTarget({
    instances: [idle('default')],
    browserMeetUrls: ['https://meet.google.com/ddd-eeee-fff?pli=1'],
  });
  assert.equal(r.action, 'join');
  assert.equal(r.source, 'browser');
  assert.equal(r.url, 'https://meet.google.com/ddd-eeee-fff');
});

test('nothing anywhere → start a fresh Meet', () => {
  assert.deepEqual(resolveNewBotTarget({ instances: [idle('default')], browserMeetUrls: [] }),
    { action: 'new', source: 'none' });
  assert.equal(resolveNewBotTarget().action, 'new');
});

// --- ask, don't guess ----------------------------------------------------------

test('two bots in two different calls → ask, listing both', () => {
  const r = resolveNewBotTarget({
    instances: [inCall('default', 'aaa-bbbb-ccc'), inCall('bot2', 'ddd-eeee-fff')],
  });
  assert.equal(r.action, 'ask');
  assert.equal(r.source, 'in-progress');
  assert.deepEqual(r.candidates.map((c) => c.roomId), ['aaa-bbbb-ccc', 'ddd-eeee-fff']);
  assert.deepEqual(r.candidates[1].profiles, ['bot2']);
});

test('two bots in the SAME call are one call, not a reason to ask', () => {
  const r = resolveNewBotTarget({
    instances: [inCall('default', 'aaa-bbbb-ccc'), inCall('bot2', 'AAA-BBBB-CCC', 'joining')],
  });
  assert.equal(r.action, 'join');
  assert.deepEqual(r.profiles, ['default', 'bot2']);
});

test('two different Meets open in the browser → ask', () => {
  const r = resolveNewBotTarget({
    browserMeetUrls: ['https://meet.google.com/aaa-bbbb-ccc', 'https://meet.google.com/ddd-eeee-fff'],
  });
  assert.equal(r.action, 'ask');
  assert.equal(r.source, 'browser');
  assert.equal(r.candidates.length, 2);
});

test('the same Meet in two tabs is one call', () => {
  const r = resolveNewBotTarget({
    browserMeetUrls: ['https://meet.google.com/aaa-bbbb-ccc', 'https://meet.google.com/aaa-bbbb-ccc?authuser=1'],
  });
  assert.equal(r.action, 'join');
  assert.equal(r.roomId, 'aaa-bbbb-ccc');
});

test('Meet pages that are not a call (landing, lookup) are ignored', () => {
  const r = resolveNewBotTarget({
    browserMeetUrls: ['https://meet.google.com/landing', 'https://meet.google.com/lookup/abcdef'],
  });
  assert.equal(r.action, 'new');
});

// --- what counts as "in progress" ---------------------------------------------

test('every on-the-way-in status counts as in progress; idle and ended do not', () => {
  for (const status of ['navigating', 'joining', 'waiting-to-be-admitted', 'in-call']) {
    assert.equal(resolveNewBotTarget({ instances: [inCall('d', 'aaa-bbbb-ccc', status)] }).action, 'join', status);
  }
  for (const status of ['idle', 'call-complete', null]) {
    assert.equal(resolveNewBotTarget({ instances: [inCall('d', 'aaa-bbbb-ccc', status)] }).action, 'new', String(status));
  }
});

test('an instance reporting no-room is not a call', () => {
  assert.equal(resolveNewBotTarget({ instances: [inCall('d', 'no-room')] }).action, 'new');
});

test('a Slack huddle in progress is rejoinable from its room id', () => {
  const r = resolveNewBotTarget({ instances: [inCall('d', 'slack-t0abc-c0def')] });
  assert.equal(r.action, 'join');
  assert.equal(r.provider, 'slack');
  assert.equal(r.url, 'https://app.slack.com/client/T0ABC/C0DEF');
});

test('a Zoom call in progress cannot be rejoined from its room id → error asking for the link', () => {
  const r = resolveNewBotTarget({ instances: [inCall('d', 'zoom-12345678901')] });
  assert.equal(r.action, 'error');
  assert.match(r.error, /meeting link/);
});

// --- explicit targets ---------------------------------------------------------

test('a bad explicit target is an error, never a silent fall-through to detection', () => {
  const r = resolveNewBotTarget({ explicit: 'not-a-call', instances: [inCall('d', 'aaa-bbbb-ccc')] });
  assert.equal(r.action, 'error');
  const lookup = resolveNewBotTarget({ explicit: 'https://meet.google.com/lookup/abc' });
  assert.equal(lookup.action, 'error');
  assert.match(lookup.error, /meet code/);
});

test('a blank explicit target means "none given"', () => {
  assert.equal(resolveNewBotTarget({ explicit: '   ' }).action, 'new');
});

test('parseCallTarget accepts every provider join_call does', () => {
  assert.deepEqual(parseCallTarget('ABC-DEFG-HIJ'),
    { ok: true, provider: 'meet', roomId: 'abc-defg-hij', url: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(parseCallTarget('meet.google.com/abc-defg-hij').roomId, 'abc-defg-hij');
  const slack = parseCallTarget('https://app.slack.com/client/T0ABC/C0DEF');
  assert.equal(slack.provider, 'slack');
  assert.equal(slack.roomId, 'slack-t0abc-c0def');
  const zoom = parseCallTarget('https://us02web.zoom.us/j/12345678901?pwd=xyz');
  assert.equal(zoom.provider, 'zoom');
  assert.equal(zoom.url, 'https://us02web.zoom.us/j/12345678901?pwd=xyz', 'passcode kept');
  assert.equal(parseCallTarget('https://teams.live.com/meet/9371234567890?p=abc').provider, 'teams');
  assert.equal(parseCallTarget('').ok, false);
});

test('roomIdToJoinUrl round-trips Meet and Slack only', () => {
  assert.equal(roomIdToJoinUrl('aaa-bbbb-ccc'), 'https://meet.google.com/aaa-bbbb-ccc');
  assert.equal(roomIdToJoinUrl('slack-t1-c2'), 'https://app.slack.com/client/T1/C2');
  assert.equal(roomIdToJoinUrl('zoom-12345678901'), null);
  assert.equal(roomIdToJoinUrl('no-room'), null);
  assert.equal(roomIdToJoinUrl(null), null);
});

// --- a summoned bot does not run its setup in someone else's call ---------------

test('--summoned rides on /join-call, after the code', () => {
  assert.equal(joinSlashCommand({ slashCmd: 'join-call', meetCode: 'aaa-bbbb-ccc', botName: 'Rowan', summoned: true }),
    '/join-call aaa-bbbb-ccc --summoned Rowan');
  assert.equal(joinSlashCommand({ slashCmd: 'join-call', meetCode: 'aaa-bbbb-ccc', botName: 'Rowan' }),
    '/join-call aaa-bbbb-ccc Rowan', 'unchanged when not summoned');
  assert.equal(joinSlashCommand({ slashCmd: 'onboarding-call', meetCode: 'aaa-bbbb-ccc', botName: 'Rowan', summoned: true }),
    '/onboarding-call aaa-bbbb-ccc Rowan', 'never on the onboarding command');
});

test('both agent hosts carry --summoned through', () => {
  const base = { meetCode: 'aaa-bbbb-ccc', botName: 'Rowan', summoned: true };
  const headless = buildAgentArgs(base);
  assert.equal(headless[headless.indexOf('-p') + 1], '/join-call aaa-bbbb-ccc --summoned Rowan');
  assert.equal(buildInteractiveAgentArgs(base).at(-1), '/join-call aaa-bbbb-ccc --summoned Rowan');
});

test('/join-call knows to skip onboarding for a summoned bot', () => {
  const skill = readFileSync(join(root, 'mcp-server/join-call-skill.md'), 'utf8');
  assert.match(skill, /--summoned/);
  assert.match(skill, /Skip the onboarding hand-off/);
});

// --- main.js wiring (it cannot be imported) -----------------------------------

const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const adopt = main.slice(main.indexOf('adoptSessionAsBot = async'), main.indexOf("ipcMain.handle('adopt-session-as-bot'"));

test('the call is decided BEFORE a profile is created, so "ask" leaves no orphan bot', () => {
  const decideAt = adopt.indexOf('resolveNewBotTarget(');
  const askAt = adopt.indexOf('needsChoice: true');
  const createAt = adopt.indexOf('nextBotProfileName()');
  assert.ok(decideAt > 0 && askAt > 0 && createAt > 0);
  assert.ok(decideAt < createAt && askAt < createAt);
});

test('the new bot is always a NEW profile, launched with the call — never an existing one redirected', () => {
  assert.match(adopt, /const name = nextBotProfileName\(\)/);
  assert.match(adopt, /--join-url=\$\{call\.url\}/);
  assert.match(adopt, /--summoned=true/);
  assert.match(adopt, /!result\.launched/, 'refuses if the profile turned out to be running already');
});

test('a fresh Meet is made by the instance that got the request, not the brand-new one', () => {
  assert.match(adopt, /websiteRequest\('\/api\/meet\/create'/);
});

test('the new instance joins at launch with its agent, via the shared join paths', () => {
  assert.match(main, /if \(cliArgs\['join-url'\]\) \{\s*\n\s*joinSummonedCall\(/);
  const helper = main.slice(main.indexOf('function joinSummonedCall'), main.indexOf('async function websiteRequest'));
  assert.match(helper, /joinMeetUrl\(t\.url, \{ summoned \}\)/);
  assert.match(helper, /launchClaudeTerminal\(room, \{ summoned \}\)/);
});

test('the browser scan used by /call-new-bot is the SAME script as the background Meet poll', () => {
  assert.match(main, /const appleScript = browserTabScanScript\(\);/);
  assert.match(main, /execFile\('osascript', \['-e', browserTabScanScript\(\)\]/);
});
