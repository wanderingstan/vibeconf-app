// extract-speaker-tracks.test.mjs — per-person audio out of Meet's shuffled
// slot tracks (#209/#422).
//
// The thing under test is an attribution decision, and its most dangerous
// failure is not a crash but a CONFIDENT WRONG NAME: a plausible label on a
// segment nobody can later tell was guessed. So most of these pin the cases
// where the right answer is "I don't know" — and check that it says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameDb, segmentsFromDb, litIntervals, overlapWith, bestAssignment,
         candidatesFor, attribute, parseWavHeader, wavHeader, isBotName }
  from '../scripts/extract-speaker-tracks.mjs';

const tone = (ms, amp, rate = 1000) =>
  Array.from({ length: Math.round(ms / 1000 * rate) }, (_, i) => Math.round(amp * Math.sin(i / 3)));
const silence = (ms, rate = 1000) => new Array(Math.round(ms / 1000 * rate)).fill(0);
const segsOf = (samples, opts) =>
  segmentsFromDb(frameDb(Int16Array.from(samples), 20), { frameMs: 20, ...opts }).segments;

test('a burst of energy becomes one segment, and silence is not a segment', () => {
  const s = segsOf([...silence(500), ...tone(1000, 8000), ...silence(500)]);
  assert.equal(s.length, 1);
  assert.ok(Math.abs(s[0].startMs - 500) <= 40, `start ${s[0].startMs}`);
  assert.ok(Math.abs(s[0].endMs - 1500) <= 40, `end ${s[0].endMs}`);
});

test('a breath mid-sentence does not split an utterance in two', () => {
  // The gap-closing is what makes a segment an UTTERANCE rather than a
  // syllable — and the utterance is the unit Meet reassigns slots at, so
  // splitting here would invent boundaries that no reassignment can occur on.
  const s = segsOf([...tone(600, 8000), ...silence(150), ...tone(600, 8000)]);
  assert.equal(s.length, 1, 'a 150ms gap is a breath, not a turn end');
});

test('a real pause DOES split, because that is where a slot can change hands', () => {
  const s = segsOf([...tone(600, 8000), ...silence(800), ...tone(600, 8000)]);
  assert.equal(s.length, 2);
});

test('a click shorter than the minimum is discarded', () => {
  assert.equal(segsOf([...silence(300), ...tone(60, 9000), ...silence(300)]).length, 0);
});

test('indicator samples widen to their poll period and merge, but do not bridge silence', () => {
  // Widening is SAMPLE WIDTH — reconstructing the interval a sample stands for
  // — not smoothing. If it bridged real gaps it would become exactly the kind
  // of hold that made the verdict unusable for this.
  const ev = [200, 400, 600, 5000].map((t) => ({ k: 'ind', p: 'Ann', v: '-40px', t }));
  const iv = litIntervals(ev, { holdMs: 260 }).get('Ann');
  assert.equal(iv.length, 2, 'three adjacent samples merge; the distant one does not');
  assert.equal(iv[0][0], 200);
  assert.ok(iv[1][0] === 5000);
});

test('a dark indicator is not evidence of speech', () => {
  const ev = [{ k: 'ind', p: 'Ann', v: '0px', t: 100 }, { k: 'ind', p: 'Ann', v: '', t: 200 }];
  assert.equal(litIntervals(ev).size, 0);
});

test('the bot is excluded, so its own TTS never claims a slot', () => {
  const ev = [{ k: 'ind', p: 'jimmy bot', v: '-40px', t: 100 },
              { k: 'ind', p: 'Ann', v: '-40px', t: 100 }];
  const lit = litIntervals(ev, { exclude: ['jimmy bot'] });
  assert.deepEqual([...lit.keys()], ['Ann']);
});

test('verdict events are ignored even when present in the same stream', () => {
  // The capture holds `mut`, `verdict` and `self` alongside `ind`. Letting a
  // verdict in would reintroduce the smoothing this whole approach avoids.
  const ev = [{ k: 'verdict', p: 'Ann', v: 1, t: 100 }, { k: 'mut', p: 'Ann', t: 100 }];
  assert.equal(litIntervals(ev).size, 0);
});

test('one lit name over a segment is a sole owner', () => {
  const lit = new Map([['Ann', [[0, 2000]]]]);
  const c = candidatesFor({ startMs: 500, endMs: 1500 }, lit);
  assert.deepEqual(c.map((x) => x.name), ['Ann']);
});

test('a name that merely grazes a segment does not claim it', () => {
  const lit = new Map([['Ann', [[0, 2000]]], ['Bo', [[1900, 2100]]]]);
  const c = candidatesFor({ startMs: 0, endMs: 2000 }, lit);
  assert.deepEqual(c.map((x) => x.name), ['Ann'], 'Bo overlaps 5% and is not a candidate');
});

test('two people talking at once are separated by exclusion, not by guessing', () => {
  // Ann and Bo overlap in time. They cannot share a slot, so the assignment is
  // forced: whichever track each one's indicator agrees with.
  const lit = new Map([['Ann', [[0, 3000]]], ['Bo', [[1000, 4000]]]]);
  const trackSegs = {
    'remote-participant-1': [{ startMs: 0, endMs: 3000 }],
    'remote-participant-2': [{ startMs: 1000, endMs: 4000 }],
  };
  const out = attribute(trackSegs, lit);
  const owner = Object.fromEntries(out.map((s) => [s.track, s.owner]));
  assert.equal(owner['remote-participant-1'], 'Ann');
  assert.equal(owner['remote-participant-2'], 'Bo');
});

