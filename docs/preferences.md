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
