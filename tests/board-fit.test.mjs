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
const { MEASURE_SCRIPT, measureScriptFor, formatFitReport, formatBudget } = require('../electron-app/board-fit.js');

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

// The script is async now — it waits for the board to stop reflowing before
// measuring (see TRAP 2 in board-fit.js). The stub is a STATIC dom, so heights
// never change and it settles on the second reading.
async function measure(dom) {
  // eslint-disable-next-line no-new-func
  return new Function('document', 'requestAnimationFrame', 'setTimeout', `return ${MEASURE_SCRIPT}`)(
    dom,
    (cb) => cb(),                       // commit the frame immediately
    (cb) => cb(),                       // and don't really sleep between polls
  );
}

const BOARD_BLOCKS = [
  { tag: 'H1', text: 'Bethany — two tracks', h: 60 },
  { tag: 'H2', text: 'TRACK 1 · Scripty in class — starts in 1-2 weeks', h: 61 },
  { tag: 'P', text: 'x'.repeat(170), h: 95 },
  { tag: 'TABLE', text: 'y'.repeat(747), h: 765 },   // pushes past the fold
  { tag: 'H2', text: 'TRACK 2 · Her cohort installing it themselves', h: 61 },
  { tag: 'P', text: 'z'.repeat(120), h: 95 },
];

test('measures the SCROLLING element, not the document — the trap', async () => {
  const m = await measure(makeDom({ blocks: BOARD_BLOCKS }));

  // If this reads the document it sees 800 vs 800 and says it fits.
  assert.equal(m.fits, false, 'must not report fits when content overflows the scroller');
  assert.equal(m.viewportPx, 800);
  assert.equal(m.contentPx, 1766);
  assert.equal(m.overflowPx, 966);
  assert.equal(m.screenfuls, 2.21);
});

test('names the block that got cut, which is what the author can act on', async () => {
  const m = await measure(makeDom({ blocks: BOARD_BLOCKS }));

  // H1 60 + H2 61 + P 95 = 216; the TABLE runs 216→981, crossing the 800 fold.
  assert.match(m.firstCutOff, /^TABLE:/);
  assert.match(m.lastFullyVisible, /^P:/);
});

test('a board that fits says so, and is not scolded', async () => {
  const short = [
    { tag: 'H1', text: 'Short board', h: 60 },
    { tag: 'P', text: 'a'.repeat(100), h: 95 },
  ];
  const m = await measure(makeDom({ viewport: 800, content: 800, blocks: short }));

  assert.equal(m.fits, true);
  assert.equal(m.overflowPx, 0);
  assert.doesNotMatch(formatFitReport(m), /DOES NOT FIT/);
  assert.match(formatFitReport(m), /Fits/);
});

test('the overflow report leads with the lost content, not the pixel count', async () => {
  const m = await measure(makeDom({ blocks: BOARD_BLOCKS }));
  const report = formatFitReport(m);

  assert.match(report, /DOES NOT FIT/);
  assert.match(report, /2\.21 screenfuls/);
  assert.match(report, /Cut from: "TABLE:/);
  // It must say the room cannot rescue itself — that is WHY this matters.
  assert.match(report, /cannot scroll/);
});

test('density constants are measured per element type, not assumed', async () => {
  const m = await measure(makeDom({ blocks: BOARD_BLOCKS }));

  // A table costs far more height per character than prose; a bot budgeting
  // with one number for both will overshoot badly on a table-heavy board.
  assert.ok(m.constants.TABLE.pxPerChar > m.constants.P.pxPerChar,
    'table should cost more per char than prose');
  // Headings are a fixed cost — px-per-char is meaningless, so avgPx carries it.
  assert.equal(m.constants.H1.avgPx, 60);
});

test('budget only quotes what was actually on the board', async () => {
  const proseOnly = [
    { tag: 'H1', text: 'Just prose', h: 60 },
    { tag: 'P', text: 'p'.repeat(200), h: 110 },
  ];
  const m = await measure(makeDom({ viewport: 800, content: 800, blocks: proseOnly }));
  const budget = formatBudget(m);

  assert.match(budget, /prose ~\d+ chars\/screen/);
  // No table on this board, so inventing a table figure would be a guess
  // presented as a measurement.
  assert.doesNotMatch(budget, /table/);
});

test('an unmeasurable surface returns null rather than a confident zero', async () => {
  const empty = {
    querySelectorAll: () => [],
    querySelector: () => null,
    documentElement: { clientHeight: 0, scrollHeight: 0 },
    body: { querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }), scrollTop: 0 },
  };
  assert.equal(await measure(empty), null);
  assert.equal(formatFitReport(null), '');
  assert.equal(formatBudget(null), '');
});

