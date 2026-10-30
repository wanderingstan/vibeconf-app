// page-host.js: the in-page half of the Playwright host.
//
// The Playwright host's counterpart of the app's call preloads (preload-meet.js,
// preload-zoom.js, preload-teams.js, preload-slack-huddle.js). The media core's
// own relay (tts-ended) is added with the core, in index.js. One small entry per platform
// (page-meet.js, …) hands it that platform's start function; the entry is
// bundled (bundle.js) and added as an init script, so it runs in the page
// before the platform's own scripts. It starts the provider, answers the
// provider's startup questions through the host, and sends every provider
// event out to Node. Node drives the provider through window.__vibeconfCall.
//
// Two bindings, exposed by index.js before any page script runs:
//   __vibeconfHostAsk(name, args) → Promise, the host's answer (getBotName, …)
//   __vibeconfEmit(channel, args)   one provider event, out to Node

const { CALL_EVENTS } = require('../../core/call-provider');

function hostPage(start) {
  const ask = (name, ...args) => window.__vibeconfHostAsk(name, args);
  const emit = (channel, args) => {
    try { window.__vibeconfEmit(channel, args); } catch { /* page closing */ }
  };

  const provider = start({
    getBotName: () => ask('getBotName'),
    getMode: () => ask('getMode'),
    getConfig: (keys) => ask('getConfig', keys),
  });
  window.__vibeconfCall = provider;

  for (const channel of Object.values(CALL_EVENTS)) {
    provider.on(channel, (...args) => emit(channel, args));
  }
}

module.exports = { hostPage };
