// screen-settle.js — #673. Notice that a participant's SHARED SCREEN changed
// while nobody is speaking, cheaply enough to run continuously.
//
// The bug, in Bethany's words: "I shared it like 10 seconds ago. Why aren't you
// seeing it?" A bot between turns is parked in wait_for_speech, a long poll that
// returns when someone SPEAKS or when it times out. A screen that changes in
// silence cannot reach it — not slowly, at all. So something has to watch the
// picture and wake that poll the way a new chat message already does.
//
// This module is the watching half, and it is arithmetic over a small array. No
// model, no vision API, no dependency. The expensive look (a screenshot into a
// vision model) is what this GATES, not what it does.
//
// ---------------------------------------------------------------------------
// WHY NOT ui-signature.js (#615) AS-IS
// ---------------------------------------------------------------------------
// It exists, it is tested, and it is the wrong tool here — not because its
// threshold needs tuning but because the two uses want OPPOSITE things. The
// visual changelog downscales to 16x16 specifically to DESTROY small changes, so
// a ticking clock and anti-aliasing do not read as a redesign. Settle detection
// has to CATCH exactly those small changes: a student fixing a typo in a git
// command is two words on a terminal line, and that is the whole signal.
//
// The numbers, at the shipping default meetViewSize of 2560x1440, with a
// 1920-wide screen shared into a presentation tile roughly that wide (scale ~1):
//
//   smallest change worth catching  ~= two words of 12px text  ~= 90 x 11 px
//
//   at 16x16   one cell covers 160 x 90 px = 14400 px.
//              The change fills 990 of them, 6.9% of one cell. Even a full
//              black->white flip (200 levels) moves that cell by 200 * 0.069
//              = ~14 levels, and the frame's MEAN moves by 14/256 = 0.05.
//              ui-signature's threshold is 6. That is ~100x too small to see:
//              the change is not merely faint, it is arithmetically absent.
//
//   at 320x180 one cell covers 8 x 8 px = 64 px. The change covers ~14 cells
//              almost completely, so each of those cells moves by most of the
//              200 levels. Comfortably resolvable.
//
// 320x180 is 57,600 bytes and one pass of subtraction — microseconds. There was
// never a cost reason to be coarse; 16x16 was a deliberate blinding for a
// different job.
//
// ---------------------------------------------------------------------------
// WHY A MEAN IS THE WRONG MEASURE, AT ANY RESOLUTION
// ---------------------------------------------------------------------------
// Resolution alone does not fix it. Those same 14 changed cells out of 57,600
// move the frame's mean by 14 * 200 / 57600 = 0.05 levels — identical to the
// 16x16 number, because a mean is a mean. A global average can never separate
// "two words changed" from "nothing changed"; the information is in WHERE.
//
// So the measure is LOCAL and it counts rather than averages:
//
//   1. a CELL is changed when its brightness moved by >= CELL_DELTA. A
//      threshold, not a magnitude, so diffuse low-amplitude video-compression
//      noise contributes exactly zero instead of a small bias.
//   2. a TILE (TILE_CELLS x TILE_CELLS cells, so 160 x 160 px of a 2560-wide
//      capture) is changed when at least MIN_CELLS_PER_TILE of its cells are.
//   3. the frame is changed when any tile is.
//
// Two changed words are ~14 adjacent cells and land in one or two tiles, so they
// clear step 2 even when they straddle a boundary (~7 cells a side).
//
// ---------------------------------------------------------------------------
// THE NOISE FLOOR, AND HOW EACH PIECE IS ANSWERED
// ---------------------------------------------------------------------------
//   video compression / anti-aliasing — diffuse, low amplitude. Killed by
//     CELL_DELTA: an 8x8 cell that wobbles by a few levels is not counted at
//     all. This is also why the cell value is an AVERAGE of 64 px rather than a
//     sample: averaging is what makes per-pixel noise small before thresholding.
//
//   a blinking cursor — a terminal block cursor is ~8 x 16 px, i.e. 1-2 cells.
//     A clock digit ticking over is 2-3. MIN_CELLS_PER_TILE = 6 sits 3x above
//     that and 2x below the two-words case it must catch. That gap is the whole
//     tuning budget and it is stated here so it can be argued with.
//
//   a live webcam tile — the hard one, because the Meet view contains people as
//     well as the share, and a face changes on EVERY frame. Handled by a churn
//     map: a cell that changed in CHURN_LIVE_FRAMES of the last CHURN_WINDOW
//     samples is live video, not a document, and is excluded from the counting.
//     A shared terminal is static between edits, so it never accrues churn; a
//     face never stops, so it never contributes. (A cursor blinking at ~1 Hz
//     sampled every 2 s could alias into "churny" — it is already below
//     MIN_CELLS_PER_TILE, so both guards would have to fail together.)
//
//   a scroll, a slide change, a window swap — these change nearly everything and
//     are meant to fire. They fire once, on the frame after they stop, because:
//
// ---------------------------------------------------------------------------
// WHY "SETTLE" AND NOT "CHANGE"
// ---------------------------------------------------------------------------
// The event worth waking a bot for is not "pixels moved", it is "the screen
// moved and has now STOPPED moving" — the moment the student has finished
// typing and is waiting to be looked at. Waking mid-scroll costs a turn to look
// at a blurred half-state and would fire once per sample through a long scroll.
//
// So the detector emits when a frame is quiet relative to the previous frame AND
// different from the last baseline it reported. One event per settled change,
// however many samples the change took.
//
// ---------------------------------------------------------------------------
// The whole file is pure except createScreenSettleWatcher, which is the timer
// wrapper and is written to swallow everything (see its own note). Nothing here
// may throw into a live call.

