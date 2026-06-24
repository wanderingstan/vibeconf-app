// slack-provider.js — SlackProvider: a first-pass CallProvider implementation
// for Slack huddles. The Slack analog of google-meet-provider.js.
//
// Scope of THIS pass: the DOM-manipulation primitives for everything covered by
// the #264 recon (Stan, 2026-06-24) — camera, screen share, leave, enable
// captions, scrape the attributed transcript, enumerate participants, and read
// the per-tile speaking signal. It runs against the huddle POPUP DOM (the
// surface that renders the call UI).
//
// Implemented (DOM): camera, screen share, mic mute/unmute, leave, enable
// captions, scrape captions, read/send chat (Thread tab), participants, speaking.
//
// NOT wired yet (deliberate — after the two-surface Electron plumbing lands):
//   • IPC / CALL_EVENTS emit + the command handlers (cf. Meet steps 3–4)
//   • join(): how to start/join a huddle isn't in the recon yet
//   • speak(): TTS/media goes through the MAIN app.slack.com window — Stan
//     confirmed (2026-06-24) the main window owns getUserMedia/RTCPeerConnection
//     (it shows the OS mic/cam in-use indicators), so the media patch injects
//     there, not in this popup (#264 two-surface).
//   • the main.js surface-topology seam (setWindowOpenHandler for the popup)
// Search this file for "RECON NEEDED" / "TWO-SURFACE".
//
// Pure-ish: requires only the contract + selectors. Browser globals (document,
// window, KeyboardEvent) resolve at run time in the popup (contextIsolation:false).

const { CallProvider } = require('./call-provider');
const { SLACK } = require('./slack-selectors');

// ---------------------------------------------------------------------------
// Small DOM helpers (mirrors google-meet-provider's style, trimmed).
// ---------------------------------------------------------------------------
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isVisible(el) {
  if (!el) return false;
  if (el.offsetParent === null && el !== document.documentElement) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return window.getComputedStyle(el).visibility !== 'hidden';
}

// Poll for fn() to return a truthy value, up to `ms`.
async function waitFor(fn, ms = 5000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = fn(); if (v) return v; } catch { /* keep polling */ }
    await delay(step);
  }
  return null;
}

// First visible menu item whose text contains `text` (case-insensitive).
function findMenuItemByText(text) {
  const lower = text.toLowerCase();
  for (const el of document.querySelectorAll(SLACK.menu.item)) {
    if (isVisible(el) && (el.textContent || '').trim().toLowerCase().includes(lower)) return el;
  }
  return null;
}

class SlackProvider extends CallProvider {
  static get id() { return 'slack'; }

  // --- Camera --------------------------------------------------------------
  isCameraOn() {
    const b = document.querySelector(SLACK.camera.button);
    if (!b) return false;
    // Prefer the language-independent inner data-qa icon; fall back to the
    // (localized) aria-label only if neither icon is present.
    if (b.querySelector(SLACK.camera.iconOn)) return true;
    if (b.querySelector(SLACK.camera.iconOff)) return false;
    return b.getAttribute('aria-label') === SLACK.camera.labelOn;
  }
  async setCameraOn(on) {
    const b = document.querySelector(SLACK.camera.button);
    if (!b) { console.warn('[slack] camera button not found'); return false; }
    if (this.isCameraOn() !== !!on) { b.click(); console.log('[slack] camera', on ? 'on' : 'off'); }
    return true;
  }

  // --- Screen share --------------------------------------------------------
  isSharing() {
    const b = document.querySelector(SLACK.screenShare.button);
    return !!b && b.getAttribute(SLACK.screenShare.pressedAttr) === 'true';
  }
  // shareType is accepted for contract parity; Slack's button is a single
  // toggle (the source picker is handled by the getDisplayMedia patch).
  async startShare(/* shareType */) {
    const b = document.querySelector(SLACK.screenShare.button);
    if (!b) { console.warn('[slack] screenshare button not found'); return false; }
    if (!this.isSharing()) { b.click(); console.log('[slack] started screen share'); }
    return true;
  }
  async stopShare() {
    const b = document.querySelector(SLACK.screenShare.button);
    if (!b) { console.warn('[slack] screenshare button not found'); return false; }
    if (this.isSharing()) { b.click(); console.log('[slack] stopped screen share'); }
    return true;
  }

  // --- Microphone ----------------------------------------------------------
  // State reads off the aria-label (no aria-pressed; the toggled-on class is a
  // rotating hash). "Unmute microphone" is shown WHILE MUTED. Language-bound —
  // a language-independent muted-icon data-qa would be better if recon finds one.
  isMicMuted() {
    const b = document.querySelector(SLACK.mic.button);
    return !!b && b.getAttribute('aria-label') === SLACK.mic.labelUnmute;
  }
  setMicMuted(mute) {
    const b = document.querySelector(SLACK.mic.button);
    if (!b) { console.warn('[slack] mic button not found'); return false; }
    if (this.isMicMuted() !== !!mute) { b.click(); console.log('[slack] mic', mute ? 'muted' : 'unmuted'); }
    return true;
  }

