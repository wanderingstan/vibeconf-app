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
};
