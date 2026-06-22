// preload-meet.js — Preload script for the Meet BrowserWindow.
// Runs with contextIsolation: false so it shares the page's world.
// This lets us patch getUserMedia BEFORE Meet's scripts run.

const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// meetView runs with contextIsolation:false, so the preload and page share one
// window. Expose a tiny helper the idle screen uses to open a URL in the user's
// external browser (the "Start default testing meet" link).
try { window.vibeconfOpenExternal = (url) => ipcRenderer.send('open-external-url', url); } catch { /* window not ready */ }

// Auto-stamp every console line with HH:MM:SS.mmm BEFORE any other code runs,
// so [electron-meet] / [speaker-tracker] / [CC] / [bots-in-calls] lines all
// flow into the main process timeline with a wall-clock prefix. main.js's own
// console wrapper sees the prefix and skips re-stamping. Page-inject is eval'd
// into this same context (contextIsolation: false), so this single wrap
// covers both preload-meet AND page-inject log sites.
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

// ---------------------------------------------------------------------------
// Inject page-inject.js IMMEDIATELY — before any page scripts execute.
// With contextIsolation: false, this runs in the page's JS context,
// so our getUserMedia override is in place when Meet's code loads.
// ---------------------------------------------------------------------------

// Inject page-inject.js IMMEDIATELY in preload — before any page scripts run.
// This ensures our getUserMedia override is in place when Meet requests media.
// With contextIsolation: false, this preload only runs in the Meet BrowserView,
// so no URL check is needed. Injecting at DOMContentLoaded was too late — Meet's
// scripts could call getUserMedia before that, getting a real mic stream instead
// of our VirtualMic, causing TTS audio to silently fail.
try {
  const pageInjectPath = path.join(__dirname, '..', 'extension', 'page-inject.js');
  const pageInjectCode = fs.readFileSync(pageInjectPath, 'utf-8');
  (0, eval)(pageInjectCode);
  console.log('[electron-meet] page-inject.js loaded (preload, before page scripts)');
} catch (err) {
  console.error('[electron-meet] Failed to load page-inject.js:', err.message);
}

// ---------------------------------------------------------------------------
// Expose screen share helper to page context (for getDisplayMedia override)
// ---------------------------------------------------------------------------

window.__vibeconf_getScreenShareSource = async function () {
  return ipcRenderer.invoke('get-screen-share-source');
};

window.__vibeconf_startWhiteboardShare = function (meetCode) {
  ipcRenderer.send('start-whiteboard-share', { meetCode });
};

// ---------------------------------------------------------------------------
// Listen for messages from main process and forward to page context
// ---------------------------------------------------------------------------

ipcRenderer.on('extension-message', (_event, message) => {
  // Forward to page context via window.postMessage
  // page-inject.js listens for __botsInCalls messages
  if (message.action === 'play-tts') {
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: 'play-tts',
      payload: message.payload,
    }, '*');
  } else if (message.action === 'unmute-mic') {
    setMicMuted(false);
  } else if (message.action === 'mute-mic') {
    setMicMuted(true);
  } else if (message.action === 'camera-on') {
    setCameraOff(false);
  } else if (message.action === 'camera-off') {
    setCameraOff(true);
  } else if (message.action === 'play-speech-test') {
    // Resolve test audio — main process sends the base64 directly
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      action: 'play-speech-test',
      payload: message.payload,
    }, '*');
  } else {
    // Generic forward
    window.postMessage({
      __botsInCalls: true,
      __fromExtension: true,
      ...message,
    }, '*');
  }
});

// ---------------------------------------------------------------------------
// DOM helpers (from content-script.js)
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Visibility check: skip elements that are display:none, visibility:hidden,
// or zero-size. Meet renders accessibility live regions and stale UI shells
// off-screen, so text-walk matches frequently hit invisible nodes that look
// clickable but aren't (#175 — autoJoin matched a hidden "Ask to join" before
// the visible "Join now" and silently no-op-clicked into "waiting" forever).
function isVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null && el !== document.documentElement) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  // computed-style visibility check is the last defense — display:none is
  // already caught by offsetParent, but visibility:hidden is not.
  const style = window.getComputedStyle(el);
  if (style.visibility === 'hidden') return false;
  return true;
}

function findByText(text, { exact = false } = {}) {
  if (!document.body) return null;
  const lower = text.toLowerCase();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const nodeText = walk.currentNode.textContent.trim().toLowerCase();
    const match = exact ? nodeText === lower : nodeText.includes(lower);
    if (!match) continue;
    let el = walk.currentNode.parentElement;
    let candidate = null;
    while (el && el !== document.body) {
      if (
        el.tagName === 'BUTTON' ||
        el.getAttribute('role') === 'button' ||
        el.hasAttribute('jsaction') ||
        el.tabIndex >= 0
      ) {
        candidate = el;
        break;
      }
      el = el.parentElement;
    }
    const result = candidate || walk.currentNode.parentElement;
    if (isVisible(result)) return result;
    // Keep walking — there may be a visible match later in the document.
  }
  return null;
}

function findByAriaLabel(label) {
  // No visibility filter here — Meet's toolbar buttons can be transiently 0×0
  // during initial layout (e.g. the captions button before the bot view has
  // its final dimensions), which made isVisible() reject them and broke the
  // auto-CC enable path. Unlike findByText (where invisible-duplicate text
  // nodes are real and motivated isVisible()), aria-labeled elements in
  // Meet's DOM don't have hidden-duplicate buttons. Add a visible-only
  // variant if a future caller needs one.
  return document.querySelector(
    `button[aria-label*="${label}" i], [role="button"][aria-label*="${label}" i]`
  );
}

// Auto-dismiss Meet's one-time onboarding/info modals that block the bot's join
// flow and button detection (#227, #240). Meet shows a whole FAMILY of these —
// "Others may see your video differently", "Your screen may not appear to others
// the way it appears for you", and more — each dismissed by a single "Got it"
// button. Enumerating every heading is a losing game (they change, and an
// uncaught one likely contributed to #240's cold-join failures), so this is a
// CATCH-ALL: in Meet, a visible "Got it" button is always a dismissible info
// modal, so we click any we find. The recording-consent dialog (#130) uses
// Leave / Join now (not "Got it"), so it's unaffected. Returns true if dismissed.
const KNOWN_MODAL_HEADINGS = [ // for clearer logging only — NOT a gate
  'others may see your video differently',
  'your screen may not appear',
  'may not appear to others',
];
let _lastModalDumpAt = 0;
function dismissBlockingModals() {
  // Click any visible "Got it" button (label may be nested in a span; match by
  // text or aria-label across all candidates).
  const clickables = document.querySelectorAll('button, [role="button"]');
  for (const el of clickables) {
    const label = (el.textContent || '').trim().toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
    if ((label === 'got it' || aria === 'got it') && isVisible(el)) {
      el.click();
      const bodyText = (document.body && document.body.textContent || '').toLowerCase();
      const known = KNOWN_MODAL_HEADINGS.find((h) => bodyText.includes(h));
      console.log('[electron-meet] Dismissed info modal via "Got it"' +
        (known ? ' (' + known + ')' : ' (unrecognized heading)'));
      return true;
    }
  }

  // No "Got it" found. If a modal dialog is nonetheless sitting open and
  // blocking (and it's not the recording-consent dialog handled elsewhere),
  // dump its DOM (throttled) so we can learn its dismiss button — maybe it uses
  // a different label we should add. This is how we finally capture the rare
  // ones we can't reproduce on demand.
  const dlg = document.querySelector('[role="dialog"][aria-modal="true"], [aria-modal="true"], [role="dialog"]');
  if (dlg && isVisible(dlg) && Date.now() - _lastModalDumpAt > 15000) {
    const txt = (dlg.textContent || '').toLowerCase();
    const isRecordingConsent = txt.includes('being recorded') || txt.includes('taking notes');
    if (!isRecordingConsent) {
      _lastModalDumpAt = Date.now();
      console.warn('[electron-meet] Modal dialog open with no "Got it" button — DOM sample so we can handle it:\n' +
        (dlg.outerHTML || '').slice(0, 2500));
    }
  }
  return false;
}

// Auto-accept Meet's AI-recording disclosure dialog that blocks admission (#130).
// Premium Meet calls show a modal — "This video call is being recorded and
// transcribed. Gemini is taking notes." — with Leave / Join now buttons. Left
// unhandled, the bot sits stuck at 'waiting-to-be-admitted'. We click "Join now"
// (the dialog's data-mdc-dialog-action="ok" button) to consent on the user's
// behalf, gated on the recording heading so a stray "Join now" elsewhere can't be
// clicked. Returns true if accepted. Surfaces a one-time status so the operator
// knows the bot consented to recording for them.
let _recordingConsentNotified = false;
function acceptRecordingConsentIfPresent() {
  const dlg = document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"]');
  if (!dlg) return false;
  const text = (dlg.textContent || '').toLowerCase();
  const isRecordingConsent =
    text.includes('being recorded') ||
    text.includes('recorded and transcribed') ||
    text.includes('taking notes');
  if (!isRecordingConsent) return false;

  // Accept = the dialog's "ok" action (labelled "Join now"); fall back to text.
  const okBtn = dlg.querySelector('button[data-mdc-dialog-action="ok"]')
    || [...dlg.querySelectorAll('button, [role="button"]')]
         .find((b) => /\bjoin now\b/i.test(b.textContent || ''));
  if (okBtn && isVisible(okBtn)) {
    okBtn.click();
    if (!_recordingConsentNotified) {
      _recordingConsentNotified = true;
      console.log('[electron-meet] Accepted call-recording disclosure (clicked "Join now") — recording/transcription consented on the user\'s behalf');
      try { sendStatus('Accepted recording disclosure (call is being recorded/transcribed)'); } catch { /* status bar not ready */ }
    }
    return true;
  }
  return false;
}

