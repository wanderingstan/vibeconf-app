// whatsapp-provider.js: WhatsAppProvider, the CallProvider for a WhatsApp Web
// call (#843, call links #891). The call screen's buttons are found by their
// aria-label (whatsapp-call.js). Chat is the caller's 1:1 chat, only during a
// call and only with the person on it; a call-link call (a group call the bot
// was sent to) has no caller and no chat. The incoming side stays in
// preload-whatsapp.js; see calling-app-provider.js.

const { CallingAppProvider } = require('../core/calling-app-provider');
const whatsappCall = require('./whatsapp-call');

class WhatsAppProvider extends CallingAppProvider {
  static get id() { return 'whatsapp'; }
  static get noCaptionsError() { return 'WhatsApp has no captions; the bot transcribes the call audio itself'; }

  // Calls back on screen-share changes: the preload reports self-presenting.
  constructor({ session, onSharing = () => {} } = {}) {
    super({ session });
    this._onSharing = onSharing;
  }

  press(label) {
    const b = whatsappCall.findButton(document, label);
    if (b) b.click();
    return !!b;
  }

  // The VirtualMic carries only the bot's voice: keep WhatsApp's own mute off
  // unless the app asks for it.
  async setMicMuted(muted) { return this.press(muted ? 'Mute microphone' : 'Unmute microphone'); }

  async setCameraOn(on) {
    const ok = this.press(on ? 'Turn camera on' : 'Turn camera off');
    // No button: WhatsApp has video in that state already (it turns the camera
    // on by itself for a video call).
    console.log('[whatsapp] camera', on ? 'on' : 'off', ok ? '' : '(already, no button to press)');
    return ok;
  }

  // Full rows ({ id, sender, text, fromMe }); bindToIpc trims them for the app.
  async readChat() {
    const { state, caller, botName } = this.call;
    if (state !== 'in-call') throw new Error('not in a WhatsApp call');
    if (!caller) throw new Error('A WhatsApp call-link call has no chat');
    if (!caller.peerJid) return []; // the caller's chat isn't known yet
    return whatsappCall.readChatMessages(window, caller.peerJid, { selfName: botName || 'Bot', callerName: caller.name || 'Caller' });
  }

  async sendChat(text) {
    const { state, caller } = this.call;
    if (state !== 'in-call') throw new Error('not in a WhatsApp call');
    if (!caller || !caller.peerJid) throw new Error('A WhatsApp call-link call has no chat');
    await whatsappCall.sendChatMessage(window, caller.peerJid, text);
    console.log('[whatsapp] sent a chat message to', caller.name || caller.phone);
    return true;
  }

  // Screen share: WhatsApp's own ⋮ → "Share screen". It then asks
  // getDisplayMedia, which the app answers with the whiteboard window (no
  // picker), so the room sees the bot's whiteboard.
  async startShare() {
    if (!this.inCall()) { console.log('[whatsapp] share asked for outside a call — ignored'); return false; }
    if (whatsappCall.findMenuItem(document, 'Stop sharing screen')) { this._onSharing(true); return true; }
    const ok = await whatsappCall.chooseCallMenuItem(window, 'Share screen');
    console.log('[whatsapp] share screen →', ok ? 'started' : 'no "Share screen" in the call menu');
    if (ok) this._onSharing(true);
    return ok;
  }

  async stopShare() {
    const ok = await whatsappCall.chooseCallMenuItem(window, 'Stop sharing screen');
    console.log('[whatsapp] stop sharing →', ok ? 'stopped' : 'was not sharing');
    this._onSharing(false);
    return ok;
  }

  async leave() {
    const ok = this.press('End call') || this.press('Decline');
    console.log('[whatsapp] leave requested →', ok ? 'pressed' : 'no call on screen');
    return ok;
  }
}

module.exports = { WhatsAppProvider };
