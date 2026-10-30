// page-host.js: the in-page half of the Playwright host, for Google Meet.
//
// The Playwright host's counterpart of preload-meet.js. It is bundled with the
// provider (bundle.js) and added as an init script, so it runs in the page
// before Meet's own scripts. It starts the provider, answers the provider's
// startup questions through the host, and sends every provider event out to
// Node. Node drives the provider through window.__vibeconfCall.
//
// Two bindings, exposed by index.js before any page script runs:
//   __vibeconfHostAsk(name, args) → Promise, the host's answer (getBotName, …)
//   __vibeconfEmit(channel, args)   one provider event, out to Node

const { startGoogleMeet } = require('../../providers/google-meet-provider');
const { CALL_EVENTS } = require('../../core/call-provider');

const ask = (name, ...args) => window.__vibeconfHostAsk(name, args);
const emit = (channel, args) => {
  try { window.__vibeconfEmit(channel, args); } catch { /* page closing */ }
};

const provider = startGoogleMeet({
  getBotName: () => ask('getBotName'),
  getMode: () => ask('getMode'),
  getConfig: (keys) => ask('getConfig', keys),
});
window.__vibeconfCall = provider;

for (const channel of Object.values(CALL_EVENTS)) {
  provider.on(channel, (...args) => emit(channel, args));
}

// The media core says when an utterance has finished playing; on Electron the
// preload relays the same message (CALL_EVENTS.ttsEnded).
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  if (event.data.action === 'tts-ended') emit(CALL_EVENTS.ttsEnded, []);
});
