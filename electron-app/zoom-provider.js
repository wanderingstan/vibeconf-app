// zoom-provider.js — ZoomProvider: a first-pass CallProvider for the Zoom web
// client (app.zoom.us). The Zoom analog of slack-provider.js (#318).
//
// Built from the solo recon in zoom-selectors.js (Stan + Claude, 2026-07-05).
// Unlike Slack, Zoom is a SINGLE surface like Meet: the bot loads the direct
// /wc/join/<n> URL, which renders the meeting top-level, so this provider and the
// media patch (page-inject.js) live in the same page. See preload-zoom.js.
//
// Implemented (DOM, from verified selectors): mic mute/unmute, camera, leave,
// read/send chat, participants, start share, enable captions.
//
// Best-effort (selectors marked TBD in zoom-selectors.js, unverified): the guest
// pre-join page, the waiting room, "Join Audio by Computer", stop share, the
// camera-ON label.
//
// Captions (v1, per Stan's decision on #318): the ONLY transcript source is the
// host-enabled "Full transcript" side panel. Its selectors are unknown until a
// call with the panel open is harvested, so transcriptAvailable() is false for
// now and the bot runs without hearing: it joins, speaks and chats. The overlay
// (captions.subtitle*) is deliberately NOT scraped; that is a possible v2.
//
// Pure-ish: requires only the contract + selectors. Browser globals resolve at
// run time in the page (contextIsolation:false).

const { CallProvider } = require('./call-provider');
const { ZOOM } = require('./zoom-selectors');

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The document the meeting UI lives in. Direct /wc/ URLs render top-level; the
// PWA shell nests it in a same-origin #webclient iframe. Support both.
function meetingDoc() {
  try {
    const f = document.querySelector(ZOOM.iframe);
    if (f && f.contentDocument && f.contentDocument.body) return f.contentDocument;
  } catch { /* cross-origin or not loaded */ }
  return document;
}

function isVisible(el) {
  if (!el) return false;
  const win = el.ownerDocument.defaultView || window;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return win.getComputedStyle(el).visibility !== 'hidden';
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => norm(s).toLowerCase();

async function waitFor(fn, ms = 5000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = fn(); if (v) return v; } catch { /* keep polling */ }
    await delay(step);
  }
  return null;
}

// First element matching `selector` whose visible text equals (or, with
// {contains:true}, contains) `text`, case-insensitive.
function findByText(doc, selector, text, { contains = false, visibleOnly = true } = {}) {
  const want = lower(text);
  for (const el of doc.querySelectorAll(selector)) {
    if (visibleOnly && !isVisible(el)) continue;
    const t = lower(el.textContent);
    if (contains ? t.includes(want) : t === want) return el;
  }
  return null;
}

// The Zoom user a caption row belongs to, from React's props: a few fibers up
// from the caption <span>, a component receives messageItem.user. Internal, so
// it can vanish in any Zoom release; callers fall back to the avatar match.
function captionUser(el) {
  try {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let f = key && el[key];
    for (let i = 0; f && i < 6; i++, f = f.return) {
      const user = f.memoizedProps && f.memoizedProps.messageItem && f.memoizedProps.messageItem.user;
      if (user) return user;
    }
  } catch { /* fiber shape changed */ }
  return null;
}

class ZoomProvider extends CallProvider {
  static get id() { return 'zoom'; }

  doc() { return meetingDoc(); }

  // True once the in-meeting footer toolbar exists (past pre-join/waiting room).
  // The footer hides on mouse idle but stays in the DOM, so presence is enough.
  inMeeting() { return !!this.doc().querySelector(ZOOM.footer.bar); }