async function typeIntoInput(input, value) {
  input.focus();
  input.click();
  await delay(200);

  input.select();
  const ok = document.execCommand('insertText', false, value);
  if (ok && input.value === value) return true;

  // Meet's chat input is a <textarea>; calling HTMLInputElement's value setter
  // on it throws "Illegal invocation" because `this` is the wrong type. Pull
  // the setter from the element's own prototype chain, with fallbacks for
  // either built-in type if the immediate prototype's descriptor is missing.
  const valueDescriptor =
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value') ||
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') ||
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const nativeSetter = valueDescriptor?.set;
  if (!nativeSetter) throw new Error('Could not find native value setter');
  nativeSetter.call(input, '');

  for (const char of value) {
    const keyOpts = { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    input.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
    nativeSetter.call(input, input.value + char);
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, data: char, inputType: 'insertText',
    }));
    input.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    await delay(10);
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
  input.focus();
  return input.value === value;
}

// ---------------------------------------------------------------------------
// Mic control
// ---------------------------------------------------------------------------

function getMicButton() {
  return document.querySelector('button[data-is-muted][aria-label*="microphone" i]');
}

function isMicMuted() {
  const btn = getMicButton();
  return btn?.getAttribute('data-is-muted') === 'true';
}

// Set when we toggle the mic ourselves (TTS unmute / re-mute) so the
// MutationObserver below doesn't interpret our own click as a user gesture.
let suppressMicMuteWatcher = false;

function setMicMuted(mute) {
  const btn = getMicButton();
  if (!btn) return;
  const currentlyMuted = btn.getAttribute('data-is-muted') === 'true';
  if (mute !== currentlyMuted) {
    suppressMicMuteWatcher = true;
    btn.click();
    // Clear after a tick — the data-is-muted update is synchronous on click.
    setTimeout(() => { suppressMicMuteWatcher = false; }, 50);
    console.debug('[electron-meet] Mic', mute ? 'muted' : 'unmuted');
  }
}

// Watch for user toggling the mic via Meet's UI. When that happens we map
// it to a listening-mode change: muted = passive, unmuted = active. Calls
// from our own setMicMuted() set suppressMicMuteWatcher and are ignored.
function startMicMuteWatcher() {
  const btn = getMicButton();
  if (!btn) {
    setTimeout(startMicMuteWatcher, 1000);
    return;
  }
  const observer = new MutationObserver(() => {
    if (suppressMicMuteWatcher) return;
    const muted = btn.getAttribute('data-is-muted') === 'true';
    console.log('[electron-meet] User toggled mic →', muted ? 'muted (passive)' : 'unmuted (active)');
    ipcRenderer.send('mic-mute-changed', { muted });
  });
  observer.observe(btn, { attributes: true, attributeFilter: ['data-is-muted'] });
  console.log('[electron-meet] Mic mute watcher started');
}

// ---------------------------------------------------------------------------
// Camera control
// ---------------------------------------------------------------------------

// Meet's camera toggle swaps its aria-label between "Turn off camera" (when
// the camera is on) and "Turn on camera" (when it's off) — the label is the
// action you'd take by clicking. So we read the current state from the label.
function getCameraButton() {
  return (
    document.querySelector('button[aria-label="Turn off camera"]') ||
    document.querySelector('button[aria-label="Turn on camera"]')
  );
}

function isCameraOn() {
  return !!document.querySelector('button[aria-label="Turn off camera"]');
}

function setCameraOff(off) {
  const btn = getCameraButton();
  if (!btn) {
    console.warn('[electron-meet] Camera button not found');
    return;
  }
  const currentlyOff = !isCameraOn();
  if (off !== currentlyOff) {
    btn.click();
    console.log('[electron-meet] Camera', off ? 'off' : 'on');
  }
}

// ---------------------------------------------------------------------------
// Chat — read & send Meet chat messages
//
// Opening chat CLOSES the people pane, which is what the DOMSpeakerTracker
// reads for speech detection. So every chat operation is discrete: open chat,
// do the thing, then reopen the people pane. The chat button's aria-label
// ("… - New message") is a passive unread signal we can read WITHOUT opening
// the pane, so monitoring for unread messages doesn't disturb speech tracking.
// ---------------------------------------------------------------------------

// Count participant tiles that are actually VISIBLE. Switching to the chat
// pane hides the people pane (display:none) but leaves the tile elements in the
// DOM, so a plain querySelectorAll count stays > 0 and falsely reads as "people
// pane open". getClientRects() is empty for display:none elements, so it's a
// reliable visibility test.
function visiblePeopleTileCount() {
  let n = 0;
  for (const el of document.querySelectorAll('div[role="listitem"][aria-label]')) {
    if (el.getClientRects().length > 0) n++;
  }
  return n;
}

// Diagnostic dump for the captions-button race (#247). When the "Turn on
// captions" button can't be found (or never confirms on), we go silently deaf —
// and we've only been logging "button never appeared", which doesn't tell us WHY.
// This captures what the toolbar ACTUALLY contains so we can SEE the failing view
// (suspected: the cross-org / guest layout from a personal-Gmail-hosted meeting,
// where the captions control may be missing, renamed, or tucked behind the
// "More options" ⋮ menu) instead of guessing. Cheap, read-only; safe to call on
// every failure path. Pairs with #246 (escalating the deaf state, not just logging it).
function dumpCaptionDiagnostics(reason) {
  try {
    const labelEls = document.querySelectorAll('button[aria-label], [role="button"][aria-label]');
    const uniqLabels = Array.from(new Set(
      Array.from(labelEls).map(b => b.getAttribute('aria-label')).filter(Boolean)
    ));
    const ccOn = !!findByAriaLabel('Turn on captions') || !!findByAriaLabel('Activar subtítulos');
    const ccOff = !!findByAriaLabel('Turn off captions') || !!findByAriaLabel('Desactivar subtítulos');
    const moreMenu = !!findByAriaLabel('More options') || !!findByAriaLabel('Más opciones');
    const guestNameInput = !!document.querySelector('input[aria-label*="name" i], input[placeholder*="name" i]');
    console.warn('[electron-meet] [CC-diag] ' + reason +
      ' — tiles=' + visiblePeopleTileCount() +
      ' ccOnBtn=' + ccOn + ' ccOffBtn=' + ccOff + ' moreMenuBtn=' + moreMenu +
      ' guestNameInput=' + guestNameInput +
      ' totalToolbarBtns=' + uniqLabels.length +
      ' url=' + location.href);
    // The full label list is the money shot: it shows whether "Turn on captions"
    // is absent, renamed, or hidden in a submenu in this (guest) view.
    console.warn('[electron-meet] [CC-diag] button aria-labels: ' + JSON.stringify(uniqLabels));
  } catch (e) {
    console.warn('[electron-meet] [CC-diag] dump failed:', e && e.message);
  }
}

function getChatToggle() {
  // Label is "Chat with everyone" or "Chat with everyone - New message".
  return document.querySelector(
    'button[aria-label^="Chat with everyone" i], [role="button"][aria-label^="Chat with everyone" i]'
  );
}

function hasUnreadChat() {
  const btn = getChatToggle();
  return !!btn && /new message/i.test(btn.getAttribute('aria-label') || '');
}

function getChatInput() {
  return document.querySelector('textarea[aria-label="Send a message" i]');
}

function isChatPaneOpen() {
  return !!getChatInput();
}

async function openChatPane() {
  if (isChatPaneOpen()) {
    console.log('[chat] Chat pane already open');
    return true;
  }
  const btn = getChatToggle();
  if (!btn) {
    console.warn('[chat] ❌ Chat toggle button not found');
    return false;
  }
  console.log('[chat] → switching to Chat pane (clicking', JSON.stringify(btn.getAttribute('aria-label')), ')');
  btn.click();
  for (let i = 0; i < 20; i++) {
    await delay(150);
    if (isChatPaneOpen()) {
      console.log('[chat] ✓ Chat pane open');
      return true;
    }
  }
  console.warn('[chat] ❌ Chat pane did not open after click');
  return false;
}

// Reopen the people pane so the DOMSpeakerTracker can resume reading speaking
// indicators. Clicking People also closes the chat pane (Meet's side panel
// shows one pane at a time). Verify the tiles actually appear and retry — a
// single click can be dropped mid-animation. The tracker's 2s self-heal is a
// backstop if all retries somehow fail.
async function restorePeoplePane() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = findPeopleButton();
    if (!btn) {
      console.warn('[chat] ❌ People button not found (attempt', attempt + 1, 'of 3)');
    } else {
      const labelledby = btn.getAttribute('aria-labelledby');
      const labelText = labelledby ? document.getElementById(labelledby)?.textContent?.trim() : null;
      console.log('[chat] → switching to People pane (clicking button, aria-label=' +
        JSON.stringify(btn.getAttribute('aria-label')) + ', label=' + JSON.stringify(labelText) + ', attempt ' + (attempt + 1) + ')');
      btn.click();
    }
    for (let i = 0; i < 8; i++) {
      await delay(150);
      const tiles = visiblePeopleTileCount();
      if (tiles > 0) {
        console.log('[chat] ✓ People pane restored (' + tiles + ' visible tiles) after attempt', attempt + 1);
        return true;
      }
    }
    console.warn('[chat] People pane not visible after attempt', attempt + 1, '— retrying');
  }
  console.warn('[chat] ❌ Failed to reopen People pane after 3 attempts — speech tracking is blind');
  return false;
}

// A sender header is a div with exactly two div children where the second is a
// timestamp (e.g. "2:32 PM") — the first is the participant name. Meet renders
// one header per run of consecutive messages from the same person; messages
// below it (until the next header) belong to that sender. Detect structurally
// rather than by class/jsname, which rotate.
function senderFromHeader(el) {
  if (el.tagName !== 'DIV' || el.children.length !== 2) return null;
  const [nameEl, timeEl] = el.children;
  if (nameEl.tagName !== 'DIV' || timeEl.tagName !== 'DIV') return null;
  const timeText = timeEl.textContent.trim();
  if (!/^\d{1,2}:\d{2}\s*([AP]\.?M\.?)?$/i.test(timeText)) return null;
  const name = nameEl.textContent.trim();
  return name || null;
}

