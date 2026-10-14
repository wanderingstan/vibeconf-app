// preload-zoom.js — the preload for the Zoom web client view (#318).
//
// Zoom is a single surface like Meet: the bot loads app.zoom.us/wc/join/<n>
// directly, which renders the meeting top-level. So this one preload does what
// Slack splits across two: the media patch (page-inject.js: virtual mic + camera,
// TTS) AND the DOM provider (ZoomProvider: mic, camera, chat, leave, roster).
// main.js's commands reach it as they reach preload-meet: meetView IS this view.
//
// Drive it live from this view's DevTools (contextIsolation:false):
//   zoomProvider.getParticipants()   zoomProvider.openParticipants()
//   zoomProvider.sendChat('hello')   zoomProvider.readChat()
//   zoomProvider.setMicMuted(false)  zoomProvider.setCameraOn(true)
//   zoomProvider.enableCaptions()    zoomProvider.leave()
//   zoomProvider.micLevel()          // footer VU meter, px (0 = silent)
//
// Hearing: none yet. v1 reads only the host-enabled "Full transcript" panel,
// whose selectors are unharvested, so the bot joins, speaks and chats but gets no
// transcript. That's reported once (captions-state on:false + a log line).

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { ZoomProvider } = require('./zoom-provider');
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider');
const { ZOOM } = require('./zoom-selectors');

// Match navigator.userAgentData to the spoofed Chrome UA (zoom-surface sets the
// UA string) before Zoom's scripts run, so its browser check sees Chrome.
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

// The RTCPeerConnection audio-capture hook is Meet-shaped and unused here (we
// don't read call audio); keep the getUserMedia virtual mic + play-tts path.
// Same call Slack made for Chime. Must be set before the eval below.
window.__vibeconf_disableAudioCapture = true;

try {
  const code = fs.readFileSync(path.join(__dirname, 'page-inject.js'), 'utf-8');
  (0, eval)(code);
  console.log('[zoom] page-inject.js loaded (media patch, before page scripts)');
} catch (err) {
  console.error('[zoom] Failed to load page-inject.js:', err.message);
}

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

const provider = new ZoomProvider();
try { window.zoomProvider = provider; window.ZOOM = ZOOM; } catch { /* window not ready */ }

function emit(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, payload);
  } catch { /* main not listening */ }
}

// ---------------------------------------------------------------------------
// Commands main → this view. Mic/camera go to the provider; everything else
// (play-tts, play-speech-test, avatar state, chime) is a page-inject op, so
// forward it into the page, as preload-slack-main does.
// ---------------------------------------------------------------------------
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

// Unread tracking: the newest message from someone else that the agent hasn't
// read yet. wait_for_speech surfaces chat-unread on lulls, which is how a bot
// that can't hear (v1) finds out someone typed to it.
let lastReadChatId = null;
let lastChatUnread = false;
function newestOtherChatId(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].self) return messages[i].id;
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
    lastReadChatId = newestOtherChatId(messages);
    setChatUnread(false);
    result = { ok: true, messages };
  }
  catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
  let result;
  try {
    const sent = await provider.sendChat(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (see [zoom] log)' };
  } catch (err) { result = { ok: false, error: err.message }; }
  emit(CALL_EVENTS.chatResult, { requestId, ...result });
});

ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, (_e, opts) => { provider.startShare(opts && opts.shareType); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => { provider.stopShare(); });
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => { /* no Zoom analog */ });
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => { provider.recoverCaptions(); });
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, async (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ...(await provider.setCaptionLanguage()) });
});
// requestCleanLeave sends this to meetView (which is this view) before teardown.
ipcRenderer.on('trigger-leave-call', () => { provider.leave(); });

// ---------------------------------------------------------------------------
// page-inject → main: the same forwards google-meet-provider makes. tts-ended
// matters most: main uses it to put the mic back in the mode's state.
// ---------------------------------------------------------------------------
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
// Heartbeat: get through pre-join, then report in-call and push the roster.
// ---------------------------------------------------------------------------
let botName = '';
ipcRenderer.invoke('get-meet-bot-name').then((n) => { botName = n || ''; }).catch(() => {});

