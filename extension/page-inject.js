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
    constructor(width, height) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width || config.canvasWidth;
      this.canvas.height = height || config.canvasHeight;
      this.ctx = this.canvas.getContext('2d');
      this.frameCount = 0;
      this.speaking = false;
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

      // --- Animated gradient background (bright enough to avoid "camera blocked" detection) ---
      const t = this.frameCount * 0.02;
      const grad = ctx.createLinearGradient(
        w * (0.3 + 0.2 * Math.sin(t)),
        0,
        w * (0.7 + 0.2 * Math.cos(t)),
        h
      );
      grad.addColorStop(0, '#1a237e');   // deep indigo
      grad.addColorStop(0.5, '#283593'); // indigo
      grad.addColorStop(1, '#1565c0');   // blue
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Subtle animated particles for visual variance
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

      const cx = w / 2;
      const cy = h / 2 - 20;
      const r = Math.min(w, h) * 0.14; // scale with resolution

      // Pulse effect when the bot is "speaking"
      const displayR = this.speaking
        ? r + Math.sin(this.frameCount * 0.15) * (r * 0.1)
        : r;

      // Outer glow ring
      ctx.save();
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = this.speaking ? 40 : 15;
      ctx.beginPath();
      ctx.arc(cx, cy, displayR + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();

      // Avatar circle
      ctx.save();
      ctx.shadowColor = config.botColor;
      ctx.shadowBlur = this.speaking ? 30 : 10;
      ctx.beginPath();
      ctx.arc(cx, cy, displayR, 0, Math.PI * 2);
      ctx.fillStyle = config.botColor;
      ctx.fill();
      ctx.restore();

      // Initials inside the circle
      const initials = config.botName
        .split(' ')
        .map((word) => word[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);

      const fontSize = Math.round(r * 0.75);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${fontSize}px "Google Sans", Roboto, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, cx, cy);

      // Name label below avatar
      const labelSize = Math.round(r * 0.3);
      ctx.fillStyle = '#e8eaed';
      ctx.font = `${labelSize}px "Google Sans", Roboto, Arial, sans-serif`;
      ctx.fillText(config.botName, cx, cy + displayR + labelSize * 2);

      // Small green "AI" badge
      const badgeR = Math.round(r * 0.2);
      const bx = cx + displayR - badgeR * 0.5;
      const by = cy + displayR - badgeR * 0.5;
      ctx.beginPath();
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = '#34a853';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${Math.round(badgeR * 0.8)}px "Google Sans", Roboto, Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AI', bx, by);
    }

    getTrack() {
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
      return new Promise((resolve) => {
        src.onended = resolve;
        src.start();
      });
    }

    getTrack() {
      return this.destination.stream.getAudioTracks()[0];
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
      if (!mic) mic = new VirtualMic();
      tracks.push(mic.getTrack());
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
        if (mic && payload?.audioData) {
          for (const cam of cameras.values()) cam.speaking = true;
          transcription.botSpeaking = true;
          mic.playAudio(payload.audioData).then(() => {
            for (const cam of cameras.values()) cam.speaking = false;
            // Small delay before clearing — speech recognition may still
            // be processing the tail end of the bot's audio
            setTimeout(() => { transcription.botSpeaking = false; }, 1500);
          });
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
        console.debug(`[bots-in-calls] Participant ${this.id} started speaking (${db.toFixed(1)} dB)`);
        this._startRecording();
      } else if (!this.speaking && wasSpeaking && (Date.now() - this.lastSpeakingTime > 1500)) {
        console.debug(`[bots-in-calls] Participant ${this.id} stopped speaking`);
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

        if (status.length > 0) {
          console.debug('[bots-in-calls] Audio levels:', status.join(' | '));
        }

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

  // Initialize the audio capture manager
  const audioCaptureManager = new AudioCaptureManager();

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

  // Initialize transcription (but don't start listening until requested)
  const transcription = new SpeakerAttributedTranscription(audioCaptureManager);
  window.__botsInCallsTranscription = transcription;

  // ---------------------------------------------------------------------------

  // Signal readiness back through the bridge
  window.postMessage({ __botsInCalls: true, action: 'ready' }, '*');
  console.debug('[bots-in-calls] Page script loaded — getUserMedia patched, RTCPeerConnection hooked');

})();
