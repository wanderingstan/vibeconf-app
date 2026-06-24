// preload-slack-huddle.js — scrape/control preload for the huddle POPUP.
//
// The huddle UI renders in an about:blank popup the main window opens (#264).
// This preload is injected into that popup via the main window's
// setWindowOpenHandler (see slack-surface.js) — the Slack analog of what
// preload-meet.js is for Meet, but for the popup surface.
//
// FIRST PASS (live-test harness): instantiate SlackProvider, expose it on the
// popup's window for hands-on driving from DevTools (contextIsolation:false), and
// run a light scrape heartbeat that pushes participants + captions up to main
// over the existing CALL_EVENTS channels. Full command IPC wiring (mute, speak,
// chat, share) comes after the DOM layer is verified against a live huddle.
//
// Drive it live: open this popup's DevTools and call, e.g.
//   slackProvider.getParticipants()
//   slackProvider.getSpeakingNames()
//   slackProvider.enableCaptions()        // ⋯ → Show captions → Side-by-side
//   slackProvider.switchToCaptionsTab()   // in-popup Captions tab (alternative)
//   slackProvider.readCaptions()
//   slackProvider.sendChat('hello from the bot')
//   slackProvider.setCameraOn(true) / setMicMuted(false) / startShare()
//
// CAVEAT (verify live): "Side-by-side" captions reportedly open in a NEW window.
// If so, our setWindowOpenHandler injects this same preload there too, so a
// second window.slackProvider appears and scrapes that window's transcript. The
// in-popup "Captions" tab keeps captions on THIS surface — try both.

const { ipcRenderer } = require('electron');
const { SlackProvider } = require('./slack-provider');
const { CALL_EVENTS } = require('./call-provider');
const { SLACK } = require('./slack-selectors');

const provider = new SlackProvider();

// Expose for manual driving from the popup DevTools (contextIsolation:false).
try {
  window.slackProvider = provider;
  window.SLACK = SLACK;
} catch { /* window not ready */ }

console.log('[slack-huddle] popup preload injected — window.slackProvider ready');

// Emit on the same CALL_EVENTS channels Meet uses, so main.js's existing
// handlers already understand them. Preserve the no-payload arg shape.
function emit(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, payload);
  } catch { /* main not listening */ }
}

// Scrape heartbeat: once the huddle UI is up, push roster + captions so we can
// watch scraping work end-to-end. Deduped to avoid log/IPC spam.
let lastRoster = '';
let lastCaption = '';
let reportedInCall = false;
function tick() {
  try {
    const parts = provider.getParticipants();
    // Once participant tiles exist we're past the lobby and actually in the
    // huddle — tell the app so it flips to 'in-call' (main.js maps a status
    // containing "In call" → in-call), which unlocks the panel (TTS test, etc.).
    if (!reportedInCall && parts.length) {
      reportedInCall = true;
      emit(CALL_EVENTS.statusUpdate, 'In call (Slack huddle)');
      console.log('[slack-huddle] in a huddle — reported in-call to the app');
      // Standard join setup: turn on side-by-side captions (the Slack analog of
      // auto-enabling captions on Meet). Delay so the in-call toolbar settles.
      setTimeout(() => {
        provider.enableCaptions()
          .then((ok) => console.log('[slack-huddle] enableCaptions →', ok))
          .catch((e) => console.warn('[slack-huddle] enableCaptions error:', e && e.message));
      }, 2000);
    }
    const pk = JSON.stringify(parts);
    if (parts.length && pk !== lastRoster) {
      lastRoster = pk;
      emit(CALL_EVENTS.participantsUpdated, parts);
      console.log('[slack-huddle] participants:', JSON.stringify(parts));
    }
    const caps = provider.scrapeCaptions();
    if (caps.length) {
      const last = caps[caps.length - 1];
      const ck = last.speaker + '::' + last.text;
      if (ck !== lastCaption) {
        lastCaption = ck;
        emit(CALL_EVENTS.captionTurns, {
          turns: caps.map((c, i) => ({ turnId: i + 1, speaker: c.speaker, text: c.text, isBottommost: i === caps.length - 1 })),
        });
        console.log('[slack-huddle] caption:', JSON.stringify(last));
      }
    }
  } catch { /* DOM not ready yet */ }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[slack-huddle] DOMContentLoaded — starting scrape heartbeat (1s)');
  setInterval(tick, 1000);
});
