// stash-supersede.test.mjs — #519: a held reply is only worth replaying while
// it is still the agent's latest word.
//
// From the 2026-08-24 standup. Stan shouted "Jimmy stop!" four times at a bot
// that was not, in fact, refusing to yield — live barge-in worked all through
// the same minute. What he was hearing was the stash replaying answers composed
// 25.6s and 39.4s earlier, into a gap while another bot held the floor:
//
//   12:31:36.394  🛡️ [barge-in] replaying stash — 1 entries, 25588ms old
//   12:31:36.394  🛡️ [barge-in] stash replayed at a floor opening (no waiter needed)
//
// Both replays were LEGAL. bargeInStashMaxAgeMs is 45s and
// bargeInStashRedeliverMaxNewWords is 60 (~25s of ordinary speech), so nothing
// malfunctioned — the two tuned guards simply cannot see the thing that makes
// this wrong. The agent had moved on twice by then, and a reply it has already
// superseded should never have been eligible however fresh the clock said it
// was. That is what these tests pin, and it needs no tuning to hold.
//
// Run: node --test tests/stash-supersede.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

function makeServer(prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (text) => spoken.push(text),
    getPref: (k) => ({
      botSpeakJitterMaxMs: 0,
      bargeInAckExempt: false,
      probeFiring: false,
      bargeInStashMaxAgeMs: 45000,
      bargeInStashRedeliverMaxNewWords: 60,
      ...prefs,
    })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.spoken = spoken;
  return s;
}

function setFloor(s, { speaking = [], present = ['Stan', 'Seth', 'Pepper'] } = {}) {
  s.setParticipants(
    present.map((name) => ({ name, speaking: speaking.includes(name), isSelf: false })),
  );
}

const say = (s, text) => s._applyTranscriptPayload(
  { sender: 'Jimmy', role: 'bot', transcript: [{ text }] },
  'test-room',
  Date.now(),
);

test('a stash the agent has already superseded is discarded, not replayed', async () => {
  const s = makeServer();

  // The floor is busy, so the agent's first thought is held rather than said.
  setFloor(s, { speaking: ['Stan'] });
  await say(s, 'The answer to your earlier question.');
  assert.ok(s.bargeInStash, 'precondition: the first reply is held');

  // The floor opens and the agent says something newer — it has moved on.
  setFloor(s, { speaking: [] });
  await say(s, 'Actually, about the other thing.');
  assert.deepEqual(s.spoken, ['Actually, about the other thing.']);

  // The next opening must NOT bring the superseded thought back.
  assert.equal(s._maybeReplayBargeInStash(), null);
  assert.equal(s.bargeInStash, null, 'the superseded stash is dropped, not left to fire later');
  assert.deepEqual(s.spoken, ['Actually, about the other thing.'],
    'the 25s-stale answer must never reach the room');
});

test('a stash that is still the latest word replays as before', async () => {
  const s = makeServer();

  setFloor(s, { speaking: ['Stan'] });
  await say(s, 'A composed reply.');
  assert.ok(s.bargeInStash);

  // Nothing newer from the agent — only the floor clearing.
  setFloor(s, { speaking: [] });

  assert.deepEqual(s._maybeReplayBargeInStash(), ['A composed reply.'],
    'the guard must not break the feature it is guarding');
  assert.deepEqual(s.spoken, ['A composed reply.']);
});

test('re-holding the same thought is not a supersede', async () => {
  const s = makeServer();

  setFloor(s, { speaking: ['Stan'] });
  await say(s, 'A composed reply.');
  const seq = s.bargeInStash.seqAtStash;

  // The mid-TTS back-off path re-holds the SAME entries directly, without going
  // through the agent's payload handler. That must not look like a new thought,
  // or every interrupted utterance would delete itself on the second hold.
  s._stashUnspokenSpeech([{ text: 'A composed reply.' }], { at: s.bargeInStash.at });
  assert.equal(s.bargeInStash.seqAtStash, seq, 'a re-hold keeps the original sequence');

  setFloor(s, { speaking: [] });
  assert.deepEqual(s._maybeReplayBargeInStash(), ['A composed reply.']);
});

test('an ack does not supersede a held reply', async () => {
  const s = makeServer();

  setFloor(s, { speaking: ['Stan'] });
  await say(s, 'The substantive answer.');
  const seq = s.bargeInStash.seqAtStash;

  // Acks are generated here, not by the agent, so they never reach
  // _applyTranscriptPayload and must leave the counter alone. If they bumped
  // it, a single backchannel would silently delete the real reply behind it.
  s._speakWithBotJitter({ text: 'Mm-hmm.' }, { exempt: true });
  assert.equal(s._agentUtteranceSeq, seq, 'a local ack is not one of the agent\'s thoughts');

  setFloor(s, { speaking: [] });
  assert.deepEqual(s._maybeReplayBargeInStash(), ['The substantive answer.']);
});

test('the discard is reported to the agent, not silent', async () => {
  // A dropped reply the agent never hears about is #403's conversation debt:
  // it asked something, nothing was said, and nobody knows a thought was lost.
  const s = makeServer();

  setFloor(s, { speaking: ['Stan'] });
  await say(s, 'The superseded answer.');
  setFloor(s, { speaking: [] });
  await say(s, 'The newer answer.');

  s._maybeReplayBargeInStash();

  assert.match(s._lastDiscardedStash.reason, /moved on/,
    'the drop reason must survive for the agent to read');
  assert.deepEqual(s._lastDiscardedStash.texts, ['The superseded answer.'],
    'and it must name the thought that was dropped, not the one that replaced it');
});
