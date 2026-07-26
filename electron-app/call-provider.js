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
// IMPORTANT (current status): this is the DESIGN artifact. The channel-name
// constants are byte-identical to the strings hardcoded in preload-meet.js /
// main.js today, so wiring them in (step 3) is behavior-preserving. Nothing
// imports this yet — creating it changes no behavior. GoogleMeetProvider (the
// concrete wrapper that owns the DOM automation now living in preload-meet.js)
// lands in step 3, validated by scripts/meet-test.mjs.
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
  },
  triggerScreenShare: 'trigger-screen-share',
  triggerStopSharing: 'trigger-stop-sharing',
  setStudioSound: 'set-studio-sound',
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
  // Side-panel state (which pane is open).
  paneState: 'pane-state',
  // Presenting / screen share.
  selfPresenting: 'self-presenting',
  someonePresenting: 'someone-presenting',
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

module.exports = { CallProvider, CALL_COMMANDS, CALL_EVENTS, CALL_BOOTSTRAP };
