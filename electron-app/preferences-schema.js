// preferences-schema.js — Whitelist of preferences exposed to the agent.
//
// Each entry is a self-contained spec: type, default, description, and
// optional validation. Anything NOT in this map is invisible to the agent
// even if it lives in the same config.json (API keys, auth cookies, etc.).
//
// Adding a new agent-exposed preference: add it here, then read it via
// store.get('key') ?? PREFERENCES.key.default in the consumer.
//
// hiddenInSettingsUI: true keeps a pref out of the App Settings "Advanced"
// section while leaving it fully functional (CLI flags, set_preference, any
// already-persisted value). Use it for plumbing nobody should reach for in
// normal use.

// The name a bot wears when nobody has given it one. Exported so every
// fallback in the app reads THIS rather than repeating a literal — the old
// `store.get('botName') || 'Jimmy'` pattern was copied to six places, and a
// default that lives in six places is a default nobody can change.
const DEFAULT_BOT_NAME = 'Unnamed bot';

const PREFERENCES = {
  comprehendCharThreshold: {
    type: 'number',
    default: 0,
    min: 0,
    description:
      'Two-tier experiment (OFF by default): how many characters of NEW transcript ' +
      'must pile up before the bot refreshes its background working memory ' +
      '(understanding / stance / people) via a local model. 0 disables it (the ' +
      'default) — without this, a bot with no local model running would ping the ' +
      'endpoint every ~500c and fail. Set to e.g. 500 ONLY if you have a local ' +
      '(openai-compat / LM Studio) model configured and want to test the two-tier ' +
      'working memory. Lower = fresher but more local-model calls; the first two ' +
      'refreshes fire sooner (~120c then ~300c) to warm up, then settle to this value.',
  },
  ackShortMin: {
    type: 'number',
    default: 20,
    min: 0,
    description:
      'Word count below which the bot skips the acknowledgment entirely. ' +
      'For very short prompts the thinking emoji is enough feedback.',
  },
  ackLongMin: {
    type: 'number',
    default: 50,
    min: 0,
    description:
      'Word count at or above which the bot uses a longer ack ' +
      '("Let me think about that") instead of a short one.',
  },
  ackShortPhrases: {
    type: 'string[]',
    default: [
      'Mm-hmm.',
      'Mmmm',
      'Ahhh okay',
      'Okay.',
      'Got it.',
      'Mm.',
      'Right.',
      'Yeah.',
      'Sure.',
      'Uh-huh.',
      'Mhm.',
      'Cool.',
      'Gotcha.',
      'Right, right.',
    ],
    minItems: 1,
    description:
      'Phrases the bot picks from for short acks (when wordCount is between ' +
      'ackShortMin and ackLongMin). One is chosen at random per ack.',
  },
  ackLongPhrases: {
    type: 'string[]',
    default: [
      'Let me think about that.',
      'Hmm, let me consider that.',
      'Give me a moment.',
      'One moment',
      'One second, thinking.',
      'Hmm, good question.',
      'Let me chew on that.',
      'Just a sec, processing.',
      'Hmm, interesting.',
      'Hold on, working through that.',
      'Let me work that out.',
    ],
    minItems: 1,
    description:
      'Phrases the bot picks from for long acks (when wordCount >= ackLongMin).',
  },
  // The language the bot LISTENS in — Meet's "Language of the meeting" caption
  // setting, applied automatically when the bot joins a call.
  //
  // Empty means LEAVE MEET ALONE. Deliberately not defaulted to 'en-US': that
  // would make every existing bot start rewriting a Meet account setting it had
  // never touched, on upgrade, for no reason the user asked for. Opt in.
  //
  // This is the bot's hearing, not a display preference — it reads the room
  // through the caption region, so a mismatch means it hears nonsense and
  // answers the nonsense rather than falling silent.
  afterCallWorkSeconds: {
    type: 'number',
    default: 300,
    min: 0,
    max: 1800,
    description:
      "How long the bot's agent may keep working after it leaves a call, in seconds. "
      + 'The call\'s room, transcript and tools all stay available during this window, so the '
      + 'agent can summarise, file notes, or write a receipt before the app tears the call down. '
      + 'What it actually does is in the bot\'s CLAUDE.md, under "After the call". '
      + 'This is a BACKSTOP, not a schedule: an agent that finishes early calls end_session and '
      + 'the app tears down immediately, so the usual cost is seconds, not the whole window. It '
      + 'only runs to the limit when an agent never reports back. Skipped entirely when no agent '
      + 'is driving the bot, since there would be nobody to do the work. Set 0 to turn the phase '
      + 'off and tear down the moment the bot leaves.',
  },
  captionLanguage: {
    type: 'string',
    default: '',
    description:
      "BCP-47 tag for the language the bot listens in, e.g. 'de-DE', 'es-ES', " +
      "'en-GB'. Applied to Meet's \"Language of the meeting\" when the bot joins " +
      'a call. Empty leaves whatever Meet is already set to. Meet has no ' +
      'host-level control for this, so each bot sets its own.',
  },
  botName: {
    type: 'string',
    // Deliberately NOT a plausible name. "Jimmy" was the default for a long
    // time, and it reads as a real, configured bot — so an unconfigured or
    // stray test profile was indistinguishable from someone's actual bot, both
    // on screen and in a Meet participant list. That cost us a live call on
    // 2026-07-29: a leftover test instance answered to "Jimmy", joined the
    // call, and the agent drove the wrong one. A name nobody would choose makes
    // the mistake obvious the moment it shows up anywhere.
    default: DEFAULT_BOT_NAME,
    description:
      "The bot's display name in Meet calls. Takes effect on the next call.",
    requiresRestart: true,
  },
  logRawCaptions: {
    type: 'boolean',
    default: false,
    description:
      'Debug/data-collection: log the raw in-flight caption progression ' +
      '([caption-raw]) — every partial as Meet captions grow, marked LIVE vs ' +
      'settled. The messy data needed to test utterance-completeness detection ' +
      '(#243). Verbose; turn ON only when collecting test data, OFF for normal use.',
  },
  recordCallAudio: {
    type: 'boolean',
    default: false,
    hiddenInSettingsUI: true,
    description:
      'Debug: record the call\'s audio to disk, one file per track — the bot\'s ' +
      'own outgoing audio plus each remote WebRTC track Meet delivers — with a ' +
      'manifest that time-aligns them. Built to diagnose "heard-nothing" stalls: ' +
      'it captures what each mic actually carried, to compare against captions. ' +
      'Meet gives each remote participant its own track (measured), so "remote-*" ' +
      'tracks are per-participant — labeled by arrival order, not name. OFF by ' +
      'default; verbose on disk. Env VIBECONF_RECORD_CALL=1 ' +
      'forces it on (used by the test fleet so a nightly stall comes with audio).',
  },
  studioSound: {
    type: 'boolean',
    default: true,
    description:
      'Meet\'s "Studio sound" voice filter (noise cancellation + voice-activity ' +
      'detection). ON (default) = Meet\'s normal behavior, best for the bot\'s ' +
      'spoken voice but it SUPPRESSES non-voice audio. Set FALSE to have the bot ' +
      'turn Studio sound OFF once in-call (More options → Settings → Audio), so ' +
      'sound effects / music played via play_audio pass through the mic. Costs a ' +
      'bit of voice enhancement. Availability depends on the Meet account tier.',
  },
  focusCallTabOnJoin: {
    type: 'boolean',
    default: true,
    description:
      'After the bot joins a call, bring the user\'s browser tab hosting that ' +
      'call to the front (Chrome/Brave/Safari), so they land on the call — from ' +
      'either the Join button or /join-call in the CLI. Provider-agnostic (Meet, ' +
      'Slack huddles; Zoom/Teams later). Best-effort: a silent no-op if there is ' +
      'no such tab. Set FALSE to stop the app stealing window focus on join.',
  },
  triageAck: {
    type: 'boolean',
    default: false,
    description:
      'Use the on-device fast model (Apple triage) to decide whether the bot is ' +
      'being addressed THIS turn, and if so fire an instant ack filler to cover the ' +
      "slow model's response latency (#243/#245). OFF (default) = the simpler " +
      'regex-addressivity ack path. ON = smarter ack gating via triage.js against ' +
      'the ackEndpoint (Apple on-device by default), with the background-maintained ' +
      'engagement state fed in so a bare "you" resolves to this bot mid-exchange. ' +
      'Independent of ackProvider, which only chooses the ack PHRASE source. ' +
      '(Formerly named shadowPhrase — that pref gated the now-removed two-tier ' +
      'shadow drafter; it was repurposed to gate the triage-ack.)',
  },
  botPersonality: {
    type: 'string',
    default: '',
    maxLength: 2000,
    description:
      "Two-tier experiment: the voice/character the fast model speaks in (e.g. " +
      "'dry, concise, a bit wry; never corporate'). Used by the shadow harness " +
      "now (drafting what the bot would say) and by the fast model once it " +
      "becomes the bot's voice. Empty = a neutral, conversational default.",
  },
  // ── The bot's voice ───────────────────────────────────────────────────────
  // One choice, four keys, because the three TTS providers don't share an
  // identifier space: an OS voice is a NAME ("Ava (Premium)"), ElevenLabs is an
  // opaque ID, and Voicebox needs a profile id PLUS the engine that renders it.
  // So the stored form is "which provider" + "that provider's identifier".
  //
  // They live here rather than in some private corner because set_voice has to
  // be able to write them through /api/preferences like every other setting —
  // when they weren't preferences, the MCP server grew its own config file to
  // hold them and the two copies silently diverged. Prefer set_voice
  // over setting any of these by hand: it resolves a name across all three
  // providers and writes the whole set consistently.
  ttsProvider: {
    type: 'string',
    default: '',
    enum: ['', 'elevenlabs', 'macos-say', 'voicebox'],
    description:
      'Which text-to-speech engine renders the bot\'s voice. Empty = pick automatically ' +
      '(ElevenLabs when a key is set, otherwise the built-in OS voice). Set indirectly ' +
      'by set_voice, which forces the provider that owns the voice you chose.',
  },
  ttsVoiceId: {
    type: 'string',
    default: '',
    description:
      'ElevenLabs voice ID, used when ttsProvider is "elevenlabs". ' +
      'Use list_voices and set_voice for an in-call switch instead of editing this directly.',
  },
  macosVoice: {
    type: 'string',
    default: '',
    description:
      'Built-in OS voice NAME, used when ttsProvider is "macos-say" — a macOS `say` voice ' +
      '("Ava (Premium)") or, on Windows, a SAPI voice ("Microsoft Zira Desktop"). The key ' +
      'is named for macOS for config compatibility; it holds the Windows voice too. ' +
      'Use list_voices and set_voice rather than editing this directly.',
  },
  voiceboxProfileId: {
    type: 'string',
    default: '',
    description:
      'Voicebox local-TTS profile id, used when ttsProvider is "voicebox". ' +
      'Use list_voices and set_voice rather than editing this directly.',
  },
  voiceboxEngine: {
    type: 'string',
    default: '',
    description:
      'Which engine renders the Voicebox profile (e.g. "kokoro"). Set alongside ' +
      'voiceboxProfileId by set_voice; a profile id without its engine will not speak.',
  },
  avatarBackgroundSvg: {
    type: 'string',
    default: '',
    maxLength: 1_000_000,
    description:
      "SVG source for the avatar background. Empty = default animated gradient. " +
      "The camera is 16:9 (1280x720), so author LANDSCAPE — e.g. " +
      "viewBox=\"0 0 1280 720\". The image is cover-fitted (scaled to fill, " +
      "aspect preserved, overflow center-cropped), so a square SVG is not " +
      "distorted but its top and bottom WILL be cropped — keep anything " +
      "important near the vertical center. " +
      "The SVG can include <image href='file:///...' or 'https://...'> — the app " +
      "auto-resolves external references into data URIs so you don't need to " +
      "base64-encode anything. SVG/CSS animations don't tick (rasterized once); " +
      "the emoji's bounce provides motion. Use to display backgrounds, name plates, " +
      "debug info, or anything SVG can render.",
  },
  avatarBackgroundCaption: {
    type: 'string',
    default: '',
    description:
      "Optional human-readable label for your current avatar background (e.g. " +
      "'Berlin skyline at dusk'). Purely for recall — set it alongside " +
      "avatarBackgroundSvg so you (or a future context after a reset) can answer " +
      "'what's my background?' without parsing raw SVG. Surfaced in get_room_info; " +
      "not rendered.",
  },
  emojiSet: {
    type: 'string',
    default: 'fluent3d',
    enum: ['native', 'twemoji', 'openmoji', 'noto', 'fluent3d'],
    description:
      'Which emoji graphics the avatar\'s face uses. "native" = the OS emoji font. ' +
      '"twemoji" = Twitter Twemoji (flat). "openmoji" = OpenMoji (outlined). "noto" = ' +
      'Google Noto Emoji. "fluent3d" = Microsoft Fluent 3D (a curated face set — ' +
      'hand/person emojis fall back to native). All bundled in the app — no network. ' +
      'Any emoji not in the chosen set falls back to the native glyph. Reskin the ' +
      'bot\'s face (#316).',
  },
  agentBackend: {
    type: 'string',
    default: 'claude',
    enum: ['claude', 'codex', 'other'],
    // Optional presentation hints, honoured by the schema-driven App Settings
    // renderer. Without them a select shows the raw key and raw enum values,
    // which here would present three neutral peers — and they are not peers:
    // one is automated, one is experimental, one is bring-your-own.
    label: 'Agent backend',
    enumLabels: {
      claude: 'Claude Code (recommended)',
      codex: 'OpenAI Codex (experimental, manual setup)',
      other: 'Other MCP client (LM Studio, custom)',
    },
    description:
      'Which agent drives the bots on THIS MACHINE. App-level, not per-bot: which ' +
      'CLI is installed is a property of the machine, and every bot on it is driven ' +
      'by the same one. "claude" = Claude Code, the path the app automates (it writes ' +
      'the MCP config, opens the Terminal, and checks sign-in). "codex" = OpenAI Codex ' +
      'CLI — experimental, and set up by hand per docs/codex.md. "other" = anything ' +
      'else that speaks MCP (LM Studio, a hand-rolled client, an agent on ' +
      'another machine) — the app gives you the connection details and stays out of ' +
      'the way. ' +
      'Only "claude" makes the app responsible for launching the agent, so it is the ' +
      'only value that warns about Claude Code being missing or signed out (#137).',
  },
  remoteLogging: {
    type: 'boolean',
    default: true,
    description:
      'Ship this app\'s session log to the backend so it can be read remotely ' +
      'via get_session_log (instance:…) or the logs CLI — useful for debugging ' +
      'another machine\'s bots without terminal access. ON by default during ' +
      'early testing (the team relies on these call logs for optimizing/debugging); ' +
      'the log may contain transcript text. Set false to keep logs local. ' +
      'Takes effect immediately (no restart).',
  },
  websiteUrl: {
    type: 'string',
    default: '',
    pattern: /^(|https?:\/\/.+)$/,
    description:
      'Override the website host the app talks to (auth, sync, room URLs). ' +
      'Empty = use the production default (https://vibeconferencing.com). ' +
      'Set to a Vercel preview like https://vibeconferencing-git-BRANCH-lets-vibe.vercel.app ' +
      'to test against a feature branch. Takes precedence over syncBaseUrl. ' +
      'Must be a full http:// or https:// URL with no trailing slash. ' +
      'APP-LEVEL (#366): shared by all profiles on this machine.',
    requiresRestart: true,
    hiddenInSettingsUI: true,
  },
  syncBaseUrl: {
    type: 'string',
    default: '',
    pattern: /^(|https?:\/\/.+)$/,
    description:
      'Legacy override for the sync/website host. Prefer websiteUrl for new setups. ' +
      'Empty = no override. Acts as a fallback websiteUrl when websiteUrl is unset. ' +
      'Must be a full http:// or https:// URL with no trailing slash. ' +
      'APP-LEVEL (#366): shared by all profiles on this machine.',
    requiresRestart: true,
    hiddenInSettingsUI: true,
  },

  // ── Conversation timing knobs ────────────────────────────────────────────
  // All read live from the local-server via the getPref callback — set_preference
  // takes effect on the next time the value is consulted (no app restart).
  // Per-profile, so different bot personas can have different conversational
  // rhythms.

  bargeInGraceMs: {
    type: 'number',
    default: 2500,
    min: 0,
    max: 10_000,
    description:
      'How long the bot waits after detecting a human interruption before ' +
      'actually stopping its TTS. Tunes the bot\'s "patience" — higher means ' +
      'a brief overlap (a cough, a "yeah" backchannel, a false start) is ridden ' +
      'out as natural conversation; lower means the bot drops out almost ' +
      'instantly. Read live, so it can be tuned mid-call (per profile). Used as ' +
      'the FIXED grace when bargeInUrgencyScaling is off; when scaling is on this ' +
      'is ignored in favor of the min/max range below. Default 2500ms.',
  },
  bargeInUrgencyScaling: {
    type: 'boolean',
    default: true,
    description:
      'Scale the barge-in grace (and how tolerant the resume is of interruption ' +
      'words) by the URGENCY the bot self-scored for the utterance it is currently ' +
      'speaking. A house-on-fire reply (urgency≈1) holds the floor for the full ' +
      'bargeInGraceMaxMs; pure filler (urgency≈0) cedes it almost instantly at ' +
      'bargeInGraceMinMs. Unscored utterances default to the midpoint. Experimental ' +
      '(#367) — urgency calibration is still being collected; toggle off mid-call ' +
      'if it feels wrong.',
  },
  bargeInGraceMinMs: {
    type: 'number',
    default: 700,
    min: 0,
    max: 10_000,
    description:
      'When bargeInUrgencyScaling is on: the grace for a zero-urgency (filler) ' +
      'utterance — the bot yields the floor almost immediately. Default 700ms.',
  },
  bargeInGraceMaxMs: {
    type: 'number',
    default: 1500,
    min: 0,
    max: 10_000,
    description:
      'When bargeInUrgencyScaling is on: the grace for a max-urgency utterance — ' +
      'the bot fights hardest to be heard. Default 1500ms — was 3500ms, lowered ' +
      'in #138: the agent self-scored u≈0.90 on essentially every utterance that ' +
      'call, so the scaling sat pinned near its ceiling and bought ~2.9s of ' +
      'talking over a human, which is what "you\'re not stopping when we start ' +
      'speaking" felt like from the room. With the min at 700ms the whole range ' +
      'is now inside human turn-taking latency; raise it again if the urgency ' +
      'distribution ever spreads out enough for the ceiling to mean something.',
  },
  workingStateMinMs: {
    type: 'number',
    default: 2500,
    min: 0,
    max: 30_000,
    description:
      'How long the agent must be continuously working before the avatar escalates ' +
      'from 🤔 thinking to 🧑‍💻 working (#339). Prevents a flicker on quick turns — the ' +
      'speak call is itself a tool, so without a dwell every reply would flash 🧑‍💻. ' +
      'Higher = 🧑‍💻 only for genuinely heads-down work; 0 = show it on the first tool. ' +
      'Read live.',
  },
  workingStateQuietMs: {
    type: 'number',
    default: 8000,
    min: 1000,
    max: 60_000,
    description:
      'How long after the last agent activity before the 🧑‍💻/🤔 face eases back to ' +
      'listening/idle (#339). Held through a pending turn regardless. Read live.',
  },
  bargeInAckExempt: {
    type: 'boolean',
    default: true,
    description:
      'When on, the bot\'s OPENING ACK (its first short reply to a turn) and very ' +
      'short backchannels are EXEMPT from the barge-in drop — they play even if a ' +
      'human is still talking. Keeps the room from thinking the bot went silent while ' +
      'it does slow tool work (root cause of the #335 double-response). Turn OFF if it ' +
      'feels like the bot talks over people. Read live — tunable mid-call. Length caps: ' +
      'bargeInAckMaxWords / bargeInBackchannelMaxWords.',
  },
  bargeInAckMaxWords: {
    type: 'number',
    default: 12,
    min: 0,
    max: 200,
    description:
      'Max words for the OPENING ACK to stay barge-in-exempt (see bargeInAckExempt). ' +
      'Protects a real ack ("Sure — putting that together now.") while letting anything ' +
      'longer yield to a human. An exempt utterance plays OVER a live speaker, so this ' +
      'cap is the sole thing standing between "the bot signalled it heard me" and "the ' +
      'bot talked over me". 40 -> 30 (#67) -> 12 (#109): on the Jul 28 call all 14 ' +
      'exemptions came through this path at a median of 18 words — full sentences, not ' +
      'acks — while the code above it claims "substantive mid-turn responses are NOT ' +
      'exempt". 12 is about where an ack stops being an ack. Read live.',
  },
  botViewMode: {
    type: 'string',
    enum: ['hidden', 'thumbnail'],
    default: 'hidden',
    requiresRestart: true,
    description:
      "Where the bot's Meet view rests when it isn't popped out. 'hidden' (default) " +
      'keeps it in a window that is never shown, at 1600x900 and zoom 1, so ' +
      'get_call_screenshot captures ~3200x1800 and the bot can actually READ a ' +
      "participant's shared screen. 'thumbnail' is the legacy narrow-column preview: " +
      'it looks nicer but squeezes Meet to ~380px, and since capturePage() bakes the ' +
      'zoom in, that shrunken image IS what the bot sees — on the Jul 28 call a shared ' +
      'terminal arrived at ~3px per line and the bot said so out loud (#103). Either ' +
      "way the pop-out button still works, and that's how you sign the bot into " +
      'Google/Slack/GitHub. Switch to thumbnail if hiding the view ever misbehaves.',
  },
  bargeInAckMinUrgency: {
    type: 'number',
    default: 0.5,
    min: 0,
    max: 1,
    description:
      'Minimum self-scored URGENCY for an utterance to stay barge-in-exempt, i.e. to ' +
      'play OVER a live speaker. Length alone was the gate until #109; urgency was ' +
      'consulted only AFTER speech started (scaling the grace, see ' +
      'bargeInUrgencyScaling), so a low-value interruption not only began but then ' +
      'held the floor longer. On the Jul 28 call every short utterance that actually ' +
      'played over someone scored 0.3-0.4 ("mildly useful"), while every 0.8-0.9 one ' +
      'went out into an open floor and needed no exemption at all — so a 0.5 floor ' +
      'blocks the bad cases at no cost to the good ones. Unscored utterances count as ' +
      '0.5 (the same midpoint convention as the grace scaling), so an agent that never ' +
      'passes urgency keeps its acks. Set 0 to disable the urgency condition. Read live.',
  },
  bargeInBackchannelMaxWords: {
    type: 'number',
    default: 6,
    min: 0,
    max: 50,
    description:
      'Max words for ANY bot utterance to count as a barge-in-exempt backchannel ' +
      '("Got it.", "On it.") — it plays over a human because it is brief. Set 0 to ' +
      'disable backchannel exemption (the opening-ack exemption still applies). Read live.',
  },
  thinkingHoldMs: {
    type: 'number',
    default: 8000,
    min: 0,
    max: 60_000,
    description:
      'How long the avatar may keep showing "thinking" after new speech ' +
      'resolves a wait_for_speech, when the agent re-arms listening without ' +
      'speaking. Long enough to cover the fast-ack decision + ack TTS so the ' +
      '🤔 doesn\'t flicker away mid-acknowledgment; after this the state ' +
      'downgrades to listening so the bot doesn\'t look stuck pondering ' +
      'through silence (#221). Default 8000ms.',
  },
  bargeInBotRandomMinMs: {
    type: 'number',
    default: 1000,
    min: 0,
    max: 10_000,
    description:
      'When two bots try to speak at the same moment, each waits a random ' +
      'delay in [min, max] before committing to its turn — preventing ' +
      'lockstep talking over each other. This is the floor of that range.',
  },
  bargeInBotRandomMaxMs: {
    type: 'number',
    default: 4000,
    min: 0,
    max: 30_000,
    description:
      'Ceiling of the bot-vs-bot random-delay range (see bargeInBotRandomMinMs).',
  },
  bargeInStashMaxAgeMs: {
    type: 'number',
    default: 45_000,
    min: 0,
    max: 120_000,
    description:
      'When the bot yields mid-thought to a human, its queued speech is ' +
      'stashed and auto-replayed on the next silence gap if still fresh. ' +
      'This is how fresh (ms) the stash must be to replay; older than this ' +
      'and the slow model regenerates from scratch. Higher = more "the bot ' +
      'patiently waited and just said its thing"; lower = more "the bot ' +
      're-thinks every gap." Was 10s, which in practice never fired: a live ' +
      'two-person call holds the floor far longer (one call: 13 stashes, 0 ' +
      'replays, holds of 37s/77s/80s). Relevance is guarded by ' +
      'bargeInStashRedeliverMaxNewWords, not by the clock, so the age bar can ' +
      'afford to be generous. Default 45s.',
  },
  bargeInStashRedeliverMaxNewWords: {
    type: 'number',
    default: 15,
    min: 0,
    max: 200,
    description:
      'Content-delta gate on replaying a barge-in stash (#239). When the bot ' +
      'yields mid-thought and the floor reopens, the stashed reply is only ' +
      'auto-replayed if fewer than this many NEW words were spoken by others ' +
      'while it was held — otherwise the conversation has moved on, the stash ' +
      'is discarded, and the slow model re-derives on the caught-up window. ' +
      'This is the "clock-vs-words" companion to bargeInStashMaxAgeMs: age ' +
      'guards wall-clock staleness, this guards topical staleness. Higher = ' +
      'replay even after a lot was said; 0 = only replay if literally nothing ' +
      'new was said. Default 15. Read live.',
  },
  ttsResumeEnabled: {
    type: 'boolean',
    default: true,
    description:
      'When the bot is cut off MID-SPEECH by a barge-in and the floor reopens ' +
      'quickly, resume the interrupted utterance near where it stopped instead ' +
      'of dropping the half-spoken sentence (#350). Audio-level resume (same ' +
      'voice, no re-synthesis). Gated by ttsResumeMaxAgeMs + ' +
      'bargeInStashRedeliverMaxNewWords (only resume if the conversation didn\'t ' +
      'move on). Set false to always drop on interruption. Read live.',
  },
  ttsResumeMaxAgeMs: {
    type: 'number',
    default: 5000,
    min: 0,
    max: 30_000,
    description:
      'How soon (ms) the floor must reopen after a mid-speech interruption for ' +
      'the bot to resume the cut-off utterance (#350). Past this the retained ' +
      'audio is considered stale and dropped (the agent moves on). The ' +
      'wall-clock companion to bargeInStashRedeliverMaxNewWords (topical ' +
      'staleness). Default 5s. Read live.',
  },
  captionDropoutGraceMs: {
    type: 'number',
    default: 2000,
    min: 0,
    max: 30_000,
    description:
      'How long a participant tile can stay active without caption text ' +
      'arriving before the bot decides the captions have dropped out (and ' +
      'surfaces that to the agent as a warning). See issue #187.',
  },
  fastFloorDetection: {
    type: 'boolean',
    default: false,
    description:
      'EXPERIMENTAL (#115). Use the Web Audio analyser to decide whether anyone is ' +
      'speaking, instead of waiting on Meet mic-meter DOM mutations. The DOM path ' +
      'needs 3 mutations in a 1200ms window, so it lands ~400-700ms after speech ' +
      'starts; the analyser already samples every animation frame (~16ms) and is ' +
      'the signal every turn-taking gate actually wants. EITHER signal counts as ' +
      'busy, so the DOM path still covers what the analyser misses. ' +
      'ON while the userbase is test users only, because the experiment needs real ' +
      'call data and nobody runs with a non-default preference. KNOWN RISK: the ' +
      '-55dB threshold is inherited from STT gating (where its own comment says it ' +
      'was "set low for now"), and Meet applies noise suppression + VAD before ' +
      'animating the meter we are replacing — so a raw level check may fire on a ' +
      'fan or a keyboard. The failure is the bot believing someone is ALWAYS ' +
      'talking and never speaking at all, which reads as thinking rather than as a ' +
      'bug. If a bot goes quiet, set this false — it is read live, so it takes ' +
      'effect mid-call. Watch the [floor-levels] and [floor-latency] log lines; ' +
      'they record regardless of this setting.',
  },
  botSpeakJitterMaxMs: {
    type: 'number',
    default: 2000,
    min: 0,
    max: 5000,
    description:
      'When the call has 2+ other participants (so another bot could answer the ' +
      'same prompt in lockstep), the bot waits a random 0-N ms before speaking, to ' +
      'decorrelate simultaneous starts (#230). Raised 800 -> 2000 in #100: the ' +
      'delay only helps if the LOSING bot can SEE the winner before its own turn, ' +
      'and speaking-detection needs ~400-700ms (3 meter mutations in a 1200ms ' +
      'window). Two draws from U(0,N) differ by more than the detection latency ' +
      'with probability (1 - D/N)^2, so N=800 converted into a yield only ~14% of ' +
      'the time — jitter fired 119 times on the Jul 28 call and bots still answered ' +
      'together. N=2000 gets that to ~56%. Solo / single-human calls skip it ' +
      'entirely. 0 disables. Higher = more separation, more lag.',
  },
  botSpeakUrgencyLeadMs: {
    type: 'number',
    default: 900,
    min: 0,
    max: 5000,
    description:
      'How much of the speak delay is decided by URGENCY rather than chance. The ' +
      'bot waits (1 - urgency) x this, PLUS the random jitter above — so a reply ' +
      'the agent scored 0.9 reaches the floor ~700ms before one scored 0.1, by ' +
      'construction rather than by winning a coin flip. Without it two bots with ' +
      'very different things to say are equally likely to go first. Unscored ' +
      'utterances count as 0.5. 0 makes ordering purely random (the pre-#100 ' +
      'behaviour). Read live.',
  },
  defaultSilenceSeconds: {
    type: 'number',
    default: 1.4,
    min: 1,
    max: 30,
    description:
      'Default silence threshold (seconds) for wait_for_speech if the agent ' +
      'doesn\'t pass one. The bot waits this long after a speaker stops ' +
      'before considering their turn complete. Higher = more patient (bot ' +
      'lets users compose longer thoughts); lower = snappier. 1.4 has felt ' +
      'good in live calls; 2.0 was the old default.',
  },
  nameMentionSilenceSeconds: {
    type: 'number',
    default: 1.0,
    min: 0,
    max: 30,
    description:
      'Shorter silence threshold used when the bot is addressed by name AT THE END ' +
      'of an utterance — a hand-off like "…what do you think, Jimmy?" (#343). It then ' +
      'resolves after this much silence instead of the full defaultSilenceSeconds, ' +
      'for a prompter reply. Only applies when the name is at the END (not mid-' +
      'sentence, which would cut the speaker off), and only ever shortens. Kept at ' +
      '1.0 (not lower) so a brief pause right after saying the name — "Hey Jimmy… ' +
      'how are you" — does not trip it. Set >= defaultSilenceSeconds to disable. Read live.',
  },
  defaultMaxWaitForSpeechSec: {
    type: 'number',
    default: 55,
    min: 5,
    max: 300,
    description:
      'Maximum seconds wait_for_speech blocks before returning empty. The ' +
      'agent should re-call after a timeout. Default 55 (just under typical ' +
      'HTTP timeouts). Raise only if you have a reason — long blocks make ' +
      'the agent appear stalled.',
  },
  backgroundTickWords: {
    type: 'number',
    default: 100,
    min: 0,
    max: 1000,
    description:
      'Active-listening experiment (#245), OFF by default (0). When > 0, ' +
      'wait_for_speech surfaces the slow model EARLY — once this many NEW ' +
      'transcript WORDS pile up during conversation the bot is NOT part of — ' +
      'with a "background_tick" result instead of blocking until a definitive ' +
      'silence. Measured as a true DELTA (words since the last tick), so one long ' +
      'monologue ticks once per this-many words rather than every poll. On a tick ' +
      'the slow session updates its understanding / banks a brief active-listening ' +
      'probe and loops WITHOUT speaking; only a real silence resolution lets it ' +
      'speak. This is the mechanism that lets the (otherwise blocked) slow model ' +
      'think during long stretches. Content-based, so it scales with how much was ' +
      'actually said, not wall-clock. 0 = exactly today\'s behavior. Costs ' +
      'continuous slow-model turns — fine on the flat subscription, not metered. ' +
      'Try e.g. 100.',
  },
  ackEndpoint: {
    type: 'string',
    default: 'http://127.0.0.1:11535/v1',
    pattern: /^https?:\/\/.+/,
    description:
      'OpenAI-compatible base URL for the LOCAL fast model used by the ack, ' +
      'background comprehension, triage, and the active-listening completeness ' +
      'gate (#243/#245/#237). Default is the Apple on-device wrapper ' +
      '(http://127.0.0.1:11535/v1). Point at LM Studio ' +
      '(http://127.0.0.1:1234/v1) or any openai-compat server instead if you ' +
      'prefer. Read live — takes effect on the next model call, no restart. ' +
      'Pair with ackModel.',
  },
  ackModel: {
    type: 'string',
    default: 'apple-on-device',
    description:
      'Model name requested from ackEndpoint for the local fast-model consumers ' +
      '(ack / comprehend / triage / completeness gate). Must match a model the ' +
      'endpoint serves — e.g. "apple-on-device" for the Apple wrapper (default), ' +
      '"qwen2.5-7b-instruct-mlx" for LM Studio. Read live; no restart.',
  },
  probeFiring: {
    type: 'boolean',
    default: false,
    description:
      'Active-listening firing gate (#245), OFF by default. When ON, on a brief ' +
      'quiet (probeSilenceMs — shorter than the full turn-silence gate) the bot ' +
      'runs the Apple completeness judge on the last utterance; if it\'s a genuine ' +
      'opening AND the bot isn\'t directly named, it fires a SHORT interjection — ' +
      'the freshest banked probe (bank_probe, deposited by the slow model on ' +
      'background ticks) or a probeGenericPhrases fallback. This is the "active ' +
      'listening" behavior: cheap probes that fill gaps and buy the slow model ' +
      'time. Requires at least TWO other participants: a probe fills a gap in a ' +
      'conversation between others, and with only one counterpart every turn is ' +
      'aimed at the bot, so a probe just stacks a filler in front of the ack and ' +
      'the real reply. Uses the ackEndpoint/ackModel gate when reachable, and a ' +
      'conservative lexical gate (completeness.heuristicComplete) when it is not.',
  },
  probeSilenceMs: {
    type: 'number',
    default: 700,
    min: 200,
    max: 5000,
    description:
      'How briefly the room must go quiet before the active-listening firing gate ' +
      '(probeFiring) considers an opening. Deliberately shorter than the full ' +
      'wait_for_speech silence gate (defaultSilenceSeconds) so a probe lands in ' +
      'the gap before a real turn would resolve. Default 700ms.',
  },
  probeMinIntervalMs: {
    type: 'number',
    default: 25000,
    min: 0,
    max: 600000,
    description:
      'Rate limit for active-listening probes: minimum ms between fired probes, ' +
      'so the bot doesn\'t get needy/chatty. Over-done active listening is worse ' +
      'than silence. Default 25s.',
  },
  probeMaxAgeMs: {
    type: 'number',
    default: 30000,
    min: 0,
    max: 600000,
    description:
      'Freshness window for a banked probe. Probes deposited by the slow model ' +
      'older than this are discarded at fire time (the conversation has moved on) ' +
      'and the bot falls back to a generic. Default 30s.',
  },
  probeGenericPhrases: {
    type: 'string[]',
    default: ['Interesting.', 'Mm, right.', 'Go on.', 'Huh.', 'Makes sense.', 'Hmm.'],
    minItems: 1,
    description:
      'Fallback active-listening interjections fired when the probe bank is empty ' +
      'or stale. Kept deliberately short and content-free so they\'re never wrong. ' +
      'One is chosen at random.',
  },
  backgroundTickJitterFrac: {
    type: 'number',
    default: 0.3,
    min: 0,
    max: 2,
    description:
      'Anti-lockstep jitter for backgroundTickWords (#245/#230). Each time the ' +
      'bot re-arms a background tick it rolls its effective threshold to ' +
      'backgroundTickWords × (1 + random·thisFraction) — so multiple bots in the ' +
      'same call surface (and later fire probes) on DIFFERENT cadences instead of ' +
      'in unison. 0.3 = up to +30%. 0 disables the jitter (all bots tick at the ' +
      'same threshold — not recommended with 2+ bots).',
  },
};

