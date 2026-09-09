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
// ── THE BOARD NOW MEASURES ITSELF; THIS FILE JUST READS THE ANSWER ───────────
//
// This used to inject a measuring script into the share surface and poll: wait
// for a content signature to change, then wait for the scroll height to stop
// moving, both bounded by a timeout. That approach is dead, and it is worth
// recording why, because both of its failures shipped and both were wrong on a
// live call:
//
//   1. Measure right after the write → reads the PREVIOUS layout. The write
//      goes to the sync server and comes back over SSE, so the pixels move a
//      network round-trip after update_whiteboard returns. A board cut from
//      ~4,000 characters to ~1,200 reported "3.11 screenfuls, 1687px over" and
//      quoted the OLD board's last visible line. It had already become 1.04.
//   2. Wait for the height to stop changing → the previous board is sitting
//      there perfectly stable, so that test passes on the first reading and
//      still measures the old board.
//
// The signature check was the patch for (2), and the timeout was the patch for
// how long to wait. Both are guesses about someone else's network: the timeout
// was 600ms, it expired twice on one call, and raising it just moves the guess.
//
// The renderer knows exactly when it has finished laying out, so that is where
// the measurement belongs. The website's Whiteboard component now measures
// itself after each patch (inside a requestAnimationFrame, and again when a
// Mermaid diagram resolves and changes the height) and publishes:
//
//     window.__vcBoardFit = { version, measuredAt, viewportPx, contentPx,
//                             overflowPx, screenfuls, fits, lastFullyVisible,
//                             firstCutOff, blocks, constants }
//
// `version` is the board version the measurement describes. That stamp is the
// whole point: "has it finished?" stops being a guess and becomes a comparison.
// Capture the version before the write, accept only a measurement stamped
// NEWER, and staleness is impossible rather than unlikely.
//
// See vibeconferencing#540 (`publishFit` in src/components/Whiteboard.tsx). The
// whiteboard is rendered by the WEBSITE, so a user on an older build publishes
// nothing at all — that is a normal, silent outcome here, not an error.
//
// ── The remaining timeout is a failsafe, not the mechanism ───────────────────
// If the renderer never publishes a newer measurement — old website build, a
// wedged renderer — we must not hold up the write forever. So there is still a
// bound, but nothing depends on its value being tuned: expiring means "report
// what is there, flagged as unsettled" or "report nothing", never "report the
// previous board as fact".

'use strict';

// Read the version stamp of whatever measurement is on the board RIGHT NOW,
// captured BEFORE the write so the read afterwards can tell "this describes the
// board I just wrote" from "this is the one before it".
//
// null means the board has never published a measurement: an older website
// build, or a surface that has not rendered yet.
const FIT_VERSION_SCRIPT = `(() => {
  const fit = window.__vcBoardFit;
  return (fit && typeof fit.version === 'number') ? fit.version : null;
})()`;

const POLL_MS = 40;
// A pure failsafe. Nothing is timed against this: the version comparison decides
// whether a measurement is trustworthy, and this only bounds how long we are
// willing to sit here when the answer is never going to arrive.
const FAILSAFE_TIMEOUT_MS = 2500;

// Runs INSIDE the share surface (a sandboxed browser page), so it must be a
// self-contained expression with no imports and no closure over this module.
// Kept as a string because that is how it reaches the page — see
// evalInShare()/onEvalShare in main.js. Async: executeJavaScript resolves the
// promise it returns.
//
// Returns null when there is nothing to read, which is how a caller
// distinguishes "measured, and it fits" from "could not measure".
const readFitScriptFor = (previousVersion) => `(async () => {
  const POLL = ${POLL_MS}, LIMIT = ${FAILSAFE_TIMEOUT_MS};
  const PREV = ${JSON.stringify(previousVersion ?? null)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const read = () => {
    const fit = window.__vcBoardFit;
    return (fit && typeof fit.viewportPx === 'number' && fit.viewportPx) ? fit : null;
  };

  // GREATER than, not equal to. The app's local version counter and the sync
  // server's INCR can diverge (a write from another client, a reconnect), and a
  // measurement newer than the board we replaced is still a correct answer for
  // what is on screen now. Equal is NOT enough: that is the measurement of the
  // board we just overwrote, which is exactly the stale report this replaces.
  //
  // PREV === null means nothing was published before this write. The before-read
  // and this read travel the same channel, so a missing PREV is the board having
  // published nothing, not a failure to look — and in that case anything we find
  // here appeared after the write.
  const isNewer = (fit) => !!fit
    && (PREV === null || (typeof fit.version === 'number' && fit.version > PREV));

  const startedAt = Date.now();
  let fit = read();
  while (!isNewer(fit) && Date.now() - startedAt < LIMIT) {
    await sleep(POLL);
    fit = read();
  }

  // Nothing published at all: an older website build, or a surface showing
  // something that is not the whiteboard. Silence, not a guess.
  if (!fit) return null;

  // A stale measurement still gets reported — the write must not be held up —
  // but flagged, so formatFitReport caveats it rather than presenting the
  // previous board's numbers as fact.
  return Object.assign({}, fit, { settled: isNewer(fit) });
})()`;

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

module.exports = { FIT_VERSION_SCRIPT, readFitScriptFor, formatFitReport, formatBudget, FAILSAFE_TIMEOUT_MS };