  // --- Pre-join / admission (TBD selectors, best-effort) -------------------
  // Signed in, /wc/join/<n> goes straight into the meeting (recon). Signed out,
  // a guest pre-join page asks for a name (and maybe a passcode). Fill the name
  // and click Join if that page is showing; a no-op otherwise.
  async fillPrejoin(botName) {
    const d = this.doc();
    const input = d.querySelector(ZOOM.join.nameInput);
    if (!input || !isVisible(input)) return false;
    if (botName && input.value !== botName) {
      input.focus();
      // React-controlled input: set via the native setter so React sees it.
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
      if (setter) setter.call(input, botName); else input.value = botName;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const join = findByText(d, 'button', ZOOM.join.joinButtonText);
    if (!join) { console.warn('[zoom] pre-join: name filled, Join button not found'); return false; }
    if (join.disabled) { console.warn('[zoom] pre-join: Join button disabled (passcode required?)'); return false; }
    join.click();
    console.log('[zoom] pre-join: joined as', JSON.stringify(botName));
    return true;
  }

  // Zoom's reCAPTCHA rejected the guest join. A human has to deal with it (or
  // the bot signs in to a Zoom account); the bot must not keep clicking Join.
  captchaFailed() {
    return lower(this.doc().body && this.doc().body.innerText).includes(ZOOM.join.captchaFailedText.toLowerCase());
  }

  inWaitingRoom() {
    const body = lower(this.doc().body && this.doc().body.innerText);
    return ZOOM.join.waitingRoomTexts.some((t) => body.includes(t.toLowerCase()));
  }

  // "Join Audio by Computer" (TBD verify): the bot can't be heard, and Zoom
  // won't take its mic, until computer audio is joined.
  async joinComputerAudio() {
    const btn = findByText(this.doc(), 'button', ZOOM.mic.joinAudioByComputerText, { contains: true });
    if (!btn) return false;
    btn.click();
    console.log('[zoom] clicked "Join Audio by Computer"');
    return true;
  }

  // Close promo/info modals ("Got it", …) that cover the toolbar. Scoped to
  // visible dialogs so it can't click an unrelated "OK" elsewhere.
  dismissModals() {
    const d = this.doc();
    let n = 0;
    for (const dlg of d.querySelectorAll(ZOOM.modals.dialog)) {
      if (!isVisible(dlg)) continue;
      for (const text of ZOOM.join.dismissTexts) {
        const b = findByText(dlg, 'button', text);
        if (b) { b.click(); n++; console.log('[zoom] dismissed modal via', JSON.stringify(text)); break; }
      }
    }
    for (const b of d.querySelectorAll(ZOOM.join.gotItButton)) {
      if (isVisible(b) && norm(b.textContent) === ZOOM.join.gotItText) {
        b.click(); n++; console.log('[zoom] dismissed coachmark ("Got it")');
      }
    }
    return n;
  }

  // --- Microphone ----------------------------------------------------------
  // aria-label is the action you'd take: "unmute my microphone" shows WHILE MUTED.
  _micButton() { return this.doc().querySelector(ZOOM.mic.button); }
  isMicMuted() {
    const b = this._micButton();
    return !!b && lower(b.getAttribute('aria-label')) === ZOOM.mic.labelUnmute;
  }
  // Self VU meter: the footer's .audio-level-indicator height in px (0 = silent).
  micLevel() {
    const el = this.doc().querySelector(ZOOM.mic.liveIndicator);
    return el ? (parseFloat(el.style.height) || 0) : null;
  }
  setMicMuted(mute) {
    const b = this._micButton();
    if (!b) { console.warn('[zoom] mic button not found'); return false; }
    const label = lower(b.getAttribute('aria-label'));
    if (label !== ZOOM.mic.labelMute && label !== ZOOM.mic.labelUnmute) {
      // Before computer audio is joined the same slot reads "join audio".
      console.warn('[zoom] mic button not in a mute/unmute state:', JSON.stringify(label));
      return false;
    }
    if (this.isMicMuted() !== !!mute) { b.click(); console.log('[zoom] mic', mute ? 'muted' : 'unmuted'); }
    return true;
  }

  // --- Camera --------------------------------------------------------------
  isCameraOn() {
    const b = this.doc().querySelector(ZOOM.camera.button);
    // "start my video" (verified) shows while OFF; anything else is read as ON.
    return !!b && lower(b.getAttribute('aria-label')) !== ZOOM.camera.labelStart;
  }
  async setCameraOn(on) {
    const b = this.doc().querySelector(ZOOM.camera.button);
    if (!b) { console.warn('[zoom] camera button not found'); return false; }
    if (this.isCameraOn() !== !!on) { b.click(); console.log('[zoom] camera', on ? 'on' : 'off'); }
    return true;
  }

  // --- Screen share --------------------------------------------------------
  // Clicking Share calls getDisplayMedia; page-inject's override + main's source
  // picker answer it, as on Meet. Idempotent: a second click while sharing is
  // not a no-op in Zoom, so never click while already sharing.
  async startShare(/* shareType */) {
    if (this.isSharing()) { console.log('[zoom] already sharing'); return true; }
    const b = this.doc().querySelector(ZOOM.share.button);
    if (!b) { console.warn('[zoom] share button not found'); return false; }
    b.click();
    console.log('[zoom] clicked Share');
    return true;
  }
  async stopShare() {
    const b = this.doc().querySelector(ZOOM.share.stopButton);
    if (!b || !isVisible(b)) { console.log('[zoom] stopShare: not sharing'); return true; }
    b.click();
    console.log('[zoom] clicked Stop Share');
    return true;
  }
  isSharing() { return isVisible(this.doc().querySelector(ZOOM.share.stopButton)); }

  // Who else is sharing: [{ name, id }] (id = their Zoom userId, the same one
  // the captions carry). The web client shows one remote share at a time, so
  // this is at most one entry.
  remoteShares() {
    const d = this.doc();
    const tip = d.querySelector(ZOOM.share.viewingIndicator);
    if (!tip || !isVisible(tip)) return [];
    const m = (tip.getAttribute('aria-label') || norm(tip.textContent)).match(ZOOM.share.viewingAriaRe);
    if (!m) return [];
    const player = d.querySelector(ZOOM.share.sharePlayer);
    return [{ name: norm(m[1]), id: (player && player.getAttribute('node-id')) || null }];
  }

  // Pause (true) / resume (false) the share's computer audio. While it's on,
  // Zoom keeps the bot's mic muted, so the bot can't talk over its own share.
  setShareAudioPaused(paused) {
    const d = this.doc();
    const b = d.querySelector(paused ? ZOOM.share.pauseAudioButton : ZOOM.share.resumeAudioButton);
    if (!b || !isVisible(b)) return false;
    b.click();
    console.log('[zoom] share audio', paused ? 'paused (mic restored)' : 'resumed (mic muted by Zoom)');
    const tip = d.querySelector(ZOOM.share.mutedWhileSharingGotIt);
    if (tip && isVisible(tip)) tip.click();
    return true;
  }

  // --- Leave ---------------------------------------------------------------
  // The footer End/Leave button opens an option list; pick "Leave Meeting".
  // A host gets "End Meeting for All" too, which we never click.
  async leave() {
    const d = this.doc();
    const b = d.querySelector(ZOOM.leave.button);
    if (!b) { console.warn('[zoom] leave button not found'); return false; }
    b.click();
    const opt = await waitFor(() => findByText(d, ZOOM.leave.optionButton, ZOOM.leave.leaveText), 3000);
    if (!opt) { console.warn('[zoom] "Leave Meeting" option not found'); return false; }
    opt.click();
    console.log('[zoom] left meeting');
    return true;
  }

  // --- Captions ------------------------------------------------------------
  // Turn live transcription on: More → Captions → Show Captions, then "Save" on
  // the first-time language dialog. Host-only for the transcription itself.
  async enableCaptions() {
    const d = this.doc();
    const footer = d.querySelector(ZOOM.footer.bar);
    if (!footer) { console.warn('[zoom] [CC] not in meeting yet'); return false; }
    const c = ZOOM.captions;
    const moreBtn = footer.querySelector(c.moreButton);
    if (moreBtn) {
      // Current UI: a grid menu with the caption toggle as one item box.
      if (!d.querySelector(c.moreMenu)) moreBtn.click();
      const menu = await waitFor(() => d.querySelector(c.moreMenu), 3000);
      if (!menu) { console.warn('[zoom] [CC] More menu did not open'); return false; }
      const items = [...menu.querySelectorAll(c.moreItem)].map((b) => b.getAttribute('aria-label'));
      console.log('[zoom] [CC] More menu items:', JSON.stringify(items));
      const hide = menu.querySelector(c.hideCaptionsItem);
      const show = menu.querySelector(c.showCaptionsItem);
      if (show) show.click();
      if (d.querySelector(c.moreMenu)) moreBtn.click(); // close it either way
      if (hide && !show) { console.log('[zoom] [CC] captions already on'); return true; }
      if (!show) { console.warn('[zoom] [CC] no "Show Captions" item in the More menu'); return false; }
      const dlg = await waitFor(() => d.querySelector(c.languageDialog), 2000);
      if (dlg) {
        const save = findByText(dlg, 'button', c.languageSaveText);
        if (save) { save.click(); console.log('[zoom] [CC] saved caption language'); }
      }
      console.log('[zoom] [CC] clicked "Show Captions"');
      await delay(1500);
      this.logTranscriptCandidates();
      await this.openFullTranscript();
      return true;
    }
    // July 2026 UI: More → Captions submenu → Show Captions.
    const more = findByText(footer, 'button', ZOOM.captions.moreButtonText, { visibleOnly: false });
    if (!more) { console.warn('[zoom] [CC] footer "More" button not found'); return false; }
    more.click();
    const cc = await waitFor(() => d.querySelector(ZOOM.captions.captionsItem), 3000);
    if (!cc) { console.warn('[zoom] [CC] "Captions" menu item not found'); return false; }
    cc.click();
    await delay(300);
    if (findByText(d, ZOOM.modals.dropdownItem, ZOOM.captions.hideCaptionsText, { contains: true })) {
      console.log('[zoom] [CC] captions already on');
      d.body.click(); // close the menu
      return true;
    }
    const show = await waitFor(() => findByText(d, ZOOM.modals.dropdownItem, ZOOM.captions.showCaptionsText, { contains: true }), 3000);
    if (!show) { console.warn('[zoom] [CC] "Show Captions" not found'); return false; }
    show.click();
    const dlg = await waitFor(() => d.querySelector(ZOOM.captions.languageDialog), 2000);
    if (dlg) {
      const save = findByText(dlg, 'button', ZOOM.captions.languageSaveText);
      if (save) { save.click(); console.log('[zoom] [CC] saved caption language'); }
    }
    console.log('[zoom] [CC] captions enabled');
    return true;
  }

  // Recon aid while the transcript panel is unmapped: log every visible control
  // or element that mentions a transcript, so a test call shows where it lives.
  logTranscriptCandidates() {
    const d = this.doc();
    const hits = [];
    for (const el of d.querySelectorAll('button, [role="button"], [role="menuitem"], a, [aria-label], [class*="transcri"], [id*="transcri"]')) {
      const label = el.getAttribute('aria-label') || '';
      const text = norm(el.textContent).slice(0, 60);
      const cls = String(el.className || '');
      if (/transcri/i.test(label + ' ' + cls + ' ' + (el.id || '')) || (/transcri/i.test(text) && text.length < 60)) {
        hits.push({ tag: el.tagName.toLowerCase(), id: el.id || undefined, cls: cls.slice(0, 80), label: label.slice(0, 60), text, visible: isVisible(el) });
      }
    }
    console.log('[zoom] [CC] transcript candidates (' + hits.length + '):', JSON.stringify(hits.slice(0, 15)));
    return hits;
  }

  // Open the full transcript from the caption overlay's gear menu, if this
  // meeting offers it. Logs the menu either way: the item names are recon.
  async openFullTranscript() {
    const d = this.doc();
    const gear = d.querySelector(ZOOM.captions.captionSettingsButton);
    if (!gear) { console.warn('[zoom] [CC] caption settings button not found'); return false; }
    const before = new Set(d.querySelectorAll('*'));
    gear.click();
    await delay(600);
    const fresh = [...d.querySelectorAll('button, [role="menuitem"], [role="menuitemcheckbox"], [role="option"], li, .dropdown-item')]
      .filter((el) => !before.has(el) && isVisible(el));
    const items = fresh.map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 70), label: (el.getAttribute('aria-label') || '').slice(0, 50), text: norm(el.textContent).slice(0, 50) }));
    console.log('[zoom] [CC] caption settings menu (' + items.length + '):', JSON.stringify(items.slice(0, 20)));
    const item = fresh.find((el) => /full transcript|view transcript|transcript/i.test(el.getAttribute('aria-label') || '') || /full transcript|view transcript/i.test(norm(el.textContent)));
    if (!item) {
      gear.click(); // close the menu
      console.warn('[zoom] [CC] no transcript item in caption settings');
      return false;
    }
    item.click();
    console.log('[zoom] [CC] clicked', JSON.stringify(norm(item.textContent) || item.getAttribute('aria-label')));
    await delay(1500);
    this.logTranscriptCandidates();
    return true;
  }

  // avatar src → { name, isSelf } from the participants list. The caption
  // overlay names nobody; its avatar <img> is how a line is attributed.
  avatarNames() {
    const map = new Map();
    for (const li of this.doc().querySelectorAll(ZOOM.people.item)) {
      const img = li.querySelector(ZOOM.people.avatar);
      const p = ZOOM.parseParticipantAria(li.getAttribute('aria-label'));
      if (img && img.src && p) map.set(img.src, { name: p.name, isSelf: p.isSelf });
    }
    return map;
  }

  overlayVisible() {
    const box = this.doc().querySelector(ZOOM.captions.overlayBox);
    return !!box && !box.classList.contains(ZOOM.captions.overlayHiddenClass);
  }

  // The overlay's current rows as [{ key, speaker, text }]. Speaker, best first:
  //   1. React props: the caption row's component gets messageItem.user
  //      ({ userId, displayName, avatar }) — verified live 2026-10-14. Works
  //      for people without a profile photo, unlike (2).
  //   2. The avatar <img> src, matched to the participants list.
  // Neither → 'unknown'.
  readOverlay() {
    const c = ZOOM.captions;
    const root = this.doc().querySelector(c.subtitle);
    if (!root || !this.overlayVisible()) return [];
    let names = null; // avatar map, built only if (1) fails
    const rows = [];
    let row = null;
    for (const el of root.children) {
      if (el.matches(c.subtitleAvatar)) {
        row = { key: el.src || 'unknown', speaker: 'unknown', text: '', src: el.src };
        rows.push(row);
      } else if (el.matches(c.subtitleItem)) {
        if (!row) { row = { key: 'unknown', speaker: 'unknown', text: '' }; rows.push(row); }
        row.text = norm(row.text + ' ' + el.textContent);
        const user = captionUser(el);
        if (user && user.displayName) {
          row.speaker = user.displayName;
          if (user.userId != null) row.key = 'user:' + user.userId;
        }
      }
    }
    for (const r of rows) {
      if (r.speaker !== 'unknown' || !r.src) continue;
      names = names || this.avatarNames();
      const who = names.get(r.src);
      if (who) r.speaker = who.name;
    }
    return rows
      .filter((r) => r.text && r.text !== 'Captions are on')
      .map(({ key, speaker, text }) => ({ key, speaker, text }));
  }

  // Recon: the overlay DOM names nobody (img alt="" aria-hidden, no title or
  // data-*), but Zoom's React component picked that avatar from SOME user
  // record. Walk the fiber up from the caption row and log any props that look
  // like a name or user id. Run once per call; remove when attribution settles.
  probeCaptionFiber() {
    const root = this.doc().querySelector(ZOOM.captions.subtitle);
    if (!root) return null;
    const start = root.querySelector(ZOOM.captions.subtitleItem) || root;
    const fiberKey = Object.keys(start).find((k) => k.startsWith('__reactFiber$'));
    if (!fiberKey) { console.log('[zoom] [CC] fiber probe: no React fiber on the caption row'); return null; }
    const hits = [];
    const seen = new Set();
    const scan = (obj, path, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 3 || seen.has(obj)) return;
      seen.add(obj);
      for (const k of Object.keys(obj)) {
        if (k === 'children' || k.startsWith('_')) continue;
        let v;
        try { v = obj[k]; } catch { continue; }
        if (v && typeof v === 'object' && !(v instanceof Node)) scan(v, path + '.' + k, depth + 1);
        else if (/name|user|speaker|display|avatar|id$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          hits.push(path + '.' + k + '=' + String(v).slice(0, 80));
        }
      }
    };
    let f = start[fiberKey];
    for (let i = 0; f && i < 12; i++, f = f.return) {
      const name = typeof f.type === 'string' ? f.type : (f.type && (f.type.displayName || f.type.name)) || '?';
      scan(f.memoizedProps, '[' + i + ' ' + name + ']', 0);
    }
    console.log('[zoom] [CC] fiber probe (' + hits.length + '):', JSON.stringify(hits.slice(0, 40)));
    return hits;
  }

  // v1 transcript source: the "Full transcript" panel. False until its
  // selectors are harvested, or when the host's account doesn't have it on.
  transcriptAvailable() {
    const sel = ZOOM.captions.transcriptPanel;
    return !!sel && !!this.doc().querySelector(sel);
  }
  scrapeTranscript() {
    if (!this.transcriptAvailable()) return [];
    const c = ZOOM.captions;
    const out = [];
    for (const row of this.doc().querySelector(c.transcriptPanel).querySelectorAll(c.transcriptRow)) {
      const speaker = norm(row.querySelector(c.transcriptSpeaker)?.textContent);
      const text = norm(row.querySelector(c.transcriptText)?.textContent);
      if (text) out.push({ speaker: speaker || 'unknown', text });
    }
    return out;
  }
  async readCaptions() { return this.scrapeTranscript(); }
  async recoverCaptions() { return this.enableCaptions(); }

  // --- Chat ----------------------------------------------------------------
  async _ensureChatOpen() {
    const d = this.doc();
    if (d.querySelector(ZOOM.chat.editor)) return true;
    const t = d.querySelector(ZOOM.chat.toggle);
    if (!t) { console.warn('[zoom] chat toggle not found'); return false; }
    t.click();
    return !!(await waitFor(() => d.querySelector(ZOOM.chat.editor), 4000));
  }

  // Visible messages only: the list is Virtuoso-virtualized. Sender renders on
  // the first message of a run, so carry it forward; dedup on data-id.
  scrapeChatMessages() {
    const d = this.doc();
    const list = d.querySelector(ZOOM.chat.list) || d;
    const out = [];
    const seen = new Set();
    let sender = '';
    let senderId = null;
    for (const row of list.querySelectorAll(ZOOM.chat.item)) {
      const s = row.querySelector(ZOOM.chat.sender);
      if (s) {
        sender = s.getAttribute(ZOOM.chat.senderNameAttr) || norm(s.textContent) || sender;
        senderId = s.getAttribute(ZOOM.chat.senderIdAttr) || senderId;
      }
      const id = row.getAttribute(ZOOM.chat.itemIdAttr);
      if (!id || seen.has(id)) continue;
      const content = row.querySelector(ZOOM.chat.messageContent);
      const parsed = ZOOM.parseChatAria(content && content.getAttribute('aria-label'));
      const text = norm(row.querySelector(ZOOM.chat.textBox)?.textContent) || (parsed && parsed.text) || '';
      if (!text) continue;
      seen.add(id);
      const self = !!row.querySelector('.' + ZOOM.chat.selfModifier);
      out.push({ id, sender: sender || (parsed && parsed.from) || 'unknown', senderId, text, self });
    }
    return out;
  }

  async readChat() {
    if (!(await this._ensureChatOpen())) return [];
    await delay(200);
    return this.scrapeChatMessages();
  }

  // Enter sends (no send button). Refuses to send unless the recipient is the
  // whole meeting, so a stale DM selection can't leak a message to one person.
  async sendChat(text) {
    if (!(await this._ensureChatOpen())) return false;
    const d = this.doc();
    const to = d.querySelector(ZOOM.chat.receiverButton);
    if (to && !lower(to.textContent).includes(ZOOM.chat.receiverEveryone.toLowerCase())) {
      console.warn('[zoom] chat recipient is not the whole meeting:', JSON.stringify(norm(to.textContent)), '— not sending');
      return false;
    }
    const editor = d.querySelector(ZOOM.chat.editor);
    editor.focus();
    const ok = d.execCommand('insertText', false, text);
    if (!ok) {
      editor.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true }));
    }
    await delay(100);
    const send = d.querySelector(ZOOM.chat.sendButton);
    if (send && !send.disabled && !send.classList.contains(ZOOM.chat.sendDisabledClass)) {
      send.click();
    } else {
      const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      editor.dispatchEvent(new KeyboardEvent('keydown', enter));
      editor.dispatchEvent(new KeyboardEvent('keyup', enter));
    }
    await delay(200);
    // Confirm: the editor clears on a successful send.
    return !norm(editor.textContent);
  }

  // --- Roster --------------------------------------------------------------
  // Read from the participants pane (open it if needed). Virtualized: a long
  // roster only shows its visible rows. Per-participant speaking is TBD
  // (checklist 4), so `speaking` is always false for now.
  async openParticipants() {
    const d = this.doc();
    if (d.querySelector(ZOOM.people.list)) return true;
    const b = d.querySelector(ZOOM.people.button);
    if (!b) return false;
    b.click();
    return !!(await waitFor(() => d.querySelector(ZOOM.people.list), 3000));
  }
  getParticipants() {
    const out = [];
    for (const li of this.doc().querySelectorAll(ZOOM.people.item)) {
      const p = ZOOM.parseParticipantAria(li.getAttribute('aria-label'));
      if (p) out.push({ name: p.name, isSelf: p.isSelf, isHost: p.isHost, audioMuted: p.audioMuted, videoOn: p.videoOn, speaking: false });
    }
    return out;
  }
  // Count from the people button's aria ("…list pane,3 particpants"); works
  // with the pane closed, unlike getParticipants().
  participantCount() {
    const b = this.doc().querySelector(ZOOM.people.button);
    const m = (b && b.getAttribute('aria-label') || '').match(ZOOM.people.buttonCountRe);
    return m ? Number(m[1]) : null;
  }

  // --- No Zoom analog ------------------------------------------------------
  async setStudioSound(/* enabled */) { return true; }
  async setCaptionLanguage(/* language */) {
    return { ok: false, error: 'Caption language is not wired for Zoom yet' };
  }
  speak(/* payload */) {
    // TTS rides page-inject's virtual mic in this same page (preload-zoom.js),
    // driven by the play-tts extension-message, not by this provider.
  }
}

module.exports = { ZoomProvider, meetingDoc };
