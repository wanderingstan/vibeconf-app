// local-server.js — Local HTTP server for agent communication.
// Owns all room/transcript/whiteboard/call state for the Electron app flow;
// the MCP server talks to the local app server and never hits the public website.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const prefsSchema = require('./preferences-schema.js');
const { getRecentSessionLog, getSessionLogPath } = require('./session-log.js');

// Mime types for the whiteboard asset server (#157). Conservative list —
// images and PDFs, the formats the whiteboard markdown / window can actually
// render.
const ASSET_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
};

const DEFAULT_PORT = 7865;

// Short HH:MM:SS.mmm timestamp for emoji diagnostic logs — lets us cross-
// reference log lines with actual conversation moments. Keep it local so
// reading the log doesn't require mental clock-math.
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

class LocalServer {
  constructor({ port, appVersion, onBotSpeech, onStopTts, onWhiteboardUpdate, onLeaveCall, onShareWhiteboard, onStopSharing, onLoadUrl, onJoinCall, onBotStateChange, onModeChange, onCallStatusChange, onAnyoneSpeakingChange, onParticipantsFirstSeen, onAvatarEmojiOverride, onSetCamera, onCaptureScreenshot, onReadChat, onSendChat, onScrollShare, getWebsiteUrl, getWhiteboardLoadedUrl, getPref, setPref, applyPref } = {}) {
    this.port = port || DEFAULT_PORT;
    this.appVersion = appVersion || null;
    this.onBotSpeech = onBotSpeech || (() => {});
    this.onStopTts = onStopTts || (() => {});
    this.onWhiteboardUpdate = onWhiteboardUpdate || (() => {});
    this.onLeaveCall = onLeaveCall || (() => {});
    this.onShareWhiteboard = onShareWhiteboard || (() => {});
    this.onStopSharing = onStopSharing || (() => {});
    this.onJoinCall = onJoinCall || (() => {});
    this.onLoadUrl = onLoadUrl || (() => {});
    this.onScrollShare = onScrollShare || (async () => ({ ok: false, error: 'not implemented' }));
    this.onBotStateChange = onBotStateChange || (() => {}); // 'idle' | 'listening' | 'thinking' | 'speaking' | 'yielding'
    this.onModeChange = onModeChange || (() => {});        // 'active' | 'passive' | 'silent'
    this.onCallStatusChange = onCallStatusChange || (() => {}); // 'idle' | 'joining' | 'waiting-to-be-admitted' | 'in-call' | 'left'
    this.onAnyoneSpeakingChange = onAnyoneSpeakingChange || (() => {}); // boolean
    this.onParticipantsFirstSeen = onParticipantsFirstSeen || (() => {}); // fires once per call when DOMSpeakerTracker first reports participants
    this.onAvatarEmojiOverride = onAvatarEmojiOverride || (() => {}); // ({idle?, listening?}) — null/undefined for that key means reset
    this.onSetCamera = onSetCamera || (() => {}); // (on: boolean)
    this.onCaptureScreenshot = onCaptureScreenshot || (async () => ({ error: 'not implemented' }));
    this.onReadChat = onReadChat || (async () => ({ ok: false, error: 'not implemented' }));
    this.onSendChat = onSendChat || (async () => ({ ok: false, error: 'not implemented' }));
    this.getWebsiteUrl = getWebsiteUrl || (() => ''); // host where /room/:id renders
    // What URL is currently loaded in the whiteboard window? Surfaced so an
    // agent (or the panel) can confirm what's actually being shared — useful
    // after update_whiteboard({url}) and scroll_share (#169).
    this.getWhiteboardLoadedUrl = getWhiteboardLoadedUrl || (() => null);
    this.chatUnread = false; // passive "… - New message" signal from the chat button

    // Response-state tracking — what the bot last responded to. Used to detect
    // when a new wait window is just a continuation of an utterance the bot
    // already answered (captions grow progressively across windows), so the
    // agent can avoid double-responding to the same thought.
    this.lastRespondedSpeaker = null;
    this.lastRespondedText = null;

    // Pending bot speech — queued when speak() is called before the bot is
    // actually admitted to the call. Flushed in setCallStatus when status
    // becomes 'in-call'. Without this, audio plays through the virtual mic
    // before Meet has connected our stream and goes into the void.
    this.pendingBotSpeech = []; // [{ text, voice }]

    // Preference plumbing (whitelist defined in preferences-schema.js).
    // getPref reads from the persistent store; setPref writes; applyPref runs
    // any side-effect needed to make the change live (e.g. reload TTS config).
    this.getPref = getPref || (() => undefined);
    this.setPref = setPref || (() => {});
    this.applyPref = applyPref || (() => {});
    this.botState = 'idle';

    // Mode is persistent user-controlled behavior; distinct from transient botState.
    //   active  — responds freely (ack on every pause, speaks its thoughts)
    //   passive — silent until its name is mentioned
    //   silent  — listens for its name but never speaks; can still act (whiteboard, tools)
    this.mode = 'active';

    // Room state (single room — the active call)
    this.roomId = null;
    this.transcripts = [];       // { id, participantName, role, text, isFinal, timestamp, voice? }
                                 // Holds bot speech + page-inject Web Speech entries. Meet
                                 // captions live in `turns` (snapshot model, #178) and are
                                 // merged in on read via _entriesSince.
    this.turns = new Map();      // turnId(number) -> { id, speaker, text, firstSeen, lastUpdated, settled, source }
                                 // Snapshot of Meet caption children. Upserted by updateTurns.
                                 // settled=true once the child is no longer bottommost.
    this.maxTurns = 200;         // Bound the map to recent turns
    this.whiteboard = { content: '', version: 0, lastModified: null, lastEditor: null };
    this.members = [];
    this.maxTranscripts = 500;

    // Call status tracking
    this.callStatus = 'idle';    // idle, joining, waiting-to-be-admitted, in-call, left
    this.sharing = false;
    this.errors = [];            // recent errors (max 10)

    // State exposed to agents
    this.localProfile = null;   // optional app profile name for multi-agent local runs
    this.detectedMeetUrls = [];  // Meet URLs found in browser tabs (when not in a call)
    this.participants = [];      // [{ name, speaking }] from DOM speaker tracker
    this.someoneElsePresenting = false;  // another participant is screen sharing
    this.presenterName = null;   // name of the person presenting (if any)

    // Real-time speaking state (from DOMSpeakerTracker, not captions)
    this.anyoneSpeaking = false;       // true if any participant is currently speaking
    this.lastSpeechStoppedAt = null;   // timestamp (ms) when last person stopped speaking

    // Last fast-ack phrase the bot played (or null). Surfaces to the slow
    // model on its next wait_for_speech so the model can self-correct if
    // its full response contradicts the ack tone (e.g. ack was "Uh-huh"
    // but the real answer is "no, actually..."). Cleared after one read.
    this.lastAckPhrase = null;

    // Speech the bot was about to say when a human interrupted (barge-in).
    // Held for BARGE_IN_STASH_MAX_AGE_MS, then auto-replayed on the next
    // silence resolution — matches the conversational rhythm of "I raised
    // my hand, the floor opened, I speak my thought." If too stale, the
    // stash is discarded and the agent's slow model regenerates from
    // scratch instead.
    //
    // Shape: { entries: [{ text, voice, emoji }], at: ms }
    this.bargeInStash = null;
    // Texts of any stash that was replayed in the just-completed resolve.
    // Surfaced once on the next _buildResponse, then cleared, so the slow
    // model knows the queued thought already happened and can build on it
    // (or stay silent).
    this._lastReplayedStash = null;

    // Last ack decision event — phrase, source ('llm' / 'llm-fallback-builtin'
    // / 'builtin'), latency, and any error. Surfaced in the troubleshooting
    // panel so it's visible at-a-glance whether the LLM path is hitting,
    // falling back, or just skipping.
    this.lastAckEvent = null;

    // Whiteboard asset registry (#157). Bots can register a local file path
    // and get back an opaque http://127.0.0.1:PORT/asset/{token} URL they
    // can embed in update_whiteboard markdown (e.g. an image generated by an
    // external tool). The token, not the path, is what appears in the URL,
    // so file locations don't leak into the rendered markdown.
    this._whiteboardAssets = new Map(); // token -> { path, mime }

    // Barge-in / back-off (#154). When the bot is speaking and someone else
    // starts talking, wait a grace period (we want to ride out brief noise/
    // cross-talk and not cut off mid-utterance). Then decide:
    //   - human interrupter → back off (stop TTS, drop the queue).
    //   - another bot      → wait an additional random delay; if still being
    //                        interrupted, back off. With random per-bot
    //                        delays, whichever bot's timer fires first
    //                        yields, the other detects silence and continues
    //                        — emergent resolution, no deadlock.
    this.bargeInGraceMs = 2000;
    this.bargeInBotRandomMinMs = 1000;
    this.bargeInBotRandomMaxMs = 4000;
    this._bargeInTimer = null;

    // Auto-leave when alone (#145). Only fires once at least one other
    // participant has appeared in the call — guards against auto-leaving
    // immediately after admission when the people pane is still populating.
    this._sawOtherParticipant = false;
    this._autoLeaveTimer = null;
    this._autoLeaveTriggered = false;
    this.autoLeaveGraceMs = 10_000;

    // Long-poll waiters
    this.waiters = [];           // { resolve, since, bot, silence, timer }
    this.lastWaitForSpeechAt = null; // ms timestamp of the most recent wait_for_speech call

    // macOS permission status, updated by main.js. Possible values match
    // systemPreferences.getMediaAccessStatus: 'not-determined', 'granted',
    // 'denied', 'restricted', 'unknown'. 'unknown' is also used on non-darwin.
    this.permissions = {
      screenRecording: 'unknown',
    };

    this.server = null;
  }

  getLocalServerUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  setPermission(name, status) {
    if (this.permissions[name] === status) return;
    this.permissions[name] = status;
    console.log('[local-server] Permission', name + ':', status);
  }

  // -------------------------------------------------------------------------
  // Room management
  // -------------------------------------------------------------------------

  setRoom(roomId) {
    this.roomId = roomId;
    this.transcripts = [];
    this.turns = new Map();
    this.whiteboard = { content: '', version: 0, lastModified: null, lastEditor: null };
    this.members = [];
    this.sharing = false;
    this.errors = [];
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.lastSpeechStoppedAt = null;
    this.lastRespondedSpeaker = null;
    this.lastRespondedText = null;
    this._resetAutoLeave();
    this.resolveAllWaiters();
    // Use the setter so onCallStatusChange fires — the avatar uses this to
    // switch to 🫥 while joining.
    this.setCallStatus('joining');
  }

  clearRoom() {
    this.roomId = null;
    this.transcripts = [];
    this.turns = new Map();
    this.members = [];
    this.sharing = false;
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.lastSpeechStoppedAt = null;
    this.lastRespondedSpeaker = null;
    this.lastRespondedText = null;
    this._resetAutoLeave();
    this.resolveAllWaiters();
    this.setCallStatus('idle');
  }

  setCallStatus(status) {
    if (this.callStatus === status) return;
    this.callStatus = status;
    console.log('[local-server] Call status:', status);
    this.onCallStatusChange(status);

    // Drop pending speech if we never made it in (call failed / cleared).
    // Pending flush itself is gated on first-participants-seen, not in-call —
    // 'in-call' fires when Meet's UI is up, but the bot's mic track isn't
    // reliably connected to other participants until the people pane is
    // populated (a stronger 'fully wired up' signal). See _flushPendingBotSpeech.
    if (status === 'idle' || status === 'left') {
      if (this.pendingBotSpeech.length > 0) {
        console.log('[local-server] Dropping', this.pendingBotSpeech.length, 'unflushed bot speech entries (call ended)');
        this.pendingBotSpeech = [];
      }
      this._resetAutoLeave();
    }
  }

