// zoom-selectors.test.mjs — unit tests for the pure Zoom URL/aria helpers
// (#318): meeting-link parsing, the web-client URL the bot loads, the room code,
// and the participant/chat aria-label parsers harvested in the 2026-07-05 recon.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ZOOM } = require('../electron-app/zoom-selectors.js');

test('meetingNumberFromUrl: invite links and both web-client path forms', () => {
  assert.equal(ZOOM.meetingNumberFromUrl('https://us05web.zoom.us/j/81234567890?pwd=abc'), '81234567890');
  assert.equal(ZOOM.meetingNumberFromUrl('https://app.zoom.us/wc/81234567890/join'), '81234567890');
  assert.equal(ZOOM.meetingNumberFromUrl('https://app.zoom.us/wc/join/81234567890'), '81234567890');
  assert.equal(ZOOM.meetingNumberFromUrl('https://zoom.us/myhome'), null);
  assert.equal(ZOOM.meetingNumberFromUrl(''), null);
  assert.equal(ZOOM.meetingNumberFromUrl(null), null);
});

test('isZoomUrl: zoom.us and tenant subdomains only, and only with a meeting number', () => {
  assert.equal(ZOOM.isZoomUrl('https://zoom.us/j/81234567890'), true);
  assert.equal(ZOOM.isZoomUrl('https://acme.zoom.us/j/81234567890?pwd=x'), true);
  assert.equal(ZOOM.isZoomUrl('https://app.zoom.us/wc/join/81234567890'), true);
  assert.equal(ZOOM.isZoomUrl('https://us05web.zoom.us/myhome'), false);
  // Suffix match must be on a label boundary: notzoom.us is someone else.
  assert.equal(ZOOM.isZoomUrl('https://notzoom.us/j/81234567890'), false);
  assert.equal(ZOOM.isZoomUrl('https://meet.google.com/abc-defg-hij'), false);
  assert.equal(ZOOM.isZoomUrl('not a url'), false);
});

test('webClientJoinUrl: rewrites any meeting link to the direct /wc/join URL, keeping the passcode', () => {
  assert.equal(
    ZOOM.webClientJoinUrl('https://us05web.zoom.us/j/81234567890?pwd=Ab12.1'),
    'https://app.zoom.us/wc/join/81234567890?pwd=Ab12.1',
  );
  assert.equal(ZOOM.webClientJoinUrl('https://zoom.us/j/81234567890'), 'https://app.zoom.us/wc/join/81234567890');
  assert.equal(ZOOM.webClientJoinUrl('https://zoom.us/myhome'), null);
});

test('the room code is zoom-<number> and a valid local-server slug', () => {
  const code = ZOOM.roomCodeFromUrl('https://zoom.us/j/81234567890?pwd=x');
  assert.equal(code, 'zoom-81234567890');
  // The pattern the local-server /api/sync/:room route accepts.
  assert.match(code, /^[a-z0-9-]+$/);
});

test('parseParticipantAria: name, self/host markers and A/V state', () => {
  assert.deepEqual(ZOOM.parseParticipantAria('Stan (Host, me),computer audio muted,video off'), {
    name: 'Stan', isSelf: true, isHost: true, audioMuted: true, videoOn: false,
  });
  assert.deepEqual(ZOOM.parseParticipantAria('Seth,computer audio unmuted,video on'), {
    name: 'Seth', isSelf: false, isHost: false, audioMuted: false, videoOn: true,
  });
  // "me" with no role, and as co-host: still self, role parens stripped.
  assert.deepEqual(
    [ZOOM.parseParticipantAria('Bot (me),video off').isSelf, ZOOM.parseParticipantAria('Bot (me)').name],
    [true, 'Bot'],
  );
  assert.equal(ZOOM.parseParticipantAria('Ana (Co-host, me),video on').isSelf, true);
  assert.equal(ZOOM.parseParticipantAria('Ana (Co-host, me),video on').name, 'Ana');
  // No audio joined yet: the phrase is absent, so the state is unknown, not false.
  assert.equal(ZOOM.parseParticipantAria('Guest Bot').audioMuted, null);
  assert.equal(ZOOM.parseParticipantAria(''), null);
});

test('parseChatAria: sender, recipient, time and text (text may contain commas)', () => {
  assert.deepEqual(ZOOM.parseChatAria('You to Everyone, 12:05 PM, selector harvest test, with a comma'), {
    from: 'You', to: 'Everyone', time: '12:05 PM', text: 'selector harvest test, with a comma',
  });
  assert.equal(ZOOM.parseChatAria('garbage'), null);
});

test('viewingAriaRe: the presenter from the "You are viewing …\'s screen" indicator (#810)', () => {
  const name = (s) => (s.match(ZOOM.share.viewingAriaRe) || [])[1] || null;
  assert.equal(name("You are viewing Stan's screen,"), 'Stan'); // aria-label, verified live
  assert.equal(name('You are viewing  Ana Lima’s screen'), 'Ana Lima'); // textContent, curly apostrophe
  assert.equal(name('You are viewing James\'s screen'), 'James');
  assert.equal(name("You're screen sharing"), null); // the bot's OWN share bar is not someone else
});

test('mcp-server parses the same Zoom links into the same room id (it cannot import zoom-selectors, #708)', () => {
  // Pull the inline Zoom match out of join_call and run it against the cases
  // above, so the two parsers can't drift apart silently.
  const src = readFileSync(new URL('../mcp-server/server.js', import.meta.url), 'utf8');
  const hostRe = src.match(/const zoomMatch = (\/\^https\?.*?\/i)\.test/);
  const numRe = src.match(/String\(room_id\)\.match\((\/\\\/\(\?:j\|wc.*?\/)\);/);
  assert.ok(hostRe && numRe, 'join_call Zoom regexes not found in mcp-server/server.js');
  const toRe = (lit) => { const i = lit.lastIndexOf('/'); return new RegExp(lit.slice(1, i), lit.slice(i + 1)); };
  const host = toRe(hostRe[1]);
  const num = toRe(numRe[1]);
  const mcpRoom = (url) => (host.test(url) && url.match(num)) ? `zoom-${url.match(num)[1]}` : null;
  for (const url of [
    'https://us05web.zoom.us/j/81234567890?pwd=abc',
    'https://app.zoom.us/wc/81234567890/join',
    'https://app.zoom.us/wc/join/81234567890',
    'https://zoom.us/myhome',
    'https://notzoom.us/j/81234567890',
  ]) {
    const app = ZOOM.isZoomUrl(url) ? ZOOM.roomCodeFromUrl(url) : null;
    assert.equal(mcpRoom(url), app, url);
  }
});
