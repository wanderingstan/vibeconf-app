// teams-provider.js — TeamsProvider: a first-pass CallProvider for the
// Microsoft Teams web client. The Teams analog of zoom-provider.js.
//
// Built from live recon (2026-10-15, personal-account meeting, guest join);
// selectors live in teams-selectors.js. Like Zoom, Teams is a SINGLE surface:
// the meeting renders top-level, so this provider and page-inject (virtual
// mic/camera, TTS) share one page — see preload-teams.js.
//
// Verified from recon: launcher, pre-join, lobby, toolbar ids, captions (a
// persistent list that names each speaker), chat compose/send, leave.
// Unverified until the Electron bot runs it: mic/camera on/off state labels,
// screen share, the speaking outline.
//
// Pure-ish: requires only the contract + selectors. Browser globals resolve at
// run time in the page (contextIsolation:false).

const { CallProvider } = require('./call-provider');
const { TEAMS } = require('./teams-selectors');

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => norm(s).toLowerCase();

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return window.getComputedStyle(el).visibility !== 'hidden';
}

async function waitFor(fn, ms = 5000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = fn(); if (v) return v; } catch { /* keep polling */ }
    await delay(step);
  }
  return null;
}

const $ = (sel) => document.querySelector(sel);

// Teams' toolbar toggles report state with aria-pressed / aria-checked when
// they have it; null when the attribute is absent.
function pressed(el) {
  if (!el) return null;
  const v = el.getAttribute('aria-pressed') ?? el.getAttribute('aria-checked');
  return v == null ? null : v === 'true';
}

class TeamsProvider extends CallProvider {
  static get id() { return 'teams'; }

  inMeeting() { return !!$(TEAMS.inMeetingMarker); }
  inLobby() {
    const body = lower(document.body && document.body.innerText);
    return TEAMS.lobby.texts.some((t) => body.includes(t));
  }
  hasLeft() {
    const body = lower(document.body && document.body.innerText);
    return !this.inMeeting() && TEAMS.leftTexts.some((t) => body.includes(t));
  }

  // --- Join ----------------------------------------------------------------
  // The invite lands on a launcher; take "Continue on this browser".
  clickJoinOnWeb() {
    const b = $(TEAMS.launcher.joinOnWeb);
    if (!b) return false;
    b.click();
    console.log('[teams] launcher: continue on this browser');
    return true;
  }

