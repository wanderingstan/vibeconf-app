// stash-named-exemption.test.mjs — being asked for by name outranks
// "the conversation moved on" (#239's guard).
//
// The etiquette rule "answers promptly when addressed by name" failed with the
// bot holding a reply it never delivered. The name-mention machinery was not at
// fault: nameMentionSilenceSeconds shortened the opening wait exactly as
// designed, the timer fired, and then the content-staleness guard discarded the
// stash — 25 new words against a max of 15.
//
// Those words were the interrupter's, and the human's question was among them.
// The guard's premise is that nobody wants the held thought any more; a direct
// "So <name>, what do you think?" is that premise being contradicted out loud.
//
// Only this guard is waived. Age and floor-busy still apply — see the tests at
// the bottom, which are the ones that would catch an over-broad fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js');
const LocalServer = globalThis.LocalServer;

const PREFS = {
  bargeInStashMaxAgeMs: 30_000,
  bargeInStashRedeliverMaxNewWords: 15,
};

function makeServer(prefs = {}) {
  const spoken = [];
  const s = new LocalServer({
    port: 0,
    onBotSpeech: (t) => spoken.push(t),
    getPref: (k) => ({ ...PREFS, ...prefs })[k],
  });
  s.setRoom('test-room');
  s.callStatus = 'in-call';
  s.getEffectiveBotName = () => 'Alice';
  s.spoken = spoken;
  return s;
}

// A stash held since `agoMs`, with `heard` said by others since.
function held(s, { agoMs = 1000, heard = [] } = {}) {
  const at = Date.now() - agoMs;
  s.bargeInStash = {
    at,
    wordsAtStash: 0,
    entries: [{ text: 'I had something queued about the release.', voice: 'v', emoji: '💬' }],
  };
  s._entriesSince = () => heard.map((text) => ({ text, timestamp: new Date(at + 1).toISOString() }));
  s._tickWordCount = () => heard.join(' ').trim().split(/\s+/).filter(Boolean).length;
  return s;
}

const LONG = 'we should really move the whole schedule out by a week or two given how '
           + 'much is still open on the integration side and nobody has looked at it';

test('a long unrelated stretch still discards the stash', () => {
  const s = held(makeServer(), { heard: [LONG] });
  assert.equal(s._maybeReplayBargeInStash(), null);
  assert.equal(s.bargeInStash, null, 'discarded');
});

test('being named in that stretch keeps it', () => {
  const s = held(makeServer(), { heard: [LONG, 'So Alice, what do you think about that?'] });
  const played = s._maybeReplayBargeInStash();
  assert.ok(played, 'replayed rather than discarded');
  assert.match(played[0], /something queued/);
});

test('the name is found wherever it falls, not only in the newest utterance', () => {
  // The case from the real trace: the question came first and the interrupter
  // kept talking over it, so the name is not in the latest entry.
  const s = held(makeServer(), { heard: ['Alice, your take?', LONG] });
  assert.ok(s._maybeReplayBargeInStash(), 'still replayed');
});

test('matching is case-insensitive', () => {
  const s = held(makeServer(), { heard: [LONG, 'alice?'] });
  assert.ok(s._maybeReplayBargeInStash());
});

test('someone else being named does not keep it', () => {
  const s = held(makeServer(), { heard: [LONG, 'So Jimmy, what do you think?'] });
  assert.equal(s._maybeReplayBargeInStash(), null);
  assert.equal(s.bargeInStash, null);
});

// ── the exemption must stay narrow ─────────────────────────────────────────

test('being named does NOT rescue a stash that has aged out', () => {
  const s = held(makeServer(), { agoMs: 60_000, heard: [LONG, 'Alice?'] });
  assert.equal(s._maybeReplayBargeInStash(), null, 'age is judged before content');
  assert.equal(s.bargeInStash, null);
});

test('being named does NOT license talking over the person who named us', () => {
  const s = held(makeServer(), { heard: [LONG, 'Alice, go ahead'] });
  s.anyoneSpeaking = true;              // floorBusy is a getter over this
  assert.equal(s._maybeReplayBargeInStash(), null, 'held, not played');
  assert.ok(s.bargeInStash, 'and survives for the next opening');
});

test('no bot name configured — the guard behaves exactly as before', () => {
  const s = held(makeServer(), { heard: [LONG, 'Alice?'] });
  s.getEffectiveBotName = () => '';
  assert.equal(s._maybeReplayBargeInStash(), null);
});

test('a short exchange replays with or without the name', () => {
  for (const heard of [['sure'], ['sure, Alice']]) {
    const s = held(makeServer(), { heard });
    assert.ok(s._maybeReplayBargeInStash(), `under the word cap: ${heard}`);
  }
});
