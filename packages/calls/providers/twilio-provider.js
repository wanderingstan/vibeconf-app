// twilio-provider.js: TwilioProvider, the CallProvider for a phone call through
// Twilio (#882). The bot's phone is a local page running Twilio's Voice SDK; a
// call is the SDK's Call object, which the preload hands over as
// session().activeCall. A phone call has audio only: no camera, chat, captions
// or screen. The incoming side (the gate, the allowlist) runs on Twilio's side
// and in preload-twilio.js; see calling-app-provider.js.

const { CallingAppProvider } = require('../core/calling-app-provider');

class TwilioProvider extends CallingAppProvider {
  static get id() { return 'twilio'; }
  static get noCaptionsError() { return 'A phone call has no captions; the bot transcribes the audio itself'; }

  async setMicMuted(muted) {
    const { activeCall } = this.call;
    if (!activeCall) return false;
    activeCall.mute(muted);
    return true;
  }

  async startShare() { console.log('[twilio] a phone call has no screen to share'); return false; }
  async readChat() { throw new Error('A phone call has no chat'); }
  async sendChat() { throw new Error('A phone call has no chat'); }

  async leave() {
    const { activeCall } = this.call;
    console.log('[twilio] leave requested →', activeCall ? 'hanging up' : 'no call');
    if (activeCall) activeCall.disconnect();
    return !!activeCall;
  }
}

module.exports = { TwilioProvider };
