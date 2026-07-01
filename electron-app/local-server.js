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
const { TranscriptTailer } = require('./agent-transcript.js');

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

// How often a background-tick waiter re-checks whether enough new transcript has
// accumulated to surface the slow model (#245). This is just the sampling
// granularity — the actual trigger is content (chars), not time.
const BACKGROUND_TICK_POLL_MS = 2500;

// Short HH:MM:SS.mmm timestamp for emoji diagnostic logs — lets us cross-
// reference log lines with actual conversation moments. Keep it local so
// reading the log doesn't require mental clock-math.
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Auto-stamp every console line with HH:MM:SS.mmm. Skip when caller already
// supplied a ts() prefix so existing `console.log(ts(), '...')` sites don't
// double-stamp. Runs in the main process — same wrapper as main.js, but
// idempotent: if main.js already wrapped, wrapping again just adds a second
// no-op layer (TS_RE matches its own output, so the second wrapper skips).
(function installTimestampedConsole() {
  if (console.__tsWrapped) return;
  console.__tsWrapped = true;
  const TS_RE = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
  const wrap = (fn) => (...args) => {
    if (args.length && typeof args[0] === 'string' && TS_RE.test(args[0])) fn(...args);
    else fn(ts(), ...args);
  };
  console.log = wrap(console.log.bind(console));
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
})();

class LocalServer {
  constructor({ port, appVersion, onBotSpeech, onStopTts, onWhiteboardUpdate, onLeaveCall, onShareWhiteboard, onStopSharing, onLoadUrl, onJoinCall, onJoinSlack, onBotStateChange, onModeChange, onCallStatusChange, onAnyoneSpeakingChange, onCaptionsChange, onWorkingMemoryChange, onComprehensionDue, onTriageAck, onProbeOpening, onParticipantsFirstSeen, onAvatarEmojiOverride, onSetCamera, onCaptureScreenshot, onReadChat, onSendChat, onScrollShare, onInspectDom, onPlayAudio, onFocusRequest, getWebsiteUrl, getWhiteboardLoadedUrl, getConfiguredBotName, getPref, setPref, applyPref } = {}) {
    this.port = port || DEFAULT_PORT;
    this.appVersion = appVersion || null;
    this.onBotSpeech = onBotSpeech || (() => {});
    this.onStopTts = onStopTts || (() => {});
    this.onWhiteboardUpdate = onWhiteboardUpdate || (() => {});
    this.onLeaveCall = onLeaveCall || (() => {});
    this.onShareWhiteboard = onShareWhiteboard || (() => {});
    this.onStopSharing = onStopSharing || (() => {});
    this.onJoinCall = onJoinCall || (() => {});
    this.onJoinSlack = onJoinSlack || (() => {});
    this.onLoadUrl = onLoadUrl || (() => {});
    this.onScrollShare = onScrollShare || (async () => ({ ok: false, error: 'not implemented' }));
    this.onPlayAudio = onPlayAudio || (() => {});
    this.onFocusRequest = onFocusRequest || (() => {}); // raise this instance's window (profile switcher)
    this.onInspectDom = onInspectDom || (async () => ({ ok: false, error: 'not implemented' }));
    this.onBotStateChange = onBotStateChange || (() => {}); // 'idle' | 'listening' | 'thinking' | 'speaking' | 'yielding'
    this.onModeChange = onModeChange || (() => {});        // 'active' | 'passive' | 'silent'
    this.onCallStatusChange = onCallStatusChange || (() => {}); // 'idle' | 'joining' | 'waiting-to-be-admitted' | 'in-call' | 'left'
    this.onAnyoneSpeakingChange = onAnyoneSpeakingChange || (() => {}); // boolean
    this.onCaptionsChange = onCaptionsChange || (() => {}); // boolean — true=on, false=off (=== deaf)
    this.onWorkingMemoryChange = onWorkingMemoryChange || (() => {}); // ({understanding, stance, updatedAt, updatedBy})
    this.onComprehensionDue = onComprehensionDue || (async () => {}); // async (transcriptText, workingMemory) — background refresh
    // Two-tier shadow harness: async ({lastUtterance, workingMemory, recentTranscript})
    // fired at floor-open. Fast model drafts what it WOULD say from `stance`;
    // log-only for now (never spoken). docs/two-tier-design.md.
    this.onTriageAck = onTriageAck || (async () => {});
    // Active-listening (#245): fires on a brief silence (a soft opening) when
    // probeFiring is on, so main.js can run the completeness gate and decide
    // whether to fire a banked probe. async ({ lastUtterance, recentTranscript, roster }).
    this.onProbeOpening = onProbeOpening || (async () => {});
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
    // The user's persistent panel/store botName preference (#212). Read live so
    // the MCP can resolve an omitted bot_name to the panel preference instead of
    // a frozen env default, and so we never overwrite it on a per-call basis.
    this.getConfiguredBotName = getConfiguredBotName || (() => null);
    // Per-call name override (#212): what the agent asked this bot to be called
    // in THIS call. Set on join when bot_name is explicit, cleared on leave.
    // The persistent store preference (getConfiguredBotName) is never touched.
    this.currentCallBotName = null;
    this.chatUnread = false; // passive "… - New message" signal from the chat button

    // Response-state tracking — what the bot last responded to. Used to detect
    // when a new wait window is just a continuation of an utterance the bot
    // already answered (captions grow progressively across windows), so the
    // agent can avoid double-responding to the same thought.
    this.lastRespondedSpeaker = null;
    this.lastRespondedText = null;
    this.lastProcessingText = null;
    this.lastRespondedAt = null;

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
    // #221: when 'thinking' started, and the pending deferred downgrade (if
    // any) — see the thinkingHoldMs logic in _setBotState.
    this._thinkingSince = 0;
    this._thinkingHoldTimer = null;
    // #222: name this session last joined under — rejoining as yourself is
    // exempt from the duplicate-name guard (our own presence may linger).
    this._everJoinedAs = null;

    // Mode is persistent user-controlled behavior; distinct from transient botState.
    //   active  — responds freely (ack on every pause, speaks its thoughts)
    //   passive — silent until its name is mentioned
    //   silent  — listens for its name but never speaks; can still act (whiteboard, tools)
    this.mode = 'active';

    // Agent-activity tail: the driving Claude session reports its transcript
    // path here (via the auto-installed hook); we tail it into a ring buffer
    // shown on the debug overlay. Gated by the same `debugOverlay` toggle.
    this.agentLog = [];
    this._agentTailer = new TranscriptTailer({ onLines: (lines) => { this.agentLog = lines; } });

    // Room state (single room — the active call)
    this.roomId = null;
    this.callId = null;          // first-class per-join call ID (#292), minted in setRoom
    this.callStartedAt = null;   // ISO timestamp the current call's room was set
    this.currentUrl = null;      // the meet/slack URL currently loaded (set by loadMeetURL),
                                 // surfaced to the panel so the URL field reflects CLI launches
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
    this.detectedSlackHuddleUrl = null; // app.slack.com/client/<team>/<channel> when a huddle is live in a browser tab
    this.participants = [];      // [{ name, speaking }] from DOM speaker tracker
    this.someoneElsePresenting = false;  // another participant is screen sharing
    this.presenterName = null;   // name of the person presenting (if any)

    // Real-time speaking state (from DOMSpeakerTracker, not captions)
    this.anyoneSpeaking = false;       // true if any participant is currently speaking
    this.lastSpeechStoppedAt = null;   // timestamp (ms) when last person stopped speaking

    // Two-tier "workingMemory" (docs/two-tier-design.md). The bot's private
    // internal read of the conversation — NOT the shared whiteboard. The slow
    // model maintains this in the background while the bot is silent; the fast
    // model phrases responses from it instantly. Phase 0: state + endpoints
    // only, consumers wired in later steps.
    //   understanding — slow model's running read of the discussion (churns)
    //   stance        — the point the bot would make if the floor opened now (churns)
    //   people        — accumulating notes about who's in the call (roles,
    //                    expertise, who's been quiet). Distinct from the
    //                    mechanical this.participants presence list; this is
    //                    semantic knowledge that persists across topic shifts.
    this.workingMemory = { understanding: '', stance: '', people: '', engagement: '', updatedAt: null, updatedBy: null };
    // Background comprehension trigger — fires onComprehensionDue when enough
    // NEW transcript has accumulated since the last refresh (size-based, not
    // time-based). _charsAtLastComprehension is the transcript char total at
    // the last refresh; the delta vs. the current total is the accumulation.
    this._charsAtLastComprehension = 0;
    this._comprehensionInFlight = false;
    this._comprehensionCount = 0; // refreshes done this call — drives the warm-up ramp

    // Last fast-ack phrase the bot played (or null). Surfaces to the slow
    // model on its next wait_for_speech so the model can self-correct if
    // its full response contradicts the ack tone (e.g. ack was "Uh-huh"
    // but the real answer is "no, actually..."). Cleared after one read.
    this.lastAckPhrase = null;

    // Active-listening probe bank (#245). The slow model deposits a short,
    // context-aware interjection here on background ticks via bank_probe; the
    // Apple firing gate fires it at a detected opening (or a generic fallback).
    // SINGLE-SLOT: holds only the freshest probe — each tick replaces the prior
    // one, and firing consumes it (no stale backlog). Stays an array (0 or 1
    // entry { text, at: ms }) for snapshot/back-compat. lastProbeAt drives the
    // rate limit so the bot doesn't over-interject.
    this.probeBank = [];
    this.lastProbeAt = 0;
    this._probeTimer = null;

    // Speech the bot was about to say when a human interrupted (barge-in).
    // Held for the bargeInStashMaxAgeMs pref window, then auto-replayed on the next
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

    // Captions on/off (from the scraper's CC-button watcher). The bot hears
    // through captions, so captions-off === deaf. null = unknown / pre-join.
    this.captionsOn = null;

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
    // Barge-in / silence timing knobs now read live from preferences each
    // time they're consulted (this._pref helper). The agent can tune them
    // mid-call via set_preference, and they're per-profile so different
    // personas can have different conversational rhythms. Schema defaults
    // match what these used to be hardcoded as. See preferences-schema.js.
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

    // --- Claude responsiveness (mid-call perf) ---------------------------------
    // The headline "is the bot snappy today" metric is Claude's reaction time:
    // the wall-clock gap between us answering a wait_for_speech (handing Claude
    // the floor) and Claude's FIRST speak landing back here. Both ends pass
    // through this server, so we can measure it live and separate "Claude is slow
    // today" from "our code is slow" (our per-call processing is sub-ms). The
    // two-phase skill makes that first speak the quick ack, so this stays a clean
    // reaction time regardless of how much deeper work the turn then needs.
    this._pendingTurnSince = null; // ms ts of the resolve we're awaiting Claude's first reply to
    this._perfSamples = [];        // rolling [{ ts, ms }] of recent reaction times (cap 30)
    this.lastResponseMs = null;    // most recent Claude reaction time (ms)

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

  // The meet/slack URL currently loaded in the bot's view. Set by loadMeetURL so
  // the panel can reflect a --meet-url CLI launch (or any programmatic join) in
  // the URL field — useful to tell at a glance which call a test is running.
  setCurrentUrl(url) {
    this.currentUrl = url || null;
  }

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
    this.captionsOn = null;
    this.lastRespondedSpeaker = null;
    this.lastRespondedText = null;
    this.lastProcessingText = null;
    this.lastRespondedAt = null;
    this.workingMemory = { understanding: '', stance: '', people: '', engagement: '', updatedAt: null, updatedBy: null };
    this._charsAtLastComprehension = 0;
    this._comprehensionInFlight = false;
    this._comprehensionCount = 0; // refreshes done this call — drives the warm-up ramp
    this._resetAutoLeave();
    this.resolveAllWaiters();
    // Use the setter so onCallStatusChange fires — the avatar uses this to
    // switch to 🫥 while joining.
    this.setCallStatus('joining');
  }

