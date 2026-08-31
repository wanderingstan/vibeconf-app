// ui-signature.js — #615. A tiny perceptual signature of a UI capture, and the
// comparison that decides whether the app "looks different" from last time.
//
// Its own module for one reason: it is the only genuinely load-bearing logic in
// the visual-changelog feature, and inside main.js it could only ever be tested
// by launching Electron. Here it is a pure function over a bitmap.
//
// WHY NOT A CHECKSUM. Two captures of an unchanged panel are never byte-equal —
// the clock moves, the elapsed timer ticks, a status dot animates, text
// anti-aliases differently between runs. A hash therefore reports "changed"
// every night, the changelog fills with near-identical frames, and the one
// property that made it worth keeping (every file marks a real change) is gone.
//
// Downscaling to 16x16 grayscale destroys that noise while preserving what we
// actually care about: layout, weight, colour relationships. A moved button, a
// new type scale or a restyled header all survive it comfortably.

const SIGNATURE_SIDE = 16;

/**
 * Hex signature from a raw BGRA bitmap (Electron's nativeImage.toBitmap()).
 * Expects the image already resized to SIGNATURE_SIDE^2 pixels.
 */
function signatureFromBitmap(bmp) {
  let out = '';
  for (let i = 0; i + 3 < bmp.length; i += 4) {
    // Rec. 601 luma. Alpha ignored — these captures are opaque, and a window
    // that captured transparent would read as black under any weighting.
    //
    // ROUND, do not truncate. The coefficients sum to exactly 1, so a flat grey
    // should map to itself — but in floating point 0.299*64 + 0.587*64 +
    // 0.114*64 lands a hair under 64, and `| 0` turned every such pixel into
    // 63. Harmless on its own, and it would have put a constant floor under
    // every comparison for no reason. Caught by the first test written.
    const lum = Math.round(0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i]);
    out += lum.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Mean absolute per-pixel brightness difference between two signatures, 0-255.
 *
 * Returns Infinity for signatures of different lengths: that means the window
 * was captured at a different SIZE, so the two frames are not comparable at all
 * and the honest answer is "changed", not a number.
 */
function signatureDistance(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return Infinity;
  if (!a.length || a.length !== b.length || a.length % 2) return Infinity;
  let total = 0;
  const n = a.length / 2;
  for (let i = 0; i < a.length; i += 2) {
    total += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
  }
  return total / n;
}

// Above this mean difference, two frames count as different and the new one is
// kept. NOT zero — see the note at the top. NOT measured either: it is a
// starting point, to be tuned once there are a few weeks of frames to tune
// against. Frames are cheap and a threshold is easy to change later; a baseline
// not captured today is gone forever. That is the right order to get these in.
const DEFAULT_THRESHOLD = 6;

module.exports = { SIGNATURE_SIDE, signatureFromBitmap, signatureDistance, DEFAULT_THRESHOLD };
