// barge-in-rearm-after-ride-out.test.mjs — interruptions do not come one per
// utterance (#487).
//
// The failure this pins down, observed live on paz-sqoa-npe 2026-08-20: the
// monitor armed once, logged "rode it out" 1.5s later when the interrupter
// looked stopped, and then went dark. Arming is edge-driven — the analyser
// rising edge via _onFloorChanged, the DOM transition in setParticipants — so
// with the human STILL TALKING there was no fresh edge to re-arm on. The bot
// talked over them for the remaining 15 seconds of its utterance with nothing
// watching.
//
// The existing suite passed throughout, because every case in it interrupts
// exactly once. That is the gap: a second bid for the floor, in the same
// utterance, after the first was ridden out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const GRACE = 300; // keep the polls short; the cadence is what matters, not the value

function makeServer() {
  const s = new LocalServer({
    port: 0,
    onBotSpeech: () => {},
    getPref: (k) => ({
      fastFloorDetection: true,
      bargeInQuietConfirmMs: 250,
      bargeInUrgencyScaling: false,
      bargeInGraceMs: GRACE,
      bargeInGraceMinMs: GRACE,
      bargeInGraceMaxMs: GRACE,
      bargeInClearHangoverMs: 0,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

test('a ride-out re-arms, so a SECOND interruption in the same utterance is still caught', async () => {
  const s = makeServer();
  const backedOff = [];
  s._performBackOff = (reason) => backedOff.push(reason);

  s.botState = 'speaking';

  // First bid for the floor: ridden out (they stopped inside the grace).
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = false;
  const out = capture(() => s._evaluateBargeIn());
  assert.match(out, /rode it out/, 'precondition: the first interruption was ridden out');
  assert.equal(backedOff.length, 0, 'and correctly did not back off');

  // Same utterance, seconds later: they start again and keep going. No rising
  // edge is delivered — this is the sustained-interrupter case, where the DOM
  // flag and the analyser were already true and simply stay true.
  s.anyoneSpeaking = true;
  s.audioFloorSpeaking = true;
  s.participants = [{ name: 'Stan James', speaking: true, isSelf: false }];

  await sleep(GRACE * 3);

  assert.deepEqual(backedOff, ['human-interrupt'],
    'the monitor must re-arm itself and yield to the second bid');
});

test('the re-arm poll stops when the bot stops speaking', async () => {
  const s = makeServer();
  const backedOff = [];
  s._performBackOff = (reason) => backedOff.push(reason);

  s.botState = 'speaking';
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = false;
  capture(() => s._evaluateBargeIn());

  // Utterance ends normally; a human starts talking straight afterwards, which
  // is ordinary turn-taking and must not fire stop-tts at a silent bot.
  s.botState = 'idle';
  s.anyoneSpeaking = true;
  s.audioFloorSpeaking = true;
  s.participants = [{ name: 'Stan James', speaking: true, isSelf: false }];

  await sleep(GRACE * 3);
  assert.deepEqual(backedOff, [], 'nothing to back off from once the bot is quiet');
});

test('_clearBargeIn tears the re-arm poll down', async () => {
  const s = makeServer();
  const backedOff = [];
  s._performBackOff = (reason) => backedOff.push(reason);

  s.botState = 'speaking';
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = false;
  capture(() => s._evaluateBargeIn());

  capture(() => s._clearBargeIn('bot stopped speaking'));
  assert.equal(s._bargeInRearmTimer, null, 'the poll handle is released');

  // Even if the state flags stay stale, a cleared monitor stays cleared.
  s.anyoneSpeaking = true;
  s.audioFloorSpeaking = true;
  s.participants = [{ name: 'Stan James', speaking: true, isSelf: false }];
  await sleep(GRACE * 3);
  assert.deepEqual(backedOff, []);
});

test('replayed audio (#422) is never re-armed against', async () => {
  const s = makeServer();
  const backedOff = [];
  s._performBackOff = (reason) => backedOff.push(reason);

  s.botState = 'speaking';
  s._uninterruptiblePlayback = true;
  s.anyoneSpeaking = false;
  s.audioFloorSpeaking = false;
  capture(() => s._evaluateBargeIn());

  s.anyoneSpeaking = true;
  s.audioFloorSpeaking = true;
  s.participants = [{ name: 'Stan James', speaking: true, isSelf: false }];

  await sleep(GRACE * 3);
  assert.deepEqual(backedOff, [], 'ground-truth replay must not be interrupted by the poll');
});