  clearRoom() {
    // Tell the website we're leaving so our presence entry doesn't linger and
    // block the next session's join (name-collision, #252). Fire-and-forget,
    // BEFORE we null roomId/name below.
    this._deregisterPresence();
    this.roomId = null;
    this.callId = null;
    this.callStartedAt = null;
    this.currentUrl = null;
    this.transcripts = [];
    this.turns = new Map();
    this.members = [];
    this.sharing = false;
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.lastSpeechStoppedAt = null;
    this.captionsOn = null;
    this.lastRespondedSpeaker = null;
    this.lastRespondedText = null;
    this.lastProcessingText = null;
    this.lastRespondedAt = null;
    this.workingMemory = { understanding: '', stance: '', people: '', engagement: '', updatedAt: null, updatedBy: null };
    this._charsAtLastComprehension = 0;
    this._comprehensionInFlight = false;
    this._comprehensionCount = 0; // refreshes done this call — drives the warm-up ramp
    this._resetAutoLeave();
    this.resolveAllWaiters();
    this.setCallStatus('idle');
  }

  // Captions toggled on/off (from the scraper's CC-button watcher). The bot
  // hears via captions, so off === deaf. Forwarded to main so it can flip
  // the avatar emoji as a visible signal to call participants. Surfaces in
  // wait_for_speech timeouts so the agent can ask humans to turn captions
  // back on.
  setCaptionsOn(on) {
    if (this.captionsOn === on) return;
    this.captionsOn = on;
    console.log(ts(), on ? '🟢 [captions] back ON' : '🔴 [captions] OFF — bot is deaf');
    this.onCaptionsChange(on);
  }

  // --- workingMemory (two-tier, docs/two-tier-design.md) ----------------------

  getWorkingMemory() {
    return { ...this.workingMemory };
  }

  // Partial update — pass any of { understanding, stance, people }. Unset
  // fields are left as-is so the slow model can refresh just one (e.g. update
  // the topic read without touching the accumulated people notes). Returns the
  // merged result. updatedBy is for debug attribution.
  setWorkingMemory({ understanding, stance, people, engagement, updatedBy } = {}) {
    if (typeof understanding === 'string') this.workingMemory.understanding = understanding;
    if (typeof stance === 'string') this.workingMemory.stance = stance;
    if (typeof people === 'string') this.workingMemory.people = people;
    if (typeof engagement === 'string') this.workingMemory.engagement = engagement;
    this.workingMemory.updatedAt = Date.now();
    if (updatedBy) this.workingMemory.updatedBy = updatedBy;
    const u = (this.workingMemory.understanding || '').length;
    const s = (this.workingMemory.stance || '').length;
    const p = (this.workingMemory.people || '').length;
    const e = (this.workingMemory.engagement || '').length;
    console.log(ts(), `🧩 [workingMemory] updated by ${updatedBy || '?'} (understanding ${u}c, stance ${s}c, people ${p}c, engagement ${e}c)`);
    this.onWorkingMemoryChange(this.getWorkingMemory());
    return this.getWorkingMemory();
  }

  // Total chars of caption transcript currently held — the accumulation
  // signal for background comprehension. Captions exclude the bot's own
  // speech, so this measures how much OTHERS have said.
  _transcriptCharsTotal() {
    let total = 0;
    for (const turn of this.turns.values()) total += (turn.text || '').length;
    return total;
  }

  // Build a compact recent-transcript string for the comprehension model.
  // Log each finalized caption turn so the session log is a true record of what
  // the bot HEARD (every speaker except the bot's own TTS), making it possible to
  // correlate responses against the actual conversation without inferring timing.
  _logHeard(speaker, text) {
    const t = (text || '').trim();
    if (t) console.log(ts(), '👂 [heard]', (speaker || 'someone') + ':', t);
  }

  // Raw in-flight caption progression (gated by logRawCaptions pref) — every
  // partial as Meet's captions grow, marked LIVE (still being edited) vs settled.
  // This is the messy data needed to test utterance-COMPLETENESS detection (#243):
  // a "settled" snapshot is the ground-truth "complete" point; the LIVE partials
  // before it are the "is this done yet?" judgments. [heard] only logs the final
  // text — too late for completeness. Off by default (verbose); enable for data
  // collection.
  _logRawCaption(turnId, speaker, text, isBottommost) {
    if (!this._pref('logRawCaptions')) return;
    const t = (text || '').trim();
    if (t) console.log(ts(), '📝 [caption-raw] t' + turnId + (isBottommost ? ' LIVE   ' : ' settled') +
      ' ' + (speaker || '?') + ': ' + JSON.stringify(t));
  }

  _recentTranscriptText(limit = 30) {
    const entries = this._entriesSince(null, null) || [];
    return entries
      .slice(-limit)
      .map(e => `${e.participantName || 'someone'}: ${e.text}`)
      .join('\n');
  }