test('the measurement does not change with scroll position', async () => {
  // Same board, scrolled to the bottom. Note what actually moves: a scrolling
  // CONTAINER stays where it is — only its content slides up — so the slide's
  // own rect is unchanged and each block's rect.top drops by scrollTop. (My
  // first version of this test moved the container instead and failed, which
  // is a fair reminder that the stub is a model and can be wrong.)
  // The script adds scrollTop back, so the answer must be identical.
  const dom = makeDom({ blocks: BOARD_BLOCKS });
  const before = await measure(dom);

  const slide = dom.querySelector('.wb-slide');
  const scrolled = 966;
  slide.scrollTop = scrolled;
  for (const el of dom.querySelectorAll('block')) {
    const orig = el.getBoundingClientRect();
    el.getBoundingClientRect = () => ({ top: orig.top - scrolled, height: orig.height });
  }

  const after = await measure(dom);
  assert.equal(after.overflowPx, before.overflowPx);
  assert.equal(after.firstCutOff, before.firstCutOff,
    'a scrolled board must not report a different cut point');
});

// ── TRAP 2: the measurement must not describe the PREVIOUS board ─────────────
// Live on 2026-09-06, minutes after shipping the fit report: a board cut from
// ~4,000 chars to ~1,200 still reported "3.11 screenfuls, 1687px over" and
// quoted the OLD board's last visible line. It had already become 1.04
// screenfuls. A stale report is worse than none — it tells the author the cut
// failed, so they cut again, and the board was already fine.

// A DOM that reflows LATE: the scroller reports the old tall height for the
// first few readings, then settles to the new short one. Measuring eagerly
// returns the tall (wrong) answer; waiting for it to settle returns the right one.
function makeReflowingDom({ oldHeight = 2489, newHeight = 836, settleAfter = 3 } = {}) {
  let reads = 0;
  const block = {
    tagName: 'P', textContent: 'x'.repeat(400), scrollHeight: 100, clientHeight: 100,
    scrollTop: 0, parentElement: { closest: () => null },
    getBoundingClientRect: () => ({ top: 0, height: 100 }), querySelectorAll: () => [],
  };
  const slide = {
    tagName: 'DIV', className: 'wb-slide', clientHeight: 800, scrollTop: 0,
    get scrollHeight() { reads += 1; return reads <= settleAfter ? oldHeight : newHeight; },
    getBoundingClientRect: () => ({ top: 0, height: 800 }),
    querySelectorAll: () => [block],
  };
  return {
    querySelectorAll: (sel) => (sel === '*' ? [slide, block] : [block]),
    querySelector: (sel) => (sel === '.wb-slide' ? slide : null),
    documentElement: { clientHeight: 800, scrollHeight: 800 },
    body: { querySelectorAll: () => [block], getBoundingClientRect: () => ({ top: 0 }), scrollTop: 0 },
  };
}

test('waits for the board to stop reflowing before measuring', async () => {
  const m = await measure(makeReflowingDom());

  // The eager answer is 2489px (3.11 screenfuls) — the board BEFORE the edit.
  // Settling must yield the new, shorter board instead.
  assert.equal(m.settled, true, 'should report having settled');
  assert.equal(m.contentPx, 836, 'must measure the NEW board, not the previous layout');
  assert.notEqual(m.screenfuls, 3.11, 'reporting the pre-edit board is the bug');
});

