// floor-gate-at-audio-start.test.mjs — the floor check must happen at the
// moment audio starts, and nowhere earlier (#67).
//
// The gate used to sit in the /api/sync POST handler, before the speak jitter
// (up to botSpeakJitterMaxMs, default 800ms) and before TTS synthesis. A floor
// read taken there is stale by the time audio plays, and it was wrong in BOTH
// directions:
//
//   • someone starts talking during the delay → the bot talks over them
//     (the reported bug: "bots are not supposed to start speaking when someone
//     else is already speaking, and that's been happening a lot")
//   • someone stops talking during the delay → the bot stashes a reply it
//     could have simply said, and the room gets silence instead of an answer
//
// These tests pin both directions, plus the rule that the floor means ANY
// voice — another bot counts exactly like a human.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

const JITTER_MS = 120; // long enough to flip the floor mid-delay, short enough to test

function makeServer(prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text) => spoken.push(text),
    getPref: (k) => ({
      botSpeakJitterMaxMs: 0, // opt in per-test; 0 = speak immediately
      bargeInAckExempt: false, // exemptions are exercised separately
      probeFiring: false,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.spoken = spoken;
  return s;
}

// Put N other participants in the room so the jitter path engages (it needs
// 2+ others), and set the live floor state the way setParticipants does.
function setFloor(s, { speaking = [], present = ['Stan', 'Seth', 'Pepper'] } = {}) {
  s.setParticipants(
    present.map((name) => ({ name, speaking: speaking.includes(name), isSelf: false })),
  );
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('speech is stashed when someone STARTS talking during the jitter delay', async () => {
  const s = makeServer({ botSpeakJitterMaxMs: JITTER_MS });
  setFloor(s, { speaking: [] }); // floor clear at the moment speak() is called

  const outcome = s._speakWithBotJitter({ text: 'A composed reply.' });
  // ...and a human starts talking while the bot is still inside the delay.
  setFloor(s, { speaking: ['Stan'] });

  assert.equal(await outcome, 'stashed');
  assert.deepEqual(s.spoken, [], 'the bot must not talk over speech that started during the delay');
  assert.ok(s.bargeInStash, 'the composed reply is held, not discarded');
  assert.equal(s.bargeInStash.entries[0].text, 'A composed reply.');
  assert.equal(s.botState, 'yielding');
});

test('speech PLAYS when the speaker stops during the jitter delay (no false stash)', async () => {
  const s = makeServer({ botSpeakJitterMaxMs: JITTER_MS });
  setFloor(s, { speaking: ['Stan'] }); // floor busy at the moment speak() is called

  const outcome = s._speakWithBotJitter({ text: 'A composed reply.' });
  // ...and they finish before the bot's audio would start. An earlier check
  // would have stashed this reply for no reason.
  setFloor(s, { speaking: [] });

  assert.equal(await outcome, 'spoken');
  assert.deepEqual(s.spoken, ['A composed reply.']);
  assert.equal(s.bargeInStash, null, 'nothing to hold — the floor was clear when audio started');
});

test('another BOT on the floor holds the reply just like a human does', async () => {
  const s = makeServer();
  s.members = [{ name: 'Pepper', role: 'bot' }];
  setFloor(s, { speaking: ['Pepper'] });

  assert.equal(await s._speakWithBotJitter({ text: 'Me too!' }), 'stashed');
  assert.deepEqual(s.spoken, [], 'any voice on the floor counts, not just a human one');
});

test('the barge-in exemption still plays over a busy floor', async () => {
  const s = makeServer();
  setFloor(s, { speaking: ['Stan'] });

  assert.equal(await s._speakWithBotJitter({ text: 'On it.' }, { exempt: true }), 'spoken');
  assert.deepEqual(s.spoken, ['On it.']);
});

test('a stashed reply is never recorded as something the bot said', async () => {
  const s = makeServer();
  setFloor(s, { speaking: ['Stan'] });

  const res = await s._applyTranscriptPayload({
    sender: 'Jimmy',
    role: 'bot',
    transcript: [{ text: 'Never made it out.' }],
  }, 'test-room', new Date().toISOString());

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'user-speaking-stashed');
  assert.deepEqual(s.spoken, []);
  assert.equal(
    s.transcripts.filter((e) => e.text === 'Never made it out.').length,
    0,
    'a reply that was never spoken must not appear in the transcript',
  );
});

test('a spoken reply IS recorded, and reports success to the agent', async () => {
  const s = makeServer();
  setFloor(s, { speaking: [] });

  const res = await s._applyTranscriptPayload({
    sender: 'Jimmy',
    role: 'bot',
    transcript: [{ text: 'Said out loud.' }],
  }, 'test-room', new Date().toISOString());

  assert.equal(res.ok, true);
  assert.equal(res.sent, 1);
  assert.deepEqual(s.spoken, ['Said out loud.']);
  assert.equal(s.transcripts.filter((e) => e.text === 'Said out loud.').length, 1);
});

// The regression test proper: this is the exact path the old gate sat on. A
// speak() arriving while the floor is busy used to be stashed on the spot,
// even though the floor was clear by the time audio would have played.
test('a speak() arriving on a busy floor still plays if the floor clears before audio', async () => {
  const s = makeServer({ botSpeakJitterMaxMs: JITTER_MS });
  setFloor(s, { speaking: ['Stan'] });

  const pending = s._applyTranscriptPayload({
    sender: 'Jimmy',
    role: 'bot',
    transcript: [{ text: 'Still worth saying.' }],
  }, 'test-room', new Date().toISOString());
  setFloor(s, { speaking: [] }); // Stan finishes while the bot is in the jitter

  const res = await pending;
  assert.equal(res.ok, true, 'the reply was never actually blocked — it must go out');
  assert.deepEqual(s.spoken, ['Still worth saying.']);
  assert.equal(s.bargeInStash, null);
});

test('silent mode still suppresses before anything reaches the speak path', async () => {
  const s = makeServer();
  s.mode = 'silent';
  setFloor(s, { speaking: [] });

  const res = await s._applyTranscriptPayload({
    sender: 'Jimmy',
    role: 'bot',
    transcript: [{ text: 'Shh.' }],
  }, 'test-room', new Date().toISOString());

  assert.equal(res.reason, 'mode-silent');
  assert.deepEqual(s.spoken, []);
});

await settle(0);