  // Register a local file as a whiteboard asset and return an opaque
  // http://127.0.0.1:PORT/asset/{token} URL (#157). Validates that the file
  // exists, is readable, and has a renderable mime type. Throws on invalid
  // input — caller maps the error to a 400.
  registerWhiteboardAsset(absPath) {
    if (!absPath || typeof absPath !== 'string') {
      throw new Error("image_path is required and must be a string");
    }
    if (!path.isAbsolute(absPath)) {
      throw new Error("image_path must be an absolute path");
    }
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      throw new Error(`image_path not found or not readable: ${absPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`image_path is not a regular file: ${absPath}`);
    }
    const ext = path.extname(absPath).toLowerCase();
    const mime = ASSET_MIME_TYPES[ext];
    if (!mime) {
      throw new Error(`Unsupported image type "${ext}" — allowed: ${Object.keys(ASSET_MIME_TYPES).join(', ')}`);
    }
    const token = crypto.randomBytes(16).toString('hex') + ext;
    this._whiteboardAssets.set(token, { path: absPath, mime });
    const url = `http://127.0.0.1:${this.port}/asset/${token}`;
    console.log(ts(), '🖼️  [asset] registered', token, '→', absPath);
    return { token, url, mime };
  }

  applyRemoteWhiteboard(whiteboard) {
    if (!whiteboard || typeof whiteboard.content !== 'string') return false;

    const incomingVersion = Number(whiteboard.version) || 0;
    const currentVersion = Number(this.whiteboard.version) || 0;
    if (incomingVersion <= currentVersion) return false;

    this.whiteboard = {
      content: whiteboard.content,
      version: incomingVersion,
      lastModified: whiteboard.lastModified || null,
      lastEditor: whiteboard.lastEditor || null,
    };

    console.log(ts(), '📝 [whiteboard] synced remote version', incomingVersion,
      'from', this.whiteboard.lastEditor || '(unknown)');
    return true;
  }

  _resetAutoLeave() {
    if (this._autoLeaveTimer) {
      clearTimeout(this._autoLeaveTimer);
      this._autoLeaveTimer = null;
    }
    this._sawOtherParticipant = false;
    this._autoLeaveTriggered = false;
  }

  _flushPendingBotSpeech() {
    if (this.pendingBotSpeech.length === 0) return;
    console.log('[local-server] Flushing', this.pendingBotSpeech.length,
      'queued bot speech entries (now playing)');
    const queue = this.pendingBotSpeech;
    this.pendingBotSpeech = [];
    for (const { text, voice, emoji } of queue) {
      console.log('[local-server] Playing queued speech:', text.slice(0, 60));
      this._setBotState('speaking', { emoji });
      this.onBotSpeech(text, voice, emoji);
    }
  }

  setMode(mode) {
    const allowed = ['active', 'passive', 'silent'];
    if (!allowed.includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Must be one of ${allowed.join(', ')}`);
    }
    if (this.mode === mode) return;
    this.mode = mode;
    console.log('[local-server] Mode:', mode);
    this.onModeChange(mode);
    // Re-evaluate any pending waiters under the new mode
    this._checkWaiters();
  }

  setSharing(sharing) {
    this.sharing = sharing;
  }

  setDetectedMeetUrls(urls) {
    this.detectedMeetUrls = urls || [];
  }

  setChatUnread(unread) {
    if (this.chatUnread === unread) return;
    this.chatUnread = unread;
    console.log('[local-server] Chat unread:', unread);
  }

  setPaneState({ chatPaneOpen, peoplePaneOpen } = {}) {
    this.chatPaneOpen = !!chatPaneOpen;
    this.peoplePaneOpen = !!peoplePaneOpen;
  }

  // Snapshot of everything the app currently believes about the call — for the
  // debug panel. Reflects the live detector state, not persisted config.
  // Record the ack phrase that just played. Read once on the next
  // wait_for_speech response and cleared, so the slow model sees
  // exactly one "previously you acked with X" hint per ack.
  setLastAckPhrase(phrase) {
    this.lastAckPhrase = phrase || null;
  }

  // Record a full ack-decision event for the troubleshooting panel.
  // Unlike setLastAckPhrase this isn't consumed by the slow model — it's
  // a live status indicator that persists until the next ack.
  setLastAckEvent(event) {
    this.lastAckEvent = event || null;
  }

  getCallStateSnapshot() {
    // Cross-reference Meet participants against registered bot members so
    // the panel can show (bot) alongside (self) (#162). Same logic the MCP
    // get_room_info tool uses; centralizing the snapshot keeps the two
    // surfaces consistent.
    const botNames = new Set(
      (this.members || [])
        .filter((m) => m.role === 'bot' && m.name)
        .map((m) => m.name.toLowerCase())
    );
    return {
      callStatus: this.callStatus,
      mode: this.mode,
      localServerUrl: this.getLocalServerUrl(),
      localServerPort: this.port,
      localProfile: this.localProfile,
      botState: this.botState,
      anyoneSpeaking: this.anyoneSpeaking,
      sharing: this.sharing,
      someoneElsePresenting: this.someoneElsePresenting,
      presenterName: this.presenterName,
      chatUnread: this.chatUnread,
      chatPaneOpen: !!this.chatPaneOpen,
      peoplePaneOpen: !!this.peoplePaneOpen,
      screenRecording: this.permissions?.screenRecording,
      roomId: this.roomId,
      whiteboardLoadedUrl: this.getWhiteboardLoadedUrl(),
      sessionLogPath: getSessionLogPath(),
      activeWaiters: this.waiters.length,
      lastAckEvent: this.lastAckEvent,
      lastWaitForSpeechAt: this.lastWaitForSpeechAt,
      pendingBotSpeech: (this.pendingBotSpeech || []).map(e => ({
        text: e.text || '',
        voice: e.voice || null,
        emoji: e.emoji || null,
      })),
      participants: (this.participants || []).map(p => ({
        name: p.name,
        speaking: !!p.speaking,
        isSelf: !!p.isSelf,
        isBot: botNames.has((p.name || '').toLowerCase()),
      })),
    };
  }

  setParticipants(participants) {
    const wasEmpty = this.participants.length === 0;
    this.participants = participants || [];

    // First time we see non-empty participants — DOMSpeakerTracker is up and
    // reading the people pane successfully. Fires once per call. Used for
    // avatar engagement (flips hasEngaged via the set-engaged IPC).
    //
    // NOT used to flush deferred bot speech — that's gated on the captions-
    // ready signal, which fires later and is a stronger 'fully wired up'
    // marker. Flushing here meant the welcome played 5s before the user
    // could actually see/hear what the bot heard.
    if (wasEmpty && this.participants.length > 0) {
      this.onParticipantsFirstSeen();
    }

    // Update real-time speaking state from DOM speaker tracker. Exclude the
    // bot itself ('You' in Meet's people pane) — when the bot speaks via TTS,
    // Meet flags 'You' as speaking, which would otherwise trigger the 😐
    // hearing emoji and make the avatar look like it's reacting to itself.
    const wasSpeaking = this.anyoneSpeaking;
    // Exclude self (the bot's own tile) — its audio meter pulses while TTS plays
    // and would otherwise keep anyoneSpeaking flipping true, cancelling the
    // silence timer. Fall back to the legacy 'You' name check for older payloads.
    this.anyoneSpeaking = this.participants.some(p => p.speaking && !p.isSelf && p.name !== 'You');

    if (wasSpeaking && !this.anyoneSpeaking) {
      // Speech just stopped — record when and check waiters
      this.lastSpeechStoppedAt = Date.now();
      const speakers = this.participants.filter(p => !p.isSelf && p.name !== 'You').map(p => p.name).join(', ') || '(unknown)';
      console.log(ts(), '🛑 [silence] User(s) stopped speaking:', speakers);
      if (this.botState === 'yielding') {
        this._setBotState(this.waiters.length > 0 ? 'listening' : 'idle', undefined, { force: true });
      }
      this._checkWaiters();
      this.onAnyoneSpeakingChange(false);
      // The interrupter went silent before our grace timer fired — drop
      // the back-off monitor (#154).
      this._clearBargeIn('interrupter went silent');
    } else if (!wasSpeaking && this.anyoneSpeaking) {
      // Speech just started — cancel any pending silence timers
      for (const waiter of this.waiters) {
        if (waiter.silenceTimer) {
          clearTimeout(waiter.silenceTimer);
          waiter.silenceTimer = null;
        }
      }
      this.onAnyoneSpeakingChange(true);
      // If the bot is mid-utterance when someone else starts speaking, arm
      // the back-off monitor (#154). _armBargeIn is a no-op if not in the
      // 'speaking' state, so we don't have to gate here.
      this._armBargeIn();
    }
    this._evaluateAutoLeave();
  }

  // Auto-leave when the bot is the only one left in the call (#145). Only
  // fires while in-call, only after at least one other participant has been
  // seen, and only after a grace period (to ride out brief Meet re-renders
  // during participant transitions).
  _evaluateAutoLeave() {
    if (this.callStatus !== 'in-call' || this._autoLeaveTriggered) {
      return;
    }
    const others = this.participants.filter(p => !p.isSelf && p.name !== 'You');
    if (others.length > 0) {
      this._sawOtherParticipant = true;
      if (this._autoLeaveTimer) {
        clearTimeout(this._autoLeaveTimer);
        this._autoLeaveTimer = null;
        console.log(ts(), '🤝 [auto-leave] cancelled — others present again');
      }
      return;
    }
    // Alone. Only arm the timer once we've ever seen company in this call.
    if (!this._sawOtherParticipant || this._autoLeaveTimer) return;
    console.log(ts(), '⏳ [auto-leave] alone in call — leaving in', this.autoLeaveGraceMs, 'ms');
    this._autoLeaveTimer = setTimeout(() => {
      this._autoLeaveTimer = null;
      this._triggerAutoLeave();
    }, this.autoLeaveGraceMs);
  }

  _triggerAutoLeave() {
    if (this._autoLeaveTriggered || this.callStatus !== 'in-call') return;
    this._autoLeaveTriggered = true;
    console.log(ts(), '👋 [auto-leave] firing — bot is alone, signing off');

    // Speak a brief sign-off line in active mode only. Passive/silent leave
    // quietly.
    if (this.mode === 'active') {
      try {
        this.onBotSpeech("Looks like I'm the only one here, signing off.", undefined, '👋');
      } catch (err) {
        console.warn(ts(), '[auto-leave] speak failed:', err.message);
      }
    }

    // Resolve any pending waiters with a terminal autoLeft reason so the
    // agent's wait_for_speech exits its loop instead of hanging.
    for (const w of [...this.waiters]) {
      if (w.resolved) continue;
      w.resolved = true;
      clearTimeout(w.timer);
      clearTimeout(w.silenceTimer);
      w.resolve({ success: true, autoLeft: true, asOf: new Date().toISOString(), transcript: { entries: [] } });
    }
    this.waiters = [];

    // Give the goodbye line time to play before tearing the call down (rough
    // estimate; not awaiting TTS-end yet).
    const playDelayMs = this.mode === 'active' ? 3000 : 0;
    setTimeout(() => {
      try {
        this.onLeaveCall();
      } catch (err) {
        console.warn(ts(), '[auto-leave] onLeaveCall failed:', err.message);
      }
    }, playDelayMs);
  }

  setSomeoneElsePresenting(presenting, presenterName) {
    this.someoneElsePresenting = !!presenting;
    this.presenterName = presenterName || null;
  }

  addError(message) {
    this.errors.push({ message, timestamp: new Date().toISOString() });
    if (this.errors.length > 10) this.errors.shift();
  }

  // -------------------------------------------------------------------------
  // Transcript management (called by Electron app when captions arrive)
  // -------------------------------------------------------------------------

  addTranscript(speaker, text, role = 'member', voice = undefined) {
    if (!this.roomId) return;

    const now = new Date().toISOString();
    const id = `${this.roomId}-tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      id,
      roomId: this.roomId,
      participantName: speaker,
      role,
      text,
      isFinal: true,
      timestamp: now,
    };
    if (voice) entry.voice = voice;

    this.transcripts.push(entry);

    // Trim to max
    if (this.transcripts.length > this.maxTranscripts) {
      this.transcripts = this.transcripts.slice(-this.maxTranscripts);
    }

    // Check long-poll waiters
    this._checkWaiters();
  }

  // Snapshot update from the Meet caption scraper (#178). Each tick the
  // scraper sends the current state of every visible caption child in DOM
  // order. We upsert in place: turns we've never seen get created; turns
  // whose text changed get updated. Any turn that's no longer bottommost is
  // marked settled — Meet doesn't revise non-current speakers.
  //
  // Replaces the event-log model where each caption tick produced a new
  // appended transcript entry, which forced consumers to do delta-tracking
  // to reconstruct the actual utterance.
  updateTurns(incoming) {
    if (!this.roomId || !Array.isArray(incoming) || incoming.length === 0) return;
    const now = Date.now();
    const incomingIds = new Set();
    let changed = false;

    for (let i = 0; i < incoming.length; i++) {
      const inc = incoming[i];
      if (!inc || typeof inc.turnId !== 'number') continue;
      incomingIds.add(inc.turnId);
      // Trust the scraper's explicit isBottommost flag — it's computed BEFORE
      // 'You' turns are filtered out (the bot's own TTS), so a non-final turn
      // by another speaker that has a "You" caption below it will correctly
      // be marked not-bottommost (i.e., settled) here. Fall back to
      // last-in-list for older scrapers that don't send the flag.
      const isBottommost = typeof inc.isBottommost === 'boolean'
        ? inc.isBottommost
        : (i === incoming.length - 1);
      const existing = this.turns.get(inc.turnId);
      if (!existing) {
        this.turns.set(inc.turnId, {
          id: `${this.roomId}-turn-${inc.turnId}`,
          speaker: inc.speaker,
          text: inc.text,
          firstSeen: now,
          lastUpdated: now,
          settled: !isBottommost,
          source: 'caption',
        });
        changed = true;
      } else {
        let entryChanged = false;
        if (existing.text !== inc.text) {
          existing.text = inc.text;
          entryChanged = true;
        }
        if (!existing.settled && !isBottommost) {
          existing.settled = true;
          entryChanged = true;
        }
        if (entryChanged) {
          existing.lastUpdated = now;
          changed = true;
        }
      }
    }

    // Turns that disappeared from the DOM entirely are also settled.
    for (const [turnId, turn] of this.turns) {
      if (!incomingIds.has(turnId) && !turn.settled) {
        turn.settled = true;
        turn.lastUpdated = now;
        changed = true;
      }
    }

    // Bound the map size — keep the most recently-active turns.
    if (this.turns.size > this.maxTurns) {
      const sorted = [...this.turns.entries()].sort((a, b) => b[1].lastUpdated - a[1].lastUpdated);
      this.turns = new Map(sorted.slice(0, this.maxTurns));
    }

    if (changed) this._checkWaiters();
  }

  // Project caption turns as transcript-shaped entries so the existing
  // _entriesSince / _buildResponse code can consume them uniformly with bot
  // speech entries (which still live in this.transcripts).
  //
  // `timestamp` reflects firstSeen (when the speaker started this turn), so
  // chronological sort places turns in the order the speakers actually
  // started talking — not when a turn happened to get settled later. The
  // separate `lastUpdated` field is used by _entriesSince to filter by
  // "changed since" (so a turn whose text is still growing keeps surfacing
  // to long-poll waiters).
  _turnsAsEntries() {
    const arr = [];
    for (const turn of this.turns.values()) {
      arr.push({
        id: turn.id,
        roomId: this.roomId,
        participantName: turn.speaker,
        role: 'member',
        text: turn.text,
        isFinal: turn.settled,
        timestamp: new Date(turn.firstSeen).toISOString(),
        lastUpdated: new Date(turn.lastUpdated).toISOString(),
        source: 'caption',
      });
    }
    return arr;
  }

  // -------------------------------------------------------------------------
  // Long-poll support
  // -------------------------------------------------------------------------

  _checkWaiters() {
    for (const waiter of this.waiters) {
      // Get entries since the waiter's timestamp, excluding bot if specified
      const entries = this._entriesSince(waiter.since, waiter.bot);
      if (entries.length === 0) continue;

      // Passive/silent modes only respond when directly addressed. Apply
      // a name-mention filter, then fall through to the same silence-based
      // resolution active mode uses (the bot still has to wait for the
      // speaker to finish their thought — see #208 for why the old
      // instant-resolve path was removed).
      if ((this.mode === 'passive' || this.mode === 'silent') && waiter.bot) {
        const botNameLower = waiter.bot.toLowerCase();
        const mentioned = entries.some(e => e.text.toLowerCase().includes(botNameLower));
        if (!mentioned) {
          if (waiter.silenceTimer) {
            clearTimeout(waiter.silenceTimer);
            waiter.silenceTimer = null;
          }
          continue;
        }
      }

      // Use real-time speaking state from DOMSpeakerTracker (not caption timestamps).
      // If someone is actively speaking, don't resolve — cancel any silence timer.
      //
      // Fallback: DOMSpeakerTracker occasionally gets stuck reporting speaking=true
      // when Meet keeps animating the participant tile after the person has stopped
      // talking. Captions are ground truth — if no new transcript entry has arrived
      // for (silence + 3)s, override and treat it as silence so wait_for_speech
      // doesn't ride out the full 55s timeout.
      const lastEntry = entries[entries.length - 1];
      // Use lastUpdated when present (caption turns track their own last-changed
      // separately from when the speaker started). Falls back to timestamp for
      // legacy/bot entries which have no separate lastUpdated.
      const lastEntryActivityTime = lastEntry ? new Date(lastEntry.lastUpdated || lastEntry.timestamp).getTime() : 0;
      const lastEntryAge = lastEntry ? Date.now() - lastEntryActivityTime : Infinity;
      const captionsGoneQuiet = lastEntryAge >= (waiter.silence + 3) * 1000;

      if (this.anyoneSpeaking && !captionsGoneQuiet) {
        // Speaker tracker says speaking — schedule a re-check at the point when
        // the caption-quiet fallback would kick in, so we don't depend solely on
        // the tracker flipping false (which sometimes never happens).
        if (!waiter.silenceTimer && lastEntry) {
          const timeUntilQuiet = (waiter.silence + 3) * 1000 - lastEntryAge;
          if (timeUntilQuiet > 0) {
            waiter.silenceTimer = setTimeout(() => {
              waiter.silenceTimer = null;
              this._checkWaiters();
            }, timeUntilQuiet + 50);
          }
        }
        continue;
      }

      // Nobody is speaking (or captions say they stopped) — check threshold.
      // Use the MOST RECENT activity signal: either lastSpeechStoppedAt (DOM
      // tracker stopped) or the most recent caption timestamp. If the speaker
      // tracker missed a speech-start (audio meter ramp-up lag), a fresh
      // caption arrives while lastSpeechStoppedAt is stale (minutes old). Using
      // the stale value would treat a brand-new utterance as already-silent
      // and resolve immediately on speech-onset — the user-visible "you flip to
      // thinking the moment I start talking" bug.
      const silenceMs = waiter.silence * 1000;
      const lastEntryTime = lastEntryActivityTime;
      const stopTime = this.lastSpeechStoppedAt || 0;
      const silenceStart = Math.max(stopTime, lastEntryTime) || Date.now();
      const elapsed = Date.now() - silenceStart;

      if (elapsed >= silenceMs) {
        // Silence threshold already met — resolve immediately
        console.log(ts(), '⏱️  [resolve] Silence threshold met (' + Math.round(elapsed) + 'ms ≥ ' + silenceMs + 'ms) — resolving');
        this._resolveWaiter(waiter, 'silence');
      } else if (!waiter.silenceTimer) {
        // Start a silence timer for the remaining time
        const remaining = silenceMs - elapsed;
        waiter.silenceTimer = setTimeout(() => {
          waiter.silenceTimer = null;
          // Re-check: someone may have started speaking during the wait
          this._checkWaiters();
        }, remaining + 50);
      }
    }
  }

  _setBotState(state, extra, { force } = {}) {
    if (this.botState === state) return;
    // Keep the visible "I want to speak but I'm yielding" signal while the
    // interrupter is still talking. A follow-up wait_for_speech call should
    // not make the avatar look merely idle/listening again.
    if (!force && this.botState === 'yielding' && state === 'listening' && this.anyoneSpeaking) return;
    // Don't downgrade thinking/speaking to listening just because a new
    // wait_for_speech showed up — the avatar should stay 🤔/😄 until that
    // turn naturally completes (tts-ended fires with force=true, or a fresh
    // 'thinking' from new user speech replaces it). Without this guard the
    // ack visibly flickered to 🙂 mid-acknowledgment whenever the agent
    // called wait_for_speech twice in a row.
    if (!force && (this.botState === 'speaking' || this.botState === 'thinking') && state === 'listening') return;
    const prev = this.botState;
    this.botState = state;
    // Leaving 'speaking' — TTS ended naturally or got cut off. Cancel any
    // armed barge-in timer so we don't fire stop-tts against a silent bot.
    if (prev === 'speaking' && state !== 'speaking') {
      this._clearBargeIn('bot stopped speaking');
    }
    // Entering 'speaking' — if someone is already mid-utterance, arm
    // immediately. Otherwise arming happens lazily when anyoneSpeaking
    // flips true (in setParticipants).
    if (state === 'speaking' && this.anyoneSpeaking) {
      this._armBargeIn();
    }
    this.onBotStateChange(state, extra);
  }

  // Barge-in / back-off helpers (#154) -----------------------------------------

  _clearBargeIn(reason) {
    if (this._bargeInTimer) {
      clearTimeout(this._bargeInTimer);
      this._bargeInTimer = null;
      console.log(ts(), '🛡️  [barge-in] cleared:', reason);
    }
  }

  _armBargeIn() {
    if (this._bargeInTimer || this.botState !== 'speaking') return;
    console.log(ts(), '🛡️  [barge-in] armed — grace ' + this.bargeInGraceMs + 'ms');
    this._bargeInTimer = setTimeout(() => {
      this._bargeInTimer = null;
      this._evaluateBargeIn();
    }, this.bargeInGraceMs);
  }

  // Grace period elapsed. Decide whether to back off based on who's
  // interrupting. Caller guarantees the timer slot is clear so we can
  // re-arm with the random bot-vs-bot delay if needed.
  _evaluateBargeIn() {
    if (this.botState !== 'speaking' || !this.anyoneSpeaking) {
      // Bot already stopped, or interrupter shut up during the grace
      // period — nothing to do.
      return;
    }
    const interrupters = this.participants.filter(
      (p) => p.speaking && !p.isSelf && p.name !== 'You'
    );
    if (interrupters.length === 0) return;

    // Cross-reference against registered bot members (same logic the
    // get_room_info / panel tag uses). When the binding is unknown, default
    // to "human" — better to yield than to talk over a real person.
    const botNames = new Set(
      (this.members || [])
        .filter((m) => m.role === 'bot' && m.name)
        .map((m) => m.name.toLowerCase())
    );
    const humanInterrupter = interrupters.find(
      (p) => !botNames.has((p.name || '').toLowerCase())
    );

    if (humanInterrupter) {
      console.log(ts(), '🛡️  [barge-in] human interrupted — backing off:', humanInterrupter.name);
      this._performBackOff('human-interrupt');
      return;
    }

    // All interrupters are bots. Wait an additional random delay; if still
    // being interrupted at the end of it, back off. Whichever bot's random
    // timer fires first will yield first, breaking the tie.
    const min = this.bargeInBotRandomMinMs;
    const max = this.bargeInBotRandomMaxMs;
    const delay = Math.floor(min + Math.random() * (max - min));
    console.log(ts(), '🛡️  [barge-in] bot-vs-bot — random additional delay ' + delay + 'ms before deciding');
    this._bargeInTimer = setTimeout(() => {
      this._bargeInTimer = null;
      if (this.botState !== 'speaking' || !this.anyoneSpeaking) {
        console.log(ts(), '🛡️  [barge-in] bot-vs-bot resolved during random delay — continuing');
        return;
      }
      console.log(ts(), '🛡️  [barge-in] bot-vs-bot still colliding after random delay — backing off');
      this._performBackOff('bot-interrupt-random');
    }, delay);
  }

  _performBackOff(reason) {
    try {
      this.onStopTts(reason);
    } catch (err) {
      console.warn(ts(), '[barge-in] onStopTts failed:', err.message);
    }
    // Stash queued bot speech instead of dropping it. On the next silence
    // resolution we'll auto-replay if the stash is still fresh — captures
    // the natural conversational rhythm of "I raised my hand, the floor
    // opened, I just say what I was going to say." If the stash ages out
    // (>BARGE_IN_STASH_MAX_AGE_MS), it's discarded silently and the slow
    // model regenerates fresh.
    if (this.pendingBotSpeech.length > 0) {
      console.log(ts(), '🛡️  [barge-in] stashing', this.pendingBotSpeech.length, 'queued bot speech entries for possible replay');
      this.bargeInStash = {
        entries: [...this.pendingBotSpeech],
        at: Date.now(),
      };
      this.pendingBotSpeech = [];
    }
    // Move out of 'speaking' into an explicit yielding state so humans can see
    // the bot has something queued conceptually but is not talking over them.
    this._setBotState('yielding', { reason }, { force: true });
  }

  // Window after the barge-in beyond which the stashed speech is too stale
  // to safely replay (the conversation has likely moved on). Picked to be
  // short enough that the queued thought almost certainly still fits the
  // moment — humans speak ~150wpm, so 10s is at most one short sentence
  // of new content past the stash, very unlikely to invalidate the plan.
  // If users report awkward replays, tighten this. If they report missing
  // replays, loosen it.
  static BARGE_IN_STASH_MAX_AGE_MS = 10_000;

  // Attempt to replay any fresh barge-in stash before the waiter returns
  // to the slow model. Returns the array of texts that were played (or
  // null if nothing). The bot speaks via the existing onBotSpeech path,
  // so TTS playback / transcript registration follow the normal route.
  _maybeReplayBargeInStash() {
    if (!this.bargeInStash) return null;
    const ageMs = Date.now() - this.bargeInStash.at;
    if (ageMs > LocalServer.BARGE_IN_STASH_MAX_AGE_MS) {
      console.log(ts(), '🛡️  [barge-in] discarding stash — too stale (' + ageMs + 'ms old, max ' + LocalServer.BARGE_IN_STASH_MAX_AGE_MS + 'ms)');
      this.bargeInStash = null;
      return null;
    }
    const entries = this.bargeInStash.entries;
    console.log(ts(), '🛡️  [barge-in] replaying stash — ' + entries.length + ' entries, ' + ageMs + 'ms old');
    this.bargeInStash = null;
    const texts = [];
    for (const { text, voice, emoji } of entries) {
      this._setBotState('speaking', { emoji });
      this.onBotSpeech(text, voice, emoji);
      texts.push(text);
    }
    return texts;
  }

  _resolveWaiter(waiter, reason = 'unknown') {
    if (waiter.resolved) return;
    waiter.resolved = true;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.silenceTimer);
    const waitedMs = waiter.startTime ? Date.now() - waiter.startTime : 0;
    console.log(ts(), '✅ [resolve] wait_for_speech resolved — reason=' + reason + ', waited=' + waitedMs + 'ms');

    // Auto-replay any fresh barge-in stash on silence resolution — that's
    // the "you had your hand raised, the room went quiet, just speak"
    // moment. Skip on timeout/mention/displaced/etc; only silence is the
    // natural conversational gap.
    if (reason === 'silence') {
      const replayed = this._maybeReplayBargeInStash();
      if (replayed) this._lastReplayedStash = replayed;
    }

    const response = this._buildResponse(waiter.since, waiter.bot, waiter.startTime);

    // If there are actual transcript entries, the agent will now process them → thinking state.
    // Captions arrive as multiple progressively-growing entries for one utterance
    // (e.g. "Hi" → "Hi Jimmy" → "Hi Jimmy. How's it going?"), so naively joining
    // them inflates wordCount. Dedupe by keeping the longest text per consecutive
    // run of the same speaker — same logic the MCP server applies for the agent.
    // Note: we may already be in 'thinking' state from a previous turn that the
    // agent didn't speak to (it called wait_for_speech twice). Force the state
    // change so the ack handler still runs with the new wordCount.
    const entries = this._entriesSince(waiter.since, waiter.bot);
    if (entries.length > 0) {
      const deduped = [];
      for (const entry of entries) {
        const last = deduped[deduped.length - 1];
        if (last && last.participantName === entry.participantName) {
          if (entry.text.length >= last.text.length) {
            deduped[deduped.length - 1] = entry;
          }
        } else {
          deduped.push(entry);
        }
      }
      const joinedText = deduped
        .map(e => e.text.trim())
        .filter(Boolean)
        .join(' ');
      const wordCount = joinedText.split(/\s+/).filter(Boolean).length;
      // Always fire the change callback with the new wordCount — even if state
      // is already 'thinking' from a previous turn — so the ack handler runs.
      // Without this, agent loops that call wait_for_speech twice in a row
      // skip the ack on the second resolution because the equal-state guard
      // in _setBotState short-circuits.
      console.log(ts(), '🧠 [thinking] Processing transcript — ' + wordCount + ' words, ' + deduped.length + ' entry/ies');
      this.botState = 'thinking';
      // Pass joinedText so the ack handler can do addressivity matching
      // (#155). wordCount stays the primary threshold; text is supplemental.
      this.onBotStateChange('thinking', { wordCount, text: joinedText });
    }

    waiter.resolve(response);
    this.waiters = this.waiters.filter(w => w !== waiter);
  }

