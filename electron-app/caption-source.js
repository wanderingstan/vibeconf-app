// caption-source.js — how the bot HEARS a call, separated from the call itself (#850).
//
// Until now "listening" was part of each CallProvider: the caption scraper sits
// inside the provider's preload, and enableCaptions / recoverCaptions /
// setCaptionLanguage are provider methods. That holds while every platform we
// support has captions. It stops holding for calling apps (Telegram, WhatsApp,
// Discord, Messenger: #843), which have none, and where the bot has to hear by
// transcribing the call audio itself.
//
// So the source of caption turns becomes its own piece:
//
//   CallProvider    joins, speaks, chats, shares, roster/speaking
//                   + capabilities: { captions }
//   CaptionSource   start / stop / setLanguage / recover
//                   emits SOURCE_EVENTS (turns, state, stall, ready)
//     ├─ PlatformCaptions   the provider's own captions (today's scrapers)
//     └─ AudioTranscription transcribes tapped call audio (phase 2)
//
// The turn shape is unchanged, { turnId, speaker, text, isBottommost }, so
// everything downstream of localServer.updateTurns stays source-agnostic.
//
// Pure module: no electron requires. PlatformCaptions takes the IPC surface it
// needs as arguments, so it can be exercised in a plain node test.

const { EventEmitter } = require('node:events');
const { CALL_EVENTS, CALL_COMMANDS, providerCapabilities } = require('./call-provider.js');

// What a source tells the app. Payloads match the provider events they replace,
// so the handlers in main.js moved over with their bodies untouched.
const SOURCE_EVENTS = {
  turns: 'turns',   // { turns: [{ turnId, speaker, text, isBottommost }] }
  state: 'state',   // { on: bool }: the source can (on) or cannot (off) hear
  stall: 'stall',   // { ageMs, nodes? }: says on, but nothing new is arriving
  ready: 'ready',   // first confirmed able to hear in this call
};

// Values of the listenSource preference. 'audio' = always transcribe the call
// audio ourselves, even where the platform has captions (useful for comparing
// the two, and for a platform whose captions are off or gated).
const LISTEN_SOURCES = ['auto', 'platform', 'audio'];

// The IPC channel the provider preloads forward the page's STT tap on
// (page-inject.js sttTap → preload-stt-bridge.js → here).
const STT_AUDIO_CHANNEL = 'stt-audio';

class CaptionSource extends EventEmitter {
  /** e.g. 'platform', 'audio' */
  static get id() { return 'abstract'; }

  notImplemented(method) {
    throw new Error(`${this.constructor.name}.${method}() not implemented`);
  }

  /** Begin delivering SOURCE_EVENTS. Idempotent. */
  start() { this.notImplemented('start'); }
  /** Stop delivering SOURCE_EVENTS. Idempotent. */
  stop() { this.notImplemented('stop'); }
  /** Listen in `language` (BCP-47). Resolves { ok, language? , error? }. */
  async setLanguage(/* language */) { this.notImplemented('setLanguage'); }
  /** Rebuild a stalled stream (self-heal after a confirmed stall). */
  recover() { this.notImplemented('recover'); }
}

// The call platform's own captions. A thin adapter: the scraping stays in each
// provider's preload, which already emits the CALL_EVENTS caption channels and
// handles the caption commands. This re-emits the former and forwards the
// latter, so behaviour is identical to wiring them directly.
class PlatformCaptions extends CaptionSource {
  static get id() { return 'platform'; }

  /**
   * @param {object} io
   * @param {{on: Function, removeListener: Function}} io.ipcMain
   * @param {(channel: string, payload?: object) => void} io.sendCallCmd
   * @param {(channel: string, payload: object, resultEvent: string, timeoutMs: number) => Promise<object>} io.callViewRequest
   */
  constructor({ ipcMain, sendCallCmd, callViewRequest }) {
    super();
    this._ipcMain = ipcMain;
    this._sendCallCmd = sendCallCmd;
    this._callViewRequest = callViewRequest;
    this._listeners = null;
  }

  start() {
    if (this._listeners) return;
    this._listeners = [
      [CALL_EVENTS.captionTurns, (_e, payload) => this.emit(SOURCE_EVENTS.turns, payload)],
      [CALL_EVENTS.captionsState, (_e, payload) => this.emit(SOURCE_EVENTS.state, payload)],
      [CALL_EVENTS.captionStall, (_e, payload) => this.emit(SOURCE_EVENTS.stall, payload)],
      [CALL_EVENTS.captionsReady, () => this.emit(SOURCE_EVENTS.ready)],
    ];
    for (const [channel, fn] of this._listeners) this._ipcMain.on(channel, fn);
  }

  stop() {
    if (!this._listeners) return;
    for (const [channel, fn] of this._listeners) this._ipcMain.removeListener(channel, fn);
    this._listeners = null;
  }

