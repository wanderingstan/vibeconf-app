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
const whatsappCall = require('./whatsapp-call');
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider');

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

require('./dom-probe').installDomProbe({ tag: '[whatsapp]', defaultSelector: '[aria-label="End call"]' });

window.__vibeconf_disableAudioCapture = true;

try { require('./emoji-assets.js').installPageResolvers(globalThis, __dirname); } catch (err) {
  console.error('[whatsapp] emoji resolvers failed (faces stay native):', err.message);
}

try {
  const code = fs.readFileSync(path.join(__dirname, 'page-inject.js'), 'utf-8');
  (0, eval)(code);
  console.log('[whatsapp] page-inject.js loaded (media patch, before page scripts)');
} catch (err) {
  console.error('[whatsapp] Failed to load page-inject.js:', err.message);
}

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

require('./preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[whatsapp]' });
require('./preload-stt-bridge').installSttBridge(ipcRenderer);

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

const press = (label) => {
  const b = whatsappCall.findButton(document, label);
  if (b) b.click();
  return !!b;
};

// The VirtualMic carries only the bot's voice: keep WhatsApp's own mute off
// unless the app asks for it.
function setMicMuted(muted) { return press(muted ? 'Mute microphone' : 'Unmute microphone'); }
function setCameraOn(on) {
  const ok = press(on ? 'Turn camera on' : 'Turn camera off');
  console.log('[whatsapp] camera', on ? 'on' : 'off', ok ? '' : '(button not found)');
  return ok;
}

ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: setMicMuted(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: setMicMuted(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn: setCameraOn(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOff: setCameraOn(false); break;
    default:
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
  }
});

ipcRenderer.on(CALL_COMMANDS.readChat, (_e, { requestId }) => {
  emit(CALL_EVENTS.chatResult, { requestId, ok: true, messages: [] });
});
ipcRenderer.on(CALL_COMMANDS.sendChat, (_e, { requestId }) => {
  emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: 'WhatsApp calls have no in-call chat' });
});
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ok: false, error: 'WhatsApp has no captions; the bot transcribes the call audio itself' });
});
ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, () => { console.log('[whatsapp] screen share is not supported on WhatsApp calls yet'); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => {});
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => {});
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => {});
ipcRenderer.on('trigger-leave-call', () => {
  const ok = press('End call') || press('Decline');
  console.log('[whatsapp] leave requested →', ok ? 'pressed' : 'no call on screen');
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

function tick() {
  dismissWhatsNew();
  let call;
  try { call = whatsappCall.readCall(window); } catch { return; }

  if (call.phase === 'none') {
    if (state === 'in-call') {
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