test('an unsettled measurement is flagged, not presented as fact', () => {
  // A board that never stops changing hits the timeout. It still reports — the
  // write must not be held up — but the caller has to say the number is suspect.
  const unsettled = {
    settled: false, viewportPx: 800, contentPx: 2489, overflowPx: 1689,
    screenfuls: 3.11, fits: false, lastFullyVisible: 'P: old content', firstCutOff: null,
    blocks: 4, constants: {},
  };
  const report = formatFitReport(unsettled);

  assert.match(report, /DOES NOT FIT/);
  assert.match(report, /may describe the previous/,
    'an unsettled reading must be caveated, or it sends the author cutting a board that was fine');

  // And a settled one carries no such hedge.
  assert.doesNotMatch(formatFitReport({ ...unsettled, settled: true }), /may describe the previous/);
});

// ── TRAP 2b: a STABLE OLD board answers instantly ────────────────────────────
// The first attempt at trap 2 waited for the height to stop changing. That is
// not enough: before the re-render begins, the PREVIOUS board is sitting there
// perfectly stable, so the test passes on the first reading and measures the old
// layout. Live on 2026-09-06 a 3.11-screenful board reported 1.04 — the size of
// the board it had just replaced — with the fix already in.
//
// So the measurement is given the board's signature from BEFORE the write, and
// waits for the signature to change before it trusts anything it sees.

function makeLateRenderDom({ oldHeight = 836, newHeight = 2487, rendersAfter = 3 } = {}) {
  let polls = 0;
  const block = {
    tagName: 'P', textContent: 'x'.repeat(400), scrollHeight: 100, clientHeight: 100,
    scrollTop: 0, parentElement: { closest: () => null },
    getBoundingClientRect: () => ({ top: 0, height: 100 }), querySelectorAll: () => [],
    getAttribute: () => (polls > rendersAfter ? 'sig-NEW' : 'sig-OLD'),
    attributes: [],
  };
  const slide = {
    tagName: 'DIV', className: 'wb-slide', clientHeight: 800, scrollTop: 0,
    // Rock steady at the OLD height until the re-render lands.
    get scrollHeight() { return polls > rendersAfter ? newHeight : oldHeight; },
    getBoundingClientRect: () => ({ top: 0, height: 800 }),
    querySelectorAll: () => [block],
  };
  return {
    querySelectorAll: (sel) => {
      if (sel === '[data-sig]') { polls += 1; return [block]; }
      return sel === '*' ? [slide, block] : [block];
    },
    querySelector: (sel) => (sel === '.wb-slide' ? slide : null),
    documentElement: { clientHeight: 800, scrollHeight: 800 },
    body: { querySelectorAll: () => [block], getBoundingClientRect: () => ({ top: 0 }), scrollTop: 0 },
  };
}

async function measureWithPrev(dom, prevSig) {
  // eslint-disable-next-line no-new-func
  return new Function('document', 'requestAnimationFrame', 'setTimeout',
    `return ${measureScriptFor(prevSig)}`)(dom, (cb) => cb(), (cb) => cb());
}

test('a stable OLD board does not count as settled — waits for the content to change', async () => {
  const m = await measureWithPrev(makeLateRenderDom(), 'sig-OLD');

  // The old board is 836px and never wobbles, so "stopped changing" is true
  // immediately and would answer 1.04 screenfuls. Only waiting for the signature
  // to move gets the real, new board.
  assert.equal(m.contentPx, 2487, 'must measure the NEW board, not the stable old one');
  assert.equal(m.screenfuls, 3.11);
  assert.equal(m.settled, true);
});

test('with no prior signature it still works, just without the staleness guard', async () => {
  // Back-compat path: a caller that cannot capture a signature gets the old
  // behaviour rather than an error.
  const m = await measureWithPrev(makeLateRenderDom(), null);
  assert.ok(m && typeof m.screenfuls === 'number');
});
