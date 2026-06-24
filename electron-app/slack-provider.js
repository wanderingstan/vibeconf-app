// slack-provider.js — SlackProvider: a first-pass CallProvider implementation
// for Slack huddles. The Slack analog of google-meet-provider.js.
//
// Scope of THIS pass: the DOM-manipulation primitives for everything covered by
// the #264 recon (Stan, 2026-06-24) — camera, screen share, leave, enable
// captions, scrape the attributed transcript, enumerate participants, and read
// the per-tile speaking signal. It runs against the huddle POPUP DOM (the
// surface that renders the call UI).
//
// NOT wired yet (deliberate — these come after the recon gaps close and the
// two-surface Electron plumbing lands):
//   • IPC / CALL_EVENTS emit + the command handlers (cf. Meet steps 3–4)
//   • join(): how to start/join a huddle isn't in the recon yet
//   • setMicMuted(): no mic-toggle button was captured — selector needed
//   • speak(): TTS/media goes through the MAIN app.slack.com window's
//     getUserMedia/RTCPeerConnection patch, not this popup (#264 two-surface)
//   • readChat()/sendChat(): the "Thread" tab's message DOM wasn't collected
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
    const more = document.querySelector(SLACK.moreActions.button);
    if (!more) { console.warn('[slack] [CC] "More actions" button not found'); return false; }
    more.click();

    const show = await waitFor(() => findMenuItemByText(SLACK.captions.showCaptionsItemText));
    if (!show) { console.warn('[slack] [CC] "Show captions" item not found'); return false; }
    show.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    show.click();

    const sbs = await waitFor(() =>
      document.querySelector(SLACK.captions.sideBySideButton) ||
      findMenuItemByText(SLACK.captions.sideBySideLabelPrefix));
    if (!sbs) { console.warn('[slack] [CC] "Side-by-side" option not found'); return false; }
    sbs.click();
    console.log('[slack] [CC] enabled side-by-side captions');
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
  async join(/* botName */) {
    // RECON NEEDED: how a bot starts/joins a huddle from app.slack.com.
    return this.notImplemented('join');
  }
  setMicMuted(/* muted */) {
    // RECON NEEDED: the mic-toggle button DOM wasn't captured.
    console.warn('[slack] setMicMuted: no mic-button selector yet (recon needed)');
    return false;
  }
  speak(/* payload */) {
    // TWO-SURFACE: TTS audio rides the MAIN app.slack.com window's media patch,
    // not this popup. Wired when the two-surface injection lands.
    console.warn('[slack] speak: media path lives in the main window (two-surface, not wired)');
  }
  async recoverCaptions() { return this.notImplemented('recoverCaptions'); }
  async readChat() { return this.notImplemented('readChat'); }   // RECON NEEDED: Thread tab DOM
  async sendChat(/* text */) { return this.notImplemented('sendChat'); }
  async setStudioSound(/* enabled */) { return this.notImplemented('setStudioSound'); }
}

module.exports = { SlackProvider };
