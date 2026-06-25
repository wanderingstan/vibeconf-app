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
  // VirtualCamera — renders a bot avatar to a <canvas> and exposes a MediaStream
  // ---------------------------------------------------------------------------

  class VirtualCamera {
    // Two-layer emoji system:
    //   MODE_EMOJIS — persistent user-controlled behavior (shown at rest)
    //   ACTIVITY_EMOJIS — transient activity (overrides mode when thinking/speaking)
    static MODE_EMOJIS = {
      active: '\u{1F642}',   // 🙂 engaged, responds freely
      passive: '\u{1F910}',  // 🤐 zipper-mouth — listening, lips sealed unless name called
      silent: '\u{1F636}',   // 😶 no mouth — will act but cannot speak
    };

    static ACTIVITY_EMOJIS = {
      thinking: '\u{1F914}', // 🤔 thinking face
      speaking: '\u{1F604}', // 😄 grinning face — open mouth fits TTS playback
      yielding: '\u{1F64B}', // 🙋 wants to speak, yielding to the room
    };

    // Override emojis whenever the bot isn't in the call. Anything other than
    // 'in-call' means the agent isn't actually on the line — show 🫥.
    static CALL_STATUS_EMOJIS = {
      'idle':                   '\u{1FAE5}',  // 🫥 no call yet
      'joining':                '\u{1FAE5}',  // 🫥 connecting to Meet
      'waiting-to-be-admitted': '\u{1FAE5}',  // 🫥 waiting on host to admit
      'left':                   '\u{1FAE5}',  // 🫥 call ended
    };

    // Shown when in-call but no agent is actively listening (no waiter).
    // The 'listening' state uses MODE_EMOJIS instead.
    static IDLE_EMOJI = '\u{1F614}'; // 😔 pensive face

    // Shown briefly while someone in the call is speaking — visual ack that
    // the bot heard them. Suppressed in silent mode (the bot is meant to
    // be a fly on the wall there).
    static HEARING_EMOJI = '\u{1F610}'; // 😐 neutral face

    constructor(width, height) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width || config.canvasWidth;
      this.canvas.height = height || config.canvasHeight;
      this.ctx = this.canvas.getContext('2d');
      this.frameCount = 0;
      this.speaking = false;
      // Seed persistent state from the module-level avatarState, NOT hardcoded
      // defaults. A camera can be created mid-call — e.g. turning the camera on
      // makes the host page re-acquire the video stream, spawning a fresh
      // VirtualCamera — and state messages are only pushed on CHANGE, so a fresh
      // camera that defaulted to idle/🫥 would never learn it's in-call+engaged
      // and would sit on 🫥 while the bot is actually talking. avatarState holds
      // the last known values so a new camera picks up where the call is.
      this.state = avatarState.state;   // 'idle' | 'listening' | 'thinking' | 'speaking' | 'yielding'
      this.mode = avatarState.mode;     // 'active' | 'passive' | 'silent'
      this.callStatus = avatarState.callStatus; // 'idle' | 'joining' | 'waiting-to-be-admitted' | 'in-call' | 'left'
      // True once the agent has done anything besides idle. Stays 🫥 until then,
      // since "in-call but agent not yet engaged" still means not on the line.
      // Resets whenever a new call begins.
      this.hasEngaged = avatarState.hasEngaged;
      // True while at least one participant is currently speaking (from
      // DOMSpeakerTracker). Suppressed when mode='silent'.
      this.anyoneSpeaking = false;
      // When the floor last went quiet. Drives the post-speech grace window
      // (see HEARING_GRACE_MS in the emoji waterfall).
      this.lastAnyoneSpeakingFalseAt = 0;
      // Deaf flag — set from the scraper's CC-button watcher via 'set-deaf'.
      // When true (and we're in-call), the avatar shows 🙉 so participants in
      // the Meet itself see that the bot can't hear them and can re-enable
      // captions. Takes priority over everything except the not-on-line emoji.
      this.deaf = avatarState.deaf;
      // Per-response speaking emoji (set by speak's emoji param). Cleared
      // when the TTS queue drains. Falls through to ACTIVITY_EMOJIS.speaking.
      this.speakingEmojiOverride = null;
      // Debug overlay — when enabled (panel checkbox only, never agent-set),
      // renders a corner panel showing the same internal state visible in
      // the troubleshooting screen. Lets a non-technical user diagnose
      // problems just by looking at the bot's tile in Meet.
      this.debugOverlayEnabled = debugOverlayEnabledGlobal;
      this.debugInfo = debugInfoLatest;
      // Persistent overrides from agent's set_avatar_emoji calls. null = use
      // default for that state. Seeded from avatarState so a camera created
      // mid-call keeps the configured emoji instead of reverting to defaults.
      this.idleEmojiOverride = avatarState.idleEmojiOverride;
      this.listeningEmojiOverride = avatarState.listeningEmojiOverride;
      this.yieldingEmojiOverride = avatarState.yieldingEmojiOverride;
      // Optional custom background. null = use default animated gradient.
      // Set by the 'set-avatar-background' message after server-side resolve.
      this.backgroundImage = avatarState.backgroundImage;
      this.stopped = false;

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

    _render() {
      const { canvas, ctx } = this;
      const w = canvas.width;
      const h = canvas.height;
      this.frameCount++;

      // --- Background: custom SVG (if loaded) or animated gradient fallback ---
      const t = this.frameCount * 0.02;
      if (this.backgroundImage && this.backgroundImage.complete && this.backgroundImage.naturalWidth > 0) {
        // Cover-fit the SVG to the canvas. The rasterized image already has
        // any external refs inlined (server-side resolver), so no taint risk.
        ctx.drawImage(this.backgroundImage, 0, 0, w, h);
      } else {
        // Default animated gradient — bright enough to avoid Chrome's
        // "camera blocked" heuristic, with subtle particle motion.
        const grad = ctx.createLinearGradient(
          w * (0.3 + 0.2 * Math.sin(t)),
          0,
          w * (0.7 + 0.2 * Math.cos(t)),
          h
        );
        grad.addColorStop(0, '#1a237e');
        grad.addColorStop(0.5, '#283593');
        grad.addColorStop(1, '#1565c0');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        ctx.save();
        ctx.globalAlpha = 0.15;
        for (let i = 0; i < 12; i++) {
          const px = (w * 0.1) + (i * w * 0.08) + Math.sin(t + i * 1.5) * 30;
          const py = (h * 0.2) + Math.cos(t * 0.7 + i * 2.1) * (h * 0.3);
          const pr = 20 + Math.sin(t + i) * 10;
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }
        ctx.restore();
      }

      const cx = w / 2;
      const cy = h / 2;

      // Emoji priority:
      //   1. Not in call (any callStatus other than 'in-call') → 🫥
      //   2. In-call but agent has never engaged yet → 🫥 (still loading)
      //   3. Activity state thinking → 🤔. Wins over audioPlaying so the ack
      //      TTS ("Got it.", "Let me think about that.") stays under the
      //      thinking face — without this the avatar flickers 🤔 → 😄 → 🤔
      //      → 😄 (ack-audio → ack-done → real-thinking → real-speaking),
      //      which reads as "done? oh wait still thinking? speaking now"
      //      instead of one continuous "responding."
      //   4. Activity state yielding → 🙋 (has something to say, deferring)
      //   5. Audio is playing (this.speaking) and state isn't 'thinking' →
      //      😄. Covers the real response (state='speaking') and any TTS
      //      that runs outside the response loop.
      //   6. Someone in the call is speaking → 😐 (acks "I heard you").
      //      Skipped in silent mode and during own activity.
      //   7. botState=idle between turns → 😔
      //   8. botState=listening → mode emoji (🙂 / 🤐 / 😶)
      const notOnLine = VirtualCamera.CALL_STATUS_EMOJIS[this.callStatus] || (!this.hasEngaged ? '\u{1FAE5}' : null);
      // Audio playing: per-response override > default 😄. Cleared on tts-ended.
      // Suppressed when state === 'thinking' so the ack stays under 🤔.
      const audioPlaying = (this.speaking && this.state !== 'thinking')
        ? (this.speakingEmojiOverride || VirtualCamera.ACTIVITY_EMOJIS.speaking)
        : null;
      // Post-speech grace: hold 😐 for ~2.5s after the floor goes quiet, so
      // the avatar doesn't flicker to 🙂 in the silence-threshold gap before
      // botState transitions to 'thinking'. Window is renderer-side only
      // (server's silence threshold is a pref we don't sync here); 2500ms
      // matches the typical default and degrades gracefully if the server
      // window is shorter (thinking state takes over) or longer (😐 expires
      // and the regular listening emoji shows — same as today).
      const HEARING_GRACE_MS = 2500;
      const stillInGrace = !this.anyoneSpeaking
        && this.lastAnyoneSpeakingFalseAt > 0
        && (Date.now() - this.lastAnyoneSpeakingFalseAt) < HEARING_GRACE_MS;
      const hearing = ((this.anyoneSpeaking || stillInGrace) && this.mode !== 'silent' && !this.speaking && this.state !== 'thinking' && this.state !== 'speaking' && this.state !== 'yielding')
        ? VirtualCamera.HEARING_EMOJI : null;
      const activityEmoji = this.state === 'yielding'
        ? (this.yieldingEmojiOverride || VirtualCamera.ACTIVITY_EMOJIS.yielding)
        : VirtualCamera.ACTIVITY_EMOJIS[this.state];
      // Resting emojis: agent overrides take priority over defaults when in
      // the corresponding state. Listening override only applies in 'active'
      // mode (passive/silent emojis encode a specific user-controlled state).
      const idleEmoji = this.idleEmojiOverride || VirtualCamera.IDLE_EMOJI;
      const listeningEmoji = (this.mode === 'active' && this.listeningEmojiOverride)
        ? this.listeningEmojiOverride
        : VirtualCamera.MODE_EMOJIS[this.mode] || VirtualCamera.MODE_EMOJIS.active;
      // Deaf takes priority over everything except not-on-line — the whole
      // point is making "can't hear you" visible while otherwise in-call.
      const deafEmoji = this.deaf ? '\u{1F649}' : null; // 🙉
      const emoji =
        notOnLine
        || deafEmoji
        || audioPlaying
        || activityEmoji
        || hearing
        || (this.state === 'idle' ? idleEmoji : null)
        || listeningEmoji;
      // Log every emoji change so the terminal output captures what the
      // user actually sees, not just internal state. Forwarded to main via
      // window.postMessage → preload-meet → ipcRenderer so it lands in the
      // Electron stdout that we tail with `cmux read-screen`.
      if (emoji !== this._lastLoggedEmoji) {
        this._lastLoggedEmoji = emoji;
        const reason = notOnLine ? `callStatus=${this.callStatus} hasEngaged=${this.hasEngaged}` :
          audioPlaying ? `audio playing (state=${this.state}${this.speakingEmojiOverride ? ' override' : ''})` :
          activityEmoji ? `state=${this.state}${this.state === 'yielding' && this.yieldingEmojiOverride ? ' (yielding override)' : ''}` :
          hearing ? `hearing (anyoneSpeaking=true)` :
          this.state === 'idle' ? `state=idle${this.idleEmojiOverride ? ' (idle override)' : ' (between turns)'}` :
          `mode=${this.mode}${this.listeningEmojiOverride && this.mode === 'active' ? ' (listening override)' : ' (listening)'}`;
        window.postMessage({
          __botsInCalls: true,
          action: 'log',
          payload: { line: `Avatar → ${emoji} · ${reason}` },
        }, '*');
      }
      const emojiSize = Math.min(w, h) * 0.65;
      // Idle liveness (#223). The avatar must never look like a frozen frame
      // on the video feed — a static tile reads as "the bot crashed." Two
      // small continuous motions run in EVERY state:
      //   - bob: gentle vertical bobbing. Period ~4s (was ~13s, too slow to
      //     perceive as alive over a glance).
      //   - breathe: subtle scale pulse, applied below for non-speaking
      //     states (speaking has its own louder amplitude-driven scale).
      // Both amplitudes are deliberately well under the thinking sway and the
      // speaking jaw motion so they don't compete with the meaningful states.
      const bob = Math.sin(this.frameCount * 0.045) * (emojiSize * 0.018);
      const breathe = 1 + Math.sin(this.frameCount * 0.04) * 0.012; // ±1.2%, ~3.5s
      // Speaking animation, amplitude-driven (lip-sync). We read the bot's
      // current TTS loudness from the VirtualMic analyser and use it to "open
      // the jaw": a vertical stretch + bounce that tracks the actual audio, so
      // the mouth moves with speech instead of a fixed pulse. Falls back to a
      // gentle sine when speaking but amplitude is unavailable (e.g. ack tones
      // played through a different path) so the avatar never looks frozen.
      let speakOpen = 0;
      if (this.speaking) {
        const amp = (typeof mic !== 'undefined' && mic && mic.getAmplitude) ? mic.getAmplitude() : 0;
        // Fallback sine is fairly pronounced so the avatar visibly "talks" even
        // when amplitude is unavailable (e.g. ack tones on a separate path).
        speakOpen = amp > 0.02 ? amp : (0.4 + 0.3 * (0.5 + 0.5 * Math.sin(this.frameCount * 0.5)));
      }
      // Exaggerated, two-part motion: the whole emoji pulses larger with volume,
      // AND stretches vertically (jaw open). Both are deliberately big — on a
      // flat glyph subtle scaling is invisible.
      const baseScale = 1 + speakOpen * 0.22;            // whole-emoji volume pulse
      const speakScaleY = baseScale * (1 + speakOpen * 0.35); // extra vertical = jaw
      const speakScaleX = baseScale * (1 - speakOpen * 0.10); // slight squeeze
      const speakBounce = speakOpen * (emojiSize * 0.06);
      const speakTilt = this.speaking ? Math.sin(this.frameCount * 0.3) * 0.05 : 0;
      // Thinking state: gentle side-to-side sway
      const thinkSway = this.state === 'thinking'
        ? Math.sin(t * 1.2) * 8
        : 0;
      // Background-tick "noted that" pulse — a quick head-tilt + pop that eases
      // out over ~700ms when the avatar enters thinking (set in 'set-bot-state').
      // Framerate-robust via wall-clock. sin gives a smooth 0→1→0.
      const PULSE_MS = 700;
      const pulseAge = Date.now() - (this._tickPulseAt || 0);
      const tickPulse = (pulseAge >= 0 && pulseAge < PULSE_MS) ? Math.sin((pulseAge / PULSE_MS) * Math.PI) : 0;
      const tickTilt = tickPulse * 0.16; // ~9° peak head tilt
      const tickPop = 1 + tickPulse * 0.12; // ~12% peak enlarge

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${Math.round(emojiSize)}px serif`;

      // Glow when speaking
      if (this.speaking) {
        ctx.shadowColor = '#8ab4f8';
        ctx.shadowBlur = 30;
      }
      // Subtle glow when thinking
      if (this.state === 'thinking') {
        ctx.shadowColor = '#ffc107';
        ctx.shadowBlur = 20;
      }

      // Apply translation + rotation + non-uniform scale around the avatar
      // center. The scaleX/scaleY give the "mouth open" jaw effect.
      ctx.translate(cx + thinkSway, cy + bob - speakBounce);
      if (speakTilt || tickTilt) ctx.rotate(speakTilt + tickTilt);
      if (this.speaking) {
        ctx.scale(speakScaleX * tickPop, speakScaleY * tickPop);
      } else {
        // Idle/listening/thinking breathing — keeps the glyph subtly alive
        // without the loud jaw motion of the speaking path. (#223)
        ctx.scale(breathe * tickPop, breathe * tickPop);
      }
      ctx.fillText(emoji, 0, 0);
      ctx.restore();

      if (this.debugOverlayEnabled) this._renderDebugOverlay();
    }

    _renderDebugOverlay() {
      const { ctx, canvas } = this;
      const d = this.debugInfo || {};
      const now = Date.now();
      const ago = (ms) => {
        if (!ms) return 'never';
        const s = Math.round((now - ms) / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.round(s / 60)}m ago`;
        return `${Math.round(s / 3600)}h ago`;
      };
      const loopHealth = (() => {
        if (d.activeWaiters > 0) return `listening (${d.activeWaiters})`;
        if (!d.lastWaitForSpeechAt) return 'no wait_for_speech yet';
        const idleSecs = Math.round((now - d.lastWaitForSpeechAt) / 1000);
        if (idleSecs < 5) return `between waits (${idleSecs}s)`;
        if (idleSecs < 60) return `idle ${idleSecs}s`;
        return `STALE ${ago(d.lastWaitForSpeechAt)}`;
      })();
      // Ack rendered on two lines: phrase on its own line, metadata
      // (source · latency · age) on the next so the phrase is readable
      // and the box width is dominated by the metadata line, not by long
      // ack phrases.
      const ackLines = (() => {
        const ev = d.lastAckEvent;
        if (!ev) return ['ack:      (none yet)'];
        const phrase = ev.phrase ? `"${ev.phrase}"` : 'SKIP';
        const latency = ev.latencyMs != null ? `${ev.latencyMs}ms` : '?';
        const src = ev.source === 'llm-fallback-builtin' ? 'fallback' : (ev.source || '?');
        return [
          `ack:      ${phrase}`,
          `          ${src} · ${latency} · ${ago(ev.at)}`,
        ];
      })();
      const clip = (s, max = 40) => {
        let t = String(s || '').replace(/\s+/g, ' ').trim();
        return t.length > max ? '…' + t.slice(-max) : t; // keep the most-recent tail
      };
      // heard = freshest caption (may still be in flux → "(live)") vs settled.
      // proc  = what was last SHIPPED to the slow model for processing.
      const heard = (() => {
        const c = d.lastCaption;
        if (!c || !c.text) return 'heard:    (nothing yet)';
        return `heard:    ${c.speaker || '?'}: ${clip(c.text)} ${c.live ? '(live)' : '(settled)'}`;
      })();
      const proc = (() => {
        const p = d.processing;
        if (!p || !p.text) return 'proc:     (idle)';
        return `proc:     ${p.speaker || '?'}: ${clip(p.text)}`;
      })();

      // Two clusters: CALL (overall health) and LOOP (the hear/speak cycle).
      // Each is its own line-list; blank lines and headers separate them.
      const callLines = [
        'CALL',
        `in-call:  ${d.callStatus === 'in-call' ? 'yes' : (d.callStatus || 'unknown')}`,
        `sharing:  ${d.sharing ? 'yes' : 'no'}${d.someoneElsePresenting ? ' (other)' : ''}`,
        `members:  ${(d.participants || []).length}`,
        `caps:     ${d.captionsOn ? 'ON' : 'OFF — DEAF'}`,
      ];
      const loopLines = [
        'LOOP',
        `mode:     ${d.mode || 'unknown'}`,
        `state:    ${d.botState || 'unknown'}`,
        `speaking: ${this.anyoneSpeaking ? 'yes' : 'no'}`,
        `loop:     ${loopHealth}`,
        `last WfS: ${ago(d.lastWaitForSpeechAt)}`,
        ...ackLines,
        `queued:   ${(d.pendingBotSpeech || []).length}`,
        `chat:     ${d.chatUnread ? 'UNREAD' : 'none'}`,
        heard,
        proc,
      ];
      const lines = [...callLines, '', ...loopLines];

      const pad = 16;
      const lineH = 30;
      const font = '600 22px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.save();
      ctx.font = font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      // No background panel (it was distracting as the box resized). Instead the
      // classic text-on-TV treatment: a dark OUTLINE (stroke) behind each line
      // guarantees contrast over ANY avatar background (light or busy), plus a
      // soft shadow for depth. Stroke is the workhorse; shadow is polish.
      ctx.lineJoin = 'round';   // avoid spiky corners on the outline
      ctx.miterLimit = 2;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;
      const boxX = 24;
      const boxY = 24;
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        const x = boxX + pad;
        const y = boxY + pad + i * lineH;
        // Headers yellow; STALE loop / DEAF caps / ack-fallback red; heard blue;
        // proc teal; rest light grey.
        if (ln === 'CALL' || ln === 'LOOP') ctx.fillStyle = '#fdd663';
        else if (ln.startsWith('loop:') && ln.includes('STALE')) ctx.fillStyle = '#ea4335';
        else if (ln.includes('fallback') && (ln.startsWith('ack:') || ln.startsWith('          '))) ctx.fillStyle = '#ea4335';
        else if (ln.startsWith('caps:') && ln.includes('DEAF')) ctx.fillStyle = '#ea4335';
        else if (ln.startsWith('heard:')) ctx.fillStyle = '#8ab4f8';
        else if (ln.startsWith('proc:')) ctx.fillStyle = '#5bd1c4';
        else ctx.fillStyle = '#e8eaed';
        // Outline first (carries the shadow), then the colored fill on top with
        // the shadow disabled so it doesn't muddy the glyph interior.
        ctx.strokeText(ln, x, y);
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.fillText(ln, x, y);
        ctx.restore();
      }
      ctx.restore();
    }

    getTrack() {
      // If Meet stopped the previous track (camera-off toggle calls
      // track.stop()), the cached stream's track is now in readyState
      // 'ended' and emits a black frame forever. Re-capture from the
      // same canvas — the render loop is still running, so this gives
      // us a fresh live track without rebuilding the whole camera.
      const existing = this.stream.getVideoTracks()[0];
      if (!existing || existing.readyState === 'ended') {
        console.log('[bots-in-calls] Video track was stopped, re-capturing from canvas');
        this.stream = this.canvas.captureStream(config.fps);
      }
      return this.stream.getVideoTracks()[0];
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
    async playAudio(arrayBuffer) {
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
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.destination);
      src.connect(this.analyser); // feed lip-sync amplitude (parallel tap)
      // Expose the live source so stopAudio() can interrupt it for back-off
      // (#154). onended fires whether playback finished or was stop()'d.
      this._currentSource = src;
      return new Promise((resolve) => {
        src.onended = () => {
          if (this._currentSource === src) this._currentSource = null;
          resolve();
        };
        src.start();
      });
    }

    // Stop the currently-playing TTS source immediately. No-op if nothing is
    // playing. Used by the barge-in / back-off path (#154). The src.stop()
    // call triggers onended → the playAudio promise resolves naturally, so
    // the playNextTTS state machine cleans up on its own.
    stopAudio() {
      const src = this._currentSource;
      if (!src) return false;
      try { src.stop(); } catch { /* already stopped */ }
      this._currentSource = null;
      return true;
    }

    getTrack() {
      // Consumers can END our destination track — Slack stop()s the mic track on
      // the lobby→huddle handoff (and on device switches), which would leave
      // every later getUserMedia holding a DEAD track: silent mic, "we can't hear
      // you", no TTS out. If the current track is ended, rebuild the destination
      // (with a fresh silent keep-alive) so we always return a LIVE track. TTS
      // sources connect to this.destination, so they follow the rebuild. Meet
      // never stops the track this way, so this branch is Slack-only in practice.
      let track = this.destination.stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') {
        this.destination = this.audioCtx.createMediaStreamDestination();
        const silence = this.audioCtx.createGain();
        silence.gain.value = 0;
        silence.connect(this.destination);
        const osc = this.audioCtx.createOscillator();
        osc.connect(silence);
        osc.start();
        track = this.destination.stream.getAudioTracks()[0];
        console.log('[bots-in-calls] VirtualMic track was ended — rebuilt destination; new track:', track.id);
      }
      return track;
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

  async function playNextTTS() {
    if (ttsPlaying || ttsQueue.length === 0) return;
    ttsPlaying = true;
    const { audioData, emoji } = ttsQueue.shift();
    for (const cam of cameras.values()) {
      cam.speaking = true;
      cam.speakingEmojiOverride = emoji || null;
    }
    transcription.botSpeaking = true;
    try {
      // Ensure AudioContext is running before playback
      if (mic.audioCtx.state === 'suspended') {
        console.log('[bots-in-calls] Resuming AudioContext before TTS playback');
        await mic.audioCtx.resume();
      }
      await mic.playAudio(audioData);
    } catch (err) {
      console.error('[bots-in-calls] TTS playback error:', err);
    }
    ttsPlaying = false;
    if (ttsQueue.length === 0) {
      for (const cam of cameras.values()) {
        cam.speaking = false;
        cam.speakingEmojiOverride = null;
      }
      setTimeout(() => { transcription.botSpeaking = false; }, 1500);
      window.postMessage({ __botsInCalls: true, action: 'tts-ended' }, '*');
    } else {
      playNextTTS();
    }
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

  // Module-scope debug overlay state. Persisted here so that a `set-debug-
  // overlay` message arriving BEFORE any VirtualCamera exists (which happens
  // on Meet reload — preload runs at document_start, Meet calls getUserMedia
  // later) still takes effect on the camera the moment it's created.
  let debugOverlayEnabledGlobal = false;
  let debugInfoLatest = null;

  // Last-known avatar/call state, kept at module scope for the SAME reason as the
  // debug-overlay globals: state messages (set-call-status / set-bot-state /
  // set-mode / set-avatar-*) are pushed only on CHANGE, so a VirtualCamera created
  // AFTER those messages (e.g. the camera being toggled on mid-call re-acquires
  // the video stream → a fresh camera) must seed from here or it resets to the
  // 🫥 idle default and stays there while the bot is actually engaged. The set-*
  // handlers update both every live camera AND this object.
  const avatarState = {
    state: 'idle', mode: 'active', callStatus: 'idle', hasEngaged: false,
    deaf: false, idleEmojiOverride: null, listeningEmojiOverride: null,
    yieldingEmojiOverride: null, backgroundImage: null,
  };

  function getCamera(width, height) {
    const key = `${width}x${height}`;
    if (!cameras.has(key)) {
      cameras.set(key, new VirtualCamera(width, height));
      console.log('[bots-in-calls] Created virtual camera:', key);
    }
    return cameras.get(key);
  }

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
      tracks.push(camera.getTrack());
    }

    if (constraints?.audio) {
      if (!mic) {
        mic = new VirtualMic();
        console.log('[bots-in-calls] Created VirtualMic for getUserMedia, AudioContext state:', mic.audioCtx.state);
      }
      const audioTrack = mic.getTrack();
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
  // Whiteboard — renders content to an offscreen canvas for screen sharing
  // ---------------------------------------------------------------------------

  class Whiteboard {
    constructor(width, height) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width || 1920;
      this.canvas.height = height || 1080;
      this.ctx = this.canvas.getContext('2d');
      this.content = 'Whiteboard ready.\n\nWaiting for content...';
      this.title = 'AI Assistant — Whiteboard';
      this.stream = this.canvas.captureStream(5); // 5fps is fine for a whiteboard
      this._render();
    }

    setContent(text) {
      this.content = text;
      this._render();
    }

    setTitle(title) {
      this.title = title;
      this._render();
    }

    _render() {
      const { canvas, ctx } = this;
      const w = canvas.width;
      const h = canvas.height;

      // White background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);

      // Header bar
      const headerH = 64;
      ctx.fillStyle = '#1a73e8';
      ctx.fillRect(0, 0, w, headerH);

      // Title in header
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px "Google Sans", Roboto, Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.title, 24, headerH / 2);

      // Timestamp
      ctx.textAlign = 'right';
      ctx.font = '18px "Google Sans", Roboto, Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(new Date().toLocaleTimeString(), w - 24, headerH / 2);

      // Content area
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#202124';

      const padding = 32;
      const lineHeight = 32;
      const maxWidth = w - padding * 2;
      const startY = headerH + padding;
      let y = startY;

      const lines = this.content.split('\n');
      for (const line of lines) {
        if (y > h - padding) break; // don't overflow

        // Simple heading detection
        if (line.startsWith('# ')) {
          ctx.font = 'bold 36px "Google Sans", Roboto, Arial, sans-serif';
          ctx.fillStyle = '#1a73e8';
          ctx.fillText(line.slice(2), padding, y, maxWidth);
          y += lineHeight * 1.5;
          ctx.fillStyle = '#202124';
          ctx.font = '24px "Google Sans", Roboto, Arial, sans-serif';
        } else if (line.startsWith('## ')) {
          ctx.font = 'bold 30px "Google Sans", Roboto, Arial, sans-serif';
          ctx.fillStyle = '#1565c0';
          ctx.fillText(line.slice(3), padding, y, maxWidth);
          y += lineHeight * 1.3;
          ctx.fillStyle = '#202124';
          ctx.font = '24px "Google Sans", Roboto, Arial, sans-serif';
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          ctx.font = '24px "Google Sans", Roboto, Arial, sans-serif';
          ctx.fillText('  •  ' + line.slice(2), padding, y, maxWidth);
          y += lineHeight;
        } else if (line.trim() === '') {
          y += lineHeight * 0.5;
        } else {
          ctx.font = '24px "Google Sans", Roboto, Arial, sans-serif';
          // Word wrap
          const words = line.split(' ');
          let currentLine = '';
          for (const word of words) {
            const test = currentLine + (currentLine ? ' ' : '') + word;
            if (ctx.measureText(test).width > maxWidth) {
              ctx.fillText(currentLine, padding, y, maxWidth);
              y += lineHeight;
              currentLine = word;
            } else {
              currentLine = test;
            }
          }
          if (currentLine) {
            ctx.fillText(currentLine, padding, y, maxWidth);
            y += lineHeight;
          }
        }
      }
    }

    getStream() {
      return this.stream;
    }
  }

  let whiteboard = null;

  function getWhiteboard() {
    if (!whiteboard) {
      whiteboard = new Whiteboard();
      console.debug('[bots-in-calls] Whiteboard created');
    }
    return whiteboard;
  }

  // ---------------------------------------------------------------------------
  // getDisplayMedia override — returns whiteboard stream instead of showing picker
  // ---------------------------------------------------------------------------

  const _getDisplayMedia = MediaDevices.prototype.getDisplayMedia;

  MediaDevices.prototype.getDisplayMedia = async function (constraints) {
    console.debug('[bots-in-calls] *** getDisplayMedia CALLED ***');
    // In Electron, session.setDisplayMediaRequestHandler handles source selection.
    // In Chrome extension, fall through to native picker.
    return _getDisplayMedia.call(navigator.mediaDevices, constraints);
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

      case 'set-speaking':
        for (const cam of cameras.values()) cam.speaking = !!payload;
        break;

      case 'set-bot-state':
        // Update avatar state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'yielding'
        if (payload?.state) {
          for (const cam of cameras.values()) {
            // Brief "noted that" pulse on entering thinking — this is what a
            // background_tick (#245) causes, so the avatar tilts+pops to signal
            // the slow model just surfaced. Harmless before a normal response too.
            if (payload.state === 'thinking' && cam.state !== 'thinking') cam._tickPulseAt = Date.now();
            cam.state = payload.state;
            // hasEngaged = "a real agent backend is driving us", which is the
            // meaning of 🫥 vs a face: 🫥 = in the call but unattended. ANY
            // non-idle bot state proves an agent is on the line — 'listening'
            // is set only by an agent calling wait_for_speech, and thinking/
            // speaking/yielding by it processing/responding. Bot-side auto-setup
            // (join, captions, camera) never sets these, so it can't false-trip.
            // 'idle' is the between-turns/boot resting state and does NOT engage.
            if (payload.state && payload.state !== 'idle') {
              cam.hasEngaged = true;
            }
          }
          avatarState.state = payload.state; // seed future cameras
          if (payload.state !== 'idle') avatarState.hasEngaged = true;
          console.debug('[bots-in-calls] Bot state:', payload.state);
        }
        break;

      case 'set-mode':
        // Update persistent mode: 'active' | 'passive' | 'silent'
        if (payload?.mode) {
          for (const cam of cameras.values()) cam.mode = payload.mode;
          avatarState.mode = payload.mode; // seed future cameras
          console.debug('[bots-in-calls] Bot mode:', payload.mode);
        }
        break;

      case 'set-anyone-speaking':
        if (typeof payload?.anyoneSpeaking === 'boolean') {
          for (const cam of cameras.values()) {
            // Stamp when the floor went quiet so the avatar can hold 😐
            // through the server's silence-threshold window. Without this
            // the avatar flickers 😐 → 🙂 (default listening) → 🤔 in the
            // 2-ish-second gap before botState becomes 'thinking', reading
            // as "done, back to normal" then "wait, thinking now" instead
            // of one continuous "I heard you, processing."
            if (cam.anyoneSpeaking && !payload.anyoneSpeaking) {
              cam.lastAnyoneSpeakingFalseAt = Date.now();
            }
            cam.anyoneSpeaking = payload.anyoneSpeaking;
          }
        }
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

      case 'set-call-status':
        // Forwarded from local-server: 'idle' | 'joining' |
        // 'waiting-to-be-admitted' | 'in-call' | 'left'. Used to show 🫥
        // before the bot is actually in the call.
        if (payload?.status) {
          const resets = payload.status === 'idle' || payload.status === 'joining' || payload.status === 'left';
          for (const cam of cameras.values()) {
            cam.callStatus = payload.status;
            // New-call markers reset the engagement gate — show 🫥 again
            // until the agent re-engages.
            if (resets) cam.hasEngaged = false;
          }
          avatarState.callStatus = payload.status; // seed future cameras
          if (resets) avatarState.hasEngaged = false;
          console.debug('[bots-in-calls] Call status:', payload.status);
        }
        break;

      case 'set-whiteboard':
        if (payload?.content != null) {
          getWhiteboard().setContent(payload.content);
          console.debug('[bots-in-calls] Whiteboard content updated');
        }
        if (payload?.title != null) {
          getWhiteboard().setTitle(payload.title);
        }
        break;

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
          const track = mic.getTrack();
          console.log('[bots-in-calls] Queuing TTS audio, data length:', payload.audioData.length,
            'queue size:', ttsQueue.length,
            'AudioContext state:', mic.audioCtx.state,
            'track enabled:', track?.enabled, 'readyState:', track?.readyState, 'muted:', track?.muted,
            'destination tracks:', mic.destination.stream.getAudioTracks().length);
          ttsQueue.push({ audioData: payload.audioData, emoji: payload.emoji });
          playNextTTS();
        }
        break;

      case 'stop-tts': {
        // Back-off (#154): interrupt the bot mid-utterance and drop anything
        // queued behind it. The current source's onended will fire and the
        // playNextTTS state machine cleans up normally, posting tts-ended.
        const droppedQueue = ttsQueue.length;
        ttsQueue.length = 0;
        const wasPlaying = mic ? mic.stopAudio() : false;
        const reason = payload?.reason || 'unspecified';
        console.log('[bots-in-calls] stop-tts reason=' + reason + ' wasPlaying=' + wasPlaying + ' droppedQueue=' + droppedQueue);
        break;
      }

      case 'set-deaf':
        // Captions on/off from the scraper's CC-button watcher.
        // payload.deaf === true → avatar shows 🙉 to participants.
        if (payload) {
          for (const cam of cameras.values()) cam.deaf = !!payload.deaf;
          avatarState.deaf = !!payload.deaf; // seed future cameras
        }
        break;

      case 'set-avatar-emoji-override':
        // Persistent agent overrides for resting/yielding emojis. payload.idle,
        // payload.listening, and payload.yielding are independently optional.
        // null means reset to default for that key.
        if (payload) {
          for (const cam of cameras.values()) {
            if ('idle' in payload) cam.idleEmojiOverride = payload.idle;
            if ('listening' in payload) cam.listeningEmojiOverride = payload.listening;
            if ('yielding' in payload) cam.yieldingEmojiOverride = payload.yielding;
          }
          // Seed future cameras so a mid-call camera respawn keeps the override.
          if ('idle' in payload) avatarState.idleEmojiOverride = payload.idle;
          if ('listening' in payload) avatarState.listeningEmojiOverride = payload.listening;
          if ('yielding' in payload) avatarState.yieldingEmojiOverride = payload.yielding;
          console.log('[bots-in-calls] Avatar emoji overrides:',
            'idle=' + (payload.idle ?? 'unchanged'),
            'listening=' + (payload.listening ?? 'unchanged'),
            'yielding=' + (payload.yielding ?? 'unchanged'));
        }
        break;

      case 'set-debug-overlay':
        // Toggle the debug info overlay on the virtual camera. Controlled
        // only from the panel — never from the agent — to avoid prompt-
        // injection scenarios where a bot reveals internal state on demand.
        // Update the module-scope flag too so cameras created after this
        // message arrives still pick it up (Meet creates the camera on
        // first getUserMedia, which is later than preload init).
        if (payload) {
          debugOverlayEnabledGlobal = !!payload.enabled;
          for (const cam of cameras.values()) {
            cam.debugOverlayEnabled = debugOverlayEnabledGlobal;
          }
          console.log('[bots-in-calls] Debug overlay:', payload.enabled ? 'on' : 'off');
        }
        break;

      case 'debug-info-update':
        // Periodic call-state snapshot push from main.js while the debug
        // overlay is enabled. Stored on the camera so the next render tick
        // picks it up.
        if (payload) {
          debugInfoLatest = payload;
          for (const cam of cameras.values()) {
            cam.debugInfo = payload;
          }
        }
        break;

      case 'set-avatar-background':
        // Load the resolved SVG (or clear back to default gradient when
        // payload.svg is empty). External refs are already inlined as data
        // URIs server-side, so this is safe to draw without tainting the
        // canvas. SMIL/CSS animations inside the SVG do not tick — the
        // emoji's bounce is the only motion.
        if (payload) {
          const svg = (payload.svg || '').trim();
          for (const cam of cameras.values()) {
            if (!svg) {
              cam.backgroundImage = null;
              console.log('[bots-in-calls] Avatar background cleared (default gradient)');
              continue;
            }
            const img = new Image();
            img.onload = () => {
              cam.backgroundImage = img;
              console.log('[bots-in-calls] Avatar background loaded (',
                svg.length, 'chars,', img.naturalWidth, 'x', img.naturalHeight, ')');
            };
            img.onerror = (err) => {
              console.warn('[bots-in-calls] Avatar background failed to load — falling back to gradient', err);
              cam.backgroundImage = null;
            };
            img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
          }
          // Seed future cameras (mid-call respawn keeps the custom background).
          if (!svg) {
            avatarState.backgroundImage = null;
          } else {
            const seedImg = new Image();
            seedImg.onload = () => { avatarState.backgroundImage = seedImg; };
            seedImg.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
          }
        }
        break;

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

            for (const cam of cameras.values()) cam.speaking = true;
            transcription.botSpeaking = true;
            src.onended = () => {
              for (const cam of cameras.values()) cam.speaking = false;
              setTimeout(() => { transcription.botSpeaking = false; }, 1500);
              console.log('[bots-in-calls] Speech audio finished');
            };
            src.start();
            console.log('[bots-in-calls] Speech audio playing...');
          } catch (err) {
            console.error('[bots-in-calls] Speech audio error:', err);
            for (const cam of cameras.values()) cam.speaking = false;
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
        for (const cam of cameras.values()) cam.speaking = true;
        setTimeout(() => {
          for (const cam of cameras.values()) cam.speaking = false;
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
      const wasSpeaking = this.speaking;
      this.speaking = db > -55;

      if (this.speaking) {
        this.lastSpeakingTime = Date.now();
      }

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
