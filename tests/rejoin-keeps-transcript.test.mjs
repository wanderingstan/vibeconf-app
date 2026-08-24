// rejoin-keeps-transcript.test.mjs — one call id, one transcript.
//
// after-call-work deliberately does NOT clear this.callId (see the isFinished()
// guard in _setCallStatus): the bot has left the Meet but its agent is still
// writing the call up, and dropping the call's identity there is exactly what
// the phase exists to prevent. So when someone redials the same room during
// that window, the rejoin lands on the SAME call id — one call that happened to
// have an interruption in the middle.
//
// setRoom did not know that. It wiped the transcript unconditionally, so after
// a rejoin `read_transcripts` returned only the second segment and the agent's
// write-up of the call silently lost its first half. Observed live on
// 2026-08-23 in room rfw-bmqi-ogb: same call id both sides of the rejoin, but
// the pre-leave conversation was gone.
//
// Run: node --test tests/rejoin-keeps-transcript.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const withTranscript = (s, text) => {
  s.transcripts.push({
    id: `t${s.transcripts.length + 1}`,
    participantName: 'Stan James',
    role: 'user',
    text,
    isFinal: true,
    timestamp: new Date(0).toISOString(),
  });
};

test('rejoining the same room mid-call keeps the transcript', () => {
  const s = new LocalServer({ port: 0 });
  s.setRoom('rfw-bmqi-ogb');
  withTranscript(s, 'first segment');
  // What after-call-work leaves standing: the call id outlives the bot's exit.
  s.callId = 'rfw-bmqi-ogb-20260824T025635Z';

  s.setRoom('rfw-bmqi-ogb');

  assert.equal(s.transcripts.length, 1, 'the pre-leave segment survives the rejoin');
  assert.equal(s.transcripts[0].text, 'first segment');
  assert.equal(s.callId, 'rfw-bmqi-ogb-20260824T025635Z', 'and it is still the same call');
});

test('turn bookkeeping carries over too, so the segments do not collide or duplicate', () => {
  const s = new LocalServer({ port: 0 });
  s.setRoom('rfw-bmqi-ogb');
  s.callId = 'rfw-bmqi-ogb-20260824T025635Z';
  s.turns.set(1, { id: 1, speaker: 'Stan James' });
  s._nextTurnId = 2;

  s.setRoom('rfw-bmqi-ogb');

  assert.equal(s.turns.size, 1, 'earlier turns are still addressable');
  assert.equal(s._nextTurnId, 2, 'the next turn id does not restart and collide');
});

test('the #12 turnId diagnostic starts fresh on a rejoin, unlike the transcript', () => {
  // The one piece of state that must NOT carry over. It does not gate ingest
  // (see updateTurns: "Does not influence ingest") — it counts how many scraper
  // turnIds in a batch are new, to tell a container re-render from ordinary
  // speech. `captionScraper` is module-scope, so a rejoin's fresh page starts
  // minting ids at 1 again; kept, those ids would all look familiar and the
  // signal would report "nothing new here" about an entirely new page.
  const s = new LocalServer({ port: 0 });
  s.setRoom('rfw-bmqi-ogb');
  s.callId = 'rfw-bmqi-ogb-20260824T025635Z';
  s._seenScraperTurnIds.add(1);
  s._seenScraperTurnIds.add(2);

  s.setRoom('rfw-bmqi-ogb');

  assert.equal(s._seenScraperTurnIds.size, 0,
    'a fresh page is a fresh turnId space, so the diagnostic must not carry over');
  // And the conversation itself still survives that same rejoin.
  assert.equal(s.callId, 'rfw-bmqi-ogb-20260824T025635Z');
});

test('joining a DIFFERENT room still wipes — no bleed between rooms', () => {
  const s = new LocalServer({ port: 0 });
  s.setRoom('rfw-bmqi-ogb');
  withTranscript(s, 'first room');
  s.callId = 'rfw-bmqi-ogb-20260824T025635Z';

  s.setRoom('kdd-ggdb-bta');

  assert.equal(s.transcripts.length, 0, 'the previous room does not follow you');
});

test('joining the same room with NO call in flight wipes — a genuinely new call', () => {
  const s = new LocalServer({ port: 0 });
  s.setRoom('rfw-bmqi-ogb');
  withTranscript(s, 'yesterday');
  // call-complete / idle cleared the id: nothing is in flight.
  s.callId = null;

  s.setRoom('rfw-bmqi-ogb');

  assert.equal(s.transcripts.length, 0, 'the same room later is a new call, not a resume');
});

test('a first join is never mistaken for a resume', () => {
  const s = new LocalServer({ port: 0 });
  assert.equal(s.roomId, null);
  s.setRoom('rfw-bmqi-ogb');
  assert.deepEqual(s.transcripts, []);
});
