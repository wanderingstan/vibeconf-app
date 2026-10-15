// preload-teams.js — the preload for the Microsoft Teams web client view.
//
// Same shape as preload-zoom.js: Teams renders the meeting top-level, so one
// preload carries both page-inject (virtual mic/camera, TTS) and TeamsProvider,
// and main.js's commands reach it the way they reach preload-meet.
//
// Drive it live from this view's DevTools (contextIsolation:false):
//   teamsProvider.scrapeCaptions()   teamsProvider.enableCaptions()
//   teamsProvider.sendChat('hello')  teamsProvider.readChat()
//   teamsProvider.setMicMuted(false) teamsProvider.leave()

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { TeamsProvider } = require('./teams-provider');
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider');
const { TEAMS } = require('./teams-selectors');

// Present as current Chrome (main sets the UA string; this matches
// navigator.userAgentData to it) before Teams' scripts run.
require('./slack-ua').installClientHintsShim();

(function installTimestampedConsole() {
  const _ts = () => {
    const d = new Date();
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  };
  const TS_RE = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
  const wrap = (fn) => (...args) => {
    if (args.length && typeof args[0] === 'string' && TS_RE.test(args[0])) fn(...args);
    else fn(_ts(), ...args);
  };
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
})();

// Recon (#814): log where Teams' call audio lives. Off unless
// VIBECONF_AUDIO_PROBE=1. Installed before page-inject and Teams' scripts.
if (process.env.VIBECONF_AUDIO_PROBE === '1') require('./audio-probe').installAudioProbe('[teams]');

// The Meet-shaped RTCPeerConnection audio hook is unused here; keep the
// getUserMedia virtual mic + play-tts path (as Slack and Zoom do).
window.__vibeconf_disableAudioCapture = true;

try {
  const code = fs.readFileSync(path.join(__dirname, 'page-inject.js'), 'utf-8');
  (0, eval)(code);
  console.log('[teams] page-inject.js loaded (media patch, before page scripts)');
} catch (err) {
  console.error('[teams] Failed to load page-inject.js:', err.message);
}

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

// Call recording: start/stop the page recorder and carry its tracks to main
// (#814). Without this a Teams recording was silent video.
require('./preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[teams]' });

const provider = new TeamsProvider();
// NOT window.TEAMS: Teams' own app may read globals by that name, and a stray
// one is exactly the kind of thing that flips its desktop-client detection.
try { window.teamsProvider = provider; window.__vibeTeamsSelectors = TEAMS; } catch { /* window not ready */ }

// Recon: what Teams can see of this environment. It redirected the bot to
// /error/eoa ("Classic Teams is no longer available"), i.e. it decided this is
// the old Electron desktop client. Log the usual tells once per page.
try {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map((b) => b.brand + '/' + b.version).join(', ');
  console.log('[teams] env:', JSON.stringify({
    ua: navigator.userAgent,
    brands,
    process: typeof window.process,
    require: typeof window.require,
    module: typeof window.module,
    electron: typeof window.electron,
    path: location.pathname,
  }));
} catch { /* recon only */ }

function emit(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, payload);
  } catch { /* main not listening */ }
}

ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: provider.setMicMuted(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: provider.setMicMuted(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn: provider.setCameraOn(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOff: provider.setCameraOn(false); break;
    default:
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
  }
});

let lastReadChatId = null;
let lastChatUnread = false;
function newestOtherChatId(messages, selfName) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].sender !== selfName) return messages[i].id;
  return null;
}
function setChatUnread(unread) {
  if (unread === lastChatUnread) return;
  lastChatUnread = unread;
  emit(CALL_EVENTS.chatUnread, { unread });
}

ipcRenderer.on(CALL_COMMANDS.readChat, async (_e, { requestId }) => {
  let result;
  try {
    const messages = await provider.readChat();
    lastReadChatId = newestOtherChatId(messages, botName);
    setChatUnread(false);
    result = { ok: true, messages };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
  let result;
  try {
    const sent = await provider.sendChat(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (see [teams] log)' };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, (_e, opts) => { provider.startShare(opts && opts.shareType); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { provider.stopShare(); });
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => { /* no Teams analog */ });
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => { provider.recoverCaptions(); });
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, async (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ...(await provider.setCaptionLanguage()) });
});
ipcRenderer.on('trigger-leave-call', () => { provider.leave(); });

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  const { action, payload } = event.data;
  if (action === 'tts-ended') emit(CALL_EVENTS.ttsEnded);
  else if (action === 'tts-stopped') emit('tts-stopped', payload || {});
  else if (action === 'self-audio') emit('self-audio', { loud: !!payload?.loud, at: payload?.at || Date.now() });
  else if (action === 'log' && payload?.line) emit('page-inject-log', payload.line);
  else if (action === 'avatar-emoji' && payload?.emoji) emit('avatar-emoji-changed', payload.emoji);
});

// ---------------------------------------------------------------------------
// Heartbeat: launcher → pre-join → (lobby) → in-call, then captions/roster/chat.
// ---------------------------------------------------------------------------
let botName = '';
ipcRenderer.invoke('get-meet-bot-name').then((n) => { botName = n || ''; provider.selfName = botName; }).catch(() => {});

