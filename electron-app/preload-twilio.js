// preload-twilio.js — the bot's phone (#882), on renderer/twilio-phone.html.
//
// Twilio's Voice SDK registers this bot as a client; calls reach it only
// after Twilio's own gate (twilio-call.js: caller allowlist + keypad
// passcode) has passed. Before answering, the bot still asks MAIN about the
// caller's number, the same as Telegram and WhatsApp.
//
// Voice only: no camera, no screen share, no chat. Hearing: the SDK's
// RTCPeerConnection, which page-inject's audio capture hooks (left on, as on
// Meet), feeding the STT tap. Speaking: page-inject's VirtualMic, which the
// SDK gets from getUserMedia. The view's audio is muted, so no echo.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const twilioCall = require('./twilio-call');
const { CALL_EVENTS, CALL_COMMANDS } = require('./call-provider');

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

require('./dom-probe').installDomProbe({ tag: '[phone]', defaultSelector: '#status' });

try { require('./emoji-assets.js').installPageResolvers(globalThis, __dirname); } catch (err) {
  console.error('[phone] emoji resolvers failed (faces stay native):', err.message);
}

try {
  const code = fs.readFileSync(path.join(__dirname, 'page-inject.js'), 'utf-8');
  (0, eval)(code);
  console.log('[phone] page-inject.js loaded (media patch, before page scripts)');
} catch (err) {
  console.error('[phone] Failed to load page-inject.js:', err.message);
}

require('./preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[phone]' });
require('./preload-stt-bridge').installSttBridge(ipcRenderer);

function emit(channel, payload) {
  try {
    if (payload === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, payload);
  } catch { /* main not listening */ }
}

function show(status, detail = '') {
  const s = document.getElementById('status');
  const d = document.getElementById('detail');
  if (s) s.textContent = status;
  if (d) d.textContent = detail;
}

let device = null;
let activeCall = null;
let state = 'idle'; // idle | deciding | answering | in-call
let caller = null;
let botName = '';
ipcRenderer.invoke('get-meet-bot-name').then((n) => { botName = n || ''; }).catch(() => {});

ipcRenderer.on(CALL_COMMANDS.extensionMessage, (_e, message) => {
  if (!message) return;
  switch (message.action) {
    case CALL_COMMANDS.ACTIONS.unmuteMic: if (activeCall) activeCall.mute(false); break;
    case CALL_COMMANDS.ACTIONS.muteMic: if (activeCall) activeCall.mute(true); break;
    case CALL_COMMANDS.ACTIONS.cameraOn:
    case CALL_COMMANDS.ACTIONS.cameraOff: break; // a phone call has no video
    default:
      window.postMessage({ __botsInCalls: true, __fromExtension: true, ...message }, '*');
  }
});
ipcRenderer.on(CALL_COMMANDS.readChat, (_e, { requestId }) => {
  emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: 'A phone call has no chat' });
});
ipcRenderer.on(CALL_COMMANDS.sendChat, (_e, { requestId }) => {
  emit(CALL_EVENTS.chatResult, { requestId, ok: false, error: 'A phone call has no chat' });
});
ipcRenderer.on(CALL_COMMANDS.setCaptionLanguage, (_e, { requestId } = {}) => {
  emit(CALL_EVENTS.captionLanguageResult, { requestId, ok: false, error: 'A phone call has no captions; the bot transcribes the audio itself' });
});
ipcRenderer.on(CALL_COMMANDS.triggerScreenShare, () => { console.log('[phone] a phone call has no screen to share'); });
ipcRenderer.on(CALL_COMMANDS.triggerStopSharing, () => {});
ipcRenderer.on(CALL_COMMANDS.setStudioSound, () => {});
ipcRenderer.on(CALL_COMMANDS.recoverCaptions, () => {});
ipcRenderer.on('trigger-leave-call', () => {
  console.log('[phone] leave requested →', activeCall ? 'hanging up' : 'no call');
  if (activeCall) activeCall.disconnect();
});

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.__botsInCalls) return;
  const { action, payload } = event.data;
  if (action === 'tts-ended') emit(CALL_EVENTS.ttsEnded);
  else if (action === 'tts-stopped') emit('tts-stopped', payload || {});
  else if (action === 'self-audio') emit('self-audio', { loud: !!payload?.loud, at: payload?.at || Date.now() });
  else if (action === 'log' && payload?.line) emit('page-inject-log', payload.line);
});

