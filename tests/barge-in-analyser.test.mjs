// barge-in-analyser.test.mjs — a human must be able to take the floor from a
// talking bot on the ANALYSER's evidence alone (#138).
//
// Reported live: "you're not stopping when we start speaking." The detection was
// never the problem. From that call's log: 221 analyser speech-ONs, 5 barge-in
// arms, 1 actual back-off. Two code paths, one floor:
//
//   • at audio-start, the gate read `floorBusy` (analyser OR DOM) — worked all
//     call, stashing and replaying correctly
//   • mid-utterance, _armBargeIn was only reachable from Meet's DOM rising edge
//     — and while bot TTS is playing that edge frequently never arrives, or
//     trails the analyser by 170-1210ms
//
// setAudioFloor ended with `this._onFloorChanged?.()`, a hook that was never
// assigned anywhere in the repo. The optional-call made the whole fast path a
// silent no-op. These tests pin the hook AND the gates downstream of it, since
// arming is worthless if _evaluateBargeIn then bails on the DOM signal.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const GRACE_MS = 40; // fixed + short: these tests are about arming, not #367

function makeServer({ fast = true, ...prefs } = {}) {
  const stops = [];
  const s = new LocalServer({
    port: 0,
    onStopTts: (reason) => stops.push(reason),
    getPref: (k) => ({
      fastFloorDetection: fast,
      bargeInUrgencyScaling: false, // pin the grace; urgency scaling is #367
      bargeInGraceMs: GRACE_MS,
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

// The room as the DOM speaker tracker sees it. `speaking: []` is the case that
// matters here: people are present, Meet just isn't flagging any of them.
function setDom(s, speaking = []) {
  s.setParticipants(
    ['Stan', 'Seth'].map((name) => ({ name, speaking: speaking.includes(name), isSelf: false })),
  );
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('the _onFloorChanged hook exists — setAudioFloor was calling into nothing', () => {
  // The bug in one line: `this._onFloorChanged?.()` with no assignment anywhere.
  // Optional-call syntax turns a missing hook into a silent no-op, so the
  // comment above it ("wake anyone gated on the floor") promised a behaviour the
  // code did not have. A plain method can't rot the same way.
  const s = makeServer();
  assert.equal(typeof s._onFloorChanged, 'function');
});

test('analyser-only speech interrupts a talking bot', async () => {
  const s = makeServer();
  setDom(s, []);                 // nobody flagged by the DOM tracker
  s._setBotState('speaking');
  assert.equal(s.botState, 'speaking');

  s.setAudioFloor(true);         // the analyser hears a human ~400ms early
  assert.ok(s._bargeInTimer, 'the fast edge must arm the back-off monitor');

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, ['human-interrupt'],
    'grace elapsed with the floor still busy — the bot must stop talking');
  assert.equal(s.botState, 'yielding');
});

test('a bot that starts talking into an already-hot analyser arms at once', async () => {
  // The other entry point: _setBotState('speaking') while the floor is already
  // busy. It read anyoneSpeaking, so an analyser-only floor slipped past it too.
  const s = makeServer();
  setDom(s, []);
  s.setAudioFloor(true);
  s._setBotState('speaking');
  assert.ok(s._bargeInTimer, 'no waiting for a DOM edge that may never come');

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, ['human-interrupt']);
});

test('the DOM dropping a speaker does not disarm while the analyser still hears them', async () => {
  // Meet's tracker loses a speaker mid-utterance routinely (it counts mic-meter
  // mutations in a window). Trusting that falling edge alone cancelled live
  // interruptions before the grace could ever elapse.
  const s = makeServer();
  setDom(s, ['Stan']);
  s._setBotState('speaking');
  s.setAudioFloor(true);
  assert.ok(s._bargeInTimer);

  setDom(s, []);                 // DOM says quiet; the analyser disagrees
  assert.ok(s._bargeInTimer, 'the room is not quiet — keep the monitor armed');

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, ['human-interrupt']);
});

test('a floor that genuinely reopens during grace lets the bot finish', async () => {
  // The flip side. Both signals quiet before the timer fires ⇒ no back-off; a
  // cough must not cost the bot its sentence.
  const s = makeServer();
  setDom(s, ['Stan']);
  s._setBotState('speaking');
  s.setAudioFloor(true);
  s.setAudioFloor(false);
  setDom(s, []);

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, [], 'nobody is speaking any more — keep talking');
  assert.equal(s.botState, 'speaking');
});

test('with fastFloorDetection off, the analyser stays advisory', async () => {
  // The escape hatch has to actually reach this path: if the -55dB threshold is
  // too permissive on some room, `set_preference fastFloorDetection false`
  // restores DOM-only behaviour mid-call without a restart.
  const s = makeServer({ fast: false });
  setDom(s, []);
  s._setBotState('speaking');
  s.setAudioFloor(true);

  await settle(GRACE_MS + 40);
  assert.equal(s._bargeInTimer, null);
  assert.deepEqual(s.stops, []);
  assert.equal(s.botState, 'speaking');
});

test('a named bot interrupter still gets the bot-vs-bot random delay', async () => {
  // The analyser can't tell a bot from a human, so its solo verdict is "human"
  // (yield — talking over a person is the worse failure). When the DOM DOES name
  // the interrupter and it's a registered bot, the #154 tie-break still owns it.
  const s = makeServer({ bargeInBotRandomMinMs: 400, bargeInBotRandomMaxMs: 401 });
  s.members = [{ name: 'Pepper', role: 'bot' }];
  s.setParticipants([{ name: 'Pepper', speaking: true, isSelf: false }]);
  s._setBotState('speaking');
  s.setAudioFloor(true);

  await settle(GRACE_MS + 40);
  assert.deepEqual(s.stops, [], 'bot-vs-bot: wait out the random delay first');
  assert.ok(s._bargeInTimer, 're-armed for the tie-break');
  s._clearBargeIn('test done');
});
