// local-server.js — Local HTTP server for agent communication.
// Owns all room/transcript/whiteboard/call state for the Electron app flow;
// the MCP server talks to the local app server and never hits the public website.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// #356: per-process control-token support. The control API binds 127.0.0.1, but
// that is NOT a security boundary against the user's own browser: any webpage can
// fetch() 127.0.0.1:<port> and, under the old wildcard CORS, READ the response
// (session logs / transcripts / working memory) or drive the bot. Defense is a
// random per-launch bearer token written to a 0600 file that only same-user local
// processes (our MCP server) can read — a browser page can't read local files, so
// it can't obtain the token. ENFORCEMENT is now ON by default (#201); set
// VIBECONF_REQUIRE_TOKEN=0 for the legacy open server. It landed dark first so
// the MCP client side could be wired and validated live.
const AUTH_TOKEN_DIR = path.join(os.homedir(), '.vibeconferencing', 'local-tokens');
function localTokenPath(port) { return path.join(AUTH_TOKEN_DIR, `${port}.token`); }
const prefsSchema = require('./preferences-schema.js');
const { classifyAgent, agentIsAbsent } = require('./agent-liveness.js');
const { isFinished } = require('./call-phase.js');
const { getRecentSessionLog, getSessionLogPath, sliceCallLines } = require('./session-log.js');
const { shouldIgnoreRejoin } = require('./rejoin-guard.js');
const { TranscriptActivitySource, StreamActivitySource } = require('./agent-activity.js');

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
// How long the 😑 tick blink stays on the avatar before easing back to the
// resting face. Long enough to be seen, short enough that it can't be mistaken
// for a state the bot is stuck in.
const TICK_FACE_MS = 4000;