let prejoinTried = false;
let audioJoinTried = false;
let waitingLogged = false;
let reportedInCall = false;
let transcriptReported = null; // null = not checked yet; true/false once known
let inCallAt = 0;
let lastRoster = '';
let lastTranscript = '';

function tick() {
  try {
    provider.dismissModals();

    if (!provider.inMeeting()) {
      if (provider.inWaitingRoom()) {
        if (!waitingLogged) { waitingLogged = true; console.log('[zoom] in the waiting room — the host has to admit the bot'); }
        return;
      }
      if (!prejoinTried && botName) { provider.fillPrejoin(botName).then((ok) => { prejoinTried = ok; }); }
      return;
    }

    if (!audioJoinTried) { audioJoinTried = true; provider.joinComputerAudio(); }

    if (!reportedInCall) {
      reportedInCall = true;
      inCallAt = Date.now();
      const meetCode = ZOOM.roomCodeFromUrl(location.href) || '';
      emit(CALL_EVENTS.statusUpdate, 'In call (Zoom)');
      emit(CALL_EVENTS.botJoinedCall, { meetCode, botName });
      console.log('[zoom] in the meeting — reported in-call (' + meetCode + ')');
      // Camera on so the virtual-camera avatar shows; open the roster so
      // participants can be read; turn on live transcription (host-only).
      setTimeout(async () => {
        try { console.log('[zoom] setCameraOn →', await provider.setCameraOn(true)); } catch (e) { console.warn('[zoom] setCameraOn error:', e.message); }
        try { console.log('[zoom] openParticipants →', await provider.openParticipants()); } catch (e) { console.warn('[zoom] openParticipants error:', e.message); }
        // Chat open too: it's how people reach a bot that can't hear yet. Whether
        // both panes stay open together is unverified — this log line says.
        try {
          const chatOk = await provider._ensureChatOpen();
          const d = provider.doc();
          console.log('[zoom] chat open →', chatOk, '| participants list still mounted:', !!d.querySelector(ZOOM.people.list));
          lastReadChatId = newestOtherChatId(provider.scrapeChatMessages()); // history at join isn't "unread"
        } catch (e) { console.warn('[zoom] open chat error:', e.message); }
        try { console.log('[zoom] enableCaptions →', await provider.enableCaptions()); } catch (e) { console.warn('[zoom] enableCaptions error:', e.message); }
      }, 2000);
    }

    const parts = provider.getParticipants();
    const pk = JSON.stringify(parts);
    if (parts.length && pk !== lastRoster) {
      lastRoster = pk;
      emit(CALL_EVENTS.participantsUpdated, parts);
      console.log('[zoom] participants:', pk);
    }

    const newest = newestOtherChatId(provider.scrapeChatMessages());
    if (newest && newest !== lastReadChatId) setChatUnread(true);

    // Give captions setup ~10s, then say once whether there's a transcript.
    const hasTranscript = provider.transcriptAvailable();
    if (transcriptReported !== hasTranscript && Date.now() - inCallAt > 10000) {
      transcriptReported = hasTranscript;
      emit(CALL_EVENTS.captionsState, { on: hasTranscript });
      if (!hasTranscript) {
        console.warn('[zoom] no Full transcript panel in this meeting — the bot can speak and chat but cannot hear. '
          + 'Zoom v1 needs the host account\'s "Full transcript" setting (#318).');
      }
    }
    if (hasTranscript) {
      const lines = provider.scrapeTranscript();
      const last = lines[lines.length - 1];
      const key = last ? last.speaker + '::' + last.text : '';
      if (last && key !== lastTranscript) {
        lastTranscript = key;
        emit(CALL_EVENTS.captionTurns, {
          turns: lines.map((c, i) => ({ turnId: i + 1, speaker: c.speaker, text: c.text, isBottommost: i === lines.length - 1 })),
        });
      }
    }
  } catch { /* DOM not ready yet */ }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[zoom] DOMContentLoaded — starting heartbeat (1s); window.zoomProvider ready');
  setInterval(tick, 1000);
});
