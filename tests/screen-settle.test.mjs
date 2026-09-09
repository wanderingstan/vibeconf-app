// screen-settle.test.mjs — #673. Can the bot notice a shared screen changing
// while nobody speaks, without firing on a blinking cursor?
//
// The module under test is arithmetic over an array, so this is a real unit
// test rather than a source assertion. The wiring at either end (Electron's
// capturePage, the MCP phrasing) is pinned by source assertions at the bottom,
// the way ui-history-capture.test.mjs does it.
//
// THE TEST THAT CARRIES THE ARGUMENT is 'two words of terminal text'. It builds
// one synthetic 2560x1440 capture, changes a text-line-sized patch of it, and
// downscales that same change two ways: to ui-signature's 16x16 (where it is
// arithmetically absent, ~100x under the threshold) and to this module's
// 320x180 grid with tile differencing (where it is unmissable). That pair is
// the reason this module exists instead of reusing #615.
//
// Run: node --test tests/screen-settle.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const {
  GRID_W, GRID_H, TILE_CELLS, CELL_DELTA, MIN_CELLS_PER_TILE, CHURN_WINDOW,
  grayGridFromBitmap, changedCellMask, changedTiles,
  createSettleDetector, createScreenSettleWatcher,
} = require('../electron-app/screen-settle.js');
const { signatureFromBitmap, signatureDistance, DEFAULT_THRESHOLD, SIGNATURE_SIDE } =
  require('../electron-app/ui-signature.js');

// ---------------------------------------------------------------------------
// Helpers: a synthetic "screen" and a box-average downscale, which is what
// Electron's nativeImage.resize does and is the step that turns per-pixel noise
// into something a per-cell threshold can be honest about.
// ---------------------------------------------------------------------------

// The shipping default meetViewSize. The feature sizes below are in the pixels
// of THIS capture, so the cell arithmetic in screen-settle.js's header is the
// arithmetic actually under test.
const SRC_W = 2560, SRC_H = 1440;

function blankScreen(level = 30) {
  return new Uint8Array(SRC_W * SRC_H).fill(level); // a dark terminal
}

// Paint a rectangle in SOURCE pixels.
function paint(src, x, y, w, h, level) {
  for (let yy = y; yy < y + h && yy < SRC_H; yy++) {
    for (let xx = x; xx < x + w && xx < SRC_W; xx++) src[yy * SRC_W + xx] = level;
  }
}

// Box-average down to width x height and hand back a BGRA bitmap, i.e. exactly
// what grayGridFromBitmap is fed in the app.
function downscaleToBitmap(src, width, height) {
  const bmp = Buffer.alloc(width * height * 4);
  const bw = SRC_W / width, bh = SRC_H / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, n = 0;
      for (let sy = Math.floor(y * bh); sy < Math.floor((y + 1) * bh); sy++) {
        for (let sx = Math.floor(x * bw); sx < Math.floor((x + 1) * bw); sx++) { sum += src[sy * SRC_W + sx]; n++; }
      }
      const v = Math.round(sum / n);
      const i = (y * width + x) * 4;
      bmp[i] = v; bmp[i + 1] = v; bmp[i + 2] = v; bmp[i + 3] = 255; // BGRA, grey
    }
  }
  return bmp;
}

const gridOf = (src) => grayGridFromBitmap(downscaleToBitmap(src, GRID_W, GRID_H), GRID_W, GRID_H);

// A line of terminal text, in the pixels of the capture above. Two words of 12px
// text measure about 90 x 11. Deliberately at the SMALL end of what this is
// asked to catch.
const TWO_WORDS = { x: 600, y: 480, w: 90, h: 11 };

// ---------------------------------------------------------------------------

test('the grid is one byte per cell, and a wrong-sized bitmap is refused', () => {
  const g = gridOf(blankScreen(0x40));
  assert.equal(g.length, GRID_W * GRID_H);
  assert.equal(g[0], 0x40);
  assert.equal(grayGridFromBitmap(Buffer.alloc(16), GRID_W, GRID_H), null,
    'a short bitmap is not comparable — null, not a silently wrong answer');
});

