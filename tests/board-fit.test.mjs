// board-fit.test.mjs — the board tells the bot how much of it actually fit.
//
// The bug these guard against is silent, and it shipped twice: report the
// PREVIOUS board's numbers as if they described the one just written. An author
// told "3.11 screenfuls, 1687px over" cuts the board again — and the board it is
// cutting was already fine. A confident wrong answer is worse than none.
//
// The app no longer measures the board from outside. The renderer publishes its
// own measurement stamped with the board version it describes
// (vibeconferencing#540), and this module reads it and accepts it only when the
// stamp is NEWER than the one that was there before the write. So the tests that
// matter are about the version comparison, not about DOM geometry.
//
// Run: node --test tests/board-fit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  FIT_VERSION_SCRIPT, readFitScriptFor, formatFitReport, formatBudget, FAILSAFE_TIMEOUT_MS,
} = require('../electron-app/board-fit.js');

// ── A published measurement, shaped like the renderer's ──────────────────────
// Real numbers from the 2026-09-06 board: 800px of viewport, 1766px of content.
const publishedFit = (version, over = {}) => ({
  version,
  measuredAt: 1757000000000,
  viewportPx: 800,
  contentPx: 1766,
  overflowPx: 966,
  screenfuls: 2.21,
  fits: false,
  lastFullyVisible: 'P: the paragraph above the fold',
  firstCutOff: 'TABLE: the one that got cut',
  blocks: 6,
  constants: {
    P: { count: 2, avgPx: 95, pxPerChar: 0.559 },
    TABLE: { count: 1, avgPx: 765, pxPerChar: 1.024 },
    H1: { count: 1, avgPx: 60, pxPerChar: 3.0 },
  },
  ...over,
});

// Run the reader script the way the share surface would, against a fake window.
//
// `window.__vcBoardFit` may be a function of time: `publishAfter` models the
// renderer landing its measurement N poll ticks after we started looking, which
// is the normal case (the write is a network round trip away from the pixels).
//
// The clock is FAKE and driven by the stubbed setTimeout, so the failsafe test
// does not sit here for real seconds — and `Date` is injected precisely so the
// script's own `Date.now()` reads it.
async function readFit(previousVersion, { fitAt = () => null } = {}) {
  let clock = 0;
  const win = { get __vcBoardFit() { return fitAt(clock); } };
  const setTimeout = (cb, ms) => { clock += ms; cb(); };
  const FakeDate = { now: () => clock };
  // eslint-disable-next-line no-new-func
  return new Function('window', 'setTimeout', 'Date', `return ${readFitScriptFor(previousVersion)}`)(
    win, setTimeout, FakeDate,
  );
}

// The reader waits for a measurement stamped NEWER than the one there before the
// write. This is the whole mechanism: no height polling, no settle heuristic.
test('a measurement with a NEWER version is accepted, and marked settled', async () => {
  const m = await readFit(41, { fitAt: (t) => publishedFit(t >= 200 ? 42 : 41) });

  assert.equal(m.settled, true);
  assert.equal(m.version, 42);
  assert.equal(m.contentPx, 1766);
  assert.equal(m.screenfuls, 2.21);
  assert.equal(m.fits, false);
});

// THE STALE-BOARD BUG. The previous board sits there fully rendered and
// perfectly stable, and its measurement is already published. Anything that
// accepts what it finds — or accepts an equal version — reports the board that
// was just overwritten. Delete the `> PREV` comparison in board-fit.js and this
// test fails: the reader returns settled:true for version 41.
test('the SAME version is rejected — that is the board we just overwrote', async () => {
  const m = await readFit(41, { fitAt: () => publishedFit(41) });

  assert.equal(m.settled, false,
    'a measurement stamped with the pre-write version describes the OLD board');
  assert.match(formatFitReport(m), /may describe the previous/);
});

test('an OLDER version is rejected too', async () => {
  const m = await readFit(41, { fitAt: () => publishedFit(7) });

  assert.equal(m.settled, false);
});

// GREATER THAN, not equal to: the app's local counter and the sync server's INCR
// can diverge (another client wrote, or a reconnect resynced), and a measurement
// newer than the board we replaced is still a correct answer for what is on
// screen right now. Requiring exact equality would throw good measurements away.
test('a version that jumped past ours is still accepted', async () => {
  const m = await readFit(41, { fitAt: () => publishedFit(58) });

  assert.equal(m.settled, true);
  assert.equal(m.version, 58);
});

// The whiteboard is rendered by the WEBSITE, so a user on a build older than
// vibeconferencing#540 never publishes anything. That has to be silence — and
// silence must not fail the write.
test('no __vcBoardFit at all → null, so the write reports nothing rather than guessing', async () => {
  const m = await readFit(41, { fitAt: () => undefined });

  assert.equal(m, null);
  assert.equal(formatFitReport(m), '', 'null must format to nothing, not to a hedge');
  assert.equal(formatBudget(m), '');
});

test('a half-formed publication is treated as absent, not measured', async () => {
  // No viewportPx means nothing can be divided by it; reporting 0 screenfuls
  // would be a fabricated number.
  const m = await readFit(41, { fitAt: () => ({ version: 99 }) });

  assert.equal(m, null);
});

