// board-fit.test.mjs — the board tells the bot how much of it actually fit.
//
// The bug this guards against is silent: measure the DOCUMENT instead of the
// scrolling element and every board ever written reports "fits", including the
// 2.21-screenful one measured live on 2026-09-06 that had 966px below the fold.
// A confident wrong answer is worse than no answer, because the bot stops
// checking. So the first test here runs the real measurement script against a
// DOM shaped like the actual whiteboard — document 800px, inner .wb-slide
// scrolling to 1766px — and fails if the answer comes from the document.
//
// Run: node --test tests/board-fit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MEASURE_SCRIPT, formatFitReport, formatBudget } = require('../electron-app/board-fit.js');

// ── A DOM stub shaped like the whiteboard ────────────────────────────────────
// Only what MEASURE_SCRIPT touches. Real numbers from the 2026-09-06 board.
function makeDom({ viewport = 800, content = 1766, blocks = [] } = {}) {
  const mk = (spec, top) => ({
    tagName: spec.tag,
    textContent: spec.text,
    scrollHeight: spec.h,
    clientHeight: spec.h,
    scrollTop: 0,
    parentElement: { closest: () => null },   // all top-level
    getBoundingClientRect: () => ({ top, height: spec.h }),
    querySelectorAll: () => [],
  });

  let y = 0;
  const els = blocks.map((b) => { const el = mk(b, y); y += b.h; return el; });

  const slide = {
    tagName: 'DIV',
    className: 'wb-slide',
    clientHeight: viewport,
    scrollHeight: content,
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, height: viewport }),
    querySelectorAll: () => els,
  };

  // The document reports 800/800 — no overflow — which is the trap.
  const docEl = { clientHeight: viewport, scrollHeight: viewport };
  const body = { querySelectorAll: () => els, getBoundingClientRect: () => ({ top: 0 }), scrollTop: 0 };

  return {
    querySelectorAll: (sel) => (sel === '*' ? [slide, ...els] : els),
    querySelector: (sel) => (sel === '.wb-slide' ? slide : null),
    documentElement: docEl,
    body,
  };
}

function measure(dom) {
  // eslint-disable-next-line no-new-func
  return new Function('document', `return ${MEASURE_SCRIPT}`)(dom);
}

const BOARD_BLOCKS = [
  { tag: 'H1', text: 'Bethany — two tracks', h: 60 },
  { tag: 'H2', text: 'TRACK 1 · Scripty in class — starts in 1-2 weeks', h: 61 },
  { tag: 'P', text: 'x'.repeat(170), h: 95 },
  { tag: 'TABLE', text: 'y'.repeat(747), h: 765 },   // pushes past the fold
  { tag: 'H2', text: 'TRACK 2 · Her cohort installing it themselves', h: 61 },
  { tag: 'P', text: 'z'.repeat(120), h: 95 },
];

test('measures the SCROLLING element, not the document — the trap', () => {
  const m = measure(makeDom({ blocks: BOARD_BLOCKS }));

  // If this reads the document it sees 800 vs 800 and says it fits.
  assert.equal(m.fits, false, 'must not report fits when content overflows the scroller');
  assert.equal(m.viewportPx, 800);
  assert.equal(m.contentPx, 1766);
  assert.equal(m.overflowPx, 966);
  assert.equal(m.screenfuls, 2.21);
});

test('names the block that got cut, which is what the author can act on', () => {
  const m = measure(makeDom({ blocks: BOARD_BLOCKS }));

  // H1 60 + H2 61 + P 95 = 216; the TABLE runs 216→981, crossing the 800 fold.
  assert.match(m.firstCutOff, /^TABLE:/);
  assert.match(m.lastFullyVisible, /^P:/);
});

test('a board that fits says so, and is not scolded', () => {
  const short = [
    { tag: 'H1', text: 'Short board', h: 60 },
    { tag: 'P', text: 'a'.repeat(100), h: 95 },
  ];
  const m = measure(makeDom({ viewport: 800, content: 800, blocks: short }));

  assert.equal(m.fits, true);
  assert.equal(m.overflowPx, 0);
  assert.doesNotMatch(formatFitReport(m), /DOES NOT FIT/);
  assert.match(formatFitReport(m), /Fits/);
});

test('the overflow report leads with the lost content, not the pixel count', () => {
  const m = measure(makeDom({ blocks: BOARD_BLOCKS }));
  const report = formatFitReport(m);

  assert.match(report, /DOES NOT FIT/);
  assert.match(report, /2\.21 screenfuls/);
  assert.match(report, /Cut from: "TABLE:/);
  // It must say the room cannot rescue itself — that is WHY this matters.
  assert.match(report, /cannot scroll/);
});

test('density constants are measured per element type, not assumed', () => {
  const m = measure(makeDom({ blocks: BOARD_BLOCKS }));

  // A table costs far more height per character than prose; a bot budgeting
  // with one number for both will overshoot badly on a table-heavy board.
  assert.ok(m.constants.TABLE.pxPerChar > m.constants.P.pxPerChar,
    'table should cost more per char than prose');
  // Headings are a fixed cost — px-per-char is meaningless, so avgPx carries it.
  assert.equal(m.constants.H1.avgPx, 60);
});

test('budget only quotes what was actually on the board', () => {
  const proseOnly = [
    { tag: 'H1', text: 'Just prose', h: 60 },
    { tag: 'P', text: 'p'.repeat(200), h: 110 },
  ];
  const m = measure(makeDom({ viewport: 800, content: 800, blocks: proseOnly }));
  const budget = formatBudget(m);

  assert.match(budget, /prose ~\d+ chars\/screen/);
  // No table on this board, so inventing a table figure would be a guess
  // presented as a measurement.
  assert.doesNotMatch(budget, /table/);
});

test('an unmeasurable surface returns null rather than a confident zero', () => {
  const empty = {
    querySelectorAll: () => [],
    querySelector: () => null,
    documentElement: { clientHeight: 0, scrollHeight: 0 },
    body: { querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }), scrollTop: 0 },
  };
  assert.equal(measure(empty), null);
  assert.equal(formatFitReport(null), '');
  assert.equal(formatBudget(null), '');
});

test('the measurement does not change with scroll position', () => {
  // Same board, scrolled to the bottom. Note what actually moves: a scrolling
  // CONTAINER stays where it is — only its content slides up — so the slide's
  // own rect is unchanged and each block's rect.top drops by scrollTop. (My
  // first version of this test moved the container instead and failed, which
  // is a fair reminder that the stub is a model and can be wrong.)
  // The script adds scrollTop back, so the answer must be identical.
  const dom = makeDom({ blocks: BOARD_BLOCKS });
  const before = measure(dom);

  const slide = dom.querySelector('.wb-slide');
  const scrolled = 966;
  slide.scrollTop = scrolled;
  for (const el of dom.querySelectorAll('block')) {
    const orig = el.getBoundingClientRect();
    el.getBoundingClientRect = () => ({ top: orig.top - scrolled, height: orig.height });
  }

  const after = measure(dom);
  assert.equal(after.overflowPx, before.overflowPx);
  assert.equal(after.firstCutOff, before.firstCutOff,
    'a scrolled board must not report a different cut point');
});
