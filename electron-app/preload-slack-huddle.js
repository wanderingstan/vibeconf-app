// preload-slack-huddle.js — scrape/control preload for the huddle POPUP.
//
// The huddle UI renders in an about:blank popup the main window opens (#264).
// This preload is injected into that popup via the main window's
// setWindowOpenHandler (see slack-surface.js) — the Slack analog of what
// preload-meet.js is for Meet, but for the popup surface.
//
// The huddle itself runs in the library (slack-session.js: SlackProvider and its
// scrape heartbeat). This preload is its host: main's commands become provider
// calls, and the provider's events go out over IPC.
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
// Match navigator.userAgentData to the spoofed Chrome UA before Slack's scripts run
// (same Client-Hints gate as the main surface).
require('@vibeconferencing/calls/hosts/electron/slack-ua').installClientHintsShim();
const { startSlackHuddle } = require('@vibeconferencing/calls/providers/slack-session');
const { CALL_EVENTS, CALL_COMMANDS } = require('@vibeconferencing/calls/core/call-provider');
const { SLACK } = require('@vibeconferencing/calls/providers/slack-selectors');

const provider = startSlackHuddle({});

// Expose for manual driving from the popup DevTools (contextIsolation:false).
try {
  window.slackProvider = provider;
  window.SLACK = SLACK;
} catch { /* window not ready */ }

console.log('[slack-huddle] popup preload injected — window.slackProvider ready');

// ---------------------------------------------------------------------------
// Command handlers — the Slack analog of preload-meet's command IPC. main.js
// routes the call's DOM commands (mic/camera/chat/share/captions) to THIS popup
// (audio-out/play-tts goes to the main window's VirtualMic, handled there). So
// the agent's MCP/HTTP commands reach the SlackProvider.
// ---------------------------------------------------------------------------
ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: provider.setMicMuted(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: provider.setMicMuted(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn: provider.setCameraOn(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOff: provider.setCameraOn(false); break;
    // play-tts / play-speech-test ride the main window's VirtualMic, not here.
    default: break;
  }
});

ipcRenderer.on(CALL_COMMANDS.readChat, async (_e, { requestId }) => {
  let result;
  try { result = { ok: true, messages: await provider.readChat() }; }
  catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
  let result;
  try {
    const sent = await provider.sendChat(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent' };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, (_e, opts) => { provider.startShare(opts && opts.shareType); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { provider.stopShare(); });
ipcRenderer.on(CALL_COMMANDS.setStudioSound, (_e, p) => { provider.setStudioSound(!!(p && p.enabled)); });
// Slack has no separate "recover captions" — re-running enableCaptions re-asserts it.
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => { provider.enableCaptions(); });

// Every provider event goes to main on the CALL_EVENTS channel of the same name,
// so main.js's existing handlers already understand them.
function emit(channel, ...args) {
  try { ipcRenderer.send(channel, ...args); } catch { /* main not listening */ }
}
for (const channel of Object.values(CALL_EVENTS)) {
  provider.on(channel, (...args) => emit(channel, ...args));
}
