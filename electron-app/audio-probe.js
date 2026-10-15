// audio-probe.js — RECON: log where a call client's audio lives in the page.
//
// Recording needs the other participants' audio (#814). On Meet it's tapped
// from RTCPeerConnection tracks, but that hook is disabled on Zoom/Teams and
// those clients may not use WebRTC tracks at all (Zoom's web client is known
// to decode in WebAssembly and play through Web Audio). This wraps the APIs a
// client could use to get sound to the speakers, and logs each use, so a live
// call shows which path it takes. LOG ONLY: every wrapper calls straight
// through and changes nothing.
//
// Off unless VIBECONF_AUDIO_PROBE=1 (checked by the preload). Install BEFORE
// page scripts run; lines are prefixed with the provider's log tag so main's
// console forwarder passes them through.

function installAudioProbe(tag) {
  const log = (...a) => { try { console.log(tag + ' [audio-probe]', ...a); } catch { /* console gone */ } };
  const kinds = (s) => {
    try { return s ? s.getTracks().map((t) => t.kind + (t.enabled ? '' : '(off)')).join(',') || 'none' : 'null'; } catch { return '?'; }
  };
  const W = window;
  const OrigAC = W.AudioContext; // before the wrap below; the meters use it

  // RTCPeerConnection: created? which tracks arrive?
  try {
    const PC = W.RTCPeerConnection;
    if (PC) {
      let n = 0;
      const Wrapped = function (...args) {
        const pc = new PC(...args);
        const id = ++n;
        log('RTCPeerConnection #' + id + ' created');
        pc.addEventListener('track', (e) => log('RTCPeerConnection #' + id + ' track:', e.track && e.track.kind, 'streams:', (e.streams || []).length));
        return pc;
      };
      Wrapped.prototype = PC.prototype;
      Object.setPrototypeOf(Wrapped, PC); // keep statics (generateCertificate)
      W.RTCPeerConnection = Wrapped;
    } else log('no RTCPeerConnection');
  } catch (e) { log('RTCPeerConnection wrap failed:', e.message); }

  // Media elements fed a MediaStream (srcObject) or a URL (src).
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) {
        log(this.tagName.toLowerCase() + '.srcObject =', v ? (v.constructor && v.constructor.name) : 'null', 'tracks:', v && v.getTracks ? kinds(v) : '-');
        return desc.set.call(this, v);
      },
    });
  } catch (e) { log('srcObject wrap failed:', e.message); }

  // Web Audio: contexts, worklet modules, and what reaches the speakers.
  try {
    const AC = W.AudioContext;
    let n = 0;
    const WrappedAC = function (...args) {
      const ctx = new AC(...args);
      ctx.__probeId = ++n;
      log('AudioContext #' + ctx.__probeId + ' created, sampleRate', ctx.sampleRate, 'opts', JSON.stringify(args[0] || {}));
      return ctx;
    };
    WrappedAC.prototype = AC.prototype;
    Object.setPrototypeOf(WrappedAC, AC);
    W.AudioContext = WrappedAC;
  } catch (e) { log('AudioContext wrap failed:', e.message); }
  try {
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, ...rest) {
      log('AudioWorklet.addModule', String(url).slice(0, 160));
      return addModule.call(this, url, ...rest);
    };
  } catch (e) { log('AudioWorklet wrap failed:', e.message); }
  try {
    const AWN = W.AudioWorkletNode;
    const WrappedAWN = function (ctx, name, opts) {
      log('AudioWorkletNode', JSON.stringify(name), 'on ctx #' + (ctx && ctx.__probeId), 'outputs', opts && opts.numberOfOutputs, 'channels', opts && JSON.stringify(opts.outputChannelCount));
      return new AWN(ctx, name, opts);
    };
    WrappedAWN.prototype = AWN.prototype;
    Object.setPrototypeOf(WrappedAWN, AWN);
    W.AudioWorkletNode = WrappedAWN;
  } catch (e) { log('AudioWorkletNode wrap failed:', e.message); }
  try {
    const connect = AudioNode.prototype.connect;
    const seen = new WeakSet();
    AudioNode.prototype.connect = function (dest, ...rest) {
      if (dest && dest instanceof AudioDestinationNode && !seen.has(this)) {
        seen.add(this);
        log('→ speakers:', this.constructor.name, 'on ctx #' + (this.context && this.context.__probeId));
      }
      return connect.call(this, dest, ...rest);
    };
  } catch (e) { log('AudioNode.connect wrap failed:', e.message); }
  try {
    const cmss = AudioContext.prototype.createMediaStreamSource;
    AudioContext.prototype.createMediaStreamSource = function (s) {
      log('createMediaStreamSource on ctx #' + this.__probeId, 'tracks:', kinds(s));
      return cmss.call(this, s);
    };
  } catch { /* fine */ }

  // Transports media could arrive over.
  try {
    if (W.WebTransport) {
      const WT = W.WebTransport;
      const WrappedWT = function (url, opts) { log('WebTransport', String(url).slice(0, 120)); return new WT(url, opts); };
      WrappedWT.prototype = WT.prototype;
      W.WebTransport = WrappedWT;
    }
  } catch { /* fine */ }
  try {
    const WS = W.WebSocket;
    const WrappedWS = function (url, protocols) {
      const u = String(url);
      if (!/localhost|127\.0\.0\.1/.test(u)) log('WebSocket', u.replace(/\?.*$/, '?…').slice(0, 120));
      return protocols === undefined ? new WS(url) : new WS(url, protocols);
    };
    WrappedWS.prototype = WS.prototype;
    Object.setPrototypeOf(WrappedWS, WS);
    W.WebSocket = WrappedWS;
  } catch { /* fine */ }

  // Per-track level meters: is there actually SOUND on a given stream, and
  // whose? One analyser per audio track id, on a private context (created via
  // the saved original constructor so it doesn't show up in the log above).
  let meterCtx = null;
  const meters = new Map(); // track id -> { an, buf, peak }
  function meterFor(track) {
    if (meters.has(track.id)) return meters.get(track.id);
    try {
      meterCtx = meterCtx || new OrigAC();
      const src = meterCtx.createMediaStreamSource(new MediaStream([track]));
      const an = meterCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an); // analyser only: never connected to the speakers
      const m = { an, buf: new Float32Array(an.fftSize), peak: 0 };
      meters.set(track.id, m);
      return m;
    } catch (e) { log('meter failed:', e.message); return null; }
  }
  setInterval(() => {
    try { if (meterCtx && meterCtx.state === 'suspended') meterCtx.resume(); } catch { /* fine */ }
    for (const m of meters.values()) {
      m.an.getFloatTimeDomainData(m.buf);
      let s = 0; for (const v of m.buf) s += v * v;
      m.peak = Math.max(m.peak, Math.sqrt(s / m.buf.length));
    }
  }, 100);

  // Periodic census of what's in the DOM right now, with each audio track's
  // peak level over the last 10s (0 = silence).
  setInterval(() => {
    try {
      const els = [...document.querySelectorAll('audio, video')].map((m) => {
        const s = m.srcObject;
        let levels = '';
        if (s && s.getAudioTracks) {
          levels = s.getAudioTracks().map((t) => {
            const mt = meterFor(t);
            const p = mt ? mt.peak : -1;
            if (mt) mt.peak = 0;
            return ' ' + t.id.slice(0, 6) + '=' + (p < 0 ? '?' : p.toFixed(3));
          }).join('');
        }
        return m.tagName.toLowerCase() + '[' + (s ? 'stream:' + kinds(s) + levels : (m.currentSrc ? 'src' : 'empty')) + (m.paused ? ',paused' : '') + (m.muted ? ',muted' : '') + ']';
      });
      log('census:', els.length ? els.join(' ') : 'no audio/video elements');
    } catch { /* DOM not ready */ }
  }, 10000);

  log('installed');
}

module.exports = { installAudioProbe };