  // Guest pre-join: type the name (Join stays disabled without one), make sure
  // computer audio is selected, click Join now.
  async fillPrejoin(botName) {
    const input = $(TEAMS.prejoin.nameInput);
    if (!input || !isVisible(input)) return false;
    if (botName && input.value !== botName) {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      if (setter) setter.call(input, botName); else input.value = botName;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const radio = $(TEAMS.prejoin.computerAudioRadio);
    if (radio && !radio.checked) radio.click();
    const join = await waitFor(() => { const b = $(TEAMS.prejoin.joinButton); return b && !b.disabled ? b : null; }, 3000);
    if (!join) { console.warn('[teams] pre-join: Join now stayed disabled (name not accepted?)'); return false; }
    join.click();
    console.log('[teams] pre-join: joined as', JSON.stringify(botName));
    return true;
  }

  // --- Microphone / camera -------------------------------------------------
  // State attribute on the toolbar buttons is TBD (recon had no devices); log
  // what's there on first use so the next pass can pin it down.
  isMicMuted() {
    const b = $(TEAMS.toolbar.mic);
    const label = lower(b && b.getAttribute('aria-label'));
    if (label === TEAMS.micLabelUnmute) return true;
    if (label === TEAMS.micLabelMute) return false;
    const p = pressed(b);
    return p == null ? null : !p;
  }
  setMicMuted(mute) {
    const b = $(TEAMS.toolbar.mic);
    if (!b) { console.warn('[teams] mic button not found'); return false; }
    const muted = this.isMicMuted();
    if (muted === null) {
      console.warn('[teams] mic state unknown (aria:', JSON.stringify(b.getAttribute('aria-label')), ') — not toggling');
      return false;
    }
    if (muted !== !!mute) { b.click(); console.log('[teams] mic', mute ? 'muted' : 'unmuted'); }
    return true;
  }
  isCameraOn() { return pressed($(TEAMS.toolbar.camera)); }
  async setCameraOn(on) {
    const b = $(TEAMS.toolbar.camera);
    if (!b) { console.warn('[teams] camera button not found'); return false; }
    const cur = this.isCameraOn();
    if (cur === null) {
      console.warn('[teams] camera state unknown (aria:', JSON.stringify(b.getAttribute('aria-label')), ') — not toggling');
      return false;
    }
    if (cur !== !!on) { b.click(); console.log('[teams] camera', on ? 'on' : 'off'); }
    return true;
  }

  // --- Leave ---------------------------------------------------------------
  async leave() {
    const b = $(TEAMS.toolbar.leave);
    if (!b) { console.warn('[teams] leave button not found'); return false; }
    b.click();
    console.log('[teams] left meeting');
    return true;
  }

  // --- Captions ------------------------------------------------------------
  captionsOn() { return !!$(TEAMS.captions.window); }
  async enableCaptions() {
    if (this.captionsOn()) return true;
    const more = $(TEAMS.toolbar.more);
    if (!more) { console.warn('[teams] [CC] More button not found'); return false; }
    more.click();
    const cc = await waitFor(() => $(TEAMS.more.captions), 3000);
    if (!cc) { console.warn('[teams] [CC] Captions item not found'); return false; }
    cc.click();
    const ok = !!(await waitFor(() => this.captionsOn(), 3000));
    console.log('[teams] [CC] captions', ok ? 'on' : 'did not appear');
    return ok;
  }
  async recoverCaptions() { return this.enableCaptions(); }

  // Visible caption entries, in order: [{ speaker, text }]. The list is
  // virtualized, so only rendered entries; each groups one author + one text.
  scrapeCaptions() {
    const list = $(TEAMS.captions.list);
    if (!list) return [];
    const out = [];
    for (const t of list.querySelectorAll(TEAMS.captions.text)) {
      let g = t;
      for (let i = 0; g && i < 4 && !g.querySelector(TEAMS.captions.author); i++) g = g.parentElement;
      const a = g && g.querySelector(TEAMS.captions.author);
      const text = norm(t.textContent);
      if (text) out.push({ speaker: norm(a && a.textContent) || 'unknown', text });
    }
    return out;
  }
  async readCaptions() { return this.scrapeCaptions(); }

  // --- Chat ----------------------------------------------------------------
  async _ensureChatOpen() {
    if ($(TEAMS.chat.editor)) return true;
    // The toolbar can still be rendering right after admission.
    const t = await waitFor(() => $(TEAMS.toolbar.chat), 5000);
    if (!t) { console.warn('[teams] chat button not found'); return false; }
    t.click();
    return !!(await waitFor(() => $(TEAMS.chat.editor), 4000));
  }

  scrapeChatMessages() {
    const out = [];
    let sender = '';
    for (const item of document.querySelectorAll(TEAMS.chat.item)) {
      const a = item.querySelector(TEAMS.chat.author);
      if (a) sender = norm(a.textContent) || sender;
      const m = item.querySelector(TEAMS.chat.message);
      const text = norm(m && m.textContent);
      if (!text) continue;
      const id = item.id || (m && m.id) || (sender + '::' + text);
      out.push({ id, sender: sender || 'unknown', text });
    }
    return out;
  }

  async readChat() {
    if (!(await this._ensureChatOpen())) return [];
    await delay(200);
    return this.scrapeChatMessages();
  }

  // Put `text` into Teams' CKEditor 5 composer. CKEditor keeps its own model;
  // DOM-level writes it doesn't see leave Send disabled (live, 2026-10-15:
  // the first attempt sent nothing). Try, in order: the editor instance CKEditor
  // hangs on its element, a native beforeinput (what CKEditor 5 listens to),
  // then execCommand. Returns which one took, or null.
  _insertIntoEditor(editor, text) {
    const took = () => norm(editor.textContent).includes(norm(text).slice(0, 20));
    editor.focus();
    const inst = editor.ckeditorInstance;
    if (inst && inst.model) {
      try {
        inst.model.change((writer) => writer.insertText(text, inst.model.document.selection.getFirstPosition()));
        if (took()) return 'ckeditorInstance';
      } catch (e) { console.warn('[teams] chat: ckeditorInstance insert failed:', e.message); }
    }
    try {
      editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
      if (took()) return 'beforeinput';
    } catch { /* fall through */ }
    try { document.execCommand('insertText', false, text); } catch { /* fall through */ }
    return took() ? 'execCommand' : null;
  }

  async sendChat(text) {
    if (!(await this._ensureChatOpen())) return false;
    const editor = $(TEAMS.chat.editor);
    const before = this.scrapeChatMessages().length;
    const how = this._insertIntoEditor(editor, text);
    if (!how) { console.warn('[teams] chat: could not get text into the composer'); return false; }
    const send = await waitFor(() => { const b = $(TEAMS.chat.sendButton); return b && !b.disabled ? b : null; }, 2000);
    if (send) send.click();
    else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    // Sent = it shows up in the list, not "the composer is empty" (which is also
    // what a failed insert looks like).
    const shown = await waitFor(() => this.scrapeChatMessages().length > before, 4000);
    console.log('[teams] chat send via', how, send ? '(Send button)' : '(Enter)', shown ? '→ in the list' : '→ NOT seen in the list');
    return !!shown;
  }

  // --- Screen share --------------------------------------------------------
  // One toolbar button, whose aria-label flips "Share" ↔ "Stop sharing"
  // (verified 2026-10-15). Clicking Share calls getDisplayMedia directly (no
  // picker menu), so a repeat click while sharing STOPS the share: the app's
  // Present-now retries toggled it off and on before this read the state.
  isSharing() {
    return lower($(TEAMS.toolbar.share) && $(TEAMS.toolbar.share).getAttribute('aria-label')) === TEAMS.shareLabelStop;
  }
  async startShare(/* shareType */) {
    if (this.isSharing()) { console.log('[teams] already sharing'); return true; }
    const b = $(TEAMS.toolbar.share);
    if (!b) { console.warn('[teams] share button not found'); return false; }
    b.click();
    console.log('[teams] clicked Share');
    return true;
  }
  async stopShare() {
    if (!this.isSharing()) { console.log('[teams] stopShare: not sharing'); return true; }
    $(TEAMS.toolbar.share).click();
    console.log('[teams] clicked Stop sharing');
    return true;
  }

  // Every screen share on the stage: [{ name, id }], the presenter named by the
  // share stream's own data-tid. Includes the bot's own share if Teams renders
  // one for it; callers split self from others by name.
  screenShares() {
    const out = [];
    for (const el of document.querySelectorAll(TEAMS.stage.screenShare)) {
      const name = norm(el.getAttribute('data-tid'));
      if (name && !out.some((s) => s.name === name)) out.push({ name, id: name });
    }
    return out;
  }

  // --- Roster (from stage tiles; the People pane is TBD) -------------------
  getParticipants() {
    const out = [];
    for (const el of document.querySelectorAll('[data-tid^="' + TEAMS.stage.tileByNamePrefix + '"]')) {
      const name = el.getAttribute('data-tid').slice(TEAMS.stage.tileByNamePrefix.length);
      // speaking: false, NOT "the voice-level outline exists": that element is on
      // every tile all the time, so it read as everyone always talking and the
      // bot yielded forever without saying a word (live, 2026-10-15). The real
      // per-tile signal is TBD; captions carry the turn-taking until then.
      if (name) out.push({ name, speaking: false, isSelf: name === this.selfName });
    }
    return out;
  }

  async setStudioSound(/* enabled */) { return true; }
  async setCaptionLanguage(/* language */) {
    return { ok: false, error: 'Caption language is not wired for Teams yet' };
  }
  speak(/* payload */) { /* TTS rides page-inject's virtual mic (preload-teams) */ }
}

module.exports = { TeamsProvider };