test('two words of terminal text ARE detected — and would NOT be at 16x16', () => {
  // THE POINT OF THE MODULE. One change, two resolutions.
  const before = blankScreen();
  const after = blankScreen();
  paint(after, TWO_WORDS.x, TWO_WORDS.y, TWO_WORDS.w, TWO_WORDS.h, 220); // words appear

  // 16x16, the visual-changelog signature (#615), compared its own way.
  const d16 = signatureDistance(
    signatureFromBitmap(downscaleToBitmap(before, SIGNATURE_SIDE, SIGNATURE_SIDE)),
    signatureFromBitmap(downscaleToBitmap(after, SIGNATURE_SIDE, SIGNATURE_SIDE)));
  assert.ok(d16 < DEFAULT_THRESHOLD / 10,
    `at 16x16 the change measures ${d16.toFixed(3)} against a threshold of ${DEFAULT_THRESHOLD} — `
    + 'not faint, absent. This is why ui-signature.js cannot be reused as-is.');

  // 320x180 with tile differencing.
  const tiles = changedTiles(changedCellMask(gridOf(before), gridOf(after)));
  assert.ok(tiles.length >= 1, 'the same change must be detected at the settle grid');
  assert.ok(tiles[0].cells >= MIN_CELLS_PER_TILE,
    `busiest tile had ${tiles[0].cells} changed cells, needs ${MIN_CELLS_PER_TILE}`);
});

test('a blinking cursor, a ticking clock and compression noise do NOT fire', () => {
  const base = blankScreen();
  const noisy = blankScreen();
  // Video-compression noise, at the scale that actually survives the downscale.
  // Per-PIXEL dither would be averaged away by the resize and would prove
  // nothing; a codec's artefacts move whole 8x8 blocks, which is a whole CELL,
  // so that is what is simulated here. Amplitude 16, below CELL_DELTA (24) —
  // this is precisely the band CELL_DELTA exists to discard.
  for (let by = 0; by < SRC_H; by += 8) {
    for (let bx = 0; bx < SRC_W; bx += 8) {
      paint(noisy, bx, by, 8, 8, 30 + (((bx * 7 + by * 13) % 33) - 16));
    }
  }
  // Cursor: a terminal block, ~8x16 px. Clock: a digit ticking over in a corner,
  // far enough away that the two cannot pool into one tile.
  paint(noisy, 1400, 800, 8, 16, 200);
  paint(noisy, 2200, 40, 10, 14, 200);

  const mask = changedCellMask(gridOf(base), gridOf(noisy));
  assert.ok(mask.some((v) => v), 'it is not blind — something did change');
  assert.deepEqual(changedTiles(mask), [],
    'but nothing reaches the per-tile floor, so a cursor blinking all call wakes nobody');
});

test('the noise floor is the guard, not luck: drop MIN_CELLS_PER_TILE and the cursor fires', () => {
  // Verifying the fix by removing it. With the floor at 1 the same frame trips.
  const base = blankScreen();
  const cursor = blankScreen();
  paint(cursor, 1400, 800, 8, 16, 200);
  const mask = changedCellMask(gridOf(base), gridOf(cursor));
  assert.deepEqual(changedTiles(mask), [], 'with the shipping floor: silent');
  assert.ok(changedTiles(mask, { minCells: 1 }).length > 0, 'with the floor removed: fires');
});

test('a settle fires once, after the screen stops moving — not on every frame of a scroll', () => {
  const det = createSettleDetector();
  const idle = gridOf(blankScreen());
  det.push(idle);
  for (let i = 0; i < 3; i++) assert.equal(det.push(idle).settled, false, 'a static screen never fires');

  // A scroll: three successive frames all different.
  const frames = [0, 1, 2].map((n) => {
    const s = blankScreen();
    paint(s, 400, 200 + n * 80, 1000, 120, 180);
    return gridOf(s);
  });
  const during = frames.map((f) => det.push(f));
  assert.deepEqual(during.map((r) => r.settled), [false, false, false],
    'nothing fires mid-scroll — waking there costs a turn to look at a blur');
  assert.ok(during.every((r) => r.moving), 'but each frame is seen to be moving');

  const settled = det.push(frames[2]); // it stops
  assert.equal(settled.settled, true, 'the frame after it stops is the event');
  assert.ok(settled.cells > 0 && settled.tiles.length > 0, 'and it says what changed');
  assert.equal(det.push(frames[2]).settled, false, 'exactly once, not once per quiet frame');
});