// A 16:9 grid over the capture. See the arithmetic above for why not 16x16.
const GRID_W = 320;
const GRID_H = 180;

// Cells on a side of one tile. 20 cells = 160 px of a 2560-wide capture, which
// is roughly the width of the smallest change we intend to catch, so that change
// concentrates in one tile instead of being diluted across the frame.
const TILE_CELLS = 20;

// Brightness move (0-255) before a cell counts as changed at all.
const CELL_DELTA = 24;

// Changed cells within one tile before the tile counts as changed.
const MIN_CELLS_PER_TILE = 6;

// Rolling window used to recognise live video, and how much of it a cell has to
// be busy for before it is treated as video rather than as a document.
const CHURN_WINDOW = 6;
const CHURN_LIVE_FRAMES = 4;

// How often the watcher samples. Cheap enough to go faster; 2 s keeps the notice
// latency well inside the 10 s budget screen-reading-test.mjs asserts (change ->
// next sample -> one quiet sample = ~4 s worst case) without capturing for no
// reason.
const DEFAULT_INTERVAL_MS = 2000;

/**
 * Grayscale grid from a raw BGRA bitmap (Electron's nativeImage.toBitmap()).
 * Expects the image ALREADY resized to width x height — the resize is the
 * averaging step, and it is what makes per-pixel noise small enough for
 * CELL_DELTA to be a meaningful threshold.
 *
 * Returns a Uint8Array of width*height luma values, or null if the bitmap is not
 * the size claimed (a caller must never treat a wrong-sized frame as "changed"
 * or "unchanged"; it is not comparable at all).
 */

// Are two samples pictures of the SAME region, near enough to compare?
//
// Not exact equality, which is what shipped first and broke the detector
// outright: Meet re-lays out constantly and the measured rect moves by a pixel
// or two between samples (a tile animating, the captions region appearing, a
// subpixel reflow). With an exact test every sample read as "not comparable",
// the baseline was adopted every time, and NOTHING EVER SETTLED — silently,
// with no error. Reproduced offline: a 1px jitter took 2 settles to 0.
//
// The tolerance is sized to the grid rather than picked. Every sample is
// downscaled to GRID_W across, so on a 1900px-wide share one cell covers ~6px
// and a shift smaller than that is invisible in the compared data. Below the
// floor it cannot matter; above 2% the region has genuinely moved.
function sameRegion(a, b, gridW = GRID_W) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const tol = (dim) => Math.max(dim / gridW, dim * 0.02);
  return Math.abs(a.x - b.x) <= tol(a.w) && Math.abs(a.w - b.w) <= tol(a.w)
      && Math.abs(a.y - b.y) <= tol(a.h) && Math.abs(a.h - b.h) <= tol(a.h);
}

function grayGridFromBitmap(bmp, width = GRID_W, height = GRID_H) {
  if (!bmp || typeof bmp.length !== 'number') return null;
  if (bmp.length < width * height * 4) return null;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    // Rec. 601 luma, rounded not truncated — same convention as ui-signature.js,
    // and for the same reason: truncating puts a constant floor under every
    // comparison for nothing.
    out[p] = Math.round(0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i]);
  }
  return out;
}

/**
 * Per-cell changed mask between two grids. 1 where the cell moved by at least
 * cellDelta, 0 elsewhere. Null for grids that are not comparable.
 */
function changedCellMask(a, b, cellDelta = CELL_DELTA) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  const mask = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) >= cellDelta) mask[i] = 1;
  }
  return mask;
}

/**
 * Tiles whose changed-cell count clears minCells, ignoring any cell marked live
 * in `churn` (a Uint8Array of the same length, 1 = live video).
 *
 * Returns [{ tx, ty, cells }], busiest first. An empty array means "nothing
 * happened that is worth anyone's attention", which is the common case and the
 * reason this is cheap.
 */
