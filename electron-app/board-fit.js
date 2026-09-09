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
// ── TRAP 1: THE DOCUMENT DOES NOT SCROLL ─────────────────────────────────────
// The obvious implementation is document.scrollingElement.scrollHeight vs
// clientHeight. On the whiteboard that returns:
//
//     bodyScrollH 800  bodyClientH 800  docElScrollH 800  innerHeight 800
//     → overflow 0, fits: true
//
// ...while 966px of content sits below the fold. An inner `.wb-slide`
// (overflow-y:auto) is the real scroller. So anything measuring the document
// reports "fits" for every board ever written — a confident wrong answer, worse
// than no signal at all. findScroller below is the whole point; see the test
// that fails if the measurement is taken from the document.
//
// ── TRAP 2: THE PIXELS HAVE NOT MOVED YET ────────────────────────────────────
// Measuring straight after the write returns reads the PREVIOUS layout. The
// write goes to the sync server; the board re-renders asynchronously from that.
//
// Caught live on 2026-09-06, minutes after shipping trap 1: a board cut from
// ~4,000 characters to ~1,200 still reported "3.11 screenfuls, 1687px over" and
// quoted the OLD board's last visible line. It had in fact become 1.04
// screenfuls — the cut had worked. A stale fit report is worse than none: it
// tells the author their fix failed, so they cut again, and the board they are
// trying to fix was already fine.
//
// So the script waits for the scroller height to stop changing before measuring.
// Bounded, because a board that never settles must not hold up the write: on
// timeout it measures anyway and reports `settled: false`, and the caller says so
// rather than presenting a possibly-stale number as fact.

'use strict';

// Fingerprint of what is on the board RIGHT NOW, captured BEFORE the write so
// the measurement afterwards can tell "the new content has rendered" from "the
// old content is sitting there, perfectly stable".
//
// Uses the renderer's own per-section `data-sig` (a hash of each section's
// markup, maintained for reconcile), falling back to text length if the board
// has not rendered sections yet.
const SIGNATURE_SCRIPT = `(() => {
  const sigs = Array.from(document.querySelectorAll('[data-sig]'))
    .map((el) => el.getAttribute('data-sig')).join('|');
  return sigs || String((document.body.textContent || '').trim().length);
})()`;

const SETTLE_POLL_MS = 40;
// Generous on purpose. The board does not re-render locally: the write goes to
// the sync server and comes back over SSE, so the pixels move a full network
// round-trip after update_whiteboard returns. 600ms was a guess and it was too
// short — it expired twice on a live call, reporting the previous board both
// times.
//
// The cost of a large budget is near zero, because both phases exit the instant
// the board changes and then settles; this bounds only the pathological case.
// And the one case that would genuinely burn the whole budget — content that is
// byte-identical, so the signature never changes — is skipped by the caller
// before we are ever invoked.
const SETTLE_TIMEOUT_MS = 3000;