  // The known participant roster as authoritative text for the local model —
  // names + human/bot/self, cross-referenced against registered bot members
  // (#162). We hand this to comprehend/phrase so the model never has to re-derive
  // who's in the call from captions (it does that poorly, leaving `people` empty).
  _rosterText() {
    const botNames = new Set(
      (this.members || [])
        .filter((m) => m.role === 'bot' && m.name)
        .map((m) => m.name.toLowerCase())
    );
    // Identify "me" by the bot's own name, not just the flaky isSelf flag — the
    // speaker tracker sometimes fails to mark the self tile, which mislabeled the
    // bot as "a bot" (not "you") and confused the triage classifier into treating
    // direct addresses as other-bot. The bot always knows its own name.
    const myName = (this.getEffectiveBotName() || '').toLowerCase();
    return (this.participants || [])
      .filter(p => p.name && p.name !== 'You')
      .map(p => {
        const nameLower = (p.name || '').toLowerCase();
        const kind = (p.isSelf || (myName && nameLower === myName))
          ? 'this bot — YOU'
          : (botNames.has(nameLower) ? 'a bot' : 'a human');
        return `- ${p.name} (${kind})`;
      })
      .join('\n');
  }

  // Size-based background-comprehension trigger (docs/two-tier-design.md).
  // Fires onComprehensionDue when enough NEW transcript has accumulated since
  // the last refresh. Self-guarding (single-flight) and non-blocking — the
  // handler does the local-model call off the hot path. Called from
  // updateTurns. Time is deliberately NOT the trigger: a quiet call shouldn't
  // burn refreshes, and a busy one should refresh proportionally to how much
  // was said.
  _maybeComprehend() {
    if (this.callStatus !== 'in-call') return;
    if (this._comprehensionInFlight) return;
    const total = this._transcriptCharsTotal();
    const accumulated = Math.max(0, total - this._charsAtLastComprehension);

    // 0 disables the size-based refresh entirely. (Number(0)||500 would wrongly
    // re-enable it, so handle 0 explicitly.)
    const raw = this._pref('comprehendCharThreshold');
    const steady = (raw === 0) ? 0 : (Number(raw) || 500);
    if (steady === 0) return;

    // Warm-up ramp: the first couple of refreshes fire after much less speech,
    // so workingMemory gets populated in the opening minute instead of staying
    // empty until 500c of human talk piles up. After the ramp, settle to the
    // steady cadence. Clamped to steady so a low steady value can't be exceeded.
    const ramp = [Math.min(120, steady), Math.min(300, steady)];
    const threshold = this._comprehensionCount < ramp.length
      ? ramp[this._comprehensionCount]
      : steady;
    if (accumulated < threshold) return;

    this._comprehensionInFlight = true;
    this._comprehensionCount++;
    console.log(ts(), `🧩 [comprehend] accumulation ${accumulated}c ≥ ${threshold}c (refresh #${this._comprehensionCount}) — refreshing working memory`);
    const transcript = this._recentTranscriptText();
    const wm = this.getWorkingMemory();
    const roster = this._rosterText();
    Promise.resolve()
      .then(() => this.onComprehensionDue(transcript, wm, roster))
      .catch(err => console.warn(ts(), '🧩 [comprehend] handler error:', err.message))
      .finally(() => {
        this._comprehensionInFlight = false;
        // Reset the accumulation baseline to the total as of NOW (not the
        // total at fire time) so text that arrived during the refresh counts
        // toward the next one.
        this._charsAtLastComprehension = this._transcriptCharsTotal();
      });
  }

