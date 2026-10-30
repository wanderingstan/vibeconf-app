// telegram-provider.js: TelegramProvider, the CallProvider for a Telegram Web
// call (#843). Chat is the caller's 1:1 Telegram chat, opened behind the call
// screen (telegram-call.js): every read and send first checks the open chat is
// theirs. No camera and no screen share: as the answering side Telegram Web
// can't add video (#889). The incoming side stays in preload-telegram.js; see
// calling-app-provider.js.

const { CallingAppProvider } = require('./calling-app-provider');
const telegramCall = require('./telegram-call');

class TelegramProvider extends CallingAppProvider {
  static get id() { return 'telegram'; }
  static get noCaptionsError() { return 'Telegram has no captions; the bot transcribes the call audio itself'; }

  // typeText(text): types as a keyboard would, through main
  // (webContents.insertText); it works where the page's own editing commands
  // don't, in a view without keyboard focus.
  constructor({ session, typeText } = {}) {
    super({ session });
    this._typeText = typeText;
  }

  // Mic: the VirtualMic carries only the bot's voice, so "muted" in Telegram's
  // own UI would silence the bot. Keep it unmuted unless the app asks otherwise.
  async setMicMuted(muted) {
    const btn = telegramCall.findCallButton(document, muted ? 'mute' : 'unmute');
    return btn ? telegramCall.pressButton(btn) : false;
  }

  // No camera on Telegram calls. As the answering side, Telegram Web can't add
  // video: its renegotiation offer is never answered, and pressing "start
  // video" only leaves the negotiation wedged (audio carries on). The
  // caller-side workaround didn't hold up either. Full write-up: #889.
  async setCameraOn() { return false; }

  async startShare() { console.log('[telegram] screen share is not supported on Telegram calls yet'); return false; }

  // Full rows ({ id, sender, text, fromMe }); bindToIpc trims them for the app.
  async readChat() {
    const { state, caller, botName } = this.call;
    if (state !== 'in-call' || !caller || !caller.id) throw new Error('not in a Telegram call');
    if (!(await telegramCall.openChat(document, caller.id))) throw new Error("could not open the caller's chat");
    return telegramCall.readChatMessages(document, { selfName: botName || 'Bot', callerName: caller.name || 'Caller' });
  }

  async sendChat(text) {
    await this.readChat(); // opens and verifies the caller's chat
    await telegramCall.sendChatMessage(document, text, { typeText: this._typeText });
    const { caller } = this.call;
    console.log('[telegram] sent a chat message to', caller.name || caller.id);
    return true;
  }

  async leave() {
    const btn = telegramCall.findCallButton(document, 'end call') || telegramCall.findCallButton(document, 'decline');
    console.log('[telegram] leave requested →', btn ? 'pressing ' + (btn.parentElement.innerText || '').trim() : 'no call on screen');
    return telegramCall.pressButton(btn);
  }
}

module.exports = { TelegramProvider };