  resolveAllWaiters() {
    for (const waiter of [...this.waiters]) {
      this._resolveWaiter(waiter);
    }
  }

  _entriesSince(since, botName) {
    // Merge Meet caption turns (snapshot model, #178) with bot speech and
    // legacy Web-Speech entries (event-log model). Sort by `timestamp`
    // (firstSeen for turns / event time for legacy) so entries appear in the
    // order they actually started, not in the order they happened to settle.
    //
    // Filter `since` against `lastUpdated || timestamp`: a caption turn whose
    // text is still growing should keep surfacing to long-poll waiters even
    // though its firstSeen is in the past.
    let entries = [...this._turnsAsEntries(), ...this.transcripts];
    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (since) {
      const sinceTime = new Date(since).getTime();
      entries = entries.filter(e => {
        const t = e.lastUpdated || e.timestamp;
        return new Date(t).getTime() > sinceTime;
      });
    }
    if (botName) {
      entries = entries.filter(e => e.participantName !== botName);
    }
    // Skip the legacy _collapseUtterances pass — turn entries are already
    // one-per-utterance. Legacy transcripts (bot speech, web speech) are
    // discrete events that don't need collapsing either.
    return entries;
  }

  // Captions arrive as progressively-growing entries for one utterance
  // ("Hi" -> "Hi Jimmy" -> "Hi Jimmy, how are you"). Collapse a consecutive
  // run from the same speaker where each text is a prefix-extension of the
  // previous into a single (longest) entry, so callers see whole utterances
  // rather than every fragment. Genuinely separate utterances (no prefix
  // relationship, or a different speaker in between) are preserved.
  _collapseUtterances(entries) {
    const out = [];
    for (const e of entries) {
      const last = out[out.length - 1];
      if (
        last &&
        last.participantName === e.participantName &&
        (e.text.startsWith(last.text) || last.text.startsWith(e.text))
      ) {
        out[out.length - 1] = e.text.length >= last.text.length ? e : last;
      } else {
        out.push(e);
      }
    }
    return out;
  }