function changedTiles(mask, opts = {}) {
  const {
    gridW = GRID_W, gridH = GRID_H, tileCells = TILE_CELLS,
    minCells = MIN_CELLS_PER_TILE, churn = null,
  } = opts;
  if (!mask) return [];
  const tilesX = Math.ceil(gridW / tileCells);
  const tilesY = Math.ceil(gridH / tileCells);
  const counts = new Int32Array(tilesX * tilesY);
  for (let y = 0; y < gridH; y++) {
    const ty = (y / tileCells) | 0;
    for (let x = 0; x < gridW; x++) {
      const i = y * gridW + x;
      if (!mask[i]) continue;
      if (churn && churn[i]) continue; // live video, not a document
      counts[ty * tilesX + ((x / tileCells) | 0)]++;
    }
  }
  const out = [];
  for (let t = 0; t < counts.length; t++) {
    if (counts[t] >= minCells) out.push({ tx: t % tilesX, ty: (t / tilesX) | 0, cells: counts[t] });
  }
  out.sort((p, q) => q.cells - p.cells);
  return out;
}

/**
 * The state machine. Feed it one grid per sample; it returns a verdict for that
 * sample and, when the screen has changed and then stopped changing, settled.
 *
 * push(grid) -> {
 *   settled: boolean,   // the event — emit exactly this to the call
 *   moving: boolean,    // differs from the PREVIOUS frame
 *   tiles: [...],       // changed tiles vs the baseline, when settled
 *   cells: number,      // changed cells vs the baseline, when settled
 *   reason: string,     // for the log line
 * }
 */
function createSettleDetector(opts = {}) {
  const cfg = {
    gridW: GRID_W, gridH: GRID_H, tileCells: TILE_CELLS,
    cellDelta: CELL_DELTA, minCells: MIN_CELLS_PER_TILE,
    churnWindow: CHURN_WINDOW, churnLiveFrames: CHURN_LIVE_FRAMES,
    ...opts,
  };
  let prev = null;      // the previous sample
  let prevSource = null; // the region it was a picture OF (see sameRegion)
  let baseline = null;  // the last state we reported (or the first we ever saw)
  let dirty = false;    // something moved since the baseline
  const history = [];   // recent per-cell masks, for the churn map

  function churnMap(len) {
    if (history.length < cfg.churnWindow) return null; // not enough evidence yet
    const live = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      let n = 0;
      for (const m of history) if (m[i]) n++;
      if (n >= cfg.churnLiveFrames) live[i] = 1;
    }
    return live;
  }

  function reset() { prev = null; baseline = null; dirty = false; history.length = 0; prevSource = null; }

  // `source` identifies WHAT was sampled — the crop rect the frame came from.
  // Two frames are only comparable if they are pictures of the same thing.
  //
  // The length check below cannot catch this on its own, because the caller
  // always resizes to the same grid whatever region it cropped: a Meet relayout
  // (someone joins, a tile is pinned, the share moves) produces a grid of
  // IDENTICAL length showing a different region, which reads as a large diff and
  // then a quiet frame — indistinguishable from a settle. The guard was dead in
  // the shipping wiring and this is what revives it.
  function push(grid, source = null) {
    const none = { settled: false, moving: false, tiles: [], cells: 0, reason: '' };
    if (!grid || !grid.length) return { ...none, reason: 'no-frame' };
    if (!prev || prev.length !== grid.length || !sameRegion(prevSource, source)) {
      // First frame, or not comparable with the last one — the capture size
      // changed, or we are now looking at a DIFFERENT REGION of the screen.
      // Adopt it as the new baseline rather than calling it a change, which
      // would fire on every relayout.
      const had = !!prev;
      prev = grid; baseline = grid; dirty = false; history.length = 0;
      prevSource = source || null;
      return { ...none, reason: had ? 'resized' : 'first-frame' };
    }

    const frameMask = changedCellMask(prev, grid, cfg.cellDelta);
    const churn = churnMap(grid.length);
    history.push(frameMask);
    if (history.length > cfg.churnWindow) history.shift();

    const movingTiles = changedTiles(frameMask, { ...cfg, churn });
    const moving = movingTiles.length > 0;
    prev = grid;
    if (moving) { dirty = true; return { ...none, moving: true, reason: 'moving' }; }
    if (!dirty) return { ...none, reason: 'quiet' };

    // Quiet frame with movement behind it: compare against the BASELINE, not the
    // previous frame, so a change that crept in over several samples still
    // counts and a change that reverted to where it started does not.
    const sinceBaseline = changedCellMask(baseline, grid, cfg.cellDelta);
    const tiles = changedTiles(sinceBaseline, { ...cfg, churn });
    baseline = grid;
    dirty = false;
    if (!tiles.length) return { ...none, reason: 'reverted' };
    const cells = tiles.reduce((n, t) => n + t.cells, 0);
    return { settled: true, moving: false, tiles, cells, reason: 'settled' };
  }

  return { push, reset };
}

