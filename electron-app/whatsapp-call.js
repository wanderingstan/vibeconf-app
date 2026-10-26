// WhatsApp 1:1 calls (#843): WhatsApp Web's call state, and who may call.
//
// Recon (live, 2026-10-23):
//   - Calling only works once the page is cross-origin isolated (main.js
//     tightens its COOP; Chromium 130 ignores its Document-Isolation-Policy).
//   - An incoming call shows a pop-up with buttons labelled (aria-label)
//     "Accept" / "Decline"; a plain click answers. In the call: "Mute
//     microphone" / "Unmute microphone", "Turn camera on", "End call".
//   - The call itself is read from WhatsApp's own module system:
//     require('WAWebCallCollection').activeCall has peerJid (a "…@lid" privacy
//     id), outgoing, wasEverConnected; it goes back to null at hang-up.
//   - The caller's PHONE NUMBER comes from require('WAWebApiContact')
//     .getPhoneNumber(peerJid) → "19175752435@c.us". The allowlist keys on that:
//     the display name is the caller's own choice and proves nothing.
//   - The call runs in a floating panel inside the page. Its bar: camera,
//     mic, pop-out, "More options" (⋮) and "End call". Screen sharing is in
//     that ⋮ menu: role=menuitem "Share screen", and while sharing "Stop
//     sharing screen". WhatsApp then asks getDisplayMedia, which the app
//     answers with the whiteboard window, as on Meet.
//   - WhatsApp turns the camera on by itself for a video call.
//   - Chat: a WhatsApp call has no in-call chat; its "Send message" opens the
//     caller's ordinary 1:1 chat. So the bot's chat IS that chat, read from
//     require('WAWebCollections').Chat.get(peerJid).msgs (type "chat" are
//     texts) and sent with WhatsApp's own
//     require('WAWebSendTextMsgChatAction').sendTextMsgToChat(chat, text).
//     It persists after the call, which suits a link or a summary.
//   - Audio never becomes a track or a media element: WhatsApp's WASM engine
//     plays it through an AudioWorklet named
//     "voip-shared-buffer-playback-processor" (16 kHz mono), which
//     preload-whatsapp.js copies for transcription.
//
// The allowlist logic is pure and runs in MAIN; the page only reports.

const WEB_URL = 'https://web.whatsapp.com/';

// The worklet WhatsApp plays the other side of the call through.
const PLAYBACK_WORKLET = 'voip-shared-buffer-playback-processor';

