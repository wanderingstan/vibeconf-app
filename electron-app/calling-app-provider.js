// calling-app-provider.js: the CallProvider half of a calling app (WhatsApp,
// Telegram, a Twilio phone line). Phase 1 step 4 of the calls library.
//
// A calling app is answered, not joined: someone calls the bot's own account.
// That incoming side (the allowlist, accept/decline, standby, missed calls)
// stays in each app's preload, outside CallProvider; the library will need a
// separate incoming-calls API for it (call.onIncoming, accept, decline). What
// these classes cover is the call itself once it is up, the same contract
// Meet, Zoom, Teams and Slack implement: mic, camera, chat, share, leave.
//
// The preload owns the call's state and passes a `session` reader:
//   session() → { state, caller, botName }
//   state    'idle' | 'deciding' | 'ignoring' | 'answering' | 'in-call'
//   caller   who is on the call (app-specific fields), null for none
//
// Pure-ish: requires only the contract. Browser globals resolve at run time in
// the page (contextIsolation:false), as in the other providers.

const { CallProvider, CALL_COMMANDS, CALL_EVENTS } = require('./call-provider');

class CallingAppProvider extends CallProvider {
  constructor({ session } = {}) {
    super();
    this._session = session || (() => ({ state: 'idle', caller: null, botName: '' }));
  }

  get call() { return this._session(); }
  inCall() { return this.call.state === 'in-call'; }

  // What the app answers when asked for something it can't do. Subclasses
  // set the wording; it reaches the agent as the command's error.
  static get noCaptionsError() { return 'This app has no captions; the bot transcribes the call audio itself'; }

  // No platform captions: the bot hears through the audio tap and its own STT
  // (caption-source.js), so there is nothing to switch on, recover or retune.
  async setCaptionLanguage() { return { ok: false, error: this.constructor.noCaptionsError }; }
  async enableCaptions() { return false; }
  async recoverCaptions() {}
  async setStudioSound() {}
  async setShareAudioMuted() {}

  async startShare() { console.log(this.constructor.tag + ' screen share is not supported here'); return false; }
  async stopShare() { return false; }
  async setCameraOn() { return false; }

  async readChat() { throw new Error('This call has no chat'); }
  async sendChat() { throw new Error('This call has no chat'); }

  getParticipants() {
    const c = this.call;
    if (c.state !== 'in-call') return [];
    return [{ name: c.botName || 'Bot', speaking: false, isSelf: true },
      ...(c.caller ? [{ name: c.caller.name || 'Caller', speaking: false, isSelf: false }] : [])];
  }

  static get tag() { return '[' + this.id + ']'; }
}

// Wire a calling-app provider to the app's call commands. The one copy of what
// each calling-app preload used to switch over by hand. `afterRead(messages)`
// runs after a successful chat read (the preload tracks what it has read, for
// the unread badge); `messages` are the provider's full rows.
function bindToIpc(ipcRenderer, provider, { emit, afterRead = () => {} } = {}) {
  ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
    if (!message) return;
    switch (message.action) {
      case CALL_COMMANDS.ACTIONS.unmuteMic: provider.setMicMuted(false); break;
      case CALL_COMMANDS.ACTIONS.muteMic: provider.setMicMuted(true); break;
      case CALL_COMMANDS.ACTIONS.cameraOn: provider.setCameraOn(true); break;
      case CALL_COMMANDS.ACTIONS.cameraOff: provider.setCameraOn(false); break;
      default:
        // The media work (TTS, the STT tap) is page-inject's, on this page.
        window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
    }
  });
  ipcRenderer.on(CALL_COMMANDS.readChat, async (_e, { requestId }) => {
    try {
      const messages = await provider.readChat();
      afterRead(messages);
      emit(CALL_EVENTS.chatResult, { requestId, ok: true, messages: messages.map(({ id, sender, text }) => ({ id, sender, text })) });
    } catch (err) { emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: err.message }); }
  });
  ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
    try {
      await provider.sendChat(text);
      emit(CALL_EVENTS.chatResult, { requestId, ok: true });
    } catch (err) { emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: err.message }); }
  });
  ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, async (_e, { requestId } = {}) => {
    emit(CALL_EVENTS.captionLanguageResult, { requestId, ...(await provider.setCaptionLanguage()) });
  });
  ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, () => { provider.startShare(); });
  ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { provider.stopShare(); });
  ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => { provider.setStudioSound(); });
  ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => { provider.recoverCaptions(); });
  ipcRenderer.on('trigger-leave-call', () => { provider.leave(); });
}

module.exports = { CallingAppProvider, bindToIpc };
