// Telegram 1:1 calls (#843): the call screen of Telegram Web A, and who may call.
//
// Recon (live, 2026-10-23, on #843):
//   - Ringing adds `.ActiveCallHeader` (text: the caller's display name) and a
//     dialog "<Name> is calling you..." with round buttons whose LABELS are a
//     sibling <div> ("Accept", "Decline", "Mute", "End call"); the buttons
//     themselves have empty text and build-hash classes.
//   - A bare .click() is ignored; the full pointer/mouse sequence answers.
//   - Hanging up removes `.ActiveCallHeader`. No rating dialog follows.
//   - Avatars carry the user id as data-peer-id, which is what the allowlist
//     keys on: the display name is the caller's own choice, so it proves nothing.
//   - Chat (live, 2026-10-26): the bot's chat with the caller is their 1:1
//     Telegram chat. Clicking its row in the chat list (found by the avatar's
//     data-peer-id) opens it and sets location.hash to "#<user id>"; setting
//     the hash directly doesn't. Messages are .Message (id "message-N", class
//     "own" for the bot's); a text's words are in .text-content, with the time
//     in a nested .MessageMeta. The composer is a ProseMirror editor,
//     #editable-message-text: execCommand('insertText') registers with it, and
//     a "Send Message" button (aria-label) appears. Call records are .Message
//     too, without .text-content.
//   - Video and screen share: not supported. Telegram Web can't add video
//     on the answering side, and even as the caller it only shows on the
//     other side under conditions we couldn't pin down. See #889 for the
//     full write-up before trying again.
//
// The DOM helpers take a `document` so tests can hand them a fake one. The
// allowlist logic is pure, and runs in MAIN, not the page: the page reports who
// is calling and main decides, so nothing the call page (or the agent) does can
// widen who gets answered.

const WEB_URL = 'https://web.telegram.org/a/';
const TELEGRAM_WEB_URL = WEB_URL;

// ---------------------------------------------------------------------------
// Allowlist: one entry per line (commas also work). A numeric user id, or an
// @username. Anything else is ignored rather than guessed at.
// ---------------------------------------------------------------------------
function parseAllowlist(text) {
  const ids = new Set();
  const usernames = new Set();
  for (const raw of String(text || '').split(/[\n,]+/)) {
    const entry = raw.replace(/#.*$/, '').trim(); // "# Stan" comments allowed
    if (!entry) continue;
    if (/^\d{3,20}$/.test(entry)) { ids.add(entry); continue; }
    const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(entry);
    if (m) usernames.add(m[1].toLowerCase());
  }
  return { ids, usernames };
}

// caller: { id, usernames: [] }. Usernames only count when they came from
// Telegram's own data about that id, never from the call screen's text.
function isCallerAllowed(allow, caller) {
  if (!allow || !caller) return false;
  const id = caller.id ? String(caller.id) : '';
  if (id && allow.ids.has(id)) return true;
  for (const u of caller.usernames || []) {
    if (u && allow.usernames.has(String(u).replace(/^@/, '').toLowerCase())) return true;
  }
  return false;
}

function roomCodeForCaller(id) {
  const safe = String(id || '').replace(/[^0-9A-Za-z]/g, '');
  return safe ? `telegram-${safe}` : null;
}

// ---------------------------------------------------------------------------
// Call screen (page side).
// ---------------------------------------------------------------------------

// A call button by its visible label ("accept", "decline", "mute", "unmute",
// "end call"): the label is the button's sibling, so match on the parent.
function findCallButton(doc, label) {
  const want = String(label).toLowerCase();
  for (const b of doc.querySelectorAll('button')) {
    const parentText = (b.parentElement && b.parentElement.innerText || '').trim().toLowerCase();
    if (parentText === want) return b;
  }
  return null;
}

// Press like a person: Telegram's buttons ignore a synthetic click on its own.
function pressButton(btn) {
  if (!btn) return false;
  const win = btn.ownerDocument && btn.ownerDocument.defaultView;
  const r = btn.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerType: 'mouse' };
  const Pointer = (win && win.PointerEvent) || (win && win.MouseEvent);
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') ? Pointer : win.MouseEvent;
    btn.dispatchEvent(new Ctor(type, opts));
  }
  return true;
}

// Where the call is: 'none' | 'ringing' (incoming, unanswered) | 'active'.
function callPhase(doc) {
  const header = doc.querySelector('.ActiveCallHeader');
  if (!header) return 'none';
  if (findCallButton(doc, 'accept')) return 'ringing';
  return 'active';
}

// The incoming-call dialog's whole text is ~150 characters ("If the emoji on
// X's screen are the same… X is calling you... unmute start video screencast
// accept decline"); the app around it is thousands.
const MAX_DIALOG_TEXT = 600;

