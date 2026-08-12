// zoom-selectors.js — Zoom web client DOM coupling, centralized.
//
// The Zoom analog of meet-selectors.js / slack-selectors.js: the explicit
// surface of the "Zoom" video-call backend. Sourced from hands-on DOM recon of
// the live web client at app.zoom.us (Stan + Claude, 2026-07-05, solo host
// session). Zoom has NO stable data-qa hooks like Slack; the durable handles
// are aria-labels (lowercase, distinctive phrasing like "unmute my microphone")
// and BEM-ish class names (`join-audio-container__btn`) that appear to be
// hand-written rather than hash-generated — steadier than Meet's obfuscated
// classes, less guaranteed than Slack's data-qa.
//
// Pure data + tiny pure helpers. No DOM access, no requires.
//
// SURFACE NOTE. The meeting UI renders in ONE of two places:
//   • PWA wrapper (app.zoom.us/wc/<id>/start via "launch" flow): the meeting
//     lives in a SAME-ORIGIN iframe `#webclient` (.pwa-webclient__iframe,
//     src path /wc/<id>/join). All selectors below target the IFRAME document.
//   • Direct web client (zoom.us /wc/ URLs without the PWA shell): top-level
//     document. Resolve via `iframe` selector first, fall back to top document.
//
// VIRTUALIZATION NOTE. Both the participants list (ReactVirtualized) and the
// chat list (Virtuoso) are virtualized — only visible rows exist in the DOM.
// Reading "all" participants/messages requires the pane to be scrolled, or
// accepting the visible window. (Meet/Slack code assumes full lists; Zoom
// readers must not.)
//
// TBD items are marked — they need a signed-out guest session or a multi-party
// call to verify (see the checklist at the bottom).

