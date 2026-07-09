// meet-selectors.js — Google Meet DOM coupling, centralized.
//
// Every Meet-specific literal that preload-meet.js keys off of lives here:
// CSS selectors, aria-label / button text, URL patterns, and the structural
// regexes that read Meet's UI. This is the explicit, swappable surface of the
// "Google Meet" video-call provider — the first step toward a CallProvider
// abstraction where Meet is one backend among others (Slack, etc.).
//
// Pure data plus tiny pure string helpers. NO DOM access, NO side effects, NO
// requires — safe to load in the preload (contextIsolation: false) and, later,
// in a Node-side provider module.
//
// Convention: scalar constants for point lookups (so call sites stay a 1:1
// swap), arrays only where the existing code already iterates a list. Strings
// are copied byte-for-byte from the original inline literals — including the
// case-insensitive `i` flag inside attribute selectors — so this extraction is
// behavior-preserving.

const MEET = {
  // -------------------------------------------------------------------------
  // URLs / navigation
  // -------------------------------------------------------------------------
  url: {
    host: 'meet.google.com',
    // A real meeting code path: /abc-defg-hij (three-four-three letters).
    meetingCodePath: /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i,
    // Google sign-in redirect (logged-out meet.google.com lands here).
    signInPage: /accounts\.google\.com|ServiceLogin|signin/i,
  },

  // -------------------------------------------------------------------------
  // Microphone — Meet's toggle swaps aria-label + data-is-muted together.
  // -------------------------------------------------------------------------
  mic: {
    button: 'button[data-is-muted][aria-label*="microphone" i]',
    anyButton: 'button[data-is-muted]',
    mutedAttr: 'data-is-muted',
    labelOn: 'Turn off microphone', // label shown when the mic is ON
    labelOff: 'Turn on microphone', // label shown when the mic is OFF
  },

  // -------------------------------------------------------------------------
  // Camera — label is the action you'd take, so it reveals current state.
  // -------------------------------------------------------------------------
  camera: {
    onButton: 'button[aria-label="Turn off camera"]', // present when camera ON
    offButton: 'button[aria-label="Turn on camera"]', // present when camera OFF
  },

  // -------------------------------------------------------------------------
  // Captions (CC). Bilingual labels: Meet localizes to the account locale.
  // -------------------------------------------------------------------------
  captions: {
    region: 'div[role="region"][aria-label="Captions"]',
    enableLabelEn: 'Turn on captions', // click to enable
    enableLabelEs: 'Activar subtítulos',
    disableLabelEn: 'Turn off captions', // present (clickable) only when CC is ON
    disableLabelEs: 'Desactivar subtítulos',
    // Direct querySelector form of the "captions are on" check.
    onSelector: '[aria-label="Turn off captions" i]',
    // Caption "speaker" label Meet uses for the bot's own TTS — filtered out
    // (we record our own speech authoritatively elsewhere). Distinct from the
    // people-tile "(You)" marker.
    selfSpeaker: 'You',
  },

  // -------------------------------------------------------------------------
  // Chat — read & send. Sender headers / message bodies detected structurally.
  // -------------------------------------------------------------------------
  chat: {
    toggle: 'button[aria-label^="Chat with everyone" i], [role="button"][aria-label^="Chat with everyone" i]',
    // The chat input renders DIFFERENTLY depending on the account/chat-history
    // setting, so match BOTH shapes and never rely on the aria-label (Meet sets
    // it to "Send a message" OR "History is on" depending on state):
    //   • history OFF → a real <textarea> (match by the stable maxlength=4000)
    //   • history ON  → a contenteditable div role="textbox" aria-multiline
    // The Ask-Gemini box is role="combobox" (not textbox), so it's excluded.
    // Typing/clearing must handle the contenteditable case (see typeIntoInput /
    // inputText) since a contenteditable div has no .value.
    input: 'textarea[maxlength="4000"], [contenteditable="true"][role="textbox"][aria-multiline="true"]',
    sendLabelA: 'Send a message',
    sendLabelB: 'Send message',
    unreadRe: /new message/i,
    messageBody: '[data-message-id]',
    messageIdAttr: 'data-message-id',
    pinMessageRe: /pin message/i,
    // A sender-header timestamp like "2:32 PM".
    timestampRe: /^\d{1,2}:\d{2}\s*([AP]\.?M\.?)?$/i,
  },

  // -------------------------------------------------------------------------
  // People pane — the source the speaker tracker reads.
  // -------------------------------------------------------------------------
  people: {
    tile: 'div[role="listitem"][aria-label]',
    // The People pane has multiple sections: "Contributors"/in-call, plus
    // "Also invited" (invited, not joined) and "Waiting to be admitted" (lobby).
    // Only the in-call section's tiles are real participants. Meet wraps them in
    // a region labelled "In call" — scope participant scanning to it so invited /
    // knocking people aren't counted as present (#276).
    inCallRegion: '[role="region"][aria-label="In call" i]',
    labelledButton: '[role="button"][aria-labelledby]',
    buttonFallback: 'button[aria-label^="People" i], [role="button"][aria-label^="People" i]',
    labelPrefix: 'People',
    selfMarker: '(You)', // text node next to the bot's own display name
  },

  // -------------------------------------------------------------------------
  // Present / screen share. Toolbar button cycles through label states; both
  // aria-label and data-tooltip carry the text depending on Meet's build.
  // -------------------------------------------------------------------------
  present: {
    idleRe: /^(?:Share screen|Present now)$/i,
    someoneElseRe: /(.+?)\s+is presenting$/i,
    selfRe: /^You are presenting$/i,
    // "Already presenting" / stop-share affordances (any of these = sharing).
    // Individual variants preserve the original `||` priority order where a
    // specific element is returned and clicked; the combined form is for the
    // boolean "is anything stop-able present" check (a single querySelector,
    // matching the original combined selector used in clickPresentNow's wait).
    stopAriaPresenting: '[aria-label*="Stop presenting" i]',
    stopAriaSharing: '[aria-label*="Stop sharing" i]',
    stopTooltipPresenting: '[data-tooltip*="Stop presenting" i]',
    stopTooltipSharing: '[data-tooltip*="Stop sharing" i]',
    stopSelector:
      '[aria-label*="Stop presenting" i], [aria-label*="Stop sharing" i], [data-tooltip*="Stop presenting" i], [data-tooltip*="Stop sharing" i]',
    // Share-picker options (text). Window-share falls back to full-screen.
    pickerEntireScreenA: 'Your entire screen',
    pickerEntireScreenB: 'Entire screen',
    pickerWindow: 'A window',
    // Intermittent share-failure modal.
    errorTexts: ["Can't share your screen", 'Something went wrong when screen sharing'],
    // Its dismiss affordances: aria-labelled close, else an "Ok"/"OK" button.
    errorDismissSelector: '[aria-label="Close" i], [aria-label="Dismiss" i], [aria-label="Got it" i]',
    okTextA: 'Ok',
    okTextB: 'OK',
  },

  // -------------------------------------------------------------------------
  // Studio sound (voice filter): ⋮ → Settings → Audio → toggle → Close.
  // -------------------------------------------------------------------------
  studioSound: {
    // EXACT match — substring would also hit per-participant "More options for <name>".
    moreOptions: 'button[aria-label="More options" i], [role="button"][aria-label="More options" i]',
    moreOptionsLabelEn: 'More options',
    moreOptionsLabelEs: 'Más opciones',
    toggle: '[role="switch"][aria-label*="Studio sound" i], [aria-label*="Studio sound" i]',
    audioTab: '[role="tab"][aria-label*="Audio" i]',
    audioTabText: 'audio', // left-nav item whose text is exactly "Audio"
    settingsText: 'settings', // menu item whose text starts with "Settings"
    closeDialogLabel: 'Close dialog',
    closeDialogSelector: '[role="dialog"] [aria-label*="Close" i]',
  },

  // -------------------------------------------------------------------------
  // Join / admission flow.
  // -------------------------------------------------------------------------
  join: {
    // Pre-join "Your name" guest input — three forms, tried in order.
    nameInputs: [
      'input[placeholder="Your name"]',
      'input[aria-label="Your name"]',
      'input[autocomplete="name"]',
    ],
    // CC-diagnostics' looser "is there a name input" probe.
    nameInputLoose: 'input[aria-label*="name" i], input[placeholder*="name" i]',
    joinTextAsk: 'Ask to join',
    joinTextNow: 'Join now',
    // When the meeting's scheduled start is in the future, Meet warns "This
    // meeting hasn't started" and the join button reads "Join anyway" instead
    // of "Join now". Same action — let the bot through.
    joinTextAnyway: 'Join anyway',
    joinTextSwitch: 'Switch here', // direct-join when the account has a lingering presence
    joinLabel: 'Join',
    // Dialogs to dismiss before the join button on the pre-join screen.
    dismissTexts: ['Got it', 'Dismiss', 'OK', 'Allow', 'Close', 'No thanks', 'Not now'],
    gotItText: 'Got it',
    leaveCallLabel: 'Leave call', // in-call ground truth
    leaveCallTooltip: '[data-tooltip="Leave call"]',
    // AI-recording disclosure dialog (premium calls) — heading match.
    recordingConsentTexts: ['being recorded', 'recorded and transcribed', 'taking notes'],
    // Denial / removal pages.
    denialCantJoin: "You can't join this video call",
    denialRemoved: 'You have been removed from the meeting',
    // "Waiting to be admitted" body text.
    // #330/#376: matched case-INSENSITIVELY (see google-meet-provider.js), so
    // keep these lowercase. Cover Google Meet's lobby-banner variants: "Asking to
    // be let in", "Please wait until the host lets you in", "You'll join the call
    // when someone lets you in", etc.
    waitingTexts: [
      'wait until',
      'asking to be let in',
      'please wait',
      "you'll join the call when",
      'someone lets you in',
      'lets you in',
      'let you in',
    ],
  },

  // -------------------------------------------------------------------------
  // Modals / dialogs.
  // -------------------------------------------------------------------------
  modals: {
    gotItText: 'got it', // catch-all dismiss for Meet info modals (lowercased compare)
    // Headings we recognize — for clearer logging only, NOT a gate.
    knownHeadings: [
      'others may see your video differently',
      'your screen may not appear',
      'may not appear to others',
    ],
    anyDialog: '[role="dialog"][aria-modal="true"], [aria-modal="true"], [role="dialog"]',
    dialogOrModal: '[role="dialog"][aria-modal="true"], [role="dialog"]',
    // The recording dialog's "Join now" affordance (Material dialog ok action).
    recordingOkButton: 'button[data-mdc-dialog-action="ok"]',
    // "Ready to present? / This will end your existing presentation" — Meet
    // raises this when a share is triggered while a presentation is already
    // active (a redundant start_share that slipped past the alreadyPresenting
    // guard). We match on the distinctive body phrase (so it only ever fires on
    // the TAKEOVER variant, never a legit first-share confirmation) and click
    // Cancel to KEEP the current presentation rather than tear down the board.
    presentTakeoverMarker: 'existing presentation',
    presentTakeoverCancelText: 'cancel',
    // #404: Meet's free-tier time-limit warning — a toast-style dialog
    // (role=dialog, data-is-auto-hide) with aria-label/heading "Your call ends
    // in N minutes" and body "Free group calls have a limit of 1 hour". DOM
    // captured live in the 2026-07-07 Kate call. Matched generically on the
    // minutes phrase so the later/final warnings (5 min, 1 min) hit too.
    callEndsRe: /call ends in (\d+) minute/i,
    dismissText: 'dismiss', // its only button (lowercased compare)
  },
};

// Tiny pure helper: the aria-label selector findByAriaLabel() builds. Kept here
// so the selector shape (button + role=button, substring, case-insensitive)
// stays with the rest of the Meet coupling. Mirrors the original inline literal.
MEET.ariaLabelSelector = (label) =>
  `button[aria-label*="${label}" i], [role="button"][aria-label*="${label}" i]`;

module.exports = { MEET };
