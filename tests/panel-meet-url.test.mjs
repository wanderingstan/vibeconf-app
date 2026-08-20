// panel-meet-url.test.mjs — a pasted Meet link must never get the host twice.
//
// Reported live on 2026-08-19, from an Ubuntu box, with the app refusing to
// join:
//
//   Scripty could not join the call. The page ended up at
//   https://meet.google.com/meet.google.com/wcj-odpo-wrb instead of the meeting
//
// The panel decided whether to prepend the host with `url.startsWith('http')`.
// That misses the single most common paste there is: "meet.google.com/xxx".
// Chrome HIDES the scheme in its address bar, so copying a Meet link from
// there — or out of a chat message, or a calendar entry — hands you a
// host-qualified string with no https://. It failed the startsWith test, so
// the host went on a second time.
//
// Why it survived so long: the MCP path (mcp-server/meet-room.js, #314/#319)
// already normalised this, so `/join-call` was fine. Only the panel was broken
// — the front door for anyone driving the app by hand, and therefore the path
// our agent-based testing never exercises.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const panelSrc = readFileSync(join(root, 'electron-app/renderer/panel.js'), 'utf8');

// panel.js is a renderer module bound to the DOM, so lift the one pure function
// out by source rather than importing the whole thing — same approach as
// chat-scrape-attribution and meter-level-speaking.
function loadToMeetUrl() {
  const m = panelSrc.match(/function toMeetUrl\(raw\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'toMeetUrl not found in panel.js — was it renamed?');
  return new Function(`${m[0]}; return toMeetUrl;`)();
}

test('a scheme-less "meet.google.com/xxx" paste does not double the host', () => {
  const toMeetUrl = loadToMeetUrl();
  // The exact string from the live failure.
  assert.equal(toMeetUrl('meet.google.com/wcj-odpo-wrb'),
    'https://meet.google.com/wcj-odpo-wrb');
});

test('every accepted paste shape resolves to one canonical URL', () => {
  const toMeetUrl = loadToMeetUrl();
  const cases = [
    ['wcj-odpo-wrb', 'https://meet.google.com/wcj-odpo-wrb'],          // bare code
    ['meet.google.com/wcj-odpo-wrb', 'https://meet.google.com/wcj-odpo-wrb'],
    ['www.meet.google.com/wcj-odpo-wrb', 'https://meet.google.com/wcj-odpo-wrb'],
    ['https://meet.google.com/wcj-odpo-wrb', 'https://meet.google.com/wcj-odpo-wrb'],
    ['  meet.google.com/wcj-odpo-wrb  ', 'https://meet.google.com/wcj-odpo-wrb'], // pasted whitespace
    ['MEET.GOOGLE.COM/wcj-odpo-wrb', 'https://meet.google.com/wcj-odpo-wrb'],     // case-insensitive
  ];
  for (const [input, expected] of cases) {
    assert.equal(toMeetUrl(input), expected, `for input ${JSON.stringify(input)}`);
  }
});

test('an explicit scheme is left alone, including http and odd casing', () => {
  const toMeetUrl = loadToMeetUrl();
  // Not silently upgraded to https: whatever the user pasted is what they get.
  assert.equal(toMeetUrl('http://meet.google.com/wcj-odpo-wrb'),
    'http://meet.google.com/wcj-odpo-wrb');
  assert.equal(toMeetUrl('HTTPS://meet.google.com/wcj-odpo-wrb'),
    'HTTPS://meet.google.com/wcj-odpo-wrb');
});

test('no input produces a doubled host', () => {
  const toMeetUrl = loadToMeetUrl();
  const inputs = [
    'wcj-odpo-wrb', 'meet.google.com/wcj-odpo-wrb',
    'www.meet.google.com/wcj-odpo-wrb', 'https://meet.google.com/wcj-odpo-wrb',
    '  meet.google.com/wcj-odpo-wrb  ', 'MEET.GOOGLE.COM/wcj-odpo-wrb',
    '', '   ', 'meet.google.com/',
  ];
  for (const input of inputs) {
    const hosts = (toMeetUrl(input).match(/meet\.google\.com/gi) || []).length;
    assert.ok(hosts <= 1,
      `${JSON.stringify(input)} produced ${hosts} hosts: ${toMeetUrl(input)}`);
  }
});

test('null and undefined do not throw — the field can be empty', () => {
  const toMeetUrl = loadToMeetUrl();
  // The join button reads a text input, so this is reachable, not theoretical.
  assert.equal(toMeetUrl(null), 'https://meet.google.com/');
  assert.equal(toMeetUrl(undefined), 'https://meet.google.com/');
});

test('both prepend sites go through toMeetUrl, not startsWith', () => {
  // The original bug existed at TWO sites (isJoinableUrl and the join-button
  // handler). Fixing one and missing the other would look fixed in the panel's
  // validation while still failing the actual navigation, so pin both.
  assert.ok(!/url\.startsWith\('http'\)\s*\?/.test(panelSrc),
    'isJoinableUrl still uses the startsWith test');
  assert.ok(!/if \(!url\.startsWith\('http'\)\) url = 'https:\/\/meet\.google\.com\/'/.test(panelSrc),
    'the join-button handler still prepends the host directly');
  const uses = (panelSrc.match(/toMeetUrl\(/g) || []).length;
  // definition + isJoinableUrl + join handler
  assert.ok(uses >= 3, `expected toMeetUrl at both call sites, found ${uses} references`);
});
