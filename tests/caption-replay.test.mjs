// caption-replay.test.mjs — regression tests for #402: when Meet re-renders
// the caption container, every historical turn arrives with a fresh scraper
// turnId; updateTurns must recognize the replay by content fingerprint and
// alias instead of re-ingesting the whole call as new speech.
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('../electron-app/local-server.js'); // registers globalThis.LocalServer
const LocalServer = globalThis.LocalServer;

function makeServer() {
  const s = new LocalServer({ port: 0 });
  s.setRoom('test-room');
  return s;
}

const T = (turnId, speaker, text, isBottommost = false) => ({ turnId, speaker, text, isBottommost });

test('re-render replay: history under fresh turnIds is aliased, not re-ingested', () => {
  const s = makeServer();
  s.updateTurns([
    T(1, 'Stan', 'Hi Jimmy, can you summarize the history of the site?'),
    T(2, 'Kate', 'I think brighter colors would work better here.'),
    T(3, 'Stan', 'Yeah, and check the accessibility contrast too.'),
    T(4, 'Kate', 'Sounds good, let us', true), // live turn
  ]);
  assert.equal(s.turns.size, 4);
  const before = new Map([...s.turns].map(([id, t]) => [id, { text: t.text, lastUpdated: t.lastUpdated }]));

  // Container re-render: SAME content arrives under scraper ids 101..104.
  s.updateTurns([
    T(101, 'Stan', 'Hi Jimmy, can you summarize the history of the site?'),
    T(102, 'Kate', 'I think brighter colors would work better here.'),
    T(103, 'Stan', 'Yeah, and check the accessibility contrast too.'),
    T(104, 'Kate', 'Sounds good, let us', true),
  ]);
  assert.equal(s.turns.size, 4, 'replay must not create new turns');
  for (const [id, snap] of before) {
    assert.equal(s.turns.get(id).text, snap.text);
    assert.equal(s.turns.get(id).lastUpdated, snap.lastUpdated, 'replay must not bump lastUpdated (no re-delivery to waiters)');
  }

  // Post-replay: the live turn keeps growing under its NEW scraper id — must
  // route to the original turn via the alias.
  s.updateTurns([
    T(101, 'Stan', 'Hi Jimmy, can you summarize the history of the site?'),
    T(102, 'Kate', 'I think brighter colors would work better here.'),
    T(103, 'Stan', 'Yeah, and check the accessibility contrast too.'),
    T(104, 'Kate', 'Sounds good, let us try the green palette next.', true),
  ]);
  assert.equal(s.turns.size, 4);
  assert.match(s.turns.get(4).text, /green palette/, 'growth after replay lands on the ORIGINAL turn');
});

test('re-render replay: live turn that GREW during the re-render still aliases (prefix match)', () => {
  const s = makeServer();
  s.updateTurns([
    T(1, 'Stan', 'First settled thing that was said here.'),
    T(2, 'Kate', 'Second settled thing that was said here.'),
    T(3, 'Kate', 'And the live turn was mid-sentence when', true),
  ]);
  // Replay: the live turn's text has grown a few words past what we stored.
  s.updateTurns([
    T(101, 'Stan', 'First settled thing that was said here.'),
    T(102, 'Kate', 'Second settled thing that was said here.'),
    T(103, 'Kate', 'And the live turn was mid-sentence when the container re-rendered.', true),
  ]);
  assert.equal(s.turns.size, 3, 'grown live turn must alias, not duplicate');
  assert.match(s.turns.get(3).text, /re-rendered/);
});

test('genuine repeated utterance is NOT swallowed (no replay signature)', () => {
  const s = makeServer();
  s.updateTurns([T(1, 'Kate', 'Yeah.'), T(2, 'Stan', 'So what do we think about the tagline?', true)]);
  // Minutes later Kate says the exact same thing again — ONE new turn, alone.
  s.updateTurns([
    T(1, 'Kate', 'Yeah.'),
    T(2, 'Stan', 'So what do we think about the tagline?'),
    T(3, 'Kate', 'Yeah.', true),
  ]);
  assert.equal(s.turns.size, 3, 'a lone repeated utterance is genuinely new speech');
});

