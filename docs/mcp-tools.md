# MCP tools

The MCP server (`mcp-server/server.js`) exposes these tools to any MCP-speaking agent. Each one is a thin HTTP call to the Electron app's local server. This page is the user-facing reference; the canonical descriptions live in the `server.tool(…)` calls in `mcp-server/server.js`.

Call-scoped tools accept an optional `room_id` argument, falling back to `VIBECONF_ROOM_ID` from the environment. Discovery, preference, voice, setup, recording, and logging tools have their own schemas — the registered parameters in `server.js` are authoritative.

## Joining / leaving

| Tool | What |
|---|---|
| **`join_call`** | Join a call — a Google Meet (pass the **meet code**, `xxx-xxxx-xxx`) or a **Slack huddle** (pass the huddle URL). Optional `bot_name` routes to a running profile; `force` rebuilds a wedged session (tears down a working call — default false makes repeat joins a no-op). |
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
| **`speak`** | Say something aloud via TTS. Keep messages concise — they're spoken in real time. Optional: `emoji` (avatar face for this response), `voice` (one-off voice override), and `urgency` 0–1 — the interruption gate: below 0.5 the reply waits for a gap; at or above it may play over a speaker. 0.4 is a normal answer. |
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
| **`update_whiteboard`** | Set whiteboard content. Supports markdown + Mermaid. Pass `image_path` (absolute) to embed a local image — it gets registered with the local server and embedded automatically. |
| **`load_url`** | Load an arbitrary web page (website, localhost app, dashboard) into the bot's share window, instead of markdown content. |
| **`start_share`** | The primary sharing tool: present the bot's whiteboard into Meet, with optional size and title-bar control. (`share_whiteboard` remains as a compatibility alias.) |
| **`stop_sharing`** | Stop screen-sharing. |
| **`scroll_share`** | Scroll the content currently being shared — URL or rendered markdown alike. `direction: down/up/top/bottom`. |

## Avatar & camera

| Tool | What |
|---|---|
| **`set_camera`** | Turn the bot's camera on or off — boolean `on` parameter (`{ on: false }`), not a string. Off saves bandwidth and hides the avatar video; the avatar overlay state keeps running independently. |
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

## Previously undocumented tools

One-line index, grouped; the canonical description for each is its `server.tool(…)` registration.

### Starting and routing

| Tool | What |
|---|---|
| **`start_call`** | Start a BRAND-NEW call: creates a fresh Google Meet that anyone with the link can join, sends the bot into it, and opens the user's own… |
| **`list_call_instances`** | List the Vibeconferencing app instances (profiles) currently running on this machine — each is a separate bot on its own local-server port. |

### Showing and driving the share

| Tool | What |
|---|---|
| **`start_share`** | Start screen-sharing into the Google Meet call so participants can see it. |
| **`share_tab`** | Share a SPECIFIC browser tab into the Google Meet by its URL — ideal for showing the room the exact page you're browsing with the Chrome… |
| **`set_share_size`** | Resize the shared board. |
| **`set_share_title_bar`** | Show or hide the title bar on the window you are screen-sharing. |
| **`set_share_audio`** | Mute or unmute the sound coming from what you're screen-sharing, without stopping the share. |
| **`click_share`** | Click inside whatever the bot is screen-sharing — a real mouse event, so the page reacts exactly as it would to a person. |
| **`type_share`** | Type into whatever the bot is screen-sharing — real key events, so autocomplete, validation and keyboard shortcuts all behave normally. |
| **`inspect_dom`** | Inspect the live DOM of the bot's Google Meet call, or of whatever it's currently screen-sharing into the call — returns the matched… |
| **`get_shared_screenshot`** | Capture a screenshot of the bot's OWN shared screen — the whiteboard it's currently presenting into the call — and save it to a temporary… |
| **`read_whiteboard`** | Read the current contents of the shared whiteboard — the markdown/Mermaid source text, not a screenshot. |
| **`set_whiteboard_style`** | Restyle the shared whiteboard with custom CSS — colors, fonts, spacing, backgrounds. |
| **`reload_share`** | Force the share window to refresh WITHOUT changing its content — re-fetches whatever's currently shared (whiteboard or a `load_url` page) and re-renders it. |

### Sound

| Tool | What |
|---|---|
| **`play_audio`** | Play an audio file INTO the Google Meet call through the bot's virtual mic — everyone hears it. |

### Recording

| Tool | What |
|---|---|
| **`start_recording`** | Record the current call to disk — one audio file per track (the bot's own voice plus each remote participant's audio, which Meet sends separately) plus video of the bot's own Meet view, muxed to one mp4 on stop… |
| **`stop_recording`** | Stop the call recording started by start_recording (or by the recordCallAudio pref) — finalizes the per-track audio + video files and… |

### Working memory (active listening)

| Tool | What |
|---|---|
| **`get_working_memory`** | Read the bot's private working memory for this call: 'understanding' (the running read of what's being discussed) and 'stance' (its point of view)… |
| **`post_understanding`** | Update the bot's private working memory for this call. |
| **`bank_probe`** | Active listening: stash a SHORT (2–6 word) interjection the bot may say at the next natural opening in the conversation |

### Logs and setup

| Tool | What |
|---|---|
| **`get_call_log`** | Get just one call's slice of this machine's session log — the events between that call's start and end markers, with no earlier or later… |
| **`list_log_instances`** | List remote Vibeconferencing instances that are shipping their session logs to the backend (machines/bots with the remoteLogging pref on). |
| **`suggest_bot_names`** | A list of candidate names for this bot, from the app's own curated pool — the same one the panel's name spinner draws from. |
| **`list_visual_assets`** | Absolute paths to the sample art bundled with the app: one smiling face per emoji set, and every background preset. |
| **`list_fonts`** | Font families installed on the machine running the app. |
