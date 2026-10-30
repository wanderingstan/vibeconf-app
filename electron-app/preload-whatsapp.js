// preload-whatsapp.js — the preload for WhatsApp Web as a call surface (#843).
//
// Same shape as preload-telegram.js: no link to join; the bot waits in its own
// WhatsApp account ("standby"), asks MAIN whether an incoming caller may be
// answered (the allowlist lives there, never in the page), answers, and then
// reports the call like any other provider.
//
// Two things differ from every other provider:
//   - page-inject's RTCPeerConnection hook stays OFF. WhatsApp's relay runs
//     over an RTCPeerConnection data channel, and replacing that constructor
//     (as the hook does) is the kind of change that made the relay fail to
//     bind in recon ("relay_binds_failed").
//   - Hearing: the call audio never becomes a track or a media element.
//     WhatsApp's WASM engine plays it through one AudioWorklet; we copy that
//     worklet's output into a MediaStream and publish the track on
//     window.__vibeconf_outputTapTracks, which page-inject's STT tap and call
//     recorder read. The view's audio is muted (createMeetView), so nothing
//     reaches the speakers and there is no echo.
// Speaking is the usual VirtualMic: WhatsApp asks getUserMedia for audio and
// page-inject hands it the bot's voice.
//
// Drive it live from this view's DevTools (contextIsolation:false):
//   whatsappCall.readCall(window)

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const whatsappCall = require('@vibeconferencing/calls/providers/whatsapp-call');
const { CALL_EVENTS } = require('@vibeconferencing/calls/core/call-provider');
const { WhatsAppProvider } = require('@vibeconferencing/calls/providers/whatsapp-provider');
const { bindToIpc } = require('@vibeconferencing/calls/core/calling-app-provider');

require('@vibeconferencing/calls/hosts/electron/slack-ua').installClientHintsShim();

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

require('@vibeconferencing/calls/core/dom-probe').installDomProbe({ tag: '[whatsapp]', defaultSelector: '[aria-label="End call"]' });

window.__vibeconf_disableAudioCapture = true;

// The media scripts (page-inject's core, then the app's avatar and realtime
// voice plugins), before any page script can ask for media. page-scripts.js.
require('./page-scripts').injectPageScripts({ tag: '[whatsapp]' });

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

require('@vibeconferencing/calls/recording/preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[whatsapp]' });
require('@vibeconferencing/calls/hearing/preload-stt-bridge').installSttBridge(ipcRenderer);

try { window.whatsappCall = whatsappCall; } catch { /* window not ready */ }

// ---------------------------------------------------------------------------
// Output tap: copy WhatsApp's playback worklet into a track for STT/recording.
// Only that one named worklet, so nothing of the bot's own audio is tapped.
// ---------------------------------------------------------------------------
(function installOutputTap() {
  window.__vibeconf_outputTapTracks = window.__vibeconf_outputTapTracks || [];
  const NativeWorklet = window.AudioWorkletNode;
  if (!NativeWorklet) return;
  // Subclass rather than wrap: statics and instanceof keep working.
  window.AudioWorkletNode = class extends NativeWorklet {
    constructor(context, name, options) {
      super(context, name, options);
      this.__vibeconfWorkletName = name;
    }
  };
  const nativeConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...rest) {
    const result = nativeConnect.call(this, destination, ...rest);
    try {
      if (this.__vibeconfWorkletName === whatsappCall.PLAYBACK_WORKLET
          && destination instanceof AudioDestinationNode && !this.__vibeconfTapped) {
        this.__vibeconfTapped = true;
        const tap = this.context.createMediaStreamDestination();
        nativeConnect.call(this, tap);
        const track = tap.stream.getAudioTracks()[0];
        if (track) {
          window.__vibeconf_outputTapTracks = window.__vibeconf_outputTapTracks.filter((t) => t.readyState === 'live').concat(track);
          console.log('[whatsapp] tapped the call audio (' + this.context.sampleRate + ' Hz) for transcription');
        }
      }
    } catch (err) { console.warn('[whatsapp] output tap failed:', err.message); }
    return result;
  };
})();