  // --- Leave ---------------------------------------------------------------
  async leave() {
    const b = document.querySelector(SLACK.leave.button);
    if (b) { b.click(); console.log('[slack] left huddle (button)'); return true; }
    // Fallback: Option+Shift+H.
    const k = SLACK.leave.key;
    document.dispatchEvent(new KeyboardEvent('keydown', { ...k, bubbles: true, cancelable: true }));
    console.log('[slack] left huddle (keyboard fallback)');
    return true;
  }

  // --- Captions ------------------------------------------------------------
  // More actions (⋯) → "Show captions" submenu → "Side-by-side". Best-effort:
  // the submenu may need a hover to expand, so we click AND dispatch mouseover.
  async enableCaptions() {
    if (this.captionsOn()) { console.log('[slack] [CC] captions panel already present'); return true; }
    const more = document.querySelector(SLACK.moreActions.button);
    if (!more) { console.warn('[slack] [CC] "More actions" button not found'); return false; }
    more.click();
    console.log('[slack] [CC] clicked More actions');

    const show = await waitFor(() => findMenuItemByText(SLACK.captions.showCaptionsItemText));
    if (!show) { console.warn('[slack] [CC] "Show captions" not found'); return false; }
    show.click(); // enables captions (overlay) AND reveals the mode submenu
    console.log('[slack] [CC] clicked "Show captions"');

    // "Side-by-side" (a menuitemcheckbox) switches caption mode. Wait for it to
    // be present AND visible, then drive a full click sequence — a bare .click()
    // didn't register on it.
    const sbs = await waitFor(() => {
      const el = document.querySelector(SLACK.captions.sideBySideButton)
        || findMenuItemByText(SLACK.captions.sideBySideLabelPrefix);
      return el && isVisible(el) ? el : null;
    }, 4000);
    if (!sbs) { console.warn('[slack] [CC] "Side-by-side" not found/visible'); return false; }
    if (sbs.getAttribute('aria-checked') === 'true') { console.log('[slack] [CC] side-by-side already active'); return true; }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      sbs.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    console.log('[slack] [CC] clicked "Side-by-side" — aria-checked now:', sbs.getAttribute('aria-checked'));
    return true;
  }

  captionsOn() { return !!document.querySelector(SLACK.captions.panel); }

  // Snapshot the attributed transcript: [{ speaker, text }] in DOM order.
  scrapeCaptions() {
    const panel = document.querySelector(SLACK.captions.panel);
    const root = panel || document; // TWO-SURFACE: side-by-side may pop a window
    const out = [];
    for (const ev of root.querySelectorAll(SLACK.captions.eventContent)) {
      const speaker = (ev.querySelector(SLACK.captions.speakerName)?.textContent || '').trim();
      const text = (ev.querySelector(SLACK.captions.transcription)?.textContent || '').trim();
      if (text) out.push({ speaker: speaker || 'unknown', text });
    }
    return out;
  }
  async readCaptions() { return this.scrapeCaptions(); }

  // --- Side-panel tabs -----------------------------------------------------
  async switchToCaptionsTab() {
    const t = document.querySelector(SLACK.tabs.captions);
    if (t) { t.click(); return true; }
    return false;
  }
  async switchToThreadTab() {
    const t = document.querySelector(SLACK.tabs.thread);
    if (t) { t.click(); return true; }
    return false;
  }

  // --- Chat (the "Thread" tab) ---------------------------------------------
  // Scrape messages in DOM order. Sender info is on the first message of a run
  // only, so carry it forward; dedup by the row's stable data-msg-ts.
  scrapeChatMessages() {
    const panel = document.querySelector(SLACK.chat.threadPanel) || document;
    const out = [];
    const seen = new Set();
    let sender = '';
    let senderId = null;
    for (const row of panel.querySelectorAll(SLACK.chat.messageContainer)) {
      const btn = row.querySelector(SLACK.chat.senderNameButton);
      if (btn) {
        sender = (btn.textContent || '').trim() || sender;
        senderId = btn.getAttribute(SLACK.chat.senderIdAttr) || senderId;
      }
      const id = row.getAttribute(SLACK.chat.msgTsAttr);
      if (!id || seen.has(id)) continue;
      const text = (row.querySelector(SLACK.chat.messageText)?.textContent || '').trim();
      if (!text) continue;
      seen.add(id);
      out.push({ id, sender: sender || 'unknown', senderId, text });
    }
    return out;
  }