// ---------------------------------------------------------------------------
// Allowlist: one phone number per line (commas also work), any formatting
// ("+1 (917) 575-2435", "19175752435"). Include the country code: numbers are
// compared digit for digit. "# name" comments are allowed.
// ---------------------------------------------------------------------------
function phoneDigits(text) {
  const digits = String(text || '').replace(/@.*$/, '').replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

function parseAllowlist(text) {
  const phones = new Set();
  for (const raw of String(text || '').split(/[\n,]+/)) {
    const entry = raw.replace(/#.*$/, '').trim();
    const d = phoneDigits(entry);
    if (d) phones.add(d);
  }
  return { phones };
}

// caller: { phone } (digits, from WhatsApp's own lid → number mapping).
function isCallerAllowed(allow, caller) {
  if (!allow || !caller) return false;
  const d = phoneDigits(caller.phone);
  return !!d && allow.phones.has(d);
}

function roomCodeForCaller(phone) {
  const d = phoneDigits(phone);
  return d ? `whatsapp-${d}` : null;
}

// ---------------------------------------------------------------------------
// Page side (runs in WhatsApp Web's own realm; `win` is its window).
// ---------------------------------------------------------------------------
function findButton(doc, label) {
  for (const b of doc.querySelectorAll('button, [role="button"]')) {
    if ((b.getAttribute('aria-label') || '').trim().toLowerCase() === label.toLowerCase()) return b;
  }
  return null;
}

// The call bar's own "More options" (⋮): the one sharing a container with
// "End call", not the chat header's button of the same name.
function callMenuButton(doc) {
  let node = findButton(doc, 'end call');
  for (let i = 0; node && i < 8; i++) {
    node = node.parentElement;
    if (!node || !node.querySelectorAll) break;
    for (const b of node.querySelectorAll('button, [role="button"]')) {
      if ((b.getAttribute('aria-label') || '').trim().toLowerCase() === 'more options') return b;
    }
  }
  return null;
}

function findMenuItem(doc, label) {
  for (const el of doc.querySelectorAll('[role="menuitem"]')) {
    if ((el.getAttribute('aria-label') || '').trim().toLowerCase() === label.toLowerCase()) return el;
  }
  return null;
}

// Open the call bar's ⋮ and pick an item. Resolves true when the item was
// there; closes the menu again (Escape) when it wasn't.
async function chooseCallMenuItem(win, label, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const doc = win.document;
  let item = findMenuItem(doc, label);
  if (!item) {
    const menu = callMenuButton(doc);
    if (!menu) return false;
    menu.click();
    for (let i = 0; i < 10 && !item; i++) { await wait(100); item = findMenuItem(doc, label); }
  }
  if (!item) {
    try { doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } catch { /* best effort */ }
    return false;
  }
  item.click();
  return true;
}

// The caller's 1:1 chat (the chat with the person on the call), or null.
function callerChat(win, peerJid) {
  if (!peerJid) return null;
  try { return win.require('WAWebCollections').Chat.get(peerJid) || null; } catch { return null; }
}

// Text messages in that chat, oldest first, in the app's chat shape
// ({ id, sender, text }). The bot's own are sent as `selfName`.
function readChatMessages(win, peerJid, { selfName = 'Bot', callerName = 'Caller', limit = 30 } = {}) {
  const chat = callerChat(win, peerJid);
  if (!chat || !chat.msgs) return [];
  return chat.msgs.getModelsArray()
    .filter((m) => m.type === 'chat' && m.body)
    .slice(-limit)
    .map((m) => ({
      id: String((m.id && (m.id._serialized || m.id.id)) || `${m.t}-${m.body.slice(0, 16)}`),
      sender: m.id && m.id.fromMe ? selfName : (m.notifyName || callerName),
      text: m.body,
      fromMe: !!(m.id && m.id.fromMe),
    }));
}

// Send `text` to the caller's chat through WhatsApp's own send action.
async function sendChatMessage(win, peerJid, text) {
  const chat = callerChat(win, peerJid);
  if (!chat) throw new Error('no chat with the caller');
  await win.require('WAWebSendTextMsgChatAction').sendTextMsgToChat(chat, String(text));
  return true;
}

// { phase: 'none' | 'ringing' | 'connecting' | 'active' | 'outgoing', peerJid,
//   phone, name }. 'ringing' = incoming and not yet answered (Accept on
// screen); 'connecting' = answered, media not up yet.
function readCall(win) {
  let coll;
  try { coll = win.require('WAWebCallCollection'); } catch { return { phase: 'none' }; }
  const call = coll && coll.activeCall;
  if (!call) return { phase: 'none' };
  const a = call.attributes || call;
  const peer = a.peerJid;
  const peerJid = peer ? (peer._serialized || String(peer)) : null;
  let phone = null;
  try {
    const pn = win.require('WAWebApiContact').getPhoneNumber(peer);
    phone = phoneDigits(pn ? (pn._serialized || String(pn)) : null);
  } catch { /* not mapped yet */ }
  if (!phone && peerJid && /@c\.us$/.test(peerJid)) phone = phoneDigits(peerJid);
  let name = null;
  try {
    const c = win.require('WAWebCollections').Contact.get(peer);
    name = (c && (c.pushname || c.name || c.formattedName)) || null;
  } catch { /* no contact */ }
  let phase;
  if (a.outgoing) phase = 'outgoing';
  else if (a.wasEverConnected) phase = 'active';
  else if (findButton(win.document, 'accept')) phase = 'ringing';
  else phase = 'connecting';
  return { phase, peerJid, phone, name };
}

module.exports = {
  WEB_URL,
  PLAYBACK_WORKLET,
  phoneDigits,
  parseAllowlist,
  isCallerAllowed,
  roomCodeForCaller,
  findButton,
  callMenuButton,
  findMenuItem,
  chooseCallMenuItem,
  callerChat,
  readChatMessages,
  sendChatMessage,
  readCall,
};
