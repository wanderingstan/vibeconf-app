// caption-replay.test.mjs — regression tests for #12/#402: Meet re-rendering
// the caption container used to hand every historical turn a FRESH scraper
// turnId, and the old ingest matched by turnId (with a fingerprint/alias
// fallback), so a re-render could re-ingest history as brand-new speech and
// wait_for_speech would re-deliver a growing prefix of the whole call.
//
// The fix (2026-08-14, Stan): stop keying identity on the scraper's turnId
// at all. Meet's own behavior guarantees an invariant per PARTICIPANT: it
// never revises an older turn of theirs, and never touches another
// participant's turn — it only ever appends to a participant's own latest
// turn. So updateTurns() tracks, per speaker, how many turns they've
// produced (a count) and a pointer to the current/open one, and ignores
// turnId entirely. A re-render changes every turnId but never a speaker's
// turn count or content, so there is no identity to lose — replay simply
// cannot reproduce the bug anymore, by construction, however the ids churn.
//
// Run: node --test tests/   (or `pnpm test:unit`)
//
// LIVE REPRODUCTION (2026-08-14, verified with Stan): these are all unit
// tests against synthetic batches — none of them drive an actual Google Meet
// re-render. To force a REAL one for live/manual testing, open DevTools on
// the bot's Meet BrowserView (`scripts/dev.sh --devtools`) and run:
//
//   document.querySelector('div[role="region"][aria-label="Captions"]').innerHTML = ''
//
// This empties the live captions region (keeping the container node itself).
// Confirmed live: Meet notices within ~10s and self-heals, rebuilding the
// region with entirely fresh DOM nodes/turnIds — exactly the container
// re-render this fix defends against, and more aggressive than anything
// inferred from the organic bug reports. Watch the app's session log
// (`get_session_log`) for `[caption-health] turnNodes` dropping to 0 and
// bouncing back, and confirm no duplicate `[delivered]` lines or `#12-diag`/
// replay-alarm hits follow. If this ever becomes an automated (not just
// unit) test, this is the mechanism to drive it — e.g. via inspect_dom/CDP
// against the real Meet page rather than synthetic updateTurns() batches.

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

// Simulates Meet's caption container: an ordered list of rows (one per DOM
// child), growing over the call. Every `feed()` call re-sends the FULL
// current snapshot — exactly the contract CaptionScraper honors in
// google-meet-provider.js (it re-reads and re-sends every visible child on
// every poll, never a delta). `turnIdBase` lets a "re-render" hand out an
// entirely fresh id range for the identical rows, proving the fix doesn't
// care.
function makeFeed(s) {
  let rows = [];
  const feed = (turnIdBase = 1) => {
    s.updateTurns(rows.map((r, i) => ({ turnId: turnIdBase + i, speaker: r.speaker, text: r.text })));
  };
  return {
    // Append a new row (a new turn starts) and send the full snapshot.
    say(speaker, text, turnIdBase) { rows.push({ speaker, text }); feed(turnIdBase); },
    // Extend that speaker's most recent row — simulates Meet still typing.
    grow(speaker, text, turnIdBase) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].speaker === speaker) { rows[i].text = text; break; }
      }
      feed(turnIdBase);
    },
    // Re-send the current rows verbatim (or cosmetically mutated) under a
    // fresh turnId range — a container re-render.
    rerender(turnIdBase, mutate) {
      if (mutate) rows = rows.map((r) => ({ ...r, text: mutate(r.speaker, r.text) }));
      feed(turnIdBase);
    },
    rows: () => rows,
  };
}

const stamps = (s) => new Map([...s.turns].map(([id, t]) => [id, t.lastUpdated]));
const redelivered = (s, snap) =>
  [...s.turns].filter(([id, t]) => t.lastUpdated !== snap.get(id) || !snap.has(id));
const tick = () => new Promise((r) => setTimeout(r, 2)); // clear the ms boundary