test('a live webcam tile does not drown out a screen change beside it', () => {
  // The hard noise case: the Meet view has PEOPLE in it, and a face changes on
  // every single frame. Without the churn map the detector never sees a quiet
  // frame and therefore never settles — the bot would be blind for the whole
  // call in exactly the situation it is meant for.
  const det = createSettleDetector();
  let tick = 0;
  const withWebcam = (extra) => {
    const s = blankScreen();
    // A camera tile bottom-right, different every frame.
    for (let y = 1120; y < 1400; y++) {
      for (let x = 2000; x < 2480; x++) s[y * SRC_W + x] = (x * 7 + y * 13 + tick * 91) % 255;
    }
    if (extra) extra(s);
    tick++;
    return gridOf(s);
  };

  // Long enough for the churn window to learn which cells are video.
  for (let i = 0; i < CHURN_WINDOW + 3; i++) det.push(withWebcam(null));
  const quiet = det.push(withWebcam(null));
  assert.equal(quiet.moving, false,
    'once the camera cells are known to be live video, the frame reads as quiet');

  // Now the student edits two words on the shared terminal.
  det.push(withWebcam((s) => paint(s, TWO_WORDS.x, TWO_WORDS.y, TWO_WORDS.w, TWO_WORDS.h, 220)));
  const r = det.push(withWebcam((s) => paint(s, TWO_WORDS.x, TWO_WORDS.y, TWO_WORDS.w, TWO_WORDS.h, 220)));
  assert.equal(r.settled, true, 'the screen change still reaches the bot with a camera live');
  assert.ok(r.tiles.every((t) => !(t.tx * TILE_CELLS >= 250 && t.ty * TILE_CELLS >= 140)),
    'and the reported region is the terminal, not the face');
});

test('a resize is adopted, not reported as a change', () => {
  const det = createSettleDetector();
  det.push(gridOf(blankScreen()));
  const shorter = new Uint8Array(GRID_W * (GRID_H - 1)).fill(30);
  const r = det.push(shorter);
  assert.equal(r.settled, false);
  assert.equal(r.reason, 'resized', 'a different capture size is not comparable, so it is a new baseline');
});

// ---------------------------------------------------------------------------
// The watcher: its whole job is to never reach the call.
// ---------------------------------------------------------------------------

test('a capture that throws does not propagate into the call path', async () => {
  const seen = [];
  const w = createScreenSettleWatcher({
    capture: async () => { throw new Error('Current display surface not available'); },
    onSettled: () => seen.push('settled'),
    log: () => {},
    setIntervalFn: () => null, clearIntervalFn: () => {},
  });
  await w.step(); // must not reject
  assert.equal(w.stats.failures, 1);
  assert.deepEqual(seen, []);
});

test('a capture that keeps failing disarms itself instead of logging forever', async () => {
  let cleared = false;
  const w = createScreenSettleWatcher({
    capture: async () => null,
    onSettled: () => {},
    maxFailures: 3,
    log: () => {},
    setIntervalFn: () => 'timer', clearIntervalFn: () => { cleared = true; },
  });
  w.start();
  for (let i = 0; i < 3; i++) await w.step();
  assert.equal(cleared, true, 'it stops itself');
  assert.match(w.stats.stoppedReason, /kept failing/);
});

test('an onSettled handler that throws is swallowed too', async () => {
  const grids = [gridOf(blankScreen()), gridOf(blankScreen()), null, null];
  const changed = blankScreen();
  paint(changed, TWO_WORDS.x, TWO_WORDS.y, TWO_WORDS.w, TWO_WORDS.h, 220);
  grids[2] = gridOf(changed); grids[3] = gridOf(changed);
  let i = 0;
  const w = createScreenSettleWatcher({
    capture: async () => grids[i++],
    onSettled: () => { throw new Error('local-server exploded'); },
    log: () => {},
    setIntervalFn: () => null, clearIntervalFn: () => {},
  });
  for (let n = 0; n < grids.length; n++) await w.step(); // must not reject
  assert.equal(w.stats.settles, 1, 'the event still happened');
  assert.equal(w.stats.failures, 0, 'a handler blowing up is not a capture failure');
});

