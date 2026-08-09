# Preferences

<!-- This preamble is the only hand-editable section of this page. -->

Every persisted setting the bot exposes to agents lives in `electron-app/preferences-schema.js`. Anything not in that schema, including auth cookies and API keys, is invisible to the agent even when it lives in the same `config.json`.

Use `list_preferences` to read the current values and `set_preference({key, value})` to change one. The schema is authoritative; regenerate the reference below with `node scripts/generate-preferences-doc.mjs`.

<!-- BEGIN GENERATED -->

## Preference reference

### `ackEndpoint`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"http://127.0.0.1:11535/v1"` |
| Scope | profile |
| Requires restart | no |
| Constraints | pattern `/^https?:\/\/.+/` |
| Description | OpenAI-compatible base URL for the LOCAL fast model used by the ack, background comprehension, triage, and the active-listening completeness gate (#243/#245/#237). Default is the Apple on-device wrapper (http://127.0.0.1:11535/v1). Point at LM Studio (http://127.0.0.1:1234/v1) or any openai-compat server instead if you prefer. Read live — takes effect on the next model call, no restart. Pair with ackModel. |

### `ackLongMin`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `50` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0` |
| Description | Word count at or above which the bot uses a longer ack ("Let me think about that") instead of a short one. |

### `ackLongPhrases`

| Field | Value |
| --- | --- |
| Type | `string[]` |
| Default | `["Let me think about that.","Hmm, let me consider that.","Give me a moment.","One moment","One second, thinking.","Hmm, good question.","Let me chew on that.","Just a sec, processing.","Hmm, interesting.","Hold on, working through that.","Let me work that out."]` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum items `1` |
| Description | Phrases the bot picks from for long acks (when wordCount >= ackLongMin). |

### `ackModel`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"apple-on-device"` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Model name requested from ackEndpoint for the local fast-model consumers (ack / comprehend / triage / completeness gate). Must match a model the endpoint serves — e.g. "apple-on-device" for the Apple wrapper (default), "qwen2.5-7b-instruct-mlx" for LM Studio. Read live; no restart. |

### `ackShortMin`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `20` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0` |
| Description | Word count below which the bot skips the acknowledgment entirely. For very short prompts the thinking emoji is enough feedback. |

### `ackShortPhrases`

| Field | Value |
| --- | --- |
| Type | `string[]` |
| Default | `["Mm-hmm.","Mmmm","Ahhh okay","Okay.","Got it.","Mm.","Right.","Yeah.","Sure.","Uh-huh.","Mhm.","Cool.","Gotcha.","Right, right."]` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum items `1` |
| Description | Phrases the bot picks from for short acks (when wordCount is between ackShortMin and ackLongMin). One is chosen at random per ack. |

### `afterCallWorkSeconds`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `300` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `1800` |
| Description | How long the bot's agent may keep working after it leaves a call, in seconds. The call's room, transcript and tools all stay available during this window, so the agent can summarise, file notes, or write a receipt before the app tears the call down. What it actually does is in the bot's CLAUDE.md, under "After the call". This is a BACKSTOP, not a schedule: an agent that finishes early calls end_session and the app tears down immediately, so the usual cost is seconds, not the whole window. It only runs to the limit when an agent never reports back. Skipped entirely when no agent is driving the bot, since there would be nobody to do the work. Set 0 to turn the phase off and tear down the moment the bot leaves. |

### `agentBackend`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"claude"` |
| Scope | app |
| Requires restart | no |
| Constraints | one of `"claude"`, `"codex"`, `"other"` |
| Description | Which agent drives the bots on THIS MACHINE. App-level, not per-bot: which CLI is installed is a property of the machine, and every bot on it is driven by the same one. "claude" = Claude Code, the path the app automates (it writes the MCP config, opens the Terminal, and checks sign-in). "codex" = OpenAI Codex CLI — experimental; the app writes its MCP config, but does not launch it. "other" = anything else that speaks MCP (LM Studio, a hand-rolled client, an agent on another machine) — the app gives you the connection details and stays out of the way. Only "claude" makes the app responsible for launching the agent, so it is the only value that warns about Claude Code being missing or signed out (#137). |

### `agentHosting`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"terminal"` |
| Scope | app |
| Requires restart | no |
| Constraints | one of `"terminal"`, `"headless"` |
| Description | How the app runs the Claude session that drives this bot. "terminal" opens Terminal.app and types the command — you can watch the agent think, answer a prompt, and Ctrl-C it, but the app cannot see its output except through the transcript file Claude Code happens to write. "headless" spawns the agent as a child of the app with --output-format stream-json, so its activity is read directly from its own stdout rather than scraped from a file (#242) — the brain pane keeps working even when transcripts are not written, which they were not at all on 2026-08-04. Experimental because headless has no UI: there is no window to read an error in and nothing to interrupt. It also REQUIRES Dangerous Mode — a permission prompt has nowhere to draw, so the agent would stall silently on its first tool call; the app refuses headless without it and falls back to a Terminal rather than joining a call with a mute bot. Only applies when Agent backend is "claude". |

### `avatarBackgroundCaption`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Optional human-readable label for your current avatar background (e.g. 'Berlin skyline at dusk'). Purely for recall — set it alongside avatarBackgroundSvg so you (or a future context after a reset) can answer 'what's my background?' without parsing raw SVG. Surfaced in get_room_info; not rendered. |

### `avatarBackgroundSvg`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | maximum length `1000000` |
| Description | SVG source for the avatar background. Empty = default animated gradient. The camera is 16:9 (1280x720), so author LANDSCAPE — e.g. viewBox="0 0 1280 720". The image is cover-fitted (scaled to fill, aspect preserved, overflow center-cropped), so a square SVG is not distorted but its top and bottom WILL be cropped — keep anything important near the vertical center. The SVG can include <image href='file:///...' or 'https://...'> — the app auto-resolves external references into data URIs so you don't need to base64-encode anything. SVG/CSS animations don't tick (rasterized once); the emoji's bounce provides motion. Use to display backgrounds, name plates, debug info, or anything SVG can render. SHORTCUT: point it at an IMAGE FILE with "file:<path>" — "file:/Users/me/art/background.png" — and the app converts it to a self-contained SVG on write (downscaled and inlined, so moving or deleting the file later cannot leave a black camera). png/jpg/gif/webp/svg. That is the easy path when you HAVE an image, including one you just generated; writing SVG directly stays better for anything vector. |

### `backgroundTickJitterFrac`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `0.3` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `2` |
| Description | Anti-lockstep jitter for backgroundTickWords (#245/#230). Each time the bot re-arms a background tick it rolls its effective threshold to backgroundTickWords × (1 + random·thisFraction) — so multiple bots in the same call surface (and later fire probes) on DIFFERENT cadences instead of in unison. 0.3 = up to +30%. 0 disables the jitter (all bots tick at the same threshold — not recommended with 2+ bots). |

### `backgroundTickWords`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `100` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `1000` |
| Description | Active-listening experiment (#245), OFF by default (0). When > 0, wait_for_speech surfaces the slow model EARLY — once this many NEW transcript WORDS pile up during conversation the bot is NOT part of — with a "background_tick" result instead of blocking until a definitive silence. Measured as a true DELTA (words since the last tick), so one long monologue ticks once per this-many words rather than every poll. On a tick the slow session updates its understanding / banks a brief active-listening probe and loops WITHOUT speaking; only a real silence resolution lets it speak. This is the mechanism that lets the (otherwise blocked) slow model think during long stretches. Content-based, so it scales with how much was actually said, not wall-clock. 0 = exactly today's behavior. Costs continuous slow-model turns — fine on the flat subscription, not metered. Try e.g. 100. |

### `bargeInAckExempt`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | When on, the bot's OPENING ACK (its first short reply to a turn) and very short backchannels are EXEMPT from the barge-in drop — they play even if a human is still talking. Keeps the room from thinking the bot went silent while it does slow tool work (root cause of the #335 double-response). Turn OFF if it feels like the bot talks over people. Read live — tunable mid-call. Length caps: bargeInAckMaxWords / bargeInBackchannelMaxWords. |

### `bargeInAckMaxWords`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `12` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `200` |
| Description | Max words for the OPENING ACK to stay barge-in-exempt (see bargeInAckExempt). Protects a real ack ("Sure — putting that together now.") while letting anything longer yield to a human. An exempt utterance plays OVER a live speaker, so this cap is the sole thing standing between "the bot signalled it heard me" and "the bot talked over me". 40 -> 30 (#67) -> 12 (#109): on the Jul 28 call all 14 exemptions came through this path at a median of 18 words — full sentences, not acks — while the code above it claims "substantive mid-turn responses are NOT exempt". 12 is about where an ack stops being an ack. Read live. |

### `bargeInAckMinUrgency`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `0.5` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `1` |
| Description | Minimum self-scored URGENCY for an utterance to stay barge-in-exempt, i.e. to play OVER a live speaker. Length alone was the gate until #109; urgency was consulted only AFTER speech started (scaling the grace, see bargeInUrgencyScaling), so a low-value interruption not only began but then held the floor longer. On the Jul 28 call every short utterance that actually played over someone scored 0.3-0.4 ("mildly useful"), while every 0.8-0.9 one went out into an open floor and needed no exemption at all — so a 0.5 floor blocks the bad cases at no cost to the good ones. Unscored utterances count as 0.5 (the same midpoint convention as the grace scaling), so an agent that never passes urgency keeps its acks. Set 0 to disable the urgency condition. Read live. |

### `bargeInBackchannelMaxWords`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `6` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `50` |
| Description | Max words for ANY bot utterance to count as a barge-in-exempt backchannel ("Got it.", "On it.") — it plays over a human because it is brief. Set 0 to disable backchannel exemption (the opening-ack exemption still applies). Read live. |

### `bargeInBotRandomMaxMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `4000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `30000` |
| Description | Ceiling of the bot-vs-bot random-delay range (see bargeInBotRandomMinMs). |

### `bargeInBotRandomMinMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `1000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `10000` |
| Description | When two bots try to speak at the same moment, each waits a random delay in [min, max] before committing to its turn — preventing lockstep talking over each other. This is the floor of that range. |

### `bargeInGraceMaxMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `1500` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `10000` |
| Description | When bargeInUrgencyScaling is on: the grace for a max-urgency utterance — the bot fights hardest to be heard. Default 1500ms — was 3500ms, lowered in #138: the agent self-scored u≈0.90 on essentially every utterance that call, so the scaling sat pinned near its ceiling and bought ~2.9s of talking over a human, which is what "you're not stopping when we start speaking" felt like from the room. With the min at 700ms the whole range is now inside human turn-taking latency; raise it again if the urgency distribution ever spreads out enough for the ceiling to mean something. |

### `bargeInGraceMinMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `700` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `10000` |
| Description | When bargeInUrgencyScaling is on: the grace for a zero-urgency (filler) utterance — the bot yields the floor almost immediately. Default 700ms. |

### `bargeInGraceMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `2500` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `10000` |
| Description | How long the bot waits after detecting a human interruption before actually stopping its TTS. Tunes the bot's "patience" — higher means a brief overlap (a cough, a "yeah" backchannel, a false start) is ridden out as natural conversation; lower means the bot drops out almost instantly. Read live, so it can be tuned mid-call (per profile). Used as the FIXED grace when bargeInUrgencyScaling is off; when scaling is on this is ignored in favor of the min/max range below. Default 2500ms. |

### `bargeInStashMaxAgeMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `45000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `120000` |
| Description | When the bot yields mid-thought to a human, its queued speech is stashed and auto-replayed on the next silence gap if still fresh. This is how fresh (ms) the stash must be to replay; older than this and the slow model regenerates from scratch. Higher = more "the bot patiently waited and just said its thing"; lower = more "the bot re-thinks every gap." Was 10s, which in practice never fired: a live two-person call holds the floor far longer (one call: 13 stashes, 0 replays, holds of 37s/77s/80s). Relevance is guarded by bargeInStashRedeliverMaxNewWords, not by the clock, so the age bar can afford to be generous. Default 45s. |

### `bargeInStashRedeliverMaxNewWords`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `15` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `200` |
| Description | Content-delta gate on replaying a barge-in stash (#239). When the bot yields mid-thought and the floor reopens, the stashed reply is only auto-replayed if fewer than this many NEW words were spoken by others while it was held — otherwise the conversation has moved on, the stash is discarded, and the slow model re-derives on the caught-up window. This is the "clock-vs-words" companion to bargeInStashMaxAgeMs: age guards wall-clock staleness, this guards topical staleness. Higher = replay even after a lot was said; 0 = only replay if literally nothing new was said. Default 15. Read live. |

### `bargeInUrgencyScaling`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Scale the barge-in grace (and how tolerant the resume is of interruption words) by the URGENCY the bot self-scored for the utterance it is currently speaking. A house-on-fire reply (urgency≈1) holds the floor for the full bargeInGraceMaxMs; pure filler (urgency≈0) cedes it almost instantly at bargeInGraceMinMs. Unscored utterances default to the midpoint. Experimental (#367) — urgency calibration is still being collected; toggle off mid-call if it feels wrong. |

### `botName`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"Unnamed bot"` |
| Scope | profile |
| Requires restart | yes |
| Constraints | none |
| Description | The bot's display name in Meet calls. Takes effect on the next call. |

### `botPersonality`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | maximum length `2000` |
| Description | Two-tier experiment: the voice/character the fast model speaks in (e.g. 'dry, concise, a bit wry; never corporate'). Used by the shadow harness now (drafting what the bot would say) and by the fast model once it becomes the bot's voice. Empty = a neutral, conversational default. |

### `botSpeakJitterMaxMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `2000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `5000` |
| Description | When the call has 2+ other participants (so another bot could answer the same prompt in lockstep), the bot waits a random 0-N ms before speaking, to decorrelate simultaneous starts (#230). Raised 800 -> 2000 in #100: the delay only helps if the LOSING bot can SEE the winner before its own turn, and speaking-detection needs ~400-700ms (3 meter mutations in a 1200ms window). Two draws from U(0,N) differ by more than the detection latency with probability (1 - D/N)^2, so N=800 converted into a yield only ~14% of the time — jitter fired 119 times on the Jul 28 call and bots still answered together. N=2000 gets that to ~56%. Solo / single-human calls skip it entirely. 0 disables. Higher = more separation, more lag. |

### `botSpeakUrgencyLeadMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `900` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `5000` |
| Description | How much of the speak delay is decided by URGENCY rather than chance. The bot waits (1 - urgency) x this, PLUS the random jitter above — so a reply the agent scored 0.9 reaches the floor ~700ms before one scored 0.1, by construction rather than by winning a coin flip. Without it two bots with very different things to say are equally likely to go first. Unscored utterances count as 0.5. 0 makes ordering purely random (the pre-#100 behaviour). Read live. |

### `botViewMode`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"hidden"` |
| Scope | profile |
| Requires restart | yes |
| Constraints | one of `"hidden"`, `"thumbnail"` |
| Description | Where the bot's Meet view rests when it isn't popped out. 'hidden' (default) keeps it in a window that is never shown, at 1600x900 and zoom 1, so get_call_screenshot captures ~3200x1800 and the bot can actually READ a participant's shared screen. 'thumbnail' is the legacy narrow-column preview: it looks nicer but squeezes Meet to ~380px, and since capturePage() bakes the zoom in, that shrunken image IS what the bot sees — on the Jul 28 call a shared terminal arrived at ~3px per line and the bot said so out loud (#103). Either way the pop-out button still works, and that's how you sign the bot into Google/Slack/GitHub. Switch to thumbnail if hiding the view ever misbehaves. |

### `calendarIdentityEmail`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Add this email as a guest on a Google Calendar event (it doesn't need to be a real/working address) to have this bot automatically join that meeting. Alternatively, put `#vibeconf:<this bot's name>` in the event's title or description. Requires the user to be logged into vibeconferencing.com with Calendar access connected. See startCalendarPolling in main.js. |

### `captionDropoutGraceMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `2000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `30000` |
| Description | How long a participant tile can stay active without caption text arriving before the bot decides the captions have dropped out (and surfaces that to the agent as a warning). See issue #187. |

### `captionLanguage`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | BCP-47 tag for the language the bot listens in, e.g. 'de-DE', 'es-ES', 'en-GB'. Applied to Meet's "Language of the meeting" when the bot joins a call. Empty leaves whatever Meet is already set to. Meet has no host-level control for this, so each bot sets its own. |

### `comprehendCharThreshold`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `0` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0` |
| Description | Two-tier experiment (OFF by default): how many characters of NEW transcript must pile up before the bot refreshes its background working memory (understanding / stance / people) via a local model. 0 disables it (the default) — without this, a bot with no local model running would ping the endpoint every ~500c and fail. Set to e.g. 500 ONLY if you have a local (openai-compat / LM Studio) model configured and want to test the two-tier working memory. Lower = fresher but more local-model calls; the first two refreshes fire sooner (~120c then ~300c) to warm up, then settle to this value. |

### `confirmQuit`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | app |
| Requires restart | no |
| Constraints | none |
| Description | Ask before closing the main window, which quits the app. The red close button sits a few pixels from controls used constantly, and mid-call a stray click ends the call and stops the bot's agent with no undo. The dialog says which of those two you are doing. Turn off here, or via "Don't ask again" in the dialog itself. |

### `defaultMaxWaitForSpeechSec`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `55` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `5`; maximum `300` |
| Description | Maximum seconds wait_for_speech blocks before returning empty. The agent should re-call after a timeout. Default 55 (just under typical HTTP timeouts). Raise only if you have a reason — long blocks make the agent appear stalled. |

### `defaultSilenceSeconds`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `1.4` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `1`; maximum `30` |
| Description | Default silence threshold (seconds) for wait_for_speech if the agent doesn't pass one. The bot waits this long after a speaker stops before considering their turn complete. Higher = more patient (bot lets users compose longer thoughts); lower = snappier. 1.4 has felt good in live calls; 2.0 was the old default. |

### `emojiSet`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"fluent3d"` |
| Scope | profile |
| Requires restart | no |
| Constraints | one of `"native"`, `"twemoji"`, `"openmoji"`, `"noto"`, `"fluent3d"`, `"redpanda"`; or matching `/^(font:[A-Za-z0-9 _-]{1,120}(#[0-9A-Fa-f]{3,8})?\|dir:[~/][^\n"']{0,400})$/` |
| Description | How the avatar's face is drawn. Either a bundled set, or "font:<Family>" to use a font INSTALLED ON THIS MACHINE — e.g. "font:UnifontExMono". One value, so there is no second setting to disagree with this one. A MONOCHROME font has no colour of its own and draws black by default; add a hex colour to pick one — "font:UnifontExMono#ffcc00". (A colour font ignores it and keeps its own colours.) For the font form, Or "dir:<path>" for a FOLDER OF IMAGES you (or an agent) made — one file per emoji, like the bundled fluent3d set: "dir:/Users/me/taylor-emoji". No naming convention is imposed; the folder is indexed and any of these work, whichever is easiest to produce: the emoji itself ("🙂.png"), lowercase hex ("1f642.png"), uppercase with FE0F ("1F642.svg"), or noto style ("emoji_u1f642.png"). png/svg/webp/gif/jpg. An emoji with no file falls back to the native glyph, exactly like a gap in a bundled set, so a partial set is fine — the faces you supply are the ones that change. NOTE for art with text or a left/right: Meet MIRRORS the bot's own tile in its self-view, so your art looks backwards in get_call_screenshot and in the Bot's view window. Everyone else sees it the right way round — the flip is a CSS transform on the local video element, which cannot change what is transmitted. Do not pre-flip your images to compensate. For a font, call list_fonts for the exact family names available here: a family that is not installed silently falls back to the system emoji font, which looks like nothing happened. Any font with emoji coverage works, colour or monochrome. The bundled sets: "native" = the OS emoji font. "twemoji" = Twitter Twemoji (flat). "openmoji" = OpenMoji (outlined). "noto" = Google Noto Emoji. "fluent3d" = Microsoft Fluent 3D (a curated face set — hand/person emojis fall back to native). "redpanda" = a claymation red panda librarian character (a curated face set, same fallback behavior as fluent3d). All bundled in the app — no network. Any emoji not in the chosen set falls back to the native glyph. Reskin the bot's face (#316). |

### `fastFloorDetection`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Use the Web Audio analyser as a fast path for someone taking the floor from a speaking bot, alongside Meet's mic-meter DOM signal. The DOM path needs 3 mutations in a 1200ms window, so it lands ~400-700ms after speech starts; the analyser samples every animation frame (~16ms). EITHER signal counts as busy, so the DOM path still covers what the analyser misses. The floor uses its OWN threshold (FLOOR_SPEECH_DB, -35dB), well above the -55dB STT gate, and that separation is the whole point. Measured across 1,501 level windows of real calls: the room noise floor never reached even -55dB (median -92dB), so ambient sound was never the problem — but the rising edge is immediate, so one ~16ms frame over the line arms the floor for 350ms, and a keystroke clears -55dB easily. 26.5% of 3,820 measured busy periods lasted under 500ms: too short to be anyone taking the floor, and each one is the bot going quiet for nothing. At -35dB, 94% of windows containing real speech still clear it and no quiet window does. So this is an ESCAPE HATCH, not a detector: erring loud costs a moment of yield latency, erring quiet costs the bot its voice. If a bot still goes quiet, set this false — read live, so it takes effect mid-call. Watch the [floor-audio] busy durations: a return of sub-500ms periods means -35dB is still too low. [floor-levels] and [floor-latency] record regardless. |

### `focusCallTabOnJoin`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | After the bot joins a call, bring the user's browser tab hosting that call to the front (Chrome/Brave/Safari), so they land on the call — from either the Join button or /join-call in the CLI. Provider-agnostic (Meet, Slack huddles; Zoom/Teams later). Best-effort: a silent no-op if there is no such tab. Set FALSE to stop the app stealing window focus on join. |

### `keepCallRecordingTracks`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Scope | app |
| Requires restart | no |
| Constraints | none |
| Description | After a call recording finishes producing call-recording.mp4 (and, if a whiteboard share happened, call-recording-share.mp4), also keep the raw per-track files it was built from — call-recording-tracks/ (one audio file per participant, plus video.webm and share.webm) and manifest.json. OFF by default: once the merge succeeds, call-recording-tracks/ is deleted, since almost everyone only ever wants the merged video(s), not the raw tracks they came from. Turn this on to keep those too — useful for diagnosing the recording itself (per-track timing, a specific participant's audio, a failed mux) rather than just watching what happened on the call. A merge that fails or is skipped (no ffmpeg, no video captured) never deletes the raw tracks regardless of this setting — they are all that is left in that case. |

### `logRawCaptions`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Debug/data-collection: log the raw in-flight caption progression ([caption-raw]) — every partial as Meet captions grow, marked LIVE vs settled. The messy data needed to test utterance-completeness detection (#243). Verbose; turn ON only when collecting test data, OFF for normal use. |

### `macosVoice`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Built-in OS voice NAME, used when ttsProvider is "macos-say" — a macOS `say` voice ("Ava (Premium)") or, on Windows, a SAPI voice ("Microsoft Zira Desktop"). The key is named for macOS for config compatibility; it holds the Windows voice too. Use list_voices and set_voice rather than editing this directly. |

### `nameMentionSilenceSeconds`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `1` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `30` |
| Description | Shorter silence threshold used when the bot is addressed by name AT THE END of an utterance — a hand-off like "…what do you think, Jimmy?" (#343). It then resolves after this much silence instead of the full defaultSilenceSeconds, for a prompter reply. Only applies when the name is at the END (not mid-sentence, which would cut the speaker off), and only ever shortens. Kept at 1.0 (not lower) so a brief pause right after saying the name — "Hey Jimmy… how are you" — does not trip it. Set >= defaultSilenceSeconds to disable. Read live. |

### `onboardingCallComplete`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Whether this bot has ever finished the live guided onboarding call (mcp-server/onboarding-call-skill.md) — the walkthrough that sets its name, voice, emoji and background live, in-call. Distinct from the Electron dialog wizard's own `onboardingComplete` store flag, which only tracks that dialog being dismissed and says nothing about whether the live call ever ran. Explicitly set to false only when a bot is newly created (main.js), and set to true by the onboarding-call skill itself at the end of its walkthrough (Step 5, once every question has been asked or skipped). Read by join-call-skill.md and call-skill.md to redirect a bot that has never done this into the guided call instead of a normal join/call. |

### `probeFiring`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Active-listening firing gate (#245), OFF by default. When ON, on a brief quiet (probeSilenceMs — shorter than the full turn-silence gate) the bot runs the Apple completeness judge on the last utterance; if it's a genuine opening AND the bot isn't directly named, it fires a SHORT interjection — the freshest banked probe (bank_probe, deposited by the slow model on background ticks) or a probeGenericPhrases fallback. This is the "active listening" behavior: cheap probes that fill gaps and buy the slow model time. Requires at least TWO other participants: a probe fills a gap in a conversation between others, and with only one counterpart every turn is aimed at the bot, so a probe just stacks a filler in front of the ack and the real reply. Uses the ackEndpoint/ackModel gate when reachable, and a conservative lexical gate (completeness.heuristicComplete) when it is not. |

### `probeGenericPhrases`

| Field | Value |
| --- | --- |
| Type | `string[]` |
| Default | `["Interesting.","Mm, right.","Go on.","Huh.","Makes sense.","Hmm."]` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum items `1` |
| Description | Fallback active-listening interjections fired when the probe bank is empty or stale. Kept deliberately short and content-free so they're never wrong. One is chosen at random. |

### `probeMaxAgeMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `30000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `600000` |
| Description | Freshness window for a banked probe. Probes deposited by the slow model older than this are discarded at fire time (the conversation has moved on) and the bot falls back to a generic. Default 30s. |

### `probeMinIntervalMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `25000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `600000` |
| Description | Rate limit for active-listening probes: minimum ms between fired probes, so the bot doesn't get needy/chatty. Over-done active listening is worse than silence. Default 25s. |

### `probeSilenceMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `700` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `200`; maximum `5000` |
| Description | How briefly the room must go quiet before the active-listening firing gate (probeFiring) considers an opening. Deliberately shorter than the full wait_for_speech silence gate (defaultSilenceSeconds) so a probe lands in the gap before a real turn would resolve. Default 700ms. |

### `recordCallAudio`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Automatically record every call to disk — one audio file per track (the bot's own outgoing audio plus each remote WebRTC track Meet delivers) PLUS a video track of the bot's own Meet view, with a manifest that time-aligns everything. Meet gives each remote participant its own track (measured), so "remote-*" tracks are per-participant — labeled by arrival order, not name. When recording is active a small visible status window appears (elapsed time + Stop button) — that is expected UI, not a side effect, and it is also how the room is shown recording is happening. When the recording stops, audio and video are automatically muxed into one call-recording.mp4. OFF by default; verbose on disk. Env VIBECONF_RECORD_CALL=1 forces it on (used by the test fleet so a nightly stall comes with a recording). |

### `remoteLogging`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Scope | app |
| Requires restart | no |
| Constraints | none |
| Description | Ship this app's session log to the backend continuously, so it can be read remotely via get_session_log (instance:…) or the logs CLI — useful for debugging another machine's bots without terminal access. The log may contain transcript text. OFF by default (#255). It was on through early testing, on the argument that the team needed the data; the useful logs turned out to be the ones attached to a complaint, and "📤 Share this call's log" in the troubleshooting window now covers those — one call, chosen in the moment, by someone who knows what went wrong. Shipping every call forever on the strength of a checkbox answered once at install is a worse trade for both sides. Turn it on for a machine you are actively debugging. Takes effect immediately (no restart). |

### `studioSound`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Meet's "Studio sound" voice filter (noise cancellation + voice-activity detection). ON (default) = Meet's normal behavior, best for the bot's spoken voice but it SUPPRESSES non-voice audio. Set FALSE to have the bot turn Studio sound OFF once in-call (More options → Settings → Audio), so sound effects / music played via play_audio pass through the mic. Costs a bit of voice enhancement. Availability depends on the Meet account tier. |

### `syncBaseUrl`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | app |
| Requires restart | yes |
| Constraints | pattern `/^(\|https?:\/\/.+)$/` |
| Description | Legacy override for the sync/website host. Prefer websiteUrl for new setups. Empty = no override. Acts as a fallback websiteUrl when websiteUrl is unset. Must be a full http:// or https:// URL with no trailing slash. APP-LEVEL (#366): shared by all profiles on this machine. |

### `thinkingHoldMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `8000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `60000` |
| Description | How long the avatar may keep showing "thinking" after new speech resolves a wait_for_speech, when the agent re-arms listening without speaking. Long enough to cover the fast-ack decision + ack TTS so the 🤔 doesn't flicker away mid-acknowledgment; after this the state downgrades to listening so the bot doesn't look stuck pondering through silence (#221). Default 8000ms. |

### `triageAck`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `false` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Use the on-device fast model (Apple triage) to decide whether the bot is being addressed THIS turn, and if so fire an instant ack filler to cover the slow model's response latency (#243/#245). OFF (default) = the simpler regex-addressivity ack path. ON = smarter ack gating via triage.js against the ackEndpoint (Apple on-device by default), with the background-maintained engagement state fed in so a bare "you" resolves to this bot mid-exchange. Independent of ackProvider, which only chooses the ack PHRASE source. (Formerly named shadowPhrase — that pref gated the now-removed two-tier shadow drafter; it was repurposed to gate the triage-ack.) |

### `ttsProvider`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | one of `""`, `"elevenlabs"`, `"macos-say"`, `"voicebox"` |
| Description | Which text-to-speech engine renders the bot's voice. Empty = pick automatically (ElevenLabs when a key is set, otherwise the built-in OS voice). Set indirectly by set_voice, which forces the provider that owns the voice you chose. |

### `ttsResumeEnabled`

| Field | Value |
| --- | --- |
| Type | `boolean` |
| Default | `true` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | When the bot is cut off MID-SPEECH by a barge-in and the floor reopens quickly, resume the interrupted utterance near where it stopped instead of dropping the half-spoken sentence (#350). Audio-level resume (same voice, no re-synthesis). Gated by ttsResumeMaxAgeMs + bargeInStashRedeliverMaxNewWords (only resume if the conversation didn't move on). Set false to always drop on interruption. Read live. |

### `ttsResumeMaxAgeMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `5000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `30000` |
| Description | How soon (ms) the floor must reopen after a mid-speech interruption for the bot to resume the cut-off utterance (#350). Past this the retained audio is considered stale and dropped (the agent moves on). The wall-clock companion to bargeInStashRedeliverMaxNewWords (topical staleness). Default 5s. Read live. |

### `ttsVoiceId`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | ElevenLabs voice ID, used when ttsProvider is "elevenlabs". Use list_voices and set_voice for an in-call switch instead of editing this directly. |

### `updateChannel`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `"release"` |
| Scope | app |
| Requires restart | no |
| Constraints | one of `"release"`, `"candidate"` |
| Description | Which builds this Mac auto-updates to. 'Candidate' gets new release-candidates before they're promoted to everyone — for testers who want them early. |

### `voiceboxEngine`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Which engine renders the Voicebox profile (e.g. "kokoro"). Set alongside voiceboxProfileId by set_voice; a profile id without its engine will not speak. |

### `voiceboxProfileId`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | profile |
| Requires restart | no |
| Constraints | none |
| Description | Voicebox local-TTS profile id, used when ttsProvider is "voicebox". Use list_voices and set_voice rather than editing this directly. |

### `websiteUrl`

| Field | Value |
| --- | --- |
| Type | `string` |
| Default | `""` |
| Scope | app |
| Requires restart | yes |
| Constraints | pattern `/^(\|https?:\/\/.+)$/` |
| Description | Override the website host the app talks to (auth, sync, room URLs). Empty = use the production default (https://vibeconferencing.com). Set to a Vercel preview like https://vibeconferencing-git-BRANCH-lets-vibe.vercel.app to test against a feature branch. Takes precedence over syncBaseUrl. Must be a full http:// or https:// URL with no trailing slash. APP-LEVEL (#366): shared by all profiles on this machine. |

### `workingStateMinMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `2500` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `0`; maximum `30000` |
| Description | How long the agent must be continuously working before the avatar escalates from 🤔 thinking to 🧑‍💻 working (#339). Prevents a flicker on quick turns — the speak call is itself a tool, so without a dwell every reply would flash 🧑‍💻. Higher = 🧑‍💻 only for genuinely heads-down work; 0 = show it on the first tool. Read live. |

### `workingStateQuietMs`

| Field | Value |
| --- | --- |
| Type | `number` |
| Default | `8000` |
| Scope | profile |
| Requires restart | no |
| Constraints | minimum `1000`; maximum `60000` |
| Description | How long after the last agent activity before the 🧑‍💻/🤔 face eases back to listening/idle (#339). Held through a pending turn regardless. Read live. |

<!-- END GENERATED -->
