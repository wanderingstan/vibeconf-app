# Preferences

Every persisted setting the bot exposes to agents lives in `electron-app/preferences-schema.js`. Anything not in that schema (auth cookies, API keys) is invisible to the agent even though it lives in the same `config.json`.

## How to read or change them

| From | How |
|---|---|
| **Panel UI** | Open the app's panel window → cog icon (top right) → Settings. Most user-facing prefs have a labeled input. |
| **Claude / Codex / MCP** | `list_preferences` returns all keys with current values, defaults, types, and descriptions. `set_preference({key, value})` writes one. |
| **Config file** | `~/Library/Application Support/Vibeconferencing/config.json` (or `…/profiles/<name>/config.json` for a profiled instance). Hand-edit only if the app is closed. |

The schema is authoritative — this page is generated from it. If the two diverge, the schema wins.

## Reference

### Acknowledgment ("got it") behavior

When a human finishes speaking and the bot is thinking, it can optionally play a short ack before its real response so the user knows it heard them. The thresholds and phrases are tunable.

| Key | Type | Default | What |
|---|---|---|---|
| `ackShortMin` | number | 20 | Word count below which the bot skips the ack entirely (the thinking emoji is enough feedback for very short prompts). |
| `ackLongMin` | number | 50 | Word count at or above which the bot uses a longer "let me think" ack instead of a short "got it." |
| `ackShortPhrases` | string[] | `Mm-hmm.`, `Okay.`, `Got it.`, `Right.`, `Yeah.`, `Sure.`, `Mhm.`, `Cool.`, `Gotcha.`, `Right, right.`, etc. | Phrases the bot picks from at random when the prompt is between `ackShortMin` and `ackLongMin` words. |
| `ackLongPhrases` | string[] | `Let me think about that.`, `Give me a moment.`, `Hmm, good question.`, `Let me chew on that.`, etc. | Phrases the bot picks from at random when the prompt is ≥ `ackLongMin` words. |

Tuning: ask the bot ("add 'sure thing' to your short acks") or `set_preference` directly.

### Bot identity

| Key | Type | Default | Restart? | What |
|---|---|---|---|---|
| `botName` | string | `Jimmy` | ✓ | Display name in Meet. Takes effect on the next call. |
| `ttsVoiceId` | string | `''` (empty = macOS TTS) | — | ElevenLabs voice ID. Empty = use the macOS built-in TTS. Prefer `list_voices` / `set_voice` for in-call swaps. |

### Avatar

| Key | Type | Default | What |
|---|---|---|---|
| `avatarBackgroundSvg` | string | `''` | SVG source rendered behind the avatar emoji. Empty = default animated gradient. The SVG can reference external `<image href='file:///…' / 'https://…'>` — the app inlines those into data URIs server-side, so no manual base64. SVG/CSS animations don't tick (rasterized once); the emoji's bounce provides motion. Use for backgrounds, nameplates, debug overlays. Max 1,000,000 chars. |

Avatar emoji overrides (`idle` / `listening` / `yielding`) are *not* persistent preferences — they're per-call via the `set_avatar_emoji` MCP tool.

### Networking

| Key | Type | Default | Restart? | What |
|---|---|---|---|---|
| `websiteUrl` | string | `''` (uses `https://vibeconferencing.com`) | ✓ | Override the website host for auth / sync / room URLs. Useful for pointing at a Vercel preview branch (`https://vibeconferencing-git-BRANCH-lets-vibe.vercel.app`) without rebuilding. Must be a full `http://` or `https://` URL with no trailing slash. |
| `syncBaseUrl` | string | `''` | ✓ | **Legacy.** Same purpose as `websiteUrl`, kept as fallback for older configs. Prefer `websiteUrl`. |

### Conversation timing knobs

Live-tunable thresholds that shape the bot's conversational rhythm. All read on every consultation, so `set_preference` takes effect immediately — no app restart. Per-profile, so different bot personas can carry different feels (a snappy interviewer vs. a patient note-taker).