// Who is calling: display name from the header, user id from the nearest
// avatar in the call UI. Null id when Telegram hasn't drawn the avatar yet.
function readCaller(doc) {
  const header = doc.querySelector('.ActiveCallHeader');
  const name = (header && header.innerText || '').trim().split('\n')[0] || null;
  // Walk up from the call buttons, but only while still inside the call
  // dialog (a few hundred characters of text). Past that is the rest of the
  // app, chat list included, whose avatars are OTHER people: picking one up
  // would answer a stranger as someone on the allowlist. So the id counts only
  // when the dialog holds exactly one.
  let id = null;
  let node = findCallButton(doc, 'accept') || findCallButton(doc, 'end call');
  for (let i = 0; node && i < 14; i++) {
    if ((node.innerText || '').length > MAX_DIALOG_TEXT) break;
    const ids = new Set([...(node.querySelectorAll ? node.querySelectorAll('[data-peer-id]') : [])]
      .map((el) => el.getAttribute('data-peer-id')).filter(Boolean));
    if (ids.size > 1) break;
    if (ids.size === 1) id = [...ids][0];
    node = node.parentElement;
  }
  return { name, id };
}

// ---------------------------------------------------------------------------
// Chat with the caller: their 1:1 chat, opened behind the call screen.
// ---------------------------------------------------------------------------
const chatIsOpen = (doc, peerId) => !!peerId && doc.defaultView.location.hash === '#' + peerId
  && !!doc.querySelector('#editable-message-text');

// Open the caller's chat from the chat list. True once it's the open chat.
async function openChat(doc, peerId, { wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!peerId) return false;
  if (chatIsOpen(doc, peerId)) return true;
  const avatar = doc.querySelector(`#LeftColumn [data-peer-id="${peerId}"]`)
    || doc.querySelector(`.chat-list [data-peer-id="${peerId}"]`);
  const row = avatar && (avatar.closest('.ListItem') || avatar.parentElement);
  const target = row && (row.querySelector('.ListItem-button') || row);
  if (!target) return false;
  pressButton(target);
  for (let i = 0; i < 20; i++) { if (chatIsOpen(doc, peerId)) return true; await wait(100); }
  return chatIsOpen(doc, peerId);
}

// A message's words, without the time Telegram nests inside .text-content.
function messageText(el) {
  const tc = el.querySelector('.text-content');
  if (!tc) return null;
  const copy = tc.cloneNode(true);
  for (const meta of copy.querySelectorAll('.MessageMeta')) meta.remove();
  return (copy.innerText != null ? copy.innerText : copy.textContent || '').trim() || null;
}

// Texts in the OPEN chat, in the app's { id, sender, text } shape. Callers
// check chatIsOpen first, so this never reads somebody else's chat.
function readChatMessages(doc, { selfName = 'Bot', callerName = 'Caller', limit = 30 } = {}) {
  const out = [];
  for (const el of doc.querySelectorAll('.Message')) {
    const text = messageText(el);
    if (!text) continue; // call records, media, service messages
    const own = el.classList.contains('own');
    out.push({ id: el.id || null, sender: own ? selfName : callerName, text, fromMe: own });
  }
  return out.slice(-limit);
}

// Type into the open chat's composer and press Send.
// `typeText(text)`: an optional fallback that types like a keyboard (the
// preload passes main's webContents.insertText), for when the page's own
// editing commands are refused because the view has no keyboard focus.
async function sendChatMessage(doc, text, { wait = (ms) => new Promise((r) => setTimeout(r, ms)), typeText = null } = {}) {
  const editor = doc.querySelector('#editable-message-text');
  if (!editor) throw new Error('no message box');
  editor.focus();
  doc.execCommand('selectAll');
  doc.execCommand('delete');
  // insertText needs keyboard focus, which the bot's (often hidden) view may
  // not have; then type through main, like a keyboard (live, 2026-10-26).
  const took = () => (editor.innerText || '').includes(String(text).slice(0, 20));
  if (!doc.execCommand('insertText', false, String(text)) || !took()) {
    if (typeText) { editor.focus(); await typeText(String(text)); await wait(150); }
    if (!took()) throw new Error('could not type into the message box');
  }
  let send = null;
  for (let i = 0; i < 10 && !send; i++) {
    send = [...doc.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === 'Send Message');
    if (!send) await wait(100);
  }
  if (!send) throw new Error('no Send button appeared');
  send.click();
  return true;
}

module.exports = {
  WEB_URL,
  TELEGRAM_WEB_URL,
  parseAllowlist,
  isCallerAllowed,
  roomCodeForCaller,
  findCallButton,
  pressButton,
  callPhase,
  readCaller,
  chatIsOpen,
  openChat,
  messageText,
  readChatMessages,
  sendChatMessage,
};
