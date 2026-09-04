// stream-probe.js — #673. Read-only instrumentation answering two questions we
// can only settle against a REAL remote sharer on a real network:
//
//   1. RESOLUTION. Is Meet sending a share at a higher resolution than it
//      renders it at? A <video> element's videoWidth/videoHeight are the
//      DECODED STREAM's dimensions, independent of how large the element is
//      laid out. If the stream is 1920 wide while its tile is 860 wide, then
//      every screenshot of the Meet view has been reading a downscaled
//      RENDERING of a full-resolution stream, and capturing the track directly
//      would give us the pixels for free.
//
//      The pessimistic case is real and is why this measures rather than
//      assumes: WebRTC receivers signal a desired resolution, and an SFU
//      commonly forwards the simulcast layer matching the receiver's rendered
//      size. If Meet does that, stream ≈ render and there is nothing to win.
//
//   2. IDENTITY WITHOUT COORDINATES. Today a participant's identity is
//      recovered from where their tile sits in Meet's layout. A MediaStream
//      carries an id, and the tile carries `data-participant-id`, so if the two
//      can be joined we can key streams to people SEMANTICALLY. Note what that
//      does and does not buy: it removes the dependence on COORDINATES, not on
//      the DOM. The DOM is still the thing that knows who is who; it is just
//      being asked a stable question instead of a geometric one.
//
// Read-only and side-effect free by construction: it queries the DOM and reads
// properties. It never touches the page, the call, or any capture path — the
// worst a bug here can do is log something wrong.

// Runs inside the Meet page. Returns plain data only (structured-cloneable),
// never DOM nodes or MediaStream objects.
//
// Deliberately mirrors record-region.js's MEASURE_SCRIPT rather than extending
// it: that one feeds the recording crop and runs every second while recording,
// and this is a throwaway diagnostic that should not be able to affect it.
const PROBE_SCRIPT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  // Same exclusion record-region.js uses: anything inside a side panel, region
  // or dialog is Meet's chrome (the People pane's listitems carry
  // data-participant-id too), not the video grid.
  const inChrome = (el) => !!el.closest('[role="complementary"], [role="region"], [role="dialog"], nav, header');
  const out = [];
  for (const el of document.querySelectorAll('video')) {
    if (inChrome(el)) continue;
    const b = el.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0)) continue;
    // The tile that owns this video, and therefore the identity Meet assigns
    // it. meet-selectors.js:121 — a screen share gets its OWN listitem with the
    // SAME display name as the person sharing, so the id is what separates
    // them, not the name.
    const tile = el.closest('[data-participant-id]');
    // Meet appends the literal word inside the status row for a share
    // (meet-selectors.js:129). A hint, not a proof: it is localised. Recorded
    // as-seen so the log can be read in a non-English UI.
    const statusRow = tile ? tile.querySelector('.d93U2d') : null;
    const statusText = statusRow ? (statusRow.textContent || '').trim().slice(0, 40) : '';
    const so = el.srcObject;
    out.push({
      // Decoded stream size — the whole point of the probe.
      vw: el.videoWidth || 0,
      vh: el.videoHeight || 0,
      // Rendered (CSS px) size of the same element.
      cw: Math.round(b.width),
      ch: Math.round(b.height),
      // MediaStream identity, for the join against participant id.
      streamId: so && so.id ? String(so.id) : null,
      trackIds: so && so.getVideoTracks ? so.getVideoTracks().map((t) => t.id) : [],
      participantId: tile ? tile.getAttribute('data-participant-id') : null,
      statusText,
      isPresentationHint: /presentation/i.test(statusText),
    });
  }
  return { vw, vh, videos: out };
})()`;

// A stream is only INTERESTING if it carries meaningfully more resolution than
// it is being rendered at. Below this it is the same picture and there is
// nothing to recover by capturing the track. 1.2 rather than 1.0 because
// device-pixel-ratio and Meet's own layout rounding routinely put a stream a
// few percent above its CSS box without that meaning anything.
const RATIO_INTERESTING = 1.2;

function ratioOf(v) {
  if (!v || !(v.cw > 0) || !(v.vw > 0)) return 0;
  return v.vw / v.cw;
}

/**
 * One compact line per video element, plus the verdict the whole exercise is
 * for. Pure, so it is unit-testable without a page.
 *
 * Returns { line, anyUpscale, videos } where `anyUpscale` is the answer to
 * question 1: does ANY stream carry more pixels than its rendering?
 */
function summarizeProbe(m) {
  if (!m || !Array.isArray(m.videos) || m.videos.length === 0) {
    return { line: 'no video elements in the grid', anyUpscale: false, videos: [] };
  }
  const videos = m.videos.map((v) => ({ ...v, ratio: ratioOf(v) }));
  const anyUpscale = videos.some((v) => v.ratio >= RATIO_INTERESTING);
  const parts = videos.map((v) => {
    const who = v.participantId ? v.participantId.slice(0, 8) : 'no-id';
    const kind = v.isPresentationHint ? 'SHARE' : 'cam';
    const ratio = v.ratio ? v.ratio.toFixed(2) + 'x' : '—';
    return `${kind}[${who}] stream=${v.vw}x${v.vh} rendered=${v.cw}x${v.ch} ratio=${ratio} sid=${v.streamId ? v.streamId.slice(0, 8) : 'none'}`;
  });
  return { line: parts.join(' | '), anyUpscale, videos };
}

// Whether two summaries are different enough to be worth logging again. The
// probe runs on a timer and most ticks are identical; logging every one would
// bury the transitions that matter (a share starting, a stream changing
// resolution mid-call because the network degraded) in noise.
function summaryChanged(prev, next) {
  return (prev || null) !== (next || null);
}

module.exports = { PROBE_SCRIPT, summarizeProbe, summaryChanged, ratioOf, RATIO_INTERESTING };