function emit(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, payload);
  } catch { /* main not listening */ }
}

// The call itself (mic, camera, chat, share, leave) is WhatsAppProvider's;
// this preload keeps the incoming side: deciding, answering, standby.
const provider = new WhatsAppProvider({
  session: () => ({ state, caller, botName }),
  onSharing: (on) => reportSharing(on),
});
const press = (label) => provider.press(label);
const setMicMuted = (muted) => provider.setMicMuted(muted);
const setCameraOn = (on) => provider.setCameraOn(on);

// Chat = the caller's 1:1 WhatsApp chat (see whatsapp-call.js). Only during
// a call, and only with the person on it.
let lastReadChatId = null;
let lastChatUnread = false;
function setChatUnread(unread) {
  if (unread === lastChatUnread) return;
  lastChatUnread = unread;
  emit(CALL_EVENTS.chatUnread, { unread });
}
function chatMessages() {
  if (!caller || !caller.peerJid) return [];
  return whatsappCall.readChatMessages(window, caller.peerJid, { selfName: botName || 'Bot', callerName: caller.name || 'Caller' });
}
function newestFromCaller(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].fromMe) return messages[i].id;
  return null;
}
// Our side of a screen share is reported as self-presenting, so the app stops
// retrying once it's up.
let sharing = false;
function reportSharing(on) {
  if (sharing === on) return;
  sharing = on;
  emit(CALL_EVENTS.selfPresenting, { presenting: on });
  console.log('[whatsapp] self-presenting:', on);
}
bindToIpc(ipcRenderer, provider, {
  emit,
  afterRead: (messages) => { lastReadChatId = newestFromCaller(messages); setChatUnread(false); },
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

// WhatsApp opens with a "What's new on WhatsApp Web" dialog now and then; it
// sits over everything, so clear it. Only that dialog, only its Continue.
function dismissWhatsNew() {
  for (const d of document.querySelectorAll('[role="dialog"]')) {
    if (!/what.s new on whatsapp/i.test(d.innerText || '')) continue;
    const btn = [...d.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Continue');
    if (btn) { btn.click(); console.log('[whatsapp] dismissed "What\'s new"'); }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: idle → ringing → (deciding) → answering → in-call → ended.
// ---------------------------------------------------------------------------
let botName = '';
ipcRenderer.invoke('get-meet-bot-name').then((n) => { botName = n || ''; }).catch(() => {});

let state = 'idle'; // idle | deciding | ignoring | answering | in-call
let caller = null;
let answerPressedAt = 0;
let cameraStarted = false;
const CONNECT_TIMEOUT_MS = 20000;

async function decide(call) {
  caller = { phone: call.phone, name: call.name, peerJid: call.peerJid };
  let verdict = { answer: false, reason: 'no reply from the app' };
  try { verdict = await ipcRenderer.invoke('calling-app-incoming-call', { app: 'whatsapp', caller }); } catch (err) { verdict = { answer: false, reason: err.message }; }
  if (whatsappCall.readCall(window).phase !== 'ringing') { state = 'idle'; return; } // gave up meanwhile
  if (!verdict || !verdict.answer) {
    console.log('[whatsapp] not answering:', verdict && verdict.reason);
    state = 'ignoring';
    return;
  }
  console.log('[whatsapp] answering', JSON.stringify({ phone: caller.phone, name: caller.name }));
  press('Accept');
  answerPressedAt = Date.now();
  state = 'answering';
}

// A call link (#891): main opened it in this view, so this page IS the
// pre-join screen. Press "Join call" once; the page then returns to the main
// app with the call live, which the heartbeat below picks up.
let joinPressed = false;
function joinCallLinkPage() {
  if (!/^\/call\/(video|voice)\//.test(location.pathname) || joinPressed) return false;
  const btn = whatsappCall.findJoinCallButton(document);
  if (!btn) return true; // still drawing
  joinPressed = true;
  console.log('[whatsapp] joining the call link');
  btn.click();
  return true;
}

let linkRoster = '';
function tick() {
  dismissWhatsNew();
  if (joinCallLinkPage()) return;
  let call;
  try { call = whatsappCall.readCall(window); } catch { return; }

  // A call link the bot joined: a group call, not an answered caller. In the
  // call once connected; everyone else in it, by name, is the roster.
  if (call.isCallLink) {
    if (call.phase === 'active' && state !== 'in-call') {
      state = 'in-call';
      caller = null; // no 1:1 chat on a link call
      emit(CALL_EVENTS.statusUpdate, 'In call (WhatsApp)');
      emit(CALL_EVENTS.botJoinedCall, { meetCode: '', botName });
      console.log('[whatsapp] in the call-link call');
      setMicMuted(false);
    }
    if (state === 'in-call') {
      const roster = JSON.stringify(call.participants || []);
      if (roster !== linkRoster) {
        linkRoster = roster;
        emit(CALL_EVENTS.participantsUpdated, [
          ...(call.participants || []).map((n) => ({ name: n, speaking: false, isSelf: false })),
          { name: botName || 'Bot', speaking: false, isSelf: true },
        ]);
      }
    }
    return;
  }

  if (call.phase === 'none') {
    if (state === 'in-call') {
      linkRoster = '';
      reportSharing(false);
      console.log('[whatsapp] call ended');
      emit(CALL_EVENTS.statusUpdate, 'Call ended: the WhatsApp call was hung up');
    } else if (state === 'answering') {
      console.log('[whatsapp] the call went away before it connected');
      emit('calling-app-call-missed', { app: 'whatsapp', reason: 'hung up while answering' });
    }
    state = 'idle';
    caller = null;
    return;
  }
  if (call.phase === 'outgoing') return; // not ours to manage

  if (call.phase === 'ringing') {
    if (state === 'idle') {
      state = 'deciding';
      decide(call).catch((err) => { console.warn('[whatsapp] decide failed:', err.message); state = 'ignoring'; });
    } else if (state === 'answering' && Date.now() - answerPressedAt > 4000) {
      console.warn('[whatsapp] still ringing after Accept, pressing again');
      press('Accept');
      answerPressedAt = Date.now();
    }
    return;
  }

  if (call.phase === 'connecting') {
    if (state === 'answering' && Date.now() - answerPressedAt > CONNECT_TIMEOUT_MS) {
      console.warn('[whatsapp] answered but the call never connected — hanging up');
      press('End call');
      emit('calling-app-call-missed', { app: 'whatsapp', reason: 'never connected' });
      state = 'ignoring';
    }
    return;
  }

  // call.phase === 'active'
  if (state === 'answering') {
    state = 'in-call';
    cameraStarted = false;
    setMicMuted(false);
    const name = (caller && caller.name) || 'Caller';
    emit(CALL_EVENTS.statusUpdate, 'In call (WhatsApp)');
    emit(CALL_EVENTS.botJoinedCall, { meetCode: '', botName });
    emit(CALL_EVENTS.participantsUpdated, [
      { name, speaking: false, isSelf: false },
      { name: botName || 'Bot', speaking: false, isSelf: true },
    ]);
    console.log('[whatsapp] in the call with', name);
    // What was already in the chat isn't news; only what arrives from here on.
    try { lastReadChatId = newestFromCaller(chatMessages()); } catch { lastReadChatId = null; }
    lastChatUnread = false;
  }
  if (state === 'in-call') {
    try {
      const newest = newestFromCaller(chatMessages());
      if (newest && newest !== lastReadChatId) setChatUnread(true);
    } catch { /* chat not loaded */ }
  }
  if (state === 'in-call' && !cameraStarted) {
    cameraStarted = true;
    setTimeout(() => setCameraOn(true), 1500);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[whatsapp] DOMContentLoaded — watching for incoming calls (500ms)');
  setInterval(tick, 500);
});
