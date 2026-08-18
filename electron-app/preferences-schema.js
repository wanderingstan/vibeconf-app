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
  calendarIdentityEmail: {
    type: 'string',
    default: '',
    label: 'Calendar invite email',
    description:
      "Add this email as a guest on a Google Calendar event (it doesn't need to " +
      'be a real/working address) to have this bot automatically join that ' +
      "meeting. Alternatively, put `#vibeconf:<this bot's name>` in the " +
      "event's title or description. Requires the user to be logged into " +
      'vibeconferencing.com with Calendar access connected. See ' +
      'startCalendarPolling in main.js.',
  },
  onboardingCallComplete: {
    type: 'boolean',
    // Default TRUE, deliberately backwards from how a "have you done X yet"
    // flag would normally default. A brand-new, never-configured bot needs
    // this false — but that has to be written explicitly, at the moment the
    // bot is actually created (main.js: seedNewBotName, and the brand-new-
    // profile check in the startup block), not left to fall through to a
    // schema default. Defaulting to false here would mean every profile that
    // predates this preference — every bot real people have been running for
    // weeks — reads as never-onboarded the moment this shipped, and gets
    // shoved into a surprise guided call it doesn't need. Defaulting to true
    // makes "unknown" mean "assume already configured", which is the safe
    // direction to be wrong in.
    default: true,
    hiddenInSettingsUI: true,
    description:
      "Whether this bot has ever finished the live guided onboarding call " +
      "(mcp-server/onboarding-call-skill.md) — the walkthrough that sets its " +
      'name, voice, emoji and background live, in-call. Distinct from the ' +
      "Electron dialog wizard's own `onboardingComplete` store flag, which only " +
      'tracks that dialog being dismissed and says nothing about whether the ' +
      'live call ever ran. Explicitly set to false only when a bot is newly ' +
      'created (main.js), and set to true by the onboarding-call skill itself ' +
      'at the end of its walkthrough (Step 5, once every question has been ' +
      'asked or skipped). Read by join-call-skill.md and call-skill.md to ' +
      'redirect a bot that has never done this into the guided call instead ' +
      'of a normal join/call.',
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
      'Automatically record every call to disk — one audio file per track (the bot\'s ' +
      'own outgoing audio plus each remote WebRTC track Meet delivers) PLUS a ' +
      'video track of the bot\'s own Meet view, with a manifest that time-aligns ' +
      'everything. Meet gives each remote participant its own track (measured), so ' +
      '"remote-*" tracks are one stream each, but NOT reliably one person each: a ' +
      'track is labeled by arrival order, and the 2026-08-17 corpus recorded ' +
      'four participants onto three remote tracks with the fourth absent, so ' +
      'Meet appears to forward whoever is speaking into a small fixed pool. ' +
      'Treat a track as "audio from somebody" (see call-recorder.js). ' +
      'When recording is active a small visible status window appears (elapsed ' +
      'time + Stop button) — that is expected UI, not a side effect, and it is ' +
      'also how the room is shown recording is happening. When the recording ' +
      'stops, audio and video are automatically muxed into one call-recording.mp4. OFF by ' +
      'default; verbose on disk. Env VIBECONF_RECORD_CALL=1 ' +
      'forces it on (used by the test fleet so a nightly stall comes with a recording).',
  },
  extractSpeakerTracks: {
    type: 'string',
    default: 'off',
    enum: ['off', 'labels', 'audio'],
    enumLabels: {
      off: 'Off',
      labels: 'Labels + attribution.json only',
      audio: 'Also write one WAV per person',
    },
    label: 'Extract per-speaker tracks after recording',
    hiddenInSettingsUI: true,
    description:
      'After a recording is merged, reconcile the per-track audio against the raw ' +
      'mic-meter samples to work out WHO is on each track when. A recorded ' +
      'remote-* track is not one participant: Meet forwards whoever is speaking ' +
      'into a small pool of slots and reassigns them mid-call, so the per-track ' +
      '"name" in manifest.json is a whole-call majority vote and is wrong wherever ' +
      'a slot changed hands (measured: on the 2026-08-17 corpus all three humans ' +
      'appear on all three tracks). This produces the per-person view that name ' +
      'cannot. ' +
      'REQUIRES speakingEventCapture — identity comes from the indicator capture, ' +
      'and without it there is nothing to attribute with. ' +
      '"labels" writes attribution.json and the Audacity label tracks (a few ' +
      'hundred KB, and enough for every analysis question). "audio" additionally ' +
      'writes one WAV per person on the original timeline, which is ~300MB per ' +
      'person per hour — worth it for listening or fingerprinting, wasteful for a ' +
      'call nobody opens. OFF by default: it costs a CPU-minute per call and only ' +
      'matters if the recording is going to be analysed. ' +
      'Runs BEFORE call-recording-tracks/ is deleted, so it works whether or not ' +
      'keepCallRecordingTracks is on — but with tracks kept you can also re-run it ' +
      'by hand later via scripts/extract-speaker-tracks.mjs.',
  },
  keepCallRecordingTracks: {
    type: 'boolean',
    default: false,
    label: 'Keep call recording tracks',
    description:
      'After a call recording finishes producing call-recording.mp4 (and, if a ' +
      'whiteboard share happened, call-recording-share.mp4), also keep the raw ' +
      'per-track files it was built from — call-recording-tracks/ (one audio file ' +
      'per participant, plus video.webm and share.webm) and manifest.json. OFF by ' +
      'default: once the merge succeeds, call-recording-tracks/ is deleted, since ' +
      'almost everyone only ever wants the merged video(s), not the raw tracks they ' +
      'came from. Turn this on to keep those too — useful for diagnosing the ' +
      'recording itself (per-track timing, a specific participant\'s audio, a failed ' +
      'mux) rather than just watching what happened on the call. A merge that fails ' +
      'or is skipped (no ffmpeg, no video captured) never deletes the raw tracks ' +
      'regardless of this setting — they are all that is left in that case.',
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
      "debug info, or anything SVG can render. "
      + 'SHORTCUT: point it at an IMAGE FILE with "file:<path>" — '
      + '"file:/Users/me/art/background.png" — and the app converts it to a '
      + 'self-contained SVG on write (downscaled and inlined, so moving or deleting '
      + 'the file later cannot leave a black camera). png/jpg/gif/webp/svg. That is '
      + 'the easy path when you HAVE an image, including one you just generated; '
      + 'writing SVG directly stays better for anything vector.',
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
    enum: ['native', 'twemoji', 'openmoji', 'noto', 'fluent3d', 'redpanda'],
    enumPattern: /^(font:[A-Za-z0-9 _-]{1,120}(#[0-9A-Fa-f]{3,8})?|dir:[~/][^\n"']{0,400})$/,
    description:
      'How the avatar\'s face is drawn. Either a bundled set, or "font:<Family>" to '
      + 'use a font INSTALLED ON THIS MACHINE — e.g. "font:UnifontExMono". One value, '
      + 'so there is no second setting to disagree with this one. A MONOCHROME font '
      + 'has no colour of its own and draws black by default; add a hex colour to '
      + 'pick one — "font:UnifontExMono#ffcc00". (A colour font ignores it and keeps '
      + 'its own colours.) For the font form, '
      + 'Or "dir:<path>" for a FOLDER OF IMAGES you (or an agent) made — one file '
      + 'per emoji, like the bundled fluent3d set: "dir:/Users/me/taylor-emoji". '
      + 'No naming convention is imposed; the folder is indexed and any of these '
      + 'work, whichever is easiest to produce: the emoji itself ("🙂.png"), '
      + 'lowercase hex ("1f642.png"), uppercase with FE0F ("1F642.svg"), or noto '
      + 'style ("emoji_u1f642.png"). png/svg/webp/gif/jpg. An emoji with no file '
      + 'falls back to the native glyph, exactly like a gap in a bundled set, so a '
      + 'partial set is fine — the faces you supply are the ones that change. '
      + 'NOTE for art with text or a left/right: Meet MIRRORS the bot\'s own tile in '
      + 'its self-view, so your art looks backwards in get_call_screenshot and in the '
      + "Bot's view window. Everyone else sees it the right way round — the flip is a "
      + 'CSS transform on the local video element, which cannot change what is '
      + 'transmitted. Do not pre-flip your images to compensate. '
      + 'For a font, call list_fonts for the exact family names available here: a family that is '
      + 'not installed silently falls back to the system emoji font, which looks like '
      + 'nothing happened. Any font with emoji coverage works, colour or monochrome. '
      + 'The bundled sets: "native" = the OS emoji font. ' +
      '"twemoji" = Twitter Twemoji (flat). "openmoji" = OpenMoji (outlined). "noto" = ' +
      'Google Noto Emoji. "fluent3d" = Microsoft Fluent 3D (a curated face set — ' +
      'hand/person emojis fall back to native). "redpanda" = a claymation red panda ' +
      'librarian character (a curated face set, same fallback behavior as fluent3d). ' +
      'All bundled in the app — no network. ' +
      'Any emoji not in the chosen set falls back to the native glyph. Reskin the ' +
      'bot\'s face (#316).',
  },
  updateChannel: {
    type: 'string',
    default: 'release',
    enum: ['release', 'candidate'],
    // Which GitHub releases this install auto-updates to. 'release' (default — real
    // users) takes only PROMOTED releases: electron-updater's allowPrerelease stays
    // OFF, so GitHub-prerelease builds are invisible. 'candidate' (Stan + Seth) turns
    // allowPrerelease ON, so it also picks up the prerelease release-candidates BEFORE
    // they're promoted — burn them in, then promote. Promotion (scripts/promote.sh)
    // flips the release's prerelease flag off; because promoted versions are clean
    // semver with no prerelease component, a 'release' client then accepts them.
    label: 'Update channel',
    description: "Which builds this Mac auto-updates to. 'Candidate' gets new release-candidates before they're promoted to everyone — for testers who want them early.",
    enumLabels: {
      release: 'Release (stable — promoted builds only)',
      candidate: 'Candidate (prerelease — test builds before promotion)',
    },
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
      codex: 'OpenAI Codex (experimental)',
      other: 'Other MCP client (LM Studio, custom)',
    },
    description:
      'Which agent drives the bots on THIS MACHINE. App-level, not per-bot: which ' +
      'CLI is installed is a property of the machine, and every bot on it is driven ' +
      'by the same one. "claude" = Claude Code, the path the app automates (it writes ' +
      'the MCP config, opens the Terminal, and checks sign-in). "codex" = OpenAI Codex ' +
      'CLI — experimental; the app writes its MCP config, but does not launch it. "other" = anything ' +
      'else that speaks MCP (LM Studio, a hand-rolled client, an agent on ' +
      'another machine) — the app gives you the connection details and stays out of ' +
      'the way. ' +
      'Only "claude" makes the app responsible for launching the agent, so it is the ' +
      'only value that warns about Claude Code being missing or signed out (#137).',
  },
  agentHosting: {
    type: 'string',
    default: 'terminal',
    enum: ['terminal', 'headless'],
    label: 'Agent hosting',
    enumLabels: {
      terminal: 'Terminal window (default)',
      // The ⚠️ is load-bearing, not decoration. Picking headless without
      // Dangerous Mode silently does nothing — the app refuses and falls back to
      // a Terminal — so without a visible marker the setting looks like it took
      // effect when it did not.
      headless: '⚠️ Headless — needs Dangerous Mode (experimental)',
    },
    requiresRestart: false,
    description:
      'How the app runs the Claude session that drives this bot. "terminal" opens '
      + 'Terminal.app and types the command — you can watch the agent think, answer '
      + 'a prompt, and Ctrl-C it, but the app cannot see its output except through '
      + 'the transcript file Claude Code happens to write. "headless" spawns the '
      + 'agent as a child of the app with --output-format stream-json, so its '
      + 'activity is read directly from its own stdout rather than scraped from a '
      + 'file (#242) — the brain pane keeps working even when transcripts are not '
      + 'written, which they were not at all on 2026-08-04. '
      + 'Experimental because headless has no UI: there is no window to read an '
      + 'error in and nothing to interrupt. It also REQUIRES Dangerous Mode — a '
      + 'permission prompt has nowhere to draw, so the agent would stall silently '
      + 'on its first tool call; the app refuses headless without it and falls back '
      + 'to a Terminal rather than joining a call with a mute bot. '
      + 'Only applies when Agent backend is "claude".',
  },
  linuxAgentTmux: {
    type: 'boolean',
    default: false,
    label: 'Wrap the agent terminal in tmux (Linux only)',
    requiresRestart: false,
    description:
      'On Linux, run the agent inside a tmux session and use the terminal window '
      + 'only as a viewport onto it (#329). What that buys: the session SURVIVES '
      + 'the window being closed (or X restarting, or an SSH connection dropping), '
      + 'and you can reattach from anywhere with "tmux attach -t <session>" — '
      + 'including over plain SSH, which is how an unattended box gets debugged '
      + 'and recovered when its agent wedges. '
      + 'OFF by default because that is not a trade everyone wants: tmux brings '
      + 'its own status bar, scrollback and Ctrl-B keybindings, and inheriting all '
      + 'of that just because tmux happens to be installed is a surprise on a '
      + 'machine you are only playing on. Off, the terminal behaves like macOS '
      + 'does — plain, and closing it ends the agent. '
      + 'Turn it ON for a machine you need to reach remotely, or one that has to '
      + 'survive a dropped connection. '
      + 'Ignored when tmux is not installed, and ignored entirely on macOS and '
      + 'Windows. '
      + 'It does NOT mean "never run tmux": on a machine with NO terminal emulator '
      + 'at all there is no window for tmux to change the feel of, and a detached '
      + 'tmux session is the only way to have an agent anyone can type at, so that '
      + 'case still uses one regardless of this setting.',
  },
  confirmQuit: {
    type: 'boolean',
    default: true,
    label: 'Confirm before quitting',
    requiresRestart: false,
    description:
      'Ask before closing the main window, which quits the app. The red close '
      + 'button sits a few pixels from controls used constantly, and mid-call a '
      + 'stray click ends the call and stops the bot\'s agent with no undo. The '
      + 'dialog says which of those two you are doing. Turn off here, or via '
      + '"Don\'t ask again" in the dialog itself.',
  },
  remoteLogging: {
    type: 'boolean',
    default: false,
    label: 'Remote logging',
    description:
      'Ship this app\'s session log to the backend continuously, so it can be read '
      + 'remotely via get_session_log (instance:…) or the logs CLI — useful for '
      + 'debugging another machine\'s bots without terminal access. The log may '
      + 'contain transcript text. '
      + 'OFF by default (#255). It was on through early testing, on the argument '
      + 'that the team needed the data; the useful logs turned out to be the ones '
      + 'attached to a complaint, and "📤 Share this call\'s log" in the '
      + 'troubleshooting window now covers those — one call, chosen in the moment, '
      + 'by someone who knows what went wrong. Shipping every call forever on the '
      + 'strength of a checkbox answered once at install is a worse trade for both '
      + 'sides. Turn it on for a machine you are actively debugging. '
      + 'Takes effect immediately (no restart).',
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
    default: 1500,
    min: 0,
    max: 10_000,
    description:
      'How long the bot waits after detecting a human interruption before '
      + 'actually stopping its TTS. Tunes the bot\'s "patience" — higher means '
      + 'a brief overlap (a cough, a "yeah" backchannel, a false start) is ridden '
      + 'out as natural conversation; lower means the bot drops out almost '
      + 'instantly. Read live, so it can be tuned mid-call (per profile). '
      + 'ONLY USED when bargeInUrgencyScaling is off — and that defaults to ON, '
      + 'so out of the box this value is inert and the grace comes from the '
      + 'min/max range below. '
      + '1500ms, measured (#422): across 850 real overlaps from 9 calls, overlap '
      + 'duration runs p50 400ms, p90 1100ms, p99 2680ms. 1500ms rides out 95.8% '
      + 'of them — nearly every backchannel — while yielding a full second sooner '
      + 'than the old 2500ms, which outlasted 98.6% and so barely distinguished a '
      + '"mm-hm" from someone genuinely taking the floor.',
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
  bargeInQuietConfirmMs: {
    type: 'number',
    default: 250,
    min: 0,
    max: 5000,
    description:
      'How long the analyser must have heard silence, at the moment the barge-in ' +
      'grace expires, for the interruption to count as "already over" (#392). The ' +
      'participant tracker\'s speaking flag can lag a real stop by seconds, so the ' +
      'grace evaluation re-checks liveness against the analyser: quiet for at least ' +
      'this long means the blip ended inside the grace window and the bot keeps ' +
      'talking. Shorter quiet is treated as an inter-word dip (the analyser dips ' +
      'between syllables) and the bot still yields. 250ms matches the meter hold ' +
      'in the speaker tracker. Applies only when the analyser demonstrably tracked ' +
      'the interruption; with no analyser signal the old tracker-flag behavior ' +
      'decides, so a broken analyser can never stop the bot from yielding.',
  },
  bargeInGraceMinMs: {
    type: 'number',
    default: 900,
    min: 0,
    max: 10_000,
    description:
      'When bargeInUrgencyScaling is on: the grace for a zero-urgency (filler) ' +
      'utterance — the bot yields the floor almost immediately. Default 900ms.',
  },
  bargeInGraceMaxMs: {
    type: 'number',
    default: 2400,
    min: 0,
    max: 10_000,
    description:
      'When bargeInUrgencyScaling is on: the grace for a max-urgency utterance — '
      + 'the bot holds the floor longest for something it scored 1.0. The grace is '
      + 'linear in urgency: ms = min + urgency x (max - min), with unscored '
      + 'utterances treated as 0.5. '
      + '2400ms, measured (#422). The anchor is the NORMAL case rather than the '
      + 'extreme: urgency 0.4 is documented as "a normal answer to a normal '
      + 'question", and 900 + 0.4 x (2400 - 900) = 1500ms, which rides out 95.8% '
      + 'of 850 real overlaps. The ladder that produces is filler 900ms (87.7% of '
      + 'overlaps), normal answer 1500ms (95.8%), house-on-fire 2400ms (98.5%). '
      + 'The old 4000ms outlasted over 99% of ALL overlap, meaning a high-urgency '
      + 'utterance effectively never yielded to anyone.',
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
    default: 0,
    min: 0,
    max: 10_000,
    description:
      'When two bots collide (one bot interrupting another, evaluated only AFTER ' +
      'the normal bargeInGraceMs sustain period already elapsed), each independently ' +
      'draws a random tie-breaking delay in [min, max] before committing to back off ' +
      '— whichever bot draws the smaller value yields first, decorrelating two bots ' +
      'running identical logic against each other. This is the floor of that range. ' +
      'Was 1000 by default; raising it adds a flat mandatory delay to every bot-vs-' +
      'bot collision with no decorrelation benefit — the gap between two random draws ' +
      'depends only on (max - min), not on where the floor sits — so 0 is correct ' +
      'unless you specifically want a minimum pause. Read live.',
  },
  bargeInBotRandomMaxMs: {
    type: 'number',
    default: 3000,
    min: 0,
    max: 30_000,
    description:
      'Ceiling of the bot-vs-bot random-delay range (see bargeInBotRandomMinMs). Was ' +
      '4000 paired with a 1000 floor (3s spread); kept the same 3s spread when the ' +
      'floor moved to 0.',
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
  speakingEventCapture: {
    type: 'boolean',
    default: false,
    label: 'Capture raw speaking-detection events',
    description:
      'Write every raw observation the speaking detectors make to '
      + 'speaking-events.jsonl in the call folder: each tile mutation, each '
      + 'reading of Meet\'s speaking indicator (as its raw background-position-x, '
      + 'not a derived boolean), each verdict edge, and our own TTS loud/quiet '
      + 'edges. Off by default — a 4-person call produces on the order of 300k '
      + 'rows an hour. '
      + 'Turn it on to TUNE detection rather than argue about it (#422): none of '
      + 'the detector constants change what Meet does, only what we conclude '
      + 'from a recording, so one capture can be re-scored offline at any window, '
      + 'attack, hold or lookback (scripts/score-speaking.mjs). The 5s '
      + '[speaker-health] line cannot do this — it aggregates away the timing '
      + 'that is the entire subject. Pairs with keepCallRecordingTracks, which '
      + 'keeps the per-participant audio the events are scored against.',
  },
  speakingDetectionMode: {
    type: 'string',
    default: 'mutation',
    enum: ['either', 'meter', 'mutation'],
    enumLabels: {
      either: 'Either signal (fastest rising edge)',
      meter: 'Meter level only',
      mutation: 'Mutation counting only (pre-#142)',
    },
    description:
      'Which per-participant speaking signal the DOM tracker takes its verdict '
      + 'from. Both always run and both are always logged, so this only picks the '
      + 'verdict — the comparison keeps accruing whatever it is set to. '
      + '"mutation" is the original: count tile mutations, 3 inside a 1200ms '
      + 'window, which lands ~300-600ms after speech starts because Meet churns '
      + 'the meter at 5-10Hz. "meter" reads the mic meter as a LEVEL — Meet '
      + 'animates background-position-x across a sprite of bars, so one number '
      + 'is the loudness — and can flip on the first sample after onset. '
      + '"either" ORs them: earliest rising edge, and the mutation counter still '
      + 'covers anything the meter misses. A meter that has not been found or '
      + 'has not moved yet reports nothing and falls back to mutation counting, '
      + 'so no setting here can make the tracker deafer than it was before the '
      + 'meter signal existed. Watch [meter-latency] for the lead the meter '
      + 'actually delivers and [speaker-health] mtr= for meters reading blind. '
      + 'Read live (picked up on the tracker\'s 2s scan). '
      + 'DEFAULTS TO "mutation": the meter only buys ~300ms, but it fires on ANY '
      + 'sound reaching the mic — a human on laptop speakers hears the bot\'s own '
      + 'TTS come back in and the tracker reads it as that human interrupting, '
      + 'cutting the bot off mid-sentence. A slow start is invisible; a false '
      + 'cut-off is not. Set "either" when everyone is on headphones.',
  },
  fastFloorDetection: {
    type: 'boolean',
    default: true,
    description:
      'Use the Web Audio analyser as a fast path for someone taking the floor from ' +
      'a speaking bot, alongside Meet\'s mic-meter DOM signal. The DOM path needs 3 ' +
      'mutations in a 1200ms window, so it lands ~400-700ms after speech starts; ' +
      'the analyser samples every animation frame (~16ms). EITHER signal counts as ' +
      'busy, so the DOM path still covers what the analyser misses. ' +
      'The floor uses its OWN threshold (FLOOR_SPEECH_DB, -35dB), well above the ' +
      '-55dB STT gate, and that separation is the whole point. Measured across ' +
      '1,501 level windows of real calls: the room noise floor never reached even ' +
      '-55dB (median -92dB), so ambient sound was never the problem — but the ' +
      'rising edge is immediate, so one ~16ms frame over the line arms the floor ' +
      'for 350ms, and a keystroke clears -55dB easily. 26.5% of 3,820 measured busy ' +
      'periods lasted under 500ms: too short to be anyone taking the floor, and ' +
      'each one is the bot going quiet for nothing. At -35dB, 94% of windows ' +
      'containing real speech still clear it and no quiet window does. ' +
      'So this is an ESCAPE HATCH, not a detector: erring loud costs a moment of ' +
      'yield latency, erring quiet costs the bot its voice. If a bot still goes ' +
      'quiet, set this false — read live, so it takes effect mid-call. Watch the ' +
      '[floor-audio] busy durations: a return of sub-500ms periods means -35dB is ' +
      'still too low. [floor-levels] and [floor-latency] record regardless.',
  },

  botSpeakOrdering: {
    type: 'string',
    default: 'jitter',
    enum: ['jitter', 'ranked'],
    enumLabels: {
      jitter: 'Random jitter (each bot waits a random delay)',
      ranked: 'Deterministic order (bots agree who goes first; the winner waits for nothing)',
    },
    description:
      'How several bots in one call decide who answers first. '
      + '"jitter" is the original (#230): each bot waits a private random delay. '
      + 'Because the draws are independent the separation is only probabilistic — '
      + 'two draws from U(0,N) beat the detection time D with probability '
      + '(1 - D/N)^2, so at N=2000 with D measured near 180ms roughly 17% of '
      + 'collisions still survive, and EVERY bot pays a mean 1000ms on EVERY turn '
      + 'to get that. '
      + '"ranked" computes an order instead, out of what every bot already knows: '
      + 'the roster, and the utterance Meet showed all of them. Same inputs, same '
      + 'hash, same order, with nothing exchanged. The winner speaks immediately; '
      + 'the rest wake botSpeakRankGapMs apart, find the floor busy, and stash '
      + 'exactly as they would for a human — which also covers a winner that '
      + 'turns out to have nothing to say. Being named in the utterance is a '
      + 'bonus in that ordering, so a direct question reaches the bot it was '
      + 'asked of. '
      + 'Requires peerBotNames, and falls back to jitter when that is unset or '
      + 'this bot is not in it — so the worst case is exactly the old behaviour.',
  },
  peerBotNames: {
    type: 'string[]',
    default: [],
    description:
      'The OTHER bots expected in calls with this one, by display name — what '
      + 'botSpeakOrdering="ranked" ranks against. '
      + 'Explicit configuration because nothing else knows: the Meet roster does '
      + 'not mark which participants are bots, and the website presence list came '
      + 'back empty when checked (2026-08-17). Populating presence, or having the '
      + 'bots announce themselves in the room chat, would remove the need for it. '
      + 'Matched case-insensitively, and this bot\'s own name is added '
      + 'automatically. A wrong or stale entry costs ordering quality, not '
      + 'correctness: an unrecognised bot simply falls back to jitter.',
  },
  botSpeakRankGapMs: {
    type: 'number',
    default: 500,
    min: 0,
    max: 5000,
    description:
      'With botSpeakOrdering="ranked", how far apart the bots wake: rank 0 speaks '
      + 'at once, rank 1 after this long, and so on. '
      + 'It must EXCEED the time a bot needs to SEE another bot start, or the '
      + 'loser\'s delay expires before it has noticed the winner and both talk. '
      + 'Measured (#422): speaking-onset p90 is about 180ms via the meter signal '
      + 'and 360-460ms via the mutation counter, so 500ms is safe on today\'s '
      + 'default and could fall to ~250ms once speakingDetectionMode is "meter". '
      + 'It is also what a silent winner costs: the next bot in line waits this '
      + 'long before filling the gap.',
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
      'Shorter silence threshold used whenever the bot is addressed by name anywhere ' +
      'in an utterance — a hand-off like "…what do you think, Jimmy?" or "Jimmy, go ' +
      'ahead" (#343, #359). It then resolves after this much silence instead of the ' +
      'full defaultSilenceSeconds, for a prompter reply. Applies uniformly to a waiter ' +
      'parked in wait_for_speech (_checkWaiters) AND to replaying a held barge-in stash ' +
      '(_maybeReplayStashOnOpening) — the same rule either way, not a separate "call-on" ' +
      'concept for the stash case. Position in the utterance is deliberately NOT ' +
      'checked (#359): it is an unreliable signal, more so across languages, and this ' +
      'only ever SHORTENS an already silence-gated wait — it never skips the wait ' +
      'outright, so there is no speaker to cut off regardless of where the name lands. ' +
      'Kept at 1.0 (not lower) so a brief pause right after saying the name — "Hey ' +
      'Jimmy… how are you" — does not trip it. Set >= defaultSilenceSeconds to disable. ' +
      'Read live.',
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
  openTurnStableMs: {
    type: 'number',
    default: 5000,
    min: 500,
    max: 30000,
    description:
      'Caption ingest (#12) tracks one open/mutable turn per participant — the ' +
      'only one of their lines Meet might still be appending to. We do not know ' +
      'Meet\'s exact rule for when it stops extending a line vs. starting a new ' +
      'one for that speaker, so if their open turn hasn\'t grown in this many ms ' +
      'it is marked settled defensively (Stan, 2026-08-14). Only affects the ' +
      'settled/isFinal flag, not what gets delivered to wait_for_speech. Default 5s.',
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
      // enumPattern widens a closed list with one open FORM, for a pref that is
      // "one of these, or a value only the user's machine knows" — emojiSet's
      // `font:<Family>`. Encoding that in the same key as the bundled sets means
      // there is no second preference with a precedence rule against this one.
      if (!(spec.enumPattern instanceof RegExp && spec.enumPattern.test(value))) {
        const extra = spec.enumPattern ? `, or ${String(spec.enumPattern)}` : '';
        return { ok: false, error: `Must be one of: ${spec.enum.join(', ')}${extra}` };
      }
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