  setCallStatus(status) {
    if (this.callStatus === status) return;
    this.callStatus = status;
    console.log('[local-server] Call status:', status);
    this.onCallStatusChange(status);

    // Mint a first-class call ID when a call begins — the first transition into
    // an active state (joining / waiting / in-call) without one. Format:
    // <roomCode>-<compact-UTC-timestamp> (e.g. kku-fpvq-smx-20260629T164900Z).
    // One per call, cleared on end, so it disambiguates multiple calls within a
    // single session log and is greppable as a `[call] id=…` block (#292).
    const activeState = status === 'joining' || status === 'waiting-to-be-admitted' || status === 'in-call';
    if (activeState && !this.callId) {
      this.callStartedAt = new Date().toISOString();
      const code = this.roomId || 'call';
      this.callId = `${code}-${this.callStartedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      console.log(`[call] id=${this.callId} room=${this.roomId || '(unknown)'} status=${status} started=${this.callStartedAt}`);
    }

    // Drop pending speech if we never made it in (call failed / cleared).
    // Pending flush itself is gated on first-participants-seen, not in-call —
    // 'in-call' fires when Meet's UI is up, but the bot's mic track isn't
    // reliably connected to other participants until the people pane is
    // populated (a stronger 'fully wired up' signal). See _flushPendingBotSpeech.
    if (status === 'idle' || status === 'left') {
      this.callId = null;
      this.callStartedAt = null;
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

  // Speak now, or after a small random jitter when another bot could answer the
  // same prompt in lockstep (#230). Two bots with identical timing logic
  // otherwise start speaking in unison; a random 0–N ms delay decorrelates the
  // starts so one clearly goes first. Gated on 2+ other participants (the only
  // case a collision is possible) so solo / single-human calls stay snappy —
  // we can't reliably tell from one app that another participant IS a bot
  // (this.members is local-only), so participant count is the cheap proxy.
  _speakWithBotJitter(t) {
    const speakNow = () => {
      if (this.callStatus !== 'in-call') return; // call ended during the jitter
      this._setBotState('speaking', { emoji: t.emoji });
      this.onBotSpeech(t.text, t.voice, t.emoji);
    };
    const others = (this.participants || []).filter(p => !p.isSelf && p.name && p.name !== 'You').length;
    const maxJitter = Number(this._pref('botSpeakJitterMaxMs')) || 0;
    if (others >= 2 && maxJitter > 0) {
      const jitter = Math.floor(Math.random() * maxJitter);
      console.log(ts(), `🎲 [bot-jitter] ${others} others in call — delaying speak ${jitter}ms to avoid lockstep`);
      setTimeout(speakNow, jitter);
    } else {
      speakNow();
    }
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

  setDetectedSlackHuddle(url) {
    this.detectedSlackHuddleUrl = url || null;
  }

  setChatUnread(unread) {
    if (this.chatUnread === unread) return;
    this.chatUnread = unread;
    console.log('[local-server] Chat unread:', unread);

    // Pipeline a NEW chat message like speech: wake a pending wait_for_speech so
    // the agent handles it promptly instead of only on the next ~55s long-poll
    // return. BUT only in a quiet room — for two reasons:
    //   1. Don't interrupt a live speaker (chat is lower priority than the floor).
    //   2. Reading chat opens the chat pane, which closes the people pane and
    //      BLINDS speaker detection (captions keep flowing, but who's-speaking
    //      state is lost). If we only open chat when nobody's speaking, there's
    //      no live-speaker state to lose.
    // If someone IS speaking, we do nothing here: chatUnread stays set and rides
    // along when speech resolves naturally at the next pause — nothing dropped.
    // Wake a pending wait_for_speech on a new unread — but ONLY if nobody's
    // speaking (don't interrupt a live speaker; that's also when reading chat
    // would blind speaker detection). We intentionally do NOT gate on
    // chatPaneOpen: the agent is asleep in wait_for_speech and needs waking for a
    // new message regardless of pane state, and that flag can be stale (it races
    // the pane open/close animation — observed suppressing legit wakes).
    if (unread) {
      const blocked = this.anyoneSpeaking ? 'someone-speaking'
        : this.waiters.length === 0 ? 'no-active-waiter'
        : null;
      if (blocked) {
        console.log(ts(), '💬 [chat-wake] new unread but NOT waking —', blocked,
          '(anyoneSpeaking=' + this.anyoneSpeaking + ' waiters=' + this.waiters.length + ')');
      } else {
        console.log(ts(), '💬 [chat-wake] new unread in quiet room — waking', this.waiters.length, 'waiter(s)');
        for (const waiter of [...this.waiters]) {
          this._resolveWaiter(waiter, 'chat');
        }
      }
    }
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

  // The name to actually use in Meet for this call (#212): the per-call
  // override if the agent set one, otherwise the user's persistent panel
  // preference. preload-meet reads this to fill Meet's pre-join name input.
  getEffectiveBotName() {
    return this.currentCallBotName || this.getConfiguredBotName() || null;
  }

  // Bind (or rebind) the agent-activity tail to a Claude session transcript.
  // Called from the /api/agent-session route, which the PostToolUse hook hits.
  setAgentSession({ sessionId, transcriptPath } = {}) {
    if (!transcriptPath) return;
    if (transcriptPath !== this._agentTailer.path) {
      console.log('[local-server] Agent session bound:', sessionId || '?', '→', transcriptPath);
    }
    this._agentTailer.bind(transcriptPath, sessionId);
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
      captionsOn: this.captionsOn,
      // Claude responsiveness (resolve → first speak) — the "is the bot snappy
      // today" signal, surfaced live on the panel + camera overlay.
      lastResponseMs: this.lastResponseMs,
      responsePerf: this._perfStats(),
      // Latest caption the bot actually heard — surfaced on the virtual-camera
      // debug overlay so a deaf bot is visible to everyone in the call (when
      // captions stop reaching the bot this stops advancing).
      lastCaption: (() => {
        let latest = null;
        for (const turn of this.turns.values()) {
          if (!turn.text) continue;
          if (!latest || (turn.lastUpdated || 0) >= (latest.lastUpdated || 0)) latest = turn;
        }
        // live = the latest turn is still being edited (not yet settled) — i.e.
        // the caption is still in flux vs a completed utterance.
        if (latest) return { speaker: latest.speaker || '?', text: latest.text, live: !latest.settled };
        const tx = this.transcripts[this.transcripts.length - 1];
        return tx && tx.text ? { speaker: tx.participantName || '?', text: tx.text, live: false } : null;
      })(),
      // What was last shipped to the slow model for processing (set at the
      // thinking transition) — distinct from lastCaption, which is the freshest
      // caption and may still be growing. Cleared implies nothing processed yet.
      processing: this.lastProcessingText || null,
      // Recent agent (Claude session) activity — compact lines tailed from the
      // driving session's transcript. Shown on the debug overlay only.
      agentLog: this.agentLog || [],
      workingMemory: this.getWorkingMemory(),
      sharing: this.sharing,
      someoneElsePresenting: this.someoneElsePresenting,
      presenterName: this.presenterName,
      chatUnread: this.chatUnread,
      chatPaneOpen: !!this.chatPaneOpen,
      peoplePaneOpen: !!this.peoplePaneOpen,
      screenRecording: this.permissions?.screenRecording,
      roomId: this.roomId,
      callId: this.callId,
      callStartedAt: this.callStartedAt,
      // The meet/slack URL the bot is pointed at (reflects --meet-url launches).
      currentMeetUrl: this.currentUrl,
      // What URL is loaded in the bot's screen-share window right now (#177).
      // Named for the share, not the whiteboard, since it can be any URL.
      screenShareUrl: this.getWhiteboardLoadedUrl(),
      // Human-readable hint about the bot's current avatar background so it can
      // answer "what's my background?" and recall it across context resets
      // (#244) — the raw SVG lives in the preference but is opaque/large.
      avatarBackground: (() => {
        const svg = (this.getPref('avatarBackgroundSvg') || '').toString();
        const caption = (this.getPref('avatarBackgroundCaption') || '').toString().trim();
        if (!svg.trim()) return { set: false, caption: caption || null, imageRef: null };
        // Derive a hint from the first <image href> (file basename or URL).
        let imageRef = null;
        const m = svg.match(/<image[^>]*\shref=["']([^"']+)["']/i);
        if (m) {
          const ref = m[1];
          if (/^data:/i.test(ref)) imageRef = '(inline data URI)';
          else { try { imageRef = ref.replace(/^file:\/\//, '').split('/').pop() || ref; } catch { imageRef = ref; } }
        }
        return { set: true, caption: caption || null, imageRef, length: svg.length };
      })(),
      sessionLogPath: getSessionLogPath(),
      // The active experiment/timing knobs, surfaced on the debug overlay so
      // anyone in the call can see which flags a given bot is running (e.g.
      // whether Seth's bots have probeFiring on). Resolved to the EFFECTIVE
      // value — store override if set, else the schema default — so unset
      // knobs show what the bot actually runs, not a blank.
      experiments: {
        defaultSilenceSeconds: this._pref('defaultSilenceSeconds'),
        probeFiring: this._pref('probeFiring'),
        backgroundTickWords: this._pref('backgroundTickWords'),
        probeSilenceMs: this._pref('probeSilenceMs'),
        triageAck: this._pref('triageAck'),
      },
      // The slow model's banked interjections (#245), newest-last — so the
      // overlay can show the probe content evolving across ticks. Only
      // populated when probeFiring is on (otherwise nothing banks/fires).
      // lastProbeFiredAt lets the overlay show when one was last spoken.
      probeBank: this._pref('probeFiring')
        ? (this.probeBank || []).map((p) => ({ text: p.text, at: p.at }))
        : [],
      lastProbeFiredAt: this.lastProbeAt || 0,
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
      // Active listening (#245): arm a SOFT-opening probe on a brief quiet —
      // shorter than the full turn-silence gate. If the room is still quiet
      // after probeSilenceMs, _maybeProbeOpening runs the completeness gate.
      // No-op unless probeFiring is on (checked inside).
      if (this._pref('probeFiring')) {
        clearTimeout(this._probeTimer);
        const ms = Number(this._pref('probeSilenceMs')) || 700;
        this._probeTimer = setTimeout(() => this._maybeProbeOpening(), ms);
      }
    } else if (!wasSpeaking && this.anyoneSpeaking) {
      // Speech just started — cancel any pending silence timers
      for (const waiter of this.waiters) {
        if (waiter.silenceTimer) {
          clearTimeout(waiter.silenceTimer);
          waiter.silenceTimer = null;
        }
      }
      // Speaker resumed — cancel any pending soft-opening probe (no opening).
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
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
      clearTimeout(w.tickTimer);
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
  // Inject a synthetic caption turn — same path the Meet scraper uses, but
  // sourced from the panel's "Simulate speech" textbox instead. Lets us
  // drive the bot in a noisy environment, paste in conversational test
  // data, or unit-test the conversation logic without a live Meet.
  //
  // Marks the turn as already-settled (isBottommost=false) so silence
  // resolution kicks in naturally on the next _checkWaiters pass.
  injectSimulatedTurn({ text, speaker }) {
    if (!this.roomId) return { ok: false, error: 'Not in a call (no roomId)' };
    const cleanText = String(text || '').trim();
    if (!cleanText) return { ok: false, error: 'Empty text' };
    const speakerName = String(speaker || '').trim() || 'Simulated';
    // Use a clearly-out-of-band turnId so this never collides with the
    // scraper's stream (which starts at 1 and grows incrementally).
    const turnId = -Date.now();
    this.updateTurns([{
      turnId,
      speaker: speakerName,
      text: cleanText,
      isBottommost: false,
    }]);
    console.log(ts(), '💉 [simulate] Injected turn from', JSON.stringify(speakerName) + ':', JSON.stringify(cleanText.slice(0, 80)));
    // Nudge waiters in case they're sitting on the silence threshold.
    this._checkWaiters();
    return { ok: true, turnId };
  }

  updateTurns(incoming) {
    if (!this.roomId || !Array.isArray(incoming) || incoming.length === 0) return;
    // If caption turns with text are arriving, captions are definitionally ON —
    // make captionsOn self-correcting. The captions-state IPC only fires on
    // toggle CHANGES, so a clean join where captions were never toggled left the
    // flag stuck false (showing a bogus "DEAF" on the overlay while the bot was
    // clearly hearing). Actual caption text is the ground truth.
    if (!this.captionsOn && incoming.some((t) => t && t.text && String(t.text).trim())) {
      this.setCaptionsOn(true);
    }
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
        this._logRawCaption(inc.turnId, inc.speaker, inc.text, isBottommost);
        if (!isBottommost) this._logHeard(inc.speaker, inc.text); // arrived already final
      } else {
        let entryChanged = false;
        if (existing.text !== inc.text) {
          existing.text = inc.text;
          entryChanged = true;
          this._logRawCaption(inc.turnId, inc.speaker, inc.text, isBottommost);
        }
        if (!existing.settled && !isBottommost) {
          existing.settled = true;
          entryChanged = true;
          this._logHeard(existing.speaker, existing.text); // just settled — log final text
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
        this._logHeard(turn.speaker, turn.text);
      }
    }

    // Bound the map size — keep the most recently-active turns.
    if (this.turns.size > this.maxTurns) {
      const sorted = [...this.turns.entries()].sort((a, b) => b[1].lastUpdated - a[1].lastUpdated);
      this.turns = new Map(sorted.slice(0, this.maxTurns));
    }

    if (changed) this._checkWaiters();
    // Size-based background comprehension — self-guards, non-blocking.
    if (changed) this._maybeComprehend();
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
      //
      // Picking silenceStart:
      //   - If the tracker fired stop RECENTLY, trust stopTime as-is. Meet's
      //     captions often keep revising trailing text for 1-2s after speech
      //     actually ends; treating those revisions as new activity stretches
      //     the silence window unnecessarily (real-world: ~1.4s extra wait
      //     observed in a 30s utterance log, every turn).
      //   - If stopTime is STALE (tracker missed a speech-start, common
      //     after long bot turns when the indicator rotates), fall back to
      //     the most recent caption activity. Without this fallback a fresh
      //     utterance with a multi-minute-old stopTime would resolve
      //     immediately at speech-onset.
      const silenceMs = waiter.silence * 1000;
      const lastEntryTime = lastEntryActivityTime;
      const stopTime = this.lastSpeechStoppedAt || 0;
      const STOP_FRESH_MS = silenceMs * 3; // ~6s with default 2s silence
      const stopIsFresh = stopTime && (Date.now() - stopTime) < STOP_FRESH_MS;
      const silenceStart = stopIsFresh
        ? stopTime
        : (Math.max(stopTime, lastEntryTime) || Date.now());
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

  // #222: best-effort check whether `name` is already present in the call —
  // first against the live Meet roster (when we're already in the call),
  // then against the website's room presence (other bots register there
  // even when our app hasn't joined yet, which is how two fresh sessions
  // both default to "Jimmy" and collide). Returns a human-readable source
  // string when taken, null when free. Network failures return null — the
  // guard must never block a join just because presence is unreachable.
  async _nameAlreadyInCall(roomId, name) {
    const wanted = (name || '').trim().toLowerCase();
    if (!wanted) return null;
    const live = (this.participants || []).find(
      (p) => !p.isSelf && (p.name || '').trim().toLowerCase() === wanted
    );
    if (live) return 'visible in the Meet roster';
    const base = (this.getWebsiteUrl() || '').replace(/\/$/, '');
    if (!base) return null;
    try {
      const resp = await fetch(`${base}/api/room/${roomId}/presence`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const member = (data.members || []).find(
        (m) => (m.name || '').trim().toLowerCase() === wanted
      );
      if (member) return `registered in room presence as ${member.role || 'member'}`;
    } catch {
      // Presence unreachable or slow — fall through to allowing the join.
    }
    return null;
  }

  // Remove our presence entry from the website on leave so a stale "still here"
  // member doesn't block the next session reclaiming this name (#252). Reads
  // roomId/name at call time, so call it BEFORE clearRoom nulls them.
  _deregisterPresence() {
    const roomId = this.roomId;
    const name = this.getEffectiveBotName();
    const base = (this.getWebsiteUrl() || '').replace(/\/$/, '');
    if (!roomId || !name || !base) return;
    fetch(`${base}/api/room/${roomId}/presence?name=${encodeURIComponent(name)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    }).then((r) => {
      console.log(ts(), r.ok
        ? `🚪 [presence] de-registered "${name}" from room ${roomId}`
        : `[presence] de-register HTTP ${r.status} (endpoint may not be deployed yet)`);
    }).catch((e) => console.log(ts(), '[presence] de-register failed:', e.message));
  }

