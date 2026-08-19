// barge-in-disarm-hangover.test.mjs — Meet's speaking meter returns to rest
// BETWEEN SYLLABLES, and those dips must not disarm the back-off monitor.
//
// Live evidence (call eqj-edyv-fdw, 2026-08-19): Stan spoke one continuous
// sentence over the bot and the bot talked straight through it. The raw
// detector events show why — his tile's meter fell to 0px for 300-900ms
// repeatedly mid-utterance, and every one of those arrived as a tracker
// falling edge, i.e. "the interrupter went silent". The monitor armed and
// cleared four times in five seconds; the bot only yielded on the fifth
// attempt, when a dip happened not to land inside the grace window.
//
// The #138 guard (only clear if the analyser agrees the room is quiet) did not
// help on that call: the analyser never tracked Stan at all — it logged OFF
// 17.7s stale — so floorBusy was false and the DOM flicker was the only vote.
//
// The fix is a hangover on the DISARM path only: a "went silent" edge has to
// still be true bargeInClearHangoverMs later before it may clear the monitor.
// Deliberately one-sided — floor-OPENING detection keeps the raw fast falling
// edge, because a false negative there costs latency while a false negative
// here means the bot talks over a human.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const GRACE_MS = 200;     // long enough to fit a dip + hangover inside it
const HANGOVER_MS = 40;   // scaled-down bargeInClearHangoverMs to keep tests fast

function makeServer(prefs = {}) {
  const stops = [];
  const s = new LocalServer({
    port: 0,
    onStopTts: (reason) => stops.push(reason),
    getPref: (k) => ({
      fastFloorDetection: true,
      bargeInUrgencyScaling: false,
      bargeInGraceMs: GRACE_MS,
      bargeInQuietConfirmMs: 0,
      bargeInClearHangoverMs: HANGOVER_MS,
      probeFiring: false,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.stops = stops;
  return s;
}

function setDom(s, speaking = []) {
  s.setParticipants(
    ['Stan', 'Seth'].map((name) => ({ name, speaking: speaking.includes(name), isSelf: false })),
  );
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('an inter-word meter dip does not disarm the monitor', async () => {
  // The eqj-edyv-fdw case: one continuous utterance whose meter blinks off and
  // straight back on. The monitor must survive the blink and still fire.
  const s = makeServer();
  s._setBotState('speaking');
  setDom(s, ['Stan']);                 // rising edge arms
  const armed = s._bargeInTimer;
  assert.ok(armed, 'monitor armed');

  setDom(s, []);                       // meter falls to rest between syllables
  await settle(HANGOVER_MS / 2);
  setDom(s, ['Stan']);                 // ...and he was talking the whole time
  assert.equal(s._bargeInTimer, armed, 'same monitor, never disarmed');

  await settle(GRACE_MS + 60);
  assert.deepEqual(s.stops, ['human-interrupt'], 'the human still wins the floor');
});

test('a genuine stop inside the grace still disarms', async () => {
  // The hangover must not become "never disarm": quiet that outlasts it is a
  // real stop, and the bot keeps its sentence.
  const s = makeServer();
  s._setBotState('speaking');
  setDom(s, ['Stan']);
  assert.ok(s._bargeInTimer, 'monitor armed');

  setDom(s, []);                       // and stays quiet
  await settle(HANGOVER_MS + 40);
  assert.equal(s._bargeInTimer, null, 'confirmed silence disarms the monitor');

  await settle(GRACE_MS + 60);
  assert.deepEqual(s.stops, [], 'interrupter gave up — no back-off');
  assert.equal(s.botState, 'speaking');
});

test('a fresh arm outranks a pending disarm', async () => {
  // Dip, then a new rising edge before the hangover expires. The pending clear
  // must not land on the newly-armed monitor a moment later.
  const s = makeServer();
  s._setBotState('speaking');
  setDom(s, ['Stan']);
  setDom(s, []);                       // schedules a deferred clear
  await settle(HANGOVER_MS / 2);
  setDom(s, ['Seth']);                 // someone is speaking again
  await settle(HANGOVER_MS + 20);
  assert.ok(s._bargeInTimer, 'monitor survived the stale pending disarm');

  await settle(GRACE_MS + 60);
  assert.deepEqual(s.stops, ['human-interrupt']);
});

test('bargeInClearHangoverMs=0 restores the old immediate clear', async () => {
  // The escape hatch: with the hangover off, the first falling edge disarms,
  // exactly as before this change.
  const s = makeServer({ bargeInClearHangoverMs: 0 });
  s._setBotState('speaking');
  setDom(s, ['Stan']);
  assert.ok(s._bargeInTimer, 'monitor armed');
  setDom(s, []);
  assert.equal(s._bargeInTimer, null, 'cleared synchronously, no hangover');
});