function scrapeChatMessages() {
  // Collect sender headers and message bodies, order them by document position,
  // and attribute each message to the most recent header above it.
  //
  // Message bodies are divs carrying data-message-id="spaces/.../messages/...".
  // Pin BUTTONS share that attribute but have aria-label="Pin message" — skip
  // those (and any button). Only the chat pane is open during a scrape (people
  // pane is closed), so the header pattern doesn't collide with participant tiles.
  const markers = [];
  for (const el of document.querySelectorAll('div')) {
    const sender = senderFromHeader(el);
    if (sender) markers.push({ kind: 'header', el, sender });
  }
  for (const el of document.querySelectorAll('[data-message-id]')) {
    if (el.tagName === 'BUTTON') continue;
    if (/pin message/i.test(el.getAttribute('aria-label') || '')) continue;
    markers.push({ kind: 'msg', el });
  }
  markers.sort((a, b) => {
    if (a.el === b.el) return 0;
    return (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  const out = [];
  const seen = new Set();
  let currentSender = '';
  for (const m of markers) {
    if (m.kind === 'header') { currentSender = m.sender; continue; }
    const id = m.el.getAttribute('data-message-id');
    if (!id || seen.has(id)) continue;
    const text = (m.el.innerText || '').trim();
    if (!text) continue;
    seen.add(id);
    out.push(currentSender ? { id, sender: currentSender, text } : { id, text });
  }
  return out;
}

async function readChatFlow() {
  const opened = await openChatPane();
  if (!opened) throw new Error('Could not open the chat pane');
  await delay(300); // let messages render
  const messages = scrapeChatMessages();
  await restorePeoplePane(); // close chat, restore speech tracking
  return messages;
}

async function sendChatFlow(text) {
  const opened = await openChatPane();
  if (!opened) throw new Error('Could not open the chat pane');
  const input = getChatInput();
  if (!input) throw new Error('Could not find the chat input');
  await typeIntoInput(input, text);
  await delay(100);

  // Prefer clicking the real send button — synthetic Enter keystrokes are
  // untrusted events that Meet's React handlers don't always honor, which
  // is the source of the intermittent "input not cleared" failures (#190).
  // findByAriaLabel only matches button/[role=button], so it can't collide
  // with the textarea (whose aria-label is also "Send a message").
  const trySend = () => {
    const sendBtn = findByAriaLabel('Send a message') || findByAriaLabel('Send message');
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return 'button';
    }
    const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    input.dispatchEvent(new KeyboardEvent('keydown', enter));
    input.dispatchEvent(new KeyboardEvent('keypress', enter));
    input.dispatchEvent(new KeyboardEvent('keyup', enter));
    return 'enter';
  };

  let via = trySend();
  // Poll for the input to clear (= send succeeded) instead of a single
  // 200ms-later snapshot; retry through the other path halfway in.
  let sent = false;
  for (let i = 0; i < 15; i++) {
    await delay(100);
    if (input.value.trim() === '') { sent = true; break; }
    if (i === 7) via = trySend();
  }
  console.log('[electron-meet] sendChat via ' + via + ' — sent: ' + sent);
  await restorePeoplePane(); // close chat, restore speech tracking
  return sent;
}

ipcRenderer.on('read-chat', async (_event, { requestId }) => {
  let result;
  try { result = { ok: true, messages: await readChatFlow() }; }
  catch (err) { result = { ok: false, error: err.message }; }
  ipcRenderer.send('chat-result', { requestId, ...result });
});

ipcRenderer.on('send-chat', async (_event, { requestId, text }) => {
  let result;
  try {
    const sent = await sendChatFlow(text);
    result = sent ? { ok: true } : { ok: false, error: 'Message may not have sent (input not cleared)' };
  } catch (err) { result = { ok: false, error: err.message }; }
  ipcRenderer.send('chat-result', { requestId, ...result });
});

// ---------------------------------------------------------------------------
// Present-button discovery
// ---------------------------------------------------------------------------
//
// Meet's toolbar share button cycles through four label states. We treat
// the first two as "OK to click to start a share" and surface the others
// as state, not failure:
//
//   "Share screen" / "Present now"          → idle, click to start
//   "<participant name> is presenting"      → someone ELSE sharing —
//                                             still clickable to take over
//                                             (or to view; Meet allows
//                                             concurrent presenters).
//   "You are presenting"                    → WE are sharing — clicking
//                                             would re-open the picker;
//                                             callers detect this state
//                                             separately and short-circuit.
//   anything else                           → unknown — error path.
//
// Both aria-label and data-tooltip carry the text depending on Meet's
// build. probePresentingState() extracts the semantic state from whichever
// is present; findPresentButton() returns the clickable element regardless
// of which label variant Meet is currently rendering.

const PRESENT_LABEL_IDLE_RE = /^(?:Share screen|Present now)$/i;
const PRESENT_LABEL_SOMEONE_ELSE_RE = /(.+?)\s+is presenting$/i;
const PRESENT_LABEL_SELF_RE = /^You are presenting$/i;

function presentButtonText(el) {
  // Prefer aria-label (used by current builds) but fall back to
  // data-tooltip (older builds). Either may be present, sometimes both.
  return (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim();
}

function findPresentButton() {
  // Iterate the small set of toolbar candidates and pick the one whose
  // text matches a known state. Sweeping every aria-label*="present" in
  // the DOM would also match "Stop presenting" overlays from active
  // shares, which is not what we want here.
  const candidates = [
    ...document.querySelectorAll('button[aria-label]'),
    ...document.querySelectorAll('[role="button"][aria-label]'),
    ...document.querySelectorAll('[data-tooltip]'),
  ];
  for (const el of candidates) {
    const t = presentButtonText(el);
    if (!t) continue;
    if (PRESENT_LABEL_IDLE_RE.test(t)) return el;
    if (PRESENT_LABEL_SOMEONE_ELSE_RE.test(t)) return el;
    if (PRESENT_LABEL_SELF_RE.test(t)) return el;
  }
  return null;
}

function probePresentingState() {
  const btn = findPresentButton();
  if (!btn) return { selfPresenting: false, presenterName: null, buttonFound: false };
  const t = presentButtonText(btn);
  if (PRESENT_LABEL_SELF_RE.test(t)) {
    return { selfPresenting: true, presenterName: null, buttonFound: true };
  }
  const m = t.match(PRESENT_LABEL_SOMEONE_ELSE_RE);
  if (m) return { selfPresenting: false, presenterName: m[1], buttonFound: true };
  // Idle ("Share screen" / "Present now") — nobody presenting.
  return { selfPresenting: false, presenterName: null, buttonFound: true };
}

// ---------------------------------------------------------------------------
// Consolidated call-health tick (#226)
// ---------------------------------------------------------------------------
//
// Single 1s setInterval that does ONE DOM pass per tick, diffs against the
// previous snapshot, and emits per-edge IPCs. Replaces five separate
// watchers that each ran their own setInterval + querySelector + previous-
// state tracking. Same IPC channel names as before so main.js consumers
// don't change.
//
// What's NOT folded in (different lifecycle / cadence):
//   - speakingPollInterval (200ms) — performance-sensitive
//   - caption text scraping inside CaptionScraper — content ingestion
//   - DOMSpeakerTracker.checkInterval (2s) — owns its own state machine
//   - startMicMuteWatcher — event-driven MutationObserver
//
// New signals slot in by adding a key to gatherCallHealthSnapshot() plus a
// diff/emit clause below — no new timer needed.

function gatherCallHealthSnapshot() {
  // Mic: button label + data-is-muted tell us whether the mic is wired up.
  // Single querySelector shared with the mic-mute watcher, but that one
  // operates on its own (MutationObserver), so reading here is independent.
  const micBtn = document.querySelector('button[data-is-muted]');
  let micHealth = 'unknown';
  if (micBtn) {
    const label = micBtn.getAttribute('aria-label') || '';
    const muted = micBtn.getAttribute('data-is-muted');
    const ok = (label === 'Turn off microphone' && muted === 'false')
            || (label === 'Turn on microphone' && muted === 'true');
    micHealth = ok ? 'healthy' : 'problem';
  }

  // Presenting state — see probePresentingState() for the full label
  // taxonomy. Three states: self / other / none.
  const { selfPresenting, presenterName } = probePresentingState();

  // Participant list — domSpeakerTracker keeps the canonical map; we just
  // snapshot it here. After the recent edge-fired fix in _checkSpeakingChange
  // this is mostly redundant as a heartbeat, but cheap insurance against any
  // edge-emit miss.
  const participants = (typeof domSpeakerTracker !== 'undefined' && domSpeakerTracker.getParticipantList)
    ? domSpeakerTracker.getParticipantList()
    : [];

  return {
    micHealth,
    chatUnread: hasUnreadChat(),
    chatPaneOpen: isChatPaneOpen(),
    peoplePaneOpen: visiblePeopleTileCount() > 0,
    selfPresenting,
    presenterName, // null when nobody else is presenting
    participants,
  };
}

function installCallHealthTick() {
  let last = {};
  let lastMicReported = 'unknown';
  let lastParticipantsKey = '';

  const tick = () => {
    // Dismiss any blocking Meet onboarding modal before probing the DOM —
    // the overlay sits on top of the UI and would otherwise skew pane /
    // present / button detection below (#227). Also accept the AI-recording
    // disclosure if it appears mid-call (e.g. recording toggled on later) (#130).
    try { dismissBlockingModals(); } catch { /* non-fatal */ }
    try { acceptRecordingConsentIfPresent(); } catch { /* non-fatal */ }

    // #242: clear a stale error banner once we're actually in the call. The
    // "join button not found" error (#240) could linger after a manual recovery
    // because the clear depends on enterInCallState having re-fired. If the
    // in-call toolbar is present but the status bar still shows .error, reset it.
    try {
      const inCallNow = !!(findByAriaLabel('Leave call') || document.querySelector('[data-tooltip="Leave call"]'));
      const statusEl = document.getElementById('vibeconf-status');
      if (inCallNow && statusEl && statusEl.classList.contains('error')) {
        sendStatus('Participating in Meet');
      }
    } catch { /* non-fatal */ }

    let next;
    try { next = gatherCallHealthSnapshot(); }
    catch (err) {
      console.warn('[health-tick] snapshot threw:', err.message);
      return;
    }

    // --- Mic ---
    // Original semantics: WARN once on transition into problem, re-broadcast
    // the to-panel error EVERY tick while in problem state (the panel uses
    // it as a persistent banner that needs continuous re-assertion), and
    // emit 'healthy' once on recovery.
    if (next.micHealth === 'problem') {
      if (lastMicReported !== 'problem') {
        const btn = document.querySelector('button[data-is-muted]');
        const label = btn?.getAttribute('aria-label') || '';
        const muted = btn?.getAttribute('data-is-muted');
        console.warn('[electron-meet] Mic issue:', label, 'data-is-muted:', muted);
      }
      const btn = document.querySelector('button[data-is-muted]');
      const label = btn?.getAttribute('aria-label') || '';
      ipcRenderer.send('to-panel', {
        action: 'error',
        message: `Microphone issue: "${label}". Try reloading the Meet window.`,
      });
    } else if (next.micHealth === 'healthy' && lastMicReported !== 'healthy') {
      ipcRenderer.send('to-panel', { action: 'mic-status', status: 'healthy' });
    }
    lastMicReported = next.micHealth;

    // --- Chat unread ---
    if (next.chatUnread !== last.chatUnread) {
      ipcRenderer.send('chat-unread', { unread: next.chatUnread });
    }

    // --- Pane state ---
    if (next.chatPaneOpen !== last.chatPaneOpen || next.peoplePaneOpen !== last.peoplePaneOpen) {
      ipcRenderer.send('pane-state', {
        chatPaneOpen: next.chatPaneOpen,
        peoplePaneOpen: next.peoplePaneOpen,
      });
    }

    // --- Presenting state ---
    // Match the previous watcher's emit pattern: self-presenting and
    // someone-presenting are independent channels. Self-presenting forces
    // someone-presenting=false (we're the one presenting).
    if (next.selfPresenting !== last.selfPresenting) {
      ipcRenderer.send('self-presenting', { presenting: next.selfPresenting });
    }
    const someoneElse = !next.selfPresenting && !!next.presenterName;
    const lastSomeoneElse = !last.selfPresenting && !!last.presenterName;
    if (someoneElse !== lastSomeoneElse || next.presenterName !== last.presenterName) {
      ipcRenderer.send('someone-presenting', {
        presenting: someoneElse,
        presenterName: someoneElse ? next.presenterName : null,
      });
    }

    // --- Participants ---
    // Keyed snapshot diff — re-emit only when the list actually changes
    // (name set or speaking flags). The edge-fired path in
    // _checkSpeakingChange handles most updates; this is the heartbeat.
    if (next.participants.length > 0) {
      const key = next.participants
        .map(p => `${p.name}:${p.speaking ? 1 : 0}:${p.isSelf ? 1 : 0}`)
        .sort()
        .join('|');
      if (key !== lastParticipantsKey) {
        lastParticipantsKey = key;
        ipcRenderer.send('participants-updated', next.participants);
      }
    }

    last = next;
  };

  setInterval(tick, 1000);
  // Fire one immediately so consumers don't have to wait a full second for
  // the first snapshot (e.g. a still-loading panel asking for state).
  tick();
}

// ---------------------------------------------------------------------------
// Auto-join
// ---------------------------------------------------------------------------

let BOT_NAME = 'Jimmy';

// Race-sensitive: if Meet's pre-join screen renders before this resolves,
// autoJoin would type the default 'Jimmy' into the name input even when the
// user has a different botName configured. Keep the promise around so the
// DOMContentLoaded handler can await it before reading BOT_NAME.
const botNameLoaded = ipcRenderer.invoke('get-meet-bot-name').then((name) => {
  if (name) {
    BOT_NAME = name;
    console.log('[electron-meet] Loaded botName for this call:', BOT_NAME);
  }
}).catch((err) => {
  console.warn('[electron-meet] Failed to load botName:', err.message);
});

// Debug visual: outline the participant tile the speaker tracker thinks is
// speaking, so it can be eyeballed against Meet's own animating mic meter
// (#229 diagnosis). Defaults ON — the bot's Meet view is only ever seen by the
// operator in the Electron window, never by call participants, so there's no
// reason to hide it. Set speakerDebugBorder:false in config.json to disable.
let speakerDebugBorder = true;
ipcRenderer.invoke('get-config', ['speakerDebugBorder']).then((r) => {
  speakerDebugBorder = r?.speakerDebugBorder !== false; // explicit false disables
  console.log('[electron-meet] speakerDebugBorder', speakerDebugBorder ? 'ON — speaking tiles outlined' : 'OFF');
}).catch(() => {});

function ensureStatusBar() {
  if (document.getElementById('vibeconf-status-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'vibeconf-status-bar';
  bar.innerHTML = '<span class="icon">🤖</span><span class="label">Bot View —</span><span class="status" id="vibeconf-status">Initializing...</span>';

  const style = document.createElement('style');
  style.textContent = `
    #vibeconf-status-bar {
      position: fixed; top: 0; left: 0; right: 0; height: 56px;
      /* Partially transparent so any Google buttons beneath stay visible... */
      background: rgba(138, 180, 248, 0.78); color: #ffffff;
      /* ...and click-through so they stay USABLE for debugging — the banner
         never intercepts pointer events (#bot-view banner is purely a label). */
      pointer-events: none;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
      font-family: 'Google Sans', 'Roboto', sans-serif; font-size: 26px;
      font-weight: 500;
      display: flex; align-items: center; padding: 0 24px;
      z-index: 999999; user-select: none;
      letter-spacing: 0.5px;
    }
    #vibeconf-status-bar .icon { margin-right: 14px; font-size: 28px; }
    #vibeconf-status-bar .label { color: #e8f0fe; margin-right: 12px; }
    #vibeconf-status-bar .status { color: #ffffff; }
    #vibeconf-status-bar .status.error { color: #fce8e6; font-weight: 700; }
    #vibeconf-status-bar .status.active { color: #ffffff; }
    body { padding-top: 56px !important; }
  `;
  document.head.appendChild(style);
  document.body.prepend(bar);
}

function sendStatus(status) {
  console.log('[electron-meet] Status:', status);
  ensureStatusBar();
  const el = document.getElementById('vibeconf-status');
  if (el) {
    el.textContent = status;
    el.className = 'status';
    if (status.startsWith('Error')) el.classList.add('error');
    else if (status === 'Participating in Meet') el.classList.add('active');
  }
  // Also notify main process for logging
  ipcRenderer.send('meet-status-update', status);
}

// Poll for the captions button and click it as soon as it appears.
// At admission time the "Leave call" button often renders before "Turn on
// captions" does, so a single click attempt misses and we fall through to
// captionScraper's eventual retry (~30s later). This polls every 250ms
// for up to 30 seconds and clicks at the first opportunity.
// In some layouts (cross-org / guest views, #247) the captions button appears
// late, in a different node, or with a relabeled aria-label — so the old
// fixed-interval poll over a fixed 30s window raced and silently lost (= deaf
// bot). Instead: act immediately if present, then a MutationObserver (childList
// for late insertion, attributes for an existing button whose aria-label flips
// on) catches it whenever/wherever it renders, with a low-freq safety poll, and
// a backstop that ESCALATES the deaf state (#246) instead of giving up silently.
let captionsClickArmed = false;
function clickCaptionsWhenReady() {
  if (captionsClickArmed) return;
  captionsClickArmed = true;
  const startTime = Date.now();
  let settled = false;
  let observer = null;
  let safetyPoll = null;
  let backstop = null;

  const cleanup = () => {
    if (observer) { observer.disconnect(); observer = null; }
    if (safetyPoll) { clearInterval(safetyPoll); safetyPoll = null; }
    if (backstop) { clearTimeout(backstop); backstop = null; }
  };

  const attempt = () => {
    if (settled) return true;
    const offBtn = findByAriaLabel('Turn off captions') || findByAriaLabel('Desactivar subtítulos');
    if (offBtn) {
      settled = true; cleanup();
      console.log('[electron-meet] [CC] Already on, no click needed (', Date.now() - startTime, 'ms after admission)');
      return true;
    }
    const onBtn = findByAriaLabel('Turn on captions') || findByAriaLabel('Activar subtítulos');
    if (onBtn) {
      settled = true; cleanup();
      onBtn.click();
      console.log('[electron-meet] [CC] Clicked "Turn on captions" at', Date.now() - startTime, 'ms after admission (observer)');
      return true;
    }
    return false;
  };

  if (attempt()) return;

  observer = new MutationObserver(() => { attempt(); });
  try {
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'],
    });
  } catch { /* body not ready — the safety poll still covers it */ }

  safetyPoll = setInterval(attempt, 1000);

  backstop = setTimeout(() => {
    if (settled) return;
    cleanup();
    console.warn('[electron-meet] [CC] Captions button never appeared after 60s — escalating deaf');
    dumpCaptionDiagnostics('clickCaptionsWhenReady: button never appeared (60s, observer+poll)');
    try { ipcRenderer.send('captions-state', { on: false }); } catch { /* ignore */ }
  }, 60_000);
}

async function autoJoin(botName) {
  console.log('[electron-meet] ===== AUTO-JOIN STARTING =====');
  sendStatus('Joining Meet...');

  try {
    await delay(3000);

    // Dismiss dialogs
    for (const label of ['Got it', 'Dismiss', 'OK', 'Allow', 'Close', 'No thanks', 'Not now']) {
      const btn = findByText(label);
      if (btn) {
        btn.click();
        await delay(300);
      }
    }

    // Fill name. The persona name should win — if the input is missing, the
    // Electron session is signed in to a Google account and Meet will show
    // the bot under that account's display name instead (see #167). Warn so
    // the mismatch isn't silent.
    const nameInput =
      document.querySelector('input[placeholder="Your name"]') ||
      document.querySelector('input[aria-label="Your name"]') ||
      document.querySelector('input[autocomplete="name"]');

    if (nameInput) {
      await typeIntoInput(nameInput, botName);
      await delay(1000);
      if (nameInput.value !== botName) {
        const msg = `Persona name "${botName}" didn't stick on the pre-join input (got "${nameInput.value}"). Meet may overwrite it.`;
        console.warn('[electron-meet] ⚠️  ' + msg);
        ipcRenderer.send('to-panel', { action: 'error', message: msg });
      } else {
        console.log('[electron-meet] Persona name set on pre-join input:', botName);
      }
    } else {
      // No "Your name" input is **expected** in account mode (#170) — the bot
      // is signed in to Google, so Meet skips the guest pre-join and uses the
      // account's display name. Only warn when we're actually in guest mode
      // and the input genuinely wasn't found (something's off).
      let mode = 'guest';
      try {
        const info = await ipcRenderer.invoke('get-meet-mode');
        if (info?.mode) mode = info.mode;
      } catch (err) {
        console.warn('[electron-meet] get-meet-mode failed, assuming guest:', err.message);
      }
      if (mode === 'guest') {
        const msg = `Guest mode but no "Your name" input on pre-join — the bot will appear under whatever Meet picks. Persona was "${botName}".`;
        console.warn('[electron-meet] ⚠️  ' + msg);
        ipcRenderer.send('to-panel', { action: 'error', message: msg });
      } else {
        console.log('[electron-meet] Account mode — using Google account display name (persona "' + botName + '" is informational).');
      }
    }

    // Check mic health before joining
    const micBtn = document.querySelector('button[data-is-muted]');
    if (micBtn) {
      const micLabel = micBtn.getAttribute('aria-label') || '';
      const micMuted = micBtn.getAttribute('data-is-muted');
      const micHealthy =
        (micLabel === 'Turn off microphone' && micMuted === 'false') ||
        (micLabel === 'Turn on microphone' && micMuted === 'true');

      if (!micHealthy) {
        console.warn('[electron-meet] Mic problem on pre-join screen');
        sendStatus('Error: mic issue detected');
        ipcRenderer.send('to-panel', {
          action: 'error',
          message: `Cannot join: mic issue detected ("${micLabel}").`,
        });
        return;
      }
    }

    // Click join. Use a TIME deadline, not a fixed attempt count (#240): the
    // modal/popup dismissals below each `continue` the loop, so a fixed budget
    // got exhausted by popups on a slow cold join before the real "Ask to join"
    // button finished rendering — and the bot bailed with "join button not
    // found". A wall-clock deadline keeps looking for the button for the full
    // window regardless of how many popups we cleared first.
    let clicked = false;
    const joinDeadline = Date.now() + 60000;
    while (!clicked && Date.now() < joinDeadline) {
      await delay(1000);
      // Clear blocking pre-join overlays before looking for the join button.
      // Known "Others may see your video differently" overlay (#227), gated by
      // heading so we never click an unrelated "Got it":
      if (dismissBlockingModals()) continue;
      // #130: if the AI-recording disclosure dialog is up at pre-join, accepting
      // it ("Join now") IS the join/consent — count it as clicked and move on.
      if (acceptRecordingConsentIfPresent()) { clicked = true; continue; }
      // Meet's "Sign in with your Google account" promo popup can also render
      // before the join panel and delay/overlay the join button (6232133). It
      // isn't in the gated heading list; on the pre-join screen any remaining
      // "Got it" is a promo we want gone, so dismiss it here.
      const gotIt = findByText('Got it');
      if (gotIt) {
        console.log('[electron-meet] Dismissing pre-join sign-in popup');
        gotIt.click();
        continue;
      }
      const joinBtn =
        findByText('Ask to join') ||
        findByText('Join now') ||
        findByAriaLabel('Ask to join') ||
        findByAriaLabel('Join');

      if (joinBtn) {
        const btnText = joinBtn.textContent.trim();
        console.log('[electron-meet] Clicking join:', btnText.slice(0, 30));
        joinBtn.click();
        clicked = true;

        if (btnText.includes('Ask to join')) {
          sendStatus('Waiting to be admitted...');
        } else {
          sendStatus('Joining...');
        }
      }
    }

    if (!clicked) {
      sendStatus('Error: join button not found');
      console.warn('[electron-meet] Could not find join button');
      return;
    }

    // Wait for actual admission — keep waiting indefinitely while Meet shows
    // the "waiting to be admitted" UI. The host may take several minutes to
    // notice the request; we should not time out as long as Meet itself is
    // still asking us to wait. We only bail if waiting text disappears AND
    // in-call UI never appears within a grace period (denied / kicked / etc).
    //
    // Why the grace period: at the moment of admission, the waiting text
    // disappears a beat before the in-call toolbar (Leave call / captions
    // buttons) renders. Without slack, the loop sees "no waiting UI, no
    // in-call UI" and bails immediately even though admission succeeded.
    let admitted = false;
    let waitedSeconds = 0;
    let limboSeconds = 0; // consecutive seconds with neither waiting nor in-call UI
    const LIMBO_GRACE_SECONDS = 15;
    let logEvery = 30;
    while (!admitted) {
      await delay(1000);
      waitedSeconds++;

      // #130: a premium call shows an AI-recording disclosure dialog ("…being
      // recorded and transcribed. Gemini is taking notes.") with a "Join now"
      // button. Its "Join now" also trips hasJoinUI below, so without accepting
      // it the loop waits forever. Click it to consent, then re-evaluate.
      if (acceptRecordingConsentIfPresent()) continue;
      // #240: a "Got it" info modal ("…screen may not appear…", etc.) can also
      // appear during admission and block — clear it before evaluating state.
      if (dismissBlockingModals()) continue;

      const bodyText = document.body.innerText;
      const waitingText = bodyText.includes('wait until') ||
        bodyText.includes('asking to be let in') ||
        bodyText.includes('Please wait');
      const hasJoinUI = !!findByText('Ask to join') || !!findByText('Join now');
      const inCallUI =
        findByAriaLabel('Leave call') ||
        findByAriaLabel('Turn on captions') ||
        findByAriaLabel('Turn off captions') ||
        document.querySelector('[data-tooltip="Leave call"]');

      // Explicit denial pages — Meet shows one of these when the host blocks
      // entry or the call is otherwise inaccessible. Fail fast rather than
      // burning the 15s limbo grace, and give the agent a specific reason.
      if (bodyText.includes("You can't join this video call")) {
        sendStatus("Error: can't join this video call (host blocked entry or call inaccessible)");
        console.warn('[electron-meet] Denial page detected: "You can\'t join this video call"');
        return;
      }
      if (bodyText.includes('You have been removed from the meeting')) {
        sendStatus('Error: removed from the meeting');
        console.warn('[electron-meet] Removal page detected');
        return;
      }

      if (inCallUI && !hasJoinUI) {
        admitted = true;
        sendStatus('Participating in Meet');
        // Don't try a one-shot captions click here — the toolbar's "Leave
        // call" button often renders before "Turn on captions" does, so a
        // single click attempt at admission misses. Instead kick off a
        // separate waiter that retries every 250ms until the captions
        // button is in the DOM, then clicks it. captionScraper.start()
        // also retries via its own loop, so this is a fast-path overlap.
        clickCaptionsWhenReady();
        break;
      }

      if (!waitingText && !hasJoinUI && !inCallUI) {
        limboSeconds++;
        if (limboSeconds >= LIMBO_GRACE_SECONDS) {
          // Genuine failure: waiting UI gone, never saw in-call UI.
          sendStatus("Error: couldn't enter call (denied or removed?)");
          console.warn('[electron-meet] Lost waiting UI without entering call after',
            waitedSeconds, 's (', limboSeconds, 's in limbo)');
          return;
        }
      } else {
        limboSeconds = 0; // reset whenever a known UI is visible
      }

      if (waitedSeconds % logEvery === 0) {
        console.log('[electron-meet] Still waiting to be admitted (', waitedSeconds, 's )');
        sendStatus(`Waiting to be admitted (${Math.floor(waitedSeconds / 60)}m ${waitedSeconds % 60}s)...`);
      }
    }
  } catch (err) {
    sendStatus('Error: ' + err.message);
    console.error('[electron-meet] Auto-join error:', err);
  }
}

// ---------------------------------------------------------------------------
// DOM Speaker Tracker (from content-script.js)
// ---------------------------------------------------------------------------

// Find the "People" toggle in the bottom bar. Match leniently — with
// participants present the accessible name often carries a count (e.g.
// "People3"), so an exact "People" check misses it. startsWith handles both.
function findPeopleButton() {
  for (const btn of document.querySelectorAll('[role="button"][aria-labelledby]')) {
    const labelId = btn.getAttribute('aria-labelledby');
    if (!labelId) continue;
    const label = document.getElementById(labelId);
    if (label && label.textContent.trim().startsWith('People')) return btn;
  }
  return document.querySelector('button[aria-label^="People" i], [role="button"][aria-label^="People" i]');
}

class DOMSpeakerTracker {
  constructor() {
    this.participants = new Map();
    this.observer = null;
    this.isTracking = false;
    this.checkInterval = null;
  }

  start() {
    if (this.isTracking) return;
    this.isTracking = true;
    this._ensurePeoplePaneOpen();
    this.checkInterval = setInterval(() => {
      this._scanParticipants();
      // Self-heal: reopen the people pane whenever it's closed (e.g. a chat
      // read/send switched to the chat pane). _ensurePeoplePaneOpen no-ops when
      // tiles are already present, so this is cheap. Gating on participants.size
      // was wrong — the Map keeps stale entries after the pane closes, so it
      // stayed non-zero and the pane never reopened.
      this._ensurePeoplePaneOpen();
    }, 2000);
    this._startObserving();
    this.speakingPollInterval = setInterval(() => this._pollSpeakingState(), 200);
    // Diagnostic heartbeat (5s): makes a "deaf" window legible after the fact.
    // Per participant: is the tile still attached, is the indicator live, and
    // how many raw indicator class-changes (audio-meter animation) we've seen
    // since the last beat — chg>0 means that person's meter was animating (they
    // were speaking) even if our detection threshold missed it. See #229/#187.
    this.healthInterval = setInterval(() => this._logHealth(), 5000);
  }

  stop() {
    this.isTracking = false;
    if (this.observer) this.observer.disconnect();
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.speakingPollInterval) clearInterval(this.speakingPollInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);
  }

  _logHealth() {
    if (!this.isTracking) return;
    const parts = [];
    for (const [name, info] of this.participants) {
      const itemLive = info.item ? document.contains(info.item) : false;
      const mut = info._hbSubtreeMut || 0;    // tile mutations since last beat (the detection signal)
      info._hbSubtreeMut = 0;
      parts.push(`${name}${info.isSelf ? '(self)' : ''}[spk=${info.speaking ? 1 : 0} item=${itemLive ? 'live' : 'STALE'} mut=${mut}]`);
    }
    console.log('[speaker-health] tiles=' + visiblePeopleTileCount() + ' | ' + (parts.join(' ') || '(no participants tracked)'));
  }

  _ensurePeoplePaneOpen() {
    // Detect "pane is open" by the same structural marker _scanParticipants uses:
    // tiles only exist when the people list is rendered. The previous check used
    // jsname="jrQDbd" + a stale aria-label fallback; once Google rotated jsname
    // the "open" check always returned false and the 2-second loop toggled the
    // pane open→closed→open→closed forever (especially visible under throttling).
    // Only treat the pane as open if tiles are actually visible — switching to
    // chat hides them (display:none) but leaves them in the DOM.
    if (visiblePeopleTileCount() > 0) return;

    // Throttle clicks so a slow Meet load doesn't fire repeated opens before
    // the first click has finished animating. If we just clicked, give it a
    // second to settle before trying again.
    const now = Date.now();
    if (this._lastPeopleClickAt && now - this._lastPeopleClickAt < 1500) return;

    const btn = findPeopleButton();
    if (btn) {
      this._lastPeopleClickAt = now;
      console.log('[speaker-tracker] Opening People pane');
      btn.click();
    }
  }

  _scanParticipants() {
    const items = document.querySelectorAll('div[role="listitem"][aria-label]');
    for (const item of items) {
      const name = item.getAttribute('aria-label');
      if (!name) continue;
      // Register every participant tile. Detection is mutation-rate based
      // (_checkSpeakingChange), so we no longer need to locate a specific
      // indicator element — which also means a Meet DOM change can't make us
      // skip a participant and go blind to them.

      // Self-detection: Meet's own tile has a "(You)" text node next to the
      // display name (the aria-label is just the name, so we can't infer from
      // that alone). Without this flag the bot's TTS audio meter pulses get
      // counted as someone-is-speaking and cancel the silence timer.
      const isSelf = item.textContent.includes('(You)');

      if (!this.participants.has(name)) {
        if (isSelf) {
          console.log('[speaker-tracker] Identified self tile:', name);
        }
        this.participants.set(name, {
          speaking: false, isSelf, item,
          mutTimes: [], lastTrueAt: 0, lastChange: Date.now(),
        });
      } else {
        const info = this.participants.get(name);
        info.item = item;
        info.isSelf = isSelf;
      }
    }
  }

  _startObserving() {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          this._checkSpeakingChange(mutation.target);
        }
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) this._checkSpeakingChange(node);
          }
        }
      }
    });
    this.observer.observe(document.body, {
      attributes: true, attributeFilter: ['class'], childList: true, subtree: true,
    });
  }

  // Detection signal (#229): count mutations WITHIN a participant's tile in a
  // rolling window. Meet's audio meter churns the bar classes 5-10 Hz while
  // someone speaks, so a high tile-mutation rate == speaking. This replaced the
  // old approach of pinning to one structurally-guessed indicator element and
  // watching its className — that broke intermittently when findSpeakingIndicator
  // matched the wrong "3 empty divs" element (mute/pin controls have them too)
  // or held a stale ref after a Meet re-render, going totally deaf (chg=0 in
  // [speaker-health] while the real meter churned). Counting mutations across the
  // whole tile is robust to which element animates, to class-name rotation, and
  // to node swaps.
  _checkSpeakingChange(element) {
    const now = Date.now();
    for (const [name, info] of this.participants) {
      if (!info.item) continue;
      // Only count mutations that occur strictly WITHIN this tile — not on an
      // ancestor (e.g. a body-level class change), which isn't tile-specific
      // and would falsely mark everyone speaking at once.
      if (info.item === element || info.item.contains(element)) {
        (info.mutTimes || (info.mutTimes = [])).push(now);
        info._hbSubtreeMut = (info._hbSubtreeMut || 0) + 1;
        this._evaluateSpeaking(info, name, now, 'observer');
      }
    }
  }

  // Raw speaking signal: enough tile mutations in the recent window.
  _isSpeakingByMutation(info, now) {
    const WINDOW_MS = 1200;
    const MIN_MUTATIONS = 3; // meter does ~6-12 in this window; idle UI does <3
    const t = info.mutTimes;
    if (!t || !t.length) return false;
    while (t.length && now - t[0] > WINDOW_MS) t.shift();
    return t.length >= MIN_MUTATIONS;
  }

  // Asymmetric grace: true trusted instantly (avatar flips with no lag), false
  // held for SPEAKING_GRACE_MS so a brief animation pause mid-utterance doesn't
  // escape as a premature "stopped" (which used to leave wait_for_speech on a
  // stale stopped-timestamp — the 36s-late-response incident). The rolling
  // window already smooths; this adds margin on top.
  _isSpeakingWithGrace(info, now) {
    const raw = this._isSpeakingByMutation(info, now);
    if (raw) { info.lastTrueAt = now; return true; }
    const SPEAKING_GRACE_MS = 1000;
    if (info.lastTrueAt && (now - info.lastTrueAt) < SPEAKING_GRACE_MS) return true;
    return false;
  }

  // Shared flip: evaluate speaking, and on an edge emit the IPCs + toggle the
  // debug border. source distinguishes the observer (mutation-driven, catches
  // the true edge instantly) from the 200ms poll (catches the false edge once
  // the window drains, since the observer only fires while mutations arrive).
  _evaluateSpeaking(info, name, now, source) {
    const isSpeaking = this._isSpeakingWithGrace(info, now);
    if (isSpeaking !== info.speaking) {
      info.speaking = isSpeaking;
      info.lastChange = now;
      console.log('[speaker-tracker] (' + source + ')', name, '→', isSpeaking);
      this._applyDebugBorder(info, isSpeaking);
      ipcRenderer.send('update-speaking', { name, speaking: isSpeaking });
      ipcRenderer.send('participants-updated', this.getParticipantList());
    } else if (info.speaking && source === 'poll') {
      // Re-assert active speech so local-server's silence timer keeps resetting.
      ipcRenderer.send('update-speaking', { name, speaking: true });
    }
  }

  // Visual diagnostic (gated by speakerDebugBorder config): outline the tile we
  // currently think is speaking, so it can be eyeballed against Meet's own
  // animating mic meter in the same row.
  _applyDebugBorder(info, speaking) {
    if (!speakerDebugBorder || !info.item) return;
    this._injectDebugStyle(); // lazy — flag is loaded async, head exists by now
    try { info.item.classList.toggle('vibeconf-spk-debug', !!speaking); } catch { /* ignore */ }
  }

  _injectDebugStyle() {
    if (this._debugStyleInjected) return;
    this._debugStyleInjected = true;
    try {
      const style = document.createElement('style');
      style.textContent = `
        .vibeconf-spk-debug {
          outline: 3px solid #00e5ff !important;
          outline-offset: -3px !important;
          border-radius: 6px;
          animation: vibeconf-spk-pulse 0.7s ease-in-out infinite !important;
        }
        @keyframes vibeconf-spk-pulse {
          0%, 100% { box-shadow: 0 0 6px 2px rgba(0,229,255,0.55); }
          50%      { box-shadow: 0 0 16px 5px rgba(0,229,255,1); }
        }`;
      document.head.appendChild(style);
    } catch { /* ignore */ }
  }

  _pollSpeakingState() {
    const now = Date.now();
    for (const [name, info] of this.participants) {
      if (!info.item) continue;
      this._evaluateSpeaking(info, name, now, 'poll');
    }
  }

  getSpeakingNames() {
    return Array.from(this.participants.entries())
      .filter(([_, info]) => info.speaking)
      .map(([name]) => name);
  }

  getParticipantList() {
    return Array.from(this.participants.entries())
      .map(([name, info]) => ({ name, speaking: info.speaking, isSelf: !!info.isSelf }));
  }
}

