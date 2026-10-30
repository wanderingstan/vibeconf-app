// call-client.js — the app's side of the CallProvider contract.
//
// Phase 0 of the calling-library extraction (design doc: "Calling library
// extraction"). main.js used to drive the call by hand: ~a dozen raw
// webContents.send('extension-message', …) calls aimed straight at meetView,
// next to the sendCallCmd / sendExtMsg / chatRequest helpers that route by
// command. CallClient is the one object main.js now talks to for every CALL
// command. It implements CallProvider by sending the same IPC messages, byte
// for byte, to whichever view the router picks, so the providers running in
// the preloads see exactly what they saw before.
//
// What is NOT here: avatar, overlay, realtime-voice and debug messages
// (set-bot-state, set-avatar-*, set-debug-overlay, …). Those are the app
// talking to its own page-inject code, not to the call, and stay in main.js
// until page-inject is split (Phase 2).
//
// Pure module: no electron require. main.js injects the router and ipcMain,
// which keeps this testable with fakes and portable to a non-Electron host.

const { CallProvider, CALL_COMMANDS, CALL_EVENTS } = require('./call-provider.js');

const A = CALL_COMMANDS.ACTIONS;

// NOTE: a timeout here does NOT mean the renderer flow stopped — it keeps
// running and may still send. Callers must treat CHAT_TIMEOUT_ERROR as
// "unknown, possibly still in flight" and never retry on it (a retry queues
// a duplicate send behind the one that may yet succeed).
const CHAT_TIMEOUT_ERROR = 'Chat operation timed out';
const NO_CALL_VIEW_ERROR = 'No active call view';

class CallClient extends CallProvider {
  static get id() { return 'client'; }

  /**
   * @param {object} io
   * @param {(name: string) => ({ send: Function } | null)} io.resolveTarget
   *   The webContents a command or action should go to (main.js callCmdWC):
   *   in Slack mode some go to the huddle popup, everything else to meetView.
   * @param {import('events').EventEmitter} io.ipc  ipcMain, for replies + events.
   * @param {(msg: string) => void} [io.warn]
   */
  constructor({ resolveTarget, ipc, warn = console.warn }) {
    super();
    this._resolveTarget = resolveTarget;
    this._ipc = ipc;
    this._warn = warn;
    // Bound so main.js can hand them to PlatformCaptions / AudioTranscription
    // as plain functions, the shape those already take.
    this.sendCommand = this.sendCommand.bind(this);
    this.sendAction = this.sendAction.bind(this);
    this.request = this.request.bind(this);
  }

  // --- Transport ----------------------------------------------------------

  /** Send a dedicated call-command channel (trigger-screen-share, …). */
  sendCommand(channel, payload) {
    const wc = this._resolveTarget(channel);
    if (!wc) {
      // Previously a silent return — which hid #269: the whiteboard Present-now
      // trigger was dropped whenever meetView was momentarily null/destroyed, with
      // no trace. Make every dropped command visible.
      this._warn('[electron] sendCallCmd: no target webContents for "' + channel + '" — command DROPPED (call view null/destroyed?)');
      return false;
    }
    if (payload === undefined) wc.send(channel); else wc.send(channel, payload);
    return true;
  }

  /** Send an extension-message {action, …}, routed by its action. */
  sendAction(message) {
    const wc = this._resolveTarget(message && message.action);
    if (!wc) return false;
    wc.send(CALL_COMMANDS.extensionMessage, message);
    return true;
  }

  /**
   * Round-trip: send on `channel` with a fresh requestId and resolve with the
   * matching reply on `resultEvent`, or { ok: false, error } on timeout.
   * Never rejects.
   */
  request(channel, payload, resultEvent, timeoutMs = 15000, { timeoutError, idPrefix } = {}) {
    return new Promise((resolve) => {
      const wc = this._resolveTarget(channel);
      if (!wc) {
        resolve({ ok: false, error: NO_CALL_VIEW_ERROR });
        return;
      }
      const requestId = `${idPrefix || channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const handler = (_event, data) => {
        if (data?.requestId !== requestId) return;
        clearTimeout(timer);
        this._ipc.removeListener(resultEvent, handler);
        resolve(data);
      };
      const timer = setTimeout(() => {
        this._ipc.removeListener(resultEvent, handler);
        resolve({ ok: false, error: timeoutError || `${channel} timed out` });
      }, timeoutMs);
      this._ipc.on(resultEvent, handler);
      wc.send(channel, { requestId, ...payload });
    });
  }

  // --- Audio / video ------------------------------------------------------

  async setMicMuted(muted) { return this.sendAction({ action: muted ? A.muteMic : A.unmuteMic }); }
  async setCameraOn(on) { return this.sendAction({ action: on ? A.cameraOn : A.cameraOff }); }
  /** payload: { audioData (base64), emoji?, expectMore?, utt?, volume? } */
  async speak(payload) { return this.sendAction({ action: A.playTts, payload }); }
  /** Cut in-flight speech (barge-in back-off, #154). */
  async stopSpeaking(reason) { return this.sendAction({ action: A.stopTts, payload: { reason: reason || 'back-off' } }); }
  /** Resume an utterance a barge-in cut off (#350). */
  async resumeSpeaking() { return this.sendAction({ action: A.resumeTts, payload: {} }); }
  async setStudioSound(enabled) { return this.sendCommand(CALL_COMMANDS.setStudioSound, { enabled }); }

  // --- Listening ----------------------------------------------------------

  async setCaptionLanguage(language, timeoutMs = 30000) {
    return this.request(CALL_COMMANDS.setCaptionLanguage, { language }, CALL_EVENTS.captionLanguageResult, timeoutMs);
  }
  async recoverCaptions() { return this.sendCommand(CALL_COMMANDS.recoverCaptions); }
  /** Start / stop tapping remote audio for STT (calls with no captions). */
  async startAudioTap() { return this.sendAction({ action: A.startSttTap }); }
  async stopAudioTap() { return this.sendAction({ action: A.stopSttTap }); }

  // --- Chat ---------------------------------------------------------------

  readChat(timeoutMs = 15000) {
    return this.request(CALL_COMMANDS.readChat, {}, CALL_EVENTS.chatResult, timeoutMs,
      { timeoutError: CHAT_TIMEOUT_ERROR, idPrefix: 'chat' });
  }
  sendChat(text, timeoutMs = 15000) {
    return this.request(CALL_COMMANDS.sendChat, { text }, CALL_EVENTS.chatResult, timeoutMs,
      { timeoutError: CHAT_TIMEOUT_ERROR, idPrefix: 'chat' });
  }

  // --- Screen share -------------------------------------------------------

  /** type: 'window' | 'screen' | undefined (the provider's default). */
  async startShare(type) {
    return type === undefined
      ? this.sendCommand(CALL_COMMANDS.triggerScreenShare)
      : this.sendCommand(CALL_COMMANDS.triggerScreenShare, { shareType: type });
  }
  async stopShare() { return this.sendCommand(CALL_COMMANDS.triggerStopSharing); }
  async setShareAudioMuted(muted) { return this.sendAction({ action: A.setShareAudio, payload: { muted: !!muted } }); }

  // --- Events -------------------------------------------------------------
  // Providers emit CALL_EVENTS over IPC; handlers keep ipcMain's
  // (event, data) signature so existing listeners move over unchanged.
  on(channel, handler) { this._ipc.on(channel, handler); return this; }
  off(channel, handler) { this._ipc.removeListener(channel, handler); return this; }
}

module.exports = { CallClient, CHAT_TIMEOUT_ERROR, NO_CALL_VIEW_ERROR };