test('replay with duplicate texts maps each copy to a distinct original (ordinal)', () => {
  const s = makeServer();
  s.updateTurns([
    T(1, 'Kate', 'Yeah, that works for me I think.'),
    T(2, 'Stan', 'Okay so about the events calendar page.'),
    T(3, 'Kate', 'Yeah, that works for me I think.'),
    T(4, 'Stan', 'Moving on to the donation section now.', true),
  ]);
  s.updateTurns([
    T(101, 'Kate', 'Yeah, that works for me I think.'),
    T(102, 'Stan', 'Okay so about the events calendar page.'),
    T(103, 'Kate', 'Yeah, that works for me I think.'),
    T(104, 'Stan', 'Moving on to the donation section now.', true),
  ]);
  assert.equal(s.turns.size, 4, 'both duplicate-text copies alias to their own originals');
});

test('room reset clears replay state', () => {
  const s = makeServer();
  s.updateTurns([
    T(1, 'Stan', 'Something from the first call entirely.'),
    T(2, 'Stan', 'More from the first call to reach batch size.'),
    T(3, 'Stan', 'Third line from the first call here.', true),
  ]);
  s.setRoom('second-room');
  // Same texts in a NEW room must be fresh turns, not aliased to the old call.
  s.updateTurns([
    T(11, 'Stan', 'Something from the first call entirely.'),
    T(12, 'Stan', 'More from the first call to reach batch size.'),
    T(13, 'Stan', 'Third line from the first call here.', true),
  ]);
  assert.equal(s.turns.size, 3);
  assert.ok(s.turns.has(11) && s.turns.has(12) && s.turns.has(13), 'new room = fresh identity space');
});

// ---------------------------------------------------------------------------
// #12: holes left open after #402 — the 2026-07-22 call still snowballed with
// the fingerprint-alias defense in place. Three separate paths, one symptom:
// wait_for_speech re-delivering a growing prefix of the whole call.
// ---------------------------------------------------------------------------

// A waiter's cursor is `lastUpdated || timestamp` (see _entriesSince), so
// "would this be re-delivered?" == "did any turn's lastUpdated move?". Compare
// snapshots rather than a wall-clock cursor — updateTurns stamps Date.now(),
// and a whole test otherwise runs inside a single millisecond.
const stamps = (s) => new Map([...s.turns].map(([id, t]) => [id, t.lastUpdated]));
// Turns a waiter would see as new: bumped lastUpdated, or absent before.
const redelivered = (s, snap) =>
  [...s.turns].filter(([id, t]) => t.lastUpdated !== snap.get(id));
const tick = () => new Promise((r) => setTimeout(r, 2)); // clear the ms boundary

test('#12 punctuation-only re-render does NOT re-deliver history', async () => {
  const s = makeServer();
  s.updateTurns([
    T(1, 'Stan', 'Hi Jimmy, can you summarize the history of the site?'),
    T(2, 'Kate', 'I think brighter colors would work better here.'),
    T(3, 'Stan', 'Yeah, and check the accessibility contrast too.'),
    T(4, 'Kate', 'Sounds good, let us try the green palette.', true),
  ]);
  const snap = stamps(s);
  await tick();
  // Re-render replays the same WORDS with Meet's cosmetic differences: added
  // punctuation, changed case, collapsed spacing. fp-matches (so no duplicate
  // insert), but the raw text differs — which used to bump lastUpdated on
  // every replayed turn and dump the entire call to the next waiter.
  s.updateTurns([
    T(101, 'Stan', 'Hi Jimmy — can you summarize the history of the site'),
    T(102, 'Kate', 'I think brighter colors would work better here'),
    T(103, 'Stan', 'Yeah  and check the accessibility contrast, too!'),
    T(104, 'Kate', 'Sounds good... let us try the green palette', true),
  ]);
  assert.equal(s.turns.size, 4, 'no duplicate inserts');
  assert.deepEqual(redelivered(s, snap), [], 'cosmetic revision is not new speech');
  // Real new words on that same turn still surface.
  await tick();
  s.updateTurns([T(104, 'Kate', 'Sounds good, let us try the green palette next week.', true)]);
  assert.equal(redelivered(s, snap).length, 1, 'genuine growth still re-surfaces');
});