// Short HH:MM:SS.mmm timestamp for emoji diagnostic logs — lets us cross-
// reference log lines with actual conversation moments. Keep it local so
// reading the log doesn't require mental clock-math.
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Is this the same bot, written two ways? Presence records the CONFIGURED name
// while Meet's roster shows the DISPLAY name for this call, and the test fleet
// tags a run onto the end ("Alice" -> "Alice-r4a32"). Comparing them literally
// is what made each bot count twice and produced "rank 4 of 5" in a room holding
// three bots (#430).
//
// Prefix rather than equality, and in both directions, because either side may
// be the decorated one. Punctuation and case are dropped so "jimmy bot" matches
// "Jimmy". Deliberately generous: a false match costs a wasted rank slot, while
// a miss costs the ordering entirely.
function namesMatch(a, b) {
  if (!a || !b) return false;
  const n = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const [x, y] = [n(a), n(b)];
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
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
  constructor({ port, appVersion, packaged, onBotSpeech, onStopTts, onResumeTts, onWhiteboardUpdate, onWhiteboardStyle, onReloadWhiteboard, onLeaveCall, onEndSession, onShareWhiteboard, onShareTab, onStopSharing, onLoadUrl, onJoinCall, onListFonts, onJoinSlack, onBotStateChange, onModeChange, onCallStatusChange, onNameMentioned, onAnyoneSpeakingChange, onSilenceGateChange, onCaptionsChange, onWorkingMemoryChange, onComprehensionDue, onTriageAck, onProbeOpening, onParticipantsFirstSeen, onAvatarEmojiOverride, onSetCamera, onCaptureScreenshot, onCaptureSharedScreenshot, onReadChat, onSendChat, onScrollShare, onSetShareAudio, onSetCaptionLanguage, onSetShareSize, onSetShareTitleBar, onShareClick, onShareType, onInspectDom, onFindShareElement, onEvalShare, onReadShareConsole, onReadShareNetwork, onPlayAudio, onFocusRequest, onStartCall, onRecord, getWebsiteUrl, getWhiteboardLoadedUrl, getConfiguredBotName, getTakenBotNames, getPref, setPref, applyPref, getAgentWorkdir, getUnfinishedWrapUp, clearUnfinishedWrapUp, extraRoutes } = {}) {
    this.port = port || DEFAULT_PORT;
    // Optional custom-route hook: async (req, res) => boolean. Runs BEFORE auth so it can
    // serve open localhost routes (e.g. the Claude-ready ping). Returns true if handled.
    this.extraRoutes = extraRoutes || null;
    // An after-call write-up that a re-join cut short, so the next one can
    // finish it. See afterCallWorkPlan.
    this.getUnfinishedWrapUp = getUnfinishedWrapUp || null;
    this.clearUnfinishedWrapUp = clearUnfinishedWrapUp || null;
    // Where the bot's workdir (and its CLAUDE.md) lives — a thunk because
    // Electron's userData path isn't known at construction in every caller.
    // Optional: tests and headless embedders run without one.
    this.getAgentWorkdir = getAgentWorkdir || (() => null);
    this.appVersion = appVersion || null;
    // Release (installed .app/DMG) vs running from source (pnpm dev). Surfaced so
    // both the human (panel) and an agent (no-room status) can tell which build
    // is running — people who "just have Claude do everything" can't otherwise.
    this.buildType = packaged ? 'release' : 'source';
    this.onBotSpeech = onBotSpeech || (() => {});
    this.onStopTts = onStopTts || (() => {});
    this.onResumeTts = onResumeTts || (() => {}); // #350: resume a cut-off utterance
    // #350: when a barge-in cuts the bot off mid-TTS, we mark the moment + a
    // words-heard baseline so the next silence edge can decide whether to
    // resume the retained audio (fresh enough + conversation didn't move on).
    this._ttsInterruptedAt = 0;
    this._ttsInterruptWordsBaseline = 0;
    // #367: urgency the agent self-scored for the utterance the bot is CURRENTLY
    // speaking (null when unscored). Drives urgency-scaled barge-in grace — a
    // high-urgency reply holds the floor longer — and how tolerant the resume is
    // of interruption words. _ttsInterruptUrgency snapshots it at back-off.
    this._currentUrgency = null;
    this._ttsInterruptUrgency = null;
    this.onWhiteboardUpdate = onWhiteboardUpdate || (() => {});
    this.onWhiteboardStyle = onWhiteboardStyle || (() => {}); // #321 relay custom board CSS
    this.onReloadWhiteboard = onReloadWhiteboard || (() => ({ ok: false, error: 'reload not wired' })); // #321 follow-up
    this.whiteboardCss = '';
    this.onLeaveCall = onLeaveCall || (() => {});
    this.getTakenBotNames = getTakenBotNames || (() => []);
    this.onEndSession = onEndSession || (() => {});
    this.onShareWhiteboard = onShareWhiteboard || (() => {});
    this.onShareTab = onShareTab || (() => {}); // POC (share-agent-tab)
    this.onStopSharing = onStopSharing || (() => {});
    this.onJoinCall = onJoinCall || (() => {});
    this.onListFonts = onListFonts || (async () => []);
    this.onJoinSlack = onJoinSlack || (() => {});
    this.onLoadUrl = onLoadUrl || (() => {});
    this.onScrollShare = onScrollShare || (async () => ({ ok: false, error: 'not implemented' }));
    this.onSetShareSize = onSetShareSize || (async () => ({ ok: false, error: 'not implemented' }));
    this.onSetShareTitleBar = onSetShareTitleBar || (async () => ({ ok: false, error: 'not implemented' }));
    this.onShareClick = onShareClick || (async () => ({ ok: false, error: 'not implemented' }));
    this.onShareType = onShareType || (async () => ({ ok: false, error: 'not implemented' }));
    this.onSetShareAudio = onSetShareAudio || (async () => ({ ok: false, error: 'not implemented' }));
    this.onSetCaptionLanguage = onSetCaptionLanguage || (async () => ({ ok: false, error: 'not implemented' }));
    this.onPlayAudio = onPlayAudio || (() => {});
    this.onFocusRequest = onFocusRequest || (() => {}); // raise this instance's window (profile switcher)
    // Start a brand-new call: create a room, send the bot in, open the human's
    // browser. Backs the /call command, mirroring the panel's "Call <bot> now".
    this.onStartCall = onStartCall || (async () => ({ ok: false, code: 'unsupported' }));
    this.onRecord = onRecord || (async () => ({ ok: false, code: 'unsupported' })); // #209
    this.onInspectDom = onInspectDom || (async () => ({ ok: false, error: 'not implemented' }));
    this.onEvalShare = onEvalShare || (async () => ({ ok: false, error: 'not implemented' }));
    this.onFindShareElement = onFindShareElement || (async () => ({ ok: false, error: 'not implemented' }));
    this.onReadShareConsole = onReadShareConsole || (async () => ({ ok: false, error: 'not implemented' }));
    this.onReadShareNetwork = onReadShareNetwork || (async () => ({ ok: false, error: 'not implemented' }));
    this.onBotStateChange = onBotStateChange || (() => {}); // 'idle' | 'listening' | 'ticking' | 'thinking' | 'speaking' | 'yielding'
    this.onModeChange = onModeChange || (() => {});        // 'active' | 'passive' | 'silent'
    this.onCallStatusChange = onCallStatusChange || (() => {}); // see call-phase.js for the lifecycle
    // Fired at most once per caption turn, the first time it contains the
    // bot's own name — the moment someone else directly addresses the bot
    // (the same detection that lets a passive/silent bot wake up and
    // answer). Drives a purely cosmetic avatar reaction; carries no payload.
    this.onNameMentioned = onNameMentioned || (() => {});
    this.onAnyoneSpeakingChange = onAnyoneSpeakingChange || (() => {}); // boolean
    // The moment the silence gate will fire, so the avatar can run a countdown
    // that ENDS exactly when the bot takes its turn. Absolute ms, or null when
    // no gate is pending. Must be pushed on every re-arm: the deadline moves
    // (name-mention fast-resolve, and the #372 correction that re-arms earlier),
    // and a countdown that finishes at the wrong moment teaches the room to
    // distrust it — worse than showing nothing.
    this.onSilenceGateChange = onSilenceGateChange || (() => {}); // ({ deadline, from } | null)
    this._silenceGateAt = null;
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
    this.onCaptureSharedScreenshot = onCaptureSharedScreenshot || (async () => ({ error: 'not implemented' }));
    this.onReadChat = onReadChat || (async () => ({ ok: false, error: 'not implemented' }));
    this.onSendChat = onSendChat || (async () => ({ ok: false, error: 'not implemented' }));
    this.getWebsiteUrl = getWebsiteUrl || (() => ''); // host where /room/:id renders
    // What URL is currently loaded in the whiteboard window? Surfaced so an
    // agent (or the panel) can confirm what's actually being shared — useful
    // after load_url and scroll_share (#169).
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
    // actually admitted to the call. Without this, audio plays through the
    // virtual mic before Meet has connected our stream and goes into the void.
    //
    // Flushed by _flushPendingBotSpeech, which main.js calls on the
    // CAPTIONS-READY signal — NOT on the in-call transition, despite what this
    // comment used to claim. 'in-call' means Meet's UI is up; captions-ready
    // means the bot can actually hear the room, which is the later and stronger
    // "fully wired up" marker. A greeting flushed on the earlier signal played
    // several seconds before anyone could have heard a reply to it.
    //
    // Distinct from bargeInStash, and the difference is only WHICH condition
    // blocked the speech: this one is "the room cannot hear me yet", that one
    // is "someone else is talking". Both mean "held for later". They also have
    // different shapes for no principled reason — this is a FIFO array that
    // never expires, that is a single slot which overwrites and ages out in
    // 45s — and the barge-in stop path already pours this one into that one.
    // See #450; unifying them needs a per-kind hold policy first.
    this.pendingBotSpeech = []; // [{ text, voice, emoji, urgency }]

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
    // #385: which model is authoring the driving session's replies, as reported
    // by the activity source (onModel). null until the source can tell — the
    // brain window shows nothing rather than a guess.
    this.agentModel = null;
    // #339: the same feed also drives the avatar's "working" state — new agent
    // activity while we're between speaks means the bot is heads-down doing tool
    // work (🧑‍💻), not just listening (🙂). Detect NEW lines and surface them.
    this._workingQuietTimer = null;
    this._workingEscalationTimer = null; // fires the 🤔→🧑‍💻 dwell for a SINGLE long tool call
    this._workingSince = 0; // #339: dwell-clock start for the 🤔→🧑‍💻 escalation
    // #242: the SOURCE is swappable. Today this is the transcript tail; an
    // app-launched agent will hand us its own event stream instead. Everything
    // downstream — agentLog, the 🤔→🧑‍💻 escalation, the brain pane — consumes
    // the callbacks below and cannot tell which transport is behind them.
    this._agentSource = new TranscriptActivitySource(this._agentSourceCallbacks());

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
    // #12: identity is keyed on the PARTICIPANT, not the scraper's per-DOM-
    // child turnId — that id is unstable across a Meet caption-container
    // re-render (fresh JS object, fresh id, same words on screen), which is
    // the root cause behind every recurrence of this bug (07-22 through
    // 08-11): re-identified history got re-ingested as brand-new speech and
    // wait_for_speech re-delivered a growing prefix of the whole call.
    //
    // The invariant that replaces turnId matching (confirmed empirically,
    // see google-meet-provider.js CaptionScraper comment): Meet never
    // revises a participant's OLDER turn, and never touches another
    // participant's turn — it only ever appends to a participant's OWN
    // latest turn. So per participant we track how many turns we've seen
    // from them (a count, not an id) plus a pointer to the current/open one:
    //   - position [0 .. knownCount-2] for that speaker is frozen forever.
    //   - position [knownCount-1] (the open turn) may still grow.
    //   - any position >= knownCount is a brand-new turn.
    // A re-render changes every turnId but never this per-speaker count or
    // content, so replay simply cannot happen — there is no identity to
    // lose. See updateTurns().
    this._speakerTurnCount = new Map(); // speaker -> turns seen from them so far
    this._openTurnBySpeaker = new Map(); // speaker -> internal id of their current/open turn
    this._nextTurnId = 1; // internal id counter, independent of the scraper's turnId
    // #12 diagnostic ONLY — no effect on ingest. The old alias defense logged
    // "container re-render detected" as a side effect of matching turnIds;
    // this design doesn't match turnIds at all, so that visibility is gone
    // unless we track it separately. Remembering every scraper turnId we've
    // ever seen lets us log when a burst of never-before-seen ids arrives
    // without a matching burst of genuinely NEW turns — i.e. Meet just
    // re-rendered the caption container. Purely informational (confirms live
    // testing actually exercised the scenario); safe to remove if it gets noisy.
    this._seenScraperTurnIds = new Set();
    this.maxSeenScraperTurnIds = 5000;
    // #12 delivery ledger. Every defense above works on INGEST, and each one
    // has been beaten by a path nobody predicted (six recurrences: 07-22,
    // 07-27, 07-29, 08-03, 08-04, 08-11). The one thing that stays true across
    // all of them is the symptom: the agent is handed words it was already
    // handed. So audit the OUTPUT — what _resolveWaiter actually ships — rather
    // than any particular ingest path. Also the answer to "what are the agents
    // even seeing?": the 📨 lines are a verbatim record of every round.
    //
    // Keyed on the same normalized fingerprint as the ingest defenses, so a
    // re-inserted replay (fresh turnId, fresh firstSeen, therefore invisible to
    // every other field) still collides with its earlier self here.
    this._deliveredFps = new Map(); // fp -> { at, text }
    this.maxDeliveredFps = 4000;
    this._replayDeliveryFired = false;
    this.replayDeliveryCount = 0;
    // #12 regression alarm. The three replay paths were closed in beta-66, but
    // #402 closed an earlier set on 2026-07-08 and looked healthy for two weeks
    // before the 2026-07-22 call showed it had been recurring throughout —
    // nobody was watching, and the symptom (a bot answering twice) reads as
    // chattiness rather than a data bug. So watch the invariant directly:
    //
    //   a turn's lastUpdated must never advance while its NORMALIZED text is
    //   unchanged.
    //
    // lastUpdated is exactly what _entriesSince(since) filters on, so moving it
    // without new words is what re-qualifies replayed history as fresh speech —
    // the mechanism behind every variant of #12 so far. Checking the OUTCOME
    // rather than the `if (textChanged)` branch means a future path that bumps
    // it some other way is caught too.
    //
    // Deliberately NOT checked at delivery: a client may legitimately re-poll
    // with an unchanged `since` and correctly receive the same entries again.
    // An earlier draft flagged that as a replay and fired on healthy calls.
    this._replayAlarmFired = false; // one addError per session, not per batch
    this.replayAlarmCount = 0;      // total violations, for the session log
    this.members = [];
    this.maxTranscripts = 500;

    // Call status tracking
    this.callStatus = 'idle';    // lifecycle + predicates live in call-phase.js
    this.sharing = false;
    this.errors = [];            // recent errors (max 10)

    // State exposed to agents
    this.localProfile = null;   // optional app profile name for multi-agent local runs
    // Calendar auto-join health, pushed by main.js's poll (#324). null until the
    // first poll — which is itself an answer on an unattended box: it means the
    // poller never started, not that it is healthy.
    this.calendarHealth = null;
    this.detectedMeetUrls = [];  // Meet URLs found in browser tabs (when not in a call)
    this.detectedSlackHuddleUrl = null; // app.slack.com/client/<team>/<channel> when a huddle is live in a browser tab
    this.participants = [];      // [{ name, speaking, isPseudo }] from DOM speaker tracker
    this.screenShares = [];      // [{ name, id }] — every screen share in the people pane
    this.someoneElsePresenting = false;  // another participant is screen sharing
    this.presenterName = null;   // name of the person presenting (if any)

    // Real-time speaking state (from DOMSpeakerTracker, not captions)
    this.anyoneSpeaking = false;       // true if any participant is currently speaking
    // #115: the analyser-based floor signal (page-inject, ~16ms) alongside the
    // DOM-mutation one that sets anyoneSpeaking (~400-700ms). Always recorded so
    // a real call yields the latency comparison; only folded into the gates when
    // fastFloorDetection is on.
    this.audioFloorSpeaking = false;
    this._audioFloorAt = 0;
    // #392: when the analyser last reported speech OFF. The participant
    // tracker's `speaking` flag can lag the analyser's falling edge by
    // seconds (polled release), so barge-in re-checks liveness against THIS
    // at grace evaluation instead of trusting the tracker flag alone.
    this._audioFloorOffAt = 0;
    this._domFloorAt = 0;
    // #343: how many participants (excl. self) are speaking RIGHT NOW. The old
    // `anyoneSpeaking` boolean collapses this away, but the count is the raw
    // interruptibility signal — 1 speaker is far more interruptible than 2-3 in
    // crosstalk. `_peakSpeakersSinceQuiet` tracks the busiest moment while the
    // bot waited, reset once it gets a turn; logged at resolve to validate the
    // premise that the bot chokes specifically when the floor is ≥2-deep.
    this.activeSpeakerCount = 0;
    this._peakSpeakersSinceQuiet = 0;
    // #368: is the bot actually EMITTING AUDIO right now (speaking aloud), as
    // opposed to botState==='speaking' meaning "the agent is inside a speak()
    // call." Set true when playback starts, cleared on tts-ended (queue drain) /
    // back-off / call reset. While true, botState is held at 'speaking' against
    // the agent loop's premature thinking/listening transitions — so barge-in
    // (and the probe gate) see 'speaking' for the FULL audio, not just the sliver
    // the agent spends in the speak() call. This is what makes bot==='speaking'
    // mean "speaking aloud."
    this.speakingAloud = false;
    // #368 follow-up: when the bot last STOPPED speaking aloud. A long bot
    // monologue produces a 0-remote-caption gap (self-captions are filtered), so
    // the caption-stall/deaf detector must not read that gap as deafness. This
    // lets the stall handler tell "gap explained by the bot's own speech" from
    // real deafness even a moment after the bot finishes.
    this.lastSpokeAloudAt = 0;
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
    this._tickFaceTimer = null;
    // Fires one full silence-gate after the floor goes quiet while a barge-in
    // stash is pending. Deliberately independent of this.waiters — see
    // _maybeReplayStashOnOpening.
    this._stashOpeningTimer = null;

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

    // #109: the counterpart — texts of a stash that was DISCARDED rather than
    // replayed, plus why. Same one-shot surfacing, so the agent learns its
    // reply never reached the room instead of inferring it from a missing note.
    this._lastDiscardedStash = null;

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
    this._bargeInClearTimer = null;
    // #392: when the current monitor was armed. The analyser's quiet verdict
    // at grace evaluation is only trusted if the analyser produced an OFF edge
    // AFTER this — proof it actually tracked the interruption to its end. An
    // OFF timestamp older than the arm could just mean the analyser missed
    // this speaker entirely (threshold too high, no remote track), and bailing
    // on that would mean never yielding to them. That failure direction —
    // talking over a human forever — is the one we must not have, so a
    // missing/stale analyser signal falls back to the tracker-flag behavior.
    this._bargeInArmedAt = 0;

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
    // Anything the AGENT did, not just wait_for_speech (#38). Every MCP tool
    // reaches the app over HTTP, so one stamp at the request door covers the
    // whole surface — including the long tool-work stretches where the loop is
    // legitimately not waiting and would otherwise look dead.
    this.lastAgentActivityAt = null;
    // Set when a long-poll's socket dies before the poll resolves, i.e. the
    // agent process went away mid-wait. Unlike the timestamp above this is not
    // an inference from elapsed time — it is the OS telling us the peer is
    // gone — so it counts immediately. Cleared by the agent's next request.
    this.agentSocketLostAt = null;

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

  // Calendar auto-join (#299): the matched Google Calendar event, when this
  // join was triggered by one — so the spawned agent can see WHY it's here
  // (the event's title/description/start) via get_room_info, instead of
  // walking into a call cold. Call AFTER setRoom (setRoom clears this).
  setCalendarEventContext(event) {
    if (!event) { this.calendarEventContext = null; return; }
    this.calendarEventContext = {
      summary: event.summary || null,
      description: event.description || null,
      start: event.start || null,
    };
  }

  setRoom(roomId) {
    // Rejoining the SAME room while a call id is still live (i.e. during
    // after-call-work, which deliberately does not clear it — see the
    // isFinished() guard in _setCallStatus). The call id survives that rejoin,
    // so the two segments are one call by every other measure; wiping the
    // transcript here made `read_transcripts` return only the segment after the
    // rejoin, and the agent's own write-up of the call silently lost its first
    // half. Keep the conversation state so the transcript matches the id.
    //
    // Only the conversation carries over. Everything below — whiteboard,
    // members, sharing, presence — is re-derived from the room on join anyway.
    const resuming = !!roomId && this.roomId === roomId && !!this.callId;
    this.roomId = roomId;
    // Calendar auto-join (#299): set via setCalendarEventContext, right after
    // setRoom, only when this join was calendar-triggered — cleared here so a
    // manual join (or the next calendar join) never inherits a stale one.
    this.calendarEventContext = null;
    if (!resuming) {
      this.transcripts = [];
      this.turns = new Map();
      this._speakerTurnCount = new Map();
      this._openTurnBySpeaker = new Map();
      this._nextTurnId = 1;
    }
    // ALWAYS cleared, resume or not, and deliberately outside the block above.
    //
    // This set does not gate ingest — it is the #12 diagnostic that counts how
    // many scraper turnIds in a batch we have never seen, to tell a container
    // re-render apart from ordinary new speech. Carrying it across a rejoin
    // would quietly blind that: `captionScraper` is module-scope, so a rejoin's
    // fresh page starts minting turnIds at 1 again, every one of them already
    // in this set. Genuinely new turns would count as familiar, and the signal
    // would read "no re-render here" in exactly the situation it exists to
    // flag. A fresh page is a fresh id space, so it gets a fresh set.
    this._seenScraperTurnIds = new Set();
    this._replayAlarmFired = false;
    this.replayAlarmCount = 0;
    this._deliveredFps = new Map();
    this._replayDeliveryFired = false;
    this.replayDeliveryCount = 0;
    this.whiteboard = { content: '', version: 0, lastModified: null, lastEditor: null };
    this.members = [];
    this.sharing = false;
    this.errors = [];
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.activeSpeakerCount = 0;
    this._peakSpeakersSinceQuiet = 0;
    this.speakingAloud = false;
    this.lastSpokeAloudAt = 0;
    this._currentUrgency = null;
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
    //
    // 'navigating', NOT 'joining': this only records intent — the BrowserView
    // may not even have loadURL() called yet. It used to jump straight to
    // 'joining', which meant `get_room_info` reported "joining" the instant a
    // --meet-url launch (or any programmatic join) recorded the room, even
    // before the page had rendered. The real 'joining' now only fires once
    // Meet's own DOM confirms it (see the 'Joining...'/'Joining Meet...'
    // status text handled in the CALL_EVENTS.statusUpdate listener in
    // main.js), so agents polling get_room_info can tell "dispatched" from
    // "Meet is actually attempting to admit us" apart.
    this.setCallStatus('navigating');
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
    this._speakerTurnCount = new Map();
    this._openTurnBySpeaker = new Map();
    this._nextTurnId = 1;
    this._seenScraperTurnIds = new Set();
    this._replayAlarmFired = false;
    this.replayAlarmCount = 0;
    this._deliveredFps = new Map();
    this._replayDeliveryFired = false;
    this.replayDeliveryCount = 0;
    this.members = [];
    this.sharing = false;
    this.participants = [];
    this.someoneElsePresenting = false;
    this.presenterName = null;
    this.anyoneSpeaking = false;
    this.activeSpeakerCount = 0;
    this._peakSpeakersSinceQuiet = 0;
    this.speakingAloud = false;
    this.lastSpokeAloudAt = 0;
    this._currentUrgency = null;
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
    const botNames = this._botNameSet();
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
    // an active state (navigating / joining / waiting / in-call) without one.
    // Format: <roomCode>-<compact-UTC-timestamp> (e.g. kku-fpvq-smx-20260629T164900Z).
    // One per call, cleared on end, so it disambiguates multiple calls within a
    // single session log and is greppable as a `[call] id=…` block (#292).
    const activeState = status === 'navigating' || status === 'joining' ||
      status === 'waiting-to-be-admitted' || status === 'in-call';

    // #430: announce ourselves and learn the other bots, on a heartbeat. The
    // presence entry has a 5-minute TTL, so this both keeps ours alive and
    // refreshes the peer list as bots come and go mid-call. Started on the first
    // active state rather than on in-call: a bot waiting to be admitted is
    // already a peer the bots inside should know about.
    if (activeState && !this._presenceTimer) {
      const beat = () => { this._registerPresence(); this._refreshPresencePeers(); };
      beat();
      this._presenceTimer = setInterval(beat, 60_000);
      if (this._presenceTimer.unref) this._presenceTimer.unref();
    }
    if (!activeState && this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
      this._presencePeers = null;
      this._presenceLoggedOk = false;
    }
    if (activeState && !this.callId) {
      this.callStartedAt = new Date().toISOString();
      const code = this.roomId || 'call';
      this.callId = `${code}-${this.callStartedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
      console.log(`[call] id=${this.callId} room=${this.roomId || '(unknown)'} status=${status} started=${this.callStartedAt}`);
      // Which knobs were live for THIS call. Per call rather than per session,
      // because preferences change mid-session — set_preference applies
      // immediately — and a session log can hold several calls. Anything read at
      // launch would be a claim about a different call than the one being
      // debugged.
      //
      // Costs ~10 lines against a call's ~12,000, and would have turned two days
      // of statistical inference into one grep (#417).
      try {
        // Bare console.log, like the `[call] id=` line above it: the auto-stamp
        // wrapper adds the timestamp, and passing ts() here would double it.
        for (const line of prefsSchema.snapshotForLog((k) => (this.getPref ? this.getPref(k) : undefined),
          { label: `call ${this.callId}` })) console.log(line);
      } catch (err) {
        console.warn(ts(), '[prefs] snapshot failed:', err.message);
      }
    }

    // Drop pending speech if we never made it in (call failed / cleared).
    // Pending flush itself is gated on first-participants-seen, not in-call —
    // 'in-call' fires when Meet's UI is up, but the bot's mic track isn't
    // reliably connected to other participants until the people pane is
    // populated (a stronger 'fully wired up' signal). See _flushPendingBotSpeech.
    // Teardown-ish cleanup waits for the END of the lifecycle. During
    // after-call-work the call is over but the agent is still working, and
    // dropping its state there is exactly what this phase exists to prevent.
    if (isFinished(status)) {
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

  // #221: whether room state can currently be READ back from the sync server.
  // A write can succeed while this is false — the content is stored and nobody
  // can fetch it — which is exactly the failure that went unnoticed on Aug 1.
  // Set by the sync poll, read by the whiteboard write path.
  setBoardReadHealthy(healthy) {
    this.boardReadHealthy = healthy !== false;
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

  // How long to hold a reply before audio starts, to keep two bots from
  // answering the same prompt in unison (#230, #100).
  //
  // The delay only helps if the LOSER can notice the winner before its own turn
  // comes up — and noticing is slow. DOMSpeakerTracker needs MIN_MUTATIONS = 3
  // in a 1200ms window (google-meet-provider.js), so another bot takes roughly
  // 400-700ms to register as speaking. Two draws from U(0, J) differ by more
  // than the detection latency D with probability (1 - D/J)^2:
  //
  //     J=800  (the old default)   D=500ms  ->  yields  14%
  //     J=2000                     D=500ms  ->  yields  56%
  //
  // So the original 800ms window decorrelated the STARTS without converting
  // into a yield in ~86% of collisions. That is what the Jul 28 call sounded
  // like: jitter fired 119 times and bots still answered together.
  //
  // Two changes. The window is wider, and the delay is ORDERED BY URGENCY — the
  // reply the agent scored higher goes first by construction instead of winning
  // a coin flip, with a random component to break ties between equal scores.
  // Unscored counts as 0.5, the same midpoint convention used elsewhere.
  //
  // Still a mitigation, not a fix. Two bots that pick the same delay still
  // collide; the real answer is a shared floor claim, which needs a channel
  // between instances that doesn't exist yet. Tracked in #100.
  _speakDelay(t, others) {
    const maxJitter = Number(this._pref('botSpeakJitterMaxMs')) || 0;
    // Only meaningful when someone else could be answering too. Solo and
    // single-human calls stay snappy.
    if (others < 2 || maxJitter <= 0) return { delayMs: 0, why: 'no collision risk' };

    // #100 follow-up: the DETERMINISTIC path, when peers are known.
    //
    // Jitter is a private coin flip, so it can only buy separation with
    // latency, and never reaches zero collisions — (1 - D/N)^2 with the
    // measured D leaves ~17% of them at N=2000 while charging every bot a mean
    // 1000ms on every turn. Ranking uses knowledge the bots ALREADY SHARE (the
    // roster, and the utterance Meet showed all of them) so they reach the same
    // order without exchanging anything, and the winner waits for nothing.
    //
    // Falls through to jitter whenever the peer set is unknown or this bot is
    // not in it — so the worst case is exactly today's behaviour.
    const ranked = this._rankedSpeakDelay(t);
    if (ranked) return ranked;

    const lead = Number(this._pref('botSpeakUrgencyLeadMs')) || 0;
    const u = (typeof t?.urgency === 'number') ? Math.max(0, Math.min(1, t.urgency)) : 0.5;
    // Low urgency waits longer, so the more valuable reply reaches the floor first.
    const urgencyPart = Math.round((1 - u) * lead);
    const randomPart = Math.floor(Math.random() * maxJitter);
    return {
      delayMs: urgencyPart + randomPart,
      why: `urgency ${u.toFixed(2)} → ${urgencyPart}ms + ${randomPart}ms random`,
    };
  }

  // The deterministic ordering (electron-app/speak-order.js). Returns null when
  // it cannot be computed, which is the caller's signal to keep using jitter.
  //
  // peerBotNames is explicit configuration for now. The roster does not say
  // which participants are bots, and the website's presence list came back
  // empty when checked (2026-08-17), so there is no automatic source yet —
  // announcing over the room's chat, or populating presence, would both work
  // later. Leaving it unset keeps today's behaviour exactly.
  // Every early return says WHY, once per call. A silent fallback to jitter is
  // indistinguishable from the feature being off, which cost an afternoon:
  // preferences were set, the code was live, and the only visible symptom was
  // that the collision rate did not improve.
  _rankedSkip(why) {
    if (this._lastRankSkip !== why) {
      this._lastRankSkip = why;
      console.log(ts(), `🎲 [bot-order] ranked ordering unavailable (${why}) — using jitter`);
    }
    return null;
  }

  _rankedSpeakDelay(t) {
    const mode = this._pref('botSpeakOrdering');
    if (mode !== 'ranked') return this._rankedSkip(`botSpeakOrdering=${JSON.stringify(mode)}`);
    const self = this.getEffectiveBotName();
    if (!self) return this._rankedSkip('this bot has no name yet');
    // Peers come from the website's room presence, where every bot registers
    // itself with role='bot' (verified live 2026-08-17). peerBotNames is the
    // manual override for when presence is unreachable or a peer predates it.
    // Candidates come from the ROSTER — nothing here needs the server.
    //
    // Everything the ordering depends on is already local and already shared:
    // every bot has the same people pane, and Meet gives every participant the
    // same captions. The only thing the roster does NOT say is which
    // participants are bots — and that turns out not to matter. Rank everyone:
    // all bots still derive the same order, and a human simply never claims
    // their slot, at which point the next rank finds the floor free and speaks.
    //
    // The bot set is REQUIRED, despite what this comment used to claim. The
    // reasoning above ("rank everyone, a human never claims their slot") is
    // sound in isolation and does not survive the next step: the seed is the
    // last utterance by someone OUTSIDE the bot set, and ranking everyone puts
    // everyone inside it. `last` then finds nobody and this returns
    // _rankedSkip('no human utterance yet') on every call — so an empty set
    // does not degrade the ordering, it disables it. Measured live 2026-08-17
    // (#430): ranked was set on two bots and neither ever ordered.
    //
    // What is no longer required is TYPING it. Each bot now registers itself in
    // room presence with role='bot' and both its names, and _refreshPresencePeers
    // resolves those to the roster names ordering ranks over. peerBotNames stays
    // as the override for when discovery is wrong or the backend is unreachable.
    //
    // This also removes a class of bug rather than patching it: presence
    // records the CONFIGURED bot name while Meet shows the display name for
    // this call, and under test those differ ("Alice" vs "Alice-r4a32"), so
    // each bot was counted twice and the order came out "rank 4 of 5" in a room
    // holding three bots — every one of them queued behind peers that did not
    // exist. Names taken from the roster are the names everyone else sees.
    const roster = (this.participants || [])
      .filter((p) => p && p.name && !p.isSelf && p.name !== 'You' && !p.isPseudo)
      .map((p) => p.name);
    // Configured list first — an explicit answer beats a derived one, and it is
    // the escape hatch when discovery is wrong or the backend is unreachable.
    // Otherwise use what presence told us (#430): every bot registers itself
    // there with role='bot' and BOTH its names, so this needs no typing.
    const configured = Array.isArray(this._pref('peerBotNames')) ? this._pref('peerBotNames') : [];
    const discovered = Array.isArray(this._presencePeers) ? this._presencePeers : [];
    const source = configured.length ? configured : discovered;
    if (!source.length) {
      return this._rankedSkip('no peer bots known — presence has not named any yet, '
        + 'and peerBotNames is empty');
    }
    const known = new Set(source.map((n) => n.toLowerCase()));
    const peers = roster.filter((n) => known.has(n.toLowerCase())
      || source.some((s) => namesMatch(n, s)));
    if (!peers.length) {
      return this._rankedSkip(`none of the ${source.length} known bot name(s) are in the `
        + `roster (${roster.length} listed)`);
    }

    // The utterance being answered: the last thing said by a HUMAN — anyone
    // outside the bot set.
    //
    // "The last thing not said by ME" was the obvious rule and it is wrong,
    // because it is self-relative: in a three-way exchange each bot excludes a
    // different speaker and so keys on a different utterance. Measured live
    // 2026-08-17 with three bots — Alice and Jimmy both keyed on Cosmo's line
    // while Cosmo, excluding itself, keyed on Jimmy's, giving two different
    // seeds and therefore two different winners.
    //
    // Excluding EVERY bot fixes it because the exclusion set is common
    // knowledge: all bots hold the same roster, so all bots land on the same
    // human turn. It is also what the ordering is FOR — deciding who answers
    // the person, not who answers another bot.
    // _entriesSince, NOT this.transcripts.
    //
    // this.transcripts holds only the bot's OWN speech and legacy Web-Speech
    // entries. Human speech arrives as Meet CAPTION TURNS, which live in
    // _turnsAsEntries() — and _entriesSince merges the two, which is why the
    // sync API shows a human utterance that this.transcripts never contains.
    // Reading the wrong collection made this report "no human utterance to key
    // on yet" for hours while the speaker was plainly in the API's transcript.
    const speakers = new Set([self.toLowerCase(), ...peers.map((p) => p.toLowerCase())]);
    const all = this._entriesSince(null, null) || [];
    const last = [...all].reverse()
      .find((e) => e && e.text && e.participantName && !speakers.has(e.participantName.toLowerCase()));
    if (!last) return this._rankedSkip(`no human utterance yet (${all.length} entries, excluding ${[...speakers].join('/')})`);

    let ranked;
    try {
      const { speakDelay } = require('./speak-order.js');
      ranked = speakDelay({
        selfName: self,
        botNames: [...new Set([...peers, self])],
        speaker: last.participantName,
        utterance: last.text,
        gapMs: Number(this._pref('botSpeakRankGapMs')) || 500,
      });
    } catch (err) { return this._rankedSkip(`speak-order threw: ${err.message}`); }
    if (!ranked) return this._rankedSkip(`this bot ("${self}") is not in the peer set`);

    // Urgency deliberately absent: a bot cannot know the others' urgency, so
    // folding its own in would give each bot a different order and undo the
    // agreement this depends on. That needs an exchange of intent (a server
    // auction), not a local calculation.
    return { delayMs: ranked.delayMs, why: `ranked ${ranked.why}` };
  }

  // Speak now, or after the delay above.
  //
  // #67: this is ALSO where the floor is checked — at the moment audio would
  // start, and nowhere earlier. The check used to sit in _handlePost, before
  // the jitter below, which got it wrong in BOTH directions: it missed speech
  // that started during the delay (the bot talked over it), and it stashed
  // against speech that had already stopped by the time audio was ready (the
  // bot went silent for no reason). A floor read is only meaningful at the
  // instant it gates.
  //
  // Resolves 'spoken' | 'stashed' | 'aborted' so the caller can tell the agent
  // what actually happened to its reply.
  _speakWithBotJitter(t, { exempt = false } = {}) {
    return new Promise((resolve) => {
      const speakNow = () => {
        if (this.callStatus !== 'in-call') return resolve('aborted'); // call ended during the jitter
        if (this.floorBusy) {   // #115: analyser-or-DOM when fastFloorDetection is on
          if (!exempt) {
            this._stashUnspokenSpeech([t]);
            return resolve('stashed');
          }
          console.log(ts(), '🛡️  [barge-in] EXEMPT — playing over speech:', String(t.text || '').slice(0, 60));
        }
        // #367: remember this utterance's self-scored urgency so _armBargeIn can
        // scale the grace by how badly the bot wanted to be heard.
        this._currentUrgency = (typeof t.urgency === 'number') ? t.urgency : null;
        this._setBotState('speaking', { emoji: t.emoji });
        this.onBotSpeech(t.text, t.voice, t.emoji);
        resolve('spoken');
      };
      const others = (this.participants || []).filter(p => !p.isSelf && p.name && p.name !== 'You').length;
      const { delayMs, why } = this._speakDelay(t, others);
      if (delayMs > 0) {
        console.log(ts(), `🎲 [bot-jitter] ${others} others in call — delaying speak ${delayMs}ms (${why})`);
        setTimeout(speakNow, delayMs);
      } else {
        speakNow();
      }
    });
  }

  // Hold composed-but-unspoken bot speech for replay on the next opening,
  // rather than discarding it (#239 — discarding forced the agent into a fresh
  // 15-30s round to re-derive the same answer). The next silence edge replays
  // it via _maybeReplayBargeInStash(), unless it has aged out or the
  // conversation has moved on past it.
  _stashUnspokenSpeech(entries, { at } = {}) {
    const stashEntries = entries
      .filter((t) => t && t.text)
      .map((t) => ({ text: t.text, voice: t.voice, emoji: t.emoji, urgency: t.urgency }));
    if (stashEntries.length === 0) return false;
    // A second stash before the first ever got its opening means the earlier
    // thought is being discarded. That used to happen silently — the single
    // biggest reason stashes "disappeared" without a log line.
    if (this.bargeInStash) {
      const lostAgeMs = Date.now() - this.bargeInStash.at;
      console.log(ts(), '🛡️  [barge-in] overwriting an unplayed stash (' + lostAgeMs + 'ms old, ' +
        this.bargeInStash.entries.length + ' entr' + (this.bargeInStash.entries.length === 1 ? 'y' : 'ies') +
        ') — the floor never opened for it:', JSON.stringify((this.bargeInStash.entries[0]?.text || '').slice(0, 60)));
    }
    // Baseline the words-heard-from-others counter so the replay path can
    // measure how much NEW speech landed while the reply was held.
    this.bargeInStash = {
      entries: stashEntries,
      // `at` is when the thought was COMPOSED, not when it was last held. A
      // re-hold that restamped it would let a reply outlive
      // bargeInStashMaxAgeMs indefinitely, one hold at a time, and the age
      // guard exists precisely because a stale answer is worse than none.
      at: at || Date.now(),
      wordsAtStash: this._tickWordCount(this.getEffectiveBotName()),
    };
    console.log(ts(), '🛡️  [barge-in] Floor busy at audio-start — stashed bot speech for replay (' +
      stashEntries.length + ' entr' + (stashEntries.length === 1 ? 'y' : 'ies') + '):',
      String(stashEntries[0].text).slice(0, 60));
    this._setBotState('yielding', { reason: 'user-speaking' }, { force: true });
    return true;
  }

  // Apply a sync payload's transcript entries: speak them (bot) or record them
  // (member), and report back what happened for results.transcript. Split out
  // of _handlePost so the speak/stash decision is reachable without an HTTP
  // round-trip (see tests/floor-gate-at-audio-start.test.mjs).
  async _applyTranscriptPayload(data, roomId, now) {
    // #199: set when speech was accepted but the bot is not in the call yet, so
    // the MCP layer can say "queued" instead of "spoken".
    let queuedUntilInCall = false;
    // In silent mode, suppress bot speech entirely — don't record or speak.
    // Agent learns its speech was suppressed via results.transcript.reason.
    // #338: some bot utterances are exempt from the barge-in hold — they're
    // brief and a little overlap beats the alternative (silence → the room
    // re-asks → a duplicate answer, the #335 failure). Two exemptions:
    //   • the turn's OPENING ACK — the first reply to a resolve (_pendingTurnSince),
    //     capped at bargeInAckMaxWords so a real ack is protected but a runaway long
    //     "first reply" can't steamroll a human. This "I'm on it" is the whole signal
    //     that keeps the room from re-asking while the bot does slow tool work.
    //   • very short utterances — backchannels ("Got it.", "On it.")
    // Substantive mid-turn responses are NOT exempt — they still yield.
    //
    // #109: BOTH conditions now also require enough self-scored URGENCY. Length
    // alone was the gate, and it let 30-word paragraphs through — while urgency,
    // which the agent already scores on every utterance, was consulted ONLY after
    // speech had started (to scale the grace, #367). The combination was backwards:
    // a low-value interruption both began AND then held the floor longer for it.
    // Measured on the Jul 28 call: every short utterance that actually played over
    // a live speaker scored 0.3-0.4, and every 0.8-0.9 short one went out into an
    // open floor where no exemption was needed — so the floor costs nothing.
    // Unscored → 0.5, the same midpoint convention the grace scaling uses, so an
    // agent that never passes urgency keeps its acks.
    const _firstReplyToResolve = this._pendingTurnSince != null;
    const _botText = data.role === 'bot' ? (data.transcript.map((t) => t && t.text ? t.text : '').join(' ').trim()) : '';
    const _wordCount = _botText ? _botText.split(/\s+/).length : 0;
    // All three knobs read live (tunable mid-call via set_preference).
    const _exemptPref = this._pref('bargeInAckExempt');
    const _ackExemptOn = _exemptPref !== false && _exemptPref !== 'false';
    const _ackMax = Number(this._pref('bargeInAckMaxWords')) || 0;
    const _bcMax = Number(this._pref('bargeInBackchannelMaxWords')) || 0;
    // #109: unscored counts as the midpoint, matching _graceForCurrentUtterance.
    const _minUrgency = Number(this._pref('bargeInAckMinUrgency'));
    const _scored = data.role === 'bot'
      ? data.transcript.map((t) => t && t.urgency).find((u) => typeof u === 'number')
      : undefined;
    const _urgency = typeof _scored === 'number' ? _scored : 0.5;
    const _urgentEnough = !Number.isFinite(_minUrgency) || _minUrgency <= 0 || _urgency >= _minUrgency;
    const _bargeExempt = data.role === 'bot' && _ackExemptOn && _wordCount > 0 && _urgentEnough &&
      ((_firstReplyToResolve && _wordCount <= _ackMax) || (_bcMax > 0 && _wordCount <= _bcMax));
    if (data.role === 'bot' && _wordCount > 0 && !_urgentEnough &&
        ((_firstReplyToResolve && _wordCount <= _ackMax) || (_bcMax > 0 && _wordCount <= _bcMax))) {
      console.log(ts(), `🛡️  [barge-in] not exempt — urgency ${_urgency.toFixed(2)} < ${_minUrgency} (short enough, but not worth interrupting for)`);
    }

    // #343: log the slow model's self-scored urgency against the live floor
    // state (concurrent speakers + peak-while-waiting), for EVERY bot speak
    // attempt regardless of the outcome below. This is the raw scatter
    // — urgency vs interruptibility — we fit the speak/wait gate from later.
    // Log-only for now; nothing gates on it yet.
    if (data.role === 'bot' && _wordCount > 0) {
      const _urg = data.transcript.map((t) => t && t.urgency).find((u) => typeof u === 'number');
      const _urgStr = typeof _urg === 'number' ? _urg.toFixed(2) : 'n/a';
      console.log(ts(), `🎯 [urgency] u=${_urgStr} floor=${this.activeSpeakerCount} (peak ${this._peakSpeakersSinceQuiet}) words=${_wordCount}${_firstReplyToResolve ? ' first-reply' : ''}`);
    }

    if (data.role === 'bot' && this.mode === 'silent') {
      return { ok: false, reason: 'mode-silent', sent: 0, entries: [] };
    }

    // #67: NO floor check here. It used to live at this point — before the
    // speak jitter and before TTS synthesis — which meant it was reading the
    // room up to a second before any audio could play, and got it wrong in
    // both directions. The gate now lives in _speakWithBotJitter, at the
    // instant audio starts; we await its verdict so the agent still gets an
    // accurate synchronous answer.
    const entries = [];
    let stashed = false;
    for (const t of data.transcript) {
      if (!t.text) continue;

      // Bot speech goes to the speak path FIRST, and is only recorded as a
      // transcript entry once it has actually gone out — a stashed reply was
      // never said, so it must not appear in the transcript. Deferred
      // (pre-in-call) speech is queued below and recorded as before.
      if (data.role === 'bot' && this.callStatus === 'in-call') {
        const outcome = await this._speakWithBotJitter(
          { text: t.text, voice: t.voice, emoji: t.emoji, urgency: t.urgency },
          { exempt: _bargeExempt },
        );
        if (outcome !== 'spoken') {
          if (outcome === 'stashed') stashed = true;
          continue;
        }
      }

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
      if (typeof t.urgency === 'number') entry.urgency = t.urgency; // #343: self-scored, for the analyzer
      this.transcripts.push(entry);
      entries.push(entry);

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
        // TTS was already dispatched above when in-call. If we're NOT in the
        // call yet, queue it: the virtual mic stream isn't connected to Meet's
        // other participants until callStatus is 'in-call', so speaking
        // earlier plays into the void. The transcript entry is recorded now
        // either way, so order is preserved on flush.
        if (this.callStatus !== 'in-call') {
          console.log('[local-server] Queueing bot speech until in-call:', t.text.slice(0, 40));
          this.pendingBotSpeech.push({ text: t.text, voice: t.voice, emoji: t.emoji, urgency: t.urgency });
          // #199: the caller must not be told "Spoken". It was ACCEPTED and will
          // play on flush, so this is not an error — but nothing has been heard
          // yet, and reporting intent as outcome is what cost ~8 minutes of
          // hunting TTS/keys/captions during the stranger drill (#198) while the
          // app sat wedged at 'navigating' and every speak returned success.
          queuedUntilInCall = true;
        }
      }
    }

    if (stashed && entries.length === 0) {
      // Distinct reason so the MCP layer tells the agent to STAND DOWN (its
      // reply is queued and will auto-replay) rather than re-derive.
      return { ok: false, reason: 'user-speaking-stashed', sent: 0, entries: [] };
    }
    return {
      ok: true,
      sent: entries.length,
      entries,
      // #199 — truthful outcome, not intent.
      ...(queuedUntilInCall ? { queuedUntilInCall: true, callStatus: this.callStatus } : {}),
      // #253: tell the agent its PREVIOUS speech never played, at the moment it
      // speaks again — the point where it would otherwise build on a reply the
      // room never heard.
      ...((() => { const f = this.takeRecentPlaybackFailure(); return f ? { previousPlaybackFailed: f } : {}; })()),
      // #360: same moment, subtler failure — the previous speech PLAYED but was
      // cut off partway by a barge-in.
      ...((() => { const t = this.takeSpeechTruncation(); return t ? { previousSpeechTruncated: t } : {}; })()),
    };
  }

  // Speech composed before the bot could be heard, played once it can.
  //
  // What lands here is almost always the greeting: the agent calls speak while
  // the app is still joining, and the virtual mic is not connected to the other
  // participants until then, so saying it earlier plays into the void.
  //
  // Which means this fires the moment a bot arrives in a meeting ALREADY IN
  // PROGRESS. It used to emit straight into the room with no floor read and no
  // separation from a second bot joining beside it — a greeting talked over the
  // person mid-sentence, and two bots joining together greeted in unison. Both
  // are the failures the rest of the speech paths already guard against; this
  // one simply predates them.
  //
  // Gated as one batch, not per entry: the queue is one logical utterance in
  // order, and holding half of it would be worse than holding all of it.
  async _flushPendingBotSpeech() {
    if (this.pendingBotSpeech.length === 0) return;
    console.log('[local-server] Flushing', this.pendingBotSpeech.length,
      'queued bot speech entries (now playing)');
    const queue = this.pendingBotSpeech;
    this.pendingBotSpeech = [];

    // Ranked when the peers are known, jitter otherwise. At join the transcript
    // is usually empty, so ranking has no human utterance to seed on and this
    // falls through to jitter — which is still the difference between two bots
    // greeting in unison and greeting in turn.
    const others = (this.participants || [])
      .filter((p) => !p.isSelf && p.name && p.name !== 'You').length;
    const { delayMs, why } = this._speakDelay(queue[0], others);
    if (delayMs > 0) {
      console.log(ts(), `🎲 [bot-jitter] ${others} others in call — delaying queued speech ${delayMs}ms (${why})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // The floor, read HERE — after the delay, at the instant audio would start,
    // which is the only instant it means anything (#67).
    if (this.floorBusy) {
      this._stashUnspokenSpeech(queue);
      console.log(ts(), '🛡️  [barge-in] queued speech held — someone was talking as we joined');
      return;
    }

    for (const { text, voice, emoji, urgency } of queue) {
      console.log('[local-server] Playing queued speech:', text.slice(0, 60));
      this._currentUrgency = (typeof urgency === 'number') ? urgency : null; // #367
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

  setChatUnread(unread, { authoritative = false } = {}) {
    // Only a successful read_chat may CLEAR the flag (authoritative: the agent
    // provably consumed the messages). The page's false edge must not: Meet
    // marks chat read the moment the pane opens, and the bot opens the pane
    // for its OWN send_chat — so every send was silently erasing unread state
    // the agent had never seen, and the "[Unread chat messages]" notice never
    // reached wait_for_speech for bots that post a lot (#397). The true edge
    // still passes through; a spurious badge nags until the next read, which
    // is the visible failure mode, not the silent one.
    if (!unread && !authoritative) {
      if (this.chatUnread) {
        console.log('[local-server] Chat badge cleared page-side (pane open?) — keeping unread set until read_chat consumes it (#397)');
      }
      return;
    }
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

  // The one set of callbacks every agent-activity transport feeds (#242).
  // Factored out so the constructor, useStreamAgentSource and
  // releaseStreamAgentSource can't drift apart.
  _agentSourceCallbacks() {
    return {
      onLines: (lines) => {
        const prevLast = this.agentLog.length ? this.agentLog[this.agentLog.length - 1] : null;
        this.agentLog = lines;
        const last = lines.length ? lines[lines.length - 1] : null;
        if (last && last !== prevLast) this._onAgentActivity(last);
      },
      // Which model is actually authoring replies for the driving session — read
      // straight from its own transcript, so it's correct regardless of launch
      // path (app-spawned with --model, or an existing session that ran
      // /join-call). Logged (not just held in memory) so latency-audit.py can
      // group cycles by model the same way it already groups by build.
      onModel: (model) => {
        this.agentModel = model; // #385: surfaced in the brain window header
        console.log(ts(), `🧠 [agent] model=${model}`);
      },
      // Per-turn context size, read off the driving session's own usage report
      // (#345). `input` is the full prompt the model processed for the turn —
      // fresh + cache reads + cache writes — so this is the direct test of the
      // context-growth-slows-replies hypothesis; latency-audit.py buckets
      // D-claude against it.
      onUsage: (u) => {
        console.log(ts(), `📊 [context] input=${u.input} (fresh=${u.fresh} cacheRead=${u.cacheRead} cacheWrite=${u.cacheCreate}) output=${u.output}`);
      },
    };
  }

  // #242: switch to the stream transport, for an agent the APP launched and
  // therefore owns. Returns the source so main can push stdout into it.
  //
  // Replacing rather than adding: two live sources would interleave two agents'
  // activity into one buffer, and the resulting feed would be worse than either
  // alone — you could not tell which bot said what.
  useStreamAgentSource() {
    try { this._agentSource.stop(); } catch { /* already gone */ }
    this._agentSource = new StreamActivitySource(this._agentSourceCallbacks());
    this._agentSource.bind();
    this._streamBindNoted = false;
    this.agentModel = null; // #385: a new agent — don't show the old one's model
    console.log(ts(), '[local-server] Agent activity source → stream (app-launched agent)');
    return this._agentSource;
  }

  // The stream transport's agent has EXITED — hand the feed back to the
  // transcript tail so the next driving session (a terminal /join-call) can
  // bind. Without this, the dead stream source kept winning setAgentSession's
  // "stream beats transcript" guard for the rest of the app's life: on the
  // 2026-08-10 Seth call, the app-spawned agent's brief join died at 17:13,
  // Stan drove the real call from a terminal, and every 🧠 model / 📊 context
  // marker went dark for 19 minutes — the guard's one-time notice had already
  // fired, so the rejection was silent, and latency-audit attributed the whole
  // call to the dead agent's model.
  //
  // Only main's onExit calls this, and only for the child it owns; a LIVE
  // stream agent is never displaced.
  releaseStreamAgentSource() {
    if (this._agentSource.kind !== 'stream') return;
    try { this._agentSource.stop(); } catch { /* already gone */ }
    this._agentSource = new TranscriptActivitySource(this._agentSourceCallbacks());
    this._streamBindNoted = false;
    this.agentModel = null; // #385: the next driving session may run a different model
    console.log(ts(), '[local-server] Agent activity source → transcript tail (stream agent exited)');
  }

  // Bind (or rebind) the agent-activity tail to a Claude session transcript.
  // Called from the /api/agent-session route, which the PostToolUse hook hits.
  setAgentSession({ sessionId, transcriptPath } = {}) {
    if (!transcriptPath) return;
    // #242: an app-launched agent's own stream WINS over any transcript bind.
    //
    // That agent fires this hook itself — it makes mcp__vibeconferencing__ calls,
    // which is exactly what PostToolUse matches — so without this guard its first
    // tool call would land here and hand its own transcript path to a
    // StreamActivitySource, whose bind() resets the buffer. The feed would clear
    // itself one tool call in and then stay empty, which is indistinguishable
    // from an agent doing nothing.
    //
    // Any other Claude session on this machine touching our port fires it too.
    // Either way the answer is the same: when we own the process, its stdout is
    // the better source, and a file we do not control must not displace it.
    if (this._agentSource.kind === 'stream') {
      if (!this._streamBindNoted) {
        this._streamBindNoted = true;
        console.log(ts(), '[local-server] Ignoring transcript bind — this agent is app-launched, '
          + 'and its own event stream is the source of truth');
      }
      return;
    }
    if (transcriptPath !== this._agentSource.path) {
      console.log('[local-server] Agent session bound:', sessionId || '?', '→', transcriptPath);
      this.agentModel = null; // #385: new session — its own turns will re-report the model
      // #125: say so when we bind a path that isn't there. The tailer tolerates
      // it (the 1.5s poll picks up a lazily-created file), so this is a warning
      // and not an error — but without it a missing transcript looks EXACTLY
      // like a working one: a confident "Agent session bound" and then silence.
      // That ambiguity cost an afternoon chasing a proof-of-life outage that
      // turned out not to exist.
      if (!fs.existsSync(transcriptPath)) {
        console.warn('[local-server] …but that transcript does not exist yet — agent activity will stay empty until it appears');
      }
    }
    this._agentSource.bind({ transcriptPath, sessionId });
  }

  getCallStateSnapshot() {
    // Cross-reference Meet participants against registered bot members so
    // the panel can show (bot) alongside (self) (#162). Same logic the MCP
    // get_room_info tool uses; centralizing the snapshot keeps the two
    // surfaces consistent.
    const botNames = this._botNameSet();
    return {
      callStatus: this.callStatus,
      mode: this.mode,
      localServerUrl: this.getLocalServerUrl(),
      localServerPort: this.port,
      localProfile: this.localProfile,
      // #324: is this instance actually going to turn up to its next scheduled
      // meeting? On a cloud box the panel banner that answers this has no
      // reader, so the answer has to be fetchable. null = never polled.
      calendarHealth: this.calendarHealth,
      // Calendar auto-join (#299): only present when this join was matched
      // from a Google Calendar event — see setCalendarEventContext.
      calendarEventContext: this.calendarEventContext || null,
      botState: this.botState,
      anyoneSpeaking: this.anyoneSpeaking,
      // #343: concurrent-speaker count (interruptibility signal) + the busiest
      // moment reached while the bot has been waiting for a turn.
      activeSpeakerCount: this.activeSpeakerCount,
      peakSpeakersSinceQuiet: this._peakSpeakersSinceQuiet,
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
      // #385: which model the driving session runs (e.g. claude-opus-5), read
      // off the session's own turns — null until it has authored one. Shown in
      // the brain window header so multiple bots are tellable apart.
      agentModel: this.agentModel || null,
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
      lastAgentActivityAt: this.lastAgentActivityAt,
      // Computed once, here, so the avatar and the Troubleshooting readout
      // can never disagree about whether anyone is driving.
      agentState: this.agentState(),
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

  // What happens when this bot's participation ends: does it get an after-call
  // work phase, and how long. Read at the moment of leaving rather than cached,
  // since both inputs can change mid-call.
  //
  // Reported to the AGENT so its handoff message can be specific — "you have 300
  // seconds" is actionable in a way that "you may have some time" is not. Also
  // the honest answer when the phase is off: it gets told to stop, as today.
  // Wait for the bot to finish saying what it already said it would say.
  //
  // leave_call has cut the bot off mid-sentence repeatedly. The agent's last act
  // is usually `speak("Bye!")` then `leave_call`, and speak() returns when the
  // text is QUEUED, not when it has been heard — so the two land within
  // milliseconds of each other and the goodbye dies in the Meet teardown. From
  // the room it reads as the bot hanging up on you.
  //
  // Two things have to drain, and they are different: pendingBotSpeech is text
  // waiting for its turn, speakingAloud is audio currently playing (#368).
  // Either one means "not finished".
  //
  // Capped, and the cap matters more than the wait: a stuck TTS must not make
  // leave_call hang forever. On timeout we leave anyway and say so, because a
  // bot that will not hang up is worse than one that clips its goodbye.
  async waitForSpeechDrain(maxMs = 12000, pollMs = 100) {
    const started = Date.now();
    const busy = () => this.speakingAloud || (this.pendingBotSpeech || []).length > 0;
    if (!busy()) return { waited: 0, drained: true };
    while (busy() && Date.now() - started < maxMs) {
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const waited = Date.now() - started;
    const drained = !busy();
    console.log(ts(), '[leave] waited', waited + 'ms for speech to finish —',
      drained ? 'drained' : 'TIMED OUT, leaving with speech still queued');
    return { waited, drained };
  }

  // Absolute paths to the sample art the onboarding call shows off:
  // one smiling face per emoji set, and every background preset.
  //
  // Only sets that are actually IMAGES are listed. 'native' is the OS font, so
  // it has no file to show — the caller says so in words rather than shipping a
  // broken image for it.
  visualAssets() {
    const path = require('path');
    const fs = require('fs');
    const ea = require('./emoji-assets.js');
    const emojiSets = [];
    for (const set of Object.keys(ea.EMOJI_SETS || {})) {
      const rel = ea.relPathFor(set, '🙂');
      if (!rel) continue;
      const full = path.join(ea.baseDir(__dirname), rel);
      if (fs.existsSync(full)) emojiSets.push({ set, emoji: '🙂', path: full });
    }
    const bgDir = __dirname.includes('.asar')
      ? path.join(process.resourcesPath, 'backgrounds', 'presets')
      : path.join(__dirname, 'backgrounds', 'presets');
    let backgrounds = [];
    try {
      backgrounds = fs.readdirSync(bgDir)
        .filter((f) => f.toLowerCase().endsWith('.svg'))
        .sort()
        .map((f) => ({ name: f.replace(/\.svg$/i, ''), path: path.join(bgDir, f) }));
    } catch { /* none bundled */ }
    return { emojiSets, backgrounds };
  }

  afterCallWorkPlan() {
    const seconds = Number(this._pref('afterCallWorkSeconds')) || 0;
    // No agent driving means nobody to hand off TO. Matches the app-side gate in
    // beginAfterCallWorkOrTeardown so the two can't disagree about what happens.
    const hasAgent = !agentIsAbsent(this.agentState());
    const enabled = seconds > 0 && hasAgent;
    const plan = { enabled, seconds: enabled ? seconds : 0 };
    // Ship the workdir CLAUDE.md's "## After the call" section with the plan.
    // Only app-spawned agents cd into the workdir and load that file; a
    // terminal-driven session never sees it, and without this it ends the
    // session immediately ("nothing to do") — the Seth-call failure where the
    // summary and log copy were silently skipped. Inlining the duties makes
    // leave_call self-contained for every transport.
    if (enabled) {
      try {
        const workdir = this.getAgentWorkdir();
        if (workdir) {
          plan.workdir = workdir;
          const claudeMd = fs.readFileSync(path.join(workdir, 'CLAUDE.md'), 'utf-8');
          const duties = require('./agent-workdir.js').afterCallSection(claudeMd);
          if (duties) plan.duties = duties;
        }
      } catch { /* no workdir / no CLAUDE.md — the note falls back to pointing at it */ }

      // Hand back a write-up that a re-join cut short, so this pass finishes
      // both. Calling the bot back mid-wrap-up ends that agent (the live call
      // beats the last call's bookkeeping), which used to lose the summary
      // outright. It does not have to: the replacement RESUMES the same
      // session, so the interrupted work is still in its own history — it only
      // needs telling that it stopped early.
      //
      // Delivered here rather than in the join prompt because this is the
      // moment the agent is already doing after-call work, and because it
      // reaches every transport (panel, calendar auto-join, CLI) rather than
      // just the ones that build a prompt.
      try {
        const unfinished = this.getUnfinishedWrapUp && this.getUnfinishedWrapUp();
        if (unfinished && unfinished.call) {
          plan.unfinished = unfinished;
          // Told once. Left set it would nag every call forever, and the detail
          // it refers to lives in the agent's session history, not here.
          if (this.clearUnfinishedWrapUp) this.clearUnfinishedWrapUp();
        }
      } catch { /* no handover available */ }
    }
    return plan;
  }

  // Is anyone driving this bot? See agent-liveness.js for why wait_for_speech's
  // 55s cap is what makes this trustworthy.
  agentState() {
    // A dropped socket is proof, not inference, so it short-circuits the
    // elapsed-time thresholds entirely.
    if (this.agentSocketLost && this.waiters.length === 0) return 'away';
    return classifyAgent({
      activeWaiters: this.waiters.length,
      lastAgentActivityAt: this.lastAgentActivityAt,
    });
  }

  // The face-worthy half of it: away or never-attached, and only while we are
  // actually in a call — out of a call there is nothing for an agent to drive,
  // so "no agent" is the normal resting condition rather than a fault.
  agentAbsentInCall() {
    return this.callStatus === 'in-call' && agentIsAbsent(this.agentState());
  }

  // WHY we think nobody is driving, because the two are not equally certain and
  // should not claim to be:
  //   'dropped' — the socket died. The process is gone; this is a fact.
  //   'quiet'   — nothing has called in for a while. It could equally be an
  //               agent blocked on a permission prompt in its terminal, or one
  //               deep in work that makes no MCP calls. Saying "it exited" here
  //               would be a guess presented as a diagnosis.
  //   'never'   — nothing ever attached.
  agentAbsenceReason() {
    if (this.agentSocketLost && this.waiters.length === 0) return 'dropped';
    return this.agentState() === 'never' ? 'never' : 'quiet';
  }

  // #467: when our OWN outgoing audio was last loud. Published per sample by
  // page-inject's VirtualMic analyser — the same envelope the echo guard keys
  // on — so this is the app's view of exactly when the far-end signal was being
  // suppressed. Used by _floorQuietPerAnalyser to tell "the room went quiet"
  // from "we stopped being able to hear it".
  setSelfAudioLoud(loud, at) {
    if (loud) this._selfAudioLastLoudAt = Math.max(this._selfAudioLastLoudAt || 0, at || Date.now());
  }

  // #115: record the fast floor edge and, when the DOM path later agrees, log
  // how far behind it was. That delta is the whole question the issue asks.
  setAudioFloor(speaking, at) {
    if (speaking === this.audioFloorSpeaking) return;
    this.audioFloorSpeaking = speaking;
    const now = at || Date.now();
    if (speaking) {
      this._audioFloorAt = now;
      console.log(ts(), '🎤 [floor-audio] speech ON  (analyser)');
    } else {
      this._audioFloorAt = 0;
      this._audioFloorOffAt = now; // #392: barge-in liveness re-check reads this
      console.log(ts(), '🎤 [floor-audio] speech OFF (analyser)');
    }
    // Wake anyone gated on the floor so a faster ON is actually actionable.
    // No `=== true` here any more: _pref now guarantees the schema's type, and
    // the strict comparison was the trap — it silently reads a stored string as
    // "off" whatever the string says (#417).
    if (this._pref('fastFloorDetection')) this._onFloorChanged();
  }

  // #138: the analyser edge, made actionable. Until this existed, _armBargeIn
  // was only reachable from Meet's DOM rising edge in setParticipants — and
  // while bot TTS is playing that edge often never arrives at all (the log for
  // #138: 221 analyser ONs, 5 arms, 1 back-off). So a human who started talking
  // over the bot was invisible to the back-off logic, which is the entire
  // mechanism by which a human is allowed to take the floor.
  //
  // Rising edge only. The analyser samples every animation frame and dips
  // between words; clearing the monitor on an OFF edge would restart the grace
  // period on every syllable gap and the bot would never yield. A floor that
  // genuinely reopened is handled where it already was: the DOM falling edge in
  // setParticipants, and _evaluateBargeIn's own floorBusy re-check when the
  // grace timer fires.
  _onFloorChanged() {
    // A no-op unless the bot is mid-utterance with nothing already armed.
    if (this.floorBusy) this._armBargeIn();
  }

  // #395: when the silence gate should consider silence to have BEGUN — which
  // is simply when the speaker actually stopped. No padding, anywhere.
  //
  // The tracker used to hold `speaking` true for a hard-coded extra second so a
  // flicker mid-utterance couldn't read as "they finished". Two things are
  // wrong with that. It lied to every consumer, not just this gate (#392: it
  // made the earliest possible release ~2.1s, longer than the barge-in grace,
  // so a one-word interjection cut the bot off every time). And — Stan's
  // point, and it's the better one — this gate ALREADY solves the flicker, with
  // `silenceSeconds`: a drop shorter than that threshold just re-arms the timer
  // and resolves nothing. The pad was a second, unnamed silence threshold
  // stacked on the real one, so a configured 1.4s gate was really 2.4s. (The
  // "~1.4s extra wait observed every turn" noted below was this.)
  //
  // One knob, honestly named. If the bot jumps in too fast, raise
  // `silenceSeconds` — do not reintroduce a hidden pad.
  //
  // Returns 0 when nobody has stopped yet.
  effectiveSilenceStart() {
    return this.lastSpeechStoppedAt || 0;
  }

  // The floor as the turn-taking gates should see it. With fastFloorDetection
  // on, EITHER signal counts as busy — the analyser gets there first, the DOM
  // path keeps it honest if the analyser misses (threshold too high, no remote
  // track yet). Off, this is exactly today's behaviour.
  get floorBusy() {
    if (this._pref('fastFloorDetection')) {
      return this.anyoneSpeaking || this.audioFloorSpeaking;
    }
    return this.anyoneSpeaking;
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
    // #343: count concurrent non-self speakers, not just "any". anyoneSpeaking
    // stays the load-bearing boolean everywhere else; activeSpeakerCount is the
    // new interruptibility signal, and we track the peak reached while the bot
    // waits (reset when it resolves a turn).
    const speakingNow = this.participants.filter(p => p.speaking && !p.isSelf && p.name !== 'You');
    this.activeSpeakerCount = speakingNow.length;
    this.anyoneSpeaking = this.activeSpeakerCount > 0;
    // #115: on the DOM path's rising edge, report how long after the analyser it
    // arrived. This is the measurement the issue asks for, and it costs one line.
    if (this.anyoneSpeaking && !wasSpeaking) {
      this._domFloorAt = Date.now();
      if (this._audioFloorAt) {
        console.log(ts(), `📏 [floor-latency] DOM detected speech ${this._domFloorAt - this._audioFloorAt}ms after the analyser did`);
      }
    }
    if (this.activeSpeakerCount > this._peakSpeakersSinceQuiet) {
      this._peakSpeakersSinceQuiet = this.activeSpeakerCount;
    }

    if (wasSpeaking && !this.anyoneSpeaking) {
      // Speech just stopped — record when and check waiters
      this.lastSpeechStoppedAt = Date.now();
      const speakers = this.participants.filter(p => !p.isSelf && p.name !== 'You').map(p => p.name).join(', ') || '(unknown)';
      console.log(ts(), '🛑 [silence] User(s) stopped speaking:', speakers, '(peak ' + this._peakSpeakersSinceQuiet + ' concurrent)');
      // Keep the raised hand up while a stash is still waiting for its opening.
      // Dropping to listening/idle the instant the interrupter stops made the
      // bot look like it had abandoned the thought — while in fact it was
      // holding one. The stash-opening timer below is what lowers the hand.
      if (this.botState === 'yielding' && !this.bargeInStash) {
        this._setBotState(this.waiters.length > 0 ? 'listening' : 'idle', undefined, { force: true });
      }
      this._checkWaiters();
      this.onAnyoneSpeakingChange(false);
      // The interrupter went silent before our grace timer fired — drop
      // the back-off monitor (#154). #138: only if the analyser agrees the room
      // is actually quiet; Meet's tracker drops a speaker mid-utterance often
      // enough that trusting it alone here disarmed live interruptions.
      if (!this.floorBusy) this._clearBargeInAfterHangover('interrupter went silent');
      // A held reply outranks a probe: if the bot already composed a real
      // thought, the first opening belongs to that, not to a filler phrase.
      // Wait the FULL turn-silence gate before replaying — the same bar a
      // human turn has to clear — rather than the probe's shorter soft gap.
      // Crucially this timer does not care whether an agent is parked in
      // wait_for_speech: the floor opening is a property of the room, not of
      // the agent's poll cycle (see _maybeReplayStashOnOpening).
      if (this.bargeInStash) {
        clearTimeout(this._stashOpeningTimer);
        // #359: the ack that used to mask this gap is gone when a stash is
        // held (see onBotStateChange in main.js) — it can't ask the slow
        // model "should I speak?" without another round trip, which is the
        // whole reason the ack existed. A name-mention stands in for that,
        // same rule as the waiter fast-resolve in _checkWaiters: this is not
        // a distinct "call-on" concept, it's the same nameMentionSilenceSeconds
        // shortening applied uniformly, whether or not a stash happens to be
        // held.
        const ms = this._stashLatestUtteranceMentionsBotName()
          ? Math.round((Number(this._pref('nameMentionSilenceSeconds')) || 1.0) * 1000)
          : Math.round((Number(this._pref('defaultSilenceSeconds')) || 1.4) * 1000);
        this._stashOpeningTimer = setTimeout(() => this._maybeReplayStashOnOpening(), ms);
      } else if (this._pref('probeFiring')) {
        // Active listening (#245): arm a SOFT-opening probe on a brief quiet —
        // shorter than the full turn-silence gate. If the room is still quiet
        // after probeSilenceMs, _maybeProbeOpening runs the completeness gate.
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
          waiter.silenceTimerAt = null;
        }
      }
      // Speaker resumed — cancel any pending soft-opening probe (no opening).
      clearTimeout(this._probeTimer);
      this._probeTimer = null;
      // Same for a pending stash replay: the floor closed again. The stash
      // itself survives (it re-arms on the next stop) until it ages out or
      // the conversation moves past it.
      clearTimeout(this._stashOpeningTimer);
      this._stashOpeningTimer = null;
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

  // #417: the call ended out from under us (Meet collapsed the in-call UI —
  // everyone left / the tab fell out of the call). The renderer detects the
  // sustained absence of in-call controls and signals this. Exit cleanly like
  // the auto-leave path — resolve waiters with a terminal autoLeft so the
  // agent's wait_for_speech loop stops (instead of ghost-polling captions for
  // minutes) — but do NOT speak a sign-off: there's no one left to hear it.
  handleCallEnded(reason = 'call ended') {
    if (this._autoLeaveTriggered || this.callStatus !== 'in-call') return;
    this._autoLeaveTriggered = true;
    console.log(ts(), '👋 [call-ended] firing —', reason, '— resolving waiters + leaving');
    for (const w of [...this.waiters]) {
      if (w.resolved) continue;
      w.resolved = true;
      clearTimeout(w.timer);
      clearTimeout(w.silenceTimer);
      clearTimeout(w.tickTimer);
      w.resolve({ success: true, autoLeft: true, afterCallWork: this.afterCallWorkPlan(), asOf: new Date().toISOString(), transcript: { entries: [] } });
    }
    this.waiters = [];
    try { this.onLeaveCall(); } catch (err) { console.warn(ts(), '[call-ended] onLeaveCall failed:', err.message); }
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
      w.resolve({ success: true, autoLeft: true, afterCallWork: this.afterCallWorkPlan(), asOf: new Date().toISOString(), transcript: { entries: [] } });
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

  // Every screen share currently up, from the people pane. Replaces the list
  // wholesale so an ended share disappears.
  setScreenShares(shares) {
    this.screenShares = Array.isArray(shares) ? shares : [];
  }

  setSomeoneElsePresenting(presenting, presenterName) {
    this.someoneElsePresenting = !!presenting;
    this.presenterName = presenterName || null;
  }

  // #253: playback happens AFTER the speak POST has already answered, so the
  // failure cannot be returned inline without making speak block on synthesis.
  // Record it instead, two ways: as an agent-visible error (get_room_info shows
  // these), and as a one-shot flag the NEXT speak carries back — which is where
  // the agent is actually looking.
  //
  // The case from Bethany's Aug 4 log: a farewell "played" into an empty room
  // while the app logged "Meet view not available for audio playback" at info
  // level, so the agent believed it had spoken.
  notePlaybackFailure(reason) {
    this._playbackFailure = { reason: String(reason || 'unknown'), at: Date.now() };
    this.addError('Audio playback FAILED — that speech was not heard by anyone. Reason: '
      + this._playbackFailure.reason);
  }

  // Consumed once, and only while fresh: a failure from ten minutes and three
  // calls ago is noise, not news.
  takeRecentPlaybackFailure(maxAgeMs = 120000) {
    const f = this._playbackFailure;
    if (!f) return null;
    this._playbackFailure = null;
    return (Date.now() - f.at) <= maxAgeMs ? f : null;
  }

  // #360: a barge-in cut the utterance mid-playback. speak() had already
  // returned success (it answers at dispatch time), so this record is the
  // honest correction — surfaced on the next wait_for_speech or speak,
  // whichever the agent calls first. Fields:
  //   spoken       — the words that actually reached the room
  //   unspokenTail — unheard remainder of the chunk that was playing; this is
  //                  exactly what a #350 resume replays, so a completed resume
  //                  moves it into `spoken`
  //   unspokenRest — chunks that never reached the renderer at all (a resume
  //                  cannot recover these — the synth loop already bailed)
  //   cutSeconds   — how far into the audio the cut landed (null when the stop
  //                  hit between chunks)
  //   resumed      — a #350 resume of the tail is in flight
  noteSpeechTruncation({ spoken, unspokenTail, unspokenRest, cutSeconds }) {
    this._speechTruncation = {
      spoken: spoken || '',
      unspokenTail: unspokenTail || '',
      unspokenRest: unspokenRest || '',
      cutSeconds: cutSeconds ?? null,
      resumed: false,
      at: Date.now(),
    };
    console.log(ts(), '🔇 [tts-truncated] cut ' +
      (cutSeconds != null ? '~' + cutSeconds + 's in' : 'between chunks') +
      ' — unheard: ' + ((unspokenTail || '') + ' ' + (unspokenRest || '')).trim().slice(0, 80));
  }

  // #360: the audio queue drained. If a resumed utterance just played out, its
  // tail was heard after all — fold it back into `spoken`, and drop the record
  // entirely when nothing unheard remains (the room ultimately got everything).
  noteSpeechPlaybackDrained() {
    const t = this._speechTruncation;
    if (!t || !t.resumed) return;
    t.resumed = false;
    if (t.unspokenTail) {
      t.spoken = (t.spoken + ' ' + t.unspokenTail).trim();
      t.unspokenTail = '';
    }
    if (!t.unspokenRest) {
      console.log(ts(), '🔇 [tts-truncated] resume completed — utterance fully delivered, record cleared');
      this._speechTruncation = null;
    }
  }

  // #360: consumed once, while fresh — same discipline as
  // takeRecentPlaybackFailure. Not returned while a resume is in flight with
  // nothing else unheard: the tail is about to play, and reporting it as
  // unheard right before it plays would push the agent to repeat itself.
  takeSpeechTruncation(maxAgeMs = 120000) {
    const t = this._speechTruncation;
    if (!t) return null;
    if (t.resumed && !t.unspokenRest) return null;
    this._speechTruncation = null;
    return (Date.now() - t.at) <= maxAgeMs ? t : null;
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

  // Normalized content fingerprint, used for: (1) telling genuine growth
  // apart from Meet's cosmetic re-render noise (spacing/punctuation/case) on
  // a speaker's open turn in updateTurns(), and (2) the output-side replay
  // audits (_checkReplayRegression, _auditDelivery) below. NOT unique across
  // a call — two "Yeah." turns share a fingerprint — callers that need
  // per-instance identity don't use this alone.
  _turnFp(speaker, text) {
    return String(speaker) + '|' + String(text).toLowerCase().replace(/[^a-z0-9']+/g, '');
  }

  // #12 regression alarm — see the constructor for why this exists rather than
  // a reminder to check back in a few days. Runs after each updateTurns batch
  // and enforces one invariant: lastUpdated may only advance when the turn's
  // normalized text actually changed.
  //
  // Reports through addError() so it lands in get_room_info's "Recent Errors" —
  // the bot driving the call sees it live and can say so out loud, instead of
  // the recurrence hiding for another fortnight. Also logged, because that ring
  // buffer holds 10 entries and dies with the room; the log is what you grep to
  // confirm a clean streak.
  _checkReplayRegression() {
    let offenders = 0;
    for (const turn of this.turns.values()) {
      const fp = this._turnFp(turn.speaker, turn.text);
      // _alarmFp/_alarmLU are the (text, lastUpdated) pair as of the last check.
      // Same words + a later lastUpdated = the turn re-qualified for waiters'
      // `since` cursors while saying nothing new. That is the bug.
      if (turn._alarmFp === fp && turn.lastUpdated > turn._alarmLU) offenders++;
      turn._alarmFp = fp;
      turn._alarmLU = turn.lastUpdated;
    }
    if (!offenders) return;

    this.replayAlarmCount += offenders;
    console.warn(
      ts(), '🔁 [#12] caption replay: lastUpdated advanced on', offenders,
      'turn(s) with unchanged text (session total', this.replayAlarmCount + ')',
    );
    if (!this._replayAlarmFired) {
      this._replayAlarmFired = true;
      this.addError(
        `caption replay regression (#12): ${offenders} turn(s) re-surfaced to waiters ` +
        `without their text changing. This is the bug fixed in beta-66 recurring — ` +
        `please capture the session log before the call ends.`,
      );
    }
  }

  // #12: disclose — and audit — exactly what each wait_for_speech round hands
  // the agent. Two jobs in one pass:
  //
  //   1. TRANSPARENCY. One 📨 line per delivered entry, verbatim. Until now the
  //      only record of a round was the 📦 count, so "what did the bot actually
  //      hear?" was unanswerable after the fact and every #12 sighting had to be
  //      reconstructed from ingest-side breadcrumbs.
  //   2. REPLAY DETECTION AT THE BOUNDARY. Any entry whose normalized text was
  //      already delivered this call is marked ⚠️  REPEAT with the age of the
  //      first delivery. This is deliberately mechanism-blind: it does not care
  //      which ingest hole let the replay through, only that the agent is being
  //      told the same thing twice — which is the actual user-visible bug.
  //
  // Legitimate re-delivery is excluded by construction: a turn whose captions
  // are still growing ships a LONGER text each round, so it never fingerprints
  // to its earlier self. Only an exact-word repeat trips this.
  _auditDelivery(entries, reason) {
    if (!entries || !entries.length) return;
    const now = Date.now();
    let repeats = 0;
    for (const e of entries) {
      const text = String(e.text || '').trim();
      if (!text) continue;
      const fp = this._turnFp(e.participantName, text);
      const prior = this._deliveredFps.get(fp);
      // Short utterances genuinely recur ("Yeah.", "Right?") — flagging those
      // would bury the real signal in noise. The replayed history that matters
      // is always a full utterance.
      const auditable = text.length >= 40;
      let mark = '';
      if (prior && auditable) {
        repeats++;
        const agoS = Math.round((now - prior.at) / 1000);
        mark = ` ⚠️  REPEAT (first delivered ${Math.floor(agoS / 60)}m${agoS % 60}s ago)`;
      }
      if (!prior) this._deliveredFps.set(fp, { at: now });
      console.log(ts(), `📨 [delivered] ${e.participantName}: ${JSON.stringify(text)}${mark}`);
    }
    // FIFO bound — Maps iterate in insertion order.
    while (this._deliveredFps.size > this.maxDeliveredFps) {
      this._deliveredFps.delete(this._deliveredFps.keys().next().value);
    }
    if (!repeats) return;

    this.replayDeliveryCount += repeats;
    console.warn(
      ts(), '🔁 [#12] REPLAY DELIVERED:', repeats,
      'entr' + (repeats === 1 ? 'y' : 'ies'), 'the agent had already been given',
      '(reason=' + reason + ', session total ' + this.replayDeliveryCount + ')',
    );
    // Surface once into get_room_info's "Recent Errors" so the bot driving the
    // call can call it out live — the same escalation path as the lastUpdated
    // alarm, which the 08-11 call proved is not enough on its own: it never
    // fired, yet the whole room saw the replay.
    if (!this._replayDeliveryFired) {
      this._replayDeliveryFired = true;
      this.addError(
        `caption replay (#12): ${repeats} already-delivered utterance(s) were handed to the agent ` +
        `again as new speech. Treat repeated lines as artifacts, and capture this session log ` +
        `before the call ends — grep for "📨 [delivered]".`,
      );
    }
  }

  // Fire onNameMentioned at most once per caption turn, the first time its
  // text contains the bot's own name — a purely cosmetic "I heard that" avatar
  // signal, separate from the passive/silent name-gate in _checkWaiters (#343)
  // which decides whether to actually respond. Flagged on the turn object
  // rather than fired on every updateTurns() call: a turn keeps growing as the
  // speaker keeps talking, and re-triggering the animation on every caption
  // tick while the name stays in view would make it fire many times for one
  // mention instead of once at the moment it first appears.
  _maybeSignalNameMention(turn, text) {
    if (turn._nameMentionSignaled) return;
    const myName = (this.getEffectiveBotName() || '').toLowerCase();
    if (!myName) return;
    if (String(text || '').toLowerCase().includes(myName)) {
      turn._nameMentionSignaled = true;
      this.onNameMentioned();
    }
  }

  // Create a new internally-identified turn (see the constructor's #12 note
  // for why identity is never the scraper's turnId). `settled` is true for a
  // turn that's provably already closed on arrival (a later occurrence of
  // the same speaker exists in this same batch); false for the newest one.
  // Returns the internal Map key (NOT turn.id, which is the display string).
  _createTurn(speaker, text, now, settled) {
    const id = this._nextTurnId++;
    const turn = { id: `${this.roomId}-turn-${id}`, speaker, text, firstSeen: now, lastUpdated: now, settled, source: 'caption' };
    this.turns.set(id, turn);
    this._logRawCaption(id, speaker, text, !settled);
    if (!settled) this._maybeSignalNameMention(turn, text);
    else this._logHeard(speaker, text); // arrived already closed
    return id;
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
    let changed = false;

    // #12 diagnostic ONLY (see constructor note) — track how many scraper
    // turnIds in this batch we've never seen before, so we can tell a
    // container re-render apart from ordinary new speech below, purely for
    // observability. Does not influence ingest.
    let unknownTurnIds = 0;
    for (const t of incoming) {
      if (!t || typeof t.turnId !== 'number') continue;
      if (!this._seenScraperTurnIds.has(t.turnId)) {
        unknownTurnIds++;
        this._seenScraperTurnIds.add(t.turnId);
      }
    }
    while (this._seenScraperTurnIds.size > this.maxSeenScraperTurnIds) {
      this._seenScraperTurnIds.delete(this._seenScraperTurnIds.values().next().value);
    }
    let createdThisBatch = 0;

    // #12: group by speaker, preserving DOM/chronological order within each
    // speaker's own occurrences. The scraper sends a full snapshot of every
    // VISIBLE caption child every time anything changes, so `texts.length` for
    // a speaker is how many of their turns are on screen right now. We
    // deliberately ignore turnId/isBottommost entirely: they're per-DOM-child
    // bookkeeping that a re-render invalidates, and a participant's own turn
    // ordering is what a re-render can't touch.
    //
    // #389: that count is NOT monotonic, which #12's fix assumed. Meet prunes
    // old rows on a long call and a rejoin empties the pane, so it can drop at
    // any time — see the re-anchoring below, which is what makes this safe.
    const bySpeaker = new Map(); // speaker -> ordered text[]
    for (const t of incoming) {
      if (!t || !t.speaker || typeof t.text !== 'string') continue;
      if (!t.text.trim()) continue;
      const list = bySpeaker.get(t.speaker);
      if (list) list.push(t.text); else bySpeaker.set(t.speaker, [t.text]);
    }

    for (const [speaker, texts] of bySpeaker) {
      let knownCount = this._speakerTurnCount.get(speaker) || 0;
      const n = texts.length;

      // #389: a count going backwards is NOT the anomaly the original guard
      // assumed. Meet prunes old caption rows on a long call, and a rejoin
      // resets the pane to ~0 while _speakerTurnCount (server-side) survives.
      // Both are routine, and both used to `continue` here — skipping before
      // updating any state, so the high-water mark could never come down and
      // the speaker was silently, permanently unheard for the rest of the
      // call. Instead of skipping, RE-ANCHOR: find where our held turn sits in
      // the pruned snapshot and rebase the count onto it.
      if (n < knownCount) {
        const open = this.turns.get(this._openTurnBySpeaker.get(speaker));
        let rebased = -1;
        if (open) {
          // Search from the end: the open turn is the most recent one, so the
          // last match is the right anchor when text repeats. Accept the same
          // relations the update path below treats as "still the same turn" —
          // identical, grown, or a truncated replay — because Meet can prune
          // rows AND extend/re-render the open turn in the very same
          // snapshot; requiring an exact fingerprint there would drop the
          // anchor spuriously and take the lossy branch below for nothing.
          const openFp = this._turnFp(speaker, open.text);
          const bareFp = this._turnFp(speaker, ''); // guard: never prefix-match on an empty normalized text
          for (let i = n - 1; i >= 0; i--) {
            const fp = this._turnFp(speaker, texts[i]);
            const shorter = fp.length < openFp.length ? fp : openFp;
            if (fp === openFp ||
                (shorter !== bareFp && (fp.startsWith(openFp) || openFp.startsWith(fp)))) {
              rebased = i + 1;
              break;
            }
          }
        }
        if (rebased >= 0) {
          // Our open turn is still visible at position rebased-1. Everything
          // before it was pruned (already ingested, nothing lost); everything
          // after it is genuinely new and falls out of the normal path below.
          console.log(ts(), 'ℹ️  [caption] re-anchored', speaker,
            '(' + knownCount + ' -> ' + n + '): rows pruned, held turn found at',
            rebased - 1);
        } else {
          // No anchor at all — a rejoin wiped the pane, or pruning ran past
          // our open turn. Pruning drops oldest-first, so if the speaker's
          // newest held row is gone, everything visible for them now
          // postdates the gap: ingest ALL of it as new speech (rebased = 0).
          // Detach the stale open-turn pointer first — the previously-open
          // block below would otherwise rebind it and overwrite the pre-gap
          // turn's text (and timestamp) with the first post-gap row,
          // corrupting the transcript. We forfeit anything said while the
          // pane was empty, but hearing resumes with this very batch instead
          // of deadlocking forever.
          rebased = 0;
          if (open && !open.settled) {
            open.settled = true; // the pre-gap turn is definitively over
            changed = true;
            this._logHeard(open.speaker, open.text);
          }
          this._openTurnBySpeaker.delete(speaker);
          console.warn(ts(), '⚠️  [caption] lost anchor for', speaker,
            '(' + knownCount + ' -> ' + n + ') — ingesting the visible rows as new speech;',
            'anything they said in the gap is unrecoverable');
          this.addError(
            `Caption anchor lost for ${speaker} (#389): the caption pane shrank past ` +
            `the last turn we held, so anything they said in the gap was missed. ` +
            `Hearing resumes with the captions on screen now.`,
          );
        }
        this._speakerTurnCount.set(speaker, rebased);
        knownCount = rebased;
      }

      // Position knownCount-1 is the previously-open turn: the only one of
      // this speaker's turns that can still change. Compare and, if a newer
      // turn has since appeared for them (n > knownCount), it's now closed.
      if (knownCount > 0) {
        const open = this.turns.get(this._openTurnBySpeaker.get(speaker));
        if (open) {
          const text = texts[knownCount - 1];
          if (text !== open.text) {
            const prevNorm = this._turnFp(speaker, open.text);
            const nextNorm = this._turnFp(speaker, text);
            if (nextNorm === prevNorm) {
              open.text = text; // cosmetic-only revision — take Meet's tidier copy
            } else if (prevNorm.startsWith(nextNorm)) {
              // Truncated replay of the same turn — keep the fuller text we hold.
            } else {
              open.text = text;
              open.lastUpdated = now;
              open.settled = false; // may have been idle-settled below; it's still live
              changed = true;
              this._maybeSignalNameMention(open, text);
            }
            this._logRawCaption(open.id, speaker, open.text, !open.settled);
          }
          if (n > knownCount && !open.settled) {
            open.settled = true;
            changed = true;
            this._logHeard(open.speaker, open.text);
          }
        }
      }

      // Any position beyond knownCount is a brand-new turn for this speaker.
      // Every one of them except the newest is provably closed already (a
      // later occurrence for the same speaker exists right here in this
      // batch), so only the newest opens as live/mutable.
      for (let i = knownCount; i < n; i++) {
        const isNewest = i === n - 1;
        const id = this._createTurn(speaker, texts[i], now, !isNewest);
        changed = true;
        createdThisBatch++;
        if (isNewest) this._openTurnBySpeaker.set(speaker, id);
      }
      this._speakerTurnCount.set(speaker, n);
    }

    // #12 diagnostic ONLY: a burst of never-before-seen turnIds that did NOT
    // produce a matching burst of genuinely new turns means the same content
    // just arrived under fresh ids — i.e. Meet re-rendered the caption
    // container. Confirms (during live testing) that the scenario actually
    // happened; the fix above never needed to know either way.
    if (unknownTurnIds >= 3 && createdThisBatch < unknownTurnIds) {
      console.log(ts(), '🔁 [#12-diag] container re-render observed:', unknownTurnIds,
        'previously-unseen scraper turnId(s) arrived, only', createdThisBatch,
        'were genuinely new turns — harmless under the per-speaker design (identity never depended on turnId)');
    }

    // #12: a turn nobody has added to in a while is very likely closed — Meet
    // just hasn't started a new line for that speaker (or never will, if it
    // was their last utterance in the call). We don't know Meet's exact rule
    // for when it stops extending a line vs. starting a new one, so age it
    // out defensively (Stan, 2026-08-14) rather than leave it "live" forever.
    // This only affects the settled/isFinal flag — it does not affect what
    // gets delivered, since delivery is keyed on lastUpdated, not settled.
    const stableMs = Number(this._pref('openTurnStableMs')) || 5000;
    for (const id of this._openTurnBySpeaker.values()) {
      const turn = this.turns.get(id);
      if (turn && !turn.settled && now - turn.lastUpdated >= stableMs) {
        turn.settled = true;
        changed = true;
      }
    }

    this._checkReplayRegression();

    // Bound the map size — keep the most recently-active turns, but never
    // evict a speaker's currently-open turn: pruning it would sever the
    // pointer that growth-matching depends on and reintroduce exactly the
    // "we've lost identity" failure this whole design avoids.
    if (this.turns.size > this.maxTurns) {
      const openIds = new Set(this._openTurnBySpeaker.values());
      const evictable = [...this.turns.entries()]
        .filter(([id]) => !openIds.has(id))
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
      let toDrop = this.turns.size - this.maxTurns;
      for (const [id] of evictable) {
        if (toDrop-- <= 0) break;
        this.turns.delete(id);
      }
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

      // #343: is the bot directly addressed in these entries? Drives BOTH the
      // passive/silent name-gate AND — in any mode — a shorter silence threshold
      // (fast-resolve). A direct "Jimmy…" should get a prompt reply instead of
      // waiting for a whole-room gap that rarely comes in a lively multi-party
      // call (the bot otherwise falls back to the word-count tick, 20–30s late).
      const botNameLower = waiter.bot ? waiter.bot.toLowerCase() : '';
      const nameMentioned = !!botNameLower && entries.some(e => e.text.toLowerCase().includes(botNameLower));

      // Passive/silent modes only respond when directly addressed; otherwise they
      // fall through to the same silence-based resolution active mode uses (the
      // bot still waits for the speaker to finish — see #208 for why the old
      // instant-resolve path was removed).
      if ((this.mode === 'passive' || this.mode === 'silent') && waiter.bot) {
        if (!nameMentioned) {
          if (waiter.silenceTimer) {
            clearTimeout(waiter.silenceTimer);
            waiter.silenceTimer = null;
          }
          continue;
        }
      }

      // Effective silence threshold — shortened when the bot was just addressed
      // by name, so a direct question resolves promptly rather than waiting for
      // the full whole-room gap (#343). Live-tunable via nameMentionSilenceSeconds.
      // #359: position in the utterance used to matter (only "at the end" fast-
      // resolved, to avoid cutting off "hey Jimmy, how's it going") — dropped.
      // Position is an unreliable signal (more so across languages), and this
      // still only SHORTENS an already silence-gated wait, it never skips the
      // wait outright, so there is no speaker to cut off either way.
      const _nameSil = Number(this._pref('nameMentionSilenceSeconds'));
      const effSilence = (nameMentioned && Number.isFinite(_nameSil) && _nameSil >= 0)
        ? Math.min(waiter.silence, _nameSil)
        : waiter.silence;

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
      const captionsGoneQuiet = lastEntryAge >= (effSilence + 3) * 1000;

      if (this.anyoneSpeaking && !captionsGoneQuiet) {
        // Speaker tracker says speaking — schedule a re-check at the point when
        // the caption-quiet fallback would kick in, so we don't depend solely on
        // the tracker flipping false (which sometimes never happens).
        if (!waiter.silenceTimer && lastEntry) {
          const timeUntilQuiet = (effSilence + 3) * 1000 - lastEntryAge;
          if (timeUntilQuiet > 0) {
            // Track the deadline so the threshold branch below can RE-ARM
            // over this long fallback horizon once the speaker actually
            // stops (#372 — see the re-arm comment there).
            waiter.silenceTimerAt = Date.now() + timeUntilQuiet + 50;
            waiter.silenceTimer = setTimeout(() => {
              waiter.silenceTimer = null;
              waiter.silenceTimerAt = null;
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
      // #395: the speaker tracker now reports the TRUE stop edge — it no
      // longer holds `speaking` true for an extra second after the signal goes
      // quiet. The pad was DELETED, not moved here: a mid-sentence breath that
      // flips the tracker false just restarts this gate's own clock (a fresher
      // lastSpeechStoppedAt), so `silenceSeconds` already does the pad's job
      // and the pad was a second, unnamed threshold stacked on it. Net effect
      // on this gate: turns resolve ~1s sooner than before #395 — that second
      // was the hidden pad, not configured silence. If the bot jumps in too
      // fast, raise `silenceSeconds`; do not reintroduce a pad.
      const silenceMs = effSilence * 1000;
      const lastEntryTime = lastEntryActivityTime;
      const stopTime = this.effectiveSilenceStart();
      const STOP_FRESH_MS = silenceMs * 3; // ~6s with default 2s silence
      const stopIsFresh = stopTime && (Date.now() - stopTime) < STOP_FRESH_MS;
      const silenceStart = stopIsFresh
        ? stopTime
        : (Math.max(stopTime, lastEntryTime) || Date.now());
      const elapsed = Date.now() - silenceStart;

      if (elapsed >= silenceMs) {
        // Silence threshold already met — resolve immediately
        console.log(ts(), '⏱️  [resolve] Silence threshold met (' + Math.round(elapsed) + 'ms ≥ ' + silenceMs + 'ms' + (effSilence < waiter.silence ? ', name-mention fast-resolve' : '') + ') — resolving');
        this._announceSilenceGate(null);   // no window to show — it resolved on arrival
        this._resolveWaiter(waiter, 'silence');
      } else {
        // Arm (or RE-ARM) the silence timer for the true remaining time.
        //
        // #372: this used to be `else if (!waiter.silenceTimer)`, which let a
        // STALE timer block the correct one: while the speaker was still
        // talking, the anyoneSpeaking branch above arms a timer for the
        // caption-quiet fallback horizon (threshold + 3s). When the speaker
        // then stopped, this branch computed the right (shorter) remaining,
        // but the no-re-arm guard skipped it — so the gate only fired when
        // the stale fallback timer woke. Measured cost over 80 logged cycles:
        // +708ms avg / +1704ms p90 / +2501ms max of dead air per reply.
        // Re-arm whenever the correct deadline is meaningfully EARLIER than
        // the scheduled one (25ms slop avoids churn from back-to-back
        // caption events); never re-arm later — that would extend the wait.
        const remaining = silenceMs - elapsed + 50;
        const fireAt = Date.now() + remaining;
        if (!waiter.silenceTimer || fireAt < (waiter.silenceTimerAt || Infinity) - 25) {
          if (waiter.silenceTimer) clearTimeout(waiter.silenceTimer);
          waiter.silenceTimerAt = fireAt;
          this._announceSilenceGate(fireAt, silenceStart);
          waiter.silenceTimer = setTimeout(() => {
            waiter.silenceTimer = null;
            waiter.silenceTimerAt = null;
            this._announceSilenceGate(null);
            // Re-check: someone may have started speaking during the wait
            this._checkWaiters();
          }, remaining);
        }
      }
    }
  }

  // Tell the avatar when the silence gate will fire, so it can animate a
  // countdown that lands on the moment rather than guessing a duration.
  //
  // Deduped on the deadline: _checkWaiters runs on every caption event, so a
  // talkative moment would otherwise push dozens of identical announcements a
  // second. A 25ms slop matches the re-arm guard above — below that the deadline
  // has not meaningfully moved and re-targeting the animation would only make it
  // stutter.
  _announceSilenceGate(deadline, from) {
    const prev = this._silenceGateAt;
    if (deadline == null) {
      if (prev == null) return;
      this._silenceGateAt = null;
      try { this.onSilenceGateChange(null); } catch { /* renderer gone */ }
      return;
    }
    if (prev != null && Math.abs(deadline - prev) < 25) return;
    this._silenceGateAt = deadline;
    try { this.onSilenceGateChange({ deadline, from: from || Date.now() }); } catch { /* renderer gone */ }
  }

  // #222: best-effort check whether `name` is already present in the call —
  // first against the live Meet roster (when we're already in the call),
  // then against the website's room presence (other bots register there
  // even when our app hasn't joined yet, which is how two unconfigured
  // sessions both take the default name and collide). Returns a human-readable source
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

  // Announce this bot in the room's presence, so the OTHER bots can discover it
  // (#430). Until now nothing wrote to presence at all: the room page skips
  // registration for whiteboard-only views, which is the only view a bot opens,
  // and the app only ever read the list. Two comments in _rankedSpeakDelay
  // disagreed about this and the pessimistic one was right — the list was empty,
  // which is why peers had to be typed in by hand.
  //
  // BOTH names go up, and that is the point. Presence is keyed by the CONFIGURED
  // name while Meet's roster shows the DISPLAY name for this call, and under
  // test those differ ("Alice" vs "Alice-r4a32"). Matching one against the other
  // is what made each bot count twice and produced "rank 4 of 5" in a room
  // holding three. The endpoint has always accepted and returned displayName; it
  // was simply never sent.
  //
  // role='bot' is sent even though, in practice, only bots register — a human
  // who opens the room page to look at the whiteboard would register too, and
  // then be ranked as a bot. That costs a wasted slot rather than correctness,
  // but the field is free and makes the set explicit rather than implied.
  //
  // Fire-and-forget, like the de-register below: presence is an optimisation for
  // ordering, and a bot must never fail to speak because a heartbeat did not land.
  _registerPresence() {
    // #471: not announcing makes this instance look like a person to every other
    // bot in the room — which is the only way to test whether they yield to one.
    // Checked here rather than at the timer, so the peer REFRESH still runs: an
    // unannounced instance should still be able to see who else is a bot, it
    // just does not claim to be one itself.
    if (!this._pref('announceAsBot')) {
      if (!this._loggedNoAnnounce) {
        this._loggedNoAnnounce = true;
        console.log(ts(), '🕵️  [presence] not announcing as a bot — this instance '
          + 'appears to others as an ordinary participant (announceAsBot=false)');
      }
      return;
    }
    const roomId = this.roomId;
    const name = this.getEffectiveBotName();
    const base = (this.getWebsiteUrl() || '').replace(/\/$/, '');
    if (!roomId || !name || !base) return;
    const self = (this.participants || []).find((p) => p && p.isSelf && p.name && p.name !== 'You');
    // #222's self-exemption keys off _everJoinedAs, but that was set ONLY by the
    // MCP join handler — while the name is published from HERE, by the presence
    // heartbeat, which starts on any route into setRoom (--meet-url at startup,
    // clicking a detected Meet, the #238 start-sync recovery). A process that
    // published its name through one of those, then asked to join over MCP, met
    // its own fresh entry and did not recognise it: observed 2026-08-24, the app
    // restarted, auto-joined, and refused itself twice 40s later.
    //
    // Recording it where the publish happens is what makes the exemption mean
    // "a name THIS process put in the room" however the join was started.
    this._everJoinedAs = name;
    fetch(`${base}/api/room/${roomId}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        // What the room actually sees. Absent until the people pane names our
        // own tile, so the first heartbeat may carry only the configured name.
        ...(self && self.name !== name ? { displayName: self.name } : {}),
        role: 'bot',
      }),
      signal: AbortSignal.timeout(3000),
    }).then((r) => {
      if (!this._presenceLoggedOk && r.ok) {
        this._presenceLoggedOk = true;
        console.log(ts(), `👋 [presence] registered "${name}"`
          + (self && self.name !== name ? ` (display "${self.name}")` : '') + ` in room ${roomId}`);
      }
    }).catch(() => { /* presence is optional; ordering falls back to jitter */ });
  }

  // The other bots in this room, as PRESENCE knows them, resolved to the names
  // Meet's roster uses — which is what the ordering ranks over.
  //
  // Cached rather than fetched per utterance: ordering runs on the speak path
  // and must stay synchronous. Refreshed on the same heartbeat that registers us.
  _refreshPresencePeers() {
    const roomId = this.roomId;
    const base = (this.getWebsiteUrl() || '').replace(/\/$/, '');
    if (!roomId || !base) return;
    fetch(`${base}/api/room/${roomId}/presence`, { signal: AbortSignal.timeout(3000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const self = (this.getEffectiveBotName() || '').toLowerCase();
        const roster = (this.participants || [])
          .filter((p) => p && p.name && !p.isSelf && p.name !== 'You' && !p.isPseudo)
          .map((p) => p.name);
        const bots = (data.members || []).filter((m) => m && m.name
          && (m.role === 'bot' || !m.role)   // only bots register; role makes it explicit
          && m.name.toLowerCase() !== self);
        const matched = roster.filter((r) => bots.some((m) => namesMatch(r, m.displayName)
          || namesMatch(r, m.name)));
        // A derived set that swallows the whole roster is worse than none: the
        // seed is the last utterance by someone OUTSIDE the bot set, so with
        // everyone inside it there is nothing to key on and ordering stops
        // entirely. Only ever ADD certainty here, never remove the humans.
        if (matched.length && matched.length < roster.length) {
          const changed = JSON.stringify(matched) !== JSON.stringify(this._presencePeers || []);
          this._presencePeers = matched;
          if (changed) console.log(ts(), `🤖 [presence] peers discovered: ${matched.join(', ')}`);
        } else if (matched.length && matched.length >= roster.length) {
          this._presencePeers = null;
          console.log(ts(), `🤖 [presence] ignoring peer set — it covers every participant `
            + `(${matched.length} of ${roster.length}), which would leave no human to key on`);
        }
      })
      .catch(() => { /* unreachable — keep whatever we had */ });
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
    // #422: the replay exemption belongs to ONE playback, so it dies the moment
    // the bot stops speaking. Leaving it set would silently disable barge-in for
    // the rest of the session — a test-only flag turning into a live bug.
    if (state !== 'speaking' && this._uninterruptiblePlayback) this._uninterruptiblePlayback = false;
    if (this.botState === state) return;
    // Keep the visible "I want to speak but I'm yielding" signal while the
    // interrupter is still talking. A follow-up wait_for_speech call should
    // not make the avatar look merely idle/listening again.
    if (!force && this.botState === 'yielding' && state === 'listening' && this.anyoneSpeaking) return;
    // A raised hand outranks a glance: a background tick must not lower 🙋 while
    // a composed reply is still queued for the next opening.
    if (!force && this.botState === 'yielding' && state === 'ticking') return;
    // #368: while the bot is actually emitting audio (speakingAloud), 'speaking'
    // means "speaking aloud" — hold it there against the agent loop's premature
    // transitions (thinking/working/listening/idle). The agent finishing a long
    // speak() and looping back to wait_for_speech must NOT flip botState off
    // 'speaking' while ~2 minutes of audio still play, or barge-in (which arms
    // only in 'speaking') can't fire. Only FORCED transitions (tts-ended queue
    // drain, back-off/stop-tts) leave 'speaking' mid-audio. Cleared below on exit.
    if (!force && this.botState === 'speaking' && this.speakingAloud && state !== 'speaking') return;
    // Fallback (no audio yet, e.g. the synth gap before playback): keep the
    // original protection against a new wait_for_speech downgrading speaking→listening.
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
    // #368: entering 'speaking' always corresponds to audio starting (real
    // speak, probe, or #350 resume all enter here only when they play). Mark the
    // bot as speaking aloud; the guard above then holds this state until a forced
    // exit (tts-ended / back-off).
    if (state === 'speaking') this.speakingAloud = true;
    // Leaving 'speaking' — TTS ended naturally or got cut off. Cancel any
    // armed barge-in timer so we don't fire stop-tts against a silent bot, and
    // clear the speaking-aloud latch (#368). Only forced transitions reach here.
    if (prev === 'speaking' && state !== 'speaking') {
      this.speakingAloud = false;
      this.lastSpokeAloudAt = Date.now(); // #368: for the deaf detector's "gap was my own monologue" check
      this._clearBargeIn('bot stopped speaking');
    }
    // Entering 'speaking' — if someone is already mid-utterance, arm
    // immediately. Otherwise arming happens lazily when the floor flips busy
    // (the DOM edge in setParticipants, or the analyser edge via
    // _onFloorChanged). #138: floorBusy so the analyser counts here too.
    if (state === 'speaking' && this.floorBusy) {
      this._armBargeIn();
    }
    this.onBotStateChange(state, extra);
  }

  // #339: new agent activity → reflect a "working" avatar state so the room can
  // tell "heads-down doing tool work" from "listening". A tool line (🔧) means
  // the bot is running tools → 🧑‍💻 working; other activity (reasoning/text) →
  // 🤔 thinking. Only escalates from resting states — never overrides speaking
  // or yielding. A quiet timer eases back to listening/idle once activity stops.
  _onAgentActivity(line) {
    if (this.callStatus !== 'in-call') return;
    if (!['idle', 'listening', 'ticking', 'thinking', 'working'].includes(this.botState)) return;
    if (this.botState === 'idle' || this.botState === 'listening' || this.botState === 'ticking') {
      // Start of an engagement — show 🤔 thinking and start the dwell clock.
      this._workingSince = Date.now();
      this._setBotState('thinking');
    } else if (/🔧/.test(line)) {
      // Already engaged. Escalate 🤔 → 🧑‍💻 only once work has been sustained for
      // workingStateMinMs, so a quick single-tool turn (the speak call is itself a
      // tool!) doesn't flash 🧑‍💻. Once working, stay working.
      const minMs = Number(this._pref('workingStateMinMs')) || 0;
      if (!this._workingSince) this._workingSince = Date.now();
      if (Date.now() - this._workingSince >= minMs) this._setBotState('working');
      else this._armWorkingEscalationTimer(minMs - (Date.now() - this._workingSince));
    }
    this._armWorkingQuietTimer();
  }

  // The dwell has to expire on a TIMER, not only when the next tool line lands.
  //
  // Checking it inline was enough for a burst of quick calls — each new line
  // re-checks the clock, so the face escalates on whichever one crosses the
  // threshold. But a SINGLE long tool call produces one line and then silence:
  // nothing re-checks, and the avatar sits on 🤔 for the whole thing. That is
  // exactly backwards. A five-minute build is when the bot is least able to
  // reply and the room most needs to see it is heads-down — and it was the one
  // case that never showed 🧑‍💻 (reported 2026-08-24, "a minor annoyance for a
  // long time").
  _armWorkingEscalationTimer(afterMs) {
    clearTimeout(this._workingEscalationTimer);
    this._workingEscalationTimer = setTimeout(() => {
      this._workingEscalationTimer = null;
      // Re-check everything: the turn may have ended, the bot may be speaking or
      // yielding, or the call may be over. Only a still-thinking bot escalates.
      if (this.callStatus !== 'in-call') return;
      if (this.botState !== 'thinking') return;
      this._setBotState('working');
      // Keep the quiet timer honest — without this a long silent tool call could
      // reach 🧑‍💻 and then be dropped by a quiet timer armed before it.
      this._armWorkingQuietTimer();
    }, Math.max(0, afterMs));
  }

  // 😑 is a blink, not a state the bot lives in. The agent reads the tick and
  // loops back to wait_for_speech without speaking, and that re-arm normally
  // clears the face. This is the backstop for an agent that takes its time (or
  // wanders off into tool work): the glance expires on its own.
  _armTickFaceTimer() {
    clearTimeout(this._tickFaceTimer);
    this._tickFaceTimer = setTimeout(() => {
      this._tickFaceTimer = null;
      if (this.botState !== 'ticking') return; // something realer took over
      this._setBotState(this.waiters.length > 0 ? 'listening' : 'idle', undefined, { force: true });
    }, TICK_FACE_MS);
  }

  _armWorkingQuietTimer() {
    const QUIET_MS = Number(this._pref('workingStateQuietMs')) || 8000; // activity gone this long → drop the face
    if (this._workingQuietTimer) clearTimeout(this._workingQuietTimer);
    this._workingQuietTimer = setTimeout(() => {
      this._workingQuietTimer = null;
      // The engagement is over: a pending escalation would otherwise fire 🧑‍💻
      // onto a bot that has already gone quiet.
      clearTimeout(this._workingEscalationTimer);
      this._workingEscalationTimer = null;
      if (this.botState !== 'working' && this.botState !== 'thinking') return;
      // Still mid-turn (resolved, not yet spoken)? Hold the face and re-check —
      // a single long tool call can be quiet a while. Once the turn ends (speak
      // clears _pendingTurnSince) or the agent re-arms listening, we fall through.
      if (this._pendingTurnSince != null) { this._armWorkingQuietTimer(); return; }
      this._setBotState(this.waiters.length > 0 ? 'listening' : 'idle', undefined, { force: true });
    }, QUIET_MS);
  }

  // Barge-in / back-off helpers (#154) -----------------------------------------

  _clearBargeIn(reason) {
    clearTimeout(this._bargeInClearTimer);
    this._bargeInClearTimer = null;
    if (this._bargeInTimer) {
      clearTimeout(this._bargeInTimer);
      this._bargeInTimer = null;
      console.log(ts(), '🛡️  [barge-in] cleared:', reason);
    }
  }

  // The disarm path, with a hangover. Meet's speaking meter drops back to rest
  // BETWEEN SYLLABLES — 300-900ms gaps, measured mid-sentence on the
  // eqj-edyv-fdw call — and each dip arrives here as "the interrupter went
  // silent". Clearing on the first one meant a person speaking steadily could
  // arm-and-clear the monitor four times over while the bot talked straight
  // through them; it only ever yielded when a dip happened not to land inside
  // the grace window. So wait bargeInClearHangoverMs and re-check: if the floor
  // is busy again by then, the "silence" was an inter-word dip and the monitor
  // stays armed.
  //
  // Deliberately asymmetric — this delays only DISARMING. The floor-opening
  // path still uses the raw falling edge, because the two directions have
  // different costs: a false negative here talks over a human, a false negative
  // there just adds latency before the bot speaks.
  _clearBargeInAfterHangover(reason) {
    if (!this._bargeInTimer) return;
    const ms = Number(this._pref('bargeInClearHangoverMs'));
    if (!(ms > 0)) return this._clearBargeIn(reason);
    clearTimeout(this._bargeInClearTimer);
    this._bargeInClearTimer = setTimeout(() => {
      this._bargeInClearTimer = null;
      if (this.floorBusy) {
        console.log(ts(), '🛡️  [barge-in] disarm held off — floor busy again after ' + ms + 'ms (inter-word dip)');
        return;
      }
      this._clearBargeIn(reason + ' (confirmed after ' + ms + 'ms)');
    }, ms);
  }

  // #367: grace = how long the bot rides out an interruption before yielding.
  // When urgency scaling is on, a high-urgency utterance (self-scored) holds the
  // floor for longer (up to bargeInGraceMaxMs), pure filler cedes it almost at
  // once (bargeInGraceMinMs), and an unscored utterance sits at the midpoint.
  // Off → the fixed bargeInGraceMs.
  _graceForCurrentUtterance() {
    if (this._pref('bargeInUrgencyScaling') === false) {
      return Number(this._pref('bargeInGraceMs')) || 0;
    }
    const min = Number(this._pref('bargeInGraceMinMs'));
    const max = Number(this._pref('bargeInGraceMaxMs'));
    const u = (typeof this._currentUrgency === 'number')
      ? Math.max(0, Math.min(1, this._currentUrgency))
      : 0.5; // unscored → midpoint
    return { ms: Math.round(min + u * (max - min)), u, scaled: true };
  }

  _armBargeIn() {
    if (this._bargeInTimer || this.botState !== 'speaking') return;
    // #422: replayed audio is not the bot talking — it is a recorded human,
    // played in so detection can be scored against ground truth. Barge-in must
    // not touch it. Without this, a two-speaker replay destroys the very
    // conversation it is reproducing: each bot hears the other, arms, and stops
    // its own playback (observed on the first end-to-end run — one side's audio
    // died 4s in and that side scored as 26 missed turns).
    if (this._uninterruptiblePlayback) return;
    const g = this._graceForCurrentUtterance();
    const graceMs = typeof g === 'number' ? g : g.ms;
    const detail = typeof g === 'number' ? '' : ` (urgency ${g.u.toFixed(2)}-scaled)`;
    console.log(ts(), '🛡️  [barge-in] armed — grace ' + graceMs + 'ms' + detail);
    clearTimeout(this._bargeInClearTimer); // a fresh arm outranks a pending disarm
    this._bargeInClearTimer = null;
    this._bargeInArmedAt = Date.now(); // #392: anchors the analyser-liveness re-check
    this._bargeInTimer = setTimeout(() => {
      this._bargeInTimer = null;
      this._evaluateBargeIn();
    }, graceMs);
  }

  // #392: is the floor demonstrably quiet RIGHT NOW, per the analyser?
  //
  // `p.speaking` / floorBusy can hold true for seconds after a speaker stops
  // (the tracker's release is poll/mutation-driven), so at grace evaluation
  // they answer "was anyone speaking recently", not "is anyone speaking". The
  // analyser's falling edge is the only signal fast enough to answer the
  // question the grace period actually asks: are they STILL going?
  //
  // Trust the quiet verdict only when the analyser has proven it tracked this
  // interruption: an OFF edge at/after the monitor armed, and quiet sustained
  // for bargeInQuietConfirmMs (a shorter quiet could be an inter-word dip —
  // the analyser samples per animation frame and dips between syllables).
  // If the analyser is absent or missed this speaker (no floor-audio events,
  // or its last OFF predates the arm), return false and let the tracker-flag
  // path decide as before: the bad failure direction is a broken analyser
  // making the bot NEVER yield, so uncertainty must mean "not quiet".
  _floorQuietPerAnalyser(now = Date.now()) {
    if (this.audioFloorSpeaking) return false;
    if (!this._audioFloorOffAt || this._audioFloorOffAt < this._bargeInArmedAt) return false;
    // #467: an OFF edge only means "they stopped" if we could have HEARD them
    // continue. page-inject's echo guard (#245) forces the far-end verdict
    // false whenever our own mic is loud, so while the bot talks a person
    // talking over it reaches the analyser as fragments with blind gaps
    // between. Same audio, same room: floor episodes ran 3.0-5.1s while the bot
    // was quiet, 0.35-0.49s while it spoke.
    //
    // The sharp edge was that a PARTIAL glimpse beat none. With no floor-audio
    // events at all the guard above returns false and the bot yields —
    // "uncertainty means not quiet", per #392. One fragment set _audioFloorOffAt,
    // and 250ms later the bot decided they had finished and talked straight
    // through them. Measured yield rate against a sustained human interrupter:
    // 1 in 6, failing identically every time.
    //
    // So: silence is only evidence if OUR audio was silent for it too. This is
    // deliberately not a longer timeout — a timeout would also throw away #392's
    // real case, where a blip genuinely ends during a gap in our own speech and
    // the bot should keep its sentence. When our mic was quiet and the analyser
    // still heard nothing, that silence is trustworthy and #392 stands. When we
    // were loud, it proves nothing.
    if (this._selfAudioLastLoudAt && this._selfAudioLastLoudAt >= this._audioFloorOffAt) return false;
    const confirmMs = Number(this._pref('bargeInQuietConfirmMs'));
    return Number.isFinite(confirmMs) && (now - this._audioFloorOffAt) >= confirmMs;
  }

  // #392 (issue suggestion 3): the analyser's view, for every back-off log
  // line — so the next stale-flag incident is diagnosable from one line
  // instead of hand-correlating [floor-audio] timestamps with the decision.
  _analyserStateForLog(now = Date.now()) {
    if (this.audioFloorSpeaking) return `analyser ON ${now - this._audioFloorAt}ms`;
    if (!this._audioFloorOffAt) return 'analyser silent (no floor-audio events this call)';
    return `analyser OFF ${now - this._audioFloorOffAt}ms ago`;
  }

  // Grace period elapsed. Decide whether to back off based on who's
  // interrupting. Caller guarantees the timer slot is clear so we can
  // re-arm with the random bot-vs-bot delay if needed.
  _evaluateBargeIn() {
    if (this.botState !== 'speaking' || !this.floorBusy) {
      // Bot already stopped, or interrupter shut up during the grace
      // period — nothing to do. #138: floorBusy, not anyoneSpeaking, or an
      // analyser-armed monitor would always bail here on the way back out.
      //
      // Logged because riding out a brief interruption is a DECISION, and it
      // was the only outcome in this function that left no trace. From the
      // outside "armed, then silence" is equally consistent with the bot
      // sailing through a backchannel (right) and with it yielding and losing
      // the rest of its sentence (wrong) -- the etiquette suite read this exact
      // case as the second and reported a failure against correct behaviour.
      console.log(ts(), '🛡️  [barge-in] rode it out — '
        + (this.botState !== 'speaking'
            ? 'bot had already finished speaking'
            : 'interrupter stopped during the ' + this._analyserStateForLog() + ' grace')
        + ' — continuing');
      return;
    }
    // #392: floorBusy just said someone is speaking — but its tracker half can
    // lag a real stop by seconds, so re-check against the analyser. A blip
    // that started AND ended inside the grace window is exactly what the grace
    // exists to ride out; yielding to it cuts a live reply for an interruption
    // that no longer exists.
    if (this._floorQuietPerAnalyser()) {
      console.log(ts(), '🛡️  [barge-in] interruption already ended (' + this._analyserStateForLog()
        + ', tracker flag lagging) — continuing');
      return;
    }
    const interrupters = this.participants.filter(
      (p) => p.speaking && !p.isSelf && p.name !== 'You'
    );
    if (interrupters.length === 0) {
      // #138: the analyser hears someone but Meet's DOM tracker hasn't named
      // them (routinely, while TTS plays). We can't tell bot from human without
      // a name, and the rule below is already "unknown ⇒ human" — so yield.
      // Talking over a real person is the worse failure.
      console.log(ts(), '🛡️  [barge-in] someone interrupted (analyser only, no DOM speaker yet) — backing off ('
        + this._analyserStateForLog() + ')');
      this._performBackOff('human-interrupt');
      return;
    }

    // Cross-reference against registered bot members (same logic the
    // get_room_info / panel tag uses). When the binding is unknown, default
    // to "human" — better to yield than to talk over a real person.
    const botNames = this._botNameSet();
    const humanInterrupter = interrupters.find(
      (p) => !botNames.has((p.name || '').toLowerCase())
    );

    if (humanInterrupter) {
      console.log(ts(), '🛡️  [barge-in] human interrupted — backing off:', humanInterrupter.name,
        '(' + this._analyserStateForLog() + ')');
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
      if (this.botState !== 'speaking' || !this.floorBusy) {
        console.log(ts(), '🛡️  [barge-in] bot-vs-bot resolved during random delay — continuing');
        return;
      }
      // #392: same stale-flag hazard as the main evaluation — the colliding
      // bot may have stopped during the random delay with its tracker flag
      // still raised.
      if (this._floorQuietPerAnalyser()) {
        console.log(ts(), '🛡️  [barge-in] bot-vs-bot collision already ended ('
          + this._analyserStateForLog() + ', tracker flag lagging) — continuing');
        return;
      }
      console.log(ts(), '🛡️  [barge-in] bot-vs-bot still colliding after random delay — backing off ('
        + this._analyserStateForLog() + ')');
      this._performBackOff('bot-interrupt-random');
    }, delay);
  }

  _performBackOff(reason) {
    // #350: if we were actually mid-utterance, mark the cut (+ a words baseline)
    // so the next silence edge can resume the retained audio near where it
    // stopped. Captured BEFORE onStopTts/_setBotState flip us out of 'speaking'.
    if (this.botState === 'speaking') {
      this._ttsInterruptedAt = Date.now();
      this._ttsInterruptWordsBaseline = this._tickWordCount(this.getEffectiveBotName());
      this._ttsInterruptUrgency = this._currentUrgency; // #367: for urgency-scaled resume tolerance
    }
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
      if (this.bargeInStash) {
        console.log(ts(), '🛡️  [barge-in] overwriting an unplayed stash (' +
          (Date.now() - this.bargeInStash.at) + 'ms old) — the floor never opened for it');
      }
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
  // The effective value of a preference: what is stored, if it is valid for the
  // schema, else the default.
  //
  // Stored values go through validate() rather than straight out, so a pin
  // written by hand or by an older build cannot be a different TYPE from what
  // the reader expects. That is not hypothetical — it cost two days. A bot on
  // 2026-08-17 talked over a human three times because `floorBusy` is gated on
  // `_pref('fastFloorDetection') === true`, and a strict comparison against a
  // stored string is false however the string reads. `"true"` would have
  // disabled the fast floor exactly as thoroughly as `false`, with no warning
  // and no way to tell the two apart from a log (#417).
  //
  // coerceType, NOT validate: it fixes the FORM ("1500" to 1500, "on" to true)
  // and leaves the POLICY alone. Range and enum are enforced by set_preference
  // on the way in, so a value outside them arrived deliberately — a hand-edited
  // config, or a test setting defaultSilenceSeconds to 0.02 so it does not sleep
  // for seconds. Overriding a deliberate choice here would be a second bug
  // wearing the first one's clothes.
  //
  // A value that cannot be made into the declared type at all IS treated as
  // unset, and warned about once per key — the failure mode being fixed is
  // silence, but _pref runs on the speak path, so warning on every read would
  // be its own problem.
  _pref(key) {
    if (this.getPref) {
      const stored = this.getPref(key);
      if (stored !== undefined && stored !== null) {
        const r = prefsSchema.coerceType(key, stored);
        if (r.ok) return r.value;
        if (!this._warnedBadPrefs) this._warnedBadPrefs = new Set();
        if (!this._warnedBadPrefs.has(key)) {
          this._warnedBadPrefs.add(key);
          const spec = prefsSchema.PREFERENCES[key];
          console.warn(ts(), `⚠️  [preferences] ignoring stored ${key}=${JSON.stringify(stored)} `
            + `— ${r.error}. Using the default ${JSON.stringify(spec ? spec.default : undefined)}.`);
        }
      }
    }
    const spec = prefsSchema.PREFERENCES[key];
    return spec ? spec.default : undefined;
  }

  // #350: if the bot was cut off mid-utterance and the floor just reopened,
  // ask the renderer to resume the retained audio near the interruption point
  // — rather than dropping the half-spoken sentence. Gated the same way as the
  // #239 stash replay: fresh enough (ttsResumeMaxAgeMs) AND the conversation
  // didn't move on (bargeInStashRedeliverMaxNewWords). One-shot regardless of
  // outcome. Returns true iff a resume was fired.
  _maybeResumeInterruptedTts() {
    if (!this._ttsInterruptedAt) return false;

    // The floor, at the instant audio would restart. This runs on a silence
    // edge, so the floor has just opened — but "just opened" is not "still
    // open", and the analyser leads the tracker by up to a second (#417), which
    // is exactly the width of the window something can start in.
    //
    // BEFORE the consume below, unlike every other guard here, and the
    // distinction is the point. The age and relevance guards mean "this is no
    // longer worth saying", so spending the one attempt is correct. A busy floor
    // means "not right now" — a condition that clears on its own. Dropping the
    // tail for it would defeat #350, whose entire purpose is to not lose the
    // half-spoken sentence. Left unconsumed, the next silence edge retries, and
    // ttsResumeMaxAgeMs still bounds how long that can go on.
    //
    // Deliberately NO ranked ordering, unlike every other speech path. Ranking
    // decides who answers a human — a competition for a NEW turn. A resume
    // finishes a turn this bot already had and was cut off in, so queueing it
    // behind a peer would pause it mid-sentence to be polite about a turn
    // nobody is contesting.
    if (this.floorBusy) {
      console.log(ts(), '🔊 [tts-resume] not resuming — floor busy; the tail stays held');
      return false;
    }

    const at = this._ttsInterruptedAt;
    const baseline = this._ttsInterruptWordsBaseline;
    this._ttsInterruptedAt = 0; // consume — one attempt per interruption
    if (this._pref('ttsResumeEnabled') === false) return false;
    const ageMs = Date.now() - at;
    const maxAgeMs = Number(this._pref('ttsResumeMaxAgeMs'));
    if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) {
      console.log(ts(), '🔊 [tts-resume] skip — too stale (' + ageMs + 'ms > ' + maxAgeMs + 'ms)');
      return false;
    }
    const newWords = this._tickWordCount(this.getEffectiveBotName()) - baseline;
    let maxNewWords = Number(this._pref('bargeInStashRedeliverMaxNewWords'));
    // #367: a higher-urgency utterance tolerates more interruption words before
    // giving up on resuming — it really wanted to finish. Scale the base by
    // (0.5 + urgency): filler ~0.5×, midpoint 1×, house-on-fire 1.5×. Keeps the
    // grace and resume knobs moving together instead of fighting.
    if (this._pref('bargeInUrgencyScaling') !== false && typeof this._ttsInterruptUrgency === 'number') {
      const u = Math.max(0, Math.min(1, this._ttsInterruptUrgency));
      maxNewWords = Math.round(maxNewWords * (0.5 + u));
    }
    if (Number.isFinite(maxNewWords) && newWords > maxNewWords) {
      console.log(ts(), '🔊 [tts-resume] skip — conversation moved on (' + newWords + ' new words > ' + maxNewWords + ')');
      return false;
    }
    console.log(ts(), '🔊 [tts-resume] resuming interrupted utterance (' + ageMs + 'ms old, ' + newWords + ' new words)');
    this._setBotState('speaking');
    try {
      this.onResumeTts();
    } catch (err) {
      console.warn(ts(), '[tts-resume] onResumeTts failed:', err.message);
      return false;
    }
    // #360: the truncation record's tail is now being replayed — mark it so
    // the drain callback can fold the tail back into `spoken`, and so the
    // agent-facing note can say "resuming now" instead of "never heard".
    if (this._speechTruncation) this._speechTruncation.resumed = true;
    return true;
  }

  // #109: record a stash we threw away, so the agent finds out on its next
  // resolve. speak() told it "held — will auto-replay", and the ONLY signal
  // that it didn't was the absence of a replayedBargeInStash note — a negative
  // an agent can't reliably read. On the Jul 28 call 13 of 31 stashes died this
  // way, each one a reply the agent believed had been spoken. Silence about a
  // dropped reply is worse than the drop: the agent goes on to build on
  // something the room never heard.
  _noteDiscardedStash(stash, reason) {
    const texts = (stash?.entries || []).map((e) => e && e.text).filter(Boolean);
    if (!texts.length) return;
    this._lastDiscardedStash = { texts, reason };
  }

  // #359: the raised hand (🙋 "yielding") means "a reply is stashed and
  // ready." Every place that discards a stash without ever speaking it
  // must drop the hand in the same transaction — otherwise the hand
  // outlives the thing it was raised for, and a human reads it as a lie.
  _lowerHandIfYielding() {
    if (this.botState !== 'yielding') return;
    this._setBotState(this.waiters.length > 0 ? 'listening' : 'idle', undefined, { force: true });
  }

  // #359: does the utterance that just ended name this bot? Same rule, same
  // signal, as the waiter fast-resolve in _checkWaiters — deliberately NOT
  // narrowed to "short" utterances or "name at the end": position/length in
  // the utterance is an unreliable signal (more so across languages) and
  // this only ever SHORTENS an already silence-gated wait, never skips it,
  // so there's no speaker to cut off either way. Looks at the most recent
  // non-bot entry only — the utterance that just closed on this speech-stop
  // edge, not the whole held-open window. Used to shorten the stash-opening
  // wait (see the speech-stop handler in setParticipants); NOT used to
  // decide whether to replay at all — the freshness/relevance guards in
  // _maybeReplayBargeInStash still get the last word.
  _stashLatestUtteranceMentionsBotName() {
    const myName = (this.getEffectiveBotName() || '').toLowerCase();
    if (!myName) return false;
    const entries = this._entriesSince(null, this.getEffectiveBotName());
    const latest = entries.length ? entries[entries.length - 1] : null;
    const text = String(latest?.text || '').toLowerCase();
    return !!text && text.includes(myName);
  }

  // Was this bot addressed by name at any point while the stash was held?
  //
  // Deliberately the whole held window, not _stashLatestUtteranceMentionsBotName's
  // single latest utterance. That one answers "did the utterance that just ended
  // name me", which is the right question for a speech-stop edge. Here the
  // question is different: someone asked for me while I was waiting, and by the
  // time the floor opens their question is usually no longer the newest caption
  // -- the interrupter kept talking after it. Looking only at the latest entry
  // misses exactly the case this exists for.
  _stashWasAddressedByName() {
    const stash = this.bargeInStash;
    if (!stash) return false;
    const myName = (this.getEffectiveBotName() || '').toLowerCase();
    if (!myName) return false;
    const entries = this._entriesSince(stash.at, this.getEffectiveBotName());
    return entries.some(e => String(e.text || '').toLowerCase().includes(myName));
  }

  // Attempt to replay any fresh barge-in stash before the waiter returns
  // to the slow model. Returns the array of texts that were played (or
  // null if nothing). The bot speaks via the existing onBotSpeech path,
  // so TTS playback / transcript registration follow the normal route.
  _maybeReplayBargeInStash() {
    if (!this.bargeInStash) return null;
    const ageMs = Date.now() - this.bargeInStash.at;
    const maxAgeMs = this._pref('bargeInStashMaxAgeMs');
    // Wall-clock staleness guard: the floor took too long to reopen.
    if (ageMs > maxAgeMs) {
      console.log(ts(), '🛡️  [barge-in] discarding stash — too stale (' + ageMs + 'ms old, max ' + maxAgeMs + 'ms)');
      this._noteDiscardedStash(this.bargeInStash, `the floor stayed busy for ${Math.round(ageMs / 1000)}s`);
      this.bargeInStash = null;
      this._lowerHandIfYielding();
      return null;
    }
    // Content staleness guard (#239): even inside the age window, if a lot was
    // SAID while the reply was held, the queued thought is answering a
    // conversation that has moved on — replaying it would be a non-sequitur.
    // Discard and let the agent re-derive on the caught-up window instead.
    // (wordsAtStash is only recorded on the drop-before-playback stash path;
    // the mid-TTS _performBackOff path leaves it undefined → age-only, as before.)
    if (this.bargeInStash.wordsAtStash != null) {
      const newWords = this._tickWordCount(this.getEffectiveBotName()) - this.bargeInStash.wordsAtStash;
      const maxNewWords = Number(this._pref('bargeInStashRedeliverMaxNewWords'));
      if (Number.isFinite(maxNewWords) && newWords > maxNewWords) {
        // Unless they asked for it by name. The guard's premise is that nobody
        // wants the held thought any more, and a direct "So <name>, what do you
        // think?" is that premise being contradicted out loud. Discarding there
        // answers a question with silence, which is the worst of both: the bot
        // neither speaks nor is heard declining to.
        //
        // Only this guard is waived. The wall-clock age guard above still runs,
        // because a genuinely ancient thought is wrong to replay however it was
        // asked for, and the floor-busy check below still runs, because being
        // named is not licence to talk over the person doing the naming.
        if (this._stashWasAddressedByName()) {
          console.log(ts(), '🛡️  [barge-in] keeping stash despite ' + newWords + ' new words — the bot was addressed by name');
        } else {
          console.log(ts(), '🛡️  [barge-in] discarding stash — conversation moved on (' + newWords + ' new words > ' + maxNewWords + ') — agent will re-derive');
          this._noteDiscardedStash(this.bargeInStash, `${newWords} words were said while it waited`);
          this.bargeInStash = null;
          this._lowerHandIfYielding();
          return null;
        }
      }
    }
    // #430/#442: the floor, read HERE — at the instant audio would start, which
    // is the only instant a floor read means anything (#67).
    //
    // _maybeReplayStashOnOpening checks floorBusy before calling us, but the
    // OTHER caller — the wait_for_speech resolve path — does not, and a replay
    // reaches onBotSpeech directly without passing the audio-start gate that
    // every freshly composed utterance goes through. So a held reply could play
    // into a gap somebody was already taking. Observed twice on 2026-08-17.
    //
    // Not a replay-specific rule: it is the same floor every other speech path
    // consults, applied to the one path that was skipping it.
    if (this.floorBusy) {
      console.log(ts(), '🛡️  [barge-in] not replaying — floor busy at audio-start; stash held');
      return null;                       // the stash survives for the next opening
    }

    const entries = this.bargeInStash.entries;
    console.log(ts(), '🛡️  [barge-in] replaying stash — ' + entries.length + ' entries, ' + ageMs + 'ms old');
    this.bargeInStash = null;
    const texts = [];
    for (const { text, voice, emoji, urgency } of entries) {
      // #367: urgency was carried all the way through the stash and then dropped
      // on this line — the destructure used to take text/voice/emoji only, so a
      // replayed utterance was graded with whatever urgency the PREVIOUS one
      // had, and _armBargeIn scaled its grace from that stale number.
      this._currentUrgency = (typeof urgency === 'number') ? urgency : null;
      this._setBotState('speaking', { emoji });
      this.onBotSpeech(text, voice, emoji);
      texts.push(text);
    }
    // Advance the responded-through clock so timing-based guards know a real
    // reply just went out on this silence edge. (Full respondedThrough windowing
    // is #153; here we mark the moment so the agent's same-resolve response —
    // guided by the replayedBargeInStash one-shot in _buildResponse — builds on
    // the replay instead of racing it.)
    this.lastRespondedAt = Date.now();
    return texts;
  }

  // The floor opened and the bot is holding a composed reply. Say it.
  //
  // This exists because replaying only at wait_for_speech resolution meant the
  // stash almost never played: a resolution requires an agent parked in a
  // long-poll, and the agent spends much of a call outside one (composing,
  // running tools). Measured on a real 30-minute call: 13 stashes, 0 replays.
  // The opening is a property of the ROOM, so it is detected here from the
  // speech-stop edge and honoured regardless of this.waiters.
  //
  // The freshness/relevance guards still live in _maybeReplayBargeInStash, and
  // _lastReplayedStash still surfaces to the agent on its next resolve, so the
  // agent learns its queued thought went out and builds on it instead of
  // repeating it.
  _maybeReplayStashOnOpening() {
    this._stashOpeningTimer = null;
    if (!this.bargeInStash) return;
    if (this.callStatus !== 'in-call') return;
    // Silent mode is "act but never speak" — a replay is speech.
    if (this.mode === 'silent') return;
    // The floor closed again, or the bot is already talking. #138: floorBusy —
    // a replay calls onBotSpeech directly, so it never reaches the audio-start
    // gate, and this read is the only thing standing between a held reply and
    // talking over someone Meet's tracker hasn't flagged. A stuck-ON analyser
    // costs a stash (it ages out and the agent re-derives), not a whole call.
    if (this.floorBusy || this.botState === 'speaking') return;

    // Same precedence as the resolve-time path: an utterance the room actually
    // heard the bot START saying (#350) outranks one it never heard at all.
    // Both consumers are one-shot, so the later resolve-time call is a no-op.
    const resumed = this._maybeResumeInterruptedTts();
    if (resumed) return;
    const replayed = this._maybeReplayBargeInStash();
    if (replayed) {
      this._lastReplayedStash = replayed;
      console.log(ts(), '🛡️  [barge-in] stash replayed at a floor opening (no waiter needed)');
    }
    // If the guards rejected it, _maybeReplayBargeInStash already lowered
    // the hand as part of the discard.
  }

  // How long the room has been quiet, judged from the freshest of `entries`.
  //
  // Two traps this exists to avoid, both of which shipped:
  //   • `timestamp` is firstSeen — when a turn STARTED. A still-growing turn
  //     keeps its firstSeen and advances `lastUpdated`, so measuring from
  //     timestamp makes any long utterance look ancient while it's still being
  //     spoken. Always prefer lastUpdated. (Bot-speech entries have no
  //     lastUpdated; timestamp is correct for them.)
  //   • entries are sorted by firstSeen, so entries[last] is the turn that
  //     STARTED most recently, not the one that CHANGED most recently. Take the
  //     max rather than the tail.
  _quietMsSince(entries) {
    let freshest = 0;
    for (const e of entries) {
      const t = new Date(e.lastUpdated || e.timestamp).getTime();
      if (t > freshest) freshest = t;
    }
    return freshest ? Date.now() - freshest : Infinity;
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

  // Everyone in the call except this bot itself. Deliberately does NOT exclude
  // other bots: for turn-taking purposes a second bot is a conversational
  // partner like any other. (The ack path's isOneOnOne (#155) excludes bots
  // because it answers a different question — "is this turn aimed at me".)
  _otherParticipantCount() {
    return (this.participants || []).filter(
      (p) => !p.isSelf && p.name && p.name !== 'You'
    ).length;
  }

  // Brief-silence soft-opening hook. Armed in the speech-stop branch only when
  // probeFiring is on; if the room is still quiet after probeSilenceMs, surface
  // an opening to main.js (which runs the Apple completeness gate). All cheap
  // guards live here so we never even call the model when a probe couldn't fire.
  _maybeProbeOpening() {
    this._probeTimer = null;
    if (!this._pref('probeFiring')) return;
    if (this.mode !== 'active' || this.callStatus !== 'in-call') return;
    if (this.floorBusy || this.botState === 'speaking') return; // #138: either signal
    // A held reply beats a filler. The stash-opening timer owns this gap.
    if (this.bargeInStash) return;
    if (this.waiters.length === 0) return; // slow model isn't listening
    // A probe exists to fill a gap in a conversation between OTHERS. With only
    // one other participant there is no such conversation: every turn is aimed at
    // the bot, and a real turn resolution is ~700ms behind the soft opening.
    // Probing there stacks three utterances onto one sentence — observed live:
    //     14:12:00.873  🎣 [probe] firing (generic): "Huh."
    //     14:12:01.623  👂 [ack] Playing acknowledgement: "Okay."   (me-1on1)
    //     14:12:0x       ...and then the actual reply.
    // The name-mention guard below cannot catch this: with one other participant
    // nobody needs to say the bot's name to be talking to it. A second BOT counts
    // as a partner here — two bots alone are a 1:1 too, and equally probe-free.
    if (this._otherParticipantCount() < 2) return;
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
    if (this.floorBusy || this.botState === 'speaking') return null; // #138: either signal
    // Re-check: a stash may have landed, or someone may have left (dropping the
    // room to a 1:1), during the ~0.6s gate call.
    if (this.bargeInStash) return null;
    if (this._otherParticipantCount() < 2) return null;
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
    // #343: peak concurrent speakers during this wait — the interruptibility
    // evidence. A high peak on a late (tick) resolve is the choke case: the
    // floor was ≥2-deep so the bot never found a whole-room gap.
    const peakSpeakers = this._peakSpeakersSinceQuiet;
    console.log(ts(), '✅ [resolve] wait_for_speech resolved — reason=' + reason + ', waited=' + waitedMs + 'ms, peakSpeakers=' + peakSpeakers);
    this._peakSpeakersSinceQuiet = this.activeSpeakerCount; // reset for the next turn

    // Start the responsiveness clock for turns Claude is expected to answer (a
    // real utterance handed over: silence gap or a direct mention). NOT timeouts
    // (no speech) or background ticks (the floor is still busy and the bot
    // usually stays silent). The latest such resolve wins — if Claude never
    // spoke on the prior one, that turn simply had no audible reply.
    if (reason === 'silence' || reason === 'mention') {
      this._pendingTurnSince = Date.now();
      // #339: show "processing your turn" (🤔) immediately rather than staying on
      // the listening face until the agent's first action. Tool activity then
      // escalates to 🧑‍💻 working; the reply transitions to speaking.
      if (this.callStatus === 'in-call' && (this.botState === 'listening' || this.botState === 'idle')) {
        this._workingSince = Date.now(); // start the 🤔→🧑‍💻 dwell clock at resolve
        this._setBotState('thinking');
      }
    }

    // Auto-replay any fresh barge-in stash on silence resolution — that's
    // the "you had your hand raised, the room went quiet, just speak"
    // moment. Skip on timeout/mention/displaced/etc; only silence is the
    // natural conversational gap. A background_tick is explicitly NOT a gap —
    // the floor is still busy — so never replay the stash on a tick.
    if (reason === 'silence') {
      // #350: an utterance cut off mid-playback takes precedence over a
      // never-played stash (#239) on this edge — it's the thing the room
      // actually heard the bot start saying. If we resume it, don't also
      // replay a stash (that'd be two audios).
      const resumed = this._maybeResumeInterruptedTts();
      if (!resumed) {
        const replayed = this._maybeReplayBargeInStash();
        if (replayed) this._lastReplayedStash = replayed;
      }
    }

    const response = this._buildResponse(waiter.since, waiter.bot, waiter.startTime);
    // Size of the variable part of what this round hands the agent (#12): the
    // MCP layer wraps these entries in fixed prose, so entry chars are the
    // per-round payload trend. A snowballing re-delivery bug shows up here as
    // entries/chars climbing round over round; the 📊 [context] marker carries
    // the full context size the model actually processed.
    {
      const respEntries = (response.transcript && response.transcript.entries) || [];
      const respChars = respEntries.reduce((n, e) => n + String(e.text || '').length, 0);
      console.log(ts(), `📦 [payload] round → ${respEntries.length} entries, ${respChars} chars, reason=${reason}`);
      this._auditDelivery(respEntries, reason);
    }
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
      } else if (reason === 'background_tick') {
        // A tick is NOT a turn. It fires on a word-count delta while the speaker
        // is still mid-sentence, so it hands the slow model a snapshot, not a
        // finished thought. Wearing 🤔 and overwriting lastProcessingText made it
        // look — on the avatar and on the debug overlay's `proc:` line — exactly
        // like the bot had committed to answering half a sentence. It hadn't.
        //
        // Give it its own face (😑 "reading along") and leave lastProcessingText
        // alone: that field means "what shipped to the slow model as a TURN".
        console.log(ts(), '😑 [tick] Catching up — ' + wordCount + ' words, not a turn: "' + joinedText.slice(0, 120) + (joinedText.length > 120 ? '…' : '') + '"');
        this._setBotState('ticking', { wordCount, backgroundTick: true });
        this._armTickFaceTimer();
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
        // Ticks never reach here — they take the 'ticking' branch above — so
        // this is always a real turn and both the ack and triage may fire.
        this.onBotStateChange('thinking', { wordCount, text: joinedText, backgroundTick: false });

        // Two-tier shadow harness (now: triage classifier). Feed it the SINGLE
        // most-recent turn WITH its speaker label — not joinedText, which is the
        // windowed merge of every turn in the wait window. The merge mashed
        // multiple speakers (and truncated fragments) into one blob and gave the
        // classifier garbage to judge ("…Request Samantha, can you" = Samantha's
        // turn + the cut-off start of Stan's next turn). The classifier is ~perfect
        // on clean input (offline 19/19); recentTranscript still carries context.
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

    // #109: the mirror case — a queued reply that was thrown away rather than
    // played. Same one-shot discipline, opposite meaning: the agent must know
    // the room never heard it, so it can say the thing again if it still
    // matters instead of assuming it landed.
    const discardedBargeInStash = startTime ? this._lastDiscardedStash : null;
    if (startTime && this._lastDiscardedStash) this._lastDiscardedStash = null;

    // #360: same one-shot surface for a barge-in that truncated the previous
    // utterance mid-playback — the agent was told "Spoken" at dispatch time,
    // and this is the correction saying which words actually landed.
    const speechTruncated = startTime ? this.takeSpeechTruncation() : null;

    return {
      success: true,
      roomId: this.roomId,
      // The per-join call id (room code + start timestamp, minted in setRoom).
      // roomId alone repeats across every call in the same room, so it cannot
      // name a per-call artifact folder; this can. Surfaced through
      // get_room_info so the bot's CLAUDE.md can point at calls/<call-id>/.
      callId: this.callId,
      asOf: new Date().toISOString(),
      waited: !!startTime,
      elapsed,
      continuationOfPriorResponse,
      previousAckPhrase,
      replayedBargeInStash,
      discardedBargeInStash,
      speechTruncated,
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
      // WHO IS IN THE ROOM. Pseudo-tiles are filtered here rather than upstream:
      // they must stay in this.participants because anyoneSpeaking is derived
      // from it and a "Merged audio" tile can be where two co-located people's
      // speech actually registers. But it is not a person, and reporting it as
      // one had the bot addressing "Merged audio" as a participant.
      participants: (this.participants || []).filter((p) => !p.isPseudo),
      // Everyone sharing their screen right now, from the people pane (#…).
      // Unlike presenterName this can hold MORE THAN ONE, and it still works
      // while the bot itself is presenting.
      screenShares: this.screenShares || [],
      detectedMeetUrls: this.detectedMeetUrls,
      detectedSlackHuddleUrl: this.detectedSlackHuddleUrl,
      currentMeetUrl: this.currentUrl,
      status: {
        callStatus: this.callStatus,
        // What the bot believes about the floor RIGHT NOW, and the two halves
        // it is derived from. Exposed because the only other way to ask was to
        // grep the session log for [floor-audio] ON/OFF edges and reconstruct
        // the state from them -- which fails silently the moment an edge
        // scrolls out of the tail being read. The etiquette harness hit exactly
        // that: it reported "the floor never went busy" on runs where the ON
        // edge was sitting in the log, just past the window it fetched.
        //
        // A level, not an edge, so a reader that misses the transition still
        // gets the right answer on its next poll.
        anyoneSpeaking: this.anyoneSpeaking,
        audioFloorSpeaking: this.audioFloorSpeaking,
        floorBusy: this.floorBusy,
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
        // Claude responsiveness (resolve→first-speak) — exposed over HTTP so a
        // headless harness can assert the reaction-time readout, not just the GUI.
        lastResponseMs: this.lastResponseMs,
        responsePerf: this._perfStats(),
        workingMemory: this.getWorkingMemory(),
        chatUnread: this.chatUnread,
        roomUrl: this.roomId ? `${(this.getWebsiteUrl() || '').replace(/\/$/, '')}/room/${this.roomId}` : null,
        // #102: carries surface=viewer like the auto-posted link (main.js:680).
        // This is the URL get_room_info hands the agent, and the skill tells the
        // agent to paste it into chat when someone ASKS for the whiteboard link —
        // i.e. the highest-intent case there is. Emitting it untagged meant that
        // path could never show the signup CTA even once the web side reads the
        // tag, while the auto-posted link would. No src= here: this URL's
        // provenance is genuinely unknown — the agent may paste it into chat, an
        // email, or read it aloud — which is exactly why the CTA must key off
        // AUDIENCE (surface) rather than transport. The bot's own capture window
        // uses surface=share instead (main.js:2208) and must never come through
        // here.
        whiteboardUrl: this.roomId ? `${(this.getWebsiteUrl() || '').replace(/\/$/, '')}/room/${this.roomId}?mode=whiteboard&surface=viewer` : null,
        // What's loaded in the screen-share window now — any URL, not just the
        // whiteboard (#177).
        screenShareUrl: this.getWhiteboardLoadedUrl(),
        sessionLogPath: getSessionLogPath(),
        // Calendar auto-join (#299): only present when this join was matched
        // from a Google Calendar event — see setCalendarEventContext. This is
        // how get_room_info tells the agent WHY it's here, instead of it
        // walking into a call cold.
        calendarEventContext: this.calendarEventContext || null,
        // #324: whether auto-join is armed AT ALL, as opposed to why this
        // particular join happened. The pair matters on an unattended box: a
        // bot that never turns up looks identical to a quiet calendar, and this
        // is the only thing that tells them apart without a human reading a
        // banner nobody is looking at. null = the poller never ran.
        calendarHealth: this.calendarHealth,
      },
    };
  }

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  start() {
    // #356: mint a per-launch control token before we accept any request.
    if (!this.authToken) this.authToken = crypto.randomBytes(24).toString('hex');
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // The agent is the only thing that talks to this server over HTTP (the
        // panel uses IPC), so any request IS proof of life. Stamped on arrival
        // rather than completion because wait_for_speech blocks for up to 55s —
        // crediting it at the end would backdate the agent's liveness by a
        // whole cycle.
        this.lastAgentActivityAt = Date.now();
        this.agentSocketLost = false;
        this._handleRequest(req, res).catch(err => {
          console.error('[local-server] Request error:', err.message);
          // A handler that already responded and THEN threw would otherwise
          // raise ERR_HTTP_HEADERS_SENT here as an unhandled rejection, burying
          // the real error under a second one — which is exactly how the bug
          // above hid: the log showed the headers error, not the cause.
          if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      });

      // Fires on the initial bind AND any EADDRINUSE-retry bind, so the token file
      // always tracks the port we actually ended up on.
      this.server.on('listening', () => this._writeAuthToken());

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

  // #356: write the control token to a 0600 file only the local user can read.
  // Best-effort — never let a filesystem hiccup take down the control server.
  _writeAuthToken() {
    try {
      fs.mkdirSync(AUTH_TOKEN_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(localTokenPath(this.port), this.authToken, { mode: 0o600 });
    } catch (err) {
      console.warn('[local-server] could not write control-token file:', err.message);
    }
  }

  stop() {
    this.resolveAllWaiters();
    try { fs.unlinkSync(localTokenPath(this.port)); } catch { /* already gone */ }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async _handleRequest(req, res) {
    // #356: enforcement landed dark and is now ON by default (#201). Set
    // VIBECONF_REQUIRE_TOKEN=0 to fall back to the legacy wildcard-CORS, no-auth
    // server if something local turns out to need it.
    //
    // What flipped this: two macOS user accounts each assign profile ports from
    // their OWN registry, but 127.0.0.1 is machine-wide — so an agent in account
    // B could connect to account A's app and drive it. With no auth that is
    // SILENT: the agent joins and speaks into the wrong app while the bot in
    // front of the user sits mute, no error on either side. The token makes the
    // wrong app answer 401 instead, which is a bug report rather than a mystery.
    //
    // Safe to require because the local server only serves /api/* and /asset/* —
    // /room/:id (the board a browser opens) is rendered by the website, not here.
    // The only HTTP client is the MCP server, a same-user Node process that reads
    // the 0600 token file per request.
    const requireAuth = process.env.VIBECONF_REQUIRE_TOKEN !== '0';
    const reqPath = (() => { try { return new URL(req.url, `http://127.0.0.1:${this.port}`).pathname; } catch { return req.url || ''; } })();

    // CORS headers for local requests.
    if (requireAuth) {
      // Do NOT hand a browser a wildcard once locked down. Our MCP client is a
      // same-user Node process and sends no Origin (CORS N/A). App webviews that
      // legitimately need cross-origin reads can be allowlisted via env.
      const origin = req.headers.origin;
      const allowed = (process.env.VIBECONF_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Custom routes (main.js) get first crack — BEFORE the auth gate — so they can serve
    // open localhost-only routes like the Claude-ready ping. Returns true if it handled it.
    if (this.extraRoutes) {
      try { if (await this.extraRoutes(req, res)) return; }
      catch (err) { console.error('[local-server] extraRoutes error:', err && err.message); }
    }

    // #356: bearer-token gate. Open routes stay reachable so instance discovery
    // and opaque-token asset serving keep working: GET /api/sync/no-room is the
    // MCP's discovery ping (returns only coarse status), and /asset/<token> already
    // carries its own per-asset capability token in the path (#157).
    if (requireAuth) {
      const isOpen = (req.method === 'GET' && reqPath === '/api/sync/no-room') || reqPath.startsWith('/asset/');
      if (!isOpen) {
        const auth = req.headers['authorization'] || '';
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        // Constant-time compare to avoid leaking the token via timing.
        const ok = presented.length === this.authToken.length &&
          crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(this.authToken));
        if (!ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'unauthorized' }));
          return;
        }
        // Force JSON on writes: a cross-site form/simple-request can only send a
        // handful of content-types, none of them application/json — requiring it
        // makes every mutating call trip a CORS preflight (which we now gate).
        if (req.method === 'POST') {
          const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (ct !== 'application/json') {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'content-type must be application/json' }));
            return;
          }
        }
      }
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
          appVersion: this.appVersion,
          buildType: this.buildType, // 'release' (DMG) | 'source' (pnpm dev)
          lastResponseMs: this.lastResponseMs,
          responsePerf: this._perfStats(),
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
    // Start a call from outside the app — the /call command's entry point.
    // Deliberately mirrors the panel button rather than duplicating it: both go
    // through main's createAndJoinMeet. Never echoes the meeting URL back; the
    // link is a bearer capability and the caller doesn't need it (the bot is
    // already in, and the human's browser is already opening).
    if (url.pathname === '/api/call/start' && req.method === 'POST') {
      // openBrowser:false means the caller isn't sitting at this machine (Claude
      // Code driven from a phone, say), so no tab is opened on an unattended
      // desktop. The join link is returned either way: it used to be withheld
      // as a bearer capability, but the caller is the user's own agent, and a
      // remote one has no other route into the room it just made.
      let openBrowser = true;
      // No spawned agent by default on THIS route. Reaching it means an MCP
      // client asked for the call, and that client is the agent — the app used
      // to open a Terminal running a second Claude anyway, so the call got two
      // drivers racing for wait_for_speech (2026-07-29: the session that made
      // the call was displaced by the one the app spawned). The panel button
      // does not come through here; it keeps its terminal.
      //
      // Overridable for the case with no agent behind it at all — a bare curl,
      // a script — where a driverless bot in the room is the worse outcome.
      let spawnAgent = false;
      try {
        const parsed = JSON.parse((await this._readBody(req)) || '{}');
        if (parsed && parsed.openBrowser === false) openBrowser = false;
        if (parsed && parsed.spawnAgent === true) spawnAgent = true;
      } catch { /* no body / unparseable — keep the defaults */ }

      let result;
      try { result = await this.onStartCall({ openBrowser, spawnAgent }); } catch (err) { result = { ok: false, code: 'error', detail: err.message }; }
      res.writeHead(result?.ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result?.ok
        ? { success: true, roomId: this.roomId || null, url: result.url || null }
        : { success: false, code: result?.code || 'unknown', detail: result?.detail || null }));
      return;
    }

    if (url.pathname === '/api/focus' && req.method === 'POST') {
      try { this.onFocusRequest(); } catch { /* best-effort */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // #209: call recording on/off (start_recording MCP tool).
    if (url.pathname === '/api/call/record' && req.method === 'POST') {
      let on = true;
      try {
        const parsed = JSON.parse((await this._readBody(req)) || '{}');
        if (parsed && parsed.on === false) on = false;
      } catch { /* no body — default to on */ }
      let result;
      try { result = await this.onRecord({ on }); } catch (err) { result = { ok: false, code: 'error', detail: err.message }; }
      res.writeHead(result?.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result || { ok: false, code: 'unknown' }));
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

    // Per-call log slice (#287) — the after-call-work counterpart to the
    // "share this call's log" button (#255). Unlike that button, this doesn't
    // upload anywhere: it just returns the lines, so an agent can read/save
    // them like any other after-call artifact. Accepts any callId, not just
    // the currently-active one, since after-call work runs post-hangup once
    // this.callId has already been cleared.
    if (url.pathname === '/api/call-log' && req.method === 'GET') {
      const callId = url.searchParams.get('callId');
      if (!callId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'callId is required' }));
        return;
      }
      const lines = sliceCallLines(callId, getSessionLogPath());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        callId,
        filePath: getSessionLogPath(),
        content: lines.join('\n'),
        lineCount: lines.length,
      }));
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
          if (result?.ok) this.setChatUnread(false, { authoritative: true });
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

    // Where the bundled sample art lives, so an agent can SHOW the options
    // instead of describing them.
    //
    // The onboarding call asks people to pick an emoji set and a background.
    // Both were lists of words — "fluent3d, twemoji, openmoji, noto, native" —
    // which is exactly the choice a picture answers instantly and prose does
    // not. The agent cannot guess these paths: each emoji set names its files
    // differently (1f642.png / 1F642.svg / emoji_u1f642.svg), and a packaged
    // build resolves them somewhere else entirely.
    // Candidate names for the setup call's naming step.
    //
    // Drawn from the app's own curated pool rather than invented on the spot:
    // that list exists BECAUSE names vary in how reliably the bot hears itself
    // addressed, and it is the same pool the panel's name spinner draws from, so
    // the setup call and the spinner offer the same universe of names. Names
    // already in use on this machine are excluded — two bots answering to one
    // name makes MCP routing by name ambiguous.
    if (url.pathname === '/api/name-suggestions' && req.method === 'GET') {
      try {
        const { randomBotName } = require('./bot-names.js');
        const want = Math.min(24, Math.max(1, Number(url.searchParams.get('count')) || 12));
        const taken = [...this.getTakenBotNames()];
        const picks = [];
        // Draw one at a time, adding each to `taken`, so the list has no repeats.
        for (let i = 0; i < want; i++) {
          const n = randomBotName({ taken: [...taken, ...picks] });
          if (!n || picks.includes(n)) continue;
          picks.push(n);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, names: picks }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Font families installed on THIS machine, so the agent can name one exactly
    // for emojiSet's `font:<Family>` form. A guessed name is not an error anyone
    // can see — it silently falls back to the system emoji font.
    if (url.pathname === '/api/fonts' && req.method === 'GET') {
      try {
        const families = await this.onListFonts();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, families }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    if (url.pathname === '/api/visual-assets' && req.method === 'GET') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, ...this.visualAssets() }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
      return;
    }

    // Passthrough to the sync server's whiteboard version history (#380).
    // The history lives on the website (Redis list `whiteboard:{roomId}:history`,
    // up to 50 prior versions, newest first). This keeps the MCP server talking
    // only to the local server, and routes by the same website base URL + room
    // code the rest of whiteboard sync uses. NOTE: the upstream endpoint takes
    // the ROOM CODE (e.g. ded-iika-yrs), not any call id.
    if (url.pathname === '/api/whiteboard-history' && req.method === 'GET') {
      const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const room = url.searchParams.get('room') || this.roomId;
      if (!room) {
        json({ success: false, error: 'no-room' });
        return;
      }
      const base = (this.getWebsiteUrl() || '').replace(/\/$/, '');
      if (!base) {
        json({ success: false, error: 'no-sync-server' });
        return;
      }
      try {
        const qs = new URLSearchParams();
        for (const k of ['offset', 'limit']) {
          const v = url.searchParams.get(k);
          if (v != null) qs.set(k, v);
        }
        const resp = await fetch(
          `${base}/api/room/${encodeURIComponent(room)}/whiteboard-history${qs.size ? `?${qs}` : ''}`,
          { signal: AbortSignal.timeout(5000) }
        );
        const data = await resp.json().catch(() => null);
        if (!resp.ok || !data?.success) {
          json({ success: false, error: data?.error || `sync server ${resp.status}` });
          return;
        }
        json({
          success: true,
          roomId: room,
          entries: data.entries || [],
          total: data.total ?? (data.entries || []).length,
          hasMore: !!data.hasMore,
        });
      } catch (err) {
        json({ success: false, error: `sync server unreachable: ${err.message}` });
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

    // Capture the bot's own shared screen (the whiteboard window it's presenting).
    if (url.pathname === '/api/shared-screenshot' && req.method === 'POST') {
      try {
        const result = await this.onCaptureSharedScreenshot({ roomId: this.roomId });
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
      // Two shapes: {key, value} for a single setting, or {updates: [{key,
      // value}, …]} to change several as ONE operation.
      //
      // The batch exists because some settings are only meaningful together.
      // A voice is a provider PLUS that provider's identifier (see the voice
      // block in preferences-schema.js); applied as separate requests, a
      // failure between them leaves the bot on ElevenLabs pointing at a macOS
      // voice name — a state that can't speak. So every update is validated
      // BEFORE any is written, and a bad one rejects the whole set.
      const batch = Array.isArray(parsed?.updates)
        ? parsed.updates
        : [{ key: parsed?.key, value: parsed?.value }];
      if (batch.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No updates provided' }));
        return;
      }

      const validated = [];
      for (const upd of batch) {
        const result = prefsSchema.validate(upd?.key, upd?.value);
        if (!result.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error, key: upd?.key }));
          return;
        }
        validated.push({ key: upd.key, value: result.value });
      }

      // Writes first, then the live-apply hooks. Persisting is the part that
      // must not be lost; applyPref only mirrors it into the running app, and
      // ordering it second means a throwing hook can't leave a change applied
      // but unsaved (which is exactly the bug this endpoint is fixing).
      const applied = [];
      try {
        for (const { key, value } of validated) {
          this.setPref(key, value);
          applied.push(key);
        }
        for (const { key, value } of validated) this.applyPref(key, value);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message, applied }));
        return;
      }

      const requiresRestart = validated.some(
        ({ key }) => !!prefsSchema.PREFERENCES[key]?.requiresRestart,
      );
      // #430: a setting can persist, report success, and still do nothing
      // because it depends on another that is unset. Computed AFTER the write,
      // so a batch that sets both halves together reports neither as inert.
      const warnings = validated
        .map(({ key, value }) => prefsSchema.inertWarning(key, value, (k) => this._pref(k)))
        .filter(Boolean);
      if (warnings.length) {
        for (const w of warnings) console.log(ts(), '⚠️  [preferences]', w);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        // Single-key callers still get the flat {key, value} they always did.
        ...(validated.length === 1
          ? { key: validated[0].key, value: validated[0].value }
          : { updated: validated }),
        requiresRestart,
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      }));
      return;
    }

    if (!pathMatch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    const roomId = pathMatch[1];

    // Accept requests for any room ID — set it as active if we don't have one.
    //
    // Through setRoom, NOT a bare assignment. setRoom is what CREATES the
    // per-room state (whiteboard, transcripts, turns); assigning roomId alone
    // left this.roomId truthy while this.whiteboard stayed undefined, so the
    // first whiteboard write on an adopted room died with "Cannot set
    // properties of undefined (setting 'content')" and any snapshot built for
    // that room died reading it. Reproduced on 0.8.0-beta1 and -beta2: a
    // whiteboard POST to a room the app hasn't otherwise been told about.
    //
    // Adoption only happens when there is no room yet, so there is no state to
    // lose by initialising it here.
    //
    // #105: capture room + status BEFORE adopting. setRoom also does
    // setCallStatus('navigating'), so after this line both values look exactly
    // like an in-progress join — and the rejoin guard downstream reads them to
    // decide whether a join is a duplicate. Left to read live state, the very
    // first /join-call after launch matches its OWN adoption and gets dropped.
    // The guard needs the state as it was before this request touched it.
    const preAdoption = { roomId: this.roomId, callStatus: this.callStatus };
    if (!this.roomId) {
      this.setRoom(roomId);
    }

    if (req.method === 'GET') {
      await this._handleGet(req, res, url, roomId);
    } else if (req.method === 'POST') {
      await this._handlePost(req, res, roomId, preAdoption);
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
    if (this.botState === 'thinking' || this.botState === 'ticking') {
      this._setBotState('listening', undefined, { force: true });
    }

    // Check if there are already entries that satisfy the silence condition —
    // speech that finished while the agent was away composing or running tools.
    //
    // Measure the gap from the speaker's LAST WORD, not their first. `timestamp`
    // is firstSeen (when the turn started); a turn that is still growing keeps
    // its firstSeen and advances `lastUpdated`. Using timestamp here meant any
    // utterance longer than the silence bar returned INSTANTLY, mid-sentence,
    // handing the agent a half-finished caption — the "it processed my speech
    // while I was still talking" bug. Entries are sorted by firstSeen, so the
    // freshest one isn't necessarily last; take the max explicitly.
    const existing = this._entriesSince(since, bot);
    if (existing.length > 0 && !this.anyoneSpeaking) {
      const quietMs = this._quietMsSince(existing);
      if (quietMs >= clampedSilence * 1000) {
        // This path returns without ever creating a waiter, so none of the
        // [resolve] lines fire. Its silence made a delivered turn look lost.
        console.log(ts(), '⚡ [resolve] wait_for_speech returned immediately — ' + existing.length +
          ' entr' + (existing.length === 1 ? 'y' : 'ies') + ' already past the silence bar (' +
          Math.round(quietMs) + 'ms quiet ≥ ' + Math.round(clampedSilence * 1000) + 'ms), no waiter registered');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this._buildResponse(since, bot, Date.now())));
        return;
      }
      console.log(ts(), '⏳ [resolve] undelivered speech is only ' + Math.round(quietMs) +
        'ms old (< ' + Math.round(clampedSilence * 1000) + 'ms) — waiting for the speaker to finish');
    } else if (existing.length > 0) {
      console.log(ts(), '⏳ [resolve] ' + existing.length + ' undelivered entr' +
        (existing.length === 1 ? 'y' : 'ies') + ', but someone is speaking right now — waiting');
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
      // A killed agent closes its TCP connection immediately, so this is a FACT
      // rather than a guess from elapsed silence — and it is the common case,
      // since an agent in the conversation loop spends most of its life parked
      // in this poll. Without it, killing an agent mid-wait takes the full
      // timeout to notice; with it, the face changes within a poll tick.
      //
      // Guarded on waiter.resolved because 'close' also fires on the normal
      // response, which is not a disconnect.
      req.on('close', () => {
        if (waiter.resolved) return;
        waiter.resolved = true;
        clearTimeout(waiter.timer);
        clearTimeout(waiter.silenceTimer);
        clearTimeout(waiter.tickTimer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.agentSocketLost = true;
        this.agentSocketLostAt = Date.now();
        console.log(ts(), '\u{1F50C} [agent] wait_for_speech socket closed before resolving — agent went away');
        resolve({ success: true, aborted: true, asOf: new Date().toISOString(), transcript: { entries: [] } });
      });
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

  async _handlePost(req, res, roomId, preAdoption = null) {
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
      results.transcript = await this._applyTranscriptPayload(data, roomId, now);
    }

    // Handle whiteboard update
    if (data.whiteboard && typeof data.whiteboard.content === 'string') {
      this.whiteboard.content = data.whiteboard.content;
      this.whiteboard.version++;
      this.whiteboard.lastModified = now;
      this.whiteboard.lastEditor = data.sender;
      // Await the push and report what it actually did (#221).
      //
      // This used to set ok:true from mutating local memory alone and fire the
      // push off unwatched, so a bot got a success — and a plausible incrementing
      // version number — for content that never reached the board anyone was
      // looking at. On the call this was invisible: the bot had no reason to
      // retry, mention it, or fall back to chat. It believed it had presented.
      //
      // `delivered` is tri-state on purpose: true = the shared board has it,
      // false = it does not and here is why, null = there is no room, so there
      // is no shared board to miss.
      const push = await this.onWhiteboardUpdate(data.whiteboard.content, data.sender);
      const delivered = push?.delivered ?? null;
      // A successful write to an unreadable board is still a board nobody sees,
      // so `readable: false` rides alongside `delivered` rather than replacing
      // it — the two failures are independent and the bot needs to tell them
      // apart ("it didn't save" vs "it saved and nobody can see it").
      const readable = this.boardReadHealthy !== false;
      results.whiteboard = {
        ok: delivered !== false,
        delivered,
        readable,
        version: this.whiteboard.version,
        lastModified: now,
        lastEditor: data.sender,
        ...(delivered === false ? { error: push.error } : {}),
      };
    }

    // Custom whiteboard styling (#321): relay CSS to the remote sync so the
    // whiteboard window (which renders from the remote) picks it up.
    if (typeof data.whiteboardStyle === 'string') {
      this.whiteboardCss = data.whiteboardStyle;
      results.whiteboardStyle = { ok: true };
      this.onWhiteboardStyle(data.whiteboardStyle, data.sender);
    }

    // Explicit whiteboard reload (#321 follow-up): re-fetch the shared board's
    // content + style without changing content. Used by the reload_share
    // tool when the bot wants to force a refresh.
    if (data.reloadWhiteboard === true) {
      results.reloadWhiteboard = this.onReloadWhiteboard() || { ok: true };
    }

    // Handle join command — tell the app to join a Meet call
    if (data.meta?.action === 'join') {
      const meetCode = data.meta.meetCode || roomId;
      const botName = data.meta.botName;

      // #26: a second join for the room we are ALREADY in is almost always an
      // agent retrying after a transient error, not realising the first join
      // succeeded. Honouring it destroyed the working session: loadMeetURL
      // tears down and recreates the Meet view, and the reload then sticks
      // forever on Meet's "Getting ready…" screen — no join button ever
      // renders. The agent finally sees "the bot couldn't enter the Meet
      // (denied or removed)", which blames Meet for something we did.
      //
      // So treat it as the no-op it should have been. A join for a DIFFERENT
      // room still switches calls, and force:true still rebuilds the session
      // for the case where it really is wedged.
      //
      // #105: read the PRE-adoption room/status, not the live ones. Adopting an
      // unknown room (handleRequest) calls setRoom, which sets callStatus to
      // 'navigating' — so by the time we get here a first-ever join has already
      // written the exact state this guard treats as "a join is in flight", and
      // would ignore itself. preAdoption is what was true before this request.
      const guardState = preAdoption || { roomId: this.roomId, callStatus: this.callStatus };
      if (shouldIgnoreRejoin({
        requestedRoom: meetCode,
        currentRoom: guardState.roomId,
        callStatus: guardState.callStatus,
        force: data.meta.force,
      })) {
        console.log('[local-server] Join ignored — already', guardState.callStatus, 'in', meetCode);
        results.join = {
          ok: true,
          alreadyInCall: true,
          status: this.callStatus,
          botName: this.getEffectiveBotName() || null,
        };
      }
      // #222: refuse to join under a name that's already in the call — two
      // same-named bots are indistinguishable in the Meet roster, the
      // transcript, and bot-to-bot addressivity. Skip the check when
      // rejoining under a name this session already used (our own presence
      // entry may not have expired), and allow meta.force to override.
      if (!results.join && botName && !data.meta.force && botName !== this._everJoinedAs) {
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
      // Let the goodbye actually be heard. speak() returns once the text is
      // QUEUED, so an agent that says "Bye!" and immediately calls leave_call
      // otherwise hangs up over its own voice.
      const drain = await this.waitForSpeechDrain();
      // Captured BEFORE onLeaveCall, which is what starts the phase — after it
      // the agent-liveness read could race with teardown.
      const plan = this.afterCallWorkPlan();
      this.onLeaveCall();
      results.leave = { ok: true, afterCallWork: plan, ...(drain.waited ? { waitedForSpeechMs: drain.waited, speechDrained: drain.drained } : {}) };
    }

    // The agent says its after-call work is done. Ends the phase early rather
    // than burning the whole backstop, which is the difference between a bot
    // that wraps up in 20s and one that ties up a terminal for 5 minutes.
    if (data.meta?.action === 'end-session') {
      const wasActive = this.callStatus === 'after-call-work';
      if (wasActive) this.onEndSession();
      results.endSession = { ok: true, wasActive };
    }

    // Handle share/stop whiteboard commands
    if (data.meta?.action === 'share-tab') { // POC (share-agent-tab)
      this.onShareTab(data.meta.url, data.meta.appName);
      results.shareTab = { ok: true };
    }
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
      // uninterruptible: for replay rigs only (#422). Ordinary play_audio stays
      // interruptible — a human talking over a sound effect should still stop it.
      this._uninterruptiblePlayback = data.meta.uninterruptible === true;
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

    // Handle set-share-audio — silence/restore the shared surface's sound
    // mid-share, without stopping and restarting the share.
    if (data.meta?.action === 'set-share-title-bar') {
      results.setShareTitleBar = await this.onSetShareTitleBar({ visible: data.meta.visible });
    }

    if (data.meta?.action === 'set-share-size') {
      results.setShareSize = await this.onSetShareSize({ width: data.meta.width, height: data.meta.height });
    }

    // Drive the shared board: click and type into whatever it is showing.
    if (data.meta?.action === 'share-click') {
      results.shareClick = await this.onShareClick({
        selector: data.meta.selector, x: data.meta.x, y: data.meta.y,
        button: data.meta.button, clickCount: data.meta.clickCount,
      });
    }

    if (data.meta?.action === 'share-type') {
      results.shareType = await this.onShareType({
        text: data.meta.text, key: data.meta.key,
        modifiers: data.meta.modifiers, selector: data.meta.selector,
      });
    }

    if (data.meta?.action === 'set-share-audio') {
      results.setShareAudio = await this.onSetShareAudio({ muted: data.meta.muted });
    }

    // The caption language the bot LISTENS in. Not cosmetic: the bot reads the
    // room through Meet's caption region, so the wrong language means it hears
    // nonsense and answers it.
    if (data.meta?.action === 'set-caption-language') {
      results.setCaptionLanguage = await this.onSetCaptionLanguage({ language: data.meta.language });
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

    // Sandboxed JS eval against the share surface (#244).
    if (data.meta?.action === 'eval-share') {
      results.evalShare = await this.onEvalShare({ expression: data.meta.expression });
    }

    // Locate an element on the share surface by description (#244).
    if (data.meta?.action === 'find-share-element') {
      results.findShareElement = await this.onFindShareElement({
        description: data.meta.description,
        max_results: data.meta.maxResults,
      });
    }

    // Read the share surface's buffered console messages (#244).
    if (data.meta?.action === 'read-share-console') {
      results.readShareConsole = await this.onReadShareConsole({ limit: data.meta.limit });
    }

    // Read the share surface's buffered network requests (#244).
    if (data.meta?.action === 'read-share-network') {
      results.readShareNetwork = await this.onReadShareNetwork({ limit: data.meta.limit });
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

  // Every name a registered bot member could show up under in the call.
  // Members carry BOTH a registration name and a Meet display name, and they
  // routinely differ ("Jimmy" registers, the tile reads "jimmy bot"). Keying
  // this set on `name` alone meant a bot interrupter never matched, so the
  // barge-in check fell through to its "unknown ⇒ human" default and yielded
  // to other bots as if they were people. Index both.
  // Fold the website's room presence into the local roster. Called from the
  // sync poll, which already fetches it.
  //
  // Remote entries are merged, never allowed to delete: presence expires on its
  // own schedule and a bot that has gone quiet for a moment must not vanish from
  // the roster mid-utterance, which is exactly when the barge-in check needs it.
  // A remote role of 'bot' upgrades a local 'member' — bots register themselves,
  // so that claim is theirs to make — but the reverse is not true, or a stale
  // 'member' row for a bot's Meet display name (the sync server holds both) would
  // demote it back to human and reinstate the very bug this fixes.
  mergeRemoteMembers(members) {
    if (!Array.isArray(members)) return;
    let learned = 0;
    for (const m of members) {
      if (!m || !m.name) continue;
      const existing = this.members.find((x) => x.name === m.name);
      const wasBot = existing && existing.role === 'bot';
      const role = m.role === 'bot' || wasBot ? 'bot' : (existing?.role || m.role || 'member');
      this._upsertMember(m.name, role, m.ownerName, m.displayName, m.versions);
      if (role === 'bot' && !wasBot) learned++;
    }
    if (learned) {
      console.log(ts(), `👥 [presence] roster now knows ${this._botNameSet().size} bot name(s) from room presence`);
    }
  }

  _botNameSet() {
    const names = new Set();
    for (const m of this.members || []) {
      if (m.role !== 'bot') continue;
      if (m.name) names.add(m.name.toLowerCase());
      if (m.displayName) names.add(m.displayName.toLowerCase());
    }
    return names;
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
// Same channel, for the one module-level helper worth testing on its own: the
// name matching is what the peer discovery stands or falls on (#430).
LocalServer._namesMatch = namesMatch;