const domSpeakerTracker = new DOMSpeakerTracker();

// ---------------------------------------------------------------------------
// Caption Scraper (from content-script.js)
// ---------------------------------------------------------------------------

class CaptionScraper {
  constructor() {
    this.isRunning = false;
    this.onReady = null; // fires once when caption container is observed
    // Stable per-DOM-child turn IDs. Each caption-container child = one
    // speaker turn (which Meet may continue editing — appending text or
    // rewriting the tail — while it's the bottommost child). WeakMap keyed
    // by DOM node so dead nodes drop out.
    //
    // Snapshot model (#178): each tick we send the full current state of
    // visible turns to local-server, which upserts them and marks settled
    // anything that's no longer bottommost. The transcript stops being an
    // event log and becomes a map of {turnId → current best-guess text},
    // matching how Meet's caption UI actually behaves.
    this._turnIdByChild = new WeakMap();
    this._nextTurnId = 1;
    this._lastSentSnapshot = ''; // for IPC dedup — skip sending if nothing changed
  }

  start() {
    if (this.isRunning) return;
    // Don't click here — clickCaptionsWhenReady (armed in the admission
    // loop) is already polling for the button. Clicking again risks a
    // double-toggle (off → on → off). Just wait for confirmation.
    this._waitForCaptions();
  }

