// preload-telegram.js — the preload for Telegram Web A as a call surface (#843).
//
// Unlike Meet, Zoom and Teams there is no link to join: the bot sits in its own
// Telegram account ("standby") and calls come to it. This preload watches for
// the incoming-call screen, asks MAIN whether this caller may be answered (the
// allowlist lives there, never in the page), answers, and then reports the call
// the way preload-teams does, so the rest of the app treats it as any call.
//
// Hearing: Telegram has no captions, and its call audio never reaches an
// <audio> element; it arrives on the RTCPeerConnection, which page-inject's
// audio capture hooks (left ON here, as on Meet). The sttTap reads it from
// there for on-device transcription. Speaking: page-inject's getUserMedia
// override hands Telegram the VirtualMic, so the bot's real microphone is never
// used (answering on the real mic echoed the caller back to themselves).
//
// Drive it live from this view's DevTools (contextIsolation:false):
//   telegramCall.callPhase(document)   telegramCall.readCaller(document)

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const telegramCall = require('./telegram-call');
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider');

// Present as current Chrome (main sets the UA string; this matches
// navigator.userAgentData to it) before Telegram's scripts run.
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

require('./dom-probe').installDomProbe({ tag: '[telegram]', defaultSelector: '.ActiveCallHeader' });

// Emoji sets (#828): the camera face's bundled art reaches page-inject only
// through resolvers this preload installs (it has no fs).
try { require('./emoji-assets.js').installPageResolvers(globalThis, __dirname); } catch (err) {
  console.error('[telegram] emoji resolvers failed (faces stay native):', err.message);
}

try {
  const code = fs.readFileSync(path.join(__dirname, 'page-inject.js'), 'utf-8');
  (0, eval)(code);
  console.log('[telegram] page-inject.js loaded (media patch, before page scripts)');
} catch (err) {
  console.error('[telegram] Failed to load page-inject.js:', err.message);
}

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

require('./preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[telegram]' });
// Speech-to-text tap → main: the only way this bot hears a Telegram call.
require('./preload-stt-bridge').installSttBridge(ipcRenderer);

try { window.telegramCall = telegramCall; } catch { /* window not ready */ }

// The call's own peer connections, so "in call" waits for "connected".
// Wraps page-inject's wrapper (installed just above); the realtime voice
// session uses the native constructor and so is not counted.
const callConnections = [];
(function trackCallConnections() {
  const Wrapped = window.RTCPeerConnection;
  if (!Wrapped) return;
  window.RTCPeerConnection = function (...args) {
    const pc = new Wrapped(...args);
    callConnections.push(pc);
    if (callConnections.length > 8) callConnections.shift();
    return pc;
  };
  window.RTCPeerConnection.prototype = Wrapped.prototype;
  for (const k of Object.keys(Wrapped)) { try { window.RTCPeerConnection[k] = Wrapped[k]; } catch { /* read-only */ } }
})();
const callConnected = () => callConnections.some((pc) => pc.connectionState === 'connected');
// For DevTools: what the call is sending (getStats on these).
try { window.__vibeTelegramConnections = callConnections; } catch { /* window not ready */ }

// Type as a keyboard would, through main (webContents.insertText): works when
// the page's own editing commands don't, in a view without keyboard focus.
const keyboardType = (text) => ipcRenderer.invoke('calling-app-insert-text', { text });

function emit(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, payload);
  } catch { /* main not listening */ }
}

// Mic: the VirtualMic carries only the bot's voice, so "muted" in Telegram's
// own UI would silence the bot. Keep it unmuted unless the app asks otherwise.
function setMicMuted(muted) {
  const btn = telegramCall.findCallButton(document, muted ? 'mute' : 'unmute');
  return btn ? telegramCall.pressButton(btn) : false;
}

// No camera on Telegram calls. As the answering side, Telegram Web can't add
// video: its renegotiation offer is never answered, and pressing "start video"
// only leaves the negotiation wedged (audio carries on). The caller-side
// workaround didn't hold up either. Full write-up: #889.

ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: setMicMuted(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: setMicMuted(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn:
    case CALL_COMMANDS.ACTIONS.cameraOff: break; // no video on Telegram calls (#889)
    default:
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
  }
});