  _buildResponse(since, botName, startTime) {
    const entries = this._entriesSince(since, botName);
    const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;

    // Continuation detection: is this window just the same speaker extending the
    // utterance the bot already responded to? (captions kept growing after we
    // answered). If so, flag it so the agent can avoid double-responding.
    let continuationOfPriorResponse = false;
    if (entries.length > 0 && this.lastRespondedSpeaker && this.lastRespondedText) {
      const allSameSpeaker = entries.every(e => e.participantName === this.lastRespondedSpeaker);
      const latestText = entries[entries.length - 1].text;
      if (allSameSpeaker && latestText.startsWith(this.lastRespondedText)) {
        continuationOfPriorResponse = true;
      }
    }

    // Surface the most recent fast-ack to the slow model exactly once,
    // then clear it. Lets the model self-correct if its full response
    // contradicted the ack's tone. Only attached on resolved waits
    // (startTime present) — bare GETs don't move the read pointer.
    const previousAckPhrase = startTime ? this.lastAckPhrase : null;
    if (startTime && this.lastAckPhrase) this.lastAckPhrase = null;

    // Same one-shot surface for any barge-in stash that just auto-replayed.
    // The slow model needs to know its queued thought already went out so
    // it doesn't try to repeat it — instead it can build on it or stay
    // silent.
    const replayedBargeInStash = startTime ? this._lastReplayedStash : null;
    if (startTime && this._lastReplayedStash) this._lastReplayedStash = null;

    return {
      success: true,
      roomId: this.roomId,
      asOf: new Date().toISOString(),
      waited: !!startTime,
      elapsed,
      continuationOfPriorResponse,
      previousAckPhrase,
      replayedBargeInStash,
      transcript: {
        entries,
        count: entries.length,
      },
      whiteboard: {
        content: this.whiteboard.content,
        version: this.whiteboard.version,
        lastModified: this.whiteboard.lastModified,
        lastEditor: this.whiteboard.lastEditor,
        changed: false,
      },
      chat: { messages: [], count: 0 },
      chatUnread: this.chatUnread,
      members: this.members,
      participants: this.participants,
      detectedMeetUrls: this.detectedMeetUrls,
      status: {
        callStatus: this.callStatus,
        sharing: this.sharing,
        someoneElsePresenting: this.someoneElsePresenting,
        presenterName: this.presenterName,
        mode: this.mode,
        localServerUrl: this.getLocalServerUrl(),
        localServerPort: this.port,
        localProfile: this.localProfile,
        errors: this.errors,
        permissions: this.permissions,
        chatUnread: this.chatUnread,
        roomUrl: this.roomId ? `${(this.getWebsiteUrl() || '').replace(/\/$/, '')}/room/${this.roomId}` : null,
        whiteboardUrl: this.roomId ? `${(this.getWebsiteUrl() || '').replace(/\/$/, '')}/room/${this.roomId}?mode=whiteboard` : null,
        whiteboardLoadedUrl: this.getWhiteboardLoadedUrl(),
        sessionLogPath: getSessionLogPath(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch(err => {
          console.error('[local-server] Request error:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[local-server] Listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          // Try next port
          this.port++;
          this.server.listen(this.port, '127.0.0.1');
        } else {
          reject(err);
        }
      });
    });
  }

  stop() {
    this.resolveAllWaiters();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async _handleRequest(req, res) {
    // CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathMatch = url.pathname.match(/^\/api\/sync\/([a-z]+-[a-z]+-[a-z]+)$/);

    // Room creation endpoint (for compatibility with sync-client.js)
    if (url.pathname === '/api/rooms/create' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Status endpoint — returns detected URLs and call state without a room ID
    if (url.pathname === '/api/sync/no-room' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        roomId: this.roomId,
        detectedMeetUrls: this.detectedMeetUrls,
        status: {
          callStatus: this.callStatus,
          mode: this.mode,
          localServerUrl: this.getLocalServerUrl(),
          localServerPort: this.port,
          localProfile: this.localProfile,
        },
      }));
      return;
    }

    // Session log endpoint (#173). Returns recent stdout/stderr from the
    // current session so agents can post-mortem mid-call weirdness via the
    // get_session_log MCP tool. Optional query params: lines=N (default 200),
    // grep=PATTERN (case-insensitive regex filter).
    if (url.pathname === '/api/session-log' && req.method === 'GET') {
      const lines = Math.max(1, Math.min(5000, parseInt(url.searchParams.get('lines') || '200', 10)));
      const grep = url.searchParams.get('grep');
      const result = getRecentSessionLog({ lines, grep });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    // Preferences endpoint — agent-visible whitelist with current values.
    // Excludes anything not in preferences-schema.js (API keys, auth, etc.).
    if (url.pathname === '/api/preferences' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        preferences: prefsSchema.describe(this.getPref),
      }));
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      try {
        if (parsed.action === 'send') {
          if (!parsed.text || !String(parsed.text).trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'No text to send' }));
            return;
          }
          const result = await this.onSendChat(String(parsed.text));
          res.writeHead(result?.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: !!result?.ok, error: result?.error }));
        } else {
          // default: read
          const result = await this.onReadChat();
          res.writeHead(result?.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: !!result?.ok, messages: result?.messages || [], error: result?.error }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Serve a registered whiteboard asset by opaque token (#157). 127.0.0.1
    // binding only, and the token is only known to whoever registered it.
    const assetMatch = url.pathname.match(/^\/asset\/([A-Za-z0-9.]+)$/);
    if (assetMatch && req.method === 'GET') {
      const token = assetMatch[1];
      const asset = this._whiteboardAssets.get(token);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('asset not found');
        return;
      }
      try {
        const stat = fs.statSync(asset.path);
        res.writeHead(200, {
          'Content-Type': asset.mime,
          'Content-Length': stat.size,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(asset.path).pipe(res);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('asset read failed: ' + err.message);
      }
      return;
    }

    // Register a local file as a whiteboard asset and get back an opaque URL
    // the bot can embed in update_whiteboard markdown (#157).
    if (url.pathname === '/api/whiteboard-asset' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      try {
        const result = this.registerWhiteboardAsset(parsed.path);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/call-screenshot' && req.method === 'POST') {
      try {
        const result = await this.onCaptureScreenshot({ roomId: this.roomId });
        if (result?.error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: result.path }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/preferences' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      const { key, value } = parsed || {};
      const result = prefsSchema.validate(key, value);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: result.error, key }));
        return;
      }
      try {
        this.setPref(key, result.value);
        this.applyPref(key, result.value);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, key }));
        return;
      }
      const spec = prefsSchema.PREFERENCES[key];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        key,
        value: result.value,
        requiresRestart: !!spec?.requiresRestart,
      }));
      return;
    }

    if (!pathMatch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    const roomId = pathMatch[1];

    // Accept requests for any room ID — set it as active if we don't have one
    if (!this.roomId) {
      this.roomId = roomId;
    }

    if (req.method === 'GET') {
      await this._handleGet(req, res, url, roomId);
    } else if (req.method === 'POST') {
      await this._handlePost(req, res, roomId);
    } else {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    }
  }

  async _handleGet(req, res, url, roomId) {
    const since = url.searchParams.get('since');
    const wait = parseInt(url.searchParams.get('wait') || '0', 10);
    const silence = parseInt(url.searchParams.get('silence') || '2', 10);
    const bot = url.searchParams.get('bot');

    // Non-blocking: return immediately
    if (!wait) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._buildResponse(since, bot)));
      return;
    }

    // Long-poll: wait for speech + silence
    const clampedWait = Math.min(55, Math.max(1, wait));
    const clampedSilence = Math.max(1, silence);

    // Bump the "last wait_for_speech" clock at the start of the long-poll
    // call, not inside the waiter-registration branch. The agent counts
    // as "in the loop" regardless of whether the call returns immediately
    // (because speech is already past the silence threshold) or registers
    // a real waiter. Without this, immediate-return acks make the panel's
    // Last WfS line grow stale even though the agent is actively polling.
    this.lastWaitForSpeechAt = Date.now();

    // Check if there are already entries that satisfy the silence condition
    const existing = this._entriesSince(since, bot);
    if (existing.length > 0) {
      const lastEntry = existing[existing.length - 1];
      const lastTime = new Date(lastEntry.timestamp).getTime();
      if (Date.now() - lastTime >= clampedSilence * 1000) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this._buildResponse(since, bot, Date.now())));
        return;
      }
    }

    const startTime = Date.now();

    // Single-agent enforcement: if another agent is already long-polling, kick
    // them out. Two agents on one room means double speak() calls per utterance
    // and inflated wordCounts from overlapping `since` windows. The displaced
    // agent's wait_for_speech returns with { displaced: true } so its skill
    // can exit the conversation loop instead of fighting for the room.
    if (this.waiters.length > 0) {
      console.log('[local-server] New wait_for_speech displacing', this.waiters.length, 'existing waiter(s)');
      for (const old of [...this.waiters]) {
        if (old.resolved) continue;
        old.resolved = true;
        clearTimeout(old.timer);
        clearTimeout(old.silenceTimer);
        old.resolve({ success: true, displaced: true, asOf: new Date().toISOString(), transcript: { entries: [] } });
      }
      this.waiters = [];
    }

    const responsePromise = new Promise((resolve) => {
      const waiter = {
        resolve,
        since,
        bot,
        silence: clampedSilence,
        startTime,
        resolved: false,
        silenceTimer: null,
        timer: setTimeout(() => {
          console.log(ts(), '⌛ [resolve] wait_for_speech full timeout (' + clampedWait + 's) hit');
          this._resolveWaiter(waiter, 'timeout');
        }, clampedWait * 1000),
      };
      this.waiters.push(waiter);
      this.lastWaitForSpeechAt = Date.now();
      this._setBotState('listening');

      // If entries already exist but silence hasn't elapsed, start checking
      if (existing.length > 0) {
        this._checkWaiters();
      }
    });

    const result = await responsePromise;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  async _handlePost(req, res, roomId) {
    const body = await this._readBody(req);
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      return;
    }

    if (!data.sender) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'sender is required' }));
      return;
    }

    const results = {};
    const now = new Date().toISOString();

    // Handle transcript entries (bot speech)
    if (data.transcript && Array.isArray(data.transcript)) {
      // In silent mode, suppress bot speech entirely — don't record or speak.
      // Agent learns its speech was suppressed via results.transcript.reason.
      if (data.role === 'bot' && this.mode === 'silent') {
        results.transcript = { ok: false, reason: 'mode-silent', sent: 0, entries: [] };
      } else if (data.role === 'bot' && this.anyoneSpeaking) {
        // Barge-in guard: user started speaking after the agent decided to
        // respond. Drop the response and tell the agent to wait_for_speech
        // again — talking over them is the worst voice-UX failure mode.
        console.log(ts(), '🛡️  [barge-in] Dropped bot speech — user is currently speaking:', data.transcript?.[0]?.text?.slice(0, 60));
        this._setBotState('yielding', { reason: 'user-speaking' }, { force: true });
        results.transcript = { ok: false, reason: 'user-speaking', sent: 0, entries: [] };
      } else {
        const entries = [];
        for (const t of data.transcript) {
          if (!t.text) continue;
          const id = `${roomId}-tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const entry = {
            id,
            roomId,
            participantName: data.sender,
            role: data.role || 'member',
            text: t.text,
            isFinal: true,
            timestamp: now,
          };
          if (t.voice) entry.voice = t.voice;
          this.transcripts.push(entry);
          entries.push(entry);

          // Trigger TTS for bot speech — but defer if we're not in the call
          // yet. The virtual mic stream isn't connected to Meet's other
          // participants until callStatus is 'in-call'; speaking earlier means
          // audio plays into the void. The transcript entry is recorded
          // immediately either way so order is preserved on flush.
          if (data.role === 'bot') {
            // Record the member utterance this response is answering — the most
            // recent non-bot entry. Lets us flag the next window as a
            // continuation if that speaker just keeps extending the same thought.
            // Use the merged view so caption turns (#178) are considered, not
            // just legacy this.transcripts entries.
            const allEntries = this._entriesSince(null, null);
            const lastMember = [...allEntries].reverse().find(e => e.role !== 'bot');
            if (lastMember) {
              this.lastRespondedSpeaker = lastMember.participantName;
              this.lastRespondedText = lastMember.text;
            }
            if (this.callStatus !== 'in-call') {
              console.log('[local-server] Queueing bot speech until in-call:', t.text.slice(0, 40));
              this.pendingBotSpeech.push({ text: t.text, voice: t.voice, emoji: t.emoji });
            } else {
              this._setBotState('speaking', { emoji: t.emoji });
              this.onBotSpeech(t.text, t.voice, t.emoji);
            }
          }
        }
        results.transcript = { ok: true, sent: entries.length, entries };
      }
    }

    // Handle whiteboard update
    if (data.whiteboard && typeof data.whiteboard.content === 'string') {
      this.whiteboard.content = data.whiteboard.content;
      this.whiteboard.version++;
      this.whiteboard.lastModified = now;
      this.whiteboard.lastEditor = data.sender;
      results.whiteboard = {
        ok: true,
        version: this.whiteboard.version,
        lastModified: now,
        lastEditor: data.sender,
      };
      this.onWhiteboardUpdate(data.whiteboard.content, data.sender);
    }

    // Handle join command — tell the app to join a Meet call
    if (data.meta?.action === 'join') {
      const meetCode = data.meta.meetCode || roomId;
      const botName = data.meta.botName;
      this.onJoinCall(meetCode, botName);
      results.join = { ok: true };
    }

    // Handle leave command
    if (data.meta?.action === 'leave') {
      this.onLeaveCall();
      results.leave = { ok: true };
    }

    // Handle share/stop whiteboard commands
    if (data.meta?.action === 'share-whiteboard') {
      this.onShareWhiteboard(data.meta.shareType || 'whiteboard');
      results.shareWhiteboard = { ok: true };
    }
    if (data.meta?.action === 'stop-sharing') {
      this.onStopSharing();
      results.stopSharing = { ok: true };
    }

    // Handle load-url command (load arbitrary URL in whiteboard window)
    if (data.meta?.action === 'load-url' && data.meta.url) {
      this.onLoadUrl(data.meta.url);
      results.loadUrl = { ok: true };
    }

    // Handle scroll-share command (scroll the shared whiteboard window)
    if (data.meta?.action === 'scroll-share') {
      const r = await this.onScrollShare({ direction: data.meta.direction, amount: data.meta.amount });
      results.scrollShare = r || { ok: true };
    }

    // Handle set-mode command — persistent bot behavior mode
    if (data.meta?.action === 'set-mode' && data.meta.mode) {
      try {
        this.setMode(data.meta.mode);
        results.setMode = { ok: true, mode: this.mode };
      } catch (err) {
        results.setMode = { ok: false, error: err.message };
      }
    }

    // Handle set-camera command — agent toggles its own camera on/off
    if (data.meta?.action === 'set-camera' && typeof data.meta.on === 'boolean') {
      this.onSetCamera(data.meta.on);
      results.setCamera = { ok: true, on: data.meta.on };
    }

    // Handle set-avatar-emoji command — agent overrides resting/yielding avatar
    // emojis to match conversation tone. Each field is optional;
    // empty-string clears the override (back to default).
    if (data.meta?.action === 'set-avatar-emoji') {
      const overrides = {};
      if (data.meta.idle !== undefined) overrides.idle = data.meta.idle || null;
      if (data.meta.listening !== undefined) overrides.listening = data.meta.listening || null;
      if (data.meta.yielding !== undefined) overrides.yielding = data.meta.yielding || null;
      this.onAvatarEmojiOverride(overrides);
      results.setAvatarEmoji = { ok: true };
    }

    // Update presence
    this._upsertMember(data.sender, data.role || 'member', data.ownerName, data.displayName, data.versions);

    // Trim transcripts
    if (this.transcripts.length > this.maxTranscripts) {
      this.transcripts = this.transcripts.slice(-this.maxTranscripts);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      roomId,
      asOf: now,
      results,
    }));
  }

  _memberVersions(versions) {
    const clean = versions && typeof versions === 'object' && !Array.isArray(versions)
      ? { ...versions }
      : {};
    if (this.appVersion) clean.app = this.appVersion;
    return Object.keys(clean).length > 0 ? clean : undefined;
  }

  _upsertMember(name, role, ownerName, displayName, versions) {
    const existing = this.members.find(m => m.name === name);
    const memberVersions = this._memberVersions(versions);
    if (existing) {
      existing.lastSeen = Date.now();
      if (role) existing.role = role;
      if (displayName) existing.displayName = displayName;
      if (ownerName) existing.ownerName = ownerName;
      if (memberVersions) existing.versions = memberVersions;
    } else {
      this.members.push({
        name,
        displayName: displayName || name,
        role: role || 'member',
        lastSeen: Date.now(),
        ownerName: ownerName || undefined,
        versions: memberVersions,
      });
    }
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}

// Export for use in main.js (loaded via vm.runInThisContext)
globalThis.LocalServer = LocalServer;