const ZOOM = {
  // -------------------------------------------------------------------------
  // URLs / navigation / surfaces.
  // -------------------------------------------------------------------------
  url: {
    host: 'zoom.us', // matches app.zoom.us and tenant subdomains (*.zoom.us)
    // Web-client meeting paths: /wc/<digits>/start, /wc/<digits>/join,
    // /wc/join/<digits>. Capture group = the meeting number.
    meetingPathRe: /\/wc\/(?:join\/)?(\d{9,11})/,
    // /j/<digits> is the generic invite link; it lands on a "launch meeting"
    // page whose "Join from your browser" anchor leads into /wc/.
    inviteLinkRe: /zoom\.us\/j\/(\d{9,11})/,
    // Signed-in "home" (start/schedule surface) lives on the user's TENANT
    // subdomain, e.g. https://us05web.zoom.us/myhome — the host match must
    // stay suffix-based (*.zoom.us), never app.zoom.us-exact.
    homePath: '/myhome',
    // Starting/joining a call from home SPAWNS A NEW TAB (window.open into
    // /wc/…). In the Electron provider this is the Slack-huddle lesson again:
    // intercept via setWindowOpenHandler and inject there — the originating
    // tab is NOT the meeting surface.
  },

  // PWA shell → meeting iframe (same-origin; may be absent on direct /wc/).
  iframe: '#webclient', // class .pwa-webclient__iframe

  // -------------------------------------------------------------------------
  // Footer toolbar. `#wc-footer` gains .footer__hidden when the mouse idles
  // but STAYS IN THE DOM — querySelector/click keep working; no mouse-jiggling
  // needed. Buttons are identified by aria-label (none have ids/data hooks).
  // -------------------------------------------------------------------------
  footer: {
    bar: '#wc-footer',
    hiddenClass: 'footer__hidden', // visual-only; DOM remains interactive
  },

  // -------------------------------------------------------------------------
  // Microphone — aria-label is the action you'd take (lowercase). Verified
  // flip: "unmute my microphone" ↔ "mute my microphone". While the mic is
  // live the button contains an .audio-level-indicator child that is a true
  // SELF VU METER: its inline `style.height` (px) tracks the mic input
  // AMPLITUDE and sits at "0px" when silent (verified live, Stan 2026-07-05).
  // Poll parseFloat(el.style.height) for a level reading, or > 0 for "our
  // mic hears audio" — the Zoom analog of the mic-level self-check, and a
  // debounce-free acoustic-double-play tell. (Contrast: the participants-list
  // row shows a canned ON/OFF speaking animation, not amplitude — see
  // people.rosterIconClassPrefix.) SELF ONLY: exactly one such element exists
  // (footer button); other participants' speaking is signalled elsewhere
  // (see people.rosterIconClassPrefix / tiles.speakingIndicator, TBD).
  // DOM: .audio-level-indicator < .voip-icon-inner < .audio-voip-active-icon.
  // -------------------------------------------------------------------------
  mic: {
    button: 'button.join-audio-container__btn',
    labelMute: 'mute my microphone', // shown when UNMUTED (click to mute)
    labelUnmute: 'unmute my microphone', // shown when MUTED (click to unmute)
    liveIndicator: '.audio-level-indicator', // present when hot; style.height = VU level
    // TBD: before computer audio is joined the same slot reads "join audio"
    // and a "Join Audio by Computer" affordance may interpose (auto-joined in
    // the recon session, so unverified). Known-convention selector:
    joinAudioByComputerText: 'Join Audio by Computer', // TBD verify
  },

  // -------------------------------------------------------------------------
  // Camera — same pattern as mic. Verified OFF label; ON label inferred from
  // Zoom's symmetric phrasing (TBD verify with camera on).
  // -------------------------------------------------------------------------
  camera: {
    button: 'button.send-video-container__btn',
    labelStart: 'start my video', // present when camera is OFF
    labelStop: 'stop my video', // present when camera is ON (TBD verify)
  },

  // -------------------------------------------------------------------------
  // Participants pane. Toggle button aria STARTS WITH the stable phrase and
  // then appends a count ("...list pane,3 particpants" — note Zoom's typo
  // "particpants" is in the DOM; do not "fix" it, but match on the prefix
  // anyway). List is ReactVirtualized (see VIRTUALIZATION NOTE).
  // -------------------------------------------------------------------------
  people: {
    toggleLabelPrefix: 'open the manage participants list pane',
    button: 'button[aria-label^="open the manage participants list pane" i]',
    pane: '#wc-container-right', // right side-panel host (participants/chat)
    header: '.participants-header__header', // text "Participants (N)"
    headerCountRe: /Participants\s*\((\d+)\)/i,
    list: '#participants-ul', // aria-label "Participants list"
    item: '.participants-li', // one per (visible) participant; id participants-list-<n>
    // The item aria-label encodes name + av state in one string:
    //   "Stan (Host, me),computer audio muted,video off"
    // Split on commas: [0]=display name (+role parens), rest=state phrases.
    itemAriaRe: /^([^,]+?)(?:,(.*))?$/,
    audioMutedPhrase: 'computer audio muted',
    audioUnmutedPhrase: 'computer audio unmuted',
    videoOffPhrase: 'video off',
    videoOnPhrase: 'video on', // TBD verify exact phrase with camera on
    selfMarker: '(me)', // inside the name segment, e.g. "Stan (Host, me)"
    hostMarker: '(Host', // "(Host)" or "(Host, me)"
    // Roster rows carry state as lazy-loaded SVG icons whose CLASS NAME encodes
    // the state: "lazy-icon-icons/participants-list/<state>" — observed:
    // video-off, audio-muted (prefix below). While a participant speaks, the
    // row's audio icon plays a canned ON/OFF animation (binary voice-activity,
    // NOT amplitude — unlike the footer mic button's VU meter; observed on the
    // self row, Stan 2026-07-05). This is the per-participant speaking signal;
    // the exact animated icon class/markup is TBD — harvest it multi-party.
    rosterIconClassPrefix: 'lazy-icon-icons/participants-list/',
  },

  // -------------------------------------------------------------------------
  // Video tiles / active speaker. Name badge verified; a per-tile "speaking"
  // overlay could not be verified solo (only one participant) — TBD.
  // -------------------------------------------------------------------------
  tiles: {
    speakerWrap: '.speaker-active-container__wrap', // speaker-view main tile
    videoFrame: '.speaker-active-container__video-frame',
    avatar: '.video-avatar__avatar', // camera-off placeholder tile
    nameBadge: '.video-avatar__avatar-footer', // <span> text = display name
    mutedIcon: '.video-avatar__avatar-footer--view-mute-computer',
    speakingIndicator: null, // TBD — needs a multi-party call to observe
  },

  // -------------------------------------------------------------------------
  // Chat — read & send. Compose is a TipTap/ProseMirror contenteditable (no
  // send button in the DOM; Enter sends). Verified send recipe:
  //   editor.focus(); document.execCommand('insertText', false, text);
  //   editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',
  //     code:'Enter', keyCode:13, which:13, bubbles:true, cancelable:true}));
  // -------------------------------------------------------------------------
  chat: {
    toggle: 'button[aria-label="open the chat panel" i]',
    container: '.chat-container', // whole pane (inside #wc-container-right)
    editor: 'div.tiptap.ProseMirror', // contenteditable compose box
    // Recipient picker — read it before sending to avoid DMing by accident.
    receiverButton: '.chat-receiver-list__receiver', // text e.g. "Meeting Group Chat"
    receiverEveryone: 'Meeting Group Chat',
    list: '.chat-container__chat-list', // Virtuoso-virtualized (visible rows only)
    // One message row; data-id is a stable per-message id ("3-{uuid}") — the
    // dedup key (Zoom analog of Slack's data-msg-ts / Meet's data-message-id).
    item: '.chat-item-container',
    itemIdAttr: 'data-id',
    // Sender header renders on the first message of a run; carry forward for
    // subsequent messages from the same sender (same pattern as Meet/Slack).
    sender: '.chat-item__sender', // data-userid + data-name attrs, text = name
    senderIdAttr: 'data-userid',
    senderNameAttr: 'data-name',
    timestamp: '.new-chat-item__chat-info-time-stamp', // "12:05 PM"
    // Message content. The container's aria-label is a parseable one-liner:
    //   "You to Everyone, 12:05 PM, selector harvest test"
    messageContent: '.new-chat-message__container',
    messageAriaRe: /^(.+?) to (.+?), (\d{1,2}:\d{2}\s*[AP]M), ([\s\S]*)$/i,
    textBox: '.new-chat-message__text-box', // inner <p> holds the text
    selfModifier: 'new-chat-message__text-box--self', // own messages
  },

  // -------------------------------------------------------------------------
  // Captions ("live transcription"). Enable flow (verified, host):
  //   More (footer) → "Captions" → "Show Captions" → first time only: a
  //   language dialog (.lt-select-language) → "Save".
  // Renders as a draggable overlay. Overlay gains
  // .live-transcription-subtitle__box--hide as text fades; content persists
  // briefly. NO speaker-name text was present solo (just an avatar <img>) —
  // attribution format in multi-party calls is TBD (may prefix "Name: ").
  //
  // CORRECTION (this recon originally concluded "NOT a persistent transcript
  // panel, so the Meet-style ephemeral scrape model applies, not Slack's
  // scrollable event log" — that was incomplete). Zoom DOES document a
  // "View full transcript" mode that opens a Transcript panel with the
  // session's full transcript, search, and download-as-.TXT. Enabling it is
  // host-only. See:
  //   https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0062813#h_01GHWATNVPW5FR304S2SVGXN2X
  // The overlay finding stands; it just was not the whole picture — the two
  // are most likely views of the same live transcription, and this harvest
  // never opened the panel.
  //
  // BUT: that article documents the DESKTOP and MOBILE apps and never mentions
  // the web client, which is what this file targets. So do NOT build on the
  // panel until someone confirms it exists at app.zoom.us — if it is
  // desktop-only, the ephemeral overlay below stays the only signal. See
  // checklist item 3 at the bottom of this file.
  //
  // If the panel IS reachable here, prefer it over the overlay: a persistent
  // scrollable log beats racing a fade timer, slack-selectors.js already
  // implements that pattern, and a transcript panel is the likelier place for
  // the speaker labels item 3 needs.
  // -------------------------------------------------------------------------
  captions: {
    moreButtonText: 'More', // footer button — NO aria-label; match by text
    captionsItem: '.dropdown-item[aria-label="Captions"]',
    showCaptionsText: 'Show Captions', // submenu .dropdown-item
    hideCaptionsText: 'Hide Captions', // present (visible) only when CC is ON
    languageDialog: '.lt-select-language', // first-enable "Set the caption language"
    languageSaveText: 'Save',
    overlayBox: '.live-transcription-subtitle__box',
    overlayHiddenClass: 'live-transcription-subtitle__box--hide',
    subtitle: '#live-transcription-subtitle',
    subtitleItem: '.live-transcription-subtitle__item', // <span> caption text
    enabledToastText: 'You have turned on live transcription',
  },

  // -------------------------------------------------------------------------
  // Screen share. Clicking fires getDisplayMedia → the BROWSER's native
  // picker (Electron: session.setDisplayMediaRequestHandler — same hook the
  // Meet provider uses). No in-page picker to script.
  // -------------------------------------------------------------------------
  share: {
    button: 'button.sharing-entry-button-container', // aria-label "Share"
    label: 'Share',
    // TBD: stop-share affordance + "You are sharing" banner classes (recon
    // session didn't start a share; harvest during first share test).
  },

  // -------------------------------------------------------------------------
  // Leave / end. The "End" (host) / "Leave" (participant) footer button opens
  // an in-footer option list, NOT an immediate exit.
  // -------------------------------------------------------------------------
  leave: {
    button: 'button[aria-label="End" i], button[aria-label="Leave" i]',
    optionsContainer: '.leave-option-container',
    optionButton: '.leave-meeting-options__btn', // by text, below:
    endForAllText: 'End Meeting for All', // host only
    leaveText: 'Leave Meeting',
    cancelButton: '.leave-option-container__cancel-btn',
  },

  // -------------------------------------------------------------------------
  // Join / admission flow — mostly TBD: the recon session was signed in as
  // host, and /wc/join/<id> redirected straight into the meeting. Known-
  // convention guest-prejoin selectors (VERIFY in a signed-out session):
  // -------------------------------------------------------------------------
  join: {
    nameInput: '#input-for-name', // TBD verify
    passcodeInput: '#input-for-pwd', // TBD verify (skipped when ?pwd= in URL)
    joinButtonText: 'Join', // TBD verify (.preview-join-button)
    waitingRoomTexts: ['waiting for the host', 'will let you in soon'], // TBD verify
    // Dialog-dismiss affordances observed in-meeting (Meet's dismissTexts
    // analog): promo/info modals with a primary "Got it".
    dismissTexts: ['Got it', 'OK', 'Close', 'Not Now', 'Cancel'],
    gotItButton: 'button.zmu-btn--primary', // scope to visible modal, match text
  },

  // -------------------------------------------------------------------------
  // Keyboard shortcuts — DESKTOP APP table (macOS), from
  // https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0067050
  // (Stan, 2026-07-05). ⚠️ NOT usable on the WEB client: ⌘⇧A was tested live
  // against app.zoom.us (both real browser keystrokes and synthetic keydown
  // into the #webclient iframe) and did NOT toggle the mic. DOM clicks are
  // the control path on web; this table is kept for a future desktop-app /
  // native-share integration (cf. Slack's startKey) and in case the web
  // client grows shortcut support. Meeting-relevant subset only.
  // -------------------------------------------------------------------------
  desktopKeys: {
    muteToggle: { code: 'KeyA', metaKey: true, shiftKey: true }, // ⌘⇧A
    videoToggle: { code: 'KeyV', metaKey: true, shiftKey: true }, // ⌘⇧V
    shareToggle: { code: 'KeyS', metaKey: true, shiftKey: true }, // ⌘⇧S
    sharePauseToggle: { code: 'KeyT', metaKey: true, shiftKey: true }, // ⌘⇧T
    participantsToggle: { code: 'KeyU', metaKey: true }, // ⌘U
    chatToggle: { code: 'KeyH', metaKey: true, shiftKey: true }, // ⌘⇧H
    raiseHandToggle: { code: 'KeyY', altKey: true }, // ⌥Y
    copyInviteLink: { code: 'KeyI', metaKey: true, shiftKey: true }, // ⌘⇧I
    viewToggle: { code: 'KeyW', metaKey: true, shiftKey: true }, // ⌘⇧W speaker/gallery
    pushToTalk: { code: 'Space' }, // hold to temporarily unmute
    muteAll: { code: 'KeyM', metaKey: true, ctrlKey: true }, // ⌘^M host only
    unmuteAll: { code: 'KeyU', metaKey: true, ctrlKey: true }, // ⌘^U host only
  },

  // -------------------------------------------------------------------------
  // Modals / menus — generic hooks.
  // -------------------------------------------------------------------------
  modals: {
    dialog: '[role="dialog"], .zm-modal',
    dropdownMenu: '.dropdown-menu.show', // Bootstrap-style; footer menus use it
    dropdownItem: '.dropdown-item',
  },
};