  _setBotState(state, extra, { force } = {}) {
    if (this.botState === state) return;
    // Keep the visible "I want to speak but I'm yielding" signal while the
    // interrupter is still talking. A follow-up wait_for_speech call should
    // not make the avatar look merely idle/listening again.
    if (!force && this.botState === 'yielding' && state === 'listening' && this.anyoneSpeaking) return;
    // Don't downgrade speaking to listening just because a new
    // wait_for_speech showed up — the avatar should stay 😄 until that
    // turn naturally completes (tts-ended fires with force=true).
    if (!force && this.botState === 'speaking' && state === 'listening') return;
    // Thinking gets the same protection but only for thinkingHoldMs — long
    // enough that the ack doesn't visibly flicker to 🙂 mid-acknowledgment
    // when the agent calls wait_for_speech twice in a row, but bounded so
    // an agent that re-arms without speaking doesn't leave the avatar stuck
    // pondering through silence (#221). If still inside the hold, schedule a
    // deferred re-attempt — nothing else retries this transition.
    if (!force && this.botState === 'thinking' && state === 'listening') {
      const holdMs = this._pref('thinkingHoldMs');
      const heldFor = Date.now() - (this._thinkingSince || 0);
      if (heldFor < holdMs) {
        if (!this._thinkingHoldTimer) {
          this._thinkingHoldTimer = setTimeout(() => {
            this._thinkingHoldTimer = null;
            if (this.botState === 'thinking' && this.waiters.length > 0) {
              this._setBotState('listening');
            }
          }, holdMs - heldFor + 50);
        }
        return;
      }
      console.log(ts(), '🧠 [thinking] held ' + Math.round(heldFor) + 'ms ≥ ' + holdMs + 'ms with no bot speech — downgrading to listening');
    }
    const prev = this.botState;
    this.botState = state;
    if (this._thinkingHoldTimer) {
      clearTimeout(this._thinkingHoldTimer);
      this._thinkingHoldTimer = null;
    }
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
    const graceMs = this._pref('bargeInGraceMs');
    console.log(ts(), '🛡️  [barge-in] armed — grace ' + graceMs + 'ms');
    this._bargeInTimer = setTimeout(() => {
      this._bargeInTimer = null;
      this._evaluateBargeIn();
    }, graceMs);
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
    const min = this._pref('bargeInBotRandomMinMs');
    const max = this._pref('bargeInBotRandomMaxMs');
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
    // (older than bargeInStashMaxAgeMs), it's discarded silently and the slow
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

  // Live preference read with schema-default fallback. Used for every
  // conversation timing knob in this class so set_preference takes effect
  // immediately (no app restart).
  _pref(key) {
    if (this.getPref) {
      const stored = this.getPref(key);
      if (stored !== undefined && stored !== null) return stored;
    }
    const spec = prefsSchema.PREFERENCES[key];
    return spec ? spec.default : undefined;
  }

  // Attempt to replay any fresh barge-in stash before the waiter returns
  // to the slow model. Returns the array of texts that were played (or
  // null if nothing). The bot speaks via the existing onBotSpeech path,
  // so TTS playback / transcript registration follow the normal route.
  _maybeReplayBargeInStash() {
    if (!this.bargeInStash) return null;
    const ageMs = Date.now() - this.bargeInStash.at;
    const maxAgeMs = this._pref('bargeInStashMaxAgeMs');
    if (ageMs > maxAgeMs) {
      console.log(ts(), '🛡️  [barge-in] discarding stash — too stale (' + ageMs + 'ms old, max ' + maxAgeMs + 'ms)');
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

  // Total words heard from others (not the bot itself) across all caption turns.
  // since=null = no time filter — this is a running TOTAL, snapshotted as a
  // per-waiter baseline so the tick can measure a true DELTA (see below).
  _tickWordCount(bot) {
    const entries = this._entriesSince(null, bot);
    return entries.reduce((n, e) => n + (e.text ? e.text.trim().split(/\s+/).filter(Boolean).length : 0), 0);
  }

  // Active-listening experiment (#245). When backgroundTickWords > 0, surface the
  // (otherwise blocked) slow model EARLY during ongoing conversation so it can
  // update its understanding / bank a probe — without speaking. The trigger is
  // CONTENT-based: fire once per `threshold` NEW words (delta), so it scales with
  // how much was actually said, not wall-clock.
  //
  // DELTA, not cumulative: we snapshot a per-waiter baseline (total words heard at
  // the moment this waiter starts listening) and fire when total − baseline ≥
  // threshold. Counting waiter.since here was the bug — a single long, still-
  // growing turn keeps its lastUpdated past `since`, so _entriesSince(since) re-
  // counted its FULL length every poll and the tick re-fired every ~2.5s. Measuring
  // against an absolute baseline makes one monologue tick once per threshold-words.
  //
  // The threshold is rolled ONCE per waiter with a random margin
  // (backgroundTickJitterFrac) so multiple bots don't tick in lockstep (#230). We
  // poll on a short fixed cadence and fire when enough new content has arrived.
  _scheduleBackgroundTick(waiter) {
    const base = Number(this._pref('backgroundTickWords')) || 0;
    if (base <= 0) return;
    if (waiter._tickThreshold == null) {
      const fracRaw = Number(this._pref('backgroundTickJitterFrac'));
      const frac = Number.isFinite(fracRaw) ? Math.max(0, fracRaw) : 0;
      waiter._tickThreshold = Math.round(base * (1 + Math.random() * frac));
      waiter._tickBaselineWords = this._tickWordCount(waiter.bot); // delta baseline
    }
    clearTimeout(waiter.tickTimer);
    waiter.tickTimer = setTimeout(() => {
      waiter.tickTimer = null;
      if (waiter.resolved) return;
      const newWords = this._tickWordCount(waiter.bot) - waiter._tickBaselineWords;
      if (newWords >= waiter._tickThreshold) {
        console.log(ts(), '🫧 [background-tick] surfacing slow model — ' + newWords + ' new words ≥ threshold ' + waiter._tickThreshold);
        this._resolveWaiter(waiter, 'background_tick');
      } else {
        this._scheduleBackgroundTick(waiter);
      }
    }, BACKGROUND_TICK_POLL_MS);
  }

  // --- Active-listening probe bank + firing gate (#245) ---

  // The slow model deposits a short interjection on a background tick. We hold
  // only the SINGLE freshest probe — each tick replaces the prior one. A probe
  // composed against an older moment is never worth speaking once a newer one
  // exists, and once the freshest is fired we'd rather stay silent than dole out
  // a stale-context backlog. (`probeBank` stays an array for snapshot/back-compat
  // but never holds more than one entry.) Freshness is still age-gated at fire
  // time via probeMaxAgeMs.
  bankProbe(text) {
    const t = (text || '').trim();
    if (!t) return false;
    this.probeBank = [{ text: t, at: Date.now() }];
    console.log(ts(), '🎣 [probe] banked: ' + JSON.stringify(t) + ' (replaces prior)');
    return true;
  }

  // The freshest banked probe if still within probeMaxAgeMs, removed from the
  // bank (so it fires at most once). Returns text or null. With single-slot
  // banking there is never a backlog to fall back to — once fired or aged out,
  // the bot stays silent until the next tick composes a new probe.
  _consumeFreshProbe() {
    const maxAge = Number(this._pref('probeMaxAgeMs')) || 0;
    const entry = this.probeBank.pop();
    if (!entry) return null;
    if (maxAge <= 0 || Date.now() - entry.at <= maxAge) return entry.text;
    return null; // stale — discarded (popped above), nothing older to try
  }

  // Most-recent transcript turn NOT spoken by the bot itself (or null). Used to
  // judge openings/addressivity off the last thing a human/other-bot actually said.
  _lastAttributedTurn() {
    const entries = this._entriesSince(null, null) || [];
    const myName = (this.getEffectiveBotName() || '').toLowerCase();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const name = (e.participantName || '').toLowerCase();
      if (name && myName && name === myName) continue;
      if (e.text && e.text.trim()) return e;
    }
    return null;
  }

  // Brief-silence soft-opening hook. Armed in the speech-stop branch only when
  // probeFiring is on; if the room is still quiet after probeSilenceMs, surface
  // an opening to main.js (which runs the Apple completeness gate). All cheap
  // guards live here so we never even call the model when a probe couldn't fire.
  _maybeProbeOpening() {
    this._probeTimer = null;
    if (!this._pref('probeFiring')) return;
    if (this.mode !== 'active' || this.callStatus !== 'in-call') return;
    if (this.anyoneSpeaking || this.botState === 'speaking') return;
    if (this.waiters.length === 0) return; // slow model isn't listening
    const minInterval = Number(this._pref('probeMinIntervalMs')) || 0;
    if (minInterval > 0 && Date.now() - this.lastProbeAt < minInterval) return;
    // Don't probe when the bot is directly addressed by name — that turn wants a
    // real answer, and a probe ahead of it would just be a redundant filler
    // (the lesson from the disabled triage ack). Let the normal path handle it.
    const lastTurn = this._lastAttributedTurn();
    const myName = (this.getEffectiveBotName() || '').toLowerCase();
    if (lastTurn && myName && lastTurn.text && lastTurn.text.toLowerCase().includes(myName)) return;
    const lastUtterance = lastTurn && lastTurn.text
      ? `${lastTurn.participantName || 'someone'}: ${lastTurn.text.trim()}`
      : null;
    if (!lastUtterance) return;
    Promise.resolve(this.onProbeOpening({
      lastUtterance,
      recentTranscript: this._recentTranscriptText(12),
      roster: this._rosterText(),
    })).catch(() => {});
  }

  // Called back by main.js once the completeness gate confirms a genuine opening.
  // Re-checks the fast guards (state may have changed during the ~0.6s model
  // call), selects a banked probe (or a generic fallback), and speaks it.
  // Probes are SHORT by construction, so they complete well within bargeInGraceMs
  // and are never stashed/replayed — they're fire-and-forget by design. Returns
  // the spoken text or null.
  fireProbe() {
    if (!this._pref('probeFiring')) return null;
    if (this.mode !== 'active' || this.callStatus !== 'in-call') return null;
    if (this.anyoneSpeaking || this.botState === 'speaking') return null;
    const minInterval = Number(this._pref('probeMinIntervalMs')) || 0;
    if (minInterval > 0 && Date.now() - this.lastProbeAt < minInterval) return null;
    let text = this._consumeFreshProbe();
    let source = 'banked';
    if (!text) {
      const generics = this._pref('probeGenericPhrases') || [];
      if (Array.isArray(generics) && generics.length) {
        text = generics[Math.floor(Math.random() * generics.length)];
        source = 'generic';
      }
    }
    if (!text) return null;
    this.lastProbeAt = Date.now();
    console.log(ts(), '🎣 [probe] firing (' + source + '): ' + JSON.stringify(text));
    this._setBotState('speaking', {});
    this.onBotSpeech(text, undefined, undefined);
    return text;
  }

  // Rolling stats over the recent reaction-time samples. Cheap; called on every
  // snapshot. p90 uses the nearest-rank method on the sorted window.
  _perfStats() {
    const arr = this._perfSamples.map((s) => s.ms).sort((a, b) => a - b);
    if (!arr.length) return { last: this.lastResponseMs, avg: null, p90: null, count: 0 };
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    const p90 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.9))];
    return { last: this.lastResponseMs, avg, p90, count: arr.length };
  }

  // Record one Claude reaction time (resolve → first speak) + log it. The marker
  // is parseable for the post-hoc analyzer and rides remote-logging for free.
  _recordResponseMs(ms) {
    this.lastResponseMs = ms;
    this._perfSamples.push({ ts: Date.now(), ms });
    if (this._perfSamples.length > 30) this._perfSamples.shift();
    const st = this._perfStats();
    console.log(ts(), `⚡ [perf] Claude responded in ${ms}ms (resolve→first speak) — avg ${st.avg}ms p90 ${st.p90}ms n=${st.count}`);
  }

  _resolveWaiter(waiter, reason = 'unknown') {
    if (waiter.resolved) return;
    waiter.resolved = true;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.silenceTimer);
    clearTimeout(waiter.tickTimer);
    const waitedMs = waiter.startTime ? Date.now() - waiter.startTime : 0;
    console.log(ts(), '✅ [resolve] wait_for_speech resolved — reason=' + reason + ', waited=' + waitedMs + 'ms');

    // Start the responsiveness clock for turns Claude is expected to answer (a
    // real utterance handed over: silence gap or a direct mention). NOT timeouts
    // (no speech) or background ticks (the floor is still busy and the bot
    // usually stays silent). The latest such resolve wins — if Claude never
    // spoke on the prior one, that turn simply had no audible reply.
    if (reason === 'silence' || reason === 'mention') this._pendingTurnSince = Date.now();

    // Auto-replay any fresh barge-in stash on silence resolution — that's
    // the "you had your hand raised, the room went quiet, just speak"
    // moment. Skip on timeout/mention/displaced/etc; only silence is the
    // natural conversational gap. A background_tick is explicitly NOT a gap —
    // the floor is still busy — so never replay the stash on a tick.
    if (reason === 'silence') {
      const replayed = this._maybeReplayBargeInStash();
      if (replayed) this._lastReplayedStash = replayed;
    }

    const response = this._buildResponse(waiter.since, waiter.bot, waiter.startTime);
    // Tag so the MCP layer / skill know this is a "bank and loop, do NOT speak"
    // surface rather than a real turn.
    if (reason === 'background_tick') response.backgroundTick = true;
    // Tag a chat-triggered wake so the MCP layer can phrase it as "new chat"
    // rather than a misleading "no one spoke / timed out".
    if (reason === 'chat') response.chatWake = true;

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

      // Phantom-resolve guard: Meet sometimes re-emits an already-answered
      // turn with the same text (caption DOM revision bumps lastUpdated
      // without changing content). Detect by exact equality vs.
      // lastRespondedText AND no new speech-stop since we last responded —
      // if the speaker tracker saw the floor go quiet after lastRespondedAt,
      // there was a real new utterance and the identical text is just
      // caption-lag, not a phantom. Without the lastSpeechStoppedAt check
      // this guard nuked legitimate turns whose captions hadn't caught up
      // yet (8:26:17 incident: user asked for a background change but
      // Meet's caption DOM still showed the previous turn).
      const allSameSpeaker = deduped.every(e => e.participantName === this.lastRespondedSpeaker);
      const newSpeechSinceResponse = !!this.lastRespondedAt
        && !!this.lastSpeechStoppedAt
        && this.lastSpeechStoppedAt > this.lastRespondedAt;
      const isExactPhantom = !!this.lastRespondedText
        && allSameSpeaker
        && joinedText === this.lastRespondedText
        && !newSpeechSinceResponse;
      if (isExactPhantom) {
        console.log(ts(), '👻 [phantom] Skipping thinking — transcript identical to last responded turn (' + wordCount + ' words)');
      } else {
        // Always fire the change callback with the new wordCount — even if state
        // is already 'thinking' from a previous turn — so the ack handler runs.
        // Without this, agent loops that call wait_for_speech twice in a row
        // skip the ack on the second resolution because the equal-state guard
        // in _setBotState short-circuits.
        console.log(ts(), '🧠 [thinking] Processing transcript — ' + wordCount + ' words, ' + deduped.length + ' entry/ies: "' + joinedText.slice(0, 240) + (joinedText.length > 240 ? '…' : '') + '"');
        this.botState = 'thinking';
        // Capture exactly what just SHIPPED to the slow model for this thinking
        // cycle — so the debug overlay can distinguish "heard" (latest caption,
        // possibly still in flux) from what's actually being processed right now.
        const procTurn = deduped[deduped.length - 1];
        this.lastProcessingText = {
          speaker: (procTurn && procTurn.participantName) || '?',
          text: joinedText,
          at: Date.now(),
        };
        // Restart the #221 hold window — a fresh utterance earns a fresh
        // thinking display, even if a deferred downgrade was pending.
        this._thinkingSince = Date.now();
        if (this._thinkingHoldTimer) {
          clearTimeout(this._thinkingHoldTimer);
          this._thinkingHoldTimer = null;
        }
        // Pass joinedText so the ack handler can do addressivity matching
        // (#155). wordCount stays the primary threshold; text is supplemental.
        // backgroundTick flags a "bank and loop, do NOT speak" wake so the ack
        // handler skips the spoken filler (a tick must not interrupt a speaker).
        this.onBotStateChange('thinking', { wordCount, text: joinedText, backgroundTick: reason === 'background_tick' });

        // Two-tier shadow harness (now: triage classifier). Feed it the SINGLE
        // most-recent turn WITH its speaker label — not joinedText, which is the
        // windowed merge of every turn in the wait window. The merge mashed
        // multiple speakers (and truncated fragments) into one blob and gave the
        // classifier garbage to judge ("…Request Samantha, can you" = Samantha's
        // turn + the cut-off start of Stan's next turn). The classifier is ~perfect
        // on clean input (offline 19/19); recentTranscript still carries context.
        // Skip on a background_tick — the floor is still busy; triage firing an
        // instant ack there would interrupt the speaker mid-utterance.
        if (reason !== 'background_tick') {
          const lastTurn = deduped[deduped.length - 1];
          const lastUtteranceLabeled = lastTurn && lastTurn.text
            ? `${lastTurn.participantName || 'someone'}: ${lastTurn.text.trim()}`
            : joinedText;
          Promise.resolve(this.onTriageAck({
            lastUtterance: lastUtteranceLabeled,
            workingMemory: this.getWorkingMemory(),
            recentTranscript: this._recentTranscriptText(12),
            roster: this._rosterText(),
            mode: this.mode,
          })).catch(() => {});
        }
      }
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
      detectedSlackHuddleUrl: this.detectedSlackHuddleUrl,
      currentMeetUrl: this.currentUrl,
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
        captionsOn: this.captionsOn,
        workingMemory: this.getWorkingMemory(),
        chatUnread: this.chatUnread,
        roomUrl: this.roomId ? `${(this.getWebsiteUrl() || '').replace(/\/$/, '')}/room/${this.roomId}` : null,
        whiteboardUrl: this.roomId ? `${(this.getWebsiteUrl() || '').replace(/\/$/, '')}/room/${this.roomId}?mode=whiteboard` : null,
        // What's loaded in the screen-share window now — any URL, not just the
        // whiteboard (#177).
        screenShareUrl: this.getWhiteboardLoadedUrl(),
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
    // Room id is any lowercase slug — the server adopts whatever id the first
    // request uses (see "Accept requests for any room ID" below). This used to
    // be locked to Meet's three-group code shape (`xxx-xxxx-xxx`), which 404'd
    // any non-Meet room: a Slack huddle has no Meet code, so wait_for_speech to
    // e.g. `/api/sync/slack-huddle` fell through to 404 and returned instantly
    // (looked like a 3ms "timeout"). `no-room` is intercepted by its own GET
    // handler above, so the broader pattern doesn't shadow it.
    const pathMatch = url.pathname.match(/^\/api\/sync\/([a-z0-9-]+)$/);

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
        callId: this.callId,
        callStartedAt: this.callStartedAt,
        currentMeetUrl: this.currentUrl,
        detectedMeetUrls: this.detectedMeetUrls,
        detectedSlackHuddleUrl: this.detectedSlackHuddleUrl,
        status: {
          callStatus: this.callStatus,
          mode: this.mode,
          localServerUrl: this.getLocalServerUrl(),
          localServerPort: this.port,
          localProfile: this.localProfile,
          // #212: the user's persistent panel preference. The MCP reads this to
          // resolve an omitted bot_name to the configured name instead of a
          // frozen env default. currentCallBotName is the active per-call override.
          configuredBotName: this.getConfiguredBotName(),
          currentCallBotName: this.currentCallBotName,
        },
      }));
      return;
    }

    // Focus endpoint (#282 profile switcher). A sibling instance POSTs here to
    // raise THIS instance's window when the user picks an already-running
    // profile — cross-process focus that OS-level "activate" can't do reliably
    // (all instances share one bundle id).
    if (url.pathname === '/api/focus' && req.method === 'POST') {
      try { this.onFocusRequest(); } catch { /* best-effort */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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

    // workingMemory read/write (two-tier, docs/two-tier-design.md).
    // GET  → current { understanding, stance, updatedAt, updatedBy }
    // POST → partial update; body may contain understanding and/or stance.
    //        updatedBy (optional) is for debug attribution (e.g. bot name).
    if (url.pathname === '/api/working-memory' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, workingMemory: this.getWorkingMemory() }));
      return;
    }
    if (url.pathname === '/api/working-memory' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      if (typeof parsed.understanding !== 'string' && typeof parsed.stance !== 'string' && typeof parsed.people !== 'string' && typeof parsed.engagement !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Provide understanding, stance, people, and/or engagement (string)' }));
        return;
      }
      const updated = this.setWorkingMemory({
        understanding: parsed.understanding,
        stance: parsed.stance,
        people: parsed.people,
        engagement: parsed.engagement,
        updatedBy: parsed.updatedBy,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, workingMemory: updated }));
      return;
    }

    // The driving Claude session's PostToolUse hook reports its transcript path
    // here so we can tail it onto the debug overlay. Best-effort; never errors.
    if (url.pathname === '/api/agent-session' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
      this.setAgentSession({ sessionId: parsed.sessionId, transcriptPath: parsed.transcriptPath });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (url.pathname === '/api/bank-probe' && req.method === 'POST') {
      const body = await this._readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Provide text (non-empty string)' }));
        return;
      }
      const ok = this.bankProbe(parsed.text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: ok, bankSize: this.probeBank.length }));
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
          res.end(JSON.stringify({ success: !!result?.ok, error: result?.error, reason: result?.reason }));
        } else {
          // default: read
          const result = await this.onReadChat();
          // The agent has now consumed the chat — clear the unread flag so a LATER
          // message produces a fresh false→true transition (and wakes the loop).
          // Meet's own "New message" indicator doesn't reliably clear on a brief
          // programmatic pane-open, so chatUnread would otherwise stick true and
          // suppress all future chat-wakes (#chat-wake). This is authoritative:
          // a successful read means the messages were seen.
          if (result?.ok) this.setChatUnread(false);
          res.writeHead(result?.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: !!result?.ok, messages: result?.messages || [], error: result?.error, reason: result?.reason }));
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
    // parseFloat, not parseInt — fractional thresholds like 1.4s are valid and
    // were silently truncated to 1s before. When the agent omits 'silence', fall
    // back to the defaultSilenceSeconds preference (the tunable default).
    const silenceParam = url.searchParams.get('silence');
    const silenceRaw = silenceParam != null ? parseFloat(silenceParam) : Number(this._pref('defaultSilenceSeconds'));
    const silence = Number.isFinite(silenceRaw) ? silenceRaw : 1.4;
    const bot = url.searchParams.get('bot');

    // Non-blocking: return immediately
    if (!wait) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._buildResponse(since, bot)));
      return;
    }

    // Long-poll: wait for speech + silence
    const clampedWait = Math.min(this._pref('defaultMaxWaitForSpeechSec'), Math.max(1, wait));
    const clampedSilence = Math.max(1, silence);

    // Bump the "last wait_for_speech" clock at the start of the long-poll
    // call, not inside the waiter-registration branch. The agent counts
    // as "in the loop" regardless of whether the call returns immediately
    // (because speech is already past the silence threshold) or registers
    // a real waiter. Without this, immediate-return acks make the panel's
    // Last WfS line grow stale even though the agent is actively polling.
    this.lastWaitForSpeechAt = Date.now();

    // Agent is back at the listen-for-next-turn step → any "working" thinking
    // state we set during inter-turn tool calls should clear so the avatar
    // returns to listening (🙂). Forced to bypass the (speaking|thinking) →
    // listening guard, which exists for the in-turn fast-ack window — here
    // there's no in-flight ack to protect, the agent has explicitly handed
    // the floor back. User-speech-driven thinking already transitioned
    // through speaking by the time wait_for_speech is called, so it isn't
    // affected.
    if (this.botState === 'thinking') {
      this._setBotState('listening', undefined, { force: true });
    }

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
        clearTimeout(old.tickTimer);
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
        tickTimer: null,
        timer: setTimeout(() => {
          console.log(ts(), '⌛ [resolve] wait_for_speech full timeout (' + clampedWait + 's) hit');
          this._resolveWaiter(waiter, 'timeout');
        }, clampedWait * 1000),
      };
      this.waiters.push(waiter);
      this.lastWaitForSpeechAt = Date.now();
      this._setBotState('listening');
      // Active-listening experiment (#245): if backgroundTickSeconds > 0, arm a
      // recurring early-surface so the slow model can think mid-conversation.
      this._scheduleBackgroundTick(waiter);

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

    // "Working" signal: any bot POST while the room thinks the bot is idle
    // means the agent is doing something between turns — calling a tool,
    // updating the whiteboard, changing its avatar background, etc. From the
    // call's perspective the bot is "thinking" / busy, not just sitting
    // around. Flip the state so the avatar shows 🤔 instead of 🙂. Cleared
    // when the agent next calls wait_for_speech (see _handleGet wait>0 path).
    // No wordCount/text passed → ack handler in main.js falls through and
    // skips, so this doesn't trigger an "Mm-hmm." mid-tool-call.
    if (data.role === 'bot' && this.callStatus === 'in-call' && this.botState === 'listening') {
      console.log(ts(), '🛠️  [working] bot action while listening — entering thinking');
      this._setBotState('thinking');
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
            // Claude's reaction time: this first speak after a turn-resolve
            // closes the clock. Null it so a same-turn phase-(c) follow-up speak
            // doesn't recount. Bound it [100ms, 120s] to discard garbage (a stale
            // pending crossing a long quiet stretch, or a clock skew).
            if (this._pendingTurnSince != null) {
              const thinkMs = Date.now() - this._pendingTurnSince;
              this._pendingTurnSince = null;
              if (thinkMs >= 100 && thinkMs <= 120000) this._recordResponseMs(thinkMs);
            }
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
              this.lastRespondedAt = Date.now();
            }
            if (this.callStatus !== 'in-call') {
              console.log('[local-server] Queueing bot speech until in-call:', t.text.slice(0, 40));
              this.pendingBotSpeech.push({ text: t.text, voice: t.voice, emoji: t.emoji });
            } else {
              this._speakWithBotJitter({ text: t.text, voice: t.voice, emoji: t.emoji });
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
      // #222: refuse to join under a name that's already in the call — two
      // same-named bots are indistinguishable in the Meet roster, the
      // transcript, and bot-to-bot addressivity. Skip the check when
      // rejoining under a name this session already used (our own presence
      // entry may not have expired), and allow meta.force to override.
      if (botName && !data.meta.force && botName !== this._everJoinedAs) {
        const clash = await this._nameAlreadyInCall(meetCode, botName);
        if (clash) {
          console.log('[local-server] Join refused — name collision:', botName, '(' + clash + ')');
          results.join = {
            ok: false,
            error: `Bot name "${botName}" is already in this call (${clash}). Choose a different bot_name, or pass force:true to join anyway.`,
          };
        }
      }
      if (!results.join) {
        // #212: remember the per-call name override here (not in the persistent
        // store). preload-meet types getEffectiveBotName() into Meet.
        if (botName) this.currentCallBotName = botName;
        this.onJoinCall(meetCode, botName);
        if (botName) this._everJoinedAs = botName;
        results.join = { ok: true };
      }
    }

    // Handle join-slack command — programmatic Slack-huddle join from the agent
    // (#302). Runtime provider switch + auto-join; the app sets roomId to
    // slack-<team>-<channel>.
    if (data.meta?.action === 'join-slack') {
      const url = data.meta.url;
      if (!url) {
        results.join = { ok: false, error: 'join-slack requires a Slack huddle url' };
      } else {
        if (data.sender) this.currentCallBotName = data.sender;
        this.onJoinSlack(url);
        results.join = { ok: true };
      }
    }

    // Handle leave command
    if (data.meta?.action === 'leave') {
      this.currentCallBotName = null; // #212: clear the per-call name override
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

    // Play an arbitrary audio file (url / local path / inline base64) into the
    // call via the bot's virtual mic — reuses the TTS playback path (#audio).
    // Treat it as speaking so the bot won't talk over it; 'tts-ended' clears it.
    if (data.meta?.action === 'play-audio') {
      this._setBotState('speaking', { emoji: data.meta.emoji });
      this.onPlayAudio({ url: data.meta.url, path: data.meta.path, audioData: data.meta.audioData, emoji: data.meta.emoji });
      results.playAudio = { ok: true };
    }

    // Play a bundled sound-effect by id ("arcade/coin"). Resolves the id to its
    // shipped mp3 here (the app owns the files; the MCP server only knows names)
    // and reuses the play-audio path. Unknown id → ok:false with the reason.
    if (data.meta?.action === 'play-sound') {
      const sounds = require('./sounds.js');
      const abs = sounds.resolvePath(data.meta.name);
      if (abs) {
        this._setBotState('speaking', { emoji: data.meta.emoji });
        this.onPlayAudio({ path: abs, emoji: data.meta.emoji });
        results.playSound = { ok: true, id: data.meta.name };
      } else {
        results.playSound = { ok: false, reason: `unknown sound "${data.meta.name}"` };
      }
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

    // Handle inspect-dom command — read-only DOM extraction from the Meet view
    // or the shared whiteboard window, for debugging/introspection.
    if (data.meta?.action === 'inspect-dom') {
      results.inspectDom = await this.onInspectDom({
        target: data.meta.target,
        selector: data.meta.selector,
        maxElements: data.meta.maxElements,
        maxChars: data.meta.maxChars,
      });
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
