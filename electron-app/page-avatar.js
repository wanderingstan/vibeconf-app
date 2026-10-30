// page-avatar.js: the bot's emoji avatar, an app plugin on page-inject's media
// core (Phase 2 of the calls library). page-scripts.js loads it right after
// page-inject.js, into the same page world.
//
// The core camera (CameraSurface) owns the canvas, the captured track and the
// render loop; this registers an AvatarFace per camera through
// window.__vibeconfMedia.setCameraRenderer and draws the face on every frame.
// The face follows the app's state messages (set-bot-state, set-call-status,
// set-emoji-set, …), and the core's 'bot-speaking' and 'recording' events.
// A video avatar (Runway) replaces the face at the core, through
// setVideoSource, without this file knowing.

(function () {
  'use strict';

  const media = window.__vibeconfMedia;
  if (!media) { console.warn('[bots-in-calls] page-avatar: no media core (page-inject.js) — no face'); return; }

  // The bot's name, for the arrival card and the posture seed. Arrives on
  // set-call-status.
  const config = { botName: 'AI Assistant' };

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
  // AvatarFace — the bot's emoji face, drawn on the core camera's canvas
  // (page-inject's CameraSurface) one frame at a time
  // ---------------------------------------------------------------------------

  class AvatarFace {
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

    // Total length of the "heard my name" pulse in _render (attack + hold +
    // release). The posture's sit-up move is timed to this, so the pulse's
    // release lands on the held, attentive pose instead of fighting it.
    static MENTION_PULSE_MS = 150 + 900 + 380;

    // surface: the CameraSurface this face draws on (its canvas and 2d context).
    constructor(surface) {
      this.surface = surface;
      this.canvas = surface.canvas;
      this.ctx = surface.ctx;
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
    }

    // The core camera calls this once per frame.
    render() { this._render(); }




    _render() {
      const { canvas, ctx } = this;
      const w = canvas.width;
      const h = canvas.height;
      this.frameCount++;

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
      const notOnLine = AvatarFace.CALL_STATUS_EMOJIS[this.callStatus] || (!this.hasEngaged ? '\u{1FAE5}' : null);
      // When the bot started TRYING TO JOIN — the arrival card needs it to
      // escalate from "on the way" to "having trouble".
      //
      // Deliberately NOT "when notOnLine began". `idle` is a not-on-line status
      // too, so that version measured time since the app had nothing to do: an
      // app sitting on its Settings screen while someone created a profile was
      // already 15s+ "late" before it ever attempted a call, and the card opened
      // straight on "having trouble connecting" with the on-the-way window never
      // shown at all. Seen live 2026-08-24, the first time a brand-new bot was
      // created in front of anyone.
      //
      // A join ATTEMPT is what deserves a clock, so it starts at navigating and
      // resets whenever we fall back to a resting status.
      const attempting = notOnLine && this.callStatus !== 'idle' && this.callStatus !== 'left';
      if (attempting) { if (!this._notOnLineSince) this._notOnLineSince = Date.now(); }
      else this._notOnLineSince = 0;
      // Audio playing: per-response override > default 😄. Cleared on tts-ended.
      // Suppressed when state === 'thinking' so the ack stays under 🤔.
      const audioPlaying = (this.speaking && this.state !== 'thinking')
        ? (this.speakingEmojiOverride || AvatarFace.ACTIVITY_EMOJIS.speaking)
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
      // #824: never while the bot is busy. 😐/🫤 tell the room "I'm listening";
      // a bot heads-down in tools can't respond, so saying that is a lie. The
      // activity face already outranks `hearing` in the chain below — this guard
      // makes the rule explicit rather than an accident of ordering.
      const attentive = (this.anyoneSpeaking || stillInGrace) && this.mode !== 'silent'
        && !this.speaking && this.state !== 'thinking' && this.state !== 'working'
        && this.state !== 'speaking' && this.state !== 'yielding';
      // Two faces for one window, split on whether they are STILL talking. The
      // grace half was previously indistinguishable from active listening.
      const hearing = attentive
        ? (this.anyoneSpeaking ? AvatarFace.HEARING_EMOJI : AvatarFace.SETTLING_EMOJI)
        : null;
      const activityEmoji = this.state === 'yielding'
        ? (this.yieldingEmojiOverride || AvatarFace.ACTIVITY_EMOJIS.yielding)
        : AvatarFace.ACTIVITY_EMOJIS[this.state];
      // Resting emojis: agent overrides take priority over defaults when in
      // the corresponding state. Listening override only applies in 'active'
      // mode (passive/silent emojis encode a specific user-controlled state).
      const idleEmoji = this.idleEmojiOverride || AvatarFace.IDLE_EMOJI;
      const listeningEmoji = (this.mode === 'active' && this.listeningEmojiOverride)
        ? this.listeningEmojiOverride
        : AvatarFace.MODE_EMOJIS[this.mode] || AvatarFace.MODE_EMOJIS.active;
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
        // #824: the reason follows the SAME chain as the emoji. It used to skip
        // agentAbsent/deaf/impaired, so a 🫥 shown for a quiet agent was logged as
        // "hearing (anyoneSpeaking=true)" — a lie that sent the issue looking in
        // the wrong place.
        const reason = notOnLine ? `callStatus=${this.callStatus} hasEngaged=${this.hasEngaged}` :
          agentAbsentEmoji ? `agent absent (${this.agentAbsentReason || 'quiet'})` :
          deafEmoji ? 'deaf' :
          impairedEmoji ? 'impaired' :
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
        const amp = media.speechLevel();
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
      // new activity line (pushed by main.js, overlay-independent) moves the head
      // to a fresh hash-derived angle, and it HOLDS there until the next line —
      // no return-to-neutral. (It used to snap there in one frame; the combined
      // tilt smoother now eases the move over TILT_EASE_MS, ~½ s.) Mirrors the instant emoji swaps: the
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
      // Rotation pivot for the face, as a fraction of its size below centre: 2/3
      // of the way down the face is 1/6 below its middle.
      const NECK_PIVOT_FROM_CENTRE = 2 / 3 - 1 / 2;
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
      const GATE_TILT_MAX_RATE = 0.8; // rad/s — see the smoothing note after the sweep
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
      // ...but every one of those guards cuts the sweep mid-swing when it flips:
      // the human carries on talking (anyoneSpeaking), the gate is cleared or
      // re-armed, the bot starts speaking. The pendulum then dropped from up to
      // ~8° to level in ONE frame — the jolt Stan saw in
      // teams-9361264884308-20261016T151416Z, ~2 min in. The pendulum never
      // legitimately moves faster than ~0.55 rad/s (8° over the shortest real
      // window), so its own smoother can afford a low rate limit and catch even
      // small cuts; the combined smoother below catches the big jumps of the rest.
      const tiltApi = globalThis.__vibeAvatarPosture;
      const canSmoothTilt = !!(tiltApi && typeof tiltApi.smoothTilt === 'function');
      if (canSmoothTilt) {
        if (!this._gateTiltSmooth) this._gateTiltSmooth = tiltApi.createTiltSmoother();
        gateTilt = tiltApi.smoothTilt(this._gateTiltSmooth, gateTilt, Date.now(), GATE_TILT_MAX_RATE);
      }
      const peeking = ghostRise > 0;
      const agentTiltNow = peeking ? agentTilt * PEEK_TILT_SCALE : agentTilt;
      const peekShift = peeking ? (this._agentJostleDir || 0) * PEEK_SHIFT_PX : 0;
      // Resting posture + occasional shifts (avatar-posture.js). Under every
      // other motion: it moves the face's home, and bob/sway/tilts play around
      // that. Null when the pref is off or the module didn't load → centred.
      let post = null;
      try { post = currentAvatarPosture(w, h, this.speaking); } catch (e) { post = null; }
      const postX = post ? post.dx * w : 0;
      const postY = post ? post.dy * h : 0;
      const postScale = post ? post.scale : 1;
      ctx.translate(cx + postX + thinkSway + peekShift, cy + postY + bob - speakBounce + ghostRise);
      // One smoothing for the whole rotation (avatar-posture.js smoothTilt):
      // continuous motion passes through unchanged, and any term that jumps —
      // the agent jostle, the dead flip and its revival, peeking ending, a cut
      // pendulum — eases to its new angle instead of snapping there.
      let tilt = speakTilt + tickTilt + agentTiltNow + deadFlip + mentionTilt + gateTilt;
      if (canSmoothTilt) {
        if (!this._tiltSmooth) this._tiltSmooth = tiltApi.createTiltSmoother();
        tilt = tiltApi.smoothTilt(this._tiltSmooth, tilt, Date.now());
      }
      if (Math.abs(tilt) > 1e-5) {
        // Tilt around a "neck", not the face's centre. Rotating about the middle
        // spun the face like a wheel; a pivot two-thirds of the way down reads
        // as a head tilting (Stan, 2026-10-15). Not at the very bottom — that
        // swings the top too far for the same angle.
        const neckY = emojiSize * NECK_PIVOT_FROM_CENTRE;
        ctx.translate(0, neckY);
        ctx.rotate(tilt);
        ctx.translate(0, -neckY);
      }
      if (this.speaking) {
        ctx.scale(speakScaleX * tickPop * mentionPop * postScale, speakScaleY * tickPop * mentionPop * postScale);
      } else {
        // Idle/listening/thinking breathing — keeps the glyph subtly alive
        // without the loud jaw motion of the speaking path. (#223)
        ctx.scale(breathe * tickPop * mentionPop * postScale, breathe * tickPop * mentionPop * postScale);
      }
      // Twemoji set (#316): draw the bundled SVG centered at the origin (all the
      // bob/breathe/lip-sync transforms are already applied, so the image is just
      // as alive as the glyph). Falls back to the native glyph until the image
      // decodes, or forever if the emoji isn't in the set.
      // Only IMAGE sets (fluent3d) go through drawImage. A font-backed set falls
      // to fillText below, where emojiFontStack has already put its family first.
      const emojiImg = (this.emojiSet && this.emojiSet !== 'native' && _isImageSetName(this.emojiSet))
        ? _emojiImage(this.emojiSet, emoji) : null;
      // NOT ON THE LINE: draw an arrival card instead of a tile-filling face.
      //
      // 🫥 was meant to say "the agent isn't here yet", and it does not work.
      // New users start talking to the bot the moment it appears and are
      // confused when nothing answers. The reason is that it is still a FACE,
      // and a face filling a Meet tile means somebody is there; the dots are a
      // subtlety nobody parses on their first call.
      //
      // A small thumbnail beside a line of text reads as a photo on a name badge
      // rather than as presence — the same asset, a different meaning, purely
      // from scale.
      if (notOnLine) {
        ctx.restore();
        try { this._renderArrivalCard(emojiImg, emoji); } catch (e) { /* overlay-only */ }
      } else if (emojiImg) {
        ctx.drawImage(emojiImg, -emojiSize / 2, -emojiSize / 2, emojiSize, emojiSize);
        ctx.restore();
      } else {
        ctx.fillText(emoji, 0, 0);
        ctx.restore();
      }

      // Unlike the debug overlay below, this is user-facing (consent/awareness
      // that the call is being recorded) — always drawn when isRecording is
      // true, not gated behind the panel's debug-overlay checkbox. Wrapped for
      // the same reason: a bug here must never black out the actual camera frame.
      if (this.isRecording) { try { this._renderRecordingIndicator(); } catch (e) { /* overlay-only */ } }

      // Wrapped: the overlay is diagnostic chrome — a bug in it must never black
      // out the bot's actual camera frame (which already rendered above).
      if (this.debugOverlayEnabled) { try { this._renderDebugOverlay(); } catch (e) { /* overlay-only */ } }
    }

    // The "not on the line yet" tile: a small avatar thumbnail beside a line of
    // text, over the bot's ordinary background.
    //
    // Sizing is the load-bearing decision. At tile-filling scale the glyph reads
    // as a person present; at thumbnail scale beside text it reads as a photo
    // identifying who is coming. That is the whole fix — people talked to 🫥
    // because it looked like someone was there.
    //
    // Two messages, because one cannot be honest about both cases:
    //   "<Name> is on the way"           — the normal case
    //   "<Name> is having trouble..."    — after TROUBLE_MS with still nobody home
    // 🫥 looked identical whether the join was progressing or wedged, and an
    // empty tile would too. Silence should not be the only symptom of a failure.
    _renderArrivalCard(emojiImg, emoji) {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      // Long enough that a healthy join never shows it, short enough that
      // someone waiting is not left guessing.
      //
      // Was 15s, and that was too tight. Measured on this machine's own logs,
      // healthy joins took 7s and 9s from `navigating` to in-call — a 6-second
      // margin, which any slow network or a Meet page that takes its time eats
      // immediately. So "having trouble connecting" was showing up on joins
      // that were merely ordinary, every run. A warning that fires on the
      // normal case teaches people to ignore it, which costs more than the
      // warning was ever worth.
      const TROUBLE_MS = 60000;
      const waited = this._notOnLineSince ? Date.now() - this._notOnLineSince : 0;
      const name = String((config && config.botName) || 'The bot').trim() || 'The bot';

      // Waiting in the lobby is NOT trouble, however long it lasts — it is a
      // human who has not clicked Admit yet, and Meet now hides that button
      // behind a ⋮ overflow on a "review potential risks" prompt, so this wait
      // is routinely long. Calling it "trouble connecting" blames the software
      // for what is a person's pending decision, and sends whoever is watching
      // to debug the wrong thing. Say the true thing instead: it also tells the
      // host, who is the one person who can end the wait, what to do.
      const inLobby = this.callStatus === 'waiting-to-be-admitted';
      const troubled = !inLobby && waited > TROUBLE_MS;

      // Deliberately the register of a person, not a system. "Connecting…"
      // describes machinery; "<Name> is on the way" implies someone specific is
      // about to arrive, which is what actually stops people talking to the tile.
      const text = inLobby ? name + ' is waiting to be let in'
        : troubled ? name + ' is having trouble connecting'
          : name + ' is on the way';

      const thumb = Math.min(w, h) * 0.14;   // badge-photo scale, NOT presence scale
      const fontPx = Math.round(Math.min(w, h) * 0.062);
      const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.save();
      ctx.font = fontPx + 'px ' + FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const gap = thumb * 0.42;
      const textW = ctx.measureText(text).width;
      const startX = Math.max(0, (w - (thumb + gap + textW)) / 2);
      // Two-thirds down rather than centred (Stan, on seeing it): the middle of
      // a Meet tile is where a FACE goes, so a centred card still occupies the
      // spot the eye reads as presence. Lower reads as a caption about the tile
      // instead of as the tile's occupant.
      const midY = h * 0.66;

      // A gentle bob, so the tile is never a frozen frame — a static Meet tile
      // reads as "it crashed", the opposite of the reassurance this is for.
      // Same reasoning as the idle liveness motion (#223), smaller amplitude.
      const bob = Math.sin(this.frameCount * 0.045) * (thumb * 0.05);
      if (emojiImg) {
        ctx.drawImage(emojiImg, startX, midY - thumb / 2 + bob, thumb, thumb);
      } else {
        ctx.save();
        ctx.font = Math.round(thumb) + 'px ' + (typeof emojiFontStack === 'string' && emojiFontStack ? emojiFontStack : FONT);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(emoji, startX, midY + bob);
        ctx.restore();
      }

      // Same dark-outline treatment as the recording indicator, so it stays
      // legible over ANY avatar background — including a photo the user chose,
      // which we cannot predict.
      const tx = startX + thumb + gap;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(3, fontPx * 0.14);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.strokeText(text, tx, midY);
      ctx.fillStyle = troubled ? '#f6c945' : 'rgba(255, 255, 255, 0.95)';
      ctx.fillText(text, tx, midY);
      ctx.restore();
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
      //
      // The tail is sliced HERE, at draw time, rather than upstream (#532). The
      // buffer behind d.agentLog is now 1000 lines deep, because the brain
      // window is a scrollable history and needs to be; this column is a strip
      // beside the stats on a 720p tile and fits about 16. Trimming at the
      // source is what caused #532 in the first place — one constant sized for
      // this surface, silently governing the other one — so the deep buffer is
      // shared and each consumer takes what it can draw.
      //
      // Keep OVERLAY_LINES in step with OVERLAY_MAX_LINES in agent-transcript.js.
      // It cannot be imported: this file is injected into Meet's page context and
      // has no module system. A test pins the two together.
      const OVERLAY_LINES = 16;
      const agentLines = (() => {
        const log = (d.agentLog || []).slice(-OVERLAY_LINES);
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


  }

  // Every face, one per camera (one camera per requested resolution).
  const faces = new Set();

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

  // Avatar posture (avatar-posture.js, exposed by preload-meet as
  // globalThis.__vibeAvatarPosture): where the face rests in its tile and when
  // it shifts. ONE state for the page, not per camera — a camera re-created
  // mid-call (camera toggle, Meet re-acquire) must keep the pose, not jump.
  // Seed + enabled are pushed from main ('set-avatar-posture'); until then the
  // bot name seeds it, which is already distinct per bot.
  let avatarPostureEnabledGlobal = true;
  let avatarPostureSeedGlobal = '';
  let avatarPostureState = null;
  let avatarPostureWasSpeaking = false;
  function avatarPostureApi() {
    const P = globalThis.__vibeAvatarPosture;
    return (P && typeof P.stepPosture === 'function') ? P : null;
  }
  function ensureAvatarPostureState(P, now) {
    if (!avatarPostureState) {
      avatarPostureState = P.createPostureState(avatarPostureSeedGlobal || config.botName || '', now);
    }
    return avatarPostureState;
  }
  // Called per frame. Speaking-END is detected here as the falling edge of
  // cam.speaking, which every playback path clears (TTS queue drained in
  // _ttsMaybeFinish, 'set-speaking', the direct speech-audio onended), so the
  // after-speech shift needs no hook in any of them. Module-level edge, so two
  // cameras rendering the same frame don't report the same ending twice.
  function currentAvatarPosture(w, h, speaking) {
    const P = avatarPostureApi();
    if (!P || !avatarPostureEnabledGlobal) return null;
    const now = Date.now();
    const s = ensureAvatarPostureState(P, now);
    if (avatarPostureWasSpeaking && !speaking) P.noteSpeakingEnded(s, now);
    avatarPostureWasSpeaking = !!speaking;
    return P.stepPosture(s, now, w, h, !!speaking);
  }

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

  media.setCameraRenderer((surface) => {
    const face = new AvatarFace(surface);
    faces.add(face);
    return face;
  });

  // The core's playback paths (TTS, the speech test, the test tone, realtime
  // voice) say when the bot is talking; the face lip-syncs to it.
  media.on('bot-speaking', ({ speaking, emoji } = {}) => {
    for (const face of faces) {
      face.speaking = !!speaking;
      if (emoji !== undefined) face.speakingEmojiOverride = emoji;
    }
  });
  // Recording indicator. Latched for faces created mid-recording.
  media.on('recording', ({ on } = {}) => {
    isRecordingGlobal = !!on;
    for (const face of faces) face.isRecording = !!on;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data?.__botsInCalls) return;

    const { action, payload } = event.data;

    switch (action) {
      case 'set-speaking':
        for (const cam of faces) cam.speaking = !!payload;
        break;

      case 'set-bot-state':
        // Update avatar state: 'idle' | 'listening' | 'thinking' | 'working' | 'speaking' | 'yielding'
        if (payload?.state) {
          for (const cam of faces) {
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
          for (const cam of faces) cam.mode = payload.mode;
          avatarState.mode = payload.mode; // seed future cameras
          console.debug('[bots-in-calls] Bot mode:', payload.mode);
        }
        break;

      // The countdown to the bot taking its turn (absolute deadline, or null).
      // Absolute rather than a duration because the server re-arms: a duration
      // captured at arm time would be stale the moment the gate is corrected.
      //
      // `from` is the server's silenceStart, which is usually in the PAST — the
      // last caption update, or the speaker's stop edge. Sweeping from there
      // means the pendulum's first frame lands mid-swing: up to ~8° in one
      // frame. On Teams (no speaking meter, so the gate is caption-driven) the
      // gate fires, the caption that arrived meanwhile re-arms it with a fresh
      // past `from`, and the head jumps out and drifts back every 1–2s while a
      // human talks (teams-9361264884308-20261016T151416Z, ~2 min in). So a
      // NEW sweep starts at arrival, at level, and still lands on the deadline.
      // A re-arm of a sweep already in flight keeps its start, so it bends
      // rather than restarting.
      case 'set-silence-gate': {
        const gateNow = Date.now();
        for (const cam of faces) {
          if (!payload || !payload.deadline) { cam.silenceGate = null; continue; }
          const prev = cam.silenceGate;
          const live = prev && prev.deadline > gateNow;
          const from = live ? prev.from : Math.max(payload.from || gateNow, gateNow);
          cam.silenceGate = { deadline: payload.deadline, from: Math.min(from, payload.deadline) };
        }
        break;
      }

      case 'set-anyone-speaking':
        if (typeof payload?.anyoneSpeaking === 'boolean') {
          for (const cam of faces) {
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
        for (const cam of faces) {
          cam._nameMentionPulseAt = Date.now();
          cam._mentionTiltSign = -(cam._mentionTiltSign || 1);
          cam._mentionTiltMag = mag;
        }
        // And sit up: ease to a more centred, larger pose and hold it; the
        // ordinary posture shifts move it on later (avatar-posture.js). Timed to the pulse, so the pulse
        // releases onto the attentive pose rather than two animations fighting.
        try {
          const P = avatarPostureApi();
          if (P && avatarPostureEnabledGlobal) {
            P.noteNameMentioned(ensureAvatarPostureState(P, Date.now()), Date.now(), AvatarFace.MENTION_PULSE_MS);
          }
        } catch (e) { /* posture is cosmetic */ }
        console.debug('[bots-in-calls] Name mentioned — avatar reaction fired');
        break;
      }

      case 'set-call-status':
        // Forwarded from local-server; see electron-app/call-phase.js for the
        // lifecycle. Used to show 🫥 before the bot is actually in the call.
        // Carried on this message rather than set-config, which nothing sends:
        // config.botName sat on its "AI Assistant" placeholder forever, so every
        // bot's arrival card claimed to be an AI Assistant (reported live,
        // 2026-08-24, and reproduced on a second bot).
        if (payload?.botName) config.botName = payload.botName;
        if (payload?.status) {
          // A finished call re-gates engagement so the NEXT one starts at 🫥
          // again. 'after-call-work' is deliberately absent: the agent is still
          // working, and blanking its face mid-wrap-up would say it had gone.
          const resets = payload.status === 'idle' || payload.status === 'navigating' ||
            payload.status === 'joining' || payload.status === 'call-complete';
          for (const cam of faces) {
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


      case 'set-agent-absent':
        // #38: nothing is driving the bot — show 🫥 rather than a resting face
        // that implies someone is listening.
        if (payload) {
          const away = !!payload.absent;
          const why = payload.reason || null;
          for (const cam of faces) { cam.agentAbsent = away; cam.agentAbsentReason = why; }
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
          for (const cam of faces) cam.impaired = on;
          avatarState.impaired = on; // seed future cameras
          console.log('[bots-in-calls] impaired =', on, payload.reason ? '(' + payload.reason + ')' : '');
        }
        break;

      case 'set-deaf':
        // Captions on/off from the scraper's CC-button watcher.
        // payload.deaf === true → avatar shows 🙉 to participants.
        if (payload) {
          for (const cam of faces) cam.deaf = !!payload.deaf;
          avatarState.deaf = !!payload.deaf; // seed future cameras
        }
        break;

      case 'set-avatar-emoji-override':
        // Persistent agent overrides for resting/yielding emojis. payload.idle,
        // payload.listening, and payload.yielding are independently optional.
        // null means reset to default for that key.
        if (payload) {
          for (const cam of faces) {
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
          for (const cam of faces) cam.emojiSet = emojiSetGlobal;
          console.log('[bots-in-calls] Emoji set:', emojiSetGlobal,
            emojiFontGlobal ? '(font: ' + emojiFontGlobal
              + (emojiFontColorGlobal ? ' ' + emojiFontColorGlobal : '') + ')' : '');
        }
        break;

      case 'set-avatar-posture':
        // Per-bot resting posture + occasional shifts (avatarPostureShifts
        // pref). A new seed re-derives the resting pose; turning it off
        // returns the face to dead centre.
        if (payload) {
          avatarPostureEnabledGlobal = payload.enabled !== false;
          const seed = String(payload.seed || '');
          if (seed && seed !== avatarPostureSeedGlobal) {
            avatarPostureSeedGlobal = seed;
            avatarPostureState = null;
          }
          console.log('[bots-in-calls] Avatar posture:', avatarPostureEnabledGlobal ? 'on' : 'off');
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
          for (const cam of faces) {
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
          for (const cam of faces) {
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
          for (const cam of faces) {
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
          for (const cam of faces) {
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

    }
  });
})();