// Chat = the caller's 1:1 Telegram chat, opened behind the call screen (see
// telegram-call.js). Only during a call, only with the person on it: every
// read and send first checks the open chat is theirs.
let lastReadChatId = null;
let lastChatUnread = false;
function setChatUnread(unread) {
  if (unread === lastChatUnread) return;
  lastChatUnread = unread;
  emit(CALL_EVENTS.chatUnread, { unread });
}
function newestFromCaller(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].fromMe) return messages[i].id;
  return null;
}
async function callerChatMessages() {
  if (state !== 'in-call' || !caller || !caller.id) throw new Error('not in a Telegram call');
  if (!(await telegramCall.openChat(document, caller.id))) throw new Error("could not open the caller's chat");
  return telegramCall.readChatMessages(document, { selfName: botName || 'Bot', callerName: caller.name || 'Caller' });
}
ipcRenderer.on(CALL_COMMANDS.readChat, async (_e, { requestId }) => {
  try {
    const messages = await callerChatMessages();
    lastReadChatId = newestFromCaller(messages);
    setChatUnread(false);
    emit(CALL_EVENTS.chatResult, { requestId, ok: true, messages: messages.map(({ id, sender, text }) => ({ id, sender, text })) });
  } catch (err) { emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: err.message }); }
});
ipcRenderer.on(CALL_COMMANDS.sendChat, async (_e, { requestId, text }) => {
  try {
    await callerChatMessages(); // opens and verifies the caller's chat
    await telegramCall.sendChatMessage(document, text, { typeText: keyboardType });
    console.log('[telegram] sent a chat message to', caller.name || caller.id);
    emit(CALL_EVENTS.chatResult, { requestId, ok: true });
  } catch (err) { emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: err.message }); }
});
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ok: false, error: 'Telegram has no captions; the bot transcribes the call audio itself' });
});
ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, () => { console.log('[telegram] screen share is not supported on Telegram calls yet'); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => {});
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => {});
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => {});
ipcRenderer.on('trigger-leave-call', () => {
  const btn = telegramCall.findCallButton(document, 'end call') || telegramCall.findCallButton(document, 'decline');
  console.log('[telegram] leave requested →', btn ? 'pressing ' + (btn.parentElement.innerText || '').trim() : 'no call on screen');
  telegramCall.pressButton(btn);
});

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  const { action, payload } = event.data;
  if (action === 'tts-ended') emit(CALL_EVENTS.ttsEnded);
  else if (action === 'tts-stopped') emit('tts-stopped', payload || {});
  else if (action === 'self-audio') emit('self-audio', { loud: !!payload?.loud, at: payload?.at || Date.now() });
  else if (action === 'log' && payload?.line) emit('page-inject-log', payload.line);
  else if (action === 'avatar-emoji' && payload?.emoji) emit('avatar-emoji-changed', payload.emoji);
});

// The caller's usernames, from Telegram's own cached state for that user id
// (IndexedDB tt-data → tt-global-state, as calling-app-accounts reads the
// bot's own profile). Never from the call screen's text. [] when not cached.
function lookupUsernames(id) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('tt-data');
      req.onerror = () => resolve([]);
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains('store')) { db.close(); return resolve([]); }
          const get = db.transaction('store').objectStore('store').get('tt-global-state');
          get.onsuccess = () => {
            db.close();
            let g = get.result;
            if (typeof g === 'string') { try { g = JSON.parse(g); } catch { g = null; } }
            const u = g && g.users && g.users.byId && g.users.byId[id];
            resolve(u ? (u.usernames || []).map((x) => x.username).concat(u.username ? [u.username] : []).filter(Boolean) : []);
          };
          get.onerror = () => { db.close(); resolve([]); };
        } catch { db.close(); resolve([]); }
      };
    } catch { resolve([]); }
  });
}

// ---------------------------------------------------------------------------
// Heartbeat: idle → ringing → (deciding) → answering → in-call → ended.
// ---------------------------------------------------------------------------
let botName = '';
ipcRenderer.invoke('get-meet-bot-name').then((n) => { botName = n || ''; }).catch(() => {});

let state = 'idle';   // idle | deciding | ignoring | answering | in-call
let ringSeenAt = 0;
let caller = null;
let answerPressedAt = 0;

