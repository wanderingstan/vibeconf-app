// ack-long-needs-a-finished-thought.test.mjs — a long ack claims your turn ended.
//
// The two ack pools are not the same KIND of thing. A short ack ("Mm.",
// "Right.") is backchannel and claims nothing about whose turn it is. A long ack
// ("Let me think about that.", "Just a sec, processing.") asserts the speaker has
// FINISHED and the bot is going away to answer.
//
// Word count cannot support that claim — it says how long someone has been
// talking, not whether they stopped. Observed live 2026-08-24: a 65-word turn
// drew "Just a sec, processing." while Stan was mid-sentence. Correct by the old
// rule, and it read as the bot announcing his turn was over for him.
//
// Run: node --test tests/ack-long-needs-a-finished-thought.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const builtin = require('../electron-app/ack/builtin.js');
const { heuristicComplete } = require('../electron-app/completeness.js');

const PREFS = {
  ackShortMin: 20,
  ackLongMin: 50,
  ackShortPhrases: ['SHORT'],
  ackLongPhrases: ['LONG'],
};

test('long AND finished → a long ack', () => {
  assert.equal(builtin.decide({ wordCount: 65, complete: true, prefs: PREFS }), 'LONG');
});

test('long but UNFINISHED → falls back to a short ack, not silence', () => {
  // A murmur into a continuing sentence is what a listening person would do.
  // Going silent would be a different regression.
  assert.equal(builtin.decide({ wordCount: 65, complete: false, prefs: PREFS }), 'SHORT');
});

test('short stays short regardless of completeness', () => {
  assert.equal(builtin.decide({ wordCount: 30, complete: true, prefs: PREFS }), 'SHORT');
  assert.equal(builtin.decide({ wordCount: 30, complete: false, prefs: PREFS }), 'SHORT');
});

test('below the floor still means no ack at all', () => {
  assert.equal(builtin.decide({ wordCount: 5, complete: true, prefs: PREFS }), null);
  assert.equal(builtin.decide({ wordCount: 5, complete: false, prefs: PREFS }), null);
});

test('a missing `complete` is treated as unfinished, not as finished', () => {
  // Callers that predate this argument must not silently get the old behaviour.
  assert.equal(builtin.decide({ wordCount: 65, prefs: PREFS }), 'SHORT');
});

test('the live utterance that caused this reads as unfinished', () => {
  // Stan's actual turn, cut off exactly where the ack fired.
  const midSentence = 'cool. well, i think i think, uh, i mean, a way stretch goal for that, '
    + 'too, would be that we could observe, uh, the movement of heads and other facial '
    + 'features during a call and maybe use that to inform the movement of our bot avatars '
    + 'in calls. um, i mean, obviously, we could just do this on our own';
  assert.equal(heuristicComplete(midSentence).complete, false,
    'no terminator at the end — the speaker was still going');
  const wordCount = midSentence.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount >= PREFS.ackLongMin, 'and it WAS long enough to have drawn a long ack');
  assert.equal(
    builtin.decide({ wordCount, complete: heuristicComplete(midSentence).complete, prefs: PREFS }),
    'SHORT',
    'so it now gets a murmur instead of "Just a sec, processing."',
  );
});

test('a finished long turn still gets the long ack — this is not a blanket disable', () => {
  const finished = 'Yeah, go ahead and make that change. And I think we are in agreement '
    + 'about the shape of it, so there is no need to go around this again. I would say '
    + 'that the long acknowledgment should only ever be used when we actually know, or at '
    + 'the very least genuinely believe, that the user has stopped talking completely.';
  const v = heuristicComplete(finished);
  assert.equal(v.complete, true, v.reason);
  const wordCount = finished.split(/\s+/).filter(Boolean).length;
  assert.ok(wordCount >= PREFS.ackLongMin);
  assert.equal(builtin.decide({ wordCount, complete: v.complete, prefs: PREFS }), 'LONG');
});
