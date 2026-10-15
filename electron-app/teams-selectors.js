// teams-selectors.js — Microsoft Teams web client DOM coupling, centralized.
//
// The Teams analog of meet-selectors.js / slack-selectors.js / zoom-selectors.js.
// Sourced from live recon (Stan + Claude, 2026-10-15): Stan hosting a meeting
// on his PERSONAL account (teams.live.com), Claude joining as an anonymous
// guest from a plain browser. A work-tenant (teams.microsoft.com) meeting is
// still to come; tenant policy can change the lobby, guest captions and more.
//
// Teams is the friendliest of the four to automate: most controls carry a
// stable `data-tid` (like Slack's data-qa), and the toolbar buttons have stable
// ids (#mic-button, #hangup-button, ...). Prefer those over aria-labels, which
// are localized and sometimes describe device state ("No audio devices
// available") rather than the action.
//
// Pure data + tiny pure helpers. No DOM access, no requires.
//
// SURFACE NOTE. The meeting renders TOP-LEVEL (no iframe), at
// teams.live.com/light-meetings/launch?...&anon=true for a guest. The invite
// link first lands on a launcher page that offers "Continue on this browser".

const TEAMS = {
  // -------------------------------------------------------------------------
  // URLs. Invite forms seen / documented:
  //   personal: https://teams.live.com/meet/<13 digits>?p=<passcode>   (verified)
  //   work:     https://teams.microsoft.com/meet/<digits>?p=<passcode>  (TBD verify)
  //   work:     https://teams.microsoft.com/l/meetup-join/19%3ameeting_<id>%40thread.v2/0?context=...
  // -------------------------------------------------------------------------
  url: {
    hosts: ['teams.live.com', 'teams.microsoft.com'],
    meetCodeRe: /\/meet\/(\d{6,20})/, // capture: the meeting code
    meetupJoinRe: /\/l\/meetup-join\/19(?:%3a|:)meeting_([^%@/]+)(?:%40|@)thread\.v2/i, // capture: thread id
  },

  // -------------------------------------------------------------------------
  // Launcher ("Join your Teams meeting"), verified: two buttons with data-tid.
  // -------------------------------------------------------------------------
  launcher: {
    joinOnWeb: 'button[data-tid="joinOnWeb"]', // "Continue on this browser"
    joinInApp: 'button[data-tid="joinInApp"]',
  },

  // -------------------------------------------------------------------------
  // Pre-join (guest), verified. Join stays DISABLED until a name is typed.
  // The camera/mic toggles are checkboxes (input[type=checkbox]).
  // -------------------------------------------------------------------------
  prejoin: {
    nameInput: 'input[data-tid="prejoin-display-name-input"]',
    joinButton: 'button[data-tid="prejoin-join-button"]', // id prejoin-join-button
    cancelButton: 'button[data-tid="prejoin-cancel-button"]',
    videoToggle: 'input[data-tid="toggle-video"]',
    micToggle: 'input[data-tid="toggle-mute"]',
    computerAudioRadio: 'input[type="radio"][aria-label="Computer audio"]',
    // Shown when the browser denies camera/mic; the app grants media, so the
    // bot shouldn't see it, but it blocks typing if it does.
    noMediaContinueText: 'Continue without audio or video',
    signInLink: 'button[data-tid="auth-sign-in-link"]',
  },

  // Lobby, verified: "Hi, <name>. Someone will let you in shortly."
  lobby: {
    texts: ['someone will let you in shortly', 'let you in soon'],
  },

  // -------------------------------------------------------------------------
  // In-meeting toolbar, verified: stable ids. Mic/camera aria-labels seen only
  // with NO devices ("No audio devices available"); the muted/unmuted labels
  // need recon from the Electron bot, which has a (virtual) mic.
  // -------------------------------------------------------------------------
  toolbar: {
    chat: '#chat-button',
    people: '#roster-button', // text "2People" — count + label
    raise: '#raisehands-button',
    react: '#reactions-menu-button',
    view: '#custom-view-button',
    more: '#callingButtons-showMoreBtn',
    camera: '#video-button',
    mic: '#mic-button',
    share: '#screenshare-button',
    leave: '#hangup-button', // one click, no confirm (verified)
  },
  // The mic button's aria-label is the ACTION, no aria-pressed (verified in the
  // bot, 2026-10-15): "Mute mic" while live, so "Unmute mic" while muted.
  micLabelMute: 'mute mic',
  micLabelUnmute: 'unmute mic',
  // #screenshare-button's aria-label is "Share", then "Stop sharing" while
  // the bot shares (verified 2026-10-15). Teams did NOT mute the mic for the
  // share's audio, unlike Zoom.
  shareLabelStop: 'stop sharing',
  // Presence of the toolbar's hang-up button = in the meeting.
  inMeetingMarker: '#hangup-button',

  // More menu, verified: role=menuitem with stable ids.
  more: {
    captions: '#closed-captions-button', // toggles live captions; guest CAN use it
    meetingInfo: '#meeting-info-button',
    devices: '#device-settings-button',
  },

  // -------------------------------------------------------------------------
  // Captions, verified. A persistent, virtualized LIST (like Meet's caption
  // pane, unlike Zoom's single fading line), and every entry names its
  // speaker in the DOM. One entry = a small group holding exactly one author
  // and one text node.
  // -------------------------------------------------------------------------
  captions: {
    window: '[data-tid="closed-caption-v2-window-wrapper"]',
    list: '[data-tid="closed-caption-v2-virtual-list-content"]',
    author: '[data-tid="author"]',
    text: '[data-tid="closed-caption-text"]',
  },

  // -------------------------------------------------------------------------
  // Chat, verified. CKEditor 5 compose + a Send button.
  // -------------------------------------------------------------------------
  chat: {
    // NOT [contenteditable="true"]: in the bot's view the editor div didn't
    // carry it until focused (live, 2026-10-15), so that selector missed it.
    editor: '[data-tid="ckeditor"]', // role=textbox, "Type a message"
    sendButton: 'button[data-tid="newMessageCommands-send"]',
    item: '[data-tid="chat-pane-item"]',
    message: '[data-tid="chat-pane-message"]',
    author: '[data-tid="message-author-name"]',
  },

  // -------------------------------------------------------------------------
  // Participants / stage, verified (2 people). Video tiles are keyed by display
  // name in data-tid; voice-level-stream-outline looks like a per-person
  // speaking indicator (TBD verify it tracks speech).
  // -------------------------------------------------------------------------
  stage: {
    tileByNamePrefix: 'video-item-container-', // data-tid="video-item-container-<Name>"
    // On EVERY tile all the time (live, 2026-10-15) — its presence is not a
    // speaking signal. What changes on it while someone talks is TBD.
    speakingOutline: '[data-tid="voice-level-stream-outline"]',
    // Someone sharing (verified 2026-10-15, Stan sharing a terminal): a stream
    // element whose data-tid IS the presenter's display name, inside their
    // video-item-container. aria-label "Shared content view".
    screenShare: '[data-stream-type="ScreenSharing"]',
  },

  // Teams records its client classification in these cookies (seen:
  // platformId=1415 after a visit that exposed window.process) and its
  // launcher redirects on them server-side. Cleared before every join.
  platformCookies: ['platformId', 'platformParams'],

  // After Leave, verified: "Did you leave by mistake? Rejoin the call".
  leftTexts: ['did you leave by mistake', 'rejoin the call'],
};

