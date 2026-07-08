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
