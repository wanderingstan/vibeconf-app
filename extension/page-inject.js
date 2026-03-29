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
          console.log('[bots-in-calls] Upgraded to AudioContext render loop');

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

    console.log('[bots-in-calls] getUserMedia intercepted:', JSON.stringify(constraints));

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
      console.log('[bots-in-calls] Returning virtual stream:', tracks.length, 'track(s)',
        constraints?.video ? `(${parseVideoDimensions(constraints.video).width}x${parseVideoDimensions(constraints.video).height})` : '');
      return stream;
    }

    return _getUserMedia.call(navigator.mediaDevices, constraints);
  };

  // Placeholder for whiteboard screen-share override (not yet implemented)
  const _getDisplayMedia = MediaDevices.prototype.getDisplayMedia;

  MediaDevices.prototype.getDisplayMedia = async function (constraints) {
    // TODO: Intercept and return whiteboard tab stream
    console.log('[bots-in-calls] getDisplayMedia called (pass-through for now)');
    if (_getDisplayMedia) {
      return _getDisplayMedia.call(navigator.mediaDevices, constraints);
    }
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

      case 'play-tts':
        if (mic && payload?.audioData) {
          for (const cam of cameras.values()) cam.speaking = true;
          mic.playAudio(payload.audioData).then(() => {
            for (const cam of cameras.values()) cam.speaking = false;
          });
        }
        break;
    }
  });

  // Signal readiness back through the bridge
  window.postMessage({ __botsInCalls: true, action: 'ready' }, '*');
  console.log('[bots-in-calls] Page script loaded — getUserMedia patched');
})();