// Runs INSIDE the share surface (a sandboxed browser page), so it must be a
// self-contained expression with no imports and no closure over this module.
// Kept as a string because that is how it reaches the page — see
// evalInShare()/onEvalShare in main.js. Async: executeJavaScript resolves the
// promise it returns.
//
// Returns null when there is nothing measurable, which is how a caller
// distinguishes "measured, and it fits" from "could not measure".
const measureScriptFor = (previousSignature) => `(async () => {
  const POLL = ${SETTLE_POLL_MS}, LIMIT = ${SETTLE_TIMEOUT_MS};
  const PREV = ${JSON.stringify(previousSignature ?? null)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const signature = () => {
    const sigs = Array.from(document.querySelectorAll('[data-sig]'))
      .map((el) => el.getAttribute('data-sig')).join('|');
    return sigs || String((document.body.textContent || '').trim().length);
  };

  // The scrolling element is NOT the document — see board-fit.js. Take the
  // tallest real scroller, so a small inner one (an overflowing code block, say)
  // cannot be mistaken for the board container.
  const findScroller = () => {
    let best = null;
    for (const n of document.querySelectorAll('*')) {
      if (n.scrollHeight > n.clientHeight + 4 && n.clientHeight > 100) {
        if (!best || n.clientHeight > best.clientHeight) best = n;
      }
    }
    return best;
  };
  const heightNow = () => {
    const el = findScroller();
    if (el) return el.scrollHeight;
    const slide = document.querySelector('.wb-slide');
    return slide ? slide.scrollHeight : 0;
  };

  // Let the renderer commit a frame first, so an instant render is not measured
  // mid-reconcile.
  await new Promise((r) => requestAnimationFrame(() => r()));

  const startedAt = Date.now();

  // PHASE 1 — wait for the board to actually become the new content.
  //
  // Waiting only for "the height stopped changing" is not enough: before the
  // re-render begins, the PREVIOUS board is sitting there perfectly stable, so
  // that test passes instantly and measures the old layout. (Exactly what
  // happened on 2026-09-06: a 3.11-screenful board reported 1.04, the size of
  // the board it replaced.) PREV is the signature captured before the write, so
  // a signature that still equals it means the new content has not landed yet.
  let arrived = PREV === null;   // nothing to wait for if we were not told
  while (!arrived && Date.now() - startedAt < LIMIT) {
    if (signature() !== PREV) { arrived = true; break; }
    await sleep(POLL);
  }

  // PHASE 2 — now that it is the new content, wait for it to stop reflowing.
  let settled = false, previous = -1;
  while (Date.now() - startedAt < LIMIT) {
    const h = heightNow();
    if (h === previous) { settled = true; break; }
    previous = h;
    await sleep(POLL);
  }
  settled = settled && arrived;

  const scroller = findScroller();
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

  // Offset relative to the scroller's content box, so the answer does not change
  // with scroll position (getBoundingClientRect is viewport-relative).
  const originTop = root.getBoundingClientRect().top - (root.scrollTop || 0);
  const label = (el) => el
    ? el.tagName + ': ' + (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70)
    : null;

  let lastFullyVisible = null, firstCutOff = null;
  const cost = {};
  for (const el of blocks) {
    const r = el.getBoundingClientRect();
    const top = r.top - originTop;
    const bottom = top + r.height;
    if (bottom <= view) lastFullyVisible = el;
    else if (!firstCutOff && top < view) firstCutOff = el;
    // Density per element type, measured rather than assumed: set_whiteboard_style
    // can change the type at any moment, so a hard-coded constant is a wrong one.
    const chars = (el.textContent || '').trim().length;
    const c = (cost[el.tagName] = cost[el.tagName] || { n: 0, px: 0, chars: 0 });
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
    settled,
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

// Back-compat for callers that do not capture a prior signature: still waits for
// the reflow to settle, but cannot tell a stale board from a settled one.
const MEASURE_SCRIPT = measureScriptFor(null);

// Turn a measurement into the line the agent actually reads.
//
// Deliberately leads with the block that got cut rather than the pixel count:
// the bot authored the content, so "you lost everything from '#673 No live
// view' onwards" tells it where to split. A number does not.
function formatFitReport(m) {
  if (!m || !m.viewportPx) return '';

  // An unsettled measurement may describe the PREVIOUS board. Say so rather than
  // presenting it as fact — that is what sends an author cutting content which
  // was already fine.
  const caveat = m.settled === false
    ? ' (measured before the board finished rendering, so this may describe the previous'
      + ' content — write again to confirm)'
    : '';

  if (m.fits) {
    const room = m.viewportPx - m.contentPx;
    return room >= 80
      ? ` Fits, with about ${room}px to spare.${caveat}`
      : ` Fits, but only just — no room for another line.${caveat}`;
  }

  const parts = [
    ` ⚠️ DOES NOT FIT: ${m.screenfuls} screenfuls, ${m.overflowPx}px below the fold —`
    + ` the room can only see the first screen and cannot scroll.`,
  ];
  if (m.firstCutOff) parts.push(` Cut from: "${m.firstCutOff}".`);
  if (m.lastFullyVisible) parts.push(` Last fully visible: "${m.lastFullyVisible}".`);
  parts.push(' Split it across several writes, or shorten it.');
  if (caveat) parts.push(caveat);
  return parts.join('');
}

// A compact budget for the NEXT write, so a bot can aim before it writes rather
// than measuring afterwards and trying again. Stan's ask on 2026-09-06: "just
// those three numbers as a ballpark estimate would allow a bot to make a pretty
// informed decision."
//
// Only reports what was actually on the board — a board with no table cannot
// tell you what a table costs, and inventing a figure would be worse than
// staying quiet about it.
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

module.exports = { MEASURE_SCRIPT, measureScriptFor, SIGNATURE_SCRIPT, formatFitReport, formatBudget, SETTLE_TIMEOUT_MS };
