// etiquette-markers.test.mjs — the log markers the etiquette harness asserts on
// must match what the app actually writes.
//
// The harness (scripts/etiquette-test.mjs) drives real bots in a real Meet and
// reads the subject's session log to decide whether it behaved. That makes the
// regexes load-bearing: one that never matches turns a real regression into a
// green run, or a working build into a phantom failure, and nothing in a live
// run would tell you which.
//
// So this pins them against verbatim lines from a REAL call — Pepper's
// 2026-08-17 session log, v0.8.31, where every string below was observed.
// Counts from that call, for context on which behaviours actually occur:
//
//     stashed                        36
//     replaying stash                18
//     discarding stash — moved on    16      <- nearly half of all held replies
//     armed                           7
//     interrupted — backing off       3      <- actual yields
//     discarding stash — too stale    2
//     resuming interrupted utterance  0      <- never once succeeded

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/etiquette-test.mjs'), 'utf8');

// Pull the regexes out of the harness so the test cannot drift from it.
function markers() {
  const block = src.slice(src.indexOf('const MARKERS = {'), src.indexOf('\n};', src.indexOf('const MARKERS = {')));
  const out = {};
  for (const m of block.matchAll(/^\s*(\w+):\s*\{\s*re:\s*(\/.+?\/),/gm)) {
    // eslint-disable-next-line no-eval
    out[m[1]] = eval(m[2]);
  }
  return out;
}

// Verbatim from the 2026-08-17 call (timestamps and emoji stripped).
const REAL = {
  stashed:     '[barge-in] Floor busy at audio-start — stashed bot speech for replay (1 entry): Got both.',
  spoke:       "[local-server] Bot speech: Got both. One thing worth naming out loud (emoji: '🙂')",
  armed:       '[barge-in] armed — grace 1725ms (urgency 0.55-scaled)',
  backedOff:   '[barge-in] human interrupted — backing off: Stan James (analyser)',
  endedEarly:  '[barge-in] interruption already ended (analyser OFF 671ms ago, tracker flag lagging) — continuing',
  resumeStale: '[tts-resume] skip — too stale (8905ms > 5000ms)',
  replayed:    '[barge-in] replaying stash — 1 entries, 3702ms old',
  stashMoved:  '[barge-in] discarding stash — conversation moved on (31 new words > 15) — agent will re-derive',
  stashStale:  '[barge-in] discarding stash — too stale (48210ms old, max 45000ms)',
  floorOn:     '[floor-audio] speech ON  (analyser)',
};

test('every marker matches the real line it was written for', () => {
  const M = markers();
  for (const [key, line] of Object.entries(REAL)) {
    assert.ok(M[key], `marker ${key} missing from the harness`);
    assert.match(line, M[key], `marker ${key} does not match the line the app writes`);
  }
});

test('the yield marker does NOT match a mere state change', () => {
  // The bug this catches: `Bot state: yielding` fires when the bot STASHES too,
  // and appeared 78 times in a call containing 3 real back-offs. A marker that
  // loose would report a pass from the wrong behaviour entirely.
  const M = markers();
  assert.doesNotMatch("[local-server] Bot state: yielding { reason: 'user-speaking' }", M.backedOff);
  assert.match(REAL.backedOff, M.backedOff);
});

test('stashing and speaking are distinguishable', () => {
  // The no-talk-over rule turns on exactly this: "did it hold, or did it talk".
  const M = markers();
  assert.doesNotMatch(REAL.stashed, M.spoke);
  assert.doesNotMatch(REAL.spoke, M.stashed);
});

test('a successful resume is distinguishable from a refused one', () => {
  // In the real call every resume attempt was refused as stale, and the
  // successful-resume line never appeared. Conflating them would report "no
  // resume support" when the truth is "tried three times, refused three times".
  const M = markers();
  assert.doesNotMatch(REAL.resumeStale, M.resumed);
  assert.match(REAL.resumeStale, M.resumeStale);
});

test('discarding a held reply is not mistaken for delivering it', () => {
  // 16 of 36 held replies were discarded this way in one call. If the harness
  // scored that as a pass, the most common real failure would be invisible.
  const M = markers();
  assert.doesNotMatch(REAL.stashMoved, M.replayed);
  assert.doesNotMatch(REAL.stashStale, M.replayed);
  assert.match(REAL.stashMoved, M.stashMoved);
});

test('every rule declares what it needs and how it is judged', () => {
  // Structural: a rule missing `needs` would silently test the wrong thing,
  // since a bot-as-voice cannot stand in for a human where identity matters.
  const ids = [...src.matchAll(/^\s{4}id: '([\w-]+)'/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 6, `expected several rules, found ${ids.length}`);
  const needs = [...src.matchAll(/^\s{4}needs: \[/gm)];
  // Two shapes: verdict(w) for a plain log window, verdict({ w, held }) where
  // the rule first had to confirm the subject was genuinely speaking.
  const verdicts = [...src.matchAll(/^\s{4}verdict\((?:w|\{[^)]*\})\)/gm)];
  assert.equal(needs.length, ids.length, 'every rule needs a `needs`');
  assert.equal(verdicts.length, ids.length, 'every rule needs a `verdict`');
});

test('the harness sends the app control token', () => {
  // Without it /api/session-log 401s and sessionLog() returns '' — every
  // assertion then reads an empty string. The fleet disables auth (#212), so
  // this breaks only outside the fleet, which is the least convenient place.
  const lib = readFileSync(join(root, 'scripts/meet-test-lib.mjs'), 'utf8');
  assert.match(lib, /local-tokens/);
  assert.match(lib, /Authorization: `Bearer \$\{this\._tok\}`/);
  assert.match(src, /\.\.\.bot\._auth\(\)/, 'the simulated human must authenticate too');
});