function callEnded(reason) {
  if (state === 'in-call') {
    console.log('[phone] call ended:', reason);
    emit(CALL_EVENTS.statusUpdate, 'Call ended: ' + reason);
  } else if (state === 'answering') {
    emit('calling-app-call-missed', { app: 'twilio', reason });
  }
  state = 'idle';
  activeCall = null;
  caller = null;
  show('Waiting for calls', registeredAs);
}

async function onIncoming(call) {
  const from = (call.parameters && call.parameters.From) || '';
  caller = { phone: twilioCall.phoneDigits(from), name: from || 'Caller' };
  if (state !== 'idle') { console.log('[phone] busy, rejecting', from); call.reject(); return; }
  state = 'deciding';
  show('Incoming call', from);
  let verdict = { answer: false, reason: 'no reply from the app' };
  try { verdict = await ipcRenderer.invoke('calling-app-incoming-call', { app: 'twilio', caller }); } catch (err) { verdict = { answer: false, reason: err.message }; }
  if (!verdict || !verdict.answer) {
    console.log('[phone] not answering:', verdict && verdict.reason);
    call.reject();
    state = 'idle';
    show('Waiting for calls', registeredAs);
    return;
  }
  activeCall = call;
  state = 'answering';
  call.on('accept', () => {
    state = 'in-call';
    call.mute(false);
    emit(CALL_EVENTS.statusUpdate, 'In call (Phone)');
    emit(CALL_EVENTS.botJoinedCall, { meetCode: '', botName });
    emit(CALL_EVENTS.participantsUpdated, [
      { name: caller.name, speaking: false, isSelf: false },
      { name: botName || 'Bot', speaking: false, isSelf: true },
    ]);
    console.log('[phone] in the call with', caller.name);
    show('In a call', caller.name);
  });
  call.on('disconnect', () => callEnded('the phone call was hung up'));
  call.on('cancel', () => callEnded('the caller hung up before it connected'));
  call.on('reject', () => callEnded('rejected'));
  call.on('error', (err) => console.warn('[phone] call error:', err && (err.message || err.code)));
  console.log('[phone] answering', from);
  call.accept();
}

let registeredAs = '';
async function start() {
  const Device = window.Twilio && window.Twilio.Device;
  if (!Device) { show('Phone unavailable', 'The Twilio Voice SDK did not load'); return; }
  let token;
  try { ({ token } = await ipcRenderer.invoke('twilio-token')); } catch (err) { token = null; console.warn('[phone] token:', err.message); }
  if (!token) { show('Phone not set up', 'Add Twilio credentials in Settings → Bot accounts'); return; }
  device = new Device(token, { closeProtection: false, codecPreferences: ['opus', 'pcmu'], logLevel: 'warn' });
  device.on('registered', () => {
    console.log('[phone] registered with Twilio — waiting for calls');
    ipcRenderer.invoke('twilio-number').then((n) => { registeredAs = n || ''; show('Waiting for calls', registeredAs); }).catch(() => show('Waiting for calls'));
  });
  device.on('unregistered', () => console.warn('[phone] unregistered from Twilio'));
  device.on('error', (err) => { console.warn('[phone] device error:', err && (err.message || err.code)); show('Phone error', err && err.message); });
  device.on('tokenWillExpire', async () => {
    try { const r = await ipcRenderer.invoke('twilio-token'); if (r && r.token) device.updateToken(r.token); } catch { /* retried at expiry */ }
  });
  device.on('incoming', (call) => { onIncoming(call).catch((err) => { console.warn('[phone] incoming failed:', err.message); try { call.reject(); } catch { /* gone */ } state = 'idle'; }); });
  try { await device.register(); } catch (err) { console.warn('[phone] register failed:', err.message); show('Phone error', err.message); }
}

window.addEventListener('DOMContentLoaded', () => { start(); });
