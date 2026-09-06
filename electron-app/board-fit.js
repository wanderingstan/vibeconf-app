// board-fit.js — tell the agent how much of the board actually fits on screen.
//
// The bot writing the whiteboard never finds out whether its content fit.
// update_whiteboard returns success whether the board sits comfortably on one
// screen or runs three screens past the bottom edge, so the author guesses and
// deliberately under-fills to be safe. Worse, the audience cannot rescue it: the
// share is a video stream of our window, so nobody in the room can scroll it.
// Content past the fold is not paginated, it is simply invisible — and the most
// important line is usually the heading at the top or the conclusion at the
// bottom, which is exactly what gets cropped. (#644)
//
// Measured live on 2026-09-06 while discussing this very issue: a board was
// 2.21 screenfuls, 966px past the fold, and Stan spent several minutes reading
// the bottom half without either of us realising the top half existed.
//
// ── THE TRAP ─────────────────────────────────────────────────────────────────
// The obvious implementation is document.scrollingElement.scrollHeight vs
// clientHeight. On the whiteboard that returns:
//
//     bodyScrollH 800  bodyClientH 800  docElScrollH 800  innerHeight 800
//     → overflow 0, fits: true
//
// ...while 966px of content sits below the fold. The document does NOT scroll.
// An inner `.wb-slide` (overflow-y:auto) does. So anything measuring the
// document reports "fits" for every board ever written — a confident wrong
// answer, which is worse than no signal at all and is the exact failure this
// module exists to remove. findScroller() below is the whole point; see the
// test that fails if the measurement is taken from the document.

'use strict';

// Runs INSIDE the share surface (a sandboxed browser page), so it must be a
// self-contained expression with no imports and no closure over this module.
// Kept as a string because that is how it reaches the page — see
// evalInShare()/onEvalShare in main.js.
//
// Returns null when there is no scrollable container at all, which is how a
// caller distinguishes "measured, and it fits" from "could not measure".
const MEASURE_SCRIPT = `(() => {
  // The scrolling element is NOT the document — see board-fit.js.  Walk for a
  // real scroller and take the tallest, so a small inner scroller (a code block
  // with overflow, say) cannot be mistaken for the board container.
  let scroller = null;
  for (const n of document.querySelectorAll('*')) {
    if (n.scrollHeight > n.clientHeight + 4 && n.clientHeight > 100) {
      if (!scroller || n.clientHeight > scroller.clientHeight) scroller = n;
    }
  }
  // No overflow anywhere: the board fits. Fall back to the visible viewport so
  // the caller still learns the surface size and the density constants.
  const fitted = !scroller;
  const view = scroller ? scroller.clientHeight
    : (document.querySelector('.wb-slide')?.clientHeight || document.documentElement.clientHeight);
  const total = scroller ? scroller.scrollHeight : view;
  if (!view) return null;

  const BLOCK = 'h1,h2,h3,h4,p,table,ul,ol,pre,blockquote';
  const root = scroller || document.body;
  const blocks = Array.from(root.querySelectorAll(BLOCK)).filter(
    (el) => !el.parentElement.closest(BLOCK),
  );

  // Offset of each block relative to the scroller's content box, so the answer
  // does not change with the current scroll position. getBoundingClientRect is
  // viewport-relative; add scrollTop back to get a stable content offset.
  const originTop = root.getBoundingClientRect().top - (root.scrollTop || 0);
  const label = (el) => el
    ? el.tagName + ': ' + (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70)
    : null;

  let lastFullyVisible = null;
  let firstCutOff = null;
  const cost = {};
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    const top = r.top - originTop;
    const bottom = top + r.height;
    if (bottom <= view) lastFullyVisible = el;
    else if (!firstCutOff && top < view) firstCutOff = el;
    // Density per element type, so a bot can estimate BEFORE writing. These are
    // measured rather than hard-coded because set_whiteboard_style can change
    // the type at any moment (#704) and a stale constant is a wrong constant.
    const tag = el.tagName;
    const chars = (el.textContent || '').trim().length;
    const c = (cost[tag] = cost[tag] || { n: 0, px: 0, chars: 0 });
    c.n += 1; c.px += r.height; c.chars += chars;
  }

  const constants = {};
  for (const [tag, c] of Object.entries(cost)) {
    constants[tag] = {
      count: c.n,
      avgPx: Math.round(c.px / c.n),
      // Headings are a fixed cost regardless of length, so px-per-char is
      // meaningless for them; the caller uses avgPx instead.
      pxPerChar: c.chars ? Number((c.px / c.chars).toFixed(3)) : null,
    };
  }

  return {
    viewportPx: Math.round(view),
    contentPx: Math.round(total),
    overflowPx: Math.max(0, Math.round(total - view)),
    screenfuls: Number((total / view).toFixed(2)),
    fits: fitted || total <= view + 2,
    lastFullyVisible: label(lastFullyVisible),
    firstCutOff: label(firstCutOff),
    blocks: blocks.length,
    constants,
  };
})()`;

// Turn a measurement into the line the agent actually reads.
//
// Deliberately leads with the block that got cut rather than the pixel count:
// the bot authored the content, so "you lost everything from '#673 No live
// view' onwards" tells it where to split. A number does not.
function formatFitReport(m) {
  if (!m || !m.viewportPx) return '';

  if (m.fits) {
    const room = m.viewportPx - m.contentPx;
    // Only mention headroom when there is a useful amount, otherwise every
    // successful write grows a sentence nobody needs.
    return room >= 80
      ? ` Fits, with about ${room}px to spare.`
      : ' Fits, but only just — no room for another line.';
  }

  const parts = [
    ` ⚠️ DOES NOT FIT: ${m.screenfuls} screenfuls, ${m.overflowPx}px below the fold —`
    + ` the room can only see the first screen and cannot scroll.`,
  ];
  if (m.firstCutOff) parts.push(` Cut from: "${m.firstCutOff}".`);
  if (m.lastFullyVisible) parts.push(` Last fully visible: "${m.lastFullyVisible}".`);
  parts.push(' Split it across several writes, or shorten it.');
  return parts.join('');
}

// A compact budget for the NEXT write, so a bot can aim before it writes rather
// than measuring afterwards and trying again. Stan's ask on 2026-09-06: "just
// those three numbers as a ballpark estimate would allow a bot to make a pretty
// informed decision."
//
// Only reports what was actually on the board — a board with no table cannot
// tell you what a table costs, and inventing a figure for one would be worse
// than staying quiet about it.
function formatBudget(m) {
  if (!m || !m.constants || !m.viewportPx) return '';
  const c = m.constants;
  const bits = [];
  const prose = c.P?.pxPerChar;
  if (prose) bits.push(`prose ~${Math.round(m.viewportPx / prose)} chars/screen`);
  const table = c.TABLE?.pxPerChar;
  if (table) bits.push(`table ~${Math.round(m.viewportPx / table)} chars/screen`);
  const heading = c.H1?.avgPx || c.H2?.avgPx;
  if (heading) bits.push(`each heading ~${heading}px of ${m.viewportPx}`);
  return bits.length ? ` Budget for this board's styling: ${bits.join(', ')}.` : '';
}

module.exports = { MEASURE_SCRIPT, formatFitReport, formatBudget };