// The failsafe. The renderer is wedged, or SSE never delivers, so a newer
// measurement never appears. We must not hold the write open forever, and we
// must not present the old board's numbers as fact.
test('the failsafe expires → settled:false, and the caveat fires', async () => {
  let looks = 0;
  const m = await readFit(41, { fitAt: () => { looks += 1; return publishedFit(41); } });

  assert.equal(m.settled, false);
  assert.ok(looks > 1, 'it should have kept looking rather than answering on the first read');
  const report = formatFitReport(m);
  assert.match(report, /DOES NOT FIT/, 'the numbers are still reported — the write is not held up');
  assert.match(report, /may describe the previous/,
    'an unsettled reading must be caveated, or it sends the author cutting a board that was fine');
});

test('the failsafe is bounded, not open-ended', async () => {
  // Fake clock ticks POLL ms per sleep, so a bounded loop terminates; an
  // unbounded one hangs this test rather than passing it.
  assert.ok(FAILSAFE_TIMEOUT_MS > 0 && FAILSAFE_TIMEOUT_MS <= 10000);
  const m = await readFit(41, { fitAt: () => publishedFit(41) });
  assert.equal(m.settled, false);
});

// Nothing was published before the write (first render of the session, or a
// board that has never been written). Then anything we find here appeared after
// the write, so there is nothing to compare against and nothing to hedge.
test('no prior version → the first measurement to appear is accepted', async () => {
  const m = await readFit(null, { fitAt: () => publishedFit(1) });

  assert.equal(m.settled, true);
  assert.equal(m.version, 1);
});

// ── The version probe taken before the write ─────────────────────────────────
const probeVersion = (win) =>
  // eslint-disable-next-line no-new-func
  new Function('window', `return ${FIT_VERSION_SCRIPT}`)(win);

test('the pre-write probe reads the published version, or null when there is none', () => {
  assert.equal(probeVersion({ __vcBoardFit: publishedFit(41) }), 41);
  assert.equal(probeVersion({}), null);
  assert.equal(probeVersion({ __vcBoardFit: { version: 'nope' } }), null);
  assert.equal(probeVersion({ __vcBoardFit: publishedFit(0) }), 0,
    'version 0 is a real version, not a missing one');
});

// A board on version 0 that is never rewritten would be indistinguishable from
// "nothing published" if the probe returned null for 0 — and the reader would
// then accept the OLD board as new. Guard the boundary explicitly.
test('version 0 before the write still requires a newer measurement after it', async () => {
  assert.equal((await readFit(0, { fitAt: () => publishedFit(0) })).settled, false);
  assert.equal((await readFit(0, { fitAt: () => publishedFit(1) })).settled, true);
});

// ── The report the agent actually reads ──────────────────────────────────────
test('a board that fits says so, and is not scolded', () => {
  const m = { ...publishedFit(9), contentPx: 500, overflowPx: 0, screenfuls: 0.63, fits: true, settled: true };

  assert.doesNotMatch(formatFitReport(m), /DOES NOT FIT/);
  assert.match(formatFitReport(m), /Fits, with about 300px to spare/);
});

test('a board that overflows names the block that got cut — what the author can act on', () => {
  const report = formatFitReport({ ...publishedFit(9), settled: true });

  assert.match(report, /DOES NOT FIT: 2\.21 screenfuls, 966px below the fold/);
  assert.match(report, /Cut from: "TABLE: the one that got cut"/);
  assert.match(report, /Last fully visible: "P: /);
  assert.doesNotMatch(report, /may describe the previous/, 'a settled reading carries no hedge');
});

test('the budget reports only element types the board actually contained', () => {
  const budget = formatBudget({ ...publishedFit(9), settled: true });

  assert.match(budget, /prose ~1431 chars\/screen/);   // 800 / 0.559
  assert.match(budget, /table ~781 chars\/screen/);    // 800 / 1.024
  assert.match(budget, /each heading ~60px of 800/);

  // A board with no table cannot say what a table costs.
  const noTable = { ...publishedFit(9), constants: { P: { count: 2, avgPx: 95, pxPerChar: 0.5 } } };
  assert.doesNotMatch(formatBudget(noTable), /table/);
});

test('nothing measured formats to nothing at all', () => {
  assert.equal(formatFitReport(null), '');
  assert.equal(formatBudget(null), '');
  assert.equal(formatFitReport({ settled: true }), '', 'no viewport means no answer');
});

// ── The polling is gone ──────────────────────────────────────────────────────
// Not decoration: the height/signature settle loop is the thing being deleted,
// and a re-introduction would silently bring the stale reports back with it.
test('the reader does not measure the DOM or poll for a settle', () => {
  const src = readFitScriptFor(41);

  assert.match(src, /__vcBoardFit/, 'it reads what the renderer published');
  assert.doesNotMatch(src, /scrollHeight|clientHeight|getBoundingClientRect/,
    'measuring geometry from outside is exactly the losing game this replaces');
  assert.doesNotMatch(src, /data-sig/, 'the content-signature phase is gone');
  assert.doesNotMatch(src, /\.wb-slide/, 'no reaching into the renderer\'s markup');
});
