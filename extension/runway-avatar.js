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

  class RunwayAvatar {
    constructor() { this.room = null; this.videoEl = null; this.connected = false; }

    async connect({ url, token }) {
      const LK = window.LivekitClient;
      if (!LK) throw new Error('window.LivekitClient not loaded (livekit-client UMD must be injected first)');
      if (!url || !token) throw new Error('connect requires { url, token }');

      const room = new LK.Room({ adaptiveStream: true, dynacast: true });
      this.room = room;

      room.on(LK.RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === 'video') {
          const el = track.attach();
          el.muted = true; el.playsInline = true; el.autoplay = true;
          // keep it off-DOM but alive; drawImage in VirtualCamera reads frames from it
          el.style.position = 'fixed'; el.style.left = '-9999px'; el.style.width = '2px'; el.style.height = '2px';
          (document.body || document.documentElement).appendChild(el);
          const p = el.play && el.play(); if (p && p.catch) p.catch(() => {});
          this.videoEl = el;
          window.__vibeSetAvatarVideo && window.__vibeSetAvatarVideo(el);
          console.log(TAG, 'avatar VIDEO attached → VirtualCamera');
        } else if (track.kind === 'audio') {
          // P2b: route this to the virtual mic for perfect sync. For P2a we leave it detached
          // (humans hear the bot's local TTS); attaching here would double the audio.
          console.log(TAG, 'avatar audio track available (left detached for P2a)');
        }
      });
      room.on(LK.RoomEvent.Disconnected, (reason) => { console.log(TAG, 'room disconnected:', reason); this._revert(); });
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
      try { window.__vibeSetAvatarVideo && window.__vibeSetAvatarVideo(null); } catch (e) {}
      try { if (this.videoEl) this.videoEl.remove(); } catch (e) {}
      this.videoEl = null; this.connected = false;
    }

    disconnect() {
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
        if (active) active.disconnect();
        active = new RunwayAvatar();
        await active.connect({ url: m.url, token: m.token });
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
