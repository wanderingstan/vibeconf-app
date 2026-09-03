// stream-probe.test.mjs — #673. The pure half of the raw-stream probe.
//
// The load-bearing claim is the verdict: `anyUpscale` is true exactly when some
// stream carries meaningfully MORE resolution than it is rendered at, because
// that is the whole question the probe exists to answer (is there resolution to
// recover by capturing the track instead of screenshotting the tile?).
//
// The DOM half (PROBE_SCRIPT) is a string executed in the Meet page and is not
// unit-testable here; it is read-only by construction.
//
// Run: node --test tests/   (or `pnpm test:unit`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../electron-app/stream-probe.js');

const vid = (o = {}) => ({
  vw: 1920, vh: 1080, cw: 860, ch: 484,
  streamId: 'streamabc123', trackIds: ['t1'],
  participantId: 'pid12345678', statusText: 'Presentation',
  isPresentationHint: true, ...o,
});

test('ratioOf is stream width over rendered width, and 0 when either is missing', () => {
  assert.equal(P.ratioOf({ vw: 1920, cw: 960 }), 2);
  assert.equal(P.ratioOf({ vw: 0, cw: 960 }), 0);
  assert.equal(P.ratioOf({ vw: 1920, cw: 0 }), 0);
  assert.equal(P.ratioOf(null), 0);
});

test('a stream bigger than its rendering is the positive verdict', () => {
  const s = P.summarizeProbe({ vw: 1600, vh: 900, videos: [vid()] });
  assert.equal(s.anyUpscale, true);
  assert.match(s.line, /SHARE\[pid12345\]/);
  assert.match(s.line, /stream=1920x1080/);
  assert.match(s.line, /rendered=860x484/);
  assert.match(s.line, /ratio=2\.23x/);
});

test('a stream matching its rendering is the negative verdict — nothing to recover', () => {
  // The pessimistic case: the SFU adapted the layer down to the tile size.
  const s = P.summarizeProbe({ vw: 1600, vh: 900, videos: [vid({ vw: 860, vh: 484 })] });
  assert.equal(s.anyUpscale, false);
});

test('a few percent over is NOT interesting — DPR and layout rounding do that', () => {
  // Guards the reason RATIO_INTERESTING is 1.2 and not 1.0: without the band,
  // ordinary rounding would report a win that does not exist.
  const s = P.summarizeProbe({ vw: 1600, vh: 900, videos: [vid({ vw: 900, cw: 860 })] });
  assert.equal(s.anyUpscale, false);
});

test('one upscaled stream among several is enough', () => {
  const s = P.summarizeProbe({
    vw: 1600, vh: 900,
    videos: [
      vid({ vw: 320, vh: 180, cw: 320, ch: 180, isPresentationHint: false, statusText: '' }),
      vid(),
    ],
  });
  assert.equal(s.anyUpscale, true);
});

test('camera tiles and shares are labelled differently', () => {
  const s = P.summarizeProbe({
    vw: 1600, vh: 900,
    videos: [vid({ isPresentationHint: false, statusText: '' })],
  });
  assert.match(s.line, /^cam\[/);
});

test('an empty or malformed measurement is reported, never thrown', () => {
  for (const bad of [null, undefined, {}, { videos: [] }, { videos: 'nope' }]) {
    const s = P.summarizeProbe(bad);
    assert.equal(s.anyUpscale, false);
    assert.equal(s.line, 'no video elements in the grid');
  }
});

test('a video with no participant id still reports, marked no-id', () => {
  // Meet has pseudo-tiles (record-region.js / meet-selectors.js both hit this),
  // and a probe that dropped them would hide exactly the stream we cannot
  // otherwise account for.
  const s = P.summarizeProbe({ vw: 1600, vh: 900, videos: [vid({ participantId: null })] });
  assert.match(s.line, /\[no-id\]/);
  assert.equal(s.anyUpscale, true);
});

test('summaryChanged only fires on a real transition', () => {
  assert.equal(P.summaryChanged('a', 'a'), false);
  assert.equal(P.summaryChanged('a', 'b'), true);
  assert.equal(P.summaryChanged(null, 'a'), true);
});
