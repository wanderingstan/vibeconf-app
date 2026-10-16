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
//     └─ AudioTranscription transcribes tapped call audio (phase 2, not yet)
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

// Values of the listenSource preference. 'audio' arrives with phase 2; until
// then a provider without captions has no way to hear, and says so.
const LISTEN_SOURCES = ['auto', 'platform'];

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

// Which source a bot should hear through, given its preference and what the
// call platform can do. Returns { source, reason }, where source is a
// CaptionSource id or null when nothing can hear this call.
function resolveListenSource({ pref, providerId }) {
  const caps = providerCapabilities(providerId);
  const want = LISTEN_SOURCES.includes(pref) ? pref : 'auto';
  if (caps.captions) {
    return { source: 'platform', reason: want === 'platform' ? 'preference' : 'provider has captions' };
  }
  return { source: null, reason: `${providerId} has no captions and audio transcription is not built yet (#850 phase 2)` };
}

module.exports = {
  CaptionSource,
  PlatformCaptions,
  SOURCE_EVENTS,
  LISTEN_SOURCES,
  resolveListenSource,
};
