# Modes & states

The bot has two layered notions of behavior:

- **Mode** — what the bot will *do* in the call (active / passive / silent). Persistent, user-controlled.
- **State** — what the bot is *doing right now* in the conversation (idle / listening / thinking / speaking / yielding). Transient, internal.

Both surface on the avatar emoji so you can see at a glance what's happening.

## Modes

| Mode | Resting emoji | Behavior |
|---|---|---|
| **active** (default) | 🙂 | Responds on every conversational pause. The chatty default — good for thinking-partner calls. |
| **passive** | 🤐 | Listens silently. Only speaks when its name is mentioned. Good when the bot should stay out of the way most of the time. |
| **silent** | 😶 | Listens and can act (update whiteboard, call MCP tools) but *never* speaks aloud. Good for shared rooms where bot TTS would be disruptive. Subtitles still appear on the bot's avatar. |

Set via the MCP `set_mode` tool, or from the panel UI. Mode persists across the session — the user can ask the bot to "go silent" or "be active again" at any time.

## States

States are computed in `local-server.js` based on what's happening in the call. They're broadcast to the avatar renderer in `electron-app/page-inject.js`.

| State | Default emoji | When |
|---|---|---|
| **idle** | 😔 | Between turns. The bot has nothing queued and no one is currently being processed. |
| **listening** | mode emoji (🙂 / 🤐 / 😶) | A `wait_for_speech` long-poll is active and the bot is ready to receive. |
| **thinking** | 🤔 | The agent has received transcribed speech and is computing a response. No audio yet. |
| **speaking** | 😄 | TTS audio is currently playing in the call. |
| **yielding** | 🙋 | The bot has something to say but is *holding back* because a human is currently speaking. Introduced to make "biting its tongue" legible — without it, this looked indistinguishable from idle. |

### Other situational emojis

| Emoji | When | Notes |
|---|---|---|
| 🫥 | Call not joined yet, or joined but not yet engaged | Suppresses everything else. Resets at the start of each new call. |
| 😐 | Someone is currently speaking (and the bot isn't doing anything more specific) | Visual ack that the bot heard them. Suppressed in silent mode. |

### Render-order precedence

When multiple signals are active, the avatar picks the first one in this order (top wins):

1. **Not on the line** — 🫥 if `callStatus` isn't `in-call`, or if `hasEngaged` is false.
2. **Audio playing** — per-response speak emoji (if `speak({emoji: …})` was called) → default 😄. Wins over `thinking` so the speaking face shows during TTS-ack audio.
3. **Activity emoji** — `yielding` (🙋) > `thinking` (🤔) > `speaking` (😄, when activity-routed). Yielding wins over hearing so "wants to speak but holding back" is legible.
4. **Hearing** — 😐 if `anyoneSpeaking` and no more specific state.
5. **Idle** — 😔 (between turns).
6. **Listening** — mode emoji (🙂 / 🤐 / 😶).

### Agent overrides

The `set_avatar_emoji` MCP tool lets the agent override resting emojis to match conversation tone. Three keys:

- `idle` — replace the 😔 between-turns face. E.g. ask a somber-topic bot to set 😔 → 😔 (unchanged) or 😟.
- `listening` — replace the mode-emoji at rest (active mode only — passive/silent emojis encode a specific user-controlled state, so they aren't overridden).
- `yielding` — replace the 🙋 wants-to-speak face. E.g. 🤐, ✋.

Overrides are per-call (not persisted). Pass an empty string to revert any key to default.

The per-response `speak({emoji: '😂'})` parameter does a similar thing for the TTS-playing emoji, but only for that one utterance.

## How modes and states interact

| | active | passive | silent |
|---|---|---|---|
| Will speak on a pause? | Yes | Only if named | Never |
| `listening` resting emoji | 🙂 | 🤐 | 😶 |
| Subtitles on avatar? | When the user toggles "bots silent" in the bottom bar | When the user toggles silent OR mode = passive without a name match | Always |
| Camera default | On | On | On (but the user often wants `set_camera('off')` here) |
| Audio ack ("Got it.") plays? | Yes | When speaking | Never |

## Picking the right mode

| Situation | Mode |
|---|---|
| Pair-thinking session, 1-2 humans | active |
| Team meeting where the bot should mostly observe | passive |
| Bot is a note-taker / whiteboard editor, humans want full conversational floor | silent |
| The bot should react silently with the whiteboard but not interrupt with audio | silent |
| Quick switch mid-call ("be quiet for a minute") | passive (recovers automatically when named) |

The user can ask the bot to switch ("go silent", "stop interrupting", "speak up again"), or do it from the panel.
