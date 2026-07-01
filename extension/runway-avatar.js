// runway-avatar.js — the browser half of P2 (Runway faces, puppet mode).
//
// Runs in the Meet page context (injected alongside page-inject.js). Joins the LiveKit room
// provisioned by scripts/runway-session.mjs, publishes the bot's TTS audio (so Runway lip-syncs
// it), and subscribes the lip-synced avatar VIDEO track — feeding it into the VirtualCamera so
// the bot's Meet tile shows the photoreal face instead of the emoji.
//
//   our guarded TTS → (publish) → LiveKit room ← Runway worker (lip-syncs) → avatar video → camera
//
// Requires: window.LivekitClient (livekit-client UMD, loaded before this script) and the
// page-inject bridges window.__vibeSetAvatarVideo(el) + window.__vibeMicStream().
//
// Control via postMessage: { source:'runway-avatar', type:'connect', url, token } / { type:'disconnect' }.
// Fully opt-in: if never connected, the emoji path is untouched. On any failure it reverts to emoji.
//
// SCOPE (P2a): video face + lip-sync. The bot's existing TTS still feeds Meet's mic (humans hear
// it immediately; the avatar video lags by the Runway round-trip — minor). P2b will route the
// avatar's own audio track to the mic for perfect A/V sync (the audio branch below is stubbed).