// Parse the meeting number out of any zoom.us URL form (wc paths or /j/ links).
ZOOM.meetingNumberFromUrl = (url) => {
  const m = (url || '').match(ZOOM.url.meetingPathRe) || (url || '').match(ZOOM.url.inviteLinkRe);
  return m ? m[1] : null;
};

// True if a URL is an in-meeting web-client surface (either PWA or direct).
ZOOM.isMeetingUrl = (url) => {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(ZOOM.url.host) && ZOOM.url.meetingPathRe.test(u.pathname);
  } catch {
    return false;
  }
};

// Stable vibeconferencing room code — a Zoom meeting number is globally unique.
ZOOM.roomCodeFor = (meetingNumber) => `zoom-${meetingNumber}`;
ZOOM.roomCodeFromUrl = (url) => {
  const n = ZOOM.meetingNumberFromUrl(url);
  return n ? ZOOM.roomCodeFor(n) : null;
};

// Parse a participants-item aria-label → { name, isSelf, isHost, audioMuted,
// videoOn } (nulls where the phrase wasn't present, e.g. audio not joined).
ZOOM.parseParticipantAria = (aria) => {
  const parts = (aria || '').split(',').map((s) => s.trim());
  if (!parts[0]) return null;
  const name = parts[0];
  const rest = parts.slice(1).join(',');
  return {
    name: name.replace(/\s*\((Host|Co-host)?,?\s*me\)|\s*\((Host|Co-host)\)/gi, '').trim(),
    isSelf: name.includes(ZOOM.people.selfMarker),
    isHost: name.includes(ZOOM.people.hostMarker),
    audioMuted: rest.includes(ZOOM.people.audioMutedPhrase)
      ? true
      : rest.includes(ZOOM.people.audioUnmutedPhrase)
        ? false
        : null,
    videoOn: rest.includes(ZOOM.people.videoOffPhrase)
      ? false
      : rest.includes(ZOOM.people.videoOnPhrase)
        ? true
        : null,
  };
};