// How long to wait for the caller's avatar (and so their id) to draw before
// deciding without it. Without an id the call is not answered.
const ID_WAIT_MS = 3000;
// How long an answered call may take to connect before the bot gives up.
const CONNECT_TIMEOUT_MS = 20000;

async function decide() {
  const seen = telegramCall.readCaller(document);
  if (!seen.id && Date.now() - ringSeenAt < ID_WAIT_MS) { state = 'idle'; return; } // retry next tick
  caller = { id: seen.id, name: seen.name, usernames: seen.id ? await lookupUsernames(seen.id) : [] };
  let verdict = { answer: false, reason: 'no reply from the app' };
  try { verdict = await ipcRenderer.invoke('calling-app-incoming-call', { app: 'telegram', caller }); } catch (err) { verdict = { answer: false, reason: err.message }; }
  if (telegramCall.callPhase(document) !== 'ringing') { state = 'idle'; return; } // they gave up meanwhile
  if (!verdict || !verdict.answer) {
    console.log('[telegram] not answering:', verdict && verdict.reason);
    state = 'ignoring';
    return;
  }
  console.log('[telegram] answering', JSON.stringify({ id: caller.id, name: caller.name }));
  telegramCall.pressButton(telegramCall.findCallButton(document, 'accept'));
  answerPressedAt = Date.now();
  state = 'answering';
}

function tick() {
  let phase;
  try { phase = telegramCall.callPhase(document); } catch { return; }

  if (phase === 'none') {
    if (state === 'in-call') {
      console.log('[telegram] call ended');
      emit(CALL_EVENTS.statusUpdate, 'Call ended: the Telegram call was hung up');
    } else if (state === 'answering') {
      console.log('[telegram] the call went away before it connected');
      emit('calling-app-call-missed', { app: 'telegram', reason: 'hung up while answering' });
    }
    state = 'idle';
    caller = null;
    return;
  }

  if (phase === 'ringing') {
    if (state === 'idle') {
      if (!ringSeenAt || Date.now() - ringSeenAt > 60000) ringSeenAt = Date.now();
      state = 'deciding';
      decide().catch((err) => { console.warn('[telegram] decide failed:', err.message); state = 'ignoring'; });
    } else if (state === 'answering' && Date.now() - answerPressedAt > 4000) {
      // Still ringing: the press didn't land. Try once more.
      console.warn('[telegram] still ringing after Accept, pressing again');
      telegramCall.pressButton(telegramCall.findCallButton(document, 'accept'));
      answerPressedAt = Date.now();
    }
    return;
  }

  // phase === 'active': answered, but only a call once the media connects.
  // Reporting in-call earlier started the agent talking into a call the
  // caller never got (live, 2026-10-23).
  if (state === 'answering' && !callConnected()) {
    if (Date.now() - answerPressedAt > CONNECT_TIMEOUT_MS) {
      console.warn('[telegram] answered but the call never connected — hanging up');
      telegramCall.pressButton(telegramCall.findCallButton(document, 'end call'));
      emit('calling-app-call-missed', { app: 'telegram', reason: 'never connected' });
      state = 'ignoring';
    }
    return;
  }
  if (state === 'answering') {
    state = 'in-call';
    ringSeenAt = 0;
    setMicMuted(false);
    const name = (caller && caller.name) || 'Caller';
    emit(CALL_EVENTS.statusUpdate, 'In call (Telegram)');
    emit(CALL_EVENTS.botJoinedCall, { meetCode: '', botName });
    emit(CALL_EVENTS.participantsUpdated, [
      { name, speaking: false, isSelf: false },
      { name: botName || 'Bot', speaking: false, isSelf: true },
    ]);
    console.log('[telegram] in the call with', name);
    // Open their chat behind the call screen, and take what's already there
    // as read: only messages from here on are news.
    lastChatUnread = false;
    callerChatMessages().then((m) => { lastReadChatId = newestFromCaller(m); }).catch((err) => console.warn('[telegram] chat not opened:', err.message));
  }
  if (state === 'in-call' && caller && telegramCall.chatIsOpen(document, caller.id)) {
    try {
      const newest = newestFromCaller(telegramCall.readChatMessages(document));
      if (newest && newest !== lastReadChatId) setChatUnread(true);
    } catch { /* chat redrawing */ }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[telegram] DOMContentLoaded — watching for incoming calls (500ms)');
  setInterval(tick, 500);
});