let lastSharing = false;
let lastPresenter = null;
let lastSharesKey = '[]';
let launcherClicked = false;
let prejoinDone = false;
let lobbyLogged = false;
let reportedInCall = false;
let captionsReported = null;
let inCallAt = 0;
let lastCaptionKey = '';
let lastRoster = '';

function tick() {
  try {
    if (!provider.inMeeting()) {
      if (!launcherClicked && provider.clickJoinOnWeb()) { launcherClicked = true; return; }
      if (provider.inLobby()) {
        if (!lobbyLogged) { lobbyLogged = true; console.log('[teams] in the lobby — the organizer has to admit the bot'); }
        return;
      }
      if (!prejoinDone && botName) { provider.fillPrejoin(botName).then((ok) => { if (ok) prejoinDone = true; }); }
      return;
    }

    if (!reportedInCall) {
      reportedInCall = true;
      inCallAt = Date.now();
      emit(CALL_EVENTS.statusUpdate, 'In call (Teams)');
      emit(CALL_EVENTS.botJoinedCall, { meetCode: '', botName });
      console.log('[teams] in the meeting — reported in-call');
      setTimeout(async () => {
        try {
          const b = document.querySelector(TEAMS.toolbar.mic);
          console.log('[teams] mic button state:', JSON.stringify({ aria: b && b.getAttribute('aria-label'), pressed: b && b.getAttribute('aria-pressed'), checked: b && b.getAttribute('aria-checked') }));
        } catch { /* recon log only */ }
        try { console.log('[teams] enableCaptions →', await provider.enableCaptions()); } catch (e) { console.warn('[teams] enableCaptions error:', e.message); }
        try {
          console.log('[teams] chat open →', await provider._ensureChatOpen());
          lastReadChatId = newestOtherChatId(provider.scrapeChatMessages(), botName);
        } catch (e) { console.warn('[teams] open chat error:', e.message); }
      }, 2000);
    }

    // Our own share: report edges, so the app stops retrying Share (which, on
    // Teams, toggles the share off) once it has started.
    const sharing = provider.isSharing();
    if (sharing !== lastSharing) {
      lastSharing = sharing;
      emit(CALL_EVENTS.selfPresenting, { presenting: sharing });
      console.log('[teams] self-presenting:', sharing);
    }

    // Someone else's share → someone-presenting (screen reading, #673 wake);
    // every share → screen-shares-updated, ours included, as on Meet and Zoom.
    const stageShares = provider.screenShares();
    const others = stageShares.filter((s) => s.name !== botName);
    const presenter = others.length ? others[others.length - 1].name : null;
    if (presenter !== lastPresenter) {
      lastPresenter = presenter;
      emit(CALL_EVENTS.someonePresenting, { presenting: !!presenter, presenterName: presenter });
      console.log('[teams] someone presenting:', presenter);
    }
    const shares = sharing && !stageShares.some((s) => s.name === botName)
      ? [...stageShares, { name: botName || 'self', id: 'self' }] : stageShares;
    const sharesKey = JSON.stringify(shares);
    if (sharesKey !== lastSharesKey) {
      lastSharesKey = sharesKey;
      emit(CALL_EVENTS.screenSharesUpdated, shares);
    }

    const parts = provider.getParticipants();
    const pk = JSON.stringify(parts);
    if (parts.length && pk !== lastRoster) {
      lastRoster = pk;
      emit(CALL_EVENTS.participantsUpdated, parts);
      console.log('[teams] participants:', pk);
    }

    const newest = newestOtherChatId(provider.scrapeChatMessages(), botName);
    if (newest && newest !== lastReadChatId) setChatUnread(true);

    const captionsOn = provider.captionsOn();
    if (captionsReported !== captionsOn && Date.now() - inCallAt > 10000) {
      captionsReported = captionsOn;
      emit(CALL_EVENTS.captionsState, { on: captionsOn });
      if (!captionsOn) console.warn('[teams] captions are off — the bot cannot hear until they are on');
    }
    // Captions are a persistent named list (like Meet's pane): send the visible
    // snapshot, minus the bot's own lines so it never answers itself.
    const caps = provider.scrapeCaptions().filter((c) => !botName || c.speaker !== botName);
    const last = caps[caps.length - 1];
    const key = last ? caps.length + '::' + last.speaker + '::' + last.text : '';
    if (last && key !== lastCaptionKey) {
      lastCaptionKey = key;
      emit(CALL_EVENTS.captionTurns, {
        turns: caps.map((c, i) => ({ turnId: i + 1, speaker: c.speaker, text: c.text, isBottommost: i === caps.length - 1 })),
      });
      console.log('[teams] caption:', JSON.stringify(last));
    }
  } catch { /* DOM not ready yet */ }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[teams] DOMContentLoaded — starting heartbeat (1s); window.teamsProvider ready');
  setInterval(tick, 1000);
});

// Hide Node's `process` from Teams. With contextIsolation:false it is a page
// global, and Teams v2 reads it as "this is the Classic Teams Electron desktop
// client" and redirects to /error/eoa ("Classic Teams is no longer available")
// — seen live 2026-10-15 (env log: process:"object"). Everything above holds its
// own references, so removing the global after setup is safe. Last line on
// purpose: nothing below may need it.
try { delete window.process; } catch { /* non-configurable: fall through */ }
if (typeof window.process !== 'undefined') {
  try { Object.defineProperty(window, 'process', { value: undefined, configurable: true, writable: true }); } catch { /* best effort */ }
}
