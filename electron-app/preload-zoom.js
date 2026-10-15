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
// Hearing: the caption overlay (Show Captions), one ephemeral line attributed
// by the speaker's avatar → participants-list name. zoom-captions.js turns it
// into the caption-turns snapshots the app already ingests from Meet.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { ZoomProvider } = require('./zoom-provider');
const { ZoomCaptionTracker } = require('./zoom-captions');
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
    case CALL_COMMANDS.ACTIONS.setShareAudio:
      // set_share_audio: the room hearing the shared surface costs the bot its
      // mic on Zoom, so "audio on" is an explicit choice, off by default.
      provider.setShareAudioPaused(!!(message.payload && message.payload.muted));
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
      break;
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

let lastSharing = false;
let lastPresenter = null;
let lastSharesKey = '[]';
let prejoinTried = false;
let captchaReported = false;
let audioJoinTried = false;
let waitingLogged = false;
let reportedInCall = false;
let captionsReported = null; // null = not checked yet; true/false once known
let fiberProbed = false;
const captions = new ZoomCaptionTracker();
let inCallAt = 0;
let lastRoster = '';

function tick() {
  try {
    provider.dismissModals();

    if (!provider.inMeeting()) {
      if (provider.captchaFailed()) {
        if (!captchaReported) {
          captchaReported = true;
          prejoinTried = true; // never click Join again on our own
          console.warn('[zoom] Zoom rejected the guest join (reCAPTCHA). Not retrying. '
            + 'Sign the bot in to a Zoom account (--zoom-url=https://zoom.us/signin), or click Join in the bot view yourself.');
          emit(CALL_EVENTS.statusUpdate, 'Error: Zoom blocked the guest join (reCAPTCHA). Sign the bot in to a Zoom account, or click Join in the bot view.');
          emit('page-inject-log', '[zoom] join blocked by Zoom reCAPTCHA');
        }
        return;
      }
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

    // Our own share: report edges so the app's `sharing` follows Zoom (the app
    // retries Share until it hears this). On start, pause the share's computer
    // audio so Zoom gives the bot its mic back.
    const sharing = provider.isSharing();
    if (sharing !== lastSharing) {
      lastSharing = sharing;
      emit(CALL_EVENTS.selfPresenting, { presenting: sharing });
      console.log('[zoom] self-presenting:', sharing);
      if (sharing) setTimeout(() => provider.setShareAudioPaused(true), 500);
    }

    // Someone else's share: someone-presenting drives shared-screen reading and
    // the change-wake (#673); screen-shares-updated lists every share, ours
    // included, the way Meet's people pane does.
    const remote = provider.remoteShares();
    const presenter = remote.length ? remote[0].name : null;
    if (presenter !== lastPresenter) {
      lastPresenter = presenter;
      emit(CALL_EVENTS.someonePresenting, { presenting: !!presenter, presenterName: presenter });
      console.log('[zoom] someone presenting:', presenter);
    }
    const shares = sharing ? [...remote, { name: botName || 'self', id: 'self' }] : remote;
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
      console.log('[zoom] participants:', pk);
    }

    const newest = newestOtherChatId(provider.scrapeChatMessages());
    if (newest && newest !== lastReadChatId) setChatUnread(true);

    // Hearing: the caption overlay, attributed by avatar (#318). captions-state
    // follows whether the overlay exists (Show Captions is on), checked after
    // ~10s of setup so a slow enable doesn't flap it.
    // The overlay box mounts when Show Captions is on; #live-transcription-
    // subtitle only appears with the first words, so it can't be the test.
    const captionsOn = !!provider.doc().querySelector(ZOOM.captions.overlayBox);
    if (captionsReported !== captionsOn && Date.now() - inCallAt > 10000) {
      captionsReported = captionsOn;
      emit(CALL_EVENTS.captionsState, { on: captionsOn });
      if (!captionsOn) console.warn('[zoom] captions are off — the bot cannot hear until Show Captions is on');
    }
    // Drop the bot's own lines (its TTS gets captioned too), as Meet does, so it
    // never answers itself. Self = the roster row marked "me", or the name we
    // joined as if the roster isn't readable.
    const selfName = (parts.find((p) => p.isSelf) || {}).name || botName;
    const rows = provider.readOverlay().filter((r) => !selfName || r.speaker !== selfName);
    if (rows.length && !fiberProbed) { fiberProbed = true; provider.probeCaptionFiber(); }
    if (captions.update(rows)) {
      const turns = captions.snapshot();
      emit(CALL_EVENTS.captionTurns, { turns });
      const last = turns[turns.length - 1];
      if (last) console.log('[zoom] caption:', JSON.stringify({ speaker: last.speaker, text: last.text }));
    }
  } catch { /* DOM not ready yet */ }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[zoom] DOMContentLoaded — starting heartbeat (1s); window.zoomProvider ready');
  setInterval(tick, 1000);
});