  _enableCaptions() {
    const ccButton = findByAriaLabel('Turn on captions') || findByAriaLabel('Activar subtítulos');
    const offBtn = findByAriaLabel('Turn off captions') || findByAriaLabel('Desactivar subtítulos');
    if (ccButton) {
      console.log('[electron-meet] [CC] _enableCaptions: clicking "Turn on captions"');
      ccButton.click();
      console.log('[electron-meet] [CC] _enableCaptions: click() returned at', Date.now());
    } else if (offBtn) {
      console.log('[electron-meet] [CC] _enableCaptions: already on');
    } else {
      console.warn('[electron-meet] [CC] _enableCaptions: no captions button in DOM');
      dumpCaptionDiagnostics('_enableCaptions: no captions button in DOM');
    }
  }

  // The toolbar's caption button labels itself "Turn off captions" only when
  // captions are actually ON — more reliable than the [aria-label="Captions"]
  // container (which exists earlier). Poll for that confirmation; if it never
  // flips, RE-CLICK and retry with backoff (the click can land before the button
  // is wired). After the last round, ESCALATE the deaf state (#246) rather than
  // silently giving up — a clicked-but-never-confirmed bot is still deaf.
  _waitForCaptions(round = 0) {
    const ROUND_POLLS = [120, 160, 200]; // ×250ms = 30s, 40s, 50s (backoff)
    const maxPolls = ROUND_POLLS[round] || 200;
    let attempts = 0;
    const poll = setInterval(() => {
      const captionsAreOn = !!document.querySelector('[aria-label="Turn off captions" i]')
        || !!findByAriaLabel('Turn off captions')
        || !!findByAriaLabel('Desactivar subtítulos');
      if (captionsAreOn) {
        clearInterval(poll);
        console.log('[electron-meet] [CC] Captions confirmed on at', Date.now(),
          'after', attempts * 250, 'ms (round', round, ')');
        this._observe();
        if (this.onReady) { try { this.onReady(); } catch {} }
        return;
      }
      if (++attempts > maxPolls) {
        clearInterval(poll);
        if (round < ROUND_POLLS.length - 1) {
          console.warn('[electron-meet] [CC] Captions never flipped (round', round, ') — re-clicking, retrying with backoff');
          dumpCaptionDiagnostics('_waitForCaptions: not confirmed, round ' + round);
          this._enableCaptions();
          this._waitForCaptions(round + 1);
        } else {
          console.warn('[electron-meet] [CC] Captions never confirmed after', round + 1, 'rounds — escalating deaf');
          dumpCaptionDiagnostics('_waitForCaptions: gave up after ' + (round + 1) + ' rounds');
          try { ipcRenderer.send('captions-state', { on: false }); } catch { /* ignore */ }
        }
      }
    }, 250);
  }

