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
const { CALL_EVENTS } = require('./call-provider');
const { TwilioProvider } = require('./twilio-provider');
const { bindToIpc } = require('./calling-app-provider');

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

require('./dom-probe').installDomProbe({ tag: '[twilio]', defaultSelector: '#status' });

// The media scripts (page-inject's core, then the app's avatar and realtime
// voice plugins), before any page script can ask for media. page-scripts.js.
require('./page-scripts').injectPageScripts({ tag: '[twilio]' });

require('./preload-recording-bridge').installRecordingBridge(ipcRenderer, { tag: '[twilio]' });
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

// The call itself (mic, leave) is TwilioProvider's; this preload keeps the
// incoming side: registering the phone, the caller check, answering.
const provider = new TwilioProvider({ session: () => ({ state, caller, botName, activeCall }) });
bindToIpc(ipcRenderer, provider, { emit });

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
    console.log('[twilio] call ended:', reason);
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
  if (state !== 'idle') { console.log('[twilio] busy, rejecting', from); call.reject(); return; }
  state = 'deciding';
  show('Incoming call', from);
  let verdict = { answer: false, reason: 'no reply from the app' };
  try { verdict = await ipcRenderer.invoke('calling-app-incoming-call', { app: 'twilio', caller }); } catch (err) { verdict = { answer: false, reason: err.message }; }
  if (!verdict || !verdict.answer) {
    console.log('[twilio] not answering:', verdict && verdict.reason);
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
    console.log('[twilio] in the call with', caller.name);
    show('In a call', caller.name);
  });
  call.on('disconnect', () => callEnded('the phone call was hung up'));
  call.on('cancel', () => callEnded('the caller hung up before it connected'));
  call.on('reject', () => callEnded('rejected'));
  call.on('error', (err) => console.warn('[twilio] call error:', err && (err.message || err.code)));
  console.log('[twilio] answering', from);
  call.accept();
}

let registeredAs = '';
async function start() {
  const Device = window.Twilio && window.Twilio.Device;
  if (!Device) { show('Phone unavailable', 'The Twilio Voice SDK did not load'); return; }
  let token;
  try { ({ token } = await ipcRenderer.invoke('twilio-token')); } catch (err) { token = null; console.warn('[twilio] token:', err.message); }
  if (!token) { show('Phone not set up', 'Add Twilio credentials in Settings → Bot accounts'); return; }
  device = new Device(token, { closeProtection: false, codecPreferences: ['opus', 'pcmu'], logLevel: 'warn' });
  device.on('registered', () => {
    console.log('[twilio] registered with Twilio — waiting for calls');
    ipcRenderer.invoke('twilio-number').then((n) => { registeredAs = n || ''; show('Waiting for calls', registeredAs); }).catch(() => show('Waiting for calls'));
  });
  device.on('unregistered', () => console.warn('[twilio] unregistered from Twilio'));
  device.on('error', (err) => { console.warn('[twilio] device error:', err && (err.message || err.code)); show('Phone error', err && err.message); });
  device.on('tokenWillExpire', async () => {
    try { const r = await ipcRenderer.invoke('twilio-token'); if (r && r.token) device.updateToken(r.token); } catch { /* retried at expiry */ }
  });
  device.on('incoming', (call) => { onIncoming(call).catch((err) => { console.warn('[twilio] incoming failed:', err.message); try { call.reject(); } catch { /* gone */ } state = 'idle'; }); });
  try { await device.register(); } catch (err) { console.warn('[twilio] register failed:', err.message); show('Phone error', err.message); }
}

window.addEventListener('DOMContentLoaded', () => { start(); });