(function () {
  'use strict';
  const TAG = '[runway-avatar]';
  let active = null;
  // The ONE video element the VirtualCamera currently draws. Owner-checked: an instance may only
  // clear the camera if the pointer is ITS element. Fixes the 2026-07-01 flicker: an old
  // generation's late Disconnected → _revert() → __vibeSetAvatarVideo(null) was clobbering the
  // NEW generation's freshly-attached video (face → emoji), while its leaked watchdog kept
  // logging w=0 alongside the live one (the alternating w=1088/w=0 signature in the logs).
  let cameraEl = null;

  class RunwayAvatar {
    constructor() { this.room = null; this.videoEl = null; this.connected = false; this._cameraSet = false; this.onLive = null; }

    // Tear down THIS instance's current video + watchdog (and only its own camera claim).
    // Called before adopting a re-subscribed track (LiveKit re-fires TrackSubscribed after a
    // reconnect — previously this overwrote _hb/videoEl and LEAKED the old interval + element).
    _teardownVideo() {
      try { if (this._hb) clearInterval(this._hb); } catch (e) {}
      this._hb = null;
      if (this.videoEl) {
        if (cameraEl === this.videoEl) { try { window.__vibeSetAvatarVideo && window.__vibeSetAvatarVideo(null); } catch (e) {} cameraEl = null; }
        try { this.videoEl.remove(); } catch (e) {}
      }
      this.videoEl = null; this._cameraSet = false;
    }

    // Hand the camera THIS element — only once real frames exist (frame-gated attach). Setting
    // the pointer at subscribe time (videoWidth=0) made the tile flash emoji on every renewal.
    _claimCamera(el) {
      if (this._cameraSet || this.videoEl !== el) return;
      this._cameraSet = true;
      cameraEl = el;
      try { window.__vibeSetAvatarVideo && window.__vibeSetAvatarVideo(el); } catch (e) {}
      console.log(TAG, 'avatar VIDEO live (' + el.videoWidth + 'x' + el.videoHeight + ') → VirtualCamera');
      try { this.onLive && this.onLive(); } catch (e) {}
      this.onLive = null;
    }

    async connect({ url, token }) {
      const LK = window.LivekitClient;
      if (!LK) throw new Error('window.LivekitClient not loaded (livekit-client UMD must be injected first)');
      if (!url || !token) throw new Error('connect requires { url, token }');

      // adaptiveStream/dynacast OFF: our real consumer is canvas.drawImage, not a visible/sized
      // DOM element. With adaptiveStream the SFU sees a tiny off-screen <video> as "not visible"
      // and starves the track (videoWidth stays 0 → never paints). (codex review, 2026-06-27.)
      const room = new LK.Room({ adaptiveStream: false, dynacast: false });
      this.room = room;

      room.on(LK.RoomEvent.ConnectionStateChanged, (state) => console.log(TAG, 'connection state:', state));
      room.on(LK.RoomEvent.TrackSubscribed, (track, pub, participant) => {
        console.log(TAG, 'subscribed:', track.kind, pub && pub.trackSid, participant && participant.identity);
        if (track.kind === 'video') {
          // Re-subscribes happen (LiveKit re-fires TrackSubscribed after a reconnect) — clean up
          // the previous element/watchdog first instead of leaking them (2026-07-01 flicker fix).
          this._teardownVideo();
          const el = track.attach();
          el.muted = true; el.playsInline = true; el.autoplay = true;
          // Visible-but-invisible: real size + ~0 opacity so adaptiveStream/decoder keep frames flowing.
          el.style.position = 'fixed'; el.style.left = '0'; el.style.bottom = '0';
          el.style.width = '160px'; el.style.height = '90px'; el.style.opacity = '0.01'; el.style.pointerEvents = 'none';
          (document.body || document.documentElement).appendChild(el);
          this.videoEl = el;
          for (const ev of ['loadedmetadata', 'canplay', 'playing', 'resize', 'error']) {
            el.addEventListener(ev, () => {
              console.log(TAG, 'video event:', ev, { rs: el.readyState, w: el.videoWidth, h: el.videoHeight, t: el.currentTime });
              if (el.videoWidth > 0) this._claimCamera(el); // frame-gated attach
            });
          }
          // Watchdog: log only on width change (0↔real = the failure/recovery signal), claim the
          // camera if the event path missed the first frame, and self-stop when the track ends.
          this._hbLast = -1;
          this._hb = setInterval(() => {
            const w = el.videoWidth, ended = track.mediaStreamTrack && track.mediaStreamTrack.readyState === 'ended';
            if (w !== this._hbLast) { console.log(TAG, 'video state w=' + w + ' rs=' + el.readyState + ' track=' + (track.mediaStreamTrack && track.mediaStreamTrack.readyState)); this._hbLast = w; }
            if (w > 0) this._claimCamera(el);
            if (ended) { clearInterval(this._hb); this._hb = null; }
          }, 1000);
          const p = el.play && el.play(); if (p && p.catch) p.catch((e) => console.warn(TAG, 'video play failed:', e && e.message));
          console.log(TAG, 'avatar video subscribed — waiting for first frame before claiming the camera');
        } else if (track.kind === 'audio') {
          console.log(TAG, 'avatar audio track available (left detached for P2a)');
        }
      });
      room.on(LK.RoomEvent.Disconnected, (reason) => {
        console.log(TAG, 'room disconnected:', reason);
        const expected = this._expectedClose;
        this._revert();
        // Unexpected drop (network blip, server, Runway session death) → ask main to re-establish.
        // Expected closes (a new connect / explicit disconnect) set _expectedClose so we don't loop.
        if (!expected) {
          console.log(TAG, 'UNEXPECTED disconnect → requesting re-establish');
          try { window.postMessage({ source: 'runway-avatar-status', type: 'lost' }, '*'); } catch (e) {}
        }
      });
      room.on(LK.RoomEvent.Reconnecting, () => console.log(TAG, 'reconnecting…'));

      await room.connect(url, token);
      this.connected = true;
      console.log(TAG, 'connected to room', url);
      await this._publishTtsAudio();
    }

    // Publish the bot's TTS audio (from the VirtualMic) so Runway lip-syncs OUR words.
    async _publishTtsAudio() {
      const LK = window.LivekitClient;
      let track = null;
      for (let i = 0; i < 40 && this.connected; i++) { // wait up to ~20s for the mic to exist
        // __vibeMicTrack() is rebuild-aware (survives the Slack stop()/destination rebuild)
        track = window.__vibeMicTrack && window.__vibeMicTrack();
        if (track && track.readyState === 'live') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!track) { console.warn(TAG, 'no TTS mic track found — avatar will idle (no lip-sync). Speak once to create the mic, then reconnect.'); return; }
      try {
        const localTrack = new LK.LocalAudioTrack(track);
        await this.room.localParticipant.publishTrack(localTrack, { source: LK.Track.Source.Microphone });
        console.log(TAG, 'published TTS audio → Runway will lip-sync the face');
      } catch (e) {
        console.error(TAG, 'failed to publish TTS audio:', e && e.message);
      }
    }

    _revert() {
      // Owner-checked: only clears the camera if the pointer is OUR element (_teardownVideo).
      // The old unconditional __vibeSetAvatarVideo(null) here was the flicker's second half —
      // a prior generation's late Disconnected wiped the new generation's live face.
      this._teardownVideo();
      this.connected = false;
    }

    disconnect() {
      this._expectedClose = true; // intentional close — suppress loss-recovery signal
      this._revert();
      try { this.room && this.room.disconnect(); } catch (e) {}
      this.room = null;
    }
  }

  window.RunwayAvatar = RunwayAvatar;

  // postMessage control surface (preload forwards main-process commands as window messages)
  window.addEventListener('message', async (ev) => {
    const m = ev && ev.data;
    if (!m || m.source !== 'runway-avatar') return;
    try {
      if (m.type === 'connect') {
        // GAPLESS renewal: keep the previous face drawing until the new session's video has real
        // frames (onLive), then retire it — instead of disconnect-first, which guaranteed an
        // emoji flash on every 4-minute rotate. Safety timer retires the old one regardless, so
        // a new session that never produces frames can't leave two rooms connected (the
        // 2026-07-01 two-watchdog overlap).
        const prev = active;
        active = new RunwayAvatar();
        let retired = false;
        const retire = () => { if (!retired) { retired = true; try { prev && prev.disconnect(); } catch (e) {} } };
        if (prev) { active.onLive = retire; setTimeout(retire, 15000); }
        try {
          await active.connect({ url: m.url, token: m.token });
        } catch (e) {
          // New session failed — keep the old face alive rather than reverting to emoji.
          // Handled HERE (not rethrown): the outer catch would disconnect the restored prev.
          console.error(TAG, 'connect failed:', e && e.message);
          try { active.disconnect(); } catch (e2) {}
          if (prev && !retired) { active = prev; } else { active = null; }
        }
      } else if (m.type === 'disconnect') {
        if (active) active.disconnect();
        active = null;
        console.log(TAG, 'reverted to emoji');
      }
    } catch (e) {
      console.error(TAG, 'control error:', e && e.message);
      if (active) { active.disconnect(); active = null; }
    }
  });

  console.log(TAG, 'ready (livekit-client:', !!window.LivekitClient, ') — awaiting connect message');
})();
