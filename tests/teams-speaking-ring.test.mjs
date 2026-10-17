// #847: on Teams the bot couldn't tell when a human was speaking (peakSpeakers
// always 0), so it talked over people. The signal turned out to be each tile's
// speaking ring: the ::before opacity of [data-tid="voice-level-stream-outline"]
// (1 while that person talks, 0 otherwise). These pin the provider reading it,
// and the preload turning it into the same events Meet's tracker sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A minimal fake of the Teams stage: tiles keyed by data-tid, each with an
// outline whose ::before opacity the test controls.
function fakeStage(tiles) {
  const els = tiles.map(({ name, ring, outline = true }) => {
    const outlineEl = outline ? { ring } : null;
    return {
      getAttribute: (a) => (a === 'data-tid' ? 'video-item-container-' + name : null),
      querySelector: (sel) => (sel === '[data-tid="voice-level-stream-outline"]' ? outlineEl : null),
    };
  });
  globalThis.document = { querySelectorAll: () => els };
  globalThis.window = {
    getComputedStyle: (el, pseudo) => ({ opacity: pseudo === '::before' ? String(el.ring) : '1' }),
  };
}

const { TeamsProvider } = require('../electron-app/teams-provider.js');

test('a lit ring (::before opacity 1) is speaking; an unlit one (0) is not', () => {
  fakeStage([{ name: 'Stan James', ring: 1 }, { name: 'Anya', ring: 0 }]);
  const p = new TeamsProvider();
  p.selfName = 'Jimmy';
  assert.deepEqual(p.getParticipants(), [
    { name: 'Stan James', speaking: true, isSelf: false },
    { name: 'Anya', speaking: false, isSelf: false },
  ]);
});

test('the outline merely EXISTING is not speaking (the 2026-10-15 bug: everyone talking forever)', () => {
  fakeStage([{ name: 'Stan James', ring: 0 }]);
  const p = new TeamsProvider();
  assert.equal(p.getParticipants()[0].speaking, false);
});

test("the bot's own tile never counts as speaking, and a tile without an outline is silent", () => {
  fakeStage([{ name: 'Jimmy', ring: 1 }, { name: 'Ravi', outline: false }]);
  const p = new TeamsProvider();
  p.selfName = 'Jimmy';
  assert.deepEqual(p.getParticipants(), [
    { name: 'Jimmy', speaking: false, isSelf: true },
    { name: 'Ravi', speaking: false, isSelf: false },
  ]);
});

test('preload-teams polls the ring and sends both of Meet’s events: the roster (floor) and speakingChanged (presence)', () => {
  const src = readFileSync(join(root, 'electron-app/preload-teams.js'), 'utf8');
  const poll = src.slice(src.indexOf('function pollSpeaking()'), src.indexOf("window.addEventListener('DOMContentLoaded'"));
  assert.match(poll, /emit\(CALL_EVENTS\.speakingChanged, \{ name: p\.name, speaking: p\.speaking \}\)/);
  assert.match(poll, /emit\(CALL_EVENTS\.participantsUpdated, parts\)/);
  // A participant who leaves while lit gets a closing edge.
  assert.match(poll, /if \(was\) emit\(CALL_EVENTS\.speakingChanged, \{ name, speaking: false \}\)/);
  // Polled faster than the 1s heartbeat.
  assert.match(src, /setInterval\(pollSpeaking, 250\)/);
});
