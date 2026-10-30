// call-provider.js — the CallProvider contract.
//
// Step 2 of the video-call abstraction. This file defines the provider-agnostic
// contract that the app (main.js → local-server.js → the agent HTTP API) talks
// to, so Google Meet becomes ONE backend behind it and Slack/others can slot in
// later. It is the explicit form of what is today an implicit contract: the set
// of IPC channels between main.js and preload-meet.js.
//
// Three pieces:
//   • CALL_COMMANDS — channel/action names the app sends DOWN to drive the call
//   • CALL_EVENTS   — channel names the provider sends UP as the call changes
//   • CallProvider  — the abstract base class: the semantic method + event
//                     contract a concrete provider (GoogleMeetProvider) implements
//
// Current status: both sides implement it. In each call preload a concrete
// provider (GoogleMeetProvider, ZoomProvider, TeamsProvider, SlackProvider,
// WhatsAppProvider, TelegramProvider, TwilioProvider)
// does the DOM work; in main.js a CallClient (call-client.js) implements the
// same contract over IPC, and is the only thing main.js drives the call
// through. WhatsApp, Telegram and Twilio have providers too (CallingAppProvider:
// the call itself; the incoming side, accept/decline, stays in their preloads).
//
// Pure module: no electron/DOM requires, safe to load in main OR preload.

// ---------------------------------------------------------------------------
// Wire vocabulary — the IPC channel names, today scattered as inline string
// literals on both sides of the boundary. Values copied verbatim.
// ---------------------------------------------------------------------------

// Commands: app → provider ("do this in the call"). Several ride the single
// 'extension-message' channel discriminated by an `action` (forwarded to the
// page via window.postMessage); ACTIONS captures that sub-vocabulary.
const CALL_COMMANDS = {
  extensionMessage: 'extension-message',
  ACTIONS: {
    playTts: 'play-tts',
    unmuteMic: 'unmute-mic',
    muteMic: 'mute-mic',
    cameraOn: 'camera-on',
    cameraOff: 'camera-off',
    playSpeechTest: 'play-speech-test',
    setShareAudio: 'set-share-audio',
    // Handled by page-inject's VirtualMic / STT tap on the media surface
    // (meetView; Slack's main window), not by the provider's DOM code.
    stopTts: 'stop-tts',
    resumeTts: 'resume-tts',
    startSttTap: 'start-stt-tap',
    stopSttTap: 'stop-stt-tap',
  },
  triggerScreenShare: 'trigger-screen-share',
  triggerStopSharing: 'trigger-stop-sharing',
  setStudioSound: 'set-studio-sound',
  setCaptionLanguage: 'set-caption-language',
  recoverCaptions: 'recover-captions',
  readChat: 'read-chat',
  sendChat: 'send-chat',
};

// Events: provider → app ("this changed in the call").
const CALL_EVENTS = {
  // Captions / transcript ingestion.
  captionTurns: 'caption-turns',
  captionsState: 'captions-state',
  captionsReady: 'captions-ready',
  captionStall: 'caption-stall',
  // Speaking / roster.
  speakingChanged: 'update-speaking',
  participantsUpdated: 'participants-updated',
  // Chat.
  chatUnread: 'chat-unread',
  chatResult: 'chat-result', // request/response reply to read-chat / send-chat
  captionLanguageResult: 'caption-language-result', // reply to set-caption-language
  // Side-panel state (which pane is open).
  paneState: 'pane-state',
  // Presenting / screen share.
  selfPresenting: 'self-presenting',
  someonePresenting: 'someone-presenting',
  // Every screen share in the people pane. Distinct from someonePresenting,
  // which reads the toolbar: that names ONE presenter (latest wins) and reports
  // none at all while the bot is presenting.
  screenSharesUpdated: 'screen-shares-updated',
  screenShareStopped: 'screen-share-stopped',
  screenShareError: 'screen-share-error',
  // Mic / TTS / lifecycle.
  micMuteChanged: 'mic-mute-changed',
  ttsEnded: 'tts-ended',
  botJoinedCall: 'bot-joined-call',
  statusUpdate: 'meet-status-update',
};

// Bootstrap values a provider pulls FROM the app at startup (ipcRenderer.invoke
// today). A provider needs these to join correctly; kept distinct from commands.
const CALL_BOOTSTRAP = {
  getBotName: 'get-meet-bot-name',
  getMode: 'get-meet-mode', // 'guest' | 'account'
  getConfig: 'get-config',
  getScreenShareSource: 'get-screen-share-source',
};

