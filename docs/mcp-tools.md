# MCP tools

The MCP server (`mcp-server/server.js`) exposes these tools to any MCP-speaking agent. Each one is a thin HTTP call to the Electron app's local server. This page is the user-facing reference; the canonical descriptions live in the `server.tool(…)` calls in `mcp-server/server.js`.

All tools accept an optional `room_id` argument. If omitted, the MCP server uses `VIBECONF_ROOM_ID` from the environment.

## Joining / leaving

| Tool | What |
|---|---|
| **`join_call`** | Navigate the app to a Meet URL and join. Use when the app is open but not yet in a call. |
| **`leave_call`** | Hang up. If after-call work is enabled the bot enters that phase rather than shutting down; the reply says so. |
| **`end_session`** | Finish after-call work and release the app. Call it as soon as the wrap-up is done — the app holds the room, transcript and terminal open until you do. |
| **`get_room_info`** | The primary "what's happening" query. Returns participants, speaker state, sharing status, errors, detected Meet URLs (when not in a call), local server URL, profile name, session log path. Call this first whenever you're unsure of state. |

## Listening

| Tool | What |
|---|---|
| **`wait_for_speech`** | Long-poll. Blocks until someone in the call finishes speaking (a pause). Returns the complete transcript of what was said. Much more efficient than polling `read_transcripts`. Use this as the main listen loop. |
| **`read_transcripts`** | Read recent transcripts non-blocking. Pass `since` (an ISO timestamp from a previous response's `asOf` field) for incremental updates. |

## Speaking

| Tool | What |
|---|---|
| **`speak`** | Say something aloud via TTS. Keep messages concise — they're spoken in real time. Optional `emoji` parameter sets the avatar face for this response (😂 funny, 😟 concerned, 😎 confident, 🤓 technical, 🤔 uncertain). Default 😄. |
| **`list_voices`** | List available TTS voices. Shows ElevenLabs voices if an API key is configured, otherwise macOS system voices. |
| **`set_voice`** | Change the bot's TTS voice. Persists. |

## Chat

| Tool | What |
|---|---|
| **`read_chat`** | Read Meet's text chat. Use when `get_room_info` reports unread chat, or when someone says "I posted X in chat". Briefly opens the chat pane (~1s); speaker detection pauses then resumes automatically. |
| **`send_chat`** | Post a message into Meet's text chat. Good for things awkward to say aloud — links, code snippets, room URLs — or to respond in text when in silent mode. Same ~1s pane-flip caveat. |

## Whiteboard

| Tool | What |
|---|---|
| **`update_whiteboard`** | Set whiteboard content. Supports markdown + Mermaid. Can also load an arbitrary URL (website, localhost app, dashboard) via the `url` field instead of `content`. Pass `image_path` (absolute) to embed a local image — it gets registered with the local server and embedded automatically. |
| **`share_whiteboard`** | Start screen-sharing the whiteboard window into Meet. Optional flag to share the whole screen instead. |
| **`stop_sharing`** | Stop screen-sharing. |
| **`scroll_share`** | Scroll the content currently being shared. Useful when a long URL is loaded. `direction: down/up/top/bottom`. Only affects shared URLs, not markdown content. |

## Avatar & camera

| Tool | What |
|---|---|
| **`set_camera`** | Turn the bot's camera on or off. Off saves bandwidth and hides the avatar video; the avatar overlay state (emoji, animation) keeps running independently. |
| **`set_avatar_emoji`** | Override resting emojis (`idle`, `listening`, `yielding`) for the rest of the call. Pass an empty string for a key to revert to the default for that state. See [modes-and-states.md](modes-and-states.md) for what each state means. |

## Behavior

| Tool | What |
|---|---|
| **`set_mode`** | Switch the bot's persistent behavior mode. `active` = responds freely on every pause (default). `passive` = silent until its name is mentioned. `silent` = listens and can act (whiteboard, tools) but never speaks. See [modes-and-states.md](modes-and-states.md). |
| **`set_caption_language`** | Set the language the bot LISTENS in, by changing Meet's "Language of the meeting" caption setting. Not cosmetic: the bot hears the room by reading Meet's captions, so a mismatch means it hears nonsense and answers it rather than falling silent. Meet has no host-level control — each participant sets their own — so the bot sets its own. Takes a BCP-47 tag (`de-DE`, `es-ES`, `en-GB`); a bare `de` resolves to the first regional variant Meet lists. |

## Preferences

| Tool | What |
|---|---|
| **`list_preferences`** | All user-modifiable preferences with current values, defaults, types, and descriptions. Secrets are not exposed. See [preferences.md](preferences.md) for the full schema. |
| **`set_preference`** | Modify a preference. Value must match the preference's type. Confirm with the user before irreversible-feeling settings; obvious requests don't need confirmation. |

## Debug / diagnostics

| Tool | What |
|---|---|
| **`get_session_log`** | Recent lines from the Electron app's session log. Each session writes to `userData/logs/session-{ts}.log` and the path is also in `get_room_info`'s `status.sessionLogPath`. Optional `grep` filters by case-insensitive regex (e.g. `'screen\|share\|present'` to focus on screen-share lines). Use this to post-mortem mid-call weirdness without scrambling to capture terminal output. |
| **`get_call_screenshot`** | Capture a screenshot of the Meet view as the bot sees it (participant tiles, names, mic icons, captions, shared content, surrounding Meet chrome). Returns an absolute path to a PNG. After receiving the path, read the file with your normal image-reading tool to actually look at it. |

## Patterns

**Main loop for an active bot:**

```
loop:
  result = wait_for_speech()
  if no one spoke: continue
  read_chat() if get_room_info shows unread
  speak("response")
  update_whiteboard if needed
```

**Bot that responds only when named:**

```
set_mode("passive")
loop:
  wait_for_speech()      # only returns matches involving the bot's name
  speak(...)
```

**Two-bot collaboration:** each bot has its own MCP server, its own local-server port, its own profile. They see the same Meet captions and same whiteboard (via the shared remote sync) — coordinate verbally just like humans would.
