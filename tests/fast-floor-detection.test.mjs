// fast-floor-detection.test.mjs — the analyser-based floor signal (#115).
//
// Every turn-taking gate consumes "is anyone speaking". Today that comes from
// counting mutations on Meet's mic-meter DOM: MIN_MUTATIONS = 3 inside a 1200ms
// window (google-meet-provider.js), so it lands ~400-700ms after speech starts.
//
// That latency is load-bearing. A bot-vs-bot speak delay only converts into a
// yield if the loser can SEE the winner first, so #100 had to widen the jitter
// window to 2000ms purely to out-wait the detector — up to 2.9s of added lag.
//
// Meanwhile page-inject already runs a Web Audio AnalyserNode on every remote
// track, sampling each animation frame (~16ms) and computing RMS -> dB. It was
// built to gate STT and never published upward. This wires it through as a
// SEPARATE signal so both can be compared on a real call before anything
// switches over.
//
// Default OFF on purpose: the -55dB threshold was tuned for STT, and one that's
// too sensitive means the bot believes someone is always talking and never
// speaks at all. The failure mode is silence, which is hard to notice.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PREFERENCES } = require('../electron-app/preferences-schema.js');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const srv = (fast) => {
  const s = new LocalServer({ port: 0 });
  const real = s._pref.bind(s);
  s._pref = (k) => (k === 'fastFloorDetection' ? fast : real(k));
  return s;
};

test('the experiment ships OFF — a bad threshold would silence the bot entirely', () => {
  assert.equal(PREFERENCES.fastFloorDetection.default, false,
    'enable only after the floor-latency log lines show the analyser leading cleanly');
});

test('with it off, the floor is exactly the DOM signal — todays behaviour', () => {
  const s = srv(false);
  s.anyoneSpeaking = false;
  s.setAudioFloor(true);
  assert.equal(s.audioFloorSpeaking, true, 'still RECORDED, so the comparison data accrues');
  assert.equal(s.floorBusy, false, 'but not consumed');

  s.anyoneSpeaking = true;
  assert.equal(s.floorBusy, true);
});

test('with it on, the analyser can open the gate before the DOM path agrees', () => {
  const s = srv(true);
  s.anyoneSpeaking = false;              // DOM hasn't noticed yet
  assert.equal(s.floorBusy, false);
  s.setAudioFloor(true);                 // analyser hears it ~400ms earlier
  assert.equal(s.floorBusy, true, 'this is the whole point of the change');
});

test('with it on, the DOM path still counts — the analyser can MISS', () => {
  // A threshold set too high, or a participant with no remote track yet, must
  // not make the floor look free. Either signal busy means busy.
  const s = srv(true);
  s.setAudioFloor(false);
  s.anyoneSpeaking = true;
  assert.equal(s.floorBusy, true, 'belt and braces: the union, never the analyser alone');
});

test('the floor clears only when BOTH agree it is quiet', () => {
  const s = srv(true);
  s.anyoneSpeaking = true;
  s.setAudioFloor(true);
  assert.equal(s.floorBusy, true);

  s.setAudioFloor(false);
  assert.equal(s.floorBusy, true, 'DOM still says busy');
  s.anyoneSpeaking = false;
  assert.equal(s.floorBusy, false);
});

test('setAudioFloor ignores repeats, so the edge timestamp is a real edge', () => {
  const s = srv(true);
  s.setAudioFloor(true, 1000);
  const first = s._audioFloorAt;
  s.setAudioFloor(true, 5000);
  assert.equal(s._audioFloorAt, first,
    'a repeated ON must not push the timestamp forward — the latency measurement depends on it');
});

test('a fresh server starts with a free floor and no stale edge', () => {
  const s = new LocalServer({ port: 0 });
  assert.equal(s.audioFloorSpeaking, false);
  assert.equal(s._audioFloorAt, 0);
  assert.equal(s.floorBusy, false);
});