  async readChat() {
    await this.switchToThreadTab();
    await delay(300); // let the thread render
    return this.scrapeChatMessages();
  }

  async sendChat(text) {
    await this.switchToThreadTab();
    await delay(200);
    const editor = document.querySelector(SLACK.chat.editor);
    if (!editor) { console.warn('[slack] chat editor not found'); return false; }
    await this._typeIntoQuill(editor, text);
    await delay(100);
    // Prefer the real send button (enabled once there's text); fall back to Enter.
    const send = document.querySelector(SLACK.chat.sendButton);
    if (send && send.getAttribute(SLACK.chat.sendDisabledAttr) !== 'true') {
      send.click();
    } else {
      const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent('keydown', enter));
      editor.dispatchEvent(new KeyboardEvent('keyup', enter));
    }
    await delay(200);
    return true; // best-effort; send-confirmation check is a TODO (verify live)
  }

  // Inject text into Slack's Quill (ql-editor) contenteditable. execCommand
  // insertText is the most reliable path (Quill listens to beforeinput/input);
  // fall back to dispatching the input events directly. Quill is finicky — this
  // is best-effort until verified in a live huddle.
  async _typeIntoQuill(editor, text) {
    editor.focus();
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel.addRange(range);
    } catch { /* selection not available */ }
    const ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!ok) {
      editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
      editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
    }
  }

  // --- Roster + speaking ---------------------------------------------------
  // Both come straight off the participant tiles (#264): name from the tile
  // aria-label, a stable userId from data-qa, self from the gridcell id, and
  // speaking from a per-tile overlay that exists only while talking.
  getParticipants() {
    const out = [];
    for (const tile of document.querySelectorAll(SLACK.participants.tile)) {
      const name = SLACK.participantName(tile.getAttribute('aria-label')) || 'unknown';
      const dq = tile.getAttribute('data-qa') || '';
      const userId = (dq.match(SLACK.participants.userIdRe) || [])[1] || null;
      const isSelf = (tile.getAttribute('id') || '').includes(SLACK.participants.selfIdMarker);
      const speaking = !!tile.querySelector(SLACK.participants.speakingOverlay);
      out.push({ name, userId, isSelf, speaking });
    }
    return out;
  }
  getSpeakingNames() {
    return this.getParticipants().filter((p) => p.speaking && !p.isSelf).map((p) => p.name);
  }

  // --- Not yet implemented (see header) ------------------------------------
  // TWO-SURFACE: join runs in the MAIN app.slack.com window — the channel-header
  // "Huddle" button lives there, not in the huddle popup this provider mostly
  // targets. The caller navigates the main window to /client/<team>/<channel>
  // first (SLACK.buildClientUrl); join() clicks the button, which STARTS a new
  // huddle or JOINS the active one. The popup then opens and the rest of this
  // provider takes over. Huddle-active detection = the POPUP window TITLE
  // ("Huddle: …"), read in-process main-side via SLACK.isHuddleWindowTitle.
  async join(/* channel already navigated by caller */) {
    const btn = document.querySelector(SLACK.huddle.startButton);
    if (btn) { btn.click(); console.log('[slack] channel-header Huddle clicked (opens lobby)'); return true; }
    const k = SLACK.huddle.startKey; // fallback: Cmd+Option+Shift+H
    document.dispatchEvent(new KeyboardEvent('keydown', { ...k, bubbles: true, cancelable: true }));
    console.log('[slack] start/join huddle via keyboard fallback');
    return true;
  }

  // Step 2 of joining: the lobby/preview popup ("Slack - Huddle Preview") shows a
  // camera/mic preview; click "Start Huddle" to actually enter. Runs in the
  // POPUP (where this provider lives), unlike join() which is the main window.
  // After this, the popup title flips to "Huddle: …" and the huddle UI mounts.
  async confirmJoin() {
    const btn = document.querySelector(SLACK.huddle.lobbyStartButton);
    if (!btn) { console.warn('[slack] lobby "Start Huddle" button not found'); return false; }
    btn.click();
    console.log('[slack] clicked lobby "Start Huddle" — entering huddle');
    return true;
  }
  speak(/* payload */) {
    // TWO-SURFACE: TTS audio rides the MAIN app.slack.com window's media patch,
    // not this popup. Wired when the two-surface injection lands.
    console.warn('[slack] speak: media path lives in the main window (two-surface, not wired)');
  }
  async recoverCaptions() { return this.notImplemented('recoverCaptions'); }
  async setStudioSound(/* enabled */) {
    // No Slack analog of Meet's "Studio sound" voice filter — no-op.
    return true;
  }
}

module.exports = { SlackProvider };