test('turnId churn from a container re-render is a complete non-event', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Stan', 'Hi Jimmy, can you summarize the history of the site?', 1);
  feed.say('Kate', 'I think brighter colors would work better here.', 1);
  feed.say('Stan', 'Yeah, and check the accessibility contrast too.', 1);
  feed.say('Kate', 'Sounds good, let us', 1);
  assert.equal(s.turns.size, 4);
  const snap = stamps(s);

  // Re-render: identical content, entirely fresh turnIds.
  feed.rerender(101);
  assert.equal(s.turns.size, 4, 'replay must not create new turns');
  assert.deepEqual(redelivered(s, snap), [], 'replay is invisible — nothing re-surfaces to waiters');

  // The live turn keeps growing — still lands on the same original turn.
  feed.grow('Kate', 'Sounds good, let us try the green palette next.', 101);
  assert.equal(s.turns.size, 4);
  const grown = [...s.turns.values()].find((t) => /green palette/.test(t.text));
  assert.ok(grown, 'growth after replay lands on the original turn, not a new one');
});

test('a live turn that GREW during the re-render still lands on the original', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Stan', 'First settled thing that was said here.', 1);
  feed.say('Kate', 'Second settled thing that was said here.', 1);
  feed.say('Kate', 'And the live turn was mid-sentence when', 1);
  // Replay where the live turn's text has grown past what we stored — Meet's
  // re-render snapshot can lag or lead the live edit by a few words.
  feed.rerender(101, (speaker, text) =>
    text.startsWith('And the live turn') ? text + ' the container re-rendered.' : text);
  assert.equal(s.turns.size, 3, 'grown live turn must update in place, not duplicate');
  const kate = [...s.turns.values()].find((t) => /re-rendered/.test(t.text));
  assert.ok(kate);
});

test('genuine repeated utterance by the same speaker is NOT swallowed', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Kate', 'Yeah.', 1);
  feed.say('Stan', 'So what do we think about the tagline?', 1);
  // Minutes later Kate says the exact same thing again — a genuinely NEW row.
  feed.say('Kate', 'Yeah.', 1);
  assert.equal(s.turns.size, 3, 'a real repeated utterance is a distinct new turn');
});

test('punctuation/case-only re-render does not re-deliver history', async () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Stan', 'Hi Jimmy, can you summarize the history of the site?', 1);
  feed.say('Kate', 'I think brighter colors would work better here.', 1);
  feed.say('Stan', 'Yeah, and check the accessibility contrast too.', 1);
  feed.say('Kate', 'Sounds good, let us try the green palette.', 1);
  const snap = stamps(s);
  await tick();

  feed.rerender(101, (speaker, text) =>
    text.replace(/,/g, speaker === 'Stan' ? ' —' : '').replace(/\.$/, '').replace(/\s+/g, ' '));
  assert.equal(s.turns.size, 4, 'no duplicate inserts');
  assert.deepEqual(redelivered(s, snap), [], 'cosmetic revision is not new speech');

  await tick();
  feed.grow('Kate', 'Sounds good, let us try the green palette next week.', 101);
  assert.equal(redelivered(s, snap).length, 1, 'genuine growth still re-surfaces');
});

test('a re-render mid-call delivers only the new turn to a waiter', async () => {
  const s = makeServer();
  const feed = makeFeed(s);
  for (let n = 1; n <= 12; n++) {
    const speaker = n % 2 ? 'Stan' : 'Kate';
    feed.say(speaker, `Point number ${n} about the redesign, roughly.`, 1);
    await tick();
  }
  const cursor = new Date().toISOString();
  await tick();

  // Container re-render: the whole call replays under fresh ids with
  // cosmetic differences, PLUS one genuinely new line from Kate.
  feed.rerender(500, (speaker, text) => text.replace(/,/g, '').replace(/\.$/, '') + '!');
  feed.say('Kate', 'And one brand new thing nobody has said yet.', 500);

  const fresh = s._entriesSince(cursor);
  assert.equal(fresh.length, 1, `waiter must see 1 new turn, saw ${fresh.length}`);
  assert.match(fresh[0].text, /brand new thing/);

  // A second poll from the updated cursor (still replaying, no new content) sees nothing.
  await tick();
  const afterCursor = new Date().toISOString();
  feed.rerender(700);
  assert.equal(s._entriesSince(afterCursor).length, 0, 'no re-delivery on the next poll');
});

