// barge-in-exempt-and-discard.test.mjs — two failures seen on the Jul 28 call.
//
// 1. BOTS TALKED OVER PEOPLE MID-MONOLOGUE.
//    An "exempt" utterance skips the floor check and plays over a live human.
//    That is meant for a short ack — the code's own comment says "substantive
//    mid-turn responses are NOT exempt — they still yield" — but the cap was
//    30 words, and 30 words is a paragraph. All 14 exemptions on the call came
//    through the first-reply path at a median of 18 words. Real examples that
//    played over someone speaking:
//
//      "Happy to carry more of the load, Seth — if you're near your usage
//       cap, hand me the lookups and the writing up..."            (28 words)
//      "Seth, if you join as Pepper from the new account, leave her
//       first — otherwise you get the double-driver..."            (26 words)
//
//    Not acks. The intent and the threshold disagreed; the threshold won.
//
// 2. HELD REPLIES DISAPPEARED SILENTLY.
//    speak() told the agent "held — will auto-replay". 13 of 31 stashes were
//    then discarded because the conversation moved on, and NOTHING told the
//    agent. The only signal was the absence of a replay note — a negative an
//    agent can't read. So it believed it had spoken, and kept building on a
//    thought the room never heard.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PREFERENCES } = require('../electron-app/preferences-schema.js');
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

// Read the default off the real schema. Throwing on an unknown key matters:
// a silently-undefined default made every threshold assertion below pass
// vacuously the first time this file was run.
const def = (k) => {
  const spec = PREFERENCES[k];
  assert.ok(spec, `no such preference: ${k} — renamed?`);
  assert.equal(typeof spec.default, 'number', `${k} has no numeric default`);
  return spec.default;
};

// Word counts of every utterance that skipped the floor check on Jul 28,
// measured from the session log. Exactly one was ack-sized.
const JUL28_EXEMPTED = [4, 11, 12, 13, 17, 17, 17, 18, 19, 22, 24, 26, 28, 29];

test('the ack exemption cap is ack-sized, not paragraph-sized', () => {
  const cap = def('bargeInAckMaxWords');
  assert.ok(cap > 0, 'a zero cap would disable acks entirely');
  assert.ok(cap <= 15,
    `bargeInAckMaxWords=${cap}: an exempt utterance plays OVER a live speaker, so this ` +
    'is the line between "signalled it heard me" and "talked over me". 15+ words is a sentence, not an ack.');
});

test('the Jul 28 offenders would now yield instead of steamrolling', () => {
  const cap = def('bargeInAckMaxWords');
  const stillExempt = JUL28_EXEMPTED.filter((w) => w <= cap);
  assert.ok(stillExempt.length <= 4,
    `${stillExempt.length}/14 of the observed exemptions would still play over a human at cap=${cap}`);
  assert.ok(!JUL28_EXEMPTED.filter((w) => w >= 17).some((w) => w <= cap),
    'every utterance of 17+ words from that call must now yield');
});

test('a genuine ack still gets through — the exemption must not become useless', () => {
  const cap = def('bargeInAckMaxWords');
  for (const ack of ['On it.', 'Sure — putting that together now.', 'Let me look that up for you.']) {
    assert.ok(ack.split(/\s+/).length <= cap,
      `"${ack}" must stay exempt; it is the signal that stops the room re-asking during slow tool work`);
  }
});

test('backchannels stay tighter than acks', () => {
  assert.ok(def('bargeInBackchannelMaxWords') <= def('bargeInAckMaxWords'),
    'a backchannel is the narrower case and must not be the looser threshold');
});

// --- 2. discarded stashes are reported ---

const withStash = (texts) => {
  const s = new LocalServer({ port: 0 });
  s.bargeInStash = { at: Date.now(), entries: texts.map((text) => ({ text })) };
  return s;
};

test('discarding a stash records what was lost and why', () => {
  const s = withStash(['The point the room never heard.']);
  s._noteDiscardedStash(s.bargeInStash, '31 words were said while it waited');

  assert.deepEqual(s._lastDiscardedStash.texts, ['The point the room never heard.']);
  assert.match(s._lastDiscardedStash.reason, /31 words/,
    'the reason is what lets the agent judge whether to say it again or drop it');
});

test('an empty stash records nothing — no phantom notices', () => {
  const s = withStash([]);
  s._noteDiscardedStash(s.bargeInStash, 'whatever');
  assert.equal(s._lastDiscardedStash, null);
});

test('a fresh server starts with nothing to report', () => {
  assert.equal(new LocalServer({ port: 0 })._lastDiscardedStash, null);
});

test('the discard notice is one-shot — reported once, never on repeat', () => {
  const s = withStash(['Dropped.']);
  s._noteDiscardedStash(s.bargeInStash, 'moved on');

  // Mirrors _buildResponse's read-and-clear for a waiter (startTime set).
  const first = s._lastDiscardedStash;
  s._lastDiscardedStash = null;

  assert.ok(first, 'surfaced on the next resolve');
  assert.equal(s._lastDiscardedStash, null, 'and not again — a stale notice would prompt a needless repeat');
});

test('replay and discard are distinct channels — a drop is never reported as a replay', () => {
  const s = withStash(['Dropped.']);
  s._noteDiscardedStash(s.bargeInStash, 'moved on');
  assert.equal(s._lastReplayedStash, null,
    'conflating them is the whole bug: the agent would think the room heard it');
});
