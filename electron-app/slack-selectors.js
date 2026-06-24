// slack-selectors.js — Slack huddle DOM coupling, centralized.
//
// The Slack analog of meet-selectors.js: the explicit surface of the "Slack"
// video-call (huddle) backend. Sourced from hands-on DOM recon (#264, Stan
// 2026-06-24). Slack ships stable `data-qa` test hooks, so we key off THOSE
// wherever possible — far less rotation-prone than Meet's CSS classes / aria.
//
// Pure data + tiny pure helpers. No DOM access, no requires.
//
// Two-surface note (#264): a Slack huddle splits across the main app.slack.com
// window (media: getUserMedia / RTCPeerConnection) and an about:blank popup
// (the call UI these selectors target). These selectors are for the POPUP DOM.
// "Side-by-side" captions reportedly open in ANOTHER window — TBD whether the
// transcript panel below lives in the popup or a third surface.

const SLACK = {
  // -------------------------------------------------------------------------
  // Huddle lifecycle — detection + start/join.
  //
  // DETECTION. A huddle's window URL is about:blank (useless), so detection
  // keys off the window/tab TITLE — "Huddle: #testing - <workspace> - Slack".
  // Two contexts:
  //   • USER's EXTERNAL browser (Chrome/Safari) — the auto-follow case, like
  //     Meet's detection. AppleScript scans windows/tabs, but matches the TITLE
  //     here (Meet matches the tab URL meet.google.com/…; Slack can't, so use
  //     `windowTitlePrefix`). The title also yields the channel NAME (#testing);
  //     a sibling app.slack.com/client/<team>/<channel> tab gives the IDs.
  //   • OUR OWN Electron popup (when the bot drives Slack itself) — we own that
  //     BrowserWindow, so read win.getTitle() / 'page-title-updated' in-process,
  //     no AppleScript.
  //
  // START/JOIN (main app.slack.com window): a real /client/<team>/<channel> URL
  // and the channel-header "Huddle" button — starts a new huddle OR joins the
  // active one (keyboard: Cmd+Option+Shift+H).
  // -------------------------------------------------------------------------
  huddle: {
    windowTitlePrefix: 'Huddle:', // popup window title when a huddle is live
    clientUrlBase: 'https://app.slack.com/client', // + /<team>/<channel>
    clientUrlRe: /app\.slack\.com\/client\/([^/?#]+)\/([^/?#]+)/,
    // Channel-header button (MAIN window): opens the huddle lobby/preview popup.
    startButton: 'button[data-qa="huddle_channel_header_button__start_button"]',
    startKey: { code: 'KeyH', metaKey: true, altKey: true, shiftKey: true },
    // Lobby/preview popup: a camera/mic preview, then "Start Huddle" to actually
    // enter. The popup title is "Slack - Huddle Preview" here; it flips to
    // "Huddle: …" once joined.
    lobbyStartButton: 'button[data-qa="huddle_invite_window_with_preview_content_join_button"]', // aria-label "Start Huddle"
    lobbyTitle: 'Slack - Huddle Preview',
  },

  // -------------------------------------------------------------------------
  // Screen share — toolbar button; aria-pressed + aria-label flip with state.
  // -------------------------------------------------------------------------
  screenShare: {
    button: 'button[data-qa="huddle_toolbar_screenshare_button"]',
    labelStart: 'Share your screen', // aria-label when OFF (click to start)
    labelStop: 'Stop sharing screen', // aria-label while sharing
    pressedAttr: 'aria-pressed', // "true" while sharing
  },

  // -------------------------------------------------------------------------
  // Camera — label is the action you'd take; inner data-qa icon reveals state.
  // -------------------------------------------------------------------------
  camera: {
    button: 'button[data-qa="huddle_camera_huddle_toolbar"]',
    labelOn: 'Turn off camera', // present when camera is ON
    labelOff: 'Turn on camera', // present when camera is OFF
    iconOff: '[data-qa="huddle_video_icon_camera_off"]', // present when OFF
    iconOn: '[data-qa="huddle_video_icon_camera_on"]', // present when ON
  },

  // -------------------------------------------------------------------------
  // Microphone — label is the action you'd take. No aria-pressed; state reads
  // off the aria-label (localized) for now. Keyboard: Cmd+Shift+Space.
  // -------------------------------------------------------------------------
  mic: {
    button: 'button[data-qa="segmented-mute-button-main"]',
    labelMute: 'Mute microphone', // shown when UNMUTED (click to mute)
    labelUnmute: 'Unmute microphone', // shown when MUTED (click to unmute)
    key: { code: 'Space', metaKey: true, shiftKey: true },
  },

  // -------------------------------------------------------------------------
  // Leave the huddle. Keyboard fallback: Option+Shift+H (Alt+Shift+KeyH).
  // -------------------------------------------------------------------------
  leave: {
    button: 'button[data-qa="huddle_toolbar__leave_button"]', // aria-label "Leave Huddle"
    key: { code: 'KeyH', altKey: true, shiftKey: true },
  },

  // -------------------------------------------------------------------------
  // "More actions" (⋯) toolbar menu — the gateway to captions.
  // -------------------------------------------------------------------------
  moreActions: {
    button: 'button[data-qa="huddle_toolbar_menu_button"]', // aria-label "More actions"
  },

  // -------------------------------------------------------------------------
  // Captions. Enable flow: More actions → "Show captions" → "Side-by-side".
  // Side-by-side renders a persistent, attributed, scrollable transcript column
  // (#264) — much easier to scrape than an ephemeral overlay.
  // -------------------------------------------------------------------------
  captions: {
    showCaptionsItemText: 'show captions', // submenu item, matched on lowercased text
    sideBySideButton: 'button[data-qa="huddle_sidebar_footer_buttons_feedback_menu"]',
    sideBySideLabelPrefix: 'Side-by-side', // aria-label "Side-by-side (opens in a new window)"
    // The transcript panel + list, once captions are on.
    panel: '[data-qa="tabs_content_container"][aria-label="Captions"]',
    transcriptList: '[data-qa="slack_kit_list"][aria-label="Transcript"]',
    // One utterance: speaker name + transcription text.
    eventContent: '.p-huddle_event_log__event_content',
    speakerName: '.p-huddle_event_log__member_name',
    transcription: '[data-qa="huddle_transcribe_event"]',
  },

  // -------------------------------------------------------------------------
  // Side-panel tabs: Captions vs Thread (Slack's name for huddle chat).
  // -------------------------------------------------------------------------
  tabs: {
    captions: 'button[data-qa="tabs_item"][id="captions"]',
    thread: 'button[data-qa="tabs_item"][id="threads"]',
    activeClass: 'c-tabs__tab--active',
    selectedAttr: 'aria-selected', // "true" on the active tab
  },

  // -------------------------------------------------------------------------
  // Chat — Slack calls huddle chat the "Thread" tab. Read & send.
  // -------------------------------------------------------------------------
  chat: {
    // Thread side-panel (Slack's name for huddle chat) — aria-label localized.
    threadPanel: '[data-qa="tabs_content_container"][aria-label="Thread"]',
    // Compose box: a Quill contenteditable inside the message_input container.
    inputContainer: '[data-qa="message_input"]',
    editor: '[data-qa="texty_input"]', // role=textbox, contenteditable (Quill)
    sendButton: '[data-qa="texty_send_button"]', // aria-disabled="true" until there's text
    sendDisabledAttr: 'aria-disabled',
    // One message row, with a stable per-message id (data-msg-ts) for dedup.
    messageContainer: '[data-qa="message_container"]',
    msgTsAttr: 'data-msg-ts',
    // Within a row: sender info appears on the FIRST message of a run only;
    // later messages from the same sender omit it — carry it forward (same
    // pattern as Meet's chat headers). Text body is data-qa="message-text".
    senderNameButton: '[data-qa="message_sender_name"]', // text = display name
    senderIdAttr: 'data-message-sender', // stable userId on the sender button
    messageText: '[data-qa="message-text"]',
  },

  // -------------------------------------------------------------------------
  // Participant roster + speaking signal — both present in the DOM (#264),
  // so Slack maps to Meet's tile model rather than caption-reconstruction.
  // -------------------------------------------------------------------------
  participants: {
    tile: '.p-huddle_peer_tile', // one per participant (role=gridcell)
    // Name: parse the tile's aria-label "View <Name>'s profile". Brittle-ish
    // (display-string), but it's what's on the tile; the caption member_name is
    // the clean cross-check for anyone who has spoken.
    nameRe: /^View (.+?)'s profile$/,
    // Stable per-user id from data-qa="huddle_peer_tile_userId_<ID>".
    userIdRe: /huddle_peer_tile_userId_(.+)$/,
    // Self tile: its gridcell id carries "-self_" (e.g. huddle-grid-gridcell-self_<ID>).
    selfIdMarker: '-self_',
    // Speaking: an overlay child that exists ONLY while the participant talks —
    // a direct, debounce-free signal (unlike Meet's mutation-rate heuristic).
    speakingOverlay: '.p-huddle_peer_tile__overlay--active_speaker',
  },

  // -------------------------------------------------------------------------
  // Generic role hooks for menu navigation.
  // -------------------------------------------------------------------------
  menu: {
    item: '[role="menuitem"], [role="menuitemcheckbox"], .c-menu_item__button, .c-menu_item__label',
  },
};

// Parse a participant display name from a tile's aria-label. Returns null on
// no match (e.g. a non-tile element or a future label format).
SLACK.participantName = (ariaLabel) => {
  const m = (ariaLabel || '').match(SLACK.participants.nameRe);
  return m ? m[1] : null;
};

// True if a window title marks an active huddle ("Huddle: …"). The popup is
// about:blank, so this title check (read in-process, main side) is how we
// detect the live huddle — the Slack analog of Meet's URL check.
SLACK.isHuddleWindowTitle = (title) => (title || '').trim().startsWith(SLACK.huddle.windowTitlePrefix);

// Parse a main-window /client/<team>/<channel> URL → { team, channel } (or null).
SLACK.parseClientUrl = (url) => {
  const m = (url || '').match(SLACK.huddle.clientUrlRe);
  return m ? { team: m[1], channel: m[2] } : null;
};

// Build the main-window URL to navigate to a given channel.
SLACK.buildClientUrl = (team, channel) => `${SLACK.huddle.clientUrlBase}/${team}/${channel}`;

module.exports = { SLACK };