function validate(key, value) {
  const spec = PREFERENCES[key];
  if (!spec) return { ok: false, error: `Unknown preference '${key}'` };

  if (spec.type === 'number') {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (!Number.isFinite(n)) return { ok: false, error: `Expected number, got ${typeof value}` };
    if (spec.min != null && n < spec.min) return { ok: false, error: `Below min ${spec.min}` };
    if (spec.max != null && n > spec.max) return { ok: false, error: `Above max ${spec.max}` };
    return { ok: true, value: n };
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `Expected string` };
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      return { ok: false, error: `Must be one of: ${spec.enum.join(', ')}` };
    }
    if (spec.maxLength != null && value.length > spec.maxLength) {
      return { ok: false, error: `String too long (max ${spec.maxLength} chars)` };
    }
    if (spec.pattern instanceof RegExp && !spec.pattern.test(value)) {
      return { ok: false, error: `Value doesn't match required format` };
    }
    return { ok: true, value };
  }
  if (spec.type === 'boolean') {
    // Coerce common string/number forms — LLM agents routinely pass booleans as
    // the string "true"/"false" (mirrors the number case's string leniency).
    if (typeof value === 'boolean') return { ok: true, value };
    if (typeof value === 'number' && (value === 0 || value === 1)) return { ok: true, value: value === 1 };
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(v)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off'].includes(v)) return { ok: true, value: false };
    }
    return { ok: false, error: `Expected boolean (true/false), got ${typeof value}: ${JSON.stringify(value)}` };
  }
  if (spec.type === 'string[]') {
    if (!Array.isArray(value) || !value.every(s => typeof s === 'string')) {
      return { ok: false, error: `Expected array of strings` };
    }
    if (spec.minItems != null && value.length < spec.minItems) {
      return { ok: false, error: `Must have at least ${spec.minItems} item(s)` };
    }
    return { ok: true, value };
  }
  return { ok: false, error: `Unhandled type ${spec.type}` };
}

function describe(store) {
  const { isAppLevel } = require('./config-scope.js');
  const get = typeof store === 'function' ? store : (k) => store?.get?.(k);
  return Object.entries(PREFERENCES).map(([key, spec]) => {
    const current = get(key);
    return {
      key,
      // 'app' = shared across all profiles on this machine (#366);
      // 'profile' = scoped to the running profile.
      scope: isAppLevel(key) ? 'app' : 'profile',
      type: spec.type,
      value: current !== undefined ? current : spec.default,
      default: spec.default,
      description: spec.description,
      ...(spec.min != null && { min: spec.min }),
      ...(spec.max != null && { max: spec.max }),
      ...(spec.minItems != null && { minItems: spec.minItems }),
      ...(spec.requiresRestart && { requiresRestart: true }),
      isDefault: current === undefined,
    };
  });
}

module.exports = { PREFERENCES, validate, describe, DEFAULT_BOT_NAME };
