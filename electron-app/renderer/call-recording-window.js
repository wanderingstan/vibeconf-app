// call-recording-window.js (renderer) — drives getDisplayMedia() + MediaRecorder
// for a frame-capture window (electron-app/call-recording-window.js, main
// process side). Reused for BOTH capture tracks:
//   - track=video, controls=1 — the visible Meet-view status window (elapsed
//     time + Stop button, which asks main to stop the WHOLE recording).
//   - track=share, controls=0 — the hidden whiteboard-share side capture, no
//     UI, normally driven by main telling it to stop; self-finalizes quietly
//     (no message to main asking it to stop the WHOLE recording) if its
//     source frame disappears some other way — see the 'ended' handler below.
//
// Chunk pipeline mirrors page-inject.js's existing per-track AUDIO recorder
// (callRecorder IIFE, ~line 2856): 1s timeslices, base64-encode, ship over IPC.
// Same shape, just video instead of audio and originating here instead of
// from inside the Meet page.

(() => {
  const params = new URLSearchParams(location.search);
  const TRACK = params.get('track') || 'video';
  const SHOW_CONTROLS = params.get('controls') === '1';
  const TIMESLICE_MS = 1000;

  const dot = document.getElementById('dot');
  const label = document.getElementById('label');
  const elapsedEl = document.getElementById('elapsed');
  const note = document.getElementById('note');
  const stopBtn = document.getElementById('stopBtn');

  if (!SHOW_CONTROLS) {
    // Background capture (the whiteboard-share track): no status UI needed —
    // this window is never shown — but the elements still exist in the DOM,
    // so just hide the whole row rather than maintaining a second HTML file.
    document.body.style.display = 'none';
  }

  // Capture size/rate. `{ video: true }` used to be the whole constraint, which
  // handed back the source frame at its full DEVICE-pixel size — on a Retina
  // display that meant 3024x1700 @ 60fps, and two problems fell out of it:
  //
  //   (1) ASPECT. 3024x1700 is not a standard ratio (756:425 ≈ 1.7788, next to
  //       16:9's 1.7778) — it is just whatever the window happened to be,
  //       rounded to even for yuv420p. Nothing downstream distorts it (the
  //       webm and the muxed mp4 agree exactly, SAR 1:1), but anything that
  //       ASSUMES 16:9 — Drive's preview, YouTube, most players' fullscreen —
  //       letterboxes it slightly. Pinning the capture to 16:9 fixes it at the
  //       source, which is the only place it can be fixed.
  //
  //   (2) COST. 5.1 megapixels per frame at 60fps is ~5x the pixel throughput
  //       of 1080p30 — paid by the live encoder for the whole call, and (on
  //       the VP9 fallback, see pickMime) again by the merge's re-encode
  //       afterwards. Measured on a real 3024x1700 VP9 recording, 30s of
  //       footage took 13.1s to merge — 2.3x realtime, so a 40-minute call
  //       spent ~17 minutes pinning a core.
  //
  // `ideal` rather than `exact` on purpose: a source frame smaller than 1080p
  // should be captured as-is, not upscaled, and an exact constraint would fail
  // the request outright rather than degrade. Chromium keeps the source's own
  // aspect while fitting inside the box, so a genuinely non-16:9 window still
  // records undistorted — just bounded.
  const CAPTURE_CONSTRAINTS = {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
  };

  let seq = 0;
  let startWallClock = 0;
  let startedAt = 0;
  let elapsedTimer = null;
  let mediaRecorder = null;
  let recordingMime = ''; // what pickMime() chose, once recording — see mergedSizeRatio()
  let stopRequested = false;
  // #328: pushed from main every couple of seconds. null until the first push
  // lands, which is why renderElapsed() shows time alone rather than "0 MB" —
  // a zero here would read as "nothing is being written", the exact worry the
  // size display exists to answer.
  let sizeBytes = null;

  function fmtElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // Decimal units (MB = 1e6), matching what Finder/Explorer report for the same
  // file — the point is to be comparable to what the user sees on disk, not to
  // be binary-exact.
  // Decimals scale with magnitude, so every tier reads at about three
  // significant figures. A recording ticking up past 1.06 GB earns its two
  // decimals; "130.92 GB free on disk" spends them on noise (#416). Ordinary
  // recordings sit well under 10 GB, so what you watch grow is unchanged.
  function fmtBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1e6) return `${Math.round(bytes / 1e3)} KB`;
    if (bytes < 1e9) return `${Math.round(bytes / 1e6)} MB`;
    const gb = bytes / 1e9;
    return `${gb.toFixed(gb < 10 ? 2 : gb < 100 ? 1 : 0)} GB`;
  }

  // What #328 put on screen is the RAW capture growing on disk, and out of
  // context it alarms: a 50-minute call reads "1.21 GB" while the file you
  // actually keep may be a fraction of that. Which fraction depends on the
  // codec pickMime() landed on:
  //   - H.264 (the normal case): the merge stream-copies the video, so the
  //     final mp4 is essentially the raw bytes (plus a little AAC). Ratio 1.
  //   - VP9 (fallback): the merge re-encodes to x264 crf 23, and the muxed mp4
  //     lands at roughly a sixth of the raw bytes — measured on the 2026-08-27
  //     call, 1.28 GB of tracks became a 193 MB mp4 (0.15).
  //
  // One measurement is not a model. A screen share full of motion compresses
  // far worse than the mostly-static Meet view that number came from, so this
  // is only ever shown with a tilde, and it sits in the note line rather than
  // beside the real number — the honest claim is "about this much" / "much
  // smaller than this", and the figure is there to give that claim a scale,
  // not to be held to.
  function mergedSizeRatio() {
    return /h264|avc1/i.test(recordingMime || '') ? 1 : 1 / 6;
  }

  function renderElapsed() {
    if (!SHOW_CONTROLS) return;
    const time = fmtElapsed(performance.now() - startedAt);
    const size = sizeBytes === null ? '' : fmtBytes(sizeBytes);
    // "raw" is what makes the note's "~200 MB final" legible as a pair. It
    // costs four characters at 300px wide; .label takes the ellipsis, which
    // is what the .elapsed CSS comment already says it is there to do.
    elapsedEl.textContent = size ? `${time} · ${size} raw` : time;
  }

  function setError(message) {
    if (!SHOW_CONTROLS) return;
    dot.classList.add('error');
    label.textContent = 'Video capture unavailable';
    note.textContent = message || '';
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  // H.264 first, on purpose. Chromium's MediaRecorder encodes it with the
  // platform's hardware encoder where there is one (VideoToolbox on macOS) —
  // measured at ~24% Electron CPU for a 1080p30 frame capture where VP9 sat
  // at ~94% — and, more importantly, an H.264 track is what lets
  // call-media-merge.js stream-copy the video into the final mp4 instead of
  // re-encoding it: the post-call merge goes from minutes to seconds and
  // stops scaling with the length of the call at all (issue #362). The
  // container stays webm/matroska (which is what Chromium writes for H.264 in
  // "webm" — ffmpeg reads it fine) so nothing about the chunk pipeline or the
  // on-disk file names changes. VP9/VP8 remain as fallbacks for an engine
  // without H.264 support; the merge re-encodes those as before.
  function pickMime() {
    for (const m of ['video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch { /* old engine */ }
    }
    return 'video/webm';
  }

  async function start() {
    let stream;
    try {
      // No source picker appears: main.js's setDisplayMediaRequestHandler on
      // THIS window's session answers every request with the capture
      // target's own frame directly (see call-recording-window.js), which
      // Electron intercepts before Chromium's native gesture-gated picker
      // would run.
      stream = await navigator.mediaDevices.getDisplayMedia(CAPTURE_CONSTRAINTS);
    } catch (err) {
      setError(String(err && err.message || err));
      window.electronAPI.send('frame-capture-error', { track: TRACK, message: String(err && err.message || err) });
      return;
    }

    const mime = pickMime();
    recordingMime = mime;
    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    } catch (err) {
      setError(String(err && err.message || err));
      window.electronAPI.send('frame-capture-error', { track: TRACK, message: String(err && err.message || err) });
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result).split(',')[1];
        if (b64) {
          window.electronAPI.send('frame-capture-chunk', {
            track: TRACK,
            seq: seq++,
            mime,
            dataBase64: b64,
            startWallClock,
          });
        }
      };
      reader.readAsDataURL(e.data);
    };
    mediaRecorder.onerror = (e) => {
      const message = (e && e.error && e.error.message) || 'MediaRecorder error';
      window.electronAPI.send('frame-capture-error', { track: TRACK, message });
    };
    // If the stream ends on its own (e.g. the source frame went away), don't
    // leave the window stuck in a "recording" state. What that SHOULD mean
    // differs by window: for the 'video' window it's the whole call ending —
    // ask main to stop the WHOLE recording, same as the Stop button. For the
    // 'share' window it just means the whiteboard share itself ended (its
    // source frame is whiteboardWindow, which can close for reasons that have
    // nothing to do with the recording continuing) — self-finalize quietly
    // instead of taking the audio+video recording down with it. Only the
    // normal, main-initiated stop path (stopShareCaptureIfActive) is supposed
    // to end this window; this is strictly the unexpected/self-heal case.
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (stopRequested) return;
        if (SHOW_CONTROLS) requestStop();
        else stopRecorderAndAck();
      });
    });

    startWallClock = Date.now();
    startedAt = performance.now();
    mediaRecorder.start(TIMESLICE_MS);

    if (SHOW_CONTROLS) {
      renderElapsed();
      elapsedTimer = setInterval(renderElapsed, 500);
    }
  }

  // Stop button (only wired when SHOW_CONTROLS — the 'video' track): ask MAIN
  // to stop the WHOLE recording (audio + video + any live share capture), the
  // same path start_recording/stop_recording and the call-end
  // teardown use — not just this window's own capture — so everything
  // finalizes and merges together. The 'share' capture has no button: its
  // stop is entirely driven by the share ending or the recording stopping.
  function requestStop() {
    if (SHOW_CONTROLS) {
      stopBtn.disabled = true;
      label.textContent = 'Stopping…';
    }
    window.electronAPI.send('frame-capture-stop-requested');
  }
  if (SHOW_CONTROLS) stopBtn.addEventListener('click', requestStop);

  // Stop the recorder, wait for the FINAL dataavailable/stop event — closing
  // the window before that would truncate the last ~1s of this track — then
  // ack so whoever's waiting (normally main's stopFrameCaptureWindow) knows
  // it's safe to close us. Shared by the two ways a stop can happen: main
  // telling us to ('frame-capture-stop', below) and this window's own
  // unexpected-source-ended self-heal (the 'share' branch above) — main isn't
  // necessarily waiting on the ack in the self-heal case (it didn't initiate
  // this stop), which is fine: it's a no-op if nothing's listening, and the
  // next real stopShareCaptureIfActive()/stopCallRecording() pass finds the
  // recorder already inactive and finishes immediately.
  function stopRecorderAndAck() {
    stopRequested = true;
    if (SHOW_CONTROLS) {
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      label.textContent = 'Stopping…';
      stopBtn.disabled = true;
    }
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      window.electronAPI.send('frame-capture-stopped');
      return;
    }
    mediaRecorder.addEventListener('stop', () => {
      window.electronAPI.send('frame-capture-stopped');
    }, { once: true });
    try {
      mediaRecorder.stop();
    } catch {
      window.electronAPI.send('frame-capture-stopped');
    }
  }

  // Main tells us to stop (as part of stopCallRecording, or — for 'share' —
  // onStopSharing tearing down the share via stopShareCaptureIfActive).
  window.electronAPI.on('frame-capture-stop', stopRecorderAndAck);

  // #328: main's periodic size push. Only the visible 'video' window has a UI
  // to put it in, and main only ever sends it there. Bytes are the WHOLE
  // recording's (every audio track + video + any share capture), not this
  // window's own track — the question being answered is "how much disk is this
  // call eating", which no single track answers.
  window.electronAPI.on('recording-stats', (stats) => {
    if (!SHOW_CONTROLS || !stats || stopRequested) return;
    sizeBytes = Number.isFinite(stats.bytes) ? stats.bytes : null;
    renderElapsed();
    // The note line is shared with setError(); an error ends the elapsed timer
    // and is the more important message, so never overwrite one.
    if (!dot.classList.contains('error')) {
      const free = Number.isFinite(stats.freeBytes) ? fmtBytes(stats.freeBytes) : '';
      const est = sizeBytes === null ? '' : fmtBytes(sizeBytes * mergedSizeRatio());
      note.textContent = [est && `~${est} final`, free && `${free} free on disk`]
        .filter(Boolean).join(' · ');
    }
    if (stats.dir) {
      // Hover anywhere on the row to see where this is being written.
      document.body.title = stats.dir;
    }
  });

  start();
})();
