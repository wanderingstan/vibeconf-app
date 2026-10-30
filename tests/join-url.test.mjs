// join-url.test.mjs: Phase 1 step 2 of the calls library. A call link is read in
// one place (call-target.js's platformFromUrl) and joined in one place (main.js's
// joinUrl). Before, five join paths each carried their own copy of the
// platform-to-join map, and they had drifted: calendar auto-join sent every
// non-Zoom, non-WhatsApp link to Teams, Slack included.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { platformFromUrl } = require('../packages/calls/core/call-target.js');
const main = readFileSync(new URL('../electron-app/main.js', import.meta.url), 'utf8');
const body = main.slice(main.indexOf('function joinUrl('), main.indexOf('// Join a call at launch because /call-new-bot'));

test('platformFromUrl reads every platform a link can join', () => {
  assert.equal(platformFromUrl('https://meet.google.com/abc-defg-hij').provider, 'meet');
  assert.equal(platformFromUrl('app.slack.com/client/T0ABC/C0DEF').url, 'https://app.slack.com/client/T0ABC/C0DEF');
  assert.equal(platformFromUrl('https://us05web.zoom.us/j/12345678901?pwd=x').roomId, 'zoom-12345678901');
  assert.equal(platformFromUrl('https://teams.microsoft.com/l/meetup-join/abc').provider, 'teams');
  assert.equal(platformFromUrl('https://web.whatsapp.com/call/video/AbCdEfGh1234').url, 'https://call.whatsapp.com/video/AbCdEfGh1234');
  assert.equal(platformFromUrl('https://example.com/meeting').ok, false);
});

test('joinUrl sends each platform to its own join', () => {
  assert.match(body, /case 'meet': joinMeetUrl\(t\.url, meetOpts\); return t\.roomId;/);
  assert.match(body, /case 'slack': activateSlackProvider\(t\.url, \{ autojoin: true \}\); return localServer\.roomId \|\| null;/);
  assert.match(body, /case 'zoom': return activateZoomProvider\(t\.url\);/);
  assert.match(body, /case 'teams': return activateTeamsProvider\(t\.url\);/);
  assert.match(body, /case 'whatsapp': return activateWhatsAppCallLink\(t\.url\);/);
});

test('joinUrl refuses a link for a different platform than the caller asked for', () => {
  assert.match(body, /if \(!t\.ok \|\| \(platform && t\.provider !== platform\)\) return null;/);
});

test('every join entry point goes through joinUrl', () => {
  for (const [label, re] of [
    ['agent join-slack', /onJoinSlack: \(url\) => \{[\s\S]*?return joinUrl\(url, \{ platform: 'slack' \}\);/],
    ['agent join-teams', /onJoinTeams: \(url\) => \{[\s\S]*?return joinUrl\(url, \{ platform: 'teams' \}\);/],
    ['agent join-zoom', /onJoinZoom: \(url\) => \{[\s\S]*?return joinUrl\(url, \{ platform: 'zoom' \}\);/],
    ['agent join-whatsapp', /onJoinWhatsApp: \(url\) => \{[\s\S]*?return joinUrl\(url, \{ platform: 'whatsapp' \}\);/],
    ['supervisor Add', /onJoinLink: \([\s\S]*?joinUrl\(url, \{ platform: provider \}\)/],
    ['calendar auto-join', /const room = joinUrl\(meetUrl, \{ platform: link\.provider \}\);/],
    ['panel pasted Slack link', /ipcMain\.on\('join-detected-slack'[\s\S]*?joinUrl\(url, \{ platform: 'slack' \}\)/],
    ['panel pasted link', /ipcMain\.on\(channel,[\s\S]*?joinUrl\(url, \{ platform \}\)/],
    ['/call-new-bot', /function joinSummonedCall[\s\S]*?joinUrl\(t\.url, \{ summoned \}\)/],
  ]) assert.match(main, re, label);
});

test('outside joinUrl, the activators are only called for launch flags and sign-in', () => {
  const rest = main.replace(body, '');
  const calls = [...rest.matchAll(/^.*\b(activate(?:Slack|Zoom|Teams)Provider|activateWhatsAppCallLink)\((?!\w+\) \{).*$/gm)]
    .map((m) => m[0].trim())
    .filter((l) => !/^function /.test(l) && !/^\/\//.test(l));
  for (const l of calls) {
    assert.match(l, /cliArgs\['(?:zoom|teams)-url'\]|'https:\/\/app\.slack\.com\/', \{ autojoin: false \}|ZOOM_SIGN_IN_URL/, `unexpected direct join: ${l}`);
  }
});