  _observe() {
    this.isRunning = true;
    this._captionsOn = true; // _waitForCaptions just confirmed
    this._lastReenableAt = 0;
    this._pollInterval = setInterval(() => this._checkCaptions(), 1000);
    // Diagnostic heartbeat (5s): pairs with [speaker-health] to make a deaf
    // window legible — is the captions region present, how many turn nodes are
    // in it, and how long since new caption text actually arrived (#229/#187).
    this._healthInterval = setInterval(() => this._logHealth(), 5000);
  }

  _logHealth() {
    if (!this.isRunning) return;
    const container = document.querySelector('div[role="region"][aria-label="Captions"]');
    const nodes = container ? [...container.children].filter(c => c.querySelector('img')).length : -1;
    const ageMs = this._lastNewTurnsAt ? (Date.now() - this._lastNewTurnsAt) : null;
    const age = ageMs == null ? 'never' : ageMs + 'ms';
    console.log('[caption-health] on=' + (this._captionsOn ? 1 : 0) +
      ' region=' + (container ? 'yes' : 'NULL') + ' turnNodes=' + nodes + ' lastNewText=' + age);

    // #229/#187: captions ON, region present, turns existed — but no new text for
    // a long time = a STALL (the bot is deaf). The blocker is often a mid-call
    // modal we don't recognize (e.g. one without a [role=dialog]). Auto-capture
    // the screen so it self-documents: list every visible button label (the
    // modal's dismiss button will be in there) + dump any dialog-ish element.
    const STALL_MS = 25000;
    if (this._captionsOn && nodes > 0 && ageMs != null && ageMs > STALL_MS &&
        Date.now() - (this._lastStallDumpAt || 0) > 30000) {
      this._lastStallDumpAt = Date.now();
      try {
        const btns = [...document.querySelectorAll('button, [role="button"]')]
          .filter(isVisible)
          .map(b => ((b.textContent || '').trim() || b.getAttribute('aria-label') || '').slice(0, 40))
          .filter(Boolean);
        const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
          .map(d => (d.outerHTML || '').slice(0, 1500));
        console.warn('[caption-stall] no new captions for ' + Math.round(ageMs / 1000) +
          's while ON — likely a blocking overlay. Visible buttons: ' + JSON.stringify(btns));
        if (dialogs.length) console.warn('[caption-stall] dialog DOM:\n' + dialogs.join('\n---\n'));
      } catch { /* non-fatal */ }
    }
  }