test('two participants interleaving does not confuse per-speaker identity', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Seth', 'There is Jimmy, we need quorum, come on Pepper.', 1);
  feed.say('Stan', 'Yeah, that is southwest Colorado for sure.', 1);
  feed.say('Seth', 'I was training for a century so I did a sixty mile ride.', 1);
  feed.say('Stan', 'Nice, I bet that was hot out there.', 1);
  assert.equal(s.turns.size, 4);

  // Re-render under fresh ids — must not create or drop anything.
  feed.rerender(101);
  assert.equal(s.turns.size, 4);
  const snap = stamps(s);
  feed.rerender(201);
  assert.deepEqual(redelivered(s, snap), [], 'a second replay is still a non-event');
});

test('a participant can grow their turn after someone else has spoken since (the QED case)', () => {
  // The insight this design is built on: Meet only ever appends to a
  // speaker's OWN latest turn — it does not matter that Stan's line is no
  // longer the visually-last row once Seth has spoken.
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Seth', 'Hi', 1);
  feed.say('Stan', 'Whatsup?', 1);
  // Seth's turn grows even though it is not the newest row overall.
  s.updateTurns([
    { turnId: 1, speaker: 'Seth', text: 'Hi there' },
    { turnId: 2, speaker: 'Stan', text: 'Whatsup?' },
  ]);
  const seth = [...s.turns.values()].find((t) => t.speaker === 'Seth');
  assert.equal(seth.text, 'Hi there', "Seth's turn grows even though Stan's row is below it");
  const stan = [...s.turns.values()].find((t) => t.speaker === 'Stan');
  assert.equal(stan.text, 'Whatsup?');
  assert.equal(s.turns.size, 2, 'no duplicate turns created');
});

test('room reset clears per-speaker turn tracking', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Stan', 'Something from the first call entirely.', 1);
  feed.say('Stan', 'More from the first call to reach batch size.', 1);
  feed.say('Stan', 'Third line from the first call here.', 1);
  assert.equal(s.turns.size, 3);

  s.setRoom('second-room');
  assert.equal(s.turns.size, 0);
  assert.equal(s._speakerTurnCount.size, 0, 'per-speaker counts reset with the room');
  s.updateTurns([{ turnId: 11, speaker: 'Stan', text: 'Something from the first call entirely.' }]);
  assert.equal(s.turns.size, 1, 'new room = fresh identity space, not aliased to the old call');
});

test('a growing open turn never gets pruned out from under itself', () => {
  const s = makeServer();
  s.maxTurns = 4;
  const feed = makeFeed(s);
  // Kate keeps one long-running open turn while Stan racks up settled ones,
  // pushing the map past maxTurns — Kate's open turn must survive the prune.
  feed.say('Kate', 'K', 1);
  for (let n = 1; n <= 8; n++) feed.say('Stan', `Line ${n} spoken during the pruning test call.`, 1);
  assert.ok(s.turns.size <= 4, 'map stays bounded');
  feed.grow('Kate', 'K, and one more thing.', 1);
  const kate = [...s.turns.values()].find((t) => t.speaker === 'Kate');
  assert.equal(kate.text, 'K, and one more thing.', "Kate's open turn survived the prune and still grows");
});

// ---------------------------------------------------------------------------
// #12-diag: a pure-logging signal (no effect on ingest) so a live test can
// confirm it actually exercised a container re-render, not just that the
// call stayed healthy for unrelated reasons.
// ---------------------------------------------------------------------------

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

test('#12-diag fires on a re-render (many unseen turnIds, no new turns)', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  feed.say('Stan', 'First thing that was said here.', 1);
  feed.say('Kate', 'Second thing that was said here.', 1);
  feed.say('Stan', 'Third thing that was said here.', 1);
  feed.say('Kate', 'Fourth thing that was said here.', 1);

  const lines = captureLogs(() => feed.rerender(101));
  assert.ok(lines.some((l) => l.includes('#12-diag') && l.includes('container re-render observed')),
    'diagnostic should fire when a burst of unseen turnIds carries no new turns');
});

test('#12-diag stays silent on ordinary new speech', () => {
  const s = makeServer();
  const feed = makeFeed(s);
  const lines = captureLogs(() => {
    feed.say('Stan', 'First thing that was said here.', 1);
    feed.say('Kate', 'Second thing that was said here.', 1);
    feed.say('Stan', 'Third thing that was said here.', 1);
  });
  assert.ok(!lines.some((l) => l.includes('#12-diag')), 'ordinary new turns must not be mistaken for a re-render');
});