test('#12 replay of an OLDER revised turn aliases (not just the newest per speaker)', async () => {
  const s = makeServer();
  s.updateTurns([
    T(1, 'Stan', 'The first thing I wanted to raise was the pricing page.'),
    T(2, 'Kate', 'Right, the pricing page needs a rewrite honestly.'),
    T(3, 'Stan', 'And the second thing is the onboarding flow.'),
    T(4, 'Kate', 'Agreed on the onboarding flow being confusing.', true),
  ]);
  const snap = stamps(s);
  await tick();
  // Replay where Stan's OLD turn (id 1) comes back TRUNCATED and Kate's old
  // turn (id 2) comes back EXTENDED — both are prefix-related to what we hold,
  // but neither is the most recent turn by its speaker. The old one-candidate
  // fallback missed both and re-inserted them as fresh speech.
  s.updateTurns([
    T(201, 'Stan', 'The first thing I wanted to raise was the pricing'),
    T(202, 'Kate', 'Right, the pricing page needs a rewrite honestly, top to bottom.'),
    T(203, 'Stan', 'And the second thing is the onboarding flow.'),
    T(204, 'Kate', 'Agreed on the onboarding flow being confusing.', true),
  ]);
  assert.equal(s.turns.size, 4, 'revised older turns alias instead of re-inserting');
  assert.equal(redelivered(s, snap).length, 1,
    'only the genuinely extended turn counts as new speech');
});

test('#12 replay of turns aged out of the maxTurns window is dropped, not re-ingested', async () => {
  const s = makeServer();
  s.maxTurns = 6;
  const line = (n) => `Turn number ${n} of the long standup call.`;
  // 10 turns through a window of 6 — turns 1..4 age out.
  for (let n = 1; n <= 10; n++) { s.updateTurns([T(n, 'Stan', line(n), true)]); await tick(); }
  assert.equal(s.turns.size, 6);
  assert.ok(!s.turns.has(1), 'early turns aged out');
  const snap = stamps(s);
  await tick();

  // Container re-render replays the WHOLE call, including the aged-out head.
  s.updateTurns(Array.from({ length: 10 }, (_, i) => T(300 + i, 'Stan', line(i + 1), i === 9)));
  assert.equal(s.turns.size, 6, 'aged-out history must not re-enter the window');
  assert.deepEqual(redelivered(s, snap), [], 'nothing from the replay is new speech');
});

test('#12 prune drops stale aliases and fingerprints', async () => {
  const s = makeServer();
  s.maxTurns = 4;
  const line = (n) => `Line ${n} spoken during the pruning test call.`;
  for (let n = 1; n <= 8; n++) { s.updateTurns([T(n, 'Kate', line(n), true)]); await tick(); }
  for (const ids of s._turnFps.values()) {
    for (const id of ids) assert.ok(s.turns.has(id), 'no fingerprint points at a pruned turn');
  }
  for (const canonical of s._turnAlias.values()) {
    assert.ok(s.turns.has(canonical), 'no alias routes to a pruned turn');
  }
  assert.ok(s._retiredFps.size > 0, 'pruned turns leave a retired fingerprint');
});

test('#12 retired-fingerprint set stays bounded', () => {
  const s = makeServer();
  s.maxTurns = 2;
  s.maxRetiredFps = 10;
  for (let n = 1; n <= 60; n++) s.updateTurns([T(n, 'Stan', `Bounded growth check line ${n}.`, true)]);
  assert.ok(s._retiredFps.size <= 10, `retired set bounded, got ${s._retiredFps.size}`);
});

test('#12 end-to-end: a re-render mid-call delivers only the new turn to a waiter', async () => {
  const s = makeServer();
  // 12 turns of an ordinary call.
  const said = [];
  for (let n = 1; n <= 12; n++) {
    const speaker = n % 2 ? 'Stan' : 'Kate';
    said.push([n, speaker, `Point number ${n} about the redesign, roughly.`]);
    s.updateTurns([T(n, speaker, `Point number ${n} about the redesign, roughly.`, true)]);
    await tick();
  }
  const cursor = new Date().toISOString();   // what wait_for_speech hands back as asOf
  await tick();

  // Meet re-renders: the whole call replays under fresh ids, cosmetically
  // different, with ONE genuinely new turn at the end. Pre-#12 the waiter got
  // the entire call back (and a bigger slice on every subsequent poll).
  s.updateTurns([
    ...said.map(([n, speaker, text], i) =>
      T(500 + i, speaker, text.replace(/,/g, '').replace(/\.$/, '') + (n % 3 ? '!' : ''))),
    T(599, 'Kate', 'And one brand new thing nobody has said yet.', true),
  ]);

  const fresh = s._entriesSince(cursor);
  assert.equal(fresh.length, 1, `waiter must see 1 new turn, saw ${fresh.length}`);
  assert.match(fresh[0].text, /brand new thing/);

  // And a second poll from the updated cursor sees nothing at all.
  await tick();
  s.updateTurns(said.map(([n, speaker, text], i) => T(500 + i, speaker, text)));
  assert.equal(s._entriesSince(new Date().toISOString()).length, 0, 'no re-delivery on the next poll');
});