  // Captions can be toggled OFF mid-call (user click, Meet layout change,
  // etc). Before this watcher that failed silently: the container query
  // below returned null forever and the bot went deaf while
  // `wait_for_speech` kept reporting "no one spoke" (real incident,
  // 2026-06-05, 24 minutes). Detect the flip, notify main, try to re-click.
  // TODO(#226): fold into a consolidated health tick.
  _checkCaptionsButton() {
    const on = !!document.querySelector('[aria-label="Turn off captions" i]')
      || !!findByAriaLabel('Turn off captions')
      || !!findByAriaLabel('Desactivar subtítulos');
    if (on !== this._captionsOn) {
      this._captionsOn = on;
      console.warn('[electron-meet] [CC] captions flipped', on ? 'ON' : 'OFF', 'mid-call');
      ipcRenderer.send('captions-state', { on });
    }
    if (!on) {
      // Self-heal at most once per 5s — a user deliberately keeping them
      // off shouldn't fight a tight loop.
      const now = Date.now();
      if (now - this._lastReenableAt > 5000) {
        this._lastReenableAt = now;
        this._enableCaptions();
      }
    }
  }

  _checkCaptions() {
    try {
      this._checkCaptionsButton();
      const container = document.querySelector('div[role="region"][aria-label="Captions"]');
      if (!container) return;

      // Snapshot every caption block currently in the DOM, in order. Each
      // child is one speaker turn. The bottommost may still be edited by
      // Meet; everything above it is settled (Meet doesn't revise non-current
      // speakers — confirmed empirically).
      //
      // Critical: determine bottommost based on the *DOM* state, then filter
      // out 'You' (the bot's own TTS, which we record separately via
      // addTranscript with the authoritative text). If we filtered before
      // checking bottommost, a Stan turn just above a "You" turn would look
      // bottommost to the server and stay unsettled forever.
      const allChildren = [...container.children].filter(c => c.querySelector('img'));
      const lastChild = allChildren[allChildren.length - 1] || null;
      const turns = [];
      for (const child of allChildren) {
        const span = child.querySelector('span');
        const speaker = span?.textContent?.trim() || 'unknown';
        let text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text.startsWith(speaker)) text = text.slice(speaker.length).trim();
        if (!text || speaker === 'You') continue;

        // Assign a stable turn id the first time we see this DOM node.
        let turnId = this._turnIdByChild.get(child);
        if (!turnId) {
          turnId = this._nextTurnId++;
          this._turnIdByChild.set(child, turnId);
        }
        turns.push({ turnId, speaker, text, isBottommost: child === lastChild });
      }

      if (turns.length === 0) return;

      // Dedup at the IPC boundary — no point firing on every poll if nothing
      // changed (the server-side updateTurns is idempotent, but skip the
      // serialization cost).
      const snapshot = turns.map(t => `${t.turnId}:${t.speaker}:${t.text}`).join('|');
      if (snapshot !== this._lastSentSnapshot) {
        this._lastSentSnapshot = snapshot;
        this._lastNewTurnsAt = Date.now(); // for [caption-health]
        ipcRenderer.send('caption-turns', { turns });
      }

      // Live-growing caption display on the panel uses the bottommost turn's
      // full accumulated text, which is what users expect to see (matches
      // Meet's own caption UI). Always send — the panel does its own dedup
      // on identical text.
      const last = turns[turns.length - 1];
      ipcRenderer.send('to-panel', {
        action: 'raw-caption',
        text: last.text,
        speaker: last.speaker,
      });
      ipcRenderer.send('to-panel', {
        action: 'caption-update',
        payload: { speaker: last.speaker, text: last.text, timestamp: Date.now(), source: 'captions' },
      });
    } catch (err) {
      console.error('[captions] poll error:', err);
    }
  }

  stop() {
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._healthInterval) clearInterval(this._healthInterval);
    this.isRunning = false;
  }
}

const captionScraper = new CaptionScraper();

// ---------------------------------------------------------------------------
// Page message listener — forward from page-inject.js to main process
// ---------------------------------------------------------------------------

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data?.__botsInCalls) return;

  if (event.data.action === 'dom-speaker-change') {
    const { name, speaking } = event.data.payload;
    if (name) ipcRenderer.send('update-speaking', { name, speaking });
  }

  if (event.data.action === 'tts-ended') {
    // After speaking, restore mic to its mode-appropriate state. Active mode
    // wants the mic open so the bot can be heard; passive/silent want it muted
    // so the user's mute click maps cleanly to mode. The current mode lives in
    // the main process, so we just ask main to decide.
    ipcRenderer.send('tts-ended');
  }

  if (event.data.action === 'log') {
    // Forward page-inject log lines to main so they land in the Electron
    // stdout stream alongside [local-server]/[electron] lines.
    if (event.data.payload?.line) {
      ipcRenderer.send('page-inject-log', event.data.payload.line);
    }
  }

  if (event.data.action === 'transcript') {
    const t = event.data.payload;
    if (t?.text && t?.speaker) {
      ipcRenderer.send('post-transcripts', [t]);
    }
  }
});

// ---------------------------------------------------------------------------
// Screen share — click "Present now" in Meet UI
// ---------------------------------------------------------------------------