// ---------------------------------------------------------------------------
// Capabilities: what a platform can do, as opposed to how.
//   captions  the platform transcribes the call itself, so PlatformCaptions can
//             hear it (caption-source.js, #850). Without it the bot hears
//             through the audio tap and its own STT.
//   video     the bot can show its camera (the avatar)
//   chat      the call has a chat the bot can read and send to
//   share     the bot can share a screen (its whiteboard)
//
// Keyed by provider id (each class's static id). 'meet' is the short name
// main.js uses for Google Meet in status broadcasts.
// ---------------------------------------------------------------------------
const ALL = Object.freeze({ captions: true, video: true, chat: true, share: true });
const PROVIDER_CAPABILITIES = {
  'google-meet': ALL,
  meet: ALL,
  slack: ALL,
  zoom: ALL,
  teams: ALL,
  // Calling apps (Phase 1 step 4): no platform captions. WhatsApp chat is the
  // caller's 1:1 chat (none on a call-link call). Telegram Web can't add
  // video as the answering side (#889). A phone call is audio only.
  whatsapp: Object.freeze({ captions: false, video: true, chat: true, share: true }),
  telegram: Object.freeze({ captions: false, video: false, chat: true, share: false }),
  twilio: Object.freeze({ captions: false, video: false, chat: false, share: false }),
};
const NO_CAPABILITIES = Object.freeze({ captions: false, video: false, chat: false, share: false });

function providerCapabilities(providerId) {
  return PROVIDER_CAPABILITIES[providerId] || NO_CAPABILITIES;
}

// ---------------------------------------------------------------------------
// CallProvider — abstract base. A concrete provider (GoogleMeetProvider) owns
// the platform-specific automation (DOM for Meet; an API/socket for Slack) and
// implements every method below. Commands are async and resolve when the action
// is confirmed (or reject on failure). Events are emitted via the EventEmitter
// surface (`provider.on(CALL_EVENTS.x, handler)`), letting main.js subscribe
// without knowing how the provider detects each change.
//
// Method semantics are pinned to the channel each one maps to TODAY, so the
// Meet implementation is a faithful wrapper of the existing preload behavior.
// ---------------------------------------------------------------------------

class CallProvider {
  /** Human-readable provider id, e.g. 'google-meet'. */
  static get id() { return 'abstract'; }
  /** What this platform can do; see PROVIDER_CAPABILITIES. */
  static get capabilities() { return providerCapabilities(this.id); }

  notImplemented(method) {
    throw new Error(`${this.constructor.name}.${method}() not implemented`);
  }

  // --- Lifecycle -----------------------------------------------------------
  /** Join the call as `botName`. Resolves once admitted (in-call toolbar up). */
  async join(/* botName */) { this.notImplemented('join'); }
  /** Leave the call. */
  async leave() { this.notImplemented('leave'); }

  // --- Audio / video -------------------------------------------------------
  /** Mute (true) or unmute (false) the bot's mic. Maps to mute-mic/unmute-mic. */
  async setMicMuted(/* muted */) { this.notImplemented('setMicMuted'); }
  /** Turn the bot camera on (true) / off (false). Maps to camera-on/camera-off. */
  async setCameraOn(/* on */) { this.notImplemented('setCameraOn'); }
  /** Play TTS audio out through the bot's mic. Maps to the play-tts action. */
  async speak(/* payload */) { this.notImplemented('speak'); }
  /** Toggle Meet's "Studio sound" voice filter (off lets music/SFX through). */
  async setStudioSound(/* enabled */) { this.notImplemented('setStudioSound'); }
  // Caption language is how the bot HEARS (it reads Meet's caption region), so a
  // provider without captions has nothing to set — Slack overrides this to say so.
  async setCaptionLanguage(/* language */) { this.notImplemented('setCaptionLanguage'); }

  // --- Captions / listening ------------------------------------------------
  /** Ensure captions are on. Provider streams transcript via captionTurns. */
  async enableCaptions() { this.notImplemented('enableCaptions'); }
  /** Rebuild a frozen caption stream (self-heal after a confirmed stall). */
  async recoverCaptions() { this.notImplemented('recoverCaptions'); }

  // --- Chat ----------------------------------------------------------------
  /** Read chat messages. Resolves to [{ id, sender?, text }]. Maps to read-chat. */
  async readChat() { this.notImplemented('readChat'); }
  /** Send a chat message. Resolves true if confirmed sent. Maps to send-chat. */
  async sendChat(/* text */) { this.notImplemented('sendChat'); }

  // --- Screen share --------------------------------------------------------
  /** Start sharing. type: 'screen' | 'window'. Maps to trigger-screen-share. */
  async startShare(/* type */) { this.notImplemented('startShare'); }
  /** Stop sharing. Maps to trigger-stop-sharing. */
  async stopShare() { this.notImplemented('stopShare'); }
  /** Silence (true) / restore (false) the shared surface's audio for the call. */
  async setShareAudioMuted(/* muted */) { this.notImplemented('setShareAudioMuted'); }

  // --- Roster snapshot -----------------------------------------------------
  /** Current participants: [{ name, speaking, isSelf }]. */
  getParticipants() { this.notImplemented('getParticipants'); }

  // --- Events --------------------------------------------------------------
  // A provider emits the CALL_EVENTS channels above. main.js subscribes via
  // provider.on(channel, handler). Concrete providers mix in an EventEmitter
  // (or wrap ipcMain) to satisfy on/off/emit — the base class only documents
  // the surface so every backend agrees on the same event vocabulary.
  on(/* channel, handler */) { this.notImplemented('on'); }
  off(/* channel, handler */) { this.notImplemented('off'); }
}

module.exports = {
  CallProvider, CALL_COMMANDS, CALL_EVENTS, CALL_BOOTSTRAP,
  PROVIDER_CAPABILITIES, providerCapabilities,
};