  // 30s: on Meet this walks the Settings dialog (a menu, a tab and a listbox,
  // verified at each step), and the provider reports the tag it actually got.
  setLanguage(language) {
    return this._callViewRequest(
      CALL_COMMANDS.setCaptionLanguage,
      { language },
      CALL_EVENTS.captionLanguageResult,
      30000,
    );
  }

  recover() {
    this._sendCallCmd(CALL_COMMANDS.recoverCaptions);
  }
}

// Transcribe the call audio ourselves (#850 phase 2, #836): the page taps the
// REMOTE audio (page-inject.js sttTap), one stream per audio track; each stream
// gets a speech gate (speech-gate.js) that hands real speech segments to an
// on-device engine (stt-whistle.js). Every segment is one caption turn:
// re-transcribed while it is still open (a partial, like a live caption) and
// settled when the speaker pauses.
//
// Attribution: streams are hot-swapped slots, never people (#839), so a stream
// only names its speaker on a 1:1 call, where any remote audio is the one other
// person. `attribute(stream)` decides; group calls get a neutral label until
// #839 lands. The bot's own voice is never tapped, so no self-filtering needed.
class AudioTranscription extends CaptionSource {
  static get id() { return 'audio'; }

  /**
   * @param {object} io
   * @param {{on: Function, removeListener: Function}} io.ipcMain
   * @param {() => void} io.startTap     tell the page to start tapping remote audio
   * @param {() => void} io.stopTap
   * @param {{transcribe: Function, ready: Function}} io.engine
   * @param {(stream: string) => string} [io.attribute]  speaker name for a stream
   * @param {() => string[]} [io.keywords]               names to bias toward
   * @param {(tag: string) => string|null} [io.engineLanguage]  BCP-47 → engine code
   * @param {Function} [io.gateFactory]  (callbacks) => SpeechGate; for tests
   * @param {Function} [io.log]
   */
  constructor({ ipcMain, startTap, stopTap, engine, attribute = () => 'unknown', keywords = () => [],
    engineLanguage = (t) => t || null, gateFactory = null, log = () => {} }) {
    super();
    this._ipcMain = ipcMain;
    this._startTap = startTap;
    this._stopTap = stopTap;
    this._engine = engine;
    this._attribute = attribute;
    this._keywords = keywords;
    this._engineLanguage = engineLanguage;
    this._gateFactory = gateFactory || ((cb) => new (require('./speech-gate.js').SpeechGate)(cb));
    this._log = log;
    this._listener = null;
    this._streams = new Map();   // stream -> { gate, chain: Promise }
    this._turns = [];            // [{ turnId, speaker, text, final }]
    this._nextTurnId = 1;
    this._language = null;
    this._readySent = false;
    this._on = false;
  }

  start() {
    if (this._listener) return;
    this._listener = (_e, msg) => this._onAudio(msg || {});
    this._ipcMain.on(STT_AUDIO_CHANNEL, this._listener);
    this._engine.ready().then(
      () => { this._on = true; this.emit(SOURCE_EVENTS.state, { on: true }); },
      (err) => { this._log('[stt] engine failed to load: ' + err.message); this.emit(SOURCE_EVENTS.state, { on: false, reason: err.message }); },
    );
    this._startTap();
  }

  stop() {
    if (!this._listener) return;
    this._ipcMain.removeListener(STT_AUDIO_CHANNEL, this._listener);
    this._listener = null;
    this._stopTap();
    for (const st of this._streams.values()) st.gate.flush();
    this._streams.clear();
    this._on = false;
  }

  async setLanguage(language) {
    const code = this._engineLanguage(language);
    if (language && !code) {
      return { ok: false, error: `the on-device speech engine doesn't support ${language}; it will auto-detect the language instead` };
    }
    this._language = language || null;
    return { ok: true, language: language || 'auto' };
  }

  recover() { this._stopTap(); this._startTap(); }

  _onAudio({ stream, pcm, at, event }) {
    if (!stream) return;
    if (event === 'detached') {
      const st = this._streams.get(stream);
      if (st) { st.gate.flush(); this._streams.delete(stream); }
      return;
    }
    if (event || !pcm) return;
    let st = this._streams.get(stream);
    if (!st) {
      st = { chain: Promise.resolve(), turn: null };
      st.gate = this._gateFactory({
        onPartial: (seg) => this._segment(stream, st, seg, false),
        onFinal: (seg) => this._segment(stream, st, seg, true),
      });
      this._streams.set(stream, st);
    }
    st.gate.push(pcm, at);
  }

