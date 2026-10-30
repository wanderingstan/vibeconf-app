// page-realtime-voice.js: RealtimeVoice (EXPERIMENT), OpenAI speech-to-speech
// wired straight to the call audio. An app plugin on page-inject's media core
// (Phase 2 of the calls library); page-scripts.js loads it right after
// page-inject.js, into the same page world. It needs the call's audio, which
// only this page has, so it lives here rather than in main. What it uses of
// the core: currentMic() (the mic the call publishes; the model's audio goes
// into it), remoteAudio() (everyone else's tracks, mixed into the session's
// input), setOwnVoice() and the 'bot-speaking' event (lip-sync, and keeping
// the bot's own caption out of the transcript).

(function () {
  'use strict';

  const media = window.__vibeconfMedia;
  if (!media) { console.warn('[bots-in-calls] page-realtime-voice: no media core (page-inject.js)'); return; }

  // ---------------------------------------------------------------------------
  // RealtimeVoice (EXPERIMENT) — OpenAI speech-to-speech, wired straight to the
  // call audio. Off unless the realtimeVoice pref is on for THIS bot.
  //
  // Both halves of what a realtime session needs already exist in this page and
  // nowhere else, which is why this lives here rather than in main:
  //
  //   IN   AudioCaptureManager holds the remote WebRTC tracks (other people).
  //        We mix them into one stream and publish that as the session mic.
  //   OUT  VirtualMic.destination IS the mic Meet publishes. Connecting the
  //        model audio into it is all it takes for the room to hear the bot.
  //
  // No encode/IPC/decode round trip, and the avatar lip-syncs for free because
  // we tap mic.analyser the same way normal TTS playback does.
  //
  // The main process holds the API key and mints a ~60s ephemeral secret; only
  // that secret ever reaches this page.
  class RealtimeVoice {
    constructor() {
      this.pc = null;
      this.dc = null;
      this.mixDest = null;      // where remote participants are summed for upload
      this.mixed = new Map();   // participantId -> MediaStreamAudioSourceNode
      this.sink = null;         // keeps the model audio flowing (see below)
      this.outGain = null;
      this.pollTimer = null;
      this.lipTimer = null;
      this.sayQueue = [];
      this.responseActive = false; // the model is composing, audible or not
      // Who may make this bot speak. The model no longer decides for itself
      // (create_response:false below), so this is the whole answer to "should
      // the bot answer that?".
      this.policy = { gate: false, botNames: [], otherNames: [], respondWhenUnnamed: true };
      this.holdUntil = 0; // the slow half asking for quiet, always time-limited
      this.speakingNow = false;
      this.botSpeakingClear = null;
      this.active = false;
      this.startedAt = 0;
    }

    // The model asked to do something. Main does it and hands back a result,
    // which goes into the conversation as the tool's output.
    //
    // The reply that follows is NOT gated by _shouldRespond: the bot is
    // finishing a turn it already started, not answering a fresh utterance.
    // Running it through the gate would strand the model mid-action, having
    // said "let me get that" and then never speaking again.
    _toolCall(m) {
      let args = {};
      try { args = JSON.parse(m.arguments || '{}'); } catch { /* handled below */ }
      this._report('tool', m.name + ' ' + JSON.stringify(args).slice(0, 90));
      try {
        window.postMessage({
          source: 'vibeconf-realtime-tool',
          callId: m.call_id, name: m.name, args,
        }, '*');
      } catch {
        this._toolResult(m.call_id, 'That did not work: the call view is gone.');
      }
    }

    _toolResult(callId, output) {
      if (!this.dc || this.dc.readyState !== 'open') return;
      this._send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: String(output || '') },
      });
      if (!this.responseActive) {
        this._send({ type: 'response.create' });
        this.responseActive = true;
      }
      this._report('tool-result', String(output || '').slice(0, 80));
    }

    // Should the bot answer what it just heard?
    //
    // Mirrors the app's existing passive-mode name gate (plain lowercase
    // substring, same as local-server's nameMentioned) so a realtime bot and a
    // normal one agree about what counts as being addressed.
    //
    // Errs toward speaking: silence is the failure nobody can debug from the
    // room, whereas a bot that answers once too often is merely annoying.
    _shouldRespond(text) {
      if (Date.now() < this.holdUntil) {
        return { ok: false, why: 'held by the slow half' };
      }
      const p = this.policy;
      // Two in the room: everything said is said to the bot.
      if (!p.gate) return { ok: true, why: 'two in the room' };

      const t = String(text || '').toLowerCase();
      const named = (p.botNames || []).find((n) => n && t.includes(n));
      if (named) return { ok: true, why: 'named (' + named + ')' };

      const other = (p.otherNames || []).find((n) => n && t.includes(n));
      if (other) return { ok: false, why: 'addressed to ' + other };

      return p.respondWhenUnnamed
        ? { ok: true, why: 'nobody named' }
        : { ok: false, why: 'nobody named, and configured to hold back' };
    }

    // A fact about the room, not from the slow half: who just started talking,
    // a chat message, whatever else the model has no way to perceive.
    //
    // Silent, like brief. It hears one mixed audio track for the whole room, so
    // without this it cannot tell two people apart at all, let alone tell that
    // "Gabe, what do you think?" was not addressed to it.
    note(text, { announce = false } = {}) {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (!this.active || !this.dc || this.dc.readyState !== 'open') return;
      // Most notes are context and must never be read out. A few are things the
      // ROOM needs to hear, and the model should put them in its own words
      // rather than recite them, so it is asked to mention rather than read.
      const prefix = announce
        ? '[room] Mention this to the room now, briefly and in your own words: '
        : '[room, do not read this out] ';
      this._send({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prefix + clean }] },
      });
      if (announce && !this.responseActive && !this.speakingNow) {
        this._send({ type: 'response.create' });
        this.responseActive = true;
      }
      this._report(announce ? 'announce' : 'note', clean.slice(0, 60));
    }

    // Something the model could not know, handed over WITHOUT asking it to
    // speak. conversation.item.create with no response.create: the model
    // absorbs it and uses it in its own words, whenever it is relevant, or
    // never. That is the whole primitive.
    //
    // No floor logic, and none needed. A silent inject takes nothing from
    // anybody, so unlike say() it cannot land on top of a reply in flight.
    brief(note) {
      const clean = String(note || '').trim();
      if (!clean) return;
      if (!this.active || !this.dc || this.dc.readyState !== 'open') {
        this._report('brief-failed', 'session not live');
        return;
      }
      this._send({
        type: 'conversation.item.create',
        item: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: '[context, do not read this out] ' + clean }],
        },
      });
      this._report('briefed', clean.slice(0, 80));
    }

    // Words handed over by main (agent speech, the recording notice) for the
    // model to voice. This is the whole reason ElevenLabs is out of the loop
    // for a realtime bot: one mouth, one voice, no collision.
    say(text) {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (!this.active || !this.dc || this.dc.readyState !== 'open') {
        // Never swallow it. main turns this into notePlaybackFailure so the
        // agent is not told "Spoken" about silence.
        this._report('say-failed', 'session not live');
        return;
      }
      this.sayQueue.push(clean);
      this._flushSay();
    }

    _flushSay() {
      if (!this.sayQueue.length) return;
      // Never talk over ourselves. The lip-sync amplitude watcher is the floor
      // signal, so this reuses the one thing that actually knows whether sound
      // is coming out, rather than a second guess at it.
      // Two different "busy" signals, and BOTH matter. speakingNow comes from
      // audio amplitude, which lags: the model spends a few hundred ms
      // composing before any sound exists. Firing response.create in that
      // window lands on top of a reply already in flight, and the delivered
      // words are simply lost. Seen live: Claude's line went in 374ms before
      // the model answered the human instead, and the line was never said.
      if (this.speakingNow || this.responseActive) return;
      const text = this.sayQueue.shift();
      this._send({
        type: 'conversation.item.create',
        item: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text: '[deliver, say this close to as written] ' + text }],
        },
      });
      this._send({ type: 'response.create' });
      this.responseActive = true; // ours, until response.done says otherwise
      this._report('said', text.slice(0, 80));
    }

    // The avatar's jaw is gated on cam.speaking; the analyser only modulates
    // how far it opens once that flag is already true. The TTS path raises and
    // lowers it around each clip, and realtime has no clips, so on the first
    // live call the bot talked with a completely still face.
    //
    // Driven from the model audio itself rather than from response.created /
    // response.done. Truthful by construction (the mouth moves exactly when
    // there is sound), and it cannot get stuck open the way an event-driven
    // flag does when a response.done never arrives.
    _startLipSync() {
      const mic = media.currentMic();
      if (!mic || typeof mic.getAmplitude !== 'function') return;
      let quietSince = 0;
      this.lipTimer = setInterval(() => {
        let amp = 0;
        try { amp = mic.getAmplitude() || 0; } catch { return; }
        const now = Date.now();
        if (amp > 0.02) quietSince = 0;
        else if (!quietSince) quietSince = now;
        // Hangover, so the gaps between words do not flicker the face.
        this._setSpeaking(amp > 0.02 || now - quietSince < 300);
      }, 50);
    }

    _setSpeaking(on) {
      if (on === this.speakingNow) return;
      this.speakingNow = on;

      media.emit('bot-speaking', { speaking: on, emoji: null });

      // Keeps Meet's caption of the bot's OWN voice from being ingested as if
      // somebody else in the room had said it. The TTS path does the same, with
      // the same delay on the way down: the caption lands after the audio.
      try {
        if (this.botSpeakingClear) { clearTimeout(this.botSpeakingClear); this.botSpeakingClear = null; }
        if (on) {
          media.setOwnVoice(true);
        } else {
          this.botSpeakingClear = setTimeout(() => { media.setOwnVoice(false); }, 1500);
        }
      } catch { /* transcription not up */ }

      // The floor just opened: anything main handed us while the model was
      // mid-sentence goes now.
      if (!on) this._flushSay();
    }

    _report(type, detail) {
      try {
        window.postMessage({ source: 'vibeconf-realtime-status', type, detail }, '*');
      } catch { /* page torn down */ }
      console.log('[bots-in-calls] realtime:', type, detail == null ? '' : detail);
    }

    // Sum every remote participant track into one upload stream. Deliberately
    // NOT connected to mic.destination: that would publish everyone back into
    // the bot's own mic and echo the whole room.
    _mixParticipants(ctx) {
      if (!this.mixDest) this.mixDest = ctx.createMediaStreamDestination();
      let added = 0;
      const remote = media.remoteAudio();
      const parts = (remote && remote.participants) || new Map();
      for (const [id, pa] of parts) {
        if (this.mixed.has(id)) continue;
        const track = pa && pa.track;
        if (!track || track.readyState !== 'live') continue;
        try {
          const src = ctx.createMediaStreamSource(new MediaStream([track]));
          src.connect(this.mixDest);
          this.mixed.set(id, src);
          added++;
        } catch (err) {
          console.warn('[bots-in-calls] realtime: could not mix', id, err.message);
        }
      }
      // The same remote audio the STT tap hears, from where the RTC hook can't
      // see it: a provider's output tap (WhatsApp's playback worklet) and, with
      // the hook off (Zoom, Teams, Slack), the call's <audio>/<video> elements.
      // Without these the realtime model heard nothing on those providers
      // ("mixed-participants 0", live on WhatsApp 2026-10-27).
      const extra = [...media.outputTapTracks()];
      if (window.__vibeconf_disableAudioCapture) {
        try {
          for (const el of document.querySelectorAll('audio, video')) {
            const src = el.srcObject;
            if (src && typeof src.getAudioTracks === 'function') extra.push(...src.getAudioTracks());
          }
        } catch { /* DOM not ready */ }
      }
      for (const track of extra) {
        const id = 'track-' + track.id;
        if (this.mixed.has(id) || track.readyState !== 'live') continue;
        try {
          const src = ctx.createMediaStreamSource(new MediaStream([track]));
          src.connect(this.mixDest);
          this.mixed.set(id, src);
          added++;
        } catch (err) {
          console.warn('[bots-in-calls] realtime: could not mix', id, err.message);
        }
      }
      return added;
    }

    async start({ secret, model }) {
      if (this.active) { this._report('already-active'); return; }
      if (!secret || !model) { this._report('failed', 'missing secret or model'); return; }

      // The bot has to be publishing a mic before we can speak into it. By
      // bot-joined time it is; if it somehow is not, say so rather than
      // building a second AudioContext nobody is listening to.
      const mic = media.currentMic();
      if (!mic || !mic.audioCtx || !mic.destination) {
        this._report('failed', 'no VirtualMic yet, cannot route model audio into the call');
        return;
      }
      const ctx = mic.audioCtx;
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* best effort */ } }

      const Native = window.__vibeconfNativeRTCPeerConnection || window.RTCPeerConnection;
      const pc = new Native();
      this.pc = pc;

      // OUT: model audio into the mic Meet publishes, plus a parallel tap into
      // the analyser so the avatar animates exactly as it does for TTS.
      pc.addEventListener('track', (event) => {
        if (event.track.kind !== 'audio') return;
        const stream = event.streams[0] || new MediaStream([event.track]);
        try {
          const src = ctx.createMediaStreamSource(stream);
          this.outGain = ctx.createGain();
          this.outGain.gain.value = 1;
          src.connect(this.outGain).connect(mic.destination);
          if (mic.analyser) src.connect(mic.analyser);
        } catch (err) {
          this._report('failed', 'could not route model audio: ' + err.message);
          return;
        }

        // Chromium will not pull samples from a remote WebRTC track that is fed
        // only into an AudioContext. Without a media element consuming it the
        // graph stays silent, which looks exactly like the model never spoke.
        // Muted, so this element never doubles the audio locally.
        try {
          const el = new Audio();
          el.srcObject = stream;
          el.muted = true;
          el.play().catch(() => {});
          this.sink = el;
        } catch { /* non-fatal */ }

        this._report('audio-connected');
      });

      pc.addEventListener('connectionstatechange', () => {
        this._report('pc-' + pc.connectionState);
        if (pc.connectionState === 'failed') this.stop('connection failed');
      });

      // IN: the room, as one mixed track.
      const mixedCount = this._mixParticipants(ctx);
      const upload = this.mixDest.stream.getAudioTracks()[0];
      if (!upload) { this._report('failed', 'no upload track'); return this.stop('no upload track'); }
      pc.addTrack(upload, this.mixDest.stream);
      this._report('mixed-participants', String(mixedCount));

      // People join mid-call and Meet reassigns its track slots, so re-check.
      // Polling because AudioCaptureManager emits no events; cheap and good
      // enough for a first draft.
      this.pollTimer = setInterval(() => {
        if (!this.active) return;
        const n = this._mixParticipants(ctx);
        if (n) this._report('mixed-participants', '+' + n);
      }, 3000);

      this.dc = pc.createDataChannel('oai-events');
      this.dc.onopen = () => {
        this._report('datachannel-open');
        // Pin the transcription language and stiffen VAD a little: room noise
        // tripping VAD is what makes the model open a call unprompted.
        this._send({
          type: 'session.update',
          session: {
            // Required by the GA shape. Without it the whole update is refused
            // with missing_required_parameter and the session silently keeps
            // its defaults, so the language pin and VAD tuning below never
            // apply and nothing looks broken until the model answers in the
            // wrong language.
            type: 'realtime',
            audio: {
              input: {
                transcription: { model: 'whisper-1', language: 'en' },
                turn_detection: {
                  type: 'server_vad', threshold: 0.6,
                  prefix_padding_ms: 300, silence_duration_ms: 600,
                  // The model detects turn ends but does NOT answer them. We do.
                  //
                  // Left to itself it answered 117 of 179 human turns in a
                  // three-way call: roughly two thirds, including plenty aimed
                  // at the other person. No VAD setting fixes that, because VAD
                  // knows when speech ENDED and never who it was for. Only
                  // gating the response does, and the app already knows how to
                  // make that call.
                  create_response: false,
                },
              },
            },
          },
        });
      };
      this.dc.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'response.created') {
          this.responseActive = true;
        } else if (m.type === 'response.done') {
          this.responseActive = false;
          this._flushSay(); // the model has finished; anything held goes now
        }

        if (m.type === 'response.audio_transcript.done' ||
            m.type === 'response.output_audio_transcript.done') {
          this._report('bot-said', m.transcript || '');
        } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
          const heard = m.transcript || '';
          this._report('heard', heard);
          const d = this._shouldRespond(heard);
          this._report(d.ok ? 'respond' : 'stay-quiet', d.why);
          if (d.ok && !this.responseActive && !this.speakingNow) {
            this._send({ type: 'response.create' });
            this.responseActive = true;
          }
        } else if (m.type === 'response.function_call_arguments.done') {
          this._toolCall(m);
        } else if (m.type === 'error') {
          this._report('model-error', JSON.stringify(m.error || m).slice(0, 200));
        }
      };

      try {
        await pc.setLocalDescription(await pc.createOffer());
        const answer = await this._negotiate(pc.localDescription.sdp, secret, model);
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (err) {
        this._report('failed', err.message);
        return this.stop('negotiation failed');
      }

      this.active = true;
      this.startedAt = Date.now();
      this._startLipSync();
      this._report('live', model);
    }

    async _negotiate(sdp, secret, model) {
      const res = await fetch('https://api.openai.com/v1/realtime/calls?model=' +
        encodeURIComponent(model), {
        method: 'POST',
        body: sdp,
        headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/sdp' },
      });
      if (res.ok) return await res.text();
      // Surface the server message, not just the status: 429 here is normally
      // billing rather than load, and that is only visible in the body.
      const body = await res.text().catch(() => '');
      let why = body.slice(0, 200);
      try { why = JSON.parse(body).error.message || why; } catch { /* not JSON */ }
      throw new Error('SDP ' + res.status + ': ' + why);
    }

    _send(o) {
      if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(o));
    }

    stop(why) {
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      if (this.lipTimer) { clearInterval(this.lipTimer); this.lipTimer = null; }
      this.responseActive = false;
      this._setSpeaking(false); // never leave the face mid-word
      // Anything still queued will never be said, and the agent may be waiting
      // on it. Report rather than discard silently.
      while (this.sayQueue.length) {
        this.sayQueue.shift();
        this._report('say-failed', 'the session stopped before it was said');
      }
      for (const src of this.mixed.values()) { try { src.disconnect(); } catch { /* gone */ } }
      this.mixed.clear();
      try { if (this.outGain) this.outGain.disconnect(); } catch { /* gone */ }
      this.outGain = null;
      try { if (this.sink) { this.sink.pause(); this.sink.srcObject = null; } } catch { /* gone */ }
      this.sink = null;
      try { if (this.dc) this.dc.close(); } catch { /* gone */ }
      this.dc = null;
      try { if (this.pc) this.pc.close(); } catch { /* gone */ }
      this.pc = null;
      this.mixDest = null;
      if (this.active) this._report('stopped', why || '');
      this.active = false;
    }
  }

  const realtimeVoice = new RealtimeVoice();
  window.__vibeconfRealtimeVoice = realtimeVoice; // console debugging

  window.addEventListener('message', (event) => {
    if (!event.data || event.source !== window) return;
    if (event.data.action === 'start-realtime') {
      realtimeVoice.start({ secret: event.data.secret, model: event.data.model });
    } else if (event.data.action === 'stop-realtime') {
      realtimeVoice.stop('asked to stop');
    } else if (event.data.action === 'realtime-say') {
      realtimeVoice.say(event.data.text);
    } else if (event.data.action === 'realtime-brief') {
      realtimeVoice.brief(event.data.note);
    } else if (event.data.action === 'realtime-policy') {
      realtimeVoice.policy = event.data.policy || realtimeVoice.policy;
      realtimeVoice._report('policy',
        (realtimeVoice.policy.gate ? 'gated' : 'open') +
        ', bot=' + (realtimeVoice.policy.botNames || []).join('/') +
        ', others=' + (realtimeVoice.policy.otherNames || []).join('/'));
    } else if (event.data.action === 'realtime-note') {
      realtimeVoice.note(event.data.text, { announce: !!event.data.announce });
    } else if (event.data.action === 'realtime-tool-result') {
      realtimeVoice._toolResult(event.data.callId, event.data.output);
    } else if (event.data.action === 'realtime-hold') {
      const secs = Math.max(0, Math.min(120, Number(event.data.seconds) || 0));
      realtimeVoice.holdUntil = secs ? Date.now() + secs * 1000 : 0;
      realtimeVoice._report('hold', secs ? secs + 's: ' + (event.data.reason || '') : 'released');
    }
  });
})();