test('captures never overlap — a slow one is skipped, not queued', async () => {
  let inFlight = 0, maxInFlight = 0;
  const w = createScreenSettleWatcher({
    capture: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return gridOf(blankScreen());
    },
    onSettled: () => {},
    log: () => {},
    setIntervalFn: () => null, clearIntervalFn: () => {},
  });
  await Promise.all([w.step(), w.step(), w.step()]);
  assert.equal(maxInFlight, 1, 'a capture slower than the interval must not pile up');
});

// ---------------------------------------------------------------------------
// The two ends, pinned by source. Neither can be exercised without a live call.
// ---------------------------------------------------------------------------

const main = readFileSync(join(root, 'electron-app/main.js'), 'utf8');
const server = readFileSync(join(root, 'electron-app/local-server.js'), 'utf8');
const mcp = readFileSync(join(root, 'mcp-server/server.js'), 'utf8');
const schema = readFileSync(join(root, 'electron-app/preferences-schema.js'), 'utf8');

test('the screen wake is a new REASON on the existing waiter machinery', () => {
  assert.match(server, /_resolveWaiter\(waiter, 'screen'\)/,
    'it must resolve waiters the way chat does, not invent a second path');
  assert.match(server, /reason === 'screen'[\s\S]{0,120}screenWake = true/,
    'and tag the response so the agent is told WHY it woke');
  assert.match(server, /noteScreenSettled[\s\S]{0,1800}anyoneSpeaking \? 'someone-speaking'/,
    'the floor beats the screen — same gate chat uses');
});

