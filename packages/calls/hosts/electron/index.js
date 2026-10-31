// hosts/electron: the public Call over the app's CallClient, for an Electron app
// that already runs a call view with the library's preloads. Advanced: unlike
// join(), the app owns the window, the join and the session.
//
//   const call = electronCall(callClient, { platform: 'meet', name: 'Ada (AI)', leave, screenshot });

const { Call } = require('../../api/call');
const { CALL_EVENTS } = require('../../core/call-provider');
const { CHAT_TIMEOUT_ERROR } = require('../../core/call-client');

// CallClient's shape where the public Call's differs: handlers get (event, data)
// from IPC, chat replies are { ok, … } and never reject, and the roster, the
// leave and the screenshot belong to the app.
class ElectronCallAdapter {
  constructor(client, { leave, screenshot }) {
    this.client = client;
    this.leaveFn = leave;
    this.screenshotFn = screenshot;
    this.participants = [];
    this.wrapped = new Map(); // handler -> IPC handler
    this.on(CALL_EVENTS.participantsUpdated, (list) => { this.participants = list || []; });
  }

  on(channel, handler) {
    const ipcHandler = (_event, ...args) => handler(...args);
    this.wrapped.set(handler, ipcHandler);
    this.client.on(channel, ipcHandler);
    return this;
  }

  off(channel, handler) {
    const ipcHandler = this.wrapped.get(handler);
    if (ipcHandler) this.client.off(channel, ipcHandler);
    this.wrapped.delete(handler);
    return this;
  }

  setMicMuted(muted) { return this.client.setMicMuted(muted); }
  setCameraOn(on) { return this.client.setCameraOn(on); }
  speak(payload) { return this.client.speak(payload); }
  stopSpeaking(reason) { return this.client.stopSpeaking(reason); }
  startShare(type) { return this.client.startShare(type); }
  stopShare() { return this.client.stopShare(); }
  getParticipants() { return this.participants; }
  leave() { return this.leaveFn(); }
  screenshot() { return this.screenshotFn(); }

  async readChat() {
    const reply = await this.client.readChat();
    if (!reply.ok) throw new Error(reply.error || 'Reading chat failed');
    return reply.messages || [];
  }

  // A timed-out send may still post (CHAT_TIMEOUT_ERROR): reporting it as a
  // failure is what makes a caller retry and post twice, so it counts as sent.
  async sendChat(text) {
    const reply = await this.client.sendChat(text);
    return !!reply.ok || reply.error === CHAT_TIMEOUT_ERROR;
  }
}

/**
 * @param {import('../../core/call-client').CallClient} client
 * @param {object} o
 * @param {string} o.platform
 * @param {string} o.name          the bot's display name
 * @param {() => Promise} o.leave  leave the call
 * @param {() => Promise<Buffer>} o.screenshot
 */
function electronCall(client, { platform, name, leave, screenshot }) {
  return new Call(new ElectronCallAdapter(client, { leave, screenshot }), { platform, name });
}

module.exports = { electronCall };