| Key | Type | Default | What |
|---|---|---|---|
| `bargeInGraceMs` | number | `1500` | How long the bot waits after detecting a human interruption before actually stopping its TTS. **Only read when `bargeInUrgencyScaling` is off** — and it defaults to ON, so out of the box this value is inert and the live grace comes from the min/max pair below. |
| `bargeInUrgencyScaling` | boolean | `true` | Scale the barge-in grace by the utterance's self-scored urgency instead of using the fixed `bargeInGraceMs`. On by default. |
| `bargeInGraceMinMs` | number | `900` | Grace for a zero-urgency (filler) utterance — the bot cedes the floor fastest here. |
| `bargeInGraceMaxMs` | number | `2400` | Grace for a max-urgency utterance. |

**How the scaled grace works:** `ms = min + urgency × (max − min)`, linear, with unscored utterances treated as `0.5`. With the defaults above that gives:

| urgency | grace | rides out (of 850 measured overlaps, #422) |
|---|---|---|
| 0.0 — filler | 900ms | 87.7% |
| 0.4 — a normal answer | **1500ms** | 95.8% |
| 1.0 — house on fire | 2400ms | 98.5% |

Overlap durations in real conversation run p50 400ms, p90 1100ms, p99 2680ms — so most overlap is backchannel, and the grace exists to ride that out without outlasting someone who genuinely wants the floor. The previous `4000ms` ceiling cleared over 99% of *all* overlap, meaning a high-urgency utterance effectively never yielded.
| `bargeInBotRandomMinMs` | number | `1000` | When two bots try to speak simultaneously, each waits a random delay in `[min, max]` before committing — prevents lockstep collision. Floor of that range. |
| `bargeInBotRandomMaxMs` | number | `4000` | Ceiling of the bot-vs-bot random-delay range. |
| `bargeInStashMaxAgeMs` | number | `45000` | When the bot yields mid-thought to a human, its queued speech is stashed. On the next silence gap, if the stash is younger than this, the bot auto-replays it (skipping a slow-model round-trip). Older than this, the stash is discarded and the slow model regenerates fresh. |
| `captionDropoutGraceMs` | number | `2000` | Reserved for caption-dropout detection (#187); not currently wired into logic. |
| `defaultSilenceSeconds` | number | `1.4` | Default silence threshold for `wait_for_speech` if the agent doesn't pass one. Higher = bot patiently lets users compose longer thoughts; lower = snappier. |
| `defaultMaxWaitForSpeechSec` | number | `55` | Maximum seconds `wait_for_speech` long-polls before returning empty. Default just under typical HTTP timeouts. Raise only if you have a reason. |
| `speakingDetectionMode` | string | `mutation` | Which per-participant speaking signal the DOM tracker's verdict comes from: `mutation` (count tile mutations, 3 in 1200ms — ~300-600ms late), `meter` (read Meet's mic meter as a level from `background-position-x` — flips on the first sample after onset), or `either` (OR of the two). Both signals always run and always log, so this only picks the verdict. A meter that hasn't been found or hasn't moved yet reports nothing and falls back to mutation counting, so no setting makes the tracker deafer. Defaults to `mutation`: the meter only buys ~300ms but fires on *any* sound reaching the mic, so a human on laptop speakers hears the bot's own TTS come back in and the tracker reads it as that human interrupting — cutting the bot off mid-sentence. A slow start is invisible; a false cut-off is not. Set `either` when everyone is on headphones. See #142. |

**A/B testing different feels.** Set up two profiles with different values, switch with `--profile=<name>`, talk to each. Saved per-profile so swaps are durable.

**Live tuning during a call.** Ask the bot directly: *"set bargeInGraceMs to 500 for this session."* The slow model will call `set_preference` and the next barge-in evaluation uses the new value.

## Adding a new preference

In `electron-app/preferences-schema.js`:

```js
const PREFERENCES = {
  // …
  myNewPref: {
    type: 'number',           // 'number' | 'string' | 'boolean' | 'string[]'
    default: 42,
    min: 0,                   // optional, type-specific
    max: 100,
    description: 'What this knob does, including units and edge cases.',
    requiresRestart: true,    // optional — set if the app reads it only at startup
  },
};
```

Then read it via `store.get('myNewPref') ?? PREFERENCES.myNewPref.default` at the call site. The MCP server's `list_preferences` and `set_preference` automatically pick it up.

For secrets, intentionally do *not* add them to this schema — they live in the same `config.json` but stay invisible to agents.
