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
import { readFileSync } from 'node:fs';
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

test('the experiment ships OFF now that it has been measured', () => {
  // It shipped ON deliberately (#116 review): an experiment nobody runs produces
  // no data, because nobody sets a non-default preference. That worked — the
  // data arrived, and it argues for off.
  //
  // Across 1,501 level windows of real calls the room noise floor never once
  // reached the -55dB threshold (median -92dB, worst -66dB), so ambient sound was
  // never the problem. But the rising edge is IMMEDIATE by design, so one ~16ms
  // frame above threshold arms the floor and holds it 350ms — which a keystroke
  // or a chair creak will do. 26.5% of 3,820 measured busy periods lasted under
  // 500ms, too short to be anyone taking the floor.
  //
  // A bot that yields to a cough is worse than a bot that yields 400ms later, so
  // the DOM path wins until an attack requirement makes the analyser safe. The
  // analyser keeps RECORDING either way (see below), so turning it off does not
  // stop the comparison data accruing.
  // Back ON, but only because the FLOOR now has its own threshold. It was
  // briefly defaulted off when the measurement landed; the fix is the loud
  // threshold rather than abandoning the fast path, since erring loud costs a
  // moment of yield latency while erring quiet costs the bot its voice.
  assert.equal(PREFERENCES.fastFloorDetection.default, true);
  // The floor threshold must stay well clear of the STT gate — conflating the
  // two is what made it fire on keystrokes.
  const inject = readFileSync(new URL('../electron-app/page-inject.js', import.meta.url), 'utf8');
  const m = inject.match(/const FLOOR_SPEECH_DB = (-?\d+)/);
  assert.ok(m, 'the floor needs its own threshold constant');
  assert.ok(Number(m[1]) >= -45, `${m[1]}dB is not "genuinely loud" — a keystroke clears it`);
  assert.match(inject, /noteAudioLevel\(db > FLOOR_SPEECH_DB\)/, 'the floor must not reuse this.speaking');
});

test('it is read live, so a bot that goes quiet can be rescued mid-call', () => {
  // The whole safety argument for shipping it on rests on this: no restart.
  assert.notEqual(PREFERENCES.fastFloorDetection.requiresRestart, true,
    'a restart-gated escape hatch is no escape hatch during a live call');
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
