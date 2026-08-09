// call-recording-window.js (renderer): drives getDisplayMedia() + MediaRecorder
// for a frame-capture window (electron-app/call-recording-window.js, main
// process side). Reused for BOTH capture tracks:
//   - track=video, controls=1: the visible Meet-view status window (elapsed
//     time + Stop button, which asks main to stop the WHOLE recording).
//   - track=share, controls=0: the hidden whiteboard-share side capture, no
//     UI, normally driven by main telling it to stop; self-finalizes quietly
//     (no message to main asking it to stop the WHOLE recording) if its
//     source frame disappears some other way. See the 'ended' handler below.
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
    // Background capture (the whiteboard-share track): no status UI needed,
    // this window is never shown, but the elements still exist in the DOM,
    // so just hide the whole row rather than maintaining a second HTML file.
    document.body.style.display = 'none';
  }

  let seq = 0;
  let startWallClock = 0;
  let startedAt = 0;
  let elapsedTimer = null;
  let mediaRecorder = null;
  let stopRequested = false;

  function fmtElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function setError(message) {
    if (!SHOW_CONTROLS) return;
    dot.classList.add('error');
    label.textContent = 'Video capture unavailable';
    note.textContent = message || '';
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function pickMime() {
    for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
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
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
      setError(String(err && err.message || err));
      window.electronAPI.send('frame-capture-error', { track: TRACK, message: String(err && err.message || err) });
      return;
    }

    const mime = pickMime();
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
    // differs by window: for the 'video' window it's the whole call ending, so
    // ask main to stop the WHOLE recording, same as the Stop button. For the
    // 'share' window it just means the whiteboard share itself ended (its
    // source frame is whiteboardWindow, which can close for reasons that have
    // nothing to do with the recording continuing), so self-finalize quietly
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
      elapsedTimer = setInterval(() => {
        elapsedEl.textContent = fmtElapsed(performance.now() - startedAt);
      }, 500);
    }
  }

  // Stop button (only wired when SHOW_CONTROLS, the 'video' track): ask MAIN
  // to stop the WHOLE recording (audio + video + any live share capture), the
  // same path start_recording/stop_recording and the call-end
  // teardown use, not just this window's own capture, so everything
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

  // Stop the recorder, wait for the FINAL dataavailable/stop event (closing
  // the window before that would truncate the last ~1s of this track), then
  // ack so whoever's waiting (normally main's stopFrameCaptureWindow) knows
  // it's safe to close us. Shared by the two ways a stop can happen: main
  // telling us to ('frame-capture-stop', below) and this window's own
  // unexpected-source-ended self-heal (the 'share' branch above). Main isn't
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

  // Main tells us to stop (as part of stopCallRecording, or, for 'share',
  // onStopSharing tearing down the share via stopShareCaptureIfActive).
  window.electronAPI.on('frame-capture-stop', stopRecorderAndAck);

  start();
})();
