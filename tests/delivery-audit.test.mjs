// delivery-audit.test.mjs — #12: audit what wait_for_speech actually HANDS THE
// AGENT, rather than trusting any one ingest-side defense.
//
// Six recurrences (07-22, 07-27, 07-29, 08-03, 08-04, 08-11) each beat a
// different ingest guard, and the 08-11 call proved the lastUpdated alarm is not
// enough on its own: it never fired, yet the whole room watched the feed replay.
// The invariant that survives every variant is at the boundary — the agent must
// never be handed the same utterance twice.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

function makeServer() {
  const s = new LocalServer({ port: 0 });
  s.setRoom('test-room');
  return s;
}

const E = (participantName, text) => ({ participantName, text });

const LONG = 'The whole point is that she never has to touch the Mac mini at all.';
const LONG2 = 'I was training for a century, so I did about a sixty mile ride.';

test('a normal round logs every entry and flags nothing', () => {
  const s = makeServer();
  s._auditDelivery([E('Stan', LONG), E('Seth', LONG2)], 'silence');
  assert.equal(s.replayDeliveryCount, 0);
  assert.equal((s.errors || []).length, 0, 'a clean round raises no error');
});

test('re-delivering an utterance the agent already got is caught', () => {
  const s = makeServer();
  s._auditDelivery([E('Stan', LONG)], 'silence');
  assert.equal(s.replayDeliveryCount, 0, 'first delivery is clean');
  s._auditDelivery([E('Stan', LONG)], 'silence');
  assert.equal(s.replayDeliveryCount, 1, 'the second delivery is a replay');
});

test('a turn whose captions are still growing is NOT a replay', () => {
  // The legitimate case this must never flag: one utterance delivered across
  // several rounds as Meet's captions extend it.
  const s = makeServer();
  s._auditDelivery([E('Stan', 'The whole point is that she never has to')], 'silence');
  s._auditDelivery([E('Stan', 'The whole point is that she never has to touch the')], 'silence');
  s._auditDelivery([E('Stan', LONG)], 'silence');
  assert.equal(s.replayDeliveryCount, 0, 'growing captions are new content, not replay');
});

test('a cosmetic re-punctuation of an already-delivered line IS a replay', () => {
  // The 07-27 signature: same words, recased/repunctuated, delivered again.
  const s = makeServer();
  s._auditDelivery([E('Seth', 'So all of them, including Saul West, recognize it.')], 'silence');
  s._auditDelivery([E('Seth', 'So? All of them including Saul West. Recognize it')], 'silence');
  assert.equal(s.replayDeliveryCount, 1, 'normalized comparison must see through punctuation');
});

test('short filler is not flagged — people really do say "Yeah." twice', () => {
  const s = makeServer();
  s._auditDelivery([E('Stan', 'Yeah.')], 'silence');
  s._auditDelivery([E('Stan', 'Yeah.')], 'silence');
  assert.equal(s.replayDeliveryCount, 0);
});

test('the same words from a DIFFERENT speaker are not a replay', () => {
  const s = makeServer();
  s._auditDelivery([E('Stan', LONG)], 'silence');
  s._auditDelivery([E('Seth', LONG)], 'silence');
  assert.equal(s.replayDeliveryCount, 0);
});

test('a replay surfaces through Recent Errors, once, but keeps counting', () => {
  const s = makeServer();
  s._auditDelivery([E('Stan', LONG), E('Seth', LONG2)], 'silence');
  s._auditDelivery([E('Stan', LONG)], 'silence');
  s._auditDelivery([E('Seth', LONG2)], 'silence');
  assert.equal(s.replayDeliveryCount, 2, 'both replays counted');
  const errs = (s.errors || []).filter((e) => String(e.message || e).includes('#12'));
  assert.equal(errs.length, 1, 'reported once per session, not once per replay');
});

test('leaving the room clears the ledger', () => {
  const s = makeServer();
  s._auditDelivery([E('Stan', LONG)], 'silence');
  s.setRoom('another-room');
  s._auditDelivery([E('Stan', LONG)], 'silence');
  assert.equal(s.replayDeliveryCount, 0, 'a new call starts with a clean ledger');
});

test('the full trickle-replay path is caught end to end', () => {
  // Ingest a call, then have Meet re-identify an old node below the threshold.
  // With the positional fix the replay never reaches delivery at all.
  const s = makeServer();
  const T = (turnId, speaker, text, isBottommost = false) => ({ turnId, speaker, text, isBottommost });
  s.updateTurns([T(1, 'Stan', LONG), T(2, 'Seth', LONG2, true)]);
  const first = s._entriesSince(null, null).map((e) => e.text);
  s._auditDelivery(s._entriesSince(null, null), 'silence');

  s.updateTurns([T(101, 'Stan', LONG), T(2, 'Seth', LONG2, true)]);
  assert.equal(s.turns.size, 2, 'trickle replay absorbed at ingest');
  assert.deepEqual(s._entriesSince(null, null).map((e) => e.text), first);
  assert.equal(s.replayDeliveryCount, 0);
});
