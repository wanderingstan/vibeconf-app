// Zoom: know when a human is speaking (#847 follow-up). While someone talks,
// Zoom swaps their participants-pane row's mic <svg> for
// <span class="participants-icon__voip-speaking-icon">. The provider reads that,
// and the preload turns it into the same events Meet's tracker sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ZOOM } = require('../packages/calls/providers/zoom-selectors.js');
const { ZoomProvider } = require('../packages/calls/providers/zoom-provider.js');

// Fake participants pane: one .participants-li per person, aria-label in Zoom's
// real format, and the speaking icon present or not.
function fakeRows(rows) {
  const els = rows.map(({ aria, speaking }) => ({
    getAttribute: (a) => (a === 'aria-label' ? aria : null),
    querySelector: (sel) => (sel === ZOOM.people.speakingIcon && speaking ? {} : null),
  }));
  return { querySelectorAll: (sel) => (sel === ZOOM.people.item ? els : []), querySelector: () => null };
}

test('the speaking icon in a row means speaking; the bot’s own row never counts', () => {
  const p = new ZoomProvider();
  const doc = fakeRows([
    { aria: 'Stan (Host),computer audio unmuted,video on', speaking: true },
    { aria: 'Anya,computer audio unmuted,video off', speaking: false },
    { aria: 'Jimmy (me),computer audio unmuted,video on', speaking: true },
  ]);
  p.doc = () => doc;
  const parts = p.getParticipants();
  assert.deepEqual(parts.map((x) => [x.name, x.speaking, x.isSelf]), [
    ['Stan', true, false],
    ['Anya', false, false],
    ['Jimmy', false, true],
  ]);
});

test('the selector is the class verified live', () => {
  assert.equal(ZOOM.people.speakingIcon, '.participants-icon__voip-speaking-icon');
});

test('the zoom session polls speaking and sends both of Meet’s events, and reopens a closed pane', () => {
  const src = readFileSync(join(root, 'packages/calls/providers/zoom-session.js'), 'utf8');
  const poll = src.slice(src.indexOf('function pollSpeaking()'), src.indexOf('const run = () =>'));
  assert.match(poll, /emit\(CALL_EVENTS\.speakingChanged, \{ name: p\.name, speaking: p\.speaking \}\)/);
  assert.match(poll, /emit\(CALL_EVENTS\.participantsUpdated, parts\)/);
  assert.match(poll, /if \(was\) emit\(CALL_EVENTS\.speakingChanged, \{ name, speaking: false \}\)/);
  assert.match(poll, /provider\.openParticipants\(\)/);
  // The pane counts as open when ROWS exist; the list container can be absent
  // while rows are readable (live, 2026-10-16), and checking it disabled polling.
  assert.match(poll, /if \(!d\.querySelector\(ZOOM\.people\.item\)\)/);
  assert.match(src, /setInterval\(pollSpeaking, 250\)/);
});
