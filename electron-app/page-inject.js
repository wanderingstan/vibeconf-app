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

  // #428: draw `img` to fill a w×h canvas WITHOUT distorting it — CSS
  // `object-fit: cover` semantics. Scale by the larger axis ratio so the image
  // always covers the canvas, then center it so the overflow is cropped evenly
  // on both sides. Aspect-agnostic in both directions: a square source on a
  // 16:9 canvas crops top/bottom evenly; a 16:9 source on a future portrait
  // canvas would crop left/right evenly. Never letterboxes (no empty bars).
  function drawCover(ctx, img, w, h) {
    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    if (!sw || !sh) return; // nothing sane to scale by; skip rather than divide by 0
    const scale = Math.max(w / sw, h / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

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
      // 😑 reading along. A background tick (#245) surfaces the slow model
      // mid-conversation so it can keep up and bank a probe — it is NOT
      // answering, and must not wear the 🤔 reply face. The tick fires on a
      // word-count delta while someone is still mid-sentence, so 🤔 there read
      // as "I've decided to answer your half-sentence" (see #432 / the
      // 09:01:32 "Everything else." incident).
      //
      // Expressionless, NOT 👀. A tick can only happen while someone is
      // speaking, which means the face it replaces is always 😐 HEARING_EMOJI.
      // 😐 → 😑 is the same face closing its eyes: it reads as a blink, so the
      // avatar stays a listener paying attention rather than becoming a
      // different object for a few seconds.
      ticking:  '\u{1F611}',
      thinking: '\u{1F914}', // 🤔 formulating a reply — still "with" the conversation
      working:  '\u{1F9D1}\u{200D}\u{1F4BB}', // 🧑‍💻 heads-down running tools — NOT tracking the room
      speaking: '\u{1F604}', // 😄 grinning face — open mouth fits TTS playback
      yielding: '\u{1F64B}', // 🙋 wants to speak, yielding to the room
    };

    // Override emojis whenever the bot isn't in the call. Anything other than
    // 'in-call' means the agent isn't actually on the line — show 🫥.
    static CALL_STATUS_EMOJIS = {
      'idle':                   '\u{1FAE5}',  // 🫥 no call yet
      'navigating':             '\u{1FAE5}',  // 🫥 view dispatched, not yet loaded
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
    // 🫤 the gap between "you stopped talking" and "the turn resolved" — roughly
    // defaultSilenceSeconds, ~1.4s. The face used to hold 😐 through it, which
    // is honest but says nothing; the bot is measurably slower to answer than a
    // human, so the seconds before it starts thinking are exactly where the room
    // most needs a sign it is on the case. Diagonal mouth reads as "hm, are you
    // done?" and sits naturally between 😐 and 🤔, so the sequence looks like one
    // face progressing rather than three unrelated ones.
    static SETTLING_EMOJI = '\u{1FAE4}'; // 🫤 heard you, waiting to see if you're finished

    constructor(width, height) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width || config.canvasWidth;
      this.canvas.height = height || config.canvasHeight;
      this.ctx = this.canvas.getContext('2d');
      this.frameCount = 0;
      this.speaking = false;
      // #326 — head-rotation proof-of-life driven by agent log activity. Set
      // when main.js pushes a new activity line (overlay-independent); the head
      // snaps to this lean and holds until the next line.
      this._agentJostleDir = 0;    // hash-derived lean direction, -1..1
      // "Heard my name" reaction — see 'name-mentioned' below. _mentionTiltSign
      // ALTERNATES each mention (so consecutive mentions stay visually
      // distinguishable as separate events); _mentionTiltMag is re-rolled
      // randomly each time so the tilt amplitude varies and doesn't look like
      // an identical mechanical tic. _nameMentionPulseAt is read via `|| 0` so
      // it needs no explicit init (mirrors _tickPulseAt).
      this._mentionTiltSign = 1;
      this._mentionTiltMag = 1;
      // Background-tick "noted that" pulse — see 'set-bot-state' below.
      // Direction + size are re-rolled randomly on every firing (not just
      // seeded once here) so multiple bots on one call don't tilt in lockstep
      // when they all notice the same silence gap at once.
      this._tickTiltSign = 1;
      this._tickTiltMag = 1;
      // Thinking sway envelope (#290) — see the render loop. 0 means "not
      // swaying"; both are wall-clock stamps, so neither needs a value here
      // beyond the falsy start.
      this._swaySince = 0;
      this._swayLeftAt = 0;
      // Seed persistent state from the module-level avatarState, NOT hardcoded
      // defaults. A camera can be created mid-call — e.g. turning the camera on
      // makes the host page re-acquire the video stream, spawning a fresh
      // VirtualCamera — and state messages are only pushed on CHANGE, so a fresh
      // camera that defaulted to idle/🫥 would never learn it's in-call+engaged
      // and would sit on 🫥 while the bot is actually talking. avatarState holds
      // the last known values so a new camera picks up where the call is.
      this.state = avatarState.state;   // 'idle' | 'listening' | 'ticking' | 'thinking' | 'working' | 'speaking' | 'yielding'
      this.mode = avatarState.mode;     // 'active' | 'passive' | 'silent'
      this.callStatus = avatarState.callStatus; // 'idle' | 'navigating' | 'joining' | 'waiting-to-be-admitted' | 'in-call' | 'left'
      // True once the agent has done anything besides idle. Stays 🫥 until then,
      // since "in-call but agent not yet engaged" still means not on the line.
      // Resets whenever a new call begins.
      this.hasEngaged = avatarState.hasEngaged;
      // True while at least one participant is currently speaking (from
      // DOMSpeakerTracker). Suppressed when mode='silent'.
      this.anyoneSpeaking = false;
      // { deadline, from } while the silence gate is pending — drives the
      // pendulum that returns to level exactly when the bot takes its turn.
      this.silenceGate = null;
      // When the floor last went quiet. Drives the post-speech grace window
      // (see HEARING_GRACE_MS in the emoji waterfall).
      this.lastAnyoneSpeakingFalseAt = 0;
      // Deaf flag — set from the scraper's CC-button watcher via 'set-deaf'.
      // When true (and we're in-call), the avatar shows 🙉 so participants in
      // the Meet itself see that the bot can't hear them and can re-enable
      // captions. Takes priority over everything except the not-on-line emoji.
      this.deaf = avatarState.deaf;
      // #424: generic "something is wrong" flag — the bot believes it is in a
      // degraded state it can't fully diagnose (captions ON but no new text
      // for a long stretch, renderer freeze, etc). Distinct from `deaf`
      // (captions confirmed OFF — a known, specific cause). Shows 🥴 so the
      // room and the operator can SEE that the bot is impaired instead of it
      // sitting there wearing a happy listening face while hearing nothing.
      this.impaired = avatarState.impaired;
      // #38: no agent is driving. Distinct from `impaired` (agent present but
      // hobbled) and from callStatus (not in the call at all).
      this.agentAbsent = avatarState.agentAbsent;
      // 'dropped' | 'quiet' | 'never' — only 'dropped' is certain enough to topple.
      this.agentAbsentReason = avatarState.agentAbsentReason;
      // Per-response speaking emoji (set by speak's emoji param). Cleared
      // when the TTS queue drains. Falls through to ACTIVITY_EMOJIS.speaking.
      this.speakingEmojiOverride = null;
      // Debug overlay — when enabled (panel checkbox only, never agent-set),
      // renders a corner panel showing the same internal state visible in
      // the troubleshooting screen. Lets a non-technical user diagnose
      // problems just by looking at the bot's tile in Meet.
      this.debugOverlayEnabled = debugOverlayEnabledGlobal;
      this.debugOverlayFlags = debugOverlayFlagsGlobal;
      this.emojiSet = avatarState.emojiSet || emojiSetGlobal;
      this.debugInfo = debugInfoLatest;
      // Recording indicator — unlike the debug overlay this is USER-facing
      // (consent/awareness), not diagnostic chrome, so it's drawn unconditionally
      // whenever recording is active rather than gated behind debugOverlayEnabled.
      // Seeded from the module-level global so a camera created mid-recording
      // (camera toggle, Meet reload) still shows it immediately.
      this.isRecording = isRecordingGlobal;
      // Persistent overrides from agent's set_avatar_emoji calls. null = use
      // default for that state. Seeded from avatarState so a camera created
      // mid-call keeps the configured emoji instead of reverting to defaults.
      this.idleEmojiOverride = avatarState.idleEmojiOverride;
      this.listeningEmojiOverride = avatarState.listeningEmojiOverride;
      this.yieldingEmojiOverride = avatarState.yieldingEmojiOverride;
      // Optional custom background. null = use default animated gradient.
      // Set by the 'set-avatar-background' message after server-side resolve.
      this.backgroundImage = avatarState.backgroundImage;
      // P2: optional Runway avatar <video> (set via setAvatarVideo). When playing it
      // replaces the emoji as the camera. null = normal emoji avatar (default, unchanged).
      this.avatarVideo = null;
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

    // P2: attach/detach a Runway avatar <video> as the camera source. Opt-in; null restores emoji.
    setAvatarVideo(videoEl) {
      this.avatarVideo = videoEl || null;
    }

    _render() {
      const { canvas, ctx } = this;
      const w = canvas.width;
      const h = canvas.height;
      this.frameCount++;

      // --- P2: Runway avatar face (opt-in). When a playing avatar video is attached, it
      // replaces the emoji entirely. Inert unless setAvatarVideo() was called. Falls back to
      // the emoji render until the video has real frames. (diagnostic logs once per camera.) ---
      if (this.avatarVideo) {
        if (!this._avatarSeenLogged) { this._avatarSeenLogged = true; console.log('[runway-avatar] _render sees avatarVideo (waiting for frames): rs=' + this.avatarVideo.readyState + ' w=' + this.avatarVideo.videoWidth); }
        if (this.avatarVideo.readyState >= 2 && this.avatarVideo.videoWidth > 0) {
          try {
            ctx.drawImage(this.avatarVideo, 0, 0, w, h);
            if (!this._avatarDrawLogged) { this._avatarDrawLogged = true; console.log('[runway-avatar] FIRST avatar frame drawn to camera ✅ (' + this.avatarVideo.videoWidth + 'x' + this.avatarVideo.videoHeight + ')'); }
            return;
          } catch (e) {
            if (!this._avatarErrLogged) { this._avatarErrLogged = true; console.warn('[runway-avatar] drawImage FAILED (taint/decode?): ' + (e && e.message)); }
          }
        }
      }

      // --- Background: custom SVG (if loaded) or animated gradient fallback ---
      const t = this.frameCount * 0.02;
      if (this.backgroundImage && this.backgroundImage.complete && this.backgroundImage.naturalWidth > 0) {
        // #428: TRUE cover-fit. This comment used to say "cover" while the code
        // did `drawImage(img, 0, 0, w, h)` — a full stretch. Backgrounds are
        // commonly authored square (viewBox="0 0 400 400") while the camera is
        // 16:9, so a circular sun rendered as a 1.78:1 squashed oval. The
        // rasterized image already has any external refs inlined (server-side
        // resolver), so no taint risk.
        drawCover(ctx, this.backgroundImage, w, h);
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
      //      Activity state ticking  → 😑 (reading along, NOT answering). Wins
      //      over `hearing` below, so the glance is visible while someone is
      //      talking — which is the only moment a tick can occur.
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
      const attentive = (this.anyoneSpeaking || stillInGrace) && this.mode !== 'silent'
        && !this.speaking && this.state !== 'thinking' && this.state !== 'speaking' && this.state !== 'yielding';
      // Two faces for one window, split on whether they are STILL talking. The
      // grace half was previously indistinguishable from active listening.
      const hearing = attentive
        ? (this.anyoneSpeaking ? VirtualCamera.HEARING_EMOJI : VirtualCamera.SETTLING_EMOJI)
        : null;
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
      // #38: ranks above deaf. "Can't hear you" presumes someone is home to
      // hear; if nothing is driving the bot, that is the more basic truth and
      // the one worth showing. 🫥 is already this UI's "nobody home" (it is what
      // callStatus shows out of a call), so it reads without a legend.
      const agentAbsentEmoji = this.agentAbsent ? '\u{1FAE5}' : null; // 🫥
      const deafEmoji = this.deaf ? '\u{1F649}' : null; // 🙉
      // #424: impaired ranks just under deaf — deaf is a KNOWN cause (captions
      // off), impaired is "something's wrong and I may not be hearing you".
      const impairedEmoji = this.impaired ? '\u{1F974}' : null; // 🥴
      const emoji =
        notOnLine
        || agentAbsentEmoji
        || deafEmoji
        || impairedEmoji
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
          hearing ? (this.anyoneSpeaking ? `hearing (anyoneSpeaking=true)` : `settling (speech stopped, awaiting turn)`) :
          this.state === 'idle' ? `state=idle${this.idleEmojiOverride ? ' (idle override)' : ' (between turns)'}` :
          `mode=${this.mode}${this.listeningEmojiOverride && this.mode === 'active' ? ' (listening override)' : ' (listening)'}`;
        window.postMessage({
          __botsInCalls: true,
          action: 'log',
          payload: { line: `Avatar → ${emoji} · ${reason}` },
        }, '*');
        // Mirror the face into the control panel. Announced from HERE — the one
        // place that knows what was actually rendered — so the panel never has
        // to re-derive the priority chain above and can't drift from it.
        window.postMessage({
          __botsInCalls: true,
          action: 'avatar-emoji',
          payload: { emoji },
        }, '*');
      }
      // Base "zoom" for the face — native glyph AND every image set use this, so
      // it scales all sets uniformly. 0.77 ≈ +19% over the old 0.65 (Stan: ~840px
      // → ~1000px). The bob/breathe/speaking transforms multiply on top; at that
      // peak jaw-open the glyph can just touch the tile edges, which is fine.
      const emojiSize = Math.min(w, h) * 0.77;
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
      // Thinking state: gentle side-to-side sway.
      //
      // #290 — "the animation into 🤔 has a jump." It did, and it was this line.
      // The sway used to be `state === 'thinking' ? sin(t * 1.2) * 8 : 0` against
      // the FREE-RUNNING clock `t`. That clock's phase has nothing to do with
      // when the state changes, so at the instant the bot entered thinking the
      // term went from exactly 0 to sin(whatever) * 8 — an arbitrary value
      // anywhere in ±8px, applied as a horizontal translate. The head teleported
      // sideways, on average ~5px, in a single frame. Leaving thinking snapped it
      // back the same way. Twice per turn, every turn, which is exactly the
      // "becomes jarring after a while" in the report.
      //
      // The fix is to make the sway both START and END at zero:
      //
      //   1. PHASE is anchored to the moment thinking began, so the first frame
      //      is sin(0) = 0 — the face is exactly where it already was.
      //   2. AMPLITUDE ramps in over SWAY_RAMP_MS, and ramps back out on exit
      //      rather than being cut, so leaving is as smooth as arriving.
      //
      // Wall-clock rather than frameCount, like the tick pulse below: an occluded
      // or throttled view drops frames, and a frame-counted envelope would then
      // ramp in slow motion.
      //
      // 0.72 rad/s preserves the original rate exactly (frameCount * 0.02 * 1.2
      // at 30fps), so the sway itself feels unchanged — only its edges do.
      const SWAY_PX = 8;
      const SWAY_RATE = 0.72;   // rad/s — the pre-#290 rate, kept deliberately
      const SWAY_RAMP_MS = 400;
      const swayNow = Date.now();
      if (this.state === 'thinking') {
        if (!this._swaySince) this._swaySince = swayNow;
        this._swayLeftAt = 0;              // re-entered before the ramp-out finished
      } else if (this._swaySince) {
        if (!this._swayLeftAt) this._swayLeftAt = swayNow;
        if (swayNow - this._swayLeftAt >= SWAY_RAMP_MS) {
          this._swaySince = 0;             // fully faded; stop tracking
          this._swayLeftAt = 0;
        }
      }
      let thinkSway = 0;
      if (this._swaySince) {
        const elapsed = swayNow - this._swaySince;
        const fadeIn = Math.min(1, elapsed / SWAY_RAMP_MS);
        const fadeOut = this._swayLeftAt
          ? Math.max(0, 1 - (swayNow - this._swayLeftAt) / SWAY_RAMP_MS)
          : 1;
        thinkSway = Math.sin((elapsed / 1000) * SWAY_RATE) * SWAY_PX * fadeIn * fadeOut;
      }
      // Background-tick "noted that" pulse — a quick head-tilt + pop that eases
      // out over ~700ms when the avatar enters thinking (set in 'set-bot-state').
      // Framerate-robust via wall-clock. sin gives a smooth 0→1→0.
      //
      // Multi-bot calls all hear the same silence gap at roughly the same
      // real-world moment, so every bot used to enter 'thinking' — and fire
      // this pulse — in perfect lockstep, which read as synchronized rather
      // than as several independent bots each noticing on their own. Each
      // bot is a separate process with no shared state, so the only fix is
      // per-process randomness: 'set-bot-state' jitters the START time and
      // rerolls a random direction (_tickTiltSign) + size (_tickTiltMag) on
      // every firing, so bots visibly drift out of sync with each other.
      const PULSE_MS = 700;
      const pulseAge = Date.now() - (this._tickPulseAt || 0);
      const tickPulse = (pulseAge >= 0 && pulseAge < PULSE_MS) ? Math.sin((pulseAge / PULSE_MS) * Math.PI) : 0;
      const tickTilt = tickPulse * (this._tickTiltSign || 1) * (this._tickTiltMag || 1) * 0.16; // ~9° peak head tilt, direction+size randomized per-fire
      const tickPop = 1 + tickPulse * 0.12; // ~12% peak enlarge

      // "Heard my name" reaction — another participant's speech named the bot
      // directly (set on 'name-mentioned', fired from local-server the first
      // time a caption turn contains the bot's own name). Unlike the tick
      // pulse above (a passing "noted that" blip), this is meant to read as a
      // STATE CHANGE — the dog-cocks-its-head-and-leans-in moment where it's
      // committed to answering — so it snaps into the pose almost instantly
      // (MENTION_ATTACK_MS), HOLDS the pose, then drops out of it quickly.
      //
      // The hold is an explicit phase now. It used to be implied by easing a
      // 5-second decay with cos(p·π/2): that curve does start flat, but stretched
      // over five seconds the flat part is still a slow drift, so what you saw was
      // the bot gradually deflating for most of a sentence rather than holding a
      // pose and then relaxing. Attention is held or it is not — the in-between is
      // what made it read as a fade.
      //
      // The release eases IN (1-p³: slow at first, steep at the end), which is the
      // opposite of the usual ease-out. Ease-out would leave a long shallow tail —
      // exactly the drift being removed.
      // Tilt direction alternates per-mention (_mentionTiltSign, flipped in
      // the 'name-mentioned' handler) so a run of mentions doesn't hold the
      // same cocked pose every time; _mentionTiltMag (re-rolled randomly per
      // mention) varies the peak tilt AMOUNT so the motion doesn't look like
      // an identical mechanical tic every time — organic, not robotic.
      const MENTION_ATTACK_MS = 150;
      const MENTION_HOLD_MS = 900;     // fully leaned in, not moving
      const MENTION_RELEASE_MS = 380;  // and back out, decisively
      const mentionAge = Date.now() - (this._nameMentionPulseAt || 0);
      const MENTION_HOLD_END = MENTION_ATTACK_MS + MENTION_HOLD_MS;
      let mentionPulse = 0;
      if (mentionAge >= 0 && mentionAge < MENTION_ATTACK_MS) {
        mentionPulse = mentionAge / MENTION_ATTACK_MS;
      } else if (mentionAge >= MENTION_ATTACK_MS && mentionAge < MENTION_HOLD_END) {
        mentionPulse = 1;
      } else if (mentionAge >= MENTION_HOLD_END && mentionAge < MENTION_HOLD_END + MENTION_RELEASE_MS) {
        const p = (mentionAge - MENTION_HOLD_END) / MENTION_RELEASE_MS;
        mentionPulse = 1 - p * p * p;
      }
      const mentionTilt = mentionPulse * (this._mentionTiltSign || 1) * (this._mentionTiltMag || 1) * 0.24; // ~14° peak head-cock, ±30% varied
      const mentionPop = 1 + mentionPulse * 0.22; // ~22% peak lean-in grow

      // #326 — head rotation driven by agent log activity (proof-of-life). Each
      // new activity line (pushed by main.js, overlay-independent) snaps the head
      // INSTANTLY to a fresh hash-derived angle, and it HOLDS there until the next
      // line — no ease, no return-to-neutral. Mirrors the instant emoji swaps: the
      // head just ticks to a new lean as the agent works, and rests wherever the
      // last line left it when the agent goes quiet. Peak ≈ ±30°.
      const AGENT_JOSTLE_MAX = 0.52;      // rad, ~30°
      const agentTilt = (this._agentJostleDir || 0) * AGENT_JOSTLE_MAX;

      // While PEEKING (the 🫥 arrival pose, head half below the frame) the same
      // agent-activity signal drives a smaller, sideways version: proof of life
      // during the stretch where the bot is in the call but its agent is still
      // waking up, which was otherwise dead still for ~15s.
      //
      // Not the full ±30°: rotating a half-clipped head about its own centre
      // swings the visible top out of frame and reads as a cartwheel rather than
      // a glance. A third of the tilt plus a small horizontal shift reads as the
      // head peering about instead.
      //
      // Honest limitation: this only moves when there IS activity, and agentLog
      // fills from the session's PostToolUse hook — so nothing happens between
      // the terminal launching and the agent's first tool call. Stillness there
      // is truthful (nothing is happening yet), and claudeReady would be the
      // signal to cover it if that gap ever wants filling.
      const PEEK_TILT_SCALE = 0.34;
      const PEEK_SHIFT_PX = 26;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = emojiFontStack(Math.round(emojiSize));
      // Only for a monochrome font. A COLOUR font ignores fillStyle for its own
      // glyphs anyway, so setting this is harmless there; leaving it unset when
      // no colour was asked for preserves the previous behaviour exactly.
      if (emojiFontColorGlobal) ctx.fillStyle = emojiFontColorGlobal;

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

      // Not-yet-connected "arrival" rise (Kilroy-style), while the emoji is 🫥.
      // The glyph peeks up from the bottom edge — only its top half showing — then
      // rises into place. Pops straight to center the instant the agent engages
      // (emoji is no longer 🫥). Trigger + timing below.
      // Hold peeking at the bottom while joining/waiting; only START the rise once
      // the bot has SUCCESSFULLY ENTERED the call (callStatus 'in-call'), easing up
      // to center. So the rise reads as "arriving in the room," not "still trying
      // to get in."
      //
      // Timing (1s/5.6s -> 4s/11.2s -> 2s/11.2s): the old rise reached center
      // well before the spawned agent finished starting up in its terminal,
      // so the face looked settled and ready while nothing was actually
      // listening yet. The 4s hold fixed that but read as sluggish once the
      // ease-in made the liftoff itself feel deliberate rather than abrupt —
      // 2s is enough to register the peeking pose as intentional without the
      // whole entrance feeling slow.
      //
      // Note it is a canned timer, not a readiness signal — if it still finishes
      // early, the honest fix is to drive it from claudeReady (main.js POSTs
      // /claude-ready when the spawned session is actually up) rather than to keep
      // stretching these numbers.
      const RISE_HOLD_MS = 2000;
      const RISE_DURATION_MS = 11200;
      let ghostRise = 0;
      // The rise is an ARRIVAL animation: the bot peeking over the edge while its
      // agent boots, then settling into place. An agent that has GONE (#38) is
      // the opposite story, and playing the entrance for a departure reads as
      // the bot warming up when it has in fact just died. Same glyph, no
      // entrance — it is simply there, and toppled if we know it is dead.
      if (emoji === '\u{1FAE5}' && !this.agentAbsent) {
        if (this.callStatus === 'in-call') {
          if (!this._riseSince) this._riseSince = Date.now(); // stamp on entry
          const p = Math.max(0, Math.min(1, (Date.now() - this._riseSince - RISE_HOLD_MS) / RISE_DURATION_MS));
          // easeInCubic, not easeOutCubic: a slow start reads as a deliberate
          // liftoff — the previous easeOutCubic started at full speed, which
          // read as a jolt right as the rise began. No ease-out is needed at
          // the tail either; it can arrive at center at full speed.
          const eased = Math.pow(p, 3);
          ghostRise = (1 - eased) * (h - cy);
        } else {
          ghostRise = h - cy;   // not admitted yet — hold peeking at the bottom edge
          this._riseSince = 0;  // reset so the rise starts fresh the moment we enter
        }
      } else {
        this._riseSince = 0;
      }
      // Apply translation + rotation + non-uniform scale around the avatar
      // center. The scaleX/scaleY give the "mouth open" jaw effect.
      // #38: a DROPPED agent keels over. Reserved for the certain case (the
      // socket died, so the process is gone) — a merely-quiet agent might be
      // alive on a permission prompt, and toppling it would assert a death we
      // cannot see. Eased rather than snapped so it reads as falling.
      //
      // 135°, NOT 180°. A half-turn lands the face perfectly inverted, which
      // reads as deliberate — a thing someone rotated. Stopping short leaves it
      // off-axis, which is what makes it look collapsed rather than flipped:
      // the same reason a dead animal reads as dead from its angle alone.
      const DEAD_FLIP_RAD = Math.PI * 0.75;
      const DEAD_FLIP_MS = 700;
      let deadFlip = 0;
      if (this.agentAbsent && this.agentAbsentReason === 'dropped') {
        if (!this._deadSince) this._deadSince = Date.now();
        const p = Math.max(0, Math.min(1, (Date.now() - this._deadSince) / DEAD_FLIP_MS));
        deadFlip = DEAD_FLIP_RAD * (1 - Math.pow(1 - p, 3)); // easeOutCubic
      } else {
        this._deadSince = 0;
      }
      // The turn countdown: a pendulum that swings out and returns to LEVEL at
      // the exact moment the silence gate fires and the bot takes its turn.
      //
      // Level-is-the-endpoint is the point. A fill or a fade has no unmistakable
      // finish, but "back where it started" does, so the room can learn — without
      // being told — how long they have before the bot speaks. The bot answers
      // slower than a human, and those seconds are where people either wait or
      // talk over it.
      //
      // Driven by the server's ABSOLUTE deadline, re-read every frame, because
      // that deadline moves: name-mention resolves faster, and #372's re-arm
      // corrects a late timer. A fixed 1.4s sweep would land wrong often enough
      // to teach the opposite lesson.
      //
      // Suppressed while anyone is still speaking — the window only means
      // anything once the floor is quiet — and while the bot is speaking or
      // yielding, where other motion already owns the face.
      let gateTilt = 0;
      const gate = this.silenceGate;
      if (gate && !this.anyoneSpeaking && !this.speaking
          && this.state !== 'speaking' && this.state !== 'yielding') {
        const span = gate.deadline - gate.from;
        if (span > 0) {
          const p = (Date.now() - gate.from) / span;
          if (p >= 0 && p <= 1) {
            // One half-cycle: 0 → peak → 0. sin(πp) is exactly that, and its
            // slope eases in and out on its own, so no extra easing is needed.
            gateTilt = Math.sin(Math.PI * p) * 0.14; // ~8° peak
          }
        }
      }
      const peeking = ghostRise > 0;
      const agentTiltNow = peeking ? agentTilt * PEEK_TILT_SCALE : agentTilt;
      const peekShift = peeking ? (this._agentJostleDir || 0) * PEEK_SHIFT_PX : 0;
      ctx.translate(cx + thinkSway + peekShift, cy + bob - speakBounce + ghostRise);
      if (speakTilt || tickTilt || agentTiltNow || deadFlip || mentionTilt || gateTilt) {
        ctx.rotate(speakTilt + tickTilt + agentTiltNow + deadFlip + mentionTilt + gateTilt);
      }
      if (this.speaking) {
        ctx.scale(speakScaleX * tickPop * mentionPop, speakScaleY * tickPop * mentionPop);
      } else {
        // Idle/listening/thinking breathing — keeps the glyph subtly alive
        // without the loud jaw motion of the speaking path. (#223)
        ctx.scale(breathe * tickPop * mentionPop, breathe * tickPop * mentionPop);
      }
      // Twemoji set (#316): draw the bundled SVG centered at the origin (all the
      // bob/breathe/lip-sync transforms are already applied, so the image is just
      // as alive as the glyph). Falls back to the native glyph until the image
      // decodes, or forever if the emoji isn't in the set.
      // Only IMAGE sets (fluent3d) go through drawImage. A font-backed set falls
      // to fillText below, where emojiFontStack has already put its family first.
      const emojiImg = (this.emojiSet && this.emojiSet !== 'native' && _isImageSetName(this.emojiSet))
        ? _emojiImage(this.emojiSet, emoji) : null;
      if (emojiImg) {
        ctx.drawImage(emojiImg, -emojiSize / 2, -emojiSize / 2, emojiSize, emojiSize);
      } else {
        ctx.fillText(emoji, 0, 0);
      }
      ctx.restore();

      // Unlike the debug overlay below, this is user-facing (consent/awareness
      // that the call is being recorded) — always drawn when isRecording is
      // true, not gated behind the panel's debug-overlay checkbox. Wrapped for
      // the same reason: a bug here must never black out the actual camera frame.
      if (this.isRecording) { try { this._renderRecordingIndicator(); } catch (e) { /* overlay-only */ } }

      // Wrapped: the overlay is diagnostic chrome — a bug in it must never black
      // out the bot's actual camera frame (which already rendered above).
      if (this.debugOverlayEnabled) { try { this._renderDebugOverlay(); } catch (e) { /* overlay-only */ } }
    }

    _renderRecordingIndicator() {
      const { ctx, canvas } = this;
      const text = '\u{1F534} Recording';
      // Google Sans, not the debug overlay's monospace — this is a user-facing
      // label, not a diagnostic readout, so it should match the app's own UI
      // font (panel.css's body font-family) rather than look like debug text.
      const font = '600 22px "Google Sans", Roboto, Arial, sans-serif';
      // Top-left, not bottom-left: Meet draws its own participant-name label in
      // the bottom-left of the tile, which would collide with (and visually
      // compete against) an indicator there. Extra inset (vs. the debug
      // overlay's 24/16) because Meet crops the camera feed to fit the current
      // window/tile size — a tighter corner position is more likely to survive
      // that crop, though nothing here can guarantee it always will.
      const insetX = 40;
      const insetY = 40;
      ctx.save();
      ctx.font = font;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      // Same "text on TV" treatment as the debug overlay (dark stroke outline
      // + soft shadow) for contrast over any avatar background, then a solid
      // red fill — this is the whole point of the indicator, so it should read
      // as unambiguously red, not blend into the frame.
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;
      const x = insetX;
      const y = insetY;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = '#ea4335'; // matches the app's existing red accent (debug overlay's STALE/DEAF color)
      ctx.save();
      ctx.shadowColor = 'transparent';
      ctx.fillText(text, x, y);
      ctx.restore();
      ctx.restore();
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
        // src / latency / age each on their own line so the left column stays
        // narrow (this metadata was the widest line in the stats column).
        return [
          `ack:      ${phrase}`,
          `          ${src}`,
          `          ${latency}`,
          `          ${ago(ev.at)}`,
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
        // Claude reaction time (resolve → first speak): last + rolling avg.
        // The day-to-day "snappy vs sluggish" signal, mostly Claude not us.
        `resp:     ${(() => {
          const p = d.responsePerf;
          if (!p || !p.count) return '—';
          const s = (ms) => (ms == null ? '?' : (ms / 1000).toFixed(1) + 's');
          return `${s(p.last)} (avg ${s(p.avg)} n=${p.count})`;
        })()}`,
        ...ackLines,
        `queued:   ${(d.pendingBotSpeech || []).length}`,
        `chat:     ${d.chatUnread ? 'UNREAD' : 'none'}`,
        // heard/proc moved to the RIGHT column (above the agent log) — they're
        // the other wide lines, so keeping them out of the left column keeps it
        // narrow and the right column anchored close to the stats.
      ];
      // AGENT — recent activity tailed from the driving Claude session's
      // transcript (proof of life + early "off the rails" signal). Lines are
      // pre-formatted compact strings (🗣 text / 🔧 tool / 💬 prompt). Rendered
      // in full — long lines just run off the right edge of the canvas (no
      // ellipsis), using as much of the surface as fits.
      const agentLines = (() => {
        const log = d.agentLog || [];
        if (!log.length) return ['AGENT', '  (no agent session)'];
        return ['AGENT', ...log.map((l) => '  ' + l)];
      })();
      // PROBE — the slow model's freshest banked interjection (#245), the one
      // that would actually fire next if an opening appears. Only this newest
      // entry is ever fired (_consumeFreshProbe pops the latest); older banked
      // probes just age out, so we show only the latest. Hidden unless
      // probeFiring is on and something is banked.
      const probeLines = (() => {
        const bank = d.probeBank || [];
        if (!bank.length) return [];
        const latest = bank[bank.length - 1];
        const fired = d.lastProbeFiredAt ? `  (last fired ${ago(d.lastProbeFiredAt)})` : '';
        return [
          'PROBE' + fired,
          `▸ "${String(latest.text || '').replace(/\s+/g, ' ').trim()}" ${ago(latest.at)}`,
          '',
        ];
      })();
      // #overlay: each cluster is gated by its category toggle (health / captions
      // / agentLog / experiments). Sections are joined with a blank separator,
      // skipping empty ones, so disabling a category leaves no gap.
      const F = this.debugOverlayFlags || { health: true };
      const joinSections = (sections) => {
        const out = [];
        for (const sec of sections) {
          if (!sec || !sec.length) continue;
          if (out.length) out.push('');
          out.push(...sec);
        }
        return out;
      };
      // Right column: banked probes (experiments), the wide caption lines
      // (captions), and the agent activity tail (agentLog).
      const rightLines = joinSections([
        F.experiments ? probeLines.filter((l) => l !== '') : null,
        F.captions ? [heard, proc] : null,
        F.agentLog ? agentLines : null,
      ]);
      // EXP — the active experiment/timing knobs (#273), so anyone in the call
      // can read off which flags a given bot is running. Values are the
      // EFFECTIVE settings (store override or schema default), resolved server-
      // side. on/off booleans render ON/off; numbers render as-is.
      const expLines = (() => {
        const e = d.experiments;
        if (!e) return [];
        const onoff = (v) => (v ? 'ON' : 'off');
        const num = (v) => (v == null ? '?' : String(v));
        return [
          'EXP',
          `silence:  ${num(e.defaultSilenceSeconds)}s`,
          `probe:    ${onoff(e.probeFiring)}`,
          `probeMs:  ${num(e.probeSilenceMs)}`,
          `tickWord: ${num(e.backgroundTickWords)}`,
          `triageAck:${onoff(e.triageAck)}`,
        ];
      })();
      // Left column: bot health (CALL + LOOP + response time), and the
      // experiment flags (experiments). Gated per #overlay category.
      const leftLines = joinSections([
        F.health ? [...callLines, '', ...loopLines] : null,
        F.experiments ? expLines : null,
      ]);

      const pad = 16;
      // 27px leading keeps the now-taller left column (CALL+LOOP+EXP, ~25 lines)
      // within the 720px canvas — at 30px the last EXP lines clipped off-frame.
      const lineH = 27;
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
      // Headers yellow; STALE loop / DEAF caps / ack-fallback red; heard blue;
      // proc teal; rest light grey.
      const colorFor = (ln) => {
        if (ln === 'CALL' || ln === 'LOOP' || ln === 'AGENT' || ln === 'EXP') return '#fdd663';
        if (ln.startsWith('PROBE')) return '#fdd663';
        // The freshest banked probe (the one that fires next) pops green.
        if (ln.startsWith('▸ ')) return '#81c995';
        // EXP flags that are ON pop green so an active experiment is obvious.
        if ((ln.startsWith('probe:') || ln.startsWith('triageAck')) && ln.includes('ON')) return '#81c995';
        // Claude reaction-time health: colour the resp: line by the LAST value
        // (the headline number). <3s green, 3–4s yellow, >4s red. Mirrors the
        // panel's perfDot() thresholds.
        if (ln.startsWith('resp:')) {
          const mm = ln.match(/resp:\s*([\d.]+)s/);
          if (mm) { const v = parseFloat(mm[1]); return v < 3 ? '#81c995' : v <= 4 ? '#fdd663' : '#ea4335'; }
          return '#e8eaed';
        }
        if (ln.startsWith('loop:') && ln.includes('STALE')) return '#ea4335';
        if (ln.includes('fallback') && (ln.startsWith('ack:') || ln.startsWith('          '))) return '#ea4335';
        if (ln.startsWith('caps:') && ln.includes('DEAF')) return '#ea4335';
        if (ln.startsWith('heard:')) return '#8ab4f8';
        if (ln.startsWith('proc:')) return '#5bd1c4';
        return '#e8eaed';
      };
      const drawColumn = (colLines, x) => {
        for (let i = 0; i < colLines.length; i++) {
          const ln = colLines[i];
          const y = boxY + pad + i * lineH;
          ctx.fillStyle = colorFor(ln);
          // Outline first (carries the shadow), then the colored fill on top
          // with the shadow disabled so it doesn't muddy the glyph interior.
          ctx.strokeText(ln, x, y);
          ctx.save();
          ctx.shadowColor = 'transparent';
          ctx.fillText(ln, x, y);
          ctx.restore();
        }
      };
      // Fixed columns (left 1/3, right 2/3 of the canvas) so the right column
      // doesn't jump around as the stats text changes width.
      const leftX = boxX + pad;
      const rightX = canvas.width / 3;
      drawColumn(leftLines, leftX);
      drawColumn(rightLines, rightX);
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
      return this._playBuffer(buf, 0);
    }

    // #350: resume a previously-decoded buffer from `offset` seconds in — the
    // audio-level sibling of the fresh-TTS path. Same lip-sync tap + source
    // bookkeeping; only the start offset differs.
    async playAudioBuffer(buf, offset) {
      return this._playBuffer(buf, Math.max(0, offset || 0));
    }

    // Shared playback core. Tracks the decoded buffer and the wall-clock start
    // (plus the in-buffer offset it began at) so stopAudio() can report how far
    // we actually got — the seam #350 resumes from.
    _playBuffer(buf, offset = 0) {
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.destination);
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
  // dropping it. { buf, playedTo, emoji, at } or null.
  let interruptedTts = null;

  async function playNextTTS() {
    if (ttsPlaying || ttsQueue.length === 0) return;
    ttsPlaying = true;
    const { audioData, resumeBuf, offset, emoji } = ttsQueue.shift();
    currentSpeakingEmoji = emoji || null;
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
      // #350: a resume item carries an already-decoded buffer + offset; a fresh
      // utterance carries encoded audioData.
      if (resumeBuf) {
        await mic.playAudioBuffer(resumeBuf, offset);
      } else {
        await mic.playAudio(audioData);
      }
    } catch (err) {
      console.error('[bots-in-calls] TTS playback error:', err);
    }
    ttsPlaying = false;
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
    for (const cam of cameras.values()) {
      cam.speaking = false;
      cam.speakingEmojiOverride = null;
    }
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

  // Module-scope debug overlay state. Persisted here so that a `set-debug-
  // overlay` message arriving BEFORE any VirtualCamera exists (which happens
  // on Meet reload — preload runs at document_start, Meet calls getUserMedia
  // later) still takes effect on the camera the moment it's created.
  let debugOverlayEnabledGlobal = false;
  // Per-category overlay flags (#overlay). Defaults mirror main.js OVERLAY_DEFAULTS
  // (health on, rest off) so a camera created before the first push still renders
  // sensibly.
  let debugOverlayFlagsGlobal = { health: true, captions: false, agentLog: false, experiments: false };
  let debugInfoLatest = null;
  // Same latching reasoning as debugOverlayEnabledGlobal above, but for the
  // recording indicator: 'start-recording' can arrive before any VirtualCamera
  // exists (recording auto-starts on join, same tick a fresh Meet session
  // spins up its camera), so this must be readable at construction time.
  let isRecordingGlobal = false;
  let emojiSetGlobal = 'native'; // 'native' | 'twemoji' — pushed from main (#316)
  let emojiFontGlobal = '';      // a family installed on the user's machine, or '' for the system font
  let emojiFontColorGlobal = ''; // fill colour for a monochrome font; '' = leave the canvas default

  // The family name goes straight into the canvas font SHORTHAND, which is CSS.
  // A name containing a quote, semicolon or brace could close the family and
  // append declarations, and a malformed shorthand makes ctx.font a silent no-op
  // — the assignment is simply ignored and the previous font stays, so the face
  // would render in the wrong font with nothing logged. Strip anything that
  // isn't plausibly part of a family name, then quote it.
  function sanitizeFontFamily(name) {
    const s = String(name == null ? '' : name).replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 120);
    return s;
  }
  // `font:<Family>` optionally carries a colour: `font:UnifontExMono#ffcc00`.
  // A monochrome font has no colour of its own, so without this it draws in
  // whatever fillStyle happens to be — the canvas default, black. Same reason
  // the colour rides in this string rather than a preference of its own: it is
  // part of one answer to "how is the face drawn".
  //
  // Validated to strict hex before it reaches fillStyle. An invalid fillStyle is
  // IGNORED SILENTLY, exactly like a malformed ctx.font, so a typo would draw
  // the previous colour with nothing logged.
  function parseEmojiFontValue(raw) {
    const m = /^font:([^#]+)(?:#([0-9A-Fa-f]{3,8}))?$/.exec(String(raw || ''));
    if (!m) return null;
    return { family: sanitizeFontFamily(m[1]), color: m[2] ? '#' + m[2] : '' };
  }
  function emojiFontStack(px) {
    // Order: a font the USER named, then the bundled set's font, then serif.
    // serif is always the tail so anything missing falls through to the OS emoji
    // font rather than rendering tofu.
    const families = [];
    if (emojiFontGlobal) families.push(`"${emojiFontGlobal}"`);
    if (EMOJI_FONT_SETS[emojiSetGlobal]) families.push(`"${_fontFamilyFor(emojiSetGlobal)}"`);
    families.push('serif');
    return `${px}px ${families.join(', ')}`;
  }

  // Emoji image sets (#316): draw the avatar's emoji from a bundled SVG set
  // instead of the OS font. The preload exposes __vibeEmojiSvg(relPath) — it has
  // fs; page-inject (eval'd into the preload global) doesn't reliably — and we
  // cache a data-URI Image per resolved path. Same data-URI→canvas path the
  // avatar background uses, so it never taints the captured stream. Any emoji not
  // in the chosen set → null → native glyph.
  //
  // Each set is a filename convention over the emoji's Unicode codepoints. Adding
  // a set = vendor its SVGs under emoji/<dir>/ and add one entry here.
  //   twemoji  — lowercase hex, "-", drops FE0F (except in ZWJ sequences)
  //   openmoji — UPPERCASE hex, "-", fully qualified (keeps FE0F)
  const _emojiImgCache = new Map(); // relPath -> Image (loaded) | null (loading/failed)
  function _emojiHex(emoji, { sep, upper, dropFe0f }) {
    let cps = Array.from(String(emoji)).map((c) => c.codePointAt(0));
    if (dropFe0f && !cps.includes(0x200d)) cps = cps.filter((cp) => cp !== 0xfe0f);
    const s = cps.map((cp) => cp.toString(16)).join(sep);
    return upper ? s.toUpperCase() : s;
  }
  // Each set's canonical filename = the emoji's codepoints under one convention.
  // We normalize name-based sets (Fluent) to this canonical form at VENDOR time,
  // so every set here is just { dir, ext } and shares one filename rule.
  const _canon = (e) => _emojiHex(e, { sep: '-', upper: false, dropFe0f: true });
  const EMOJI_SETS = {
    fluent3d: { dir: 'fluent3d', file: (e) => _canon(e) + '.png' },
    redpanda: { dir: 'redpanda', file: (e) => _canon(e) + '.png' },
  };

  // twemoji / openmoji / noto ship as COLOUR FONTS, not ~11,900 files. Each set
  // becomes one FontFace loaded from bytes the preload hands over, and the face
  // is then drawn as a GLYPH — the same code path as 'native', just a different
  // family. Verified inside the real Meet page: it renders in colour, and CSP
  // never applies because a FontFace from an ArrayBuffer has no URL to check.
  //
  // The family names are ours, not the fonts' own: what matters is that they
  // cannot collide with something installed on the user's machine, so a glyph
  // drawn under them provably came from our bytes.
  const EMOJI_FONT_SETS = { twemoji: 1, openmoji: 1, noto: 1 };
  const _fontFamilyFor = (setName) => 'VibeEmoji-' + setName;
  const _fontLoading = new Set();
  function _ensureEmojiFont(setName) {
    if (!EMOJI_FONT_SETS[setName]) return;
    if (_fontLoading.has(setName)) return;             // in flight or done
    _fontLoading.add(setName);
    const getBytes = (typeof globalThis !== 'undefined') && globalThis.__vibeEmojiFontBytes;
    if (!getBytes || typeof FontFace === 'undefined') return;
    let bytes = null;
    try { bytes = getBytes(setName); } catch { bytes = null; }
    if (!bytes) {
      console.warn('[bots-in-calls] No font bytes for set', setName, '— faces stay native');
      return;
    }
    try {
      const ff = new FontFace(_fontFamilyFor(setName), bytes);
      ff.load().then(() => {
        document.fonts.add(ff);
        console.log('[bots-in-calls] Emoji font ready:', setName);
      }).catch((e) => {
        // Leave it un-added: the font stack falls through to the OS emoji font,
        // so the bot keeps a face rather than rendering tofu.
        console.warn('[bots-in-calls] Emoji font failed:', setName, e && e.message);
      });
    } catch (e) {
      console.warn('[bots-in-calls] FontFace rejected for', setName, e && e.message);
    }
  }
  // `dir:<path>` — a folder of images the user or an agent made, resolved by the
  // preload (the page has no fs). Same contract as a bundled image set: a data
  // URI, or null for "not in this set", which falls back to the native glyph.
  const _dirOf = (setName) => {
    const m = /^dir:(.+)$/.exec(String(setName || ''));
    return m ? m[1].trim() : null;
  };
  const _isImageSetName = (setName) => !!EMOJI_SETS[setName] || !!_dirOf(setName);

  function _emojiImage(setName, emoji) {
    const dir = _dirOf(setName);
    if (dir) {
      const resolveDir = (typeof globalThis !== 'undefined') && globalThis.__vibeEmojiDirUri;
      if (!resolveDir) return null;
      const key = 'dir:' + dir + '|' + emoji;
      if (_emojiImgCache.has(key)) return _emojiImgCache.get(key);
      _emojiImgCache.set(key, null);
      let uri = null;
      try { uri = resolveDir(dir, emoji); } catch { uri = null; }
      if (!uri) return null;
      const dimg = new Image();
      dimg.onload = () => { _emojiImgCache.set(key, dimg); };
      dimg.onerror = () => { _emojiImgCache.set(key, null); };
      dimg.src = uri;
      return null;
    }
    const set = EMOJI_SETS[setName];
    const resolve = (typeof globalThis !== 'undefined') && globalThis.__vibeEmojiDataUri;
    if (!set || !resolve) return null;
    const rel = set.dir + '/' + set.file(emoji);
    if (_emojiImgCache.has(rel)) return _emojiImgCache.get(rel);
    _emojiImgCache.set(rel, null); // mark seen; native glyph until (if) it decodes
    const dataUri = resolve(rel);
    if (!dataUri) return null; // not in the set → native glyph
    const img = new Image();
    img.onload = () => { _emojiImgCache.set(rel, img); };
    img.onerror = () => { _emojiImgCache.set(rel, null); };
    img.src = dataUri;
    return null;
  }

  // Last-known avatar/call state, kept at module scope for the SAME reason as the
  // debug-overlay globals: state messages (set-call-status / set-bot-state /
  // set-mode / set-avatar-*) are pushed only on CHANGE, so a VirtualCamera created
  // AFTER those messages (e.g. the camera being toggled on mid-call re-acquires
  // the video stream → a fresh camera) must seed from here or it resets to the
  // 🫥 idle default and stays there while the bot is actually engaged. The set-*
  // handlers update both every live camera AND this object.
  const avatarState = {
    state: 'idle', mode: 'active', callStatus: 'idle', hasEngaged: false,
    deaf: false, impaired: false, idleEmojiOverride: null, listeningEmojiOverride: null,
    yieldingEmojiOverride: null, backgroundImage: null, emojiSet: 'native',
  };

  // P2: latch the avatar video so a camera created AFTER the track arrives (or recreated on a
  // camera toggle) still picks it up — otherwise the avatar is dropped on a timing race. (codex.)
  let pendingAvatarVideo = null;

  function getCamera(width, height) {
    const key = `${width}x${height}`;
    if (!cameras.has(key)) {
      const cam = new VirtualCamera(width, height);
      if (pendingAvatarVideo) cam.setAvatarVideo(pendingAvatarVideo);
      cameras.set(key, cam);
      console.log('[bots-in-calls] Created virtual camera:', key, 'pendingAvatar=', !!pendingAvatarVideo);
    }
    return cameras.get(key);
  }

  // P2 bridge — lets runway-avatar.js (separate page script) drive the Runway face: set the
  // avatar <video> on every VirtualCamera (+ latch it for cameras created later), and read the
  // bot's TTS mic track to publish to Runway (rebuild-aware getTrack(), survives the Slack
  // stop()/rebuild). No-ops on the default emoji path (only used when a connect message fires).
  window.__vibeSetAvatarVideo = (el) => {
    pendingAvatarVideo = el || null;
    let n = 0; try { cameras.forEach((c) => { n++; c.setAvatarVideo && c.setAvatarVideo(pendingAvatarVideo); }); } catch (e) { console.warn('[bots-in-calls] setAvatarVideo bridge:', e && e.message); }
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
      tracks.push(camera.getTrack());
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
    const inElectron = typeof window.__vibeconf_getScreenShareSource === 'function';
    if (inElectron) {
      constraints = { ...(constraints || {}), audio: true };
      if (!constraints.video) constraints.video = true; // audio-only requests are rejected
    }
    const stream = await _getDisplayMedia.call(navigator.mediaDevices, constraints);
    if (inElectron) installShareAudioGain(stream);
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

      case 'set-speaking':
        for (const cam of cameras.values()) cam.speaking = !!payload;
        break;

      case 'set-bot-state':
        // Update avatar state: 'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'yielding'
        if (payload?.state) {
          for (const cam of cameras.values()) {
            // Brief "noted that" pulse on entering thinking — this is what a
            // background_tick (#245) causes, so the avatar tilts+pops to signal
            // the slow model just surfaced. Harmless before a normal response too.
            //
            // Jittered start + re-rolled direction/size so multiple bots on the
            // same call — which all notice the same silence gap at roughly the
            // same instant — don't visibly tilt in perfect lockstep. TICK_JITTER_MS
            // delays the pulse's start (Date.now() in the future is fine: the
            // render loop's pulseAge just stays negative, so nothing shows,
            // until real time catches up to it).
            if (payload.state === 'thinking' && cam.state !== 'thinking') {
              const TICK_JITTER_MS = 250;
              cam._tickPulseAt = Date.now() + Math.random() * TICK_JITTER_MS;
              cam._tickTiltSign = Math.random() < 0.5 ? -1 : 1;
              cam._tickTiltMag = 0.7 + Math.random() * 0.6; // ±30% around the base peak tilt
            }
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

      // The countdown to the bot taking its turn (absolute deadline, or null).
      // Absolute rather than a duration because the server re-arms: a duration
      // captured at arm time would be stale the moment the gate is corrected.
      case 'set-silence-gate':
        for (const cam of cameras.values()) {
          cam.silenceGate = payload && payload.deadline ? payload : null;
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

      case 'name-mentioned': {
        // Another participant's speech named the bot directly — the same
        // detection that lets a passive/silent bot wake up and answer (#343).
        // Brief head-tilt + "leaning in" grow, like a dog cocking its head at
        // the sound of its name. Side still ALTERNATES (not random) so back-
        // to-back mentions stay visually distinguishable as separate events;
        // the peak-tilt SIZE is re-rolled randomly each time so the motion
        // doesn't look like a mechanical, identical-amplitude tic.
        const mag = 0.7 + Math.random() * 0.6; // ±30% around the base peak tilt
        for (const cam of cameras.values()) {
          cam._nameMentionPulseAt = Date.now();
          cam._mentionTiltSign = -(cam._mentionTiltSign || 1);
          cam._mentionTiltMag = mag;
        }
        console.debug('[bots-in-calls] Name mentioned — avatar reaction fired');
        break;
      }

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
        // Forwarded from local-server; see electron-app/call-phase.js for the
        // lifecycle. Used to show 🫥 before the bot is actually in the call.
        if (payload?.status) {
          // A finished call re-gates engagement so the NEXT one starts at 🫥
          // again. 'after-call-work' is deliberately absent: the agent is still
          // working, and blanking its face mid-wrap-up would say it had gone.
          const resets = payload.status === 'idle' || payload.status === 'navigating' ||
            payload.status === 'joining' || payload.status === 'call-complete';
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
          interruptedTts = { buf: stopped.buf, playedTo: stopped.playedTo, emoji: currentSpeakingEmoji, at: Date.now() };
          console.log('[bots-in-calls] stop-tts retained ' +
            (stopped.buf.duration - stopped.playedTo).toFixed(1) + 's tail for possible resume (#350)');
        } else {
          interruptedTts = null;
        }
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
        ttsQueue.push({ resumeBuf: interruptedTts.buf, offset: resumeAt, emoji: interruptedTts.emoji });
        interruptedTts = null;
        playNextTTS();
        break;
      }

      case 'set-agent-absent':
        // #38: nothing is driving the bot — show 🫥 rather than a resting face
        // that implies someone is listening.
        if (payload) {
          const away = !!payload.absent;
          const why = payload.reason || null;
          for (const cam of cameras.values()) { cam.agentAbsent = away; cam.agentAbsentReason = why; }
          avatarState.agentAbsent = away; // seed future cameras
          avatarState.agentAbsentReason = why;
        }
        break;

      case 'set-impaired':
        // #424: generic degraded-state flag → avatar shows 🥴. Raised when the
        // bot suspects it isn't hearing (captions ON but stale, renderer
        // freeze). payload.reason is logged for the operator.
        if (payload) {
          const on = !!payload.impaired;
          for (const cam of cameras.values()) cam.impaired = on;
          avatarState.impaired = on; // seed future cameras
          console.log('[bots-in-calls] impaired =', on, payload.reason ? '(' + payload.reason + ')' : '');
        }
        break;

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

      case 'set-emoji-set':
        // Which emoji graphics the avatar draws: 'native' (OS font) or 'twemoji'
        // (bundled SVG set, #316). Module-scope var seeds cameras created later.
        if (payload) {
          // One value answers "how is the face drawn": a bundled set name, or
          // `font:<Family>` for a font installed on the user's machine. Encoding
          // the font here rather than in a second preference means there is no
          // precedence rule between the two to remember, get wrong, or explain.
          const raw = String(payload.emojiSet == null ? 'native' : payload.emojiSet);
          const asFont = parseEmojiFontValue(raw);
          emojiFontGlobal = asFont ? asFont.family : '';
          emojiFontColorGlobal = asFont ? asFont.color : '';
          emojiSetGlobal = (!asFont
            && (raw === 'native' || EMOJI_SETS[raw] || EMOJI_FONT_SETS[raw] || _dirOf(raw)))
            ? raw : 'native';
          _ensureEmojiFont(emojiSetGlobal);
          avatarState.emojiSet = emojiSetGlobal;
          for (const cam of cameras.values()) cam.emojiSet = emojiSetGlobal;
          console.log('[bots-in-calls] Emoji set:', emojiSetGlobal,
            emojiFontGlobal ? '(font: ' + emojiFontGlobal
              + (emojiFontColorGlobal ? ' ' + emojiFontColorGlobal : '') + ')' : '');
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
          if (payload.flags) debugOverlayFlagsGlobal = payload.flags;
          for (const cam of cameras.values()) {
            cam.debugOverlayEnabled = debugOverlayEnabledGlobal;
            cam.debugOverlayFlags = debugOverlayFlagsGlobal;
          }
          console.log('[bots-in-calls] Debug overlay:', payload.enabled ? 'on' : 'off', payload.flags ? JSON.stringify(payload.flags) : '');
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

      case 'agent-activity':
        // #326 — overlay-independent proof-of-life feed. main.js sends this
        // only when the driving Claude session's latest activity line changes.
        // Stamp each camera so the render tick jostles the head, with a hash of
        // the line picking the lean direction (varies per activity, ± lean).
        if (payload && payload.latest) {
          let h = 0;
          const s = String(payload.latest);
          for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
          const dir = ((Math.abs(h) % 2000) / 1000) - 1; // -1..1
          for (const cam of cameras.values()) {
            cam._agentJostleDir = dir;
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
  // track + a manifest). Meet hands each remote participant its OWN WebRTC track
  // — measured independent in a 3-party call (#209) — so "remote-*" tracks are
  // genuinely per-participant, not one shared mix. They're labeled by arrival
  // order, not name; Meet can also emit extra/initially-silent tracks.
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
    // track is that speaker — vote it. Only sole-speaker moments count, so
    // overlap never mis-attributes. Best guess is pushed to main as it firms up.
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
      isRecordingGlobal = true;
      for (const cam of cameras.values()) cam.isRecording = true;
    } else if (event.data.action === 'stop-recording') {
      callRecorder.stop();
      isRecordingGlobal = false;
      for (const cam of cameras.values()) cam.isRecording = false;
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