function hostOk(u) {
  const h = u.hostname.toLowerCase();
  return TEAMS.url.hosts.some((x) => h === x || h.endsWith('.' + x));
}

// True for a Teams meeting invite link (either /meet/ or /l/meetup-join/).
TEAMS.isTeamsUrl = (url) => {
  try {
    const u = new URL(url);
    return hostOk(u) && TEAMS.meetingKeyFromUrl(url) !== null;
  } catch {
    return false;
  }
};

// A stable key for the meeting: the numeric /meet/ code, or the meetup-join
// thread id. Null if neither is present.
TEAMS.meetingKeyFromUrl = (url) => {
  const s = String(url || '');
  const m = s.match(TEAMS.url.meetCodeRe);
  if (m) return m[1];
  const t = s.match(TEAMS.url.meetupJoinRe);
  return t ? t[1] : null;
};

// The LIGHT guest client URL for a /meet/<code>?p=<passcode> invite — the bot
// loads this directly instead of the invite. The launcher's "Continue on this
// browser" sometimes routes to the full v2 app, which detects Electron and
// redirects to /error/eoa ("Classic Teams is no longer available"); the light
// client never did (live, 2026-10-15). Format copied from the URL a real
// browser lands on: coords = base64 JSON { meetingUrl, meetingCode, passcode }.
// Null for links without a /meet/ code (classic meetup-join), which still go
// through the launcher.
TEAMS.lightMeetingUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!hostOk(u)) return null;
  const m = u.pathname.match(TEAMS.url.meetCodeRe);
  if (!m) return null;
  const code = m[1];
  const passcode = u.searchParams.get('p') || '';
  const meetingUrl = `https://${u.hostname}/meet/${code}` + (passcode ? `?p=${passcode}&anon=true` : '?anon=true');
  const json = JSON.stringify({ meetingUrl, meetingCode: code, passcode });
  const coords = typeof Buffer !== 'undefined' ? Buffer.from(json, 'utf8').toString('base64') : btoa(json);
  const q = new URLSearchParams();
  if (passcode) q.set('p', passcode);
  q.set('anon', 'true');
  q.set('agent', 'web');
  q.set('coords', coords);
  return `https://${u.hostname}/light-meetings/launch?${q.toString()}`;
};

// Room code for the local server and vibeconferencing.com: teams-<key>, as a
// valid [a-z0-9-] slug (thread ids are base64-ish, so fold and cap them).
TEAMS.roomCodeFromUrl = (url) => {
  const key = TEAMS.meetingKeyFromUrl(url);
  if (!key) return null;
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return slug ? 'teams-' + slug : null;
};

module.exports = { TEAMS };