test('more lit indicators than sounding slots is UNRESOLVED, never a coin flip', () => {
  // The whole point. Two people are lit, one track carries audio: somebody's
  // audio is not here. Picking either name would be a fabricated label that
  // reads identically to a measured one — and these windows are the #378
  // signature, so they must survive as evidence.
  const lit = new Map([['Ann', [[0, 3000]]], ['Bo', [[0, 3000]]]]);
  const out = attribute({ 'remote-participant-1': [{ startMs: 0, endMs: 3000 }] }, lit);
  assert.equal(out[0].owner, null);
  assert.equal(out[0].method, 'under-determined');
  assert.deepEqual(out[0].cand.map((c) => c.name).sort(), ['Ann', 'Bo']);
});

test('audio nobody is lit for stays unlabelled rather than joining the nearest name', () => {
  const out = attribute({ t1: [{ startMs: 0, endMs: 2000 }] }, new Map([['Ann', [[9000, 9500]]]]));
  assert.equal(out[0].owner, null);
  assert.equal(out[0].method, 'unlabelled');
});

test('a slot keeps its occupant when the evidence is otherwise tied', () => {
  // The continuity bonus only breaks ties. It must never overturn evidence —
  // that would make a track sticky and re-create the whole-call-majority bug.
  const m = [[10, 10]];
  assert.equal(bestAssignment(m, { bonus: Object.assign([1], { weight: 2 }) }).pairs[0][1], 1);
  const strong = [[100, 10]];
  assert.equal(bestAssignment(strong, { bonus: Object.assign([1], { weight: 2 }) }).pairs[0][1], 0,
    'a 10x score gap outweighs the continuity nudge');
});

test('a slot may go unassigned when it carries sound no indicator claims', () => {
  const { pairs } = bestAssignment([[0], [50]]);
  assert.equal(pairs.filter(([, n]) => n === -1).length, 1);
  assert.equal(pairs.find(([, n]) => n === 0)[0], 1, 'the louder track wins the only name');
});

test('assignment maximises total agreement, not each track greedily', () => {
  // Greedy-by-largest would give track 0 name 0 (9) and strand track 1 with 1
  // (total 10). The optimum is the other pairing (8 + 7 = 15).
  const { pairs, score } = bestAssignment([[9, 8], [7, 1]]);
  assert.equal(score, 15);
  assert.deepEqual(pairs.filter(([, n]) => n >= 0), [[0, 1], [1, 0]]);
});

test('wav headers round-trip', () => {
  const h = parseWavHeader(wavHeader(1000, { sampleRate: 16000 }));
  assert.equal(h.sampleRate, 16000);
  assert.equal(h.channels, 1);
  assert.equal(h.bits, 16);
  assert.equal(h.dataLen, 1000);
});

test('overlapWith sums across several lit intervals', () => {
  assert.equal(overlapWith([[0, 100], [200, 400]], 50, 300), 150);
});

test('the bot is excluded under the name Meet shows, not the name the manifest stores', () => {
  // The manifest records botName "Jimmy"; Meet's people pane says "jimmy bot".
  // Exact matching lets the bot through as a fourth PERSON — and because it
  // holds no remote slot, every window it speaks in then looks like more
  // speakers than slots. That turned 4 genuinely under-determined windows into
  // 66, burying the real ones in our own TTS.
  assert.ok(isBotName('jimmy bot', 'Jimmy'));
  assert.ok(isBotName('Jimmy', 'jimmy bot'));
  assert.ok(isBotName('Alice-r1dc5', 'Alice'), 'run-tagged fleet names too');
  assert.equal(isBotName('Stan James', 'Jimmy'), false);
  assert.equal(isBotName('', 'Jimmy'), false);

  const ev = [{ k: 'ind', p: 'jimmy bot', v: '-40px', t: 100 },
              { k: 'ind', p: 'Stan James', v: '-40px', t: 100 }];
  assert.deepEqual([...litIntervals(ev, { exclude: ['Jimmy'] }).keys()], ['Stan James']);
});

test('a settled neighbour is an OCCUPIED slot, not an absent one', () => {
  // Ann is confidently on slot 1 for the whole window. Bo and Cy contest slots
  // 2 and 3. Counting only the contested slots sees "2 names, 2 slots" — fine
  // — but counting only contested slots when Ann's is ALSO busy is what breaks:
  // the real question is whether every lit person has somewhere to be.
  const lit = new Map([
    ['Ann', [[0, 4000]]],
    ['Bo', [[1000, 3000]]],
    ['Cy', [[1000, 3000]]],
  ]);
  const out = attribute({
    t1: [{ startMs: 0, endMs: 4000 }],
    t2: [{ startMs: 1000, endMs: 3000 }],
    t3: [{ startMs: 1000, endMs: 3000 }],
  }, lit);
  const byTrack = Object.fromEntries(out.map((s) => [s.track, s]));
  assert.equal(byTrack.t1.owner, 'Ann');
  assert.ok(byTrack.t2.owner && byTrack.t3.owner, 'Bo and Cy both placed, not stranded');
  assert.notEqual(byTrack.t2.owner, byTrack.t3.owner);
  for (const s of out) assert.notEqual(s.method, 'under-determined');
});

test('when every other name is placed, the last one falls out by elimination', () => {
  const lit = new Map([['Ann', [[0, 4000]]], ['Bo', [[0, 4000]]]]);
  const out = attribute({
    t1: [{ startMs: 0, endMs: 4000 }],           // sole -> Ann? no: both lit
    t2: [{ startMs: 0, endMs: 1000 }],
  }, lit);
  // Both slots busy, both names lit: solvable, and neither may be dropped.
  assert.equal(out.filter((s) => s.owner).length, 2);
  assert.notEqual(out[0].owner, out[1].owner);
});