// Parse a chat message container's aria-label → { from, to, time, text }.
ZOOM.parseChatAria = (aria) => {
  const m = (aria || '').match(ZOOM.chat.messageAriaRe);
  return m ? { from: m[1], to: m[2], time: m[3], text: m[4] } : null;
};

// ---------------------------------------------------------------------------
// TBD HARVEST CHECKLIST — items needing a session this recon couldn't produce
// (solo, signed-in-as-host). Capture these before wiring the provider fully:
//   1. Guest pre-join page (signed-out browser): name/passcode inputs, Join
//      button, "not a robot" gate if any → join.* above.
//   2. Waiting-room ("host will let you in") body text → join.waitingRoomTexts.
//   3. Captions, two parts (see the CORRECTION note in the captions block):
//      a. Does the "View full transcript" Transcript panel exist in the WEB
//         client at all? Zoom documents it for the desktop/mobile apps only.
//         This gates everything else: if it is desktop-only, the ephemeral
//         overlay is the only signal and we scrape it Meet-style. If it is
//         here, prefer it and add its selectors (panel container, row, speaker
//         label, scroll region) to captions.*.
//      b. Multi-party attribution: does the overlay prefix speaker names, and
//         does the panel carry them? → captions.* attribution format.
//      Also open: plan/account gating, and whether a GUEST bot can read the
//      panel once a host has turned transcription on (enabling is host-only).
//   4. Per-tile speaking indicator (needs 2+ participants) → tiles.speakingIndicator.
//   5. Stop-share affordances after a real share → share.*.
//   6. Camera-ON label + participants "video on" phrase → camera.labelStop,
//      people.videoOnPhrase.
//   7. Pre-audio-join state: "join audio" button / "Join Audio by Computer"
//      modal → mic.joinAudioByComputerText.
// ---------------------------------------------------------------------------

module.exports = { ZOOM };