  // One transcription at a time per stream, in order, so a slow partial can
  // never land after (and overwrite) its own segment's final text. A partial
  // that is still queued when a newer request arrives is skipped: only the
  // latest view of an open segment matters.
  _segment(stream, st, seg, final) {
    if (!st.turn) st.turn = { turnId: this._nextTurnId++, speaker: this._attribute(stream), text: '', final: false, startAt: seg.startAt };
    const turn = st.turn;
    if (final) st.turn = null;
    const ticket = (st.ticket = (st.ticket || 0) + 1);
    st.chain = st.chain.then(async () => {
      if (!final && ticket !== st.ticket) return; // superseded partial
      let text = '';
      let engineMs = 0;
      try {
        const r = await this._engine.transcribe(seg.audio, {
          language: this._engineLanguage(this._language),
          keywords: this._keywords(),
        });
        text = r.text;
        engineMs = r.ms || 0;
      } catch (err) {
        this._log(`[stt] transcription failed (${stream}): ${err.message}`);
        return;
      }
      if (final && Number.isFinite(seg.endAt)) {
        // The delay a person feels: from the end of what they said to the text
        // being ready (includes the gate's pause detection and padding).
        const secs = (seg.audio.length / 16000).toFixed(1);
        this._log(`[stt] final ${stream}: ${secs}s of speech, engine ${engineMs} ms, ready ${Math.max(0, Date.now() - seg.endAt)} ms after it ended: "${text}"`);
      }
      if (!text) { if (final) this._drop(turn); return; }
      turn.text = text;
      turn.final = final;
      if (!this._turns.includes(turn)) this._turns.push(turn);
      if (this._turns.length > 50) this._turns.splice(0, this._turns.length - 50);
      if (!this._readySent) { this._readySent = true; this.emit(SOURCE_EVENTS.ready); }
      this._emitTurns();
    });
  }

  _drop(turn) {
    const i = this._turns.indexOf(turn);
    if (i >= 0) { this._turns.splice(i, 1); this._emitTurns(); }
  }

  _emitTurns() {
    const turns = this._turns.map((t, i) => ({
      turnId: t.turnId,
      speaker: t.speaker,
      text: t.text,
      isBottommost: i === this._turns.length - 1,
    }));
    this.emit(SOURCE_EVENTS.turns, { turns });
  }
}

// The one source main.js listens to. It wraps whichever real source this call
// uses and re-emits its events, so main subscribes once at startup and the
// choice (platform captions vs our own transcription) can change per call.
class CaptionRouter extends CaptionSource {
  static get id() { return 'router'; }

  constructor(initial) {
    super();
    this._inner = null;
    this._relays = null;
    this._started = false;
    if (initial) this.use(initial);
  }

  /** The source currently in use. */
  get current() { return this._inner; }

  /** Switch to `source` (stopping the previous one). No-op if already in use. */
  use(source) {
    if (source === this._inner) return;
    if (this._inner) {
      for (const [ev, fn] of this._relays) this._inner.removeListener(ev, fn);
      if (this._started) this._inner.stop();
    }
    this._inner = source;
    this._relays = Object.values(SOURCE_EVENTS).map((ev) => [ev, (payload) => this.emit(ev, payload)]);
    for (const [ev, fn] of this._relays) source.on(ev, fn);
    if (this._started) source.start();
  }

  start() { this._started = true; if (this._inner) this._inner.start(); }
  stop() { this._started = false; if (this._inner) this._inner.stop(); }
  setLanguage(language) { return this._inner ? this._inner.setLanguage(language) : Promise.resolve({ ok: false, error: 'no caption source' }); }
  recover() { if (this._inner) this._inner.recover(); }
}

// Who is speaking on an audio stream, while attribution is only free on 1:1
// calls (#839): with exactly one other human in the call, it is them; any
// other count gets a neutral label rather than a guess. `participants` is the
// roster the providers report ({ name, isSelf?, isPseudo?, isBot? }).
const UNATTRIBUTED_SPEAKER = 'Caller';
function oneToOneSpeaker(participants, { selfName = '', botNames = [] } = {}) {
  const others = (participants || []).filter((p) => p && p.name
    && !p.isSelf && !p.isPseudo && !p.isBot
    && p.name !== selfName && !botNames.includes(p.name));
  return others.length === 1 ? others[0].name : UNATTRIBUTED_SPEAKER;
}

// Which source a bot should hear through, given its preference and what the
// call platform can do. Returns { source, reason }, where source is a
// CaptionSource id ('platform' | 'audio').
function resolveListenSource({ pref, providerId }) {
  const caps = providerCapabilities(providerId);
  const want = LISTEN_SOURCES.includes(pref) ? pref : 'auto';
  if (want === 'audio') return { source: 'audio', reason: 'preference' };
  if (caps.captions) {
    return { source: 'platform', reason: want === 'platform' ? 'preference' : 'provider has captions' };
  }
  return {
    source: 'audio',
    reason: want === 'platform'
      ? `${providerId} has no captions of its own, so the bot transcribes the call audio`
      : `${providerId} has no captions`,
  };
}

module.exports = {
  CaptionSource,
  PlatformCaptions,
  AudioTranscription,
  CaptionRouter,
  STT_AUDIO_CHANNEL,
  UNATTRIBUTED_SPEAKER,
  oneToOneSpeaker,
  SOURCE_EVENTS,
  LISTEN_SOURCES,
  resolveListenSource,
};
