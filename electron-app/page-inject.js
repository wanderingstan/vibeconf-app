// page-inject.js — Runs in Google Meet's page context (MAIN world, document_start)
// Overrides getUserMedia to provide virtual camera and microphone.
// Adapted from GIF-Cam virtual camera extension (2020).

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration (updated via postMessage from content script / popup)
  // ---------------------------------------------------------------------------

  const config = {
    botName: 'AI Assistant',
    botColor: '#1a73e8',
    canvasWidth: 1280,
    canvasHeight: 720,
    fps: 30,
  };

  // ---------------------------------------------------------------------------
  // CameraSurface — the virtual camera's <canvas> and the MediaStream captured
  // from it. What it shows is up to whoever registers a renderer through
  // window.__vibeconfMedia.setCameraRenderer (the app's emoji avatar is one,
  // in page-avatar.js), or a video source (setVideoSource, e.g. a Runway avatar
  // stream) which, once it has frames, is drawn instead. With neither, black.
  // ---------------------------------------------------------------------------

  class CameraSurface {
    constructor(width, height) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width || config.canvasWidth;
      this.canvas.height = height || config.canvasHeight;
      this.ctx = this.canvas.getContext('2d');
      // A <video> drawn instead of the renderer once it has frames. null = the
      // renderer (default, unchanged).
      this.videoSource = null;
      this.stopped = false;
      this.renderer = cameraRendererFactory ? cameraRendererFactory(this) : null;

      // Draw the first frame synchronously so the track has content immediately
      this._render();

      this.stream = this.canvas.captureStream(config.fps);
      this._startRenderLoop();
    }

    // Start with setInterval (works without user gesture), then upgrade to
    // AudioContext-based timer once available (keeps rendering in background tabs).
    _startRenderLoop() {
      const interval = 1000 / config.fps;

      // Immediate fallback: setInterval always works
      this._intervalId = setInterval(() => this._render(), interval);

      // Try to upgrade to AudioContext timer (survives background tabs)
      this._tryAudioTimer(interval);
    }
    _tryAudioTimer(intervalMs) {
      try {
        const freq = intervalMs / 1000;
        const aCtx = new AudioContext();

        const startOscLoop = () => {
          // Stop the setInterval fallback
          if (this._intervalId) {
            clearInterval(this._intervalId);
            this._intervalId = null;
          }
          console.debug('[bots-in-calls] Upgraded to AudioContext render loop');

          const tick = () => {
            if (this.stopped) return;
            const osc = aCtx.createOscillator();
            osc.onended = tick;
            const silence = aCtx.createGain();
            silence.gain.value = 0;
            silence.connect(aCtx.destination);
            osc.connect(silence);
            osc.start(0);
            osc.stop(aCtx.currentTime + freq);
            this._render();
          };
          tick();
        };

        if (aCtx.state === 'running') {
          startOscLoop();
        } else {
          // Resume after any user gesture on the page
          const resume = () => {
            aCtx.resume().then(() => {
              if (aCtx.state === 'running') {
                startOscLoop();
                document.removeEventListener('click', resume, true);
                document.removeEventListener('keydown', resume, true);
              }
            });
          };
          document.addEventListener('click', resume, true);
          document.addEventListener('keydown', resume, true);
        }
      } catch (e) {
        // AudioContext not available — setInterval keeps running
      }
    }
    // Draw a <video> (e.g. a Runway avatar stream) instead of the renderer once
    // it has frames; null goes back to the renderer.
    setVideoSource(videoEl) {
      this.videoSource = videoEl || null;
    }

    _render() {
      const { canvas, ctx } = this;
      const w = canvas.width;
      const h = canvas.height;

      // --- P2: Runway avatar face (opt-in). When a playing avatar video is attached, it
      // replaces the emoji entirely. Inert unless setAvatarVideo() was called. Falls back to
      // the emoji render until the video has real frames. (diagnostic logs once per camera.) ---
      if (this.videoSource) {
        if (!this._avatarSeenLogged) { this._avatarSeenLogged = true; console.log('[runway-avatar] _render sees avatarVideo (waiting for frames): rs=' + this.videoSource.readyState + ' w=' + this.videoSource.videoWidth); }
        if (this.videoSource.readyState >= 2 && this.videoSource.videoWidth > 0) {
          try {
            ctx.drawImage(this.videoSource, 0, 0, w, h);
            if (!this._avatarDrawLogged) { this._avatarDrawLogged = true; console.log('[runway-avatar] FIRST avatar frame drawn to camera ✅ (' + this.videoSource.videoWidth + 'x' + this.videoSource.videoHeight + ')'); }
            return;
          } catch (e) {
            if (!this._avatarErrLogged) { this._avatarErrLogged = true; console.warn('[runway-avatar] drawImage FAILED (taint/decode?): ' + (e && e.message)); }
          }
        }
      }

      if (this.renderer) {
        this.renderer.render();
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
      }
    }

    getTrack(consumer = 'unknown') {
      // Camera twin of the #274 mic fix: hand out a CLONE of a live master, never the
      // master itself. See handOutCameraTrack (module scope, unit-tested).
      return handOutCameraTrack(this, consumer, config.fps);
    }
    destroy() {
      this.stopped = true;
      this.stream.getTracks().forEach((t) => t.stop());
    }
  }

  // ---------------------------------------------------------------------------
  // VirtualMic — Web Audio pipeline that exposes an audio MediaStreamTrack.
  // TTS audio can be piped in via playAudio(). Outputs silence when idle.
  // ---------------------------------------------------------------------------

  class VirtualMic {
    constructor() {
      this.audioCtx = new AudioContext();
      this.destination = this.audioCtx.createMediaStreamDestination();

      // A silent oscillator keeps the stream active so Meet doesn't drop it
      const silence = this.audioCtx.createGain();
      silence.gain.value = 0;
      silence.connect(this.destination);
      const osc = this.audioCtx.createOscillator();
      osc.connect(silence);
      osc.start();

      // #274: keep the context RUNNING for the whole call. A suspended AudioContext
      // produces no audio (the master track stays readyState:'live' but goes silent),
      // which reads as "speak stopped landing" late in a long call. Auto-resume if the
      // browser suspends it (backgrounding, power events) so the master never goes mute.
      this.audioCtx.addEventListener?.('statechange', () => {
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
      });

      // Analyser for amplitude-driven lip-sync. TTS sources connect into it
      // (in parallel with the destination) so the avatar can read how loud the
      // bot is speaking right now and animate its mouth to match.
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this._ampBuf = new Uint8Array(this.analyser.fftSize);
      this._smoothedAmp = 0;
    }

    // Current speech loudness, 0..1, lightly smoothed. ~0 when not speaking.
    getAmplitude() {
      this.analyser.getByteTimeDomainData(this._ampBuf);
      let sumSq = 0;
      for (let i = 0; i < this._ampBuf.length; i++) {
        const v = (this._ampBuf[i] - 128) / 128; // -1..1
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / this._ampBuf.length); // 0..~1
      // Scale up (speech RMS is small) and clamp, then smooth toward the target.
      const target = Math.min(1, rms * 6);
      // Asymmetric smoothing: open a bit faster than it closes → reads natural.
      // Kept gentle so the emoji doesn't visibly snap between sizes frame to frame.
      const k = target > this._smoothedAmp ? 0.28 : 0.14;
      this._smoothedAmp += (target - this._smoothedAmp) * k;
      return this._smoothedAmp;
    }

    // Play a TTS response (or any audio) through the virtual mic.
    // Returns a promise that resolves when playback ends.
    async playAudio(arrayBuffer, volume = 1) {
      // Data may arrive as base64 string after Chrome message passing
      // (ArrayBuffer can't survive chrome.tabs.sendMessage serialization).
      if (typeof arrayBuffer === 'string') {
        const binary = atob(arrayBuffer);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        arrayBuffer = bytes.buffer;
      } else if (!(arrayBuffer instanceof ArrayBuffer)) {
        // Fallback: reconstruct from serialized object
        const bytes = new Uint8Array(Object.values(arrayBuffer));
        arrayBuffer = bytes.buffer;
      }
      const buf = await this.audioCtx.decodeAudioData(arrayBuffer.slice(0));
      return this._playBuffer(buf, 0, volume);
    }

    // #350: resume a previously-decoded buffer from `offset` seconds in — the
    // audio-level sibling of the fresh-TTS path. Same lip-sync tap + source
    // bookkeeping; only the start offset differs.
    async playAudioBuffer(buf, offset, volume = 1) {
      return this._playBuffer(buf, Math.max(0, offset || 0), volume);
    }

    // Shared playback core. Tracks the decoded buffer and the wall-clock start
    // (plus the in-buffer offset it began at) so stopAudio() can report how far
    // we actually got — the seam #350 resumes from.
    _playBuffer(buf, offset = 0, volume = 1) {
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      // Acknowledgements play quieter than real speech (a human's "mm-hmm" is
      // not the same loudness as their sentence). Full-volume playback skips
      // the node entirely, so the normal path is byte-for-byte what it was.
      //
      // Only the DESTINATION tap is attenuated. The analyser tap stays at unit
      // gain deliberately: it drives lip-sync, and a quiet ack should still
      // move the avatar's mouth normally rather than mumble.
      if (volume < 1) {
        const g = this.audioCtx.createGain();
        g.gain.value = Math.max(0, volume);
        src.connect(g).connect(this.destination);
      } else {
        src.connect(this.destination);
      }
      src.connect(this.analyser); // feed lip-sync amplitude (parallel tap)
      // Expose the live source so stopAudio() can interrupt it for back-off
      // (#154). onended fires whether playback finished or was stop()'d.
      this._currentSource = src;
      this._currentBuf = buf;
      this._currentOffset = offset;                    // where this playback began
      this._currentStartAt = this.audioCtx.currentTime; // clock at src.start()
      // Echo diagnosis: count how many TTS sources are wired to the mic
      // destination at once. Normal playback is strictly serialized → this must
      // stay 1. If it EVER logs >1, we have a genuine digital double-play (two
      // bot voices into Meet); if it stays 1 while a double is heard, the echo is
      // acoustic (speaker → mic re-injection), not our code.
      const srcId = (this._srcSeq = (this._srcSeq || 0) + 1);
      this._liveSources = (this._liveSources || 0) + 1;
      if (this._liveSources > 1) {
        console.warn('[tts-audio] ⚠️ DIGITAL DOUBLE-PLAY — ' + this._liveSources +
          ' TTS sources live on the mic at once (src #' + srcId + ', ' + buf.duration.toFixed(1) + 's)');
      } else {
        console.log('[tts-audio] play src #' + srcId + ' (' + buf.duration.toFixed(1) + 's, offset ' + offset.toFixed(1) + 's) — live=' + this._liveSources);
      }
      return new Promise((resolve) => {
        src.onended = () => {
          if (this._currentSource === src) this._currentSource = null;
          this._liveSources = Math.max(0, (this._liveSources || 1) - 1);
          resolve();
        };
        src.start(0, offset);
      });
    }

    // Stop the currently-playing TTS source immediately. No-op if nothing is
    // playing. Used by the barge-in / back-off path (#154). The src.stop()
    // call triggers onended → the playAudio promise resolves naturally, so
    // the playNextTTS state machine cleans up on its own. Returns how far into
    // the buffer we got so the caller can retain it for a #350 resume:
    //   { wasPlaying, buf, playedTo }  (buf null when nothing was playing).
    stopAudio() {
      const src = this._currentSource;
      if (!src) return { wasPlaying: false, buf: null, playedTo: 0 };
      const buf = this._currentBuf || null;
      const playedTo = (this._currentOffset || 0) +
        (this.audioCtx.currentTime - (this._currentStartAt || this.audioCtx.currentTime));
      try { src.stop(); } catch { /* already stopped */ }
      this._currentSource = null;
      return { wasPlaying: true, buf, playedTo: buf ? Math.min(playedTo, buf.duration) : playedTo };
    }

    getTrack(consumer = 'unknown') {
      // #274 fix (codex hypothesis): ONE stable master destination for the lifetime of
      // the page — NEVER rebuilt under normal operation. Each consumer (the call via
      // getUserMedia; Runway via __vibeMicTrack) gets an INDEPENDENT clone(). So when
      // Slack/Meet stop()s its own mic track on the lobby→huddle handoff or a device
      // switch, only THAT clone dies — our master and every other clone stay live, and
      // the call simply re-acquires a fresh clone on its next getUserMedia. We never hand
      // out (or replace) the master track itself, so the call can never end up pinned to
      // a track WE killed. The OLD rebuild path swapped the destination out from under an
      // already-acquired consumer: Runway's getTrack() got the new live track while Meet
      // stayed pinned to the dead one → "face animates, but no audio." Clones eliminate
      // that split-brain. TTS sources connect to this.destination (the master), so every
      // live clone carries the speech.

      // Master-liveness guard (codex): consumers only ever get clones, so the master
      // shouldn't end — but removing the rebuild made master death TERMINAL (every future
      // clone dead until reload) if the AudioContext closes or Chromium ends the
      // destination track. Guarded one-time revive + loud log so the soak surfaces it
      // instead of going silently dead. This is NOT the old per-ended rebuild — it only
      // fires when the MASTER itself is dead, never to swap a track out from a consumer.
      let master = this.destination.stream.getAudioTracks()[0];
      if (!master || master.readyState === 'ended' || this.audioCtx.state === 'closed') {
        console.warn(`[bots-in-calls] #274 GUARD: master dead (consumer=${consumer} master=${master && master.readyState} ctx=${this.audioCtx.state}) — reviving destination`);
        if (this.audioCtx.state === 'closed') this.audioCtx = new AudioContext();
        this.destination = this.audioCtx.createMediaStreamDestination();
        const silence = this.audioCtx.createGain(); silence.gain.value = 0; silence.connect(this.destination);
        const osc = this.audioCtx.createOscillator(); osc.connect(silence); osc.start();
        master = this.destination.stream.getAudioTracks()[0];
      }

      const clone = master.clone();
      // Clone lifecycle instrumentation (codex): label by consumer + log when THIS clone
      // ENDS, so the soak can prove the failure mode directly — e.g. the Slack lobby clone
      // ends AND a fresh 'call:getUserMedia' is re-acquired after the huddle goes live
      // (the Slack-regression check), not hidden behind a healthy master-track log.
      console.log(`[bots-in-calls] #274 getTrack consumer=${consumer} clone=${clone.id} master=${master.id} (masterState=${master.readyState})`);
      clone.addEventListener('ended', () => {
        console.log(`[bots-in-calls] #274 clone ENDED consumer=${consumer} clone=${clone.id} (master now ${this.destination.stream.getAudioTracks()[0] && this.destination.stream.getAudioTracks()[0].readyState})`);
      });
      // Keep a handle on the clone the CALL holds, so the play-tts diagnostic can log the
      // ACTUAL call clone's readyState (codex) — a dead call clone must not hide behind a
      // healthy master log.
      if (consumer.startsWith('call')) this._lastCallTrack = clone;
      return clone;
    }

    // Soft two-tone "I'm in the room" chime — used when admission completes,
    // replacing the canned "Hello I am X" welcome speech. Played through the
    // virtual mic so other participants hear it, just like TTS speech.
    async playJoinChime() {
      try {
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        const now = this.audioCtx.currentTime;
        // Two ascending sine pings, soft attack and release
        const tones = [
          { freq: 660, start: 0,    dur: 0.18 },
          { freq: 880, start: 0.16, dur: 0.22 },
        ];
        for (const t of tones) {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.value = t.freq;
          gain.gain.setValueAtTime(0, now + t.start);
          gain.gain.linearRampToValueAtTime(0.18, now + t.start + 0.02);
          gain.gain.linearRampToValueAtTime(0, now + t.start + t.dur);
          osc.connect(gain).connect(this.destination);
          osc.start(now + t.start);
          osc.stop(now + t.start + t.dur + 0.02);
        }
      } catch (err) {
        console.error('[bots-in-calls] Join chime failed:', err);
      }
    }

    destroy() {
      this.audioCtx.close();
    }
  }

  // ---------------------------------------------------------------------------
  // getUserMedia / getDisplayMedia overrides
  // ---------------------------------------------------------------------------

  let mic = null;
  let active = true; // Auto-active for POC

  // TTS audio queue — prevents overlapping playback
  const ttsQueue = [];
  let ttsPlaying = false;
  // #372 sentence-chunked TTS: when a play-tts arrives flagged expectMore,
  // another chunk of the SAME utterance is being synthesized main-side. If
  // the queue drains before it lands, HOLD the speaking state (no tts-ended,
  // face stays) until this deadline; the final chunk (expectMore=false)
  // clears it. The deadline caps the hold so a failed chunk-2 synth can't
  // leave the bot stuck "speaking" forever.
  let ttsExpectMoreUntil = 0;
  // Emoji of the utterance currently playing — so a mid-playback interruption
  // can retain it and resume (#350) with the same face.
  let currentSpeakingEmoji = null;
  // #350: a mid-TTS utterance that was cut off by a barge-in, retained so the
  // next silence edge can resume it near the interruption point instead of
  // dropping it. { buf, playedTo, emoji, utt, at } or null.
  let interruptedTts = null;
  // #360: the {id, chunk, chunks} tag of the clip currently playing, so a
  // stop-tts can report WHICH chunk of WHICH utterance it interrupted.
  let currentTtsTag = null;
  // Playback gain of the utterance in flight, so a resume after a barge-in
  // comes back at the volume it was cut off at rather than jumping to full.
  let currentTtsVolume = 1;

  async function playNextTTS() {
    if (ttsPlaying || ttsQueue.length === 0) return;
    ttsPlaying = true;
    const { audioData, resumeBuf, offset, emoji, utt, volume } = ttsQueue.shift();
    // Absent/invalid → 1, so anything that doesn't set it plays as before.
    const vol = (typeof volume === 'number' && volume >= 0 && volume < 1) ? volume : 1;
    currentTtsTag = utt || null;
    currentSpeakingEmoji = emoji || null;
    currentTtsVolume = vol;
    media.emit('bot-speaking', { speaking: true, emoji: emoji || null });
    transcription.botSpeaking = true;
    try {
      // Ensure AudioContext is running before playback
      if (mic.audioCtx.state === 'suspended') {
        console.log('[bots-in-calls] Resuming AudioContext before TTS playback');
        await mic.audioCtx.resume();
      }
      // #350: a resume item carries an already-decoded buffer + offset; a fresh
      // utterance carries encoded audioData.
      if (resumeBuf) {
        await mic.playAudioBuffer(resumeBuf, offset, vol);
      } else {
        await mic.playAudio(audioData, vol);
      }
    } catch (err) {
      console.error('[bots-in-calls] TTS playback error:', err);
    }
    ttsPlaying = false;
    currentTtsTag = null;
    currentTtsVolume = 1;
    _ttsMaybeFinish();
  }

  // Queue drained (or a hold lapsed): either play the next clip, keep holding
  // for a promised chunk (#372), or finish the utterance (tts-ended).
  function _ttsMaybeFinish() {
    if (ttsPlaying) return;
    if (ttsQueue.length > 0) { playNextTTS(); return; }
    if (Date.now() < ttsExpectMoreUntil) {
      // A chunked utterance promised another clip — hold the speaking state
      // across the seam instead of emitting a premature tts-ended (which
      // would flicker the face and drop botState out of 'speaking' between
      // sentences). Re-check shortly; an arriving chunk resumes playback via
      // its own playNextTTS call.
      setTimeout(_ttsMaybeFinish, 200);
      return;
    }
    media.emit('bot-speaking', { speaking: false, emoji: null });
    setTimeout(() => { transcription.botSpeaking = false; }, 1500);
    window.postMessage({ __botsInCalls: true, action: 'tts-ended' }, '*');
  }

  // Parse width/height from Meet's video constraints
  function parseVideoDimensions(videoConstraints) {
    if (!videoConstraints || typeof videoConstraints !== 'object') {
      return { width: config.canvasWidth, height: config.canvasHeight };
    }
    const w = videoConstraints.width;
    const h = videoConstraints.height;
    return {
      width: (w?.ideal || w?.exact || w?.max || config.canvasWidth),
      height: (h?.ideal || h?.exact || h?.max || config.canvasHeight),
    };
  }

  // Keep one camera per resolution to avoid re-creating on every getUserMedia call
  const cameras = new Map();

  // ---------------------------------------------------------------------------
  // window.__vibeconfMedia — what the app's page plugins (page-avatar.js,
  // page-realtime-voice.js; loaded right after this file by page-scripts.js)
  // build on. Phase 2 of the calls library: the media core stays here, and
  // what the app draws or says through it lives in the plugins.
  //   setCameraRenderer(factory)  factory(surface) → { render() }, called for
  //                               every camera, existing and future
  //   on(event, fn)               'bot-speaking' { speaking, emoji? }
  //                               (emoji absent = leave the face's own as is),
  //                               'recording' { on }
  //   mic()                       the VirtualMic, created on first use
  //   remoteAudio()               the AudioCaptureManager (other people's audio)
  //   speechLevel()               the bot's voice level now, 0..1 (lip-sync)
  //   outputTapTracks()           played-out tracks the RTC hook can't see
  //   currentMic()                the VirtualMic if it exists (never creates)
  //   setOwnVoice(on)             the bot's own voice is (not) playing
  // ---------------------------------------------------------------------------
  let cameraRendererFactory = null;
  const mediaListeners = new Map();
  const media = {
    setCameraRenderer(factory) {
      cameraRendererFactory = factory;
      for (const cam of cameras.values()) cam.renderer = factory ? factory(cam) : null;
    },
    on(event, fn) {
      if (!mediaListeners.has(event)) mediaListeners.set(event, new Set());
      mediaListeners.get(event).add(fn);
    },
    emit(event, data) {
      for (const fn of mediaListeners.get(event) || []) {
        try { fn(data); } catch (e) { console.warn('[bots-in-calls] media listener (' + event + ') failed:', e && e.message); }
      }
    },
    mic() { if (!mic) mic = new VirtualMic(); return mic; },
    remoteAudio() { return audioCaptureManager; },
    // How loud the bot's own voice is right now (0..1), for lip-sync. 0 when
    // no mic exists yet; never creates one.
    speechLevel() { return (mic && mic.getAmplitude) ? mic.getAmplitude() : 0; },
    // Tracks the page plays out that the hooks can't see (media elements with
    // the RTC hook off: Slack, WhatsApp). The STT tap hears these too.
    outputTapTracks() { return outputTapTracks(); },
    // The mic if it exists yet; never creates one.
    currentMic() { return mic; },
    // Mark the bot's own voice as playing, so its caption isn't taken for
    // someone else's speech. The TTS path sets the same flag.
    setOwnVoice(on) { try { if (transcription) transcription.botSpeaking = !!on; } catch { /* not up */ } },
  };
  window.__vibeconfMedia = media;

  // P2: latch the avatar video so a camera created AFTER the track arrives (or recreated on a
  // camera toggle) still picks it up — otherwise the avatar is dropped on a timing race. (codex.)
  let pendingAvatarVideo = null;

  // Camera handout (WhatsApp dead-video fix, mirrors the #274 mic clones).
  //
  // The bug: getCamera() caches one CameraSurface per resolution, and getTrack() used to
  // return the camera's ONE canvas track to every getUserMedia caller. WhatsApp Web probes
  // the camera before answering (a 1280x720 preview), then at answer calls getUserMedia
  // again at the same size and only afterwards stop()s the probe stream. Both callers held
  // the SAME track object, so stopping the "probe" killed the call's video: the caller saw
  // nothing until set_camera off/on forced a fresh getUserMedia. (The old ended-check only
  // helped when the stop landed BEFORE the next request; here it landed after.) When the
  // probe and the answer asked for different sizes, the answer got its own camera and the
  // bug hid, which is why an earlier call the same day worked.
  //
  // The fix: the camera's canvas track is a master that is never handed out; every
  // consumer gets master.clone(), so a consumer stopping its track only ends its own
  // clone. If the master itself is dead (should not happen, nobody outside holds it),
  // re-capture from the same canvas (the render loop is still running) and log loudly.
  // Pure aside from cam.canvas.captureStream(), so tests drive it with fakes.
  function handOutCameraTrack(cam, consumer, fps) {
    let master = cam.stream && cam.stream.getVideoTracks()[0];
    if (!master || master.readyState === 'ended') {
      console.warn(`[bots-in-calls] camera GUARD: master dead (consumer=${consumer} master=${master ? master.readyState : 'none'}), re-capturing from canvas`);
      cam.stream = cam.canvas.captureStream(fps);
      master = cam.stream.getVideoTracks()[0];
    }
    const clone = master.clone();
    console.log(`[bots-in-calls] camera getTrack consumer=${consumer} size=${cam.canvas.width}x${cam.canvas.height} clone=${clone.id} master=${master.id} (masterState=${master.readyState} cloneState=${clone.readyState})`);
    // Note: a consumer's own stop() does not fire 'ended'; this catches the master
    // (source) ending underneath a clone, which would otherwise be silent.
    clone.addEventListener('ended', () => {
      const m = cam.stream && cam.stream.getVideoTracks()[0];
      console.log(`[bots-in-calls] camera clone ENDED consumer=${consumer} clone=${clone.id} (master now ${m ? m.readyState : 'none'})`);
    });
    return clone;
  }

  function getCamera(width, height) {
    const key = `${width}x${height}`;
    if (!cameras.has(key)) {
      const cam = new CameraSurface(width, height);
      if (pendingAvatarVideo) cam.setVideoSource(pendingAvatarVideo);
      cameras.set(key, cam);
      console.log('[bots-in-calls] Created virtual camera:', key, 'pendingAvatar=', !!pendingAvatarVideo);
    }
    return cameras.get(key);
  }

  // P2 bridge — lets runway-avatar.js (separate page script) drive the Runway face: set the
  // avatar <video> on every CameraSurface (+ latch it for cameras created later), and read the
  // bot's TTS mic track to publish to Runway (rebuild-aware getTrack(), survives the Slack
  // stop()/rebuild). No-ops on the default emoji path (only used when a connect message fires).
  window.__vibeSetAvatarVideo = (el) => {
    pendingAvatarVideo = el || null;
    let n = 0; try { cameras.forEach((c) => { n++; c.setVideoSource(pendingAvatarVideo); }); } catch (e) { console.warn('[bots-in-calls] setAvatarVideo bridge:', e && e.message); }
    console.log('[bots-in-calls] avatar video set:', !!pendingAvatarVideo, 'cameras=', n);
  };
  window.__vibeMicTrack = () => { try { return mic ? mic.getTrack('runway') : null; } catch (e) { return null; } };

  const _getUserMedia = MediaDevices.prototype.getUserMedia;

  MediaDevices.prototype.getUserMedia = async function (constraints) {
    if (!active) {
      return _getUserMedia.call(navigator.mediaDevices, constraints);
    }

    console.debug('[bots-in-calls] getUserMedia intercepted:', JSON.stringify(constraints));

    const tracks = [];

    if (constraints?.video) {
      const { width, height } = parseVideoDimensions(constraints.video);
      const camera = getCamera(width, height);
      tracks.push(camera.getTrack('call:getUserMedia'));
    }

    if (constraints?.audio) {
      if (!mic) {
        mic = new VirtualMic();
        console.log('[bots-in-calls] Created VirtualMic for getUserMedia, AudioContext state:', mic.audioCtx.state);
      }
      const audioTrack = mic.getTrack('call:getUserMedia');
      console.log('[bots-in-calls] Providing audio track:', audioTrack.id, 'enabled:', audioTrack.enabled, 'readyState:', audioTrack.readyState);
      tracks.push(audioTrack);
    }

    if (tracks.length > 0) {
      const stream = new MediaStream(tracks);
      console.debug('[bots-in-calls] Returning virtual stream:', tracks.length, 'track(s)',
        constraints?.video ? `(${parseVideoDimensions(constraints.video).width}x${parseVideoDimensions(constraints.video).height})` : '');
      return stream;
    }

    return _getUserMedia.call(navigator.mediaDevices, constraints);
  };

  // ---------------------------------------------------------------------------
  // Permissions API override — Make Meet think mic/camera permissions are granted
  // ---------------------------------------------------------------------------

  const _permissionsQuery = Permissions.prototype.query;

  Permissions.prototype.query = async function (descriptor) {
    if (active && (descriptor.name === 'microphone' || descriptor.name === 'camera')) {
      console.debug('[bots-in-calls] permissions.query intercepted:', descriptor.name, '→ granted');
      // Return a PermissionStatus-like object with EventTarget methods
      // so Meet's code doesn't throw when calling addEventListener
      const status = new EventTarget();
      status.state = 'granted';
      status.onchange = null;
      return status;
    }
    return _permissionsQuery.call(this, descriptor);
  };

  // Also override enumerateDevices to always include virtual mic/camera entries
  const _enumerateDevices = MediaDevices.prototype.enumerateDevices;

  MediaDevices.prototype.enumerateDevices = async function () {
    const devices = await _enumerateDevices.call(navigator.mediaDevices);

    if (!active) return devices;

    // Ensure at least one audioinput and videoinput appear
    const hasAudio = devices.some((d) => d.kind === 'audioinput');
    const hasVideo = devices.some((d) => d.kind === 'videoinput');

    const extras = [];
    if (!hasAudio) {
      extras.push({
        deviceId: 'virtual-mic',
        kind: 'audioinput',
        label: 'Bots in Calls Virtual Microphone',
        groupId: 'bots-in-calls',
        toJSON() { return this; },
      });
    }
    if (!hasVideo) {
      extras.push({
        deviceId: 'virtual-camera',
        kind: 'videoinput',
        label: 'Bots in Calls Virtual Camera',
        groupId: 'bots-in-calls',
        toJSON() { return this; },
      });
    }

    if (extras.length > 0) {
      console.debug('[bots-in-calls] enumerateDevices: added', extras.length, 'virtual device(s)');
    }
    return [...devices, ...extras];
  };

  // ---------------------------------------------------------------------------
  // getDisplayMedia override. In Electron the main process picks the source
  // (the app's whiteboard window, setDisplayMediaRequestHandler); in a plain
  // browser the native picker shows.
  // ---------------------------------------------------------------------------

  const _getDisplayMedia = MediaDevices.prototype.getDisplayMedia;

  // Agent-controlled mute for the shared surface's sound (set_share_audio).
  //
  // The mute has to live UPSTREAM of the track we hand Meet. Setting
  // `enabled = false` on the captured track looks right and does nothing:
  // Meet clones the track before publishing it, and a clone carries its own
  // `enabled` state, so we end up silencing a track nobody transmits while the
  // clone plays on. (Verified in a live call — a "muted" share was still
  // audible on a remote device.) Muting the shared WINDOW instead
  // (webContents.setAudioMuted) is no good either: that is local-output
  // muting, and the capture tap sits upstream of it.
  //
  // So route the captured audio through a gain node and publish the gain's
  // output instead. Every clone Meet makes descends from that node, so gain 0
  // silences all of them at once, instantly, with no renegotiation and without
  // restarting the share. The board keeps playing normally — the bot can still
  // watch a video it has muted for everyone else.
  //
  // The flag outlives any one share: a share started while muted comes up
  // muted, rather than surprising the room with sound already suppressed.
  let shareAudioGain = null;
  let shareAudioMuted = false;
  // The RAW shared audio track (the tab/screen's actual sound, before the mute
  // gain). Exposed so the call recorder can save it as its own track (#209),
  // mirroring __vibeMicTrack. Recording the raw source, not the published
  // (post-mute) track, so the shared content's audio is captured even when the
  // bot has muted it into the call. Cleared when the share ends.
  let currentShareAudioTrack = null;
  window.__vibeShareTrack = () =>
    (currentShareAudioTrack && currentShareAudioTrack.readyState === 'live') ? currentShareAudioTrack : null;

  function applyShareAudioMute() {
    if (!shareAudioGain) return false;
    shareAudioGain.gain.value = shareAudioMuted ? 0 : 1;
    return true;
  }

  // Swap the stream's captured audio track for a gain-controlled copy of it.
  // Returns the published track, or null if anything went wrong — in which
  // case the raw track stays in place and the share is simply un-muteable,
  // which beats losing the audio altogether.
  function installShareAudioGain(stream) {
    const raw = stream.getAudioTracks()[0];
    if (!raw) { shareAudioGain = null; return null; }
    // Expose the raw track for recording, whether or not the gain graph below
    // succeeds — a share that can't be muted can still be recorded.
    currentShareAudioTrack = raw;
    raw.addEventListener('ended', () => { if (currentShareAudioTrack === raw) currentShareAudioTrack = null; });
    try {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(new MediaStream([raw])).connect(gain).connect(dest);
      const published = dest.stream.getAudioTracks()[0];

      stream.removeTrack(raw);
      stream.addTrack(published);
      shareAudioGain = gain;
      applyShareAudioMute();
      ctx.resume().catch(() => { /* autoplay-policy switch should prevent this */ });

      // The raw track ends when the share does. Tear the graph down with it —
      // the gain's output track would otherwise stay live forever, since
      // nothing else ends it.
      raw.addEventListener('ended', () => {
        try { published.stop(); ctx.close(); } catch { /* already gone */ }
        if (shareAudioGain === gain) shareAudioGain = null;
      });
      return published;
    } catch (err) {
      console.warn('[bots-in-calls] Share audio gain setup failed —',
        'audio will play but cannot be muted:', err.message);
      shareAudioGain = null;
      return null;
    }
  }

  MediaDevices.prototype.getDisplayMedia = async function (constraints) {
    console.debug('[bots-in-calls] *** getDisplayMedia CALLED ***', JSON.stringify(constraints));
    // In Electron, session.setDisplayMediaRequestHandler handles source selection.
    // In Chrome extension, fall through to native picker.
    //
    // Ask for the board's audio on the bot's behalf. Meet DOES request audio,
    // but with `windowAudio: "exclude"` and `systemAudio: "exclude"` — it only
    // wants tab audio, which a window share isn't. Chromium honours that and
    // drops the audio the main-process handler offers, so the whiteboard's
    // track never reaches the stream no matter what the handler returns.
    // Replacing the constraint with a plain `audio: true` clears the exclusions.
    // Electron only: the extension path shows the real picker, where forcing
    // audio would change what the user is prompted for.
    //
    // Except when the page says `audio: false` outright. Telegram does, and then
    // takes stream.getTracks()[0] as its screencast; Chromium lists audio
    // tracks first, so forcing audio made it "screencast" a sound and no video
    // ever went out (live, 2026-10-26).
    const inElectron = typeof window.__vibeconf_getScreenShareSource === 'function';
    const refusesAudio = constraints?.audio === false;
    if (inElectron) {
      constraints = { ...(constraints || {}), audio: !refusesAudio };
      if (!constraints.video) constraints.video = true; // audio-only requests are rejected
    }
    const stream = await _getDisplayMedia.call(navigator.mediaDevices, constraints);
    if (inElectron && !refusesAudio) installShareAudioGain(stream);
    console.log('[bots-in-calls] getDisplayMedia →',
      stream.getVideoTracks().length, 'video,',
      stream.getAudioTracks().length, 'audio track(s)',
      shareAudioGain ? (shareAudioMuted ? '(muted)' : '(muteable)') : '(not muteable)');
    // Dimensions/fps of what participants actually receive. Worth a line in the
    // log: a share that looks fine locally can still arrive letterboxed or at
    // the wrong aspect, and this is the only place that shows it.
    try {
      const vt = stream.getVideoTracks()[0];
      if (vt) console.log('[bots-in-calls] share video settings:', JSON.stringify(vt.getSettings()));
    } catch (e) { console.warn('[bots-in-calls] track settings failed', e.message); }
    return stream;
  };

  // ---------------------------------------------------------------------------
  // Message bridge — receives commands from the content script
  // ---------------------------------------------------------------------------

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data?.__botsInCalls) return;

    const { action, payload } = event.data;

    switch (action) {
      case 'activate':
        active = true;
        break;

      case 'deactivate':
        active = false;
        break;

      case 'set-config':
        if (payload) Object.assign(config, payload);
        break;

      case 'set-share-audio':
        shareAudioMuted = !!payload?.muted;
        console.log('[bots-in-calls] Share audio', shareAudioMuted ? 'MUTED' : 'unmuted',
          applyShareAudioMute() ? '(applied to live track)' : '(no live share — applies to the next one)');
        break;

      case 'play-join-chime':
        // Replaces the old canned "Hello I am X" welcome — short two-tone
        // ping when admission completes so the user knows the bot is in the
        // room without filling silence with speech. Engagement is gated
        // separately on `set-engaged` (first participants seen) — the chime
        // can fire before the bot is actually wired up.
        if (mic) mic.playJoinChime();
        break;

      // (Removed: 'set-engaged'. Avatar engagement no longer fires on
      // captions-ready / first-participants — both happen via the bot's own
      // setup with no agent. hasEngaged now flips on real agent activity in
      // the 'set-bot-state' handler above, so 🫥 means "no agent driving yet".)

      case 'play-tts':
        if (!mic) {
          console.log('[bots-in-calls] VirtualMic not yet created, creating now for TTS');
          mic = new VirtualMic();
        }
        if (payload?.audioData) {
          // Ensure AudioContext is running (may be suspended without user gesture)
          if (mic.audioCtx.state === 'suspended') {
            console.log('[bots-in-calls] AudioContext suspended, resuming for TTS');
            mic.audioCtx.resume();
          }
          const master = mic.destination.stream.getAudioTracks()[0];
          const callClone = mic._lastCallTrack; // the clone the CALL actually holds (codex: a dead call-clone must NOT hide behind a healthy master log)
          console.log('[bots-in-calls] Queuing TTS audio, data length:', payload.audioData.length,
            'queue size:', ttsQueue.length,
            'AudioContext state:', mic.audioCtx.state,
            'CALL-clone:', callClone?.id, 'enabled:', callClone?.enabled, 'readyState:', callClone?.readyState, 'muted:', callClone?.muted,
            'master readyState:', master?.readyState,
            'destination tracks:', mic.destination.stream.getAudioTracks().length);
          // A fresh utterance supersedes any retained interrupted one — the
          // agent has moved on, so don't later resume a stale tail (#350).
          interruptedTts = null;
          // #372: expectMore=true promises another chunk of this utterance —
          // hold the speaking state if the queue drains before it arrives
          // (window refreshed per chunk; final chunk clears it).
          ttsExpectMoreUntil = payload.expectMore ? Date.now() + 8000 : 0;
          ttsQueue.push({ audioData: payload.audioData, emoji: payload.emoji, utt: payload.utt, volume: payload.volume });
          playNextTTS();
        }
        break;

      case 'stop-tts': {
        // Back-off (#154): interrupt the bot mid-utterance and drop anything
        // queued behind it. The current source's onended will fire and the
        // playNextTTS state machine cleans up normally, posting tts-ended.
        const droppedTags = ttsQueue.map((q) => q.utt).filter(Boolean);
        const droppedQueue = ttsQueue.length;
        ttsQueue.length = 0;
        // #372: a barge-in cancels any promised follow-up chunk — don't hold
        // the speaking state for audio that will never be welcome.
        ttsExpectMoreUntil = 0;
        const stopped = mic ? mic.stopAudio() : { wasPlaying: false, buf: null, playedTo: 0 };
        const reason = payload?.reason || 'unspecified';
        // #350: retain the cut-off buffer so a quick reopen can resume near the
        // interruption point instead of restarting the whole sentence. Only if
        // enough is left to be worth resuming.
        const MIN_REMAINING_S = 0.5;
        if (stopped.wasPlaying && stopped.buf &&
            (stopped.buf.duration - stopped.playedTo) > MIN_REMAINING_S) {
          interruptedTts = { buf: stopped.buf, playedTo: stopped.playedTo, emoji: currentSpeakingEmoji, utt: currentTtsTag, volume: currentTtsVolume, at: Date.now() };
          console.log('[bots-in-calls] stop-tts retained ' +
            (stopped.buf.duration - stopped.playedTo).toFixed(1) + 's tail for possible resume (#350)');
        } else {
          interruptedTts = null;
        }
        // #360: report how far playback actually got, so main can tell the
        // agent which part of its utterance the room never heard. Sent even
        // when nothing was playing — main still needs droppedTags (queued
        // chunks that will now never play) to account for the whole utterance.
        window.postMessage({
          __botsInCalls: true,
          action: 'tts-stopped',
          payload: {
            reason,
            wasPlaying: stopped.wasPlaying,
            playedTo: stopped.playedTo,
            duration: stopped.buf ? stopped.buf.duration : 0,
            tag: stopped.wasPlaying ? currentTtsTag : null,
            droppedTags,
          },
        }, '*');
        console.log('[bots-in-calls] stop-tts reason=' + reason + ' wasPlaying=' + stopped.wasPlaying + ' droppedQueue=' + droppedQueue);
        break;
      }

      case 'resume-tts': {
        // #350: floor reopened quickly after a barge-in — resume the retained
        // utterance a hair before where it was cut (BACKUP) so it doesn't clip
        // mid-word. local-server owns the decision (age + content-delta gate);
        // here we just deliver if we still have the buffer.
        if (!interruptedTts) {
          console.log('[bots-in-calls] resume-tts — nothing retained, ignoring');
          break;
        }
        const BACKUP_S = 0.4;
        const resumeAt = Math.max(0, interruptedTts.playedTo - BACKUP_S);
        console.log('[bots-in-calls] resume-tts — resuming at ' + resumeAt.toFixed(1) +
          's / ' + interruptedTts.buf.duration.toFixed(1) + 's (#350)');
        // #360: carry the chunk tag through the resume so a re-interruption
        // still reports an accurate (and now further-along) cut point.
        ttsQueue.push({ resumeBuf: interruptedTts.buf, offset: resumeAt, emoji: interruptedTts.emoji, utt: interruptedTts.utt, volume: interruptedTts.volume });
        interruptedTts = null;
        playNextTTS();
        break;
      }

      case 'play-speech-test': {
        if (!mic) mic = new VirtualMic();

        const ctx = mic.audioCtx;

        // Ensure AudioContext is running
        if (ctx.state !== 'running') {
          console.debug('[bots-in-calls] AudioContext state:', ctx.state, '— resuming');
          ctx.resume();
        }

        const url = payload?.url;
        if (!url) {
          console.error('[bots-in-calls] play-speech-test: no URL provided');
          break;
        }

        console.log('[bots-in-calls] Fetching speech audio:', url);
        (async () => {
          try {
            const resp = await fetch(url);
            if (!resp.ok) {
              console.error('[bots-in-calls] Fetch failed:', resp.status, resp.statusText);
              return;
            }
            const arrayBuf = await resp.arrayBuffer();
            console.debug('[bots-in-calls] Fetched', arrayBuf.byteLength, 'bytes, decoding...');

            const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
            console.debug('[bots-in-calls] Decoded: duration=' + audioBuf.duration.toFixed(2) + 's',
              'channels=' + audioBuf.numberOfChannels,
              'sampleRate=' + audioBuf.sampleRate);

            // Create source and connect to BOTH virtual mic AND local speakers
            const src = ctx.createBufferSource();
            src.buffer = audioBuf;

            // Route to virtual mic (what Meet hears)
            src.connect(mic.destination);

            media.emit('bot-speaking', { speaking: true });
            transcription.botSpeaking = true;
            src.onended = () => {
              media.emit('bot-speaking', { speaking: false });
              setTimeout(() => { transcription.botSpeaking = false; }, 1500);
              console.log('[bots-in-calls] Speech audio finished');
            };
            src.start();
            console.log('[bots-in-calls] Speech audio playing...');
          } catch (err) {
            console.error('[bots-in-calls] Speech audio error:', err);
            media.emit('bot-speaking', { speaking: false });
          }
        })();
        break;
      }

      case 'start-listening':
        transcription.startListening();
        break;

      case 'stop-listening':
        transcription.stopListening();
        break;

      case 'get-transcripts': {
        const recent = transcription.getRecentTranscripts(payload?.ms || 60000);
        window.postMessage({
          __botsInCalls: true,
          action: 'transcripts-response',
          payload: { transcripts: recent },
        }, '*');
        break;
      }

      case 'get-audio-status': {
        const participants = [];
        for (const [id, pa] of audioCaptureManager.participants) {
          const level = pa.getLevel();
          participants.push({
            id,
            speaking: pa.speaking,
            level,
            db: 20 * Math.log10(Math.max(level, 1e-10)),
            recording: pa.isRecording,
          });
        }
        window.postMessage({
          __botsInCalls: true,
          action: 'audio-status-response',
          payload: {
            participantCount: participants.length,
            connectionCount: audioCaptureManager.connectionCount,
            participants,
          },
        }, '*');
        break;
      }

      case 'play-test-tone': {
        if (!mic) mic = new VirtualMic();
        if (mic.audioCtx.state === 'suspended') mic.audioCtx.resume();

        const ctx = mic.audioCtx;
        const duration = (payload?.duration || 3);
        const now = ctx.currentTime;

        // Generate speech-like audio that won't be filtered by Meet's noise
        // suppression. Pure tones get cancelled; we need harmonics, frequency
        // variation, and amplitude modulation — characteristics of human voice.

        // Fundamental with vibrato (mimics vocal cord vibration)
        const fundamental = ctx.createOscillator();
        fundamental.type = 'sawtooth'; // rich harmonics like a voice
        fundamental.frequency.setValueAtTime(150, now); // ~male voice range
        // Add pitch variation (like natural speech intonation)
        fundamental.frequency.linearRampToValueAtTime(180, now + duration * 0.3);
        fundamental.frequency.linearRampToValueAtTime(140, now + duration * 0.6);
        fundamental.frequency.linearRampToValueAtTime(160, now + duration * 0.8);
        fundamental.frequency.linearRampToValueAtTime(120, now + duration);

        // Formant-like bandpass filters (simulate vocal tract resonances)
        const formant1 = ctx.createBiquadFilter();
        formant1.type = 'bandpass';
        formant1.frequency.value = 600;  // ~first formant
        formant1.Q.value = 5;

        const formant2 = ctx.createBiquadFilter();
        formant2.type = 'bandpass';
        formant2.frequency.value = 1200; // ~second formant
        formant2.Q.value = 5;

        // Amplitude envelope (speech-like: attack, sustain with variation, decay)
        const envelope = ctx.createGain();
        envelope.gain.setValueAtTime(0, now);
        envelope.gain.linearRampToValueAtTime(0.5, now + 0.05);
        // Simulate syllable-like amplitude variation
        for (let t = 0.1; t < duration - 0.2; t += 0.15) {
          const peak = 0.3 + Math.random() * 0.3;
          const dip = 0.1 + Math.random() * 0.1;
          envelope.gain.linearRampToValueAtTime(peak, now + t);
          envelope.gain.linearRampToValueAtTime(dip, now + t + 0.08);
        }
        envelope.gain.linearRampToValueAtTime(0, now + duration);

        // Low-frequency amplitude modulation (adds natural tremor)
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 5; // ~5 Hz tremor
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.15;
        lfo.connect(lfoGain);
        lfoGain.connect(envelope.gain);
        lfo.start(now);
        lfo.stop(now + duration);

        // Connect: fundamental → formants → envelope → destination
        // Split into two formant paths and merge
        const merge = ctx.createGain();
        merge.gain.value = 0.5;

        fundamental.connect(formant1);
        fundamental.connect(formant2);
        formant1.connect(merge);
        formant2.connect(merge);
        merge.connect(envelope);
        envelope.connect(mic.destination);

        fundamental.start(now);
        fundamental.stop(now + duration);

        // Animate avatar while playing
        media.emit('bot-speaking', { speaking: true });
        setTimeout(() => {
          media.emit('bot-speaking', { speaking: false });
        }, duration * 1000);

        console.debug('[bots-in-calls] Playing speech-like test tone for', duration, 'seconds');
        break;
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Audio Capture — hooks RTCPeerConnection to capture individual participant
  // audio streams for speech recognition.
  //
  // How it works:
  //   Meet creates one RTCPeerConnection per participant. Each connection fires
  //   'track' events when remote media arrives. We intercept these to capture
  //   individual audio tracks, analyze their levels, and extract audio data
  //   for speech-to-text processing.
  // ---------------------------------------------------------------------------

  class ParticipantAudio {
    constructor(id, track, stream, enableSTT = true) {
      this.id = id;
      this.track = track;
      this.stream = stream;
      this.enableSTT = enableSTT;
      this.speaking = false;
      this.lastSpeakingTime = 0;
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.3;
      this.levelData = new Float32Array(this.analyser.frequencyBinCount);

      // Connect the track to our analyser
      const source = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      source.connect(this.analyser);

      // Audio recording for STT
      this.recorder = null;
      this.audioChunks = [];
      this.isRecording = false;

      // Start level monitoring
      this._monitorLevel();

      console.debug('[bots-in-calls] ParticipantAudio created:', id);
    }

    _monitorLevel() {
      if (this.track.readyState === 'ended') return;

      this.analyser.getFloatTimeDomainData(this.levelData);

      // Calculate RMS level
      let sum = 0;
      for (let i = 0; i < this.levelData.length; i++) {
        sum += this.levelData[i] * this.levelData[i];
      }
      const rms = Math.sqrt(sum / this.levelData.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-10));

      // Speech detection threshold — set low for now to ensure speakingLog gets populated.
      // Tune upward once we see real per-participant levels in a multi-person call.
      // NOTE: this gates STT RECORDING. The turn-taking floor uses its own, much
      // louder threshold below — the two questions are different, and conflating
      // them is what made the floor fire on keystrokes.
      const wasSpeaking = this.speaking;
      this.speaking = db > -55;

      if (this.speaking) {
        this.lastSpeakingTime = Date.now();
      }

      // #115: publish the fast floor signal alongside the existing STT gating.
      //
      // Deliberately NOT this.speaking. The floor answers "is someone taking the
      // floor from the bot", which is a much stronger claim than "there is audio
      // worth transcribing", and it is acted on immediately — the rising edge is
      // instant by design, so one frame is enough to silence the bot.
      // #245: echo guard. The bot's own voice comes out of a participant's
      // SPEAKERS, back into their MICROPHONE, and arrives here on their stream —
      // measured 503ms behind our TTS, loud enough to clear -35dB easily, and
      // attributed to them, so nothing about the source tells us it is ours.
      // It made the bot yield to a human who had not spoken.
      //
      // Level alone cannot separate them: echo at speaker volume is as loud as
      // speech. What separates them is CORRELATION — echo tracks our output
      // envelope, a person does not. So a frame only counts as the far end
      // talking if OUR output is quiet in that moment. TTS has gaps at every
      // word and sentence boundary; someone genuinely talking over the bot is
      // loud during those gaps, and their echo is not.
      //
      // The cost is honest: barge-in is detected at the next gap in the bot's
      // speech rather than instantly, typically within a few hundred ms. That is
      // a far better trade than yielding to ourselves, which is indistinguishable
      // from the bot being interrupted by a ghost.
      let farEnd = db > FLOOR_SPEECH_DB;
      if (farEnd && ECHO_GUARD_ENABLED) {
        const own = (typeof mic !== 'undefined' && mic && mic.getAmplitude) ? mic.getAmplitude() : 0;
        if (own > SELF_LOUD_AMP) { farEnd = false; noteEchoSuppressed(); }
      }
      try { noteAudioLevel(farEnd); noteLevelSample(db); } catch { /* never break level monitoring */ }

      if (this.speaking && !wasSpeaking) {
        // Started/stopped speaking debug lines suppressed — too noisy in
        // the terminal log. Re-enable locally if debugging speech detection.
        this._startRecording();
      } else if (!this.speaking && wasSpeaking && (Date.now() - this.lastSpeakingTime > 1500)) {
        this._stopRecording();
      }

      // Continue monitoring
      requestAnimationFrame(() => this._monitorLevel());
    }

    _startRecording() {
      if (this.isRecording || !this.enableSTT) return;

      try {
        this.audioChunks = [];
        this.recorder = new MediaRecorder(new MediaStream([this.track]), {
          mimeType: 'audio/webm;codecs=opus',
        });

        this.recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            this.audioChunks.push(event.data);
          }
        };

        this.recorder.onstop = () => {
          if (this.audioChunks.length > 0) {
            const blob = new Blob(this.audioChunks, { type: 'audio/webm;codecs=opus' });
            this._processAudioBlob(blob);
          }
          this.isRecording = false;
        };

        this.recorder.start(500); // collect in 500ms chunks
        this.isRecording = true;
      } catch (err) {
        console.warn('[bots-in-calls] MediaRecorder error for', this.id, err.message);
      }
    }

    _stopRecording() {
      if (!this.isRecording || !this.recorder) return;
      try {
        this.recorder.stop();
      } catch (err) {
        // recorder may already be inactive
      }
    }

    _processAudioBlob(blob) {
      const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
      console.debug(`[bots-in-calls] Audio captured from ${this.id}: ${sizeMB} MB`);

      // Send to STT via content script → service worker
      this._sendToSTT(blob);
    }

    async _sendToSTT(blob) {
      try {
        // Convert blob to base64 for message passing
        const reader = new FileReader();
        const base64 = await new Promise((resolve, reject) => {
          reader.onload = () => {
            const dataUrl = reader.result;
            resolve(dataUrl.split(',')[1]); // strip "data:audio/webm;base64,"
          };
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        // Post to content script which forwards to service worker
        window.postMessage({
          __botsInCalls: true,
          action: 'transcribe-audio',
          payload: {
            audioBase64: base64,
            participantId: this.id,
            size: blob.size,
          },
        }, '*');
      } catch (err) {
        console.error('[bots-in-calls] Failed to encode audio for STT:', err);
      }
    }

    getLevel() {
      this.analyser.getFloatTimeDomainData(this.levelData);
      let sum = 0;
      for (let i = 0; i < this.levelData.length; i++) {
        sum += this.levelData[i] * this.levelData[i];
      }
      return Math.sqrt(sum / this.levelData.length);
    }

    destroy() {
      this._stopRecording();
      this.audioCtx.close();
    }
  }

  // ---------------------------------------------------------------------------
  // #115: audio-level floor signal.
  //
  // The turn-taking gates (barge-in, speak jitter) consume `anyoneSpeaking`,
  // which today comes from counting mutations on Meet's mic-meter DOM — 3
  // within a 1200ms window, so ~400-700ms after audio actually starts. The
  // analyser above already answers "is anyone making sound" every animation
  // frame (~16ms). This publishes that as a separate signal so the two can be
  // compared on a real call before anything switches over to it.
  //
  // Aggregate, not per-participant: Meet can send mixed audio, so attribution
  // from this path is unreliable — but the floor gate only asks "is ANYBODY
  // talking", which is exactly what an analyser answers well.
  //
  // Falling edge is held briefly: speech has gaps between words, and without
  // hysteresis this would chatter many times per second.
  // Stan's objection, and the real design constraint: Meet's mic meter is not a
  // slow proxy for "sound" — it's a slow proxy for "Meet's own VAD decided this
  // is SPEECH". Google applies noise suppression and voice-activity detection
  // before it animates that meter. A raw RMS analyser answers a different and
  // easier question: "is there any energy at all", which a keyboard, a fan or a
  // dog will answer yes to.
  //
  // So this is not purely a latency win — it trades Meet's noise judgement for
  // ~400ms. Whether that trade is affordable depends on how far the speech level
  // sits above the room noise level in practice, which nobody here has measured.
  // Hence the periodic stats line below: it reports the level DISTRIBUTION so a
  // real call answers the question with numbers instead of opinions.
  //
  // The current -55dB threshold is inherited from STT gating, where the comment
  // says it was "set low for now", and is very likely too permissive for this.
  // fastFloorDetection is ON anyway while the userbase is test users only —
  // the experiment needs real call data, and nobody runs with a non-default
  // preference. If a bot goes quiet mid-call, that is this: it thinks someone is
  // always talking. set_preference fastFloorDetection false is read live.
  const AUDIO_FLOOR_STATS_MS = 15000;
  let _levelSamples = [];
  let _lastLevelStatsAt = 0;

  function noteLevelSample(db) {
    if (Number.isFinite(db) && db > -200) _levelSamples.push(db);
    const now = Date.now();
    if (!_lastLevelStatsAt) { _lastLevelStatsAt = now; return; }
    if (now - _lastLevelStatsAt < AUDIO_FLOOR_STATS_MS || _levelSamples.length < 50) return;
    _lastLevelStatsAt = now;
    const a = _levelSamples.sort((x, y) => x - y);
    const at = (q) => a[Math.min(a.length - 1, Math.floor(q * a.length))].toFixed(1);
    // p10 approximates the room's noise floor; p95 approximates speech peaks.
    // A usable threshold needs daylight between them.
    window.postMessage({
      __botsInCalls: true,
      action: 'log',
      payload: { line: `[floor-levels] over ${(AUDIO_FLOOR_STATS_MS / 1000)}s, n=${a.length}: `
        + `p10 ${at(0.10)}dB (noise floor?) · p50 ${at(0.50)}dB · p90 ${at(0.90)}dB · p95 ${at(0.95)}dB (speech?) `
        + `· separation ${(at(0.95) - at(0.10)).toFixed(1)}dB` },
    }, '*');
    _levelSamples = [];
  }

  const AUDIO_FLOOR_RELEASE_MS = 350;

  // How loud something must be to take the floor from a speaking bot.
  //
  // 20dB above the STT gate (-55dB), and chosen from measurement rather than
  // taste. Across 1,501 level windows of real calls: the room noise floor never
  // reached -55dB (median -92dB), so ambient sound was never the problem — but
  // the rising edge is immediate, so one ~16ms frame over the line arms the
  // floor and holds it 350ms. A keystroke or chair creak clears -55dB easily,
  // and 26.5% of 3,820 measured busy periods lasted under 500ms: too short to be
  // anyone taking the floor, each one a bot going quiet for nothing.
  //
  // At -35dB, 94% of windows containing real speech still clear it, and no quiet
  // window does. That makes this an ESCAPE HATCH rather than a detector: normal
  // turn-taking rides the DOM mic-meter as before, and this is the fast path for
  // someone who audibly wants in. Erring loud is the right error — being slow to
  // yield costs a moment, yielding to a cough costs the bot its voice.
  //
  // NOT verified: that a keystroke stays under -35dB. The 15s percentiles this
  // was derived from smooth transients away. The number to watch is the count of
  // sub-500ms busy periods in [floor-audio]; if they persist, this is still too
  // low.
  const FLOOR_SPEECH_DB = -35;

  // #245: while our own output is above this, far-end audio is treated as echo.
  // 0.10 of the smoothed 0..1 TTS amplitude — comfortably above the noise in a
  // gap, comfortably below normal speech level, so the guard opens at every word
  // boundary rather than only between sentences.
  const SELF_LOUD_AMP = 0.10;
  const ECHO_GUARD_ENABLED = true;

  // #378: the SAME envelope, published to the renderer world.
  //
  // The DOM speaker tracker (google-meet-provider.js) has exactly the problem
  // this guard already solves for audio — a human on laptop speakers hears the
  // bot's own TTS, their mic picks it up, Meet animates THEIR speaking
  // indicator, and the tracker reads it as that person interrupting. It could
  // not defend itself because our TTS envelope lives here, in the page world,
  // and the tracker runs in the renderer.
  //
  // Published as a boolean crossing rather than a stream of amplitudes: the
  // consumer only ever asks "were we loud recently", and an edge plus a slow
  // refresh is two orders of magnitude less postMessage traffic than sampling.
  // The refresh matters — without it a dropped edge would strand the consumer
  // believing we are still talking, which would make it deaf rather than
  // merely cautious.
  const SELF_AUDIO_SAMPLE_MS = 50;
  const SELF_AUDIO_REFRESH_MS = 200;
  let _selfLoud = false;
  let _selfLastPublishAt = 0;
  setInterval(() => {
    let amp = 0;
    try { amp = (typeof mic !== 'undefined' && mic && mic.getAmplitude) ? mic.getAmplitude() : 0; }
    catch { return; }
    const loud = amp > SELF_LOUD_AMP;
    const now = Date.now();
    if (loud === _selfLoud && !(loud && now - _selfLastPublishAt >= SELF_AUDIO_REFRESH_MS)) return;
    _selfLoud = loud;
    _selfLastPublishAt = now;
    try {
      window.postMessage({ __botsInCalls: true, action: 'self-audio',
        payload: { loud, amp: Math.round(amp * 100) / 100, at: now } }, '*');
    } catch { /* page tearing down */ }
  }, SELF_AUDIO_SAMPLE_MS);

  // How often the guard actually fires, sampled rather than logged per frame
  // (this runs every animation frame). Without a number here we would be
  // guessing whether the guard is doing anything or quietly disabling barge-in.
  let _echoSuppressed = 0;
  let _echoLastLogAt = 0;
  function noteEchoSuppressed() {
    _echoSuppressed++;
    const now = Date.now();
    if (!_echoLastLogAt) { _echoLastLogAt = now; return; }
    if (now - _echoLastLogAt < 15000) return;
    window.postMessage({ __botsInCalls: true, action: 'log', payload: {
      line: `🔇 [echo-guard] suppressed ${_echoSuppressed} far-end frames in the last ${Math.round((now - _echoLastLogAt) / 1000)}s `
        + `(our own audio was playing — see #245)` } }, '*');
    _echoSuppressed = 0; _echoLastLogAt = now;
  }
  let _audioFloorBusy = false;
  let _audioFloorLastTrueAt = 0;
  let _audioFloorReleaseTimer = null;

  function publishAudioFloor(busy) {
    if (busy === _audioFloorBusy) return;
    _audioFloorBusy = busy;
    window.postMessage({
      __botsInCalls: true,
      action: 'audio-floor',
      payload: { speaking: busy, at: Date.now() },
    }, '*');
  }

  // Called from ParticipantAudio._monitorLevel on every frame.
  function noteAudioLevel(anySpeakingNow) {
    const now = Date.now();
    if (anySpeakingNow) {
      _audioFloorLastTrueAt = now;
      if (_audioFloorReleaseTimer) { clearTimeout(_audioFloorReleaseTimer); _audioFloorReleaseTimer = null; }
      publishAudioFloor(true);           // rising edge: immediate, that's the point
      return;
    }
    if (!_audioFloorBusy || _audioFloorReleaseTimer) return;
    const wait = Math.max(0, AUDIO_FLOOR_RELEASE_MS - (now - _audioFloorLastTrueAt));
    _audioFloorReleaseTimer = setTimeout(() => {
      _audioFloorReleaseTimer = null;
      if (Date.now() - _audioFloorLastTrueAt >= AUDIO_FLOOR_RELEASE_MS) publishAudioFloor(false);
    }, wait);
  }

  // ---------------------------------------------------------------------------
  // AudioCaptureManager — tracks all participant audio streams
  // ---------------------------------------------------------------------------

  class AudioCaptureManager {
    constructor() {
      this.participants = new Map(); // id → ParticipantAudio
      this.connectionCount = 0;
      this._hookRTCPeerConnection();
      this._startStatusReporting();
    }

    _hookRTCPeerConnection() {
      const self = this;
      const _RTCPeerConnection = window.RTCPeerConnection;

      // Keep the NATIVE constructor reachable. Anything in this page that opens
      // its own peer connection (the realtime voice session below) must use
      // this one, or the hook we are about to install files the bot's own voice
      // as a call participant and feeds it into recording and STT.
      window.__vibeconfNativeRTCPeerConnection = _RTCPeerConnection;

      // We need to create a proper subclass to preserve instanceof checks
      // that Meet's code may rely on
      window.RTCPeerConnection = function (...args) {
        const pc = new _RTCPeerConnection(...args);
        self.connectionCount++;
        const connId = `conn-${self.connectionCount}`;

        console.debug(`[bots-in-calls] RTCPeerConnection created: ${connId}`);

        // Intercept remote tracks (audio from other participants)
        pc.addEventListener('track', (event) => {
          const { track, streams } = event;

          if (track.kind === 'audio') {
            const participantId = `participant-${self.participants.size + 1}`;
            console.debug(`[bots-in-calls] Remote audio track received:`,
              `${participantId} via ${connId}`,
              `(readyState=${track.readyState}, label=${track.label})`);

            // Only create ParticipantAudio for the first audio track.
            // In 2-person calls, all tracks carry the same mixed audio.
            // Transcribing multiple tracks wastes STT API calls.
            const enableSTT = self.participants.size === 0;
            const pa = new ParticipantAudio(
              participantId,
              track,
              streams[0] || new MediaStream([track]),
              enableSTT
            );
            self.participants.set(participantId, pa);

            // Clean up when track ends
            track.addEventListener('ended', () => {
              console.debug(`[bots-in-calls] Audio track ended for ${participantId}`);
              pa.destroy();
              self.participants.delete(participantId);
            });
          }

          if (track.kind === 'video') {
            console.debug(`[bots-in-calls] Remote video track received via ${connId}`);
          }
        });

        // Log connection state changes
        pc.addEventListener('connectionstatechange', () => {
          console.debug(`[bots-in-calls] ${connId} state: ${pc.connectionState}`);
        });

        return pc;
      };

      // Preserve prototype chain so instanceof checks work
      window.RTCPeerConnection.prototype = _RTCPeerConnection.prototype;
      window.RTCPeerConnection.prototype.constructor = window.RTCPeerConnection;

      // Copy static properties
      Object.keys(_RTCPeerConnection).forEach((key) => {
        try {
          window.RTCPeerConnection[key] = _RTCPeerConnection[key];
        } catch (e) {
          // Some properties may not be writable
        }
      });

      // Also handle webkitRTCPeerConnection if present
      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = window.RTCPeerConnection;
      }

      console.debug('[bots-in-calls] RTCPeerConnection hooked for audio capture');
    }

    _startStatusReporting() {
      // Periodically report audio capture status
      setInterval(() => {
        if (this.participants.size === 0) return;

        const status = [];
        for (const [id, pa] of this.participants) {
          const level = pa.getLevel();
          const db = 20 * Math.log10(Math.max(level, 1e-10));
          status.push(`${id}: ${db.toFixed(0)}dB ${pa.speaking ? '🔊' : '🔇'}`);
        }

        // Audio level dB output left out — too noisy in the terminal log.
        // Re-enable locally if debugging speech detection.

        // Report to extension
        const participantStatus = [];
        for (const [id, pa] of this.participants) {
          participantStatus.push({
            id,
            speaking: pa.speaking,
            level: pa.getLevel(),
          });
        }

        window.postMessage({
          __botsInCalls: true,
          action: 'audio-status',
          payload: { participants: participantStatus },
        }, '*');
      }, 3000);
    }

    getParticipants() {
      return Array.from(this.participants.values());
    }

    getSpeakingParticipants() {
      return this.getParticipants().filter((p) => p.speaking);
    }
  }

  // Audio capture hooks window.RTCPeerConnection to capture per-participant
  // audio for STT. It's VESTIGIAL — Meet and Slack both use DOM captions for the
  // transcript now — and the Meet-shaped hook BREAKS Slack/Chime's WebRTC (it
  // replaces RTCPeerConnection without preserving statics / instanceof). Gate it
  // off via window.__vibeconf_disableAudioCapture (set by preload-slack-main); a
  // stub keeps the status handlers working. Default: enabled (Meet unchanged).
  const audioCaptureManager = window.__vibeconf_disableAudioCapture
    ? { participants: new Map(), connectionCount: 0 } // stub — NO RTCPeerConnection hook
    : new AudioCaptureManager();

  // Expose for debugging from console
  window.__botsInCallsAudioCapture = audioCaptureManager;

  // ---------------------------------------------------------------------------
  // CallRecorder (#209) — per-track call audio to disk, for debugging.
  //
  // Records the bot's OWN outgoing audio (its TTS mic) and every remote WebRTC
  // track the AudioCaptureManager holds, each with its own MediaRecorder, and
  // streams the webm/opus chunks to main (call-recorder.js appends one file per
  // track + a manifest). Each "remote-*" is a separate WebRTC track, but NOT one
  // track per person: on 2026-08-17 one participant's voice was confirmed by ear
  // on two different remote-* tracks, and four participants arrived on three
  // tracks. Meet forwards speakers into a small pool of slots and reassigns them
  // mid-call, so a track is "audio from somebody". They're labeled by arrival
  // order; Meet can also emit extra/initially-silent tracks.
  //
  // Dormant until main sends 'start-recording' (gated on the recordCallAudio
  // pref / VIBECONF_RECORD_CALL). The poll re-attaches: the bot mic may not
  // exist at start, and a participant can join after.
  // ---------------------------------------------------------------------------
  const callRecorder = (() => {
    const TIMESLICE_MS = 1000;
    const recorders = new Map(); // trackName -> { rec, track, seq, paId }
    const votes = new Map();     // trackName -> { name: count }  (#209 attribution)
    const bestName = new Map();  // trackName -> current best name
    let recording = false;
    let pollTimer = null;
    let selfName = null;         // the bot's OWN name — never attribute it to a remote

    const post = (action, payload) =>
      window.postMessage({ __botsInCalls: true, action, payload }, '*');

    // Attribution: the DOMSpeakerTracker (provider) posts 'speaker-active' with
    // the REAL participant name when Meet's people-pane shows them speaking. When
    // exactly one recorded remote track is making sound at that moment, that
    // track is that speaker — vote it. Requiring a sole speaker keeps OVERLAP
    // from mis-attributing.
    //
    // It does NOT survive Meet reassigning a slot mid-call, which we have since
    // confirmed happens (2026-08-17: one voice heard by ear on two tracks). Every
    // vote may be individually correct and the winner still wrong for most of the
    // call, because this collapses the whole call to one name. The votes are
    // honest; the single winner is the lie. Time-segmented attribution is the
    // real fix — until then, speaker-events.jsonl is the source of truth for who
    // spoke when, and this name is a hint at best.
    function voteFromDom(name) {
      if (!recording || !name || name === selfName) return; // never attribute the bot's own voice
      const active = [];
      for (const [tname, st] of recorders) {
        if (!st.paId) continue; // the bot's own track has no participant id
        const pa = audioCaptureManager.participants.get(st.paId);
        if (pa && pa.speaking) active.push(tname);
      }
      if (active.length !== 1) return; // ambiguous — need a sole speaker
      const t = active[0];
      let tally = votes.get(t);
      if (!tally) { tally = {}; votes.set(t, tally); }
      tally[name] = (tally[name] || 0) + 1;
      let best = null, max = 0;
      for (const nm in tally) { if (tally[nm] > max) { max = tally[nm]; best = nm; } }
      if (best && bestName.get(t) !== best) {
        bestName.set(t, best);
        post('record-name', { track: t, name: best });
      }
    }

    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data?.__botsInCalls) return;
      if (event.data.action === 'speaker-active') {
        const { name, speaking, at } = event.data.payload || {};
        if (!name) return;
        // Persist the speaker timeline (start AND stop) to disk alongside the
        // audio: Meet mixes participants into shared slots, so the tracks alone
        // don't say who spoke when — but this DOM-derived, wall-clock-stamped
        // log does, and merge-call-audio.mjs turns it into who-spoke-when
        // annotations over the merged call audio (#209).
        if (recording) post('record-speaker-event', { name, speaking: !!speaking, at: at || Date.now() });
        if (speaking) voteFromDom(name);
      }
    });

    function pickMime() {
      for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
        try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch { /* old engine */ }
      }
      return 'audio/webm';
    }

    function recordTrack(name, track, paId = null) {
      if (!recording || !track || track.readyState === 'ended' || recorders.has(name)) return;
      const mime = pickMime();
      let rec;
      try {
        rec = new MediaRecorder(new MediaStream([track]), { mimeType: mime });
      } catch (err) {
        post('log', { line: `[call-record] cannot record ${name}: ${err.message}` });
        return;
      }
      const state = { rec, track, seq: 0, paId, startWallClock: 0 };
      recorders.set(name, state);
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result).split(',')[1];
          // startWallClock: wall-clock ms at the instant this track's recorder
          // started, i.e. the t=0 of its webm timeline. Captured HERE in the
          // renderer (not on chunk arrival at main) so a sample at internal time
          // t maps to an absolute wall clock of startWallClock + t — the anchor
          // that aligns audio with the transcript's Date.now() stamps (#209).
          if (b64) post('record-chunk', { track: name, seq: state.seq++, mime, dataBase64: b64, startWallClock: state.startWallClock });
        };
        reader.readAsDataURL(e.data);
      };
      track.addEventListener('ended', () => stopTrack(name));
      // Stamp the wall clock immediately before start() — this is the track
      // timeline's true origin, on the same clock as every other call event.
      try { state.startWallClock = Date.now(); rec.start(TIMESLICE_MS); }
      catch (err) { post('log', { line: `[call-record] start failed ${name}: ${err.message}` }); }
    }

    function stopTrack(name) {
      const s = recorders.get(name);
      if (!s) return;
      try { if (s.rec.state !== 'inactive') s.rec.stop(); } catch { /* already inactive */ }
      recorders.delete(name);
    }

    let lastShareId = null, shareCount = 0;
    // Media-element tracks (#814): track id -> stable name, so a re-poll finds
    // the same recorder and a NEW track (a slot re-created) gets a new file.
    const mediaTrackNames = new Map();
    let mediaTrackCount = 0;
    function attachAll() {
      if (!recording) return;
      try {
        const bot = window.__vibeMicTrack && window.__vibeMicTrack();
        if (bot) recordTrack('bot', bot);
      } catch { /* bot mic not up yet — poll retries */ }
      try {
        for (const [id, pa] of audioCaptureManager.participants) {
          if (pa && pa.track) recordTrack(`remote-${id}`, pa.track, id);
        }
      } catch { /* manager is a stub (Slack) — nothing to attach */ }
      // Providers without the RTCPeerConnection hook (Slack, Zoom, Teams: it's
      // disabled there because it breaks their WebRTC) — record the remote
      // audio the page itself is playing instead: every live audio track on an
      // <audio>/<video> element's srcObject (#814). Measured live 2026-10-15:
      // Zoom plays remote audio through 3 <audio> elements (speaker slots, like
      // Meet's pool); Teams through 1 (a server-mixed "mainAudio" track). Only
      // when the hook is off, so Meet never records the same audio twice.
      if (window.__vibeconf_disableAudioCapture) {
        try {
          for (const el of document.querySelectorAll('audio, video')) {
            const src = el.srcObject;
            if (!src || typeof src.getAudioTracks !== 'function') continue;
            for (const t of src.getAudioTracks()) {
              if (t.readyState !== 'live') continue;
              const key = mediaTrackNames.get(t.id) || `remote-media-${++mediaTrackCount}`;
              mediaTrackNames.set(t.id, key);
              recordTrack(key, t);
            }
          }
        } catch { /* DOM not ready — poll retries */ }
      }
      for (const t of outputTapTracks()) {
        const key = mediaTrackNames.get(t.id) || `remote-media-${++mediaTrackCount}`;
        mediaTrackNames.set(t.id, key);
        recordTrack(key, t);
      }
      // The shared tab/screen's own audio, when a share is live. A fresh id means
      // a new share session (they come and go mid-call) → a new track name, so
      // separate shares land in separate files instead of concatenating into one.
      //
      // Named 'share-audio', NOT 'share': call-recording-window.js already claims
      // the bare 'share' name for the shared surface's VIDEO capture (#288, which
      // landed after this was written). CallRecordingSession keys tracks by name
      // and opens one fd per name, so reusing 'share' would append two unrelated
      // webm byte streams into a single share.webm — a corrupt file, plus whichever
      // stream registered first would decide the per-kind byte cap for both.
      try {
        const share = window.__vibeShareTrack && window.__vibeShareTrack();
        if (share) {
          if (share.id !== lastShareId) { lastShareId = share.id; shareCount++; }
          recordTrack(shareCount === 1 ? 'share-audio' : `share-audio-${shareCount}`, share);
        }
      } catch { /* no share / not exposed — nothing to attach */ }
    }

    return {
      start(meta) {
        if (recording) return;
        recording = true;
        selfName = (meta && meta.botName) || null;
        post('record-started', { ...(meta || {}), at: Date.now() });
        attachAll();
        pollTimer = setInterval(attachAll, 1500);
      },
      stop() {
        if (!recording) return;
        recording = false;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        for (const name of [...recorders.keys()]) stopTrack(name);
        post('record-stopped', { at: Date.now() });
      },
    };
  })();

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.__botsInCalls) return;
    if (event.data.action === 'start-recording') {
      callRecorder.start(event.data.payload || {});
      media.emit('recording', { on: true });
    } else if (event.data.action === 'stop-recording') {
      callRecorder.stop();
      media.emit('recording', { on: false });
    }
  });

  // ---------------------------------------------------------------------------
  // SpeakerAttributedTranscription — combines Web Speech API (global STT)
  // with per-participant audio levels to attribute who said what.
  //
  // The Web Speech API only listens to the default microphone, so we can't
  // do per-participant STT with it. But we CAN:
  //   1. Track which participants are speaking at each moment (via audio levels)
  //   2. Run the Web Speech API on the mixed audio (what the bot "hears")
  //   3. Correlate transcripts with speaking timestamps to attribute speakers
  //
  // This is a heuristic — it won't be perfect, especially with overlapping
  // speech. But it's a solid POC without needing external STT APIs.
  //
  // For production, each participant's audio would be sent individually to
  // an STT API (Whisper, Deepgram, etc.) using the MediaRecorder blobs from
  // ParticipantAudio above.
  // ---------------------------------------------------------------------------

  class SpeakerAttributedTranscription {
    constructor(captureManager) {
      this.captureManager = captureManager;
      this.speakingLog = []; // [{timestamp, name, source}]
      this.transcripts = []; // [{timestamp, text, speaker}]
      this.recognition = null;
      this.isListening = false;
      this.botSpeaking = false; // true while bot TTS is playing
      this._maxLogEntries = 1000;

      // Track speakers from two sources:
      // 1. Audio level analysis (from RTCPeerConnection hook)
      // 2. DOM observation (from Meet's People pane — preferred, has real names)
      this._startSpeakerTracking();
      this._listenForDOMSpeakerEvents();
    }

    _startSpeakerTracking() {
      // Audio-level based tracking (fallback)
      setInterval(() => {
        const now = Date.now();
        for (const [id, pa] of this.captureManager.participants) {
          if (pa.speaking) {
            this.speakingLog.push({
              timestamp: now,
              name: id, // e.g. "participant-1"
              source: 'audio',
            });
          }
        }

        // Trim log
        if (this.speakingLog.length > this._maxLogEntries) {
          this.speakingLog = this.speakingLog.slice(-this._maxLogEntries);
        }
      }, 200);
    }

    _listenForDOMSpeakerEvents() {
      // Listen for DOM-based speaker events from the content script
      window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data?.__botsInCalls) return;
        if (event.data.action !== 'dom-speaker-change') return;

        const { name, speaking, timestamp } = event.data.payload;
        if (speaking) {
          // Log with the real participant name
          this.speakingLog.push({
            timestamp,
            name, // real name like "Stan James"
            source: 'dom',
          });
          console.debug(`[bots-in-calls] DOM speaker event: ${name} speaking`);
        }
      });
    }

    // Look up who was most likely speaking during a time window.
    // Prefers DOM-sourced entries (real names) over audio-level entries.
    _attributeSpeaker(startTime, endTime) {
      const relevantEntries = this.speakingLog.filter(
        (e) => e.timestamp >= startTime && e.timestamp <= endTime
      );

      if (relevantEntries.length === 0) return 'unknown';

      // Prefer DOM-sourced entries (they have real names)
      const domEntries = relevantEntries.filter((e) => e.source === 'dom');
      const entriesToUse = domEntries.length > 0 ? domEntries : relevantEntries;

      // Count speaking samples per participant name
      const counts = {};
      for (const entry of entriesToUse) {
        counts[entry.name] = (counts[entry.name] || 0) + 1;
      }

      // Return the participant with the most speaking samples
      let maxCount = 0;
      let speaker = 'unknown';
      for (const [name, count] of Object.entries(counts)) {
        if (count > maxCount) {
          maxCount = count;
          speaker = name;
        }
      }

      return speaker;
    }

    // Start listening for speech via Web Speech API
    // NOTE: This listens to whatever audio the browser tab is playing,
    // which in a Meet call is the mixed audio of all participants.
    // It won't work if the bot's tab doesn't have audio playing through
    // the speakers. For testing, it may need to be run from the main
    // profile's tab where participants' audio is audible.
    startListening() {
      if (this.isListening) return;

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        console.warn('[bots-in-calls] SpeechRecognition API not available');
        return;
      }

      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      let currentSegmentStart = Date.now();

      this.recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript.trim();

          if (result.isFinal && text) {
            const now = Date.now();

            // Suppress transcription while bot is speaking — Web Speech API
            // picks up the bot's TTS output from system audio
            if (this.botSpeaking) {
              console.debug('[bots-in-calls] Suppressing transcript during bot speech:', text.slice(0, 30));
              currentSegmentStart = now;
              continue;
            }

            const speaker = this._attributeSpeaker(currentSegmentStart, now);

            const transcript = {
              timestamp: now,
              text,
              speaker,
              confidence: result[0].confidence,
            };

            this.transcripts.push(transcript);
            console.log(`[bots-in-calls] TRANSCRIPT [${speaker}]: "${text}" (confidence: ${(result[0].confidence * 100).toFixed(0)}%)`);

            // Notify extension
            window.postMessage({
              __botsInCalls: true,
              action: 'transcript',
              payload: transcript,
            }, '*');

            currentSegmentStart = now;
          }
        }
      };

      this.recognition.onerror = (event) => {
        console.warn('[bots-in-calls] Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          console.warn('[bots-in-calls] Microphone access denied for speech recognition');
        }
      };

      this.recognition.onend = () => {
        // Auto-restart if we're still supposed to be listening
        if (this.isListening) {
          console.debug('[bots-in-calls] Speech recognition restarting...');
          setTimeout(() => {
            try { this.recognition.start(); } catch (e) { /* already started */ }
          }, 500);
        }
      };

      try {
        this.recognition.start();
        this.isListening = true;
        console.log('[bots-in-calls] Speech recognition started (speaker-attributed mode)');
      } catch (err) {
        console.error('[bots-in-calls] Failed to start speech recognition:', err);
      }
    }

    stopListening() {
      this.isListening = false;
      if (this.recognition) {
        this.recognition.stop();
      }
      console.debug('[bots-in-calls] Speech recognition stopped');
    }

    getTranscripts() {
      return this.transcripts;
    }

    getRecentTranscripts(ms = 60000) {
      const cutoff = Date.now() - ms;
      return this.transcripts.filter((t) => t.timestamp > cutoff);
    }
  }

  // ---------------------------------------------------------------------------
  // Speech-to-text tap (#850 phase 2): the call's REMOTE audio as 16 kHz mono
  // PCM, streamed to main, where AudioTranscription (caption-source.js) gates it
  // for speech and runs the on-device engine. This is how the bot hears a call
  // that has no captions of its own (calling apps, #843), and how it can be
  // compared against captions on a call that does.
  //
  // Same two places the recorder finds remote audio: the RTCPeerConnection hook
  // (Meet), or, where that hook is off (Slack/Zoom/Teams/calling apps), every
  // live audio track on an <audio>/<video> element's srcObject. The bot's own
  // voice is in neither, so the transcript never contains the bot.
  //
  // ScriptProcessorNode, not an AudioWorklet: a worklet loads from a module URL
  // (blob:/data:), which a call client's Content-Security-Policy can refuse, and
  // a processor needs nothing loaded. A 16 kHz AudioContext does the resampling.
  // Each chunk: 4096 samples (256 ms) as Int16, posted as 'stt-audio' and
  // forwarded to main by the provider preload (preload-stt-bridge.js).
  // Dormant until main sends 'start-stt-tap'.
  // ---------------------------------------------------------------------------
  // Live tracks a provider preload copied off the page's audio output (see the
  // sttTap and the recorder, which both read them).
  function outputTapTracks() {
    try {
      return (window.__vibeconf_outputTapTracks || []).filter((t) => t && t.readyState === 'live');
    } catch { return []; }
  }

  const sttTap = (() => {
    const RATE = 16000;
    const FRAME = 4096;
    let on = false, ctx = null, sink = null, timer = null;
    const taps = new Map(); // track.id -> { name, src, proc, track }
    let mediaCount = 0;
    const post = (payload) => window.postMessage({ __botsInCalls: true, action: 'stt-audio', payload }, '*');

    function remoteTracks() {
      const out = [];
      try {
        for (const [id, pa] of audioCaptureManager.participants) {
          if (pa && pa.track && pa.track.readyState === 'live') out.push({ track: pa.track, hint: `remote-${id}` });
        }
      } catch { /* stub manager */ }
      if (window.__vibeconf_disableAudioCapture) {
        try {
          for (const el of document.querySelectorAll('audio, video')) {
            const src = el.srcObject;
            if (!src || typeof src.getAudioTracks !== 'function') continue;
            for (const t of src.getAudioTracks()) if (t.readyState === 'live') out.push({ track: t, hint: null });
          }
        } catch { /* DOM not ready */ }
      }
      // Providers whose call audio never becomes a track or a media element
      // (WhatsApp plays it from a WASM engine through an AudioWorklet) publish
      // a copy of it here; see preload-whatsapp.js.
      for (const t of outputTapTracks()) out.push({ track: t, hint: null });
      return out;
    }

    function attach(track, hint) {
      if (taps.has(track.id)) return;
      const name = hint || `remote-media-${++mediaCount}`;
      try {
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        const proc = ctx.createScriptProcessor(FRAME, 1, 1);
        proc.onaudioprocess = (e) => {
          if (!on) return;
          const f = e.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) {
            const v = f[i] < -1 ? -1 : f[i] > 1 ? 1 : f[i];
            pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
          }
          post({ stream: name, rate: RATE, at: Date.now(), pcm });
        };
        src.connect(proc);
        proc.connect(sink); // a processor only runs while connected; sink is silent
        taps.set(track.id, { name, src, proc, track });
        track.addEventListener('ended', () => detach(track.id));
        post({ stream: name, rate: RATE, at: Date.now(), event: 'attached' });
      } catch (err) {
        console.warn('[bots-in-calls] stt tap: cannot attach', name, err && err.message);
      }
    }

    function detach(id) {
      const t = taps.get(id);
      if (!t) return;
      try { t.proc.onaudioprocess = null; t.src.disconnect(); t.proc.disconnect(); } catch { /* gone */ }
      taps.delete(id);
      post({ stream: t.name, rate: RATE, at: Date.now(), event: 'detached' });
    }

    function poll() { for (const { track, hint } of remoteTracks()) attach(track, hint); }

    return {
      start() {
        if (on) return;
        on = true;
        try {
          ctx = ctx || new AudioContext({ sampleRate: RATE });
          if (!sink) { sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination); }
          ctx.resume().catch(() => {});
        } catch (err) { console.warn('[bots-in-calls] stt tap: no AudioContext', err && err.message); on = false; return; }
        poll();
        timer = setInterval(poll, 1500);
        console.log('[bots-in-calls] stt tap started');
      },
      stop() {
        if (!on) return;
        on = false;
        if (timer) { clearInterval(timer); timer = null; }
        for (const id of [...taps.keys()]) detach(id);
        console.log('[bots-in-calls] stt tap stopped');
      },
    };
  })();
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.__botsInCalls) return;
    if (event.data.action === 'start-stt-tap') sttTap.start();
    else if (event.data.action === 'stop-stt-tap') sttTap.stop();
  });

  // Initialize transcription (Web Speech STT; don't start until requested). Also
  // skipped when capture is disabled (Slack uses DOM captions) — a stub keeps the
  // botSpeaking suppression + start/stop/get calls working as no-ops, so the TTS
  // (speak) path doesn't depend on it.
  const transcription = window.__vibeconf_disableAudioCapture
    ? { botSpeaking: false, startListening() {}, stopListening() {}, getRecentTranscripts() { return []; } }
    : new SpeakerAttributedTranscription(audioCaptureManager);
  window.__botsInCallsTranscription = transcription;

  // ---------------------------------------------------------------------------

  // Signal readiness back through the bridge
  window.postMessage({ __botsInCalls: true, action: 'ready' }, '*');
  console.debug('[bots-in-calls] Page script loaded — getUserMedia patched, RTCPeerConnection hooked');

})();