async function clickPresentNow(shareType) {
  // Already presenting? Meet swaps "Present now" → "Stop presenting"/"Show", so
  // the present button vanishes. Without this check we'd report "Could not find
  // Present button" — which looks like an auth/permission failure when in fact
  // the share is already active (often with the infinity-mirror anti-loop
  // dialog showing). Detect it and tell the caller it's a no-op success.
  const alreadyPresenting =
    document.querySelector('[aria-label*="Stop presenting" i]') ||
    document.querySelector('[aria-label*="Stop sharing" i]') ||
    document.querySelector('[data-tooltip*="Stop presenting" i]') ||
    document.querySelector('[data-tooltip*="Stop sharing" i]');
  if (alreadyPresenting) {
    console.log('[electron-meet] Already presenting — skipping Present click');
    return 'already-presenting';
  }

  // Meet's "Present now" button — labels cycle through "Share screen" /
  // "Present now" (idle), "<name> is presenting" (someone else sharing),
  // or "You are presenting" (us). We can click the button in any of the
  // first two states; the "You are presenting" / Stop-presenting case
  // was handled by the alreadyPresenting check above. Pre-#226 selector
  // list missed the "<name> is presenting" case in some Meet builds
  // where the label moved from data-tooltip to aria-label, so the bot
  // reported "Could not find button" while the button was right there.
  // Wait for the present button to render. The Meet toolbar can appear a second
  // or two after admission, so a one-shot lookup loses the race when a share is
  // requested early (the automated test surfaced this: "Could not find Present
  // now" logged 1.5s BEFORE "In-call toolbar detected"). Poll up to 10s; also
  // re-check alreadyPresenting each tick in case it flips on mid-wait.
  let presentBtn = findPresentButton();
  if (!presentBtn) {
    const waitStart = Date.now();
    while (Date.now() - waitStart < 10_000) {
      await delay(300);
      if (document.querySelector('[aria-label*="Stop presenting" i], [aria-label*="Stop sharing" i], [data-tooltip*="Stop presenting" i], [data-tooltip*="Stop sharing" i]')) {
        console.log('[electron-meet] Became already-presenting while waiting for Present button');
        return 'already-presenting';
      }
      presentBtn = findPresentButton();
      if (presentBtn) {
        console.log('[electron-meet] Present button appeared after', Date.now() - waitStart, 'ms wait');
        break;
      }
    }
  }

  if (presentBtn) {
    const label = presentButtonText(presentBtn);
    console.log('[electron-meet] Present button found, label="' + label + '"');
    presentBtn.click();
    console.log('[electron-meet] Clicked Present button');

    // Wait for the share picker to appear, then select share type
    await delay(500);

    if (shareType === 'screen') {
      // Full screen share
      const entireScreen =
        findByText('Your entire screen') ||
        findByText('Entire screen');
      if (entireScreen) {
        entireScreen.click();
        console.log('[electron-meet] Selected "entire screen"');
      }
    } else {
      // Window share (for whiteboard)
      const windowOption =
        findByText('A window') ||
        findByText('Your entire screen') ||
        findByText('Entire screen');
      if (windowOption) {
        windowOption.click();
        console.log('[electron-meet] Selected window/screen share type');
      } else {
        console.log('[electron-meet] Share picker will trigger getDisplayMedia directly');
      }
    }
    return 'started';
  }

  console.warn('[electron-meet] Could not find "Present now" button');
  return 'not-found';
}

ipcRenderer.on('trigger-screen-share', async (_event, options) => {
  const shareType = options?.shareType || 'window';
  console.log('[electron-meet] Screen share triggered, type:', shareType);
  const result = await clickPresentNow(shareType);
  if (result === 'already-presenting') {
    // Not an error — the share is already active. Tell main so it can report a
    // truthful "already sharing" instead of a misleading "couldn't find button".
    ipcRenderer.send('self-presenting', { presenting: true });
  } else if (result === 'not-found') {
    ipcRenderer.send('screen-share-error', 'Could not find Present button');
  }

  // Watch for screen share error dialogs
  setTimeout(() => {
    const errorTexts = ["Can't share your screen", "Something went wrong when screen sharing"];
    const allText = document.body?.innerText || '';
    for (const errText of errorTexts) {
      if (allText.includes(errText)) {
        console.error('[electron-meet] Screen share error detected:', errText);
        ipcRenderer.send('screen-share-error', errText);
        // Try to dismiss the dialog
        const dismissBtn = document.querySelector('[aria-label="Close"], [aria-label="Dismiss"], [aria-label="Got it"]');
        if (dismissBtn) dismissBtn.click();
        break;
      }
    }
  }, 3000);
});

function findStopPresentingButton() {
  return document.querySelector('[aria-label*="Stop presenting" i]')
    || document.querySelector('[aria-label*="Stop sharing" i]')
    || document.querySelector('[data-tooltip*="Stop presenting" i]')
    || document.querySelector('[data-tooltip*="Stop sharing" i]');
}

// Robustly stop presenting (#174). A single click can miss: Meet's toolbar
// auto-hides and re-renders, so the Stop button often isn't in the DOM at the
// instant the agent calls stop_sharing — the old one-shot click then gave up
// and reported "stopped" while Meet was still presenting. Poll-click-verify for
// a few seconds against probePresentingState() (the same "You are presenting"
// ground truth status.sharing is derived from), retrying the click until Meet
// actually leaves the presenting state. For whiteboard shares onStopSharing has
// already closed the share window, so presenting usually ends on its own and we
// confirm on the first tick without needing a click.
ipcRenderer.on('trigger-stop-sharing', () => {
  console.log('[electron-meet] Stop sharing triggered');
  const startTime = Date.now();
  let clicks = 0;
  const poll = setInterval(() => {
    if (!probePresentingState().selfPresenting) {
      clearInterval(poll);
      console.log('[electron-meet] Stop sharing confirmed (not presenting) after',
        Date.now() - startTime, 'ms,', clicks, 'click(s)');
      ipcRenderer.send('screen-share-stopped');
      return;
    }
    const stopBtn = findStopPresentingButton();
    if (stopBtn) {
      stopBtn.click();
      clicks++;
      console.log('[electron-meet] Clicked stop sharing button (attempt', clicks + ')');
    }
    if (Date.now() - startTime > 4000) {
      clearInterval(poll);
      console.warn('[electron-meet] Stop sharing: still presenting after 4s and',
        clicks, 'click(s) — giving up; the agent will see status.sharing is still true');
      ipcRenderer.send('screen-share-stopped');
    }
  }, 300);
});

// ---------------------------------------------------------------------------
// In-call setup — idempotent, path-independent (#238)
// ---------------------------------------------------------------------------

// Everything that must happen once the bot is actually in the call: flip the
// app's callStatus to in-call (via the 'Participating' status), start the
// caption/speaker trackers + health tick, and kick off sync. Guarded so it runs
// exactly once per page load, and only when the in-call toolbar (Leave call) is
// actually present. Driven by BOTH the autoJoin success path AND a standalone
// watcher (installInCallWatcher) — so we recover cleanly no matter how we got
// in: normal admission, or manual recovery after a spurious "You can't join
// this video call" page that made autoJoin bail. Before this, a manual recovery
// left Meet in the call but the app stuck at not-joined (no trackers, no sync).
let inCallSetupDone = false;
let inCallWatcher = null;
function enterInCallState() {
  if (inCallSetupDone) return;
  const leaveBtn = findByAriaLabel('Leave call') ||
    document.querySelector('[data-tooltip="Leave call"]');
  if (!leaveBtn) return; // not actually in the call yet
  inCallSetupDone = true;
  if (inCallWatcher) { clearInterval(inCallWatcher); inCallWatcher = null; }
  console.log('[electron-meet] In-call toolbar detected — entering in-call state');

  // Flips the app's callStatus → in-call (main maps 'Participating' → in-call).
  sendStatus('Participating in Meet');

  // Captions: the toolbar's "Leave call" often renders before the captions
  // button, so a one-shot click misses; clickCaptionsWhenReady retries.
  clickCaptionsWhenReady();
  captionScraper.onReady = () => {
    console.log('[electron-meet] Captions ready');
    ipcRenderer.send('captions-ready');
  };
  captionScraper.start();
  domSpeakerTracker.start();
  startMicMuteWatcher();
  installCallHealthTick();

  // Start sync + announce arrival.
  const meetCode = window.location.pathname.replace('/', '');
  if (meetCode) {
    ipcRenderer.send('start-sync', { meetCode, botName: BOT_NAME });
    ipcRenderer.send('bot-joined-call', { meetCode, botName: BOT_NAME });
  }
}

// Standalone safety net: poll for the in-call toolbar and run setup the moment
// it appears, regardless of how we entered. Catches manual recovery from the
// spurious denial page (where autoJoin already returned). No-ops once setup is
// done (enterInCallState clears the interval).
function installInCallWatcher() {
  if (inCallWatcher) return;
  inCallWatcher = setInterval(() => {
    if (inCallSetupDone) { clearInterval(inCallWatcher); inCallWatcher = null; return; }
    enterInCallState();
  }, 1500);
}

// ---------------------------------------------------------------------------
// Auto-start after DOM loads
// ---------------------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  // ALWAYS show the bot-view banner first — on a Meet call, the Meet home, OR a
  // Google sign-in page (logged out, meet.google.com redirects to accounts.
  // google.com). Its whole job is to mark this as the bot's browser view,
  // independent of login state. ensureStatusBar is idempotent; the in-call path
  // refines the text later. Set text directly (not sendStatus, which would ping
  // main with a status update).
  try {
    ensureStatusBar();
    const el = document.getElementById('vibeconf-status');
    if (el) {
      const href = window.location.href;
      el.textContent = /accounts\.google\.com|ServiceLogin|signin/i.test(href)
        ? "Bot's view — sign the bot in to Google here"
        : /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(window.location.pathname)
          ? "Bot's view of Google Meet"
          : "Bot's view — Google Meet home (not in a call)";
    }
  } catch { /* body not ready */ }

  // Only run Meet automation on actual Meet pages
  if (!window.location.href.includes('meet.google.com')) {
    console.log('[electron-meet] Not a Meet page (banner shown), skipping automation');
    return;
  }
  // Run join automation ONLY on a meeting-code URL. We now load Meet home
  // (meet.google.com/) as the idle view so the operator can sign in / start
  // meetings / debug manually — the join poll must not fire there (or on /new,
  // /landing, etc.), only when actually navigated into a meeting code.
  if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(window.location.pathname)) {
    console.log('[electron-meet] Meet home/landing (no meeting code) — skipping join automation');
    return;
  }

  // Watch for pre-join screen
  (async () => {
    sendStatus('Loading Meet...');

    // Make sure the config-loaded botName has had a chance to land before we
    // type into Meet's name field. Without this await the IPC roundtrip can
    // lose to Meet's pre-join render and we'd type the default 'Jimmy'.
    await botNameLoaded;

    // Standalone safety net runs the whole time, so even if autoJoin bails on a
    // spurious "You can't join" page and the operator manually recovers, the
    // moment the in-call toolbar appears we set up trackers + sync + status
    // (#238). enterInCallState is idempotent, so the normal path below and this
    // watcher converge without double-setup.
    installInCallWatcher();

    for (let i = 0; i < 30; i++) {
      const nameInput =
        document.querySelector('input[placeholder="Your name"]') ||
        document.querySelector('input[aria-label="Your name"]') ||
        document.querySelector('input[autocomplete="name"]');
      const joinBtn = findByText('Ask to join') || findByText('Join now');

      if (nameInput || joinBtn) {
        await autoJoin(BOT_NAME);
        break;
      }
      await delay(1000);
    }

    // Normal path: if admission succeeded, set up now (don't wait up to 1.5s for
    // the watcher tick). No-ops if the watcher already ran it, or if we're not
    // actually in the call yet (the watcher will catch it later).
    enterInCallState();
  })();
});
