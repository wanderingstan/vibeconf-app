// barge-in-ring-corroboration.test.mjs — the floor when there is no analyser
// (#847: Teams can't tell who's speaking, so a tile's speaking ring decides).
//
// Live on Teams (call teams-9361264884308-20261016T172706Z) the ring was a
// good "is the room quiet?" signal and a poor "someone started talking now"
// one: it lit for a cough, for noise, for the bot's own voice echoed through a
// listener's laptop speakers, and once stayed lit 31s with no captions while
// the bot held its reply. With no floor-audio events this call:
//   - mid-speech, a ring alone is ridden out until a caption from that person
//     corroborates it, or it has been lit ringOnlyYieldMs;
//   - at audio start, a ring lit ringStaleMs with no caption stops counting.
// With the analyser working (Meet), none of this applies.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

// Scaled down so the suite stays fast; the ratios match the defaults
// (grace < ringOnlyYieldMs < ringStaleMs).
const GRACE_MS = 40;
const RING_ONLY_YIELD_MS = 200;
const RING_STALE_MS = 250;

function makeServer(prefs = {}) {
  const stops = [];
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onStopTts: (reason) => stops.push(reason),
    onBotSpeech: (text) => spoken.push(text),
    getPref: (k) => ({
      fastFloorDetection: true,
      bargeInUrgencyScaling: false,
      bargeInGraceMs: GRACE_MS,
      bargeInClearHangoverMs: 0,
      bargeInQuietConfirmMs: 20,
      botSpeakJitterMaxMs: 0,
      bargeInAckExempt: false,
      probeFiring: false,
      ringOnlyYieldMs: RING_ONLY_YIELD_MS,
      ringCaptionWindowMs: 100,
      ringStaleMs: RING_STALE_MS,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.stops = stops;
  s.spoken = spoken;
  return s;
}

function setRing(s, speaking = []) {
  s.setParticipants(
    ['Stan James', 'Seth'].map((name) => ({ name, speaking: speaking.includes(name), isSelf: false })),
  );
}

let turnId = 1;
function caption(s, speaker, text) {
  s.updateTurns([{ turnId: turnId++, speaker, text, isBottommost: true }]);
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('no analyser: a short ring during TTS with no caption is ridden out', async () => {
  const s = makeServer();
  s._setBotState('speaking');
  setRing(s, ['Stan James']);            // cough / echo lights the ring
  assert.ok(s._bargeInTimer, 'monitor armed');
  await settle(GRACE_MS + 30);           // grace expired, ring only: held
  assert.deepEqual(s.stops, [], 'a ring alone must not cut the bot off');
  assert.ok(s._ringHoldPending, 'waiting on corroboration');
  setRing(s, []);                        // ring goes out before ringOnlyYieldMs
  await settle(RING_ONLY_YIELD_MS + 50);
  assert.deepEqual(s.stops, [], 'the blip ended: keep the sentence');
  assert.equal(s.botState, 'speaking');
});

test('no analyser: ring + a caption from that speaker yields at the grace', async () => {
  const s = makeServer();
  s._setBotState('speaking');
  setRing(s, ['Stan James']);
  caption(s, 'Stan James', 'hold on a second');
  await settle(GRACE_MS + 30);
  assert.deepEqual(s.stops, ['human-interrupt']);
});

test('no analyser: a caption arriving while held yields at once, not at ringOnlyYieldMs', async () => {
  const s = makeServer();
  s._setBotState('speaking');
  setRing(s, ['Stan James']);
  await settle(GRACE_MS + 20);
  assert.deepEqual(s.stops, [], 'held on the ring alone');
  caption(s, 'Stan James', 'wait, no');  // the corroboration lands
  assert.deepEqual(s.stops, ['human-interrupt'], 'yields on the caption, synchronously');
});

test('no analyser: a caption from someone ELSE does not corroborate the ring', async () => {
  const s = makeServer();
  s._setBotState('speaking');
  setRing(s, ['Stan James']);
  caption(s, 'Seth', 'mm-hm');
  await settle(GRACE_MS + 30);
  assert.deepEqual(s.stops, []);
});

test('no analyser: a long ring with no caption yields after ringOnlyYieldMs', async () => {
  const s = makeServer();
  s._setBotState('speaking');
  setRing(s, ['Stan James']);            // overlap: captions dropped out
  await settle(RING_ONLY_YIELD_MS - 60);
  assert.deepEqual(s.stops, [], 'still riding it out before the threshold');
  await settle(120);
  assert.deepEqual(s.stops, ['human-interrupt'], 'a sustained ring is believed');
});

test('no analyser: the ring still holds a reply at audio start', async () => {
  const s = makeServer();
  setRing(s, ['Stan James']);
  assert.equal(await s._speakWithBotJitter({ text: 'A reply.' }), 'stashed');
  assert.deepEqual(s.spoken, []);
});

test('no analyser: a stale ring with no captions stops blocking the start of speech', async () => {
  const s = makeServer();
  setRing(s, ['Stan James']);            // latched on, room silent
  assert.equal(s.floorBusy, true);
  await settle(RING_STALE_MS + 40);      // the re-check timer re-reads the floor
  assert.equal(s.floorBusy, false, 'a ring lit ringStaleMs with no caption is not speech');
  assert.ok(s.lastSpeechStoppedAt, 'treated as a stop, so the silence gate can open');
  assert.equal(await s._speakWithBotJitter({ text: 'A reply.' }), 'spoken');
  assert.deepEqual(s.spoken, ['A reply.']);
});

test('no analyser: captions keep a long ring counting, and revive a stale one', async () => {
  const s = makeServer();
  setRing(s, ['Stan James']);
  await settle(RING_STALE_MS - 80);
  caption(s, 'Stan James', 'so the thing is');
  await settle(120);                     // ring now older than ringStaleMs, caption is not
  assert.equal(s.floorBusy, true, 'captioned speech is speech, however long');
  await settle(RING_STALE_MS);
  assert.equal(s.floorBusy, false, 'captions stopped, ring stale');
  caption(s, 'Stan James', 'so the thing is that we');
  assert.equal(s.floorBusy, true, 'a new caption makes the ring count again');
});

test('tile and caption names that differ by a suffix still match', async () => {
  const s = makeServer();
  s._setBotState('speaking');
  setRing(s, ['Stan James']);
  caption(s, 'Stan James (Guest)', 'excuse me');
  await settle(GRACE_MS + 30);
  assert.deepEqual(s.stops, ['human-interrupt']);
});

test('analyser active (Meet): a ring-only interruption yields at the grace, as before', async () => {
  const s = makeServer({ ringOnlyYieldMs: 10_000 });
  s._setBotState('speaking');
  s.setAudioFloor(true);                 // the analyser hears them first
  setRing(s, ['Stan James']);
  await settle(GRACE_MS + 30);
  assert.deepEqual(s.stops, ['human-interrupt'], 'no corroboration wait with an analyser');
  assert.equal(s._ringHoldPending, false);
});

test('analyser active (Meet): a long ring is never discounted as stale', async () => {
  const s = makeServer();
  s.setAudioFloor(true);
  s.setAudioFloor(false);                // analyser proven, now quiet
  setRing(s, ['Stan James']);
  await settle(RING_STALE_MS + 60);
  assert.equal(s.floorBusy, true, 'Meet keeps trusting the tracker flag');
  assert.equal(s._ringStaleTimer, null, 'no stale re-check scheduled');
});

test('a new call starts without an analyser again', () => {
  const s = makeServer();
  s.setAudioFloor(true);
  assert.equal(s._ringFloorActive(), false);
  s.setRoom('next-room');
  assert.equal(s._ringFloorActive(), true);
});
