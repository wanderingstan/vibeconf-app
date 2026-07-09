// probe-gate.test.mjs — a probe fills a gap in a conversation between OTHERS.
//
// Live regression (2026-07-09, 1:1 call with Stan). The probe path had never
// actually run before that day — a dead ackEndpoint had been silently disabling
// it. The moment the lexical fallback made it work, one sentence produced three
// utterances:
//
//     14:12:00.873  🎣 [probe] firing (generic): "Huh."
//     14:12:01.623  👂 [ack] Playing acknowledgement: "Okay."   (me-1on1)
//     14:12:0x       ...and then the actual reply.
//
// The existing "don't probe when directly named" guard cannot catch this: with a
// single counterpart, nobody says the bot's name to address it. The gate is the
// number of OTHER participants — and another bot counts, since two bots alone are
// a 1:1 too.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer(participants) {
  let openings = 0;
  const s = new LocalServer({
    port: 0,
    onProbeOpening: () => { openings++; return Promise.resolve(); },
    getPref: (k) => ({
      probeFiring: true, probeSilenceMs: 700, probeMinIntervalMs: 0,
      probeGenericPhrases: ['Huh.'], defaultSilenceSeconds: 1.4,
    })[k],
  });
  s.setRoom('r');
  s.callStatus = 'in-call';
  s.mode = 'active';
  s.botState = 'listening';
  s.anyoneSpeaking = false;
  s.participants = participants;
  s.waiters.push({ resolve: () => {}, bot: 'jimmy' }); // slow model is listening
  // Give the gate something to judge.
  s.turns.set('t1', { id: 't1', speaker: 'Stan', text: 'so anyway that is the plan.',
    settled: true, firstSeen: Date.now() - 3000, lastUpdated: Date.now() - 2000 });
  s.openings = () => openings;
  return s;
}

const me = { name: 'jimmy bot', isSelf: true, isBot: true };

test('1:1 with a human — no probe (this is the live regression)', () => {
  const s = makeServer([me, { name: 'Stan James', isSelf: false, isBot: false }]);
  s._maybeProbeOpening();
  assert.equal(s.openings(), 0, 'a probe would stack in front of the ack and the real reply');
  assert.equal(s.fireProbe(), null, 'and fireProbe re-checks, in case the gate raced');
});

test('1:1 with another BOT — also no probe', () => {
  // Stan: "a call with two bots also doesn't need the probe."
  const s = makeServer([me, { name: 'samantha bot', isSelf: false, isBot: true }]);
  s._maybeProbeOpening();
  assert.equal(s.openings(), 0);
  assert.equal(s.fireProbe(), null);
});

test('two other participants — probe is allowed', () => {
  const s = makeServer([
    me,
    { name: 'Stan James', isSelf: false, isBot: false },
    { name: 'Randy', isSelf: false, isBot: false },
  ]);
  s._maybeProbeOpening();
  assert.equal(s.openings(), 1, 'a real side conversation — this is what probes are for');
});

test('a human plus another bot also counts as two others', () => {
  const s = makeServer([
    me,
    { name: 'Stan James', isSelf: false, isBot: false },
    { name: 'coltrane bot', isSelf: false, isBot: true },
  ]);
  s._maybeProbeOpening();
  assert.equal(s.openings(), 1);
});

test('alone in the call — no probe into an empty room', () => {
  const s = makeServer([me]);
  s._maybeProbeOpening();
  assert.equal(s.openings(), 0);
  assert.equal(s.fireProbe(), null);
});

test("Meet's 'You' pseudo-participant is never counted as a partner", () => {
  const s = makeServer([me, { name: 'You', isSelf: false, isBot: false },
    { name: 'Stan James', isSelf: false, isBot: false }]);
  assert.equal(s._otherParticipantCount(), 1, "'You' is the bot's own tile under another name");
  s._maybeProbeOpening();
  assert.equal(s.openings(), 0);
});

test('fireProbe re-checks the roster: the third person left during the gate call', () => {
  const s = makeServer([
    me,
    { name: 'Stan James', isSelf: false, isBot: false },
    { name: 'Randy', isSelf: false, isBot: false },
  ]);
  s._maybeProbeOpening();
  assert.equal(s.openings(), 1, 'opening surfaced while three were present');
  // ~0.6s later the completeness gate answers, but Randy has hung up.
  s.participants = [me, { name: 'Stan James', isSelf: false, isBot: false }];
  assert.equal(s.fireProbe(), null, 'must not fire into what is now a 1:1');
});

test('a held reply still outranks a probe, even with a full room', () => {
  const s = makeServer([
    me,
    { name: 'Stan James', isSelf: false, isBot: false },
    { name: 'Randy', isSelf: false, isBot: false },
  ]);
  s.bargeInStash = { entries: [{ text: 'held thought' }], at: Date.now(), wordsAtStash: 0 };
  s._maybeProbeOpening();
  assert.equal(s.openings(), 0);
  assert.equal(s.fireProbe(), null);
});