/**
 * The timer wrapper. Kept here rather than in main.js so the failure behaviour
 * is testable without launching Electron — "the monitor breaking must not break
 * the call" is a claim, and a claim needs a test.
 *
 * capture()   -> a Promise of a grid (Uint8Array), or null/throw when it cannot.
 * onSettled() -> called with the detector's event. May throw; we eat it.
 *
 * NOTHING here is allowed to escape. A screen watcher that throws into the call
 * path would trade a stale screenshot for a dead bot, which is a much worse bug
 * than the one being fixed. After maxFailures consecutive capture failures it
 * stops itself and says so once, because a monitor that cannot capture is not
 * going to start being able to, and a log line every 2 s helps nobody.
 */
function createScreenSettleWatcher({
  capture,
  onSettled,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxFailures = 10,
  log = () => {},
  detector = createSettleDetector(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let timer = null;
  let busy = false;              // a capture is in flight; never overlap them
  const stats = { samples: 0, settles: 0, failures: 0, consecutiveFailures: 0, rebaselines: 0, skipped: 0, stoppedReason: null };
  let lastReason = null;   // log the verdict on CHANGE, so it says why without spamming
  let lastSkip = null;     // same, for the 'nothing safe to sample' case

  async function step() {
    if (busy) return;            // the previous capture is still going: skip, don't queue
    busy = true;
    try {
      // capture() may return the grid alone, or { grid, source } where source is
      // the region it is a picture of. The second form lets the detector notice
      // it is now looking somewhere else — see push().
      const got = await capture();

      // A DELIBERATE SKIP IS NOT A FAILURE. capture() returns { skip: reason }
      // when there is nothing safe to sample — today that means the shared tile
      // could not be located, and watching the whole Meet view instead would
      // feed the detector live faces it can never settle on. Counting that as a
      // capture failure would spam the log every 2s and trip the
      // consecutive-failure backoff over a condition that is working as designed.
      if (got && got.skip) {
        if (lastSkip !== got.skip) {
          lastSkip = got.skip;
          log('skipping samples — ' + got.skip);
        }
        stats.skipped++;
        return;
      }
      lastSkip = null;

      const grid = got && got.grid ? got.grid : got;
      const source = got && got.grid ? got.source : null;
      if (!grid) throw new Error('capture returned nothing');
      stats.consecutiveFailures = 0;
      stats.samples++;
      const verdict = detector.push(grid, source);

      // SAY WHY — once per run of the same reason, not every 2s.
      //
      // Every non-settle path returned silently, which is how the re-baseline
      // bug survived to a live call: the detector ran for four minutes, never
      // fired, and left a log with NOTHING in it. A watcher that is broken and
      // a room that is simply quiet produced identical output, so the only way
      // to tell them apart was to read the source. Same lesson as _rankedSkip
      // in local-server.js, which exists for exactly this reason.
      const reason = verdict && verdict.reason;
      if (reason && reason !== lastReason) {
        lastReason = reason;
        log('verdict → ' + reason + (reason === 'resized'
          ? ' (region changed, baseline restarted — repeating means the crop rect is unstable)'
          : ''));
      }
      if (reason === 'resized') stats.rebaselines++;

      if (verdict && verdict.settled) {
        stats.settles++;
        try { onSettled(verdict); } catch (err) { log('onSettled threw: ' + (err && err.message)); }
      }
    } catch (err) {
      stats.failures++;
      stats.consecutiveFailures++;
      if (stats.consecutiveFailures === 1) log('capture failed: ' + (err && err.message));
      if (stats.consecutiveFailures >= maxFailures) {
        stats.stoppedReason = 'capture kept failing (' + stats.consecutiveFailures + 'x)';
        log('giving up — ' + stats.stoppedReason);
        stop();
      }
    } finally {
      busy = false;
    }
  }

  function start() {
    if (timer) return;
    stats.stoppedReason = null;
    try { detector.reset(); } catch { /* a detector that cannot reset is not worth a crash */ }
    timer = setIntervalFn(() => { step().catch(() => {}); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    try { clearIntervalFn(timer); } catch { /* ignore */ }
    timer = null;
  }

  return { start, stop, step, stats, get running() { return !!timer; } };
}

module.exports = {
  sameRegion,
  GRID_W, GRID_H, TILE_CELLS, CELL_DELTA, MIN_CELLS_PER_TILE,
  CHURN_WINDOW, CHURN_LIVE_FRAMES, DEFAULT_INTERVAL_MS,
  grayGridFromBitmap, changedCellMask, changedTiles,
  createSettleDetector, createScreenSettleWatcher,
};