test('the MCP side consumes a finished value and never reaches across the packaging boundary', () => {
  assert.match(mcp, /data\.screenWake/, 'it reads the flag the app already computed');
  assert.doesNotMatch(mcp, /(?:from\s*|require\s*\(\s*)['"][^'"]*screen-settle/,
    'mcp-server/ is packaged without electron-app/ beside it — importing the detector '
    + 'would resolve in the repo and kill the MCP server in the built app (v0.8.50)');
});

test('the watch is a mode, ON by default, in a call, AND only while someone presents', () => {
  // Default flipped to ON by Stan on 7 Sept: "a student who needs this would
  // never find a setting to turn it on". That is only affordable because of the
  // third condition below — ON without the presenting gate would mean sampling
  // a view of faces every two seconds for every call, forever.
  assert.match(schema, /watchSharedScreen:[\s\S]{0,200}default: true/);

  // Three conditions. The third was added on 2026-09-09 and is what makes the
  // default safe: without an active share there is nothing to watch, so the
  // watcher used to lean on the churn filter to ignore faces — work whose only
  // possible output was a false wake. Stan: "when nobody is presenting, stop
  // the watcher entirely."
  assert.match(main, /prefValue\('watchSharedScreen'\) === true/);
  assert.match(main, /localServer\.callStatus === 'in-call'/);
  assert.match(main, /localServer\.someoneElsePresenting === true/,
    'no share means no watcher at all, not a watcher filtering faces');

  assert.match(main, /meetView\.webContents\.capturePage\(\)[\s\S]{0,2000}grayGridFromBitmap/,
    'the pixels come from the SAME capture get_call_screenshot uses, resized in-process');
});

test('the watcher starts and stops on the presenting EDGE, not just on pref or call changes', () => {
  // A share beginning mid-call must start the watcher then, rather than waiting
  // for something unrelated to change.
  assert.match(main, /someonePresenting[\s\S]{0,600}reconcileScreenSettleWatcher\(\)/,
    'the presenting IPC edge must reconcile the watcher');
});

test('the sample is cropped to the presented tile before it is downscaled', () => {
  // Faces are the hardest noise source this detector has, and cropping removes
  // them by construction rather than by the churn filter. It also spends the
  // 320x180 grid on the thing being watched instead of on a view in which the
  // share is one tile among several.
  assert.match(main, /pickPresentationRect/, 'the crop rect comes from presentation-rect.js');
  assert.match(main, /capturePage\(\)[\s\S]{0,1500}\.crop\(/,
    'and the crop happens on the captured image, before the resize');
});

// --- the throttle ----------------------------------------------------------

test('a screen wake is throttled, and the throttle is a knob', () => {
  // Debounce vs throttle, which are different mechanisms for different problems:
  // "settle" IS the debounce (continuous typing never goes quiet, so it never
  // fires). The throttle covers discrete edits with pauses, where every pause is
  // a real settle. Stan, 2026-09-09: "we need some max rate at which these
  // updates flow, one every 10 seconds?"
  assert.match(schema, /screenWakeMinGapMs:[\s\S]{0,200}default: 10000/);
  assert.match(server, /screenWakeMinGapMs/, 'the wake path must consult it');
  assert.match(server, /throttled \(/, 'and say so, so a missing wake is explainable from the log');
});

test('the throttle is measured from the last WAKE, not the last settle', () => {
  // The cost being limited is the agent's turn, not the detector's sample. A
  // throttle keyed on samples would let a burst of settles through whenever the
  // agent happened to be slow.
  assert.match(server, /_lastScreenWakeAt = Date\.now\(\)[\s\S]{0,1400}_resolveWaiter\(waiter, 'screen'\)/,
    'the stamp is taken where the wake actually fires');
});

test('the existing back-pressure is kept, not replaced by the throttle', () => {
  // Between a wake and the agent parking again, nothing can fire at all. The
  // throttle only covers the case that slips through: the agent decides there is
  // nothing to say, parks quickly, and the next keystroke pause wakes it again.
  assert.match(server, /no-active-waiter/);
  assert.match(server, /someone-speaking/, 'the floor still beats the screen');
});

// --- the picture that comes with the wake ----------------------------------

test('the wake carries the picture, so the agent does not have to ask for it', () => {
  // The agent is woken specifically to LOOK, so it will look — which makes the
  // fetch unconditional, and an unconditional fetch belongs in the response.
  // Making it ask costs two further round trips (emit the call, receive the
  // file), each re-processing the whole call's context. Same argument as #726,
  // applied where the need is known in advance rather than guessed.
  assert.match(mcp, /screenshotBlocks\(data\.screenShot\)/,
    'the wake response must splice in the image');
  assert.match(mcp, /screenshotBlocks\(pathOnDisk\)[\s\S]{0,400}type: "image"/,
    'and it must be a real image block, not a path in text');
  assert.match(server, /response\.screenShot = this\.lastScreenShotPath/,
    'the app must put the path on the wake payload');
});

test('the picture is taken ONLY when the wake actually fires', () => {
  // Most settles are blocked — someone is speaking, no agent is waiting, the
  // throttle is holding — and encoding a full PNG for each of those is work
  // whose result is discarded. So the capture arrives as a function and is
  // called after the gates, not before them.
  assert.match(server, /noteScreenSettled\(info = \{\}, capture = null\)/,
    'the capture is passed as a function, not a picture');
  assert.match(main, /onSettled: \(v\) => localServer\.noteScreenSettled\(v,/,
    'and the watcher hands one over');
  const gateAt = server.indexOf("const blocked = this.anyoneSpeaking");
  const captureAt = server.indexOf("this.lastScreenShotPath = await capture()");
  assert.ok(gateAt > 0 && captureAt > gateAt,
    'the capture must happen AFTER the blocked checks, or it is paid for on every settle');
});

test('the picture is cropped to the share, not the whole Meet view', () => {
  assert.match(main, /cropRect: lastPresentationRect/,
    'the wake capture reuses the rect the sample already measured');
  assert.match(main, /onCaptureScreenshot: async \(\{ roomId, cropRect \} = \{\}\)/,
    'and the capture handler accepts one');
});

test('a missing picture degrades the wake, it does not cancel it', () => {
  // A wake with no picture still beats no wake, and the agent can always call
  // get_call_screenshot itself.
  assert.match(mcp, /data\.screenShot\s*\?[\s\S]{0,400}Call get_call_screenshot to LOOK/,
    'the wording must tell the agent to fetch one when none is attached');
  assert.match(server, /catch \{ this\.lastScreenShotPath = null; \}/,
    'a capture that throws must not stop the wake');
});
