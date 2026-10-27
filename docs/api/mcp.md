# The MCP tools, and the endpoints under them

The app bundles an MCP server (`mcp-server/server.js`). It is a thin
client of the [local API](README.md): each tool is one or two HTTP calls.
If your agent already drives a bot through Claude Code or Codex, this is
what it has been doing. If you are building against the HTTP API directly,
this table tells you which endpoint does what a tool does.

`POST room` below means `POST /api/sync/{room}` with the sender envelope
and the named field or `meta.action`. `GET room` is `GET /api/sync/{room}`.

## How the MCP server finds a bot

| Env on the agent's process | Means |
| --- | --- |
| `VIBECONF_BASE_URL` | Which bot. Default `http://127.0.0.1:7865`. |
| `VIBECONF_BOT_NAME` | The name it joins under, and the `bot` on polls. |
| `VIBECONF_ROOM_ID` | A room to use when a tool is called without one. |
| `VIBECONF_SUPERVISOR_URL` | The directory. Default port `7864`. |
| `VIBECONF_PORT_RANGE` | Ports to scan when the directory is not answering. Default `7865-7910`. |

It reads the bearer token from `~/.vibeconferencing/local-tokens/<port>.token`
on every request. `join_call` with a `bot_name` re-points the session at
the bot with that profile or name, using the directory.

## Calls

| Tool | Endpoint |
| --- | --- |
| `join_call` | `POST room` with `meta.action` = `join` (Meet), `join-zoom`, `join-teams`, `join-slack` or `join-whatsapp`, picked from the link. Locks the bot name for the call. |
| `start_call` | `POST /api/call/start` |
| `leave_call` | `POST room` `meta.action: leave` |
| `end_session` | `POST room` `meta.action: end-session` |
| `get_room_info` | `GET /api/sync/no-room`, then `GET room`, plus the website's room record for members. |
| `list_call_instances` | `GET http://127.0.0.1:7864/api/instances`, falling back to a port scan of `GET /api/sync/no-room`. |

## Listening and speaking

| Tool | Endpoint |
| --- | --- |
| `wait_for_speech` | `GET room?wait=<≤55>&since=<last asOf>[&silence=]&bot=<name>` |
| `read_transcripts` | `GET room?since=` |
| `speak` | `POST room` `transcript: [{text, voice, emoji, urgency}]` |
| `bank_probe` | `POST /api/bank-probe` |
| `hold_voice`, `brief` | `POST /api/realtime/hold`, `POST /api/realtime/brief` (realtime voice only) |
| `set_caption_language` | `POST room` `meta.action: set-caption-language` |
| `list_voices`, `set_voice` | No endpoint for listing: the server reads the app's config and asks ElevenLabs, Voicebox and the OS directly. Setting is `POST /api/preferences`. |

## Whiteboard and share

| Tool | Endpoint |
| --- | --- |
| `update_whiteboard` | `POST /api/whiteboard-asset` for each `image_path`, then `POST room` `whiteboard: {content}` |
| `read_whiteboard` | `GET room` for the current board; `GET /api/whiteboard-history` with `history: true` |
| `set_whiteboard_style` | `POST room` `whiteboardStyle` |
| `reload_share` | `POST room` `reloadWhiteboard: true` |
| `load_url` | `POST room` `meta.action: load-url` |
| `start_share` (alias `share_whiteboard`) | Optional `set-share-title-bar` and `set-share-size`, then `share-whiteboard`; polls `GET room` until `status.sharing` |
| `share_tab` | `POST room` `meta.action: share-tab` (macOS) |
| `stop_sharing` | `POST room` `meta.action: stop-sharing` |
| `scroll_share`, `set_share_size`, `set_share_title_bar`, `set_share_audio` | `scroll-share`, `set-share-size`, `set-share-title-bar`, `set-share-audio` |
| `click_share`, `type_share`, `find_share_element`, `eval_share`, `inspect_dom`, `read_share_console`, `read_share_network` | `share-click`, `share-type`, `find-share-element`, `eval-share`, `inspect-dom`, `read-share-console`, `read-share-network` |
| `get_shared_screenshot` | `POST /api/shared-screenshot` |
| `list_fonts` | `GET /api/fonts` |

## Chat, behaviour, memory

| Tool | Endpoint |
| --- | --- |
| `read_chat`, `send_chat` | `POST /api/chat` with `action: read` or `action: send` |
| `set_mode` | `POST room` `meta.action: set-mode` |
| `set_camera` | `POST room` `meta.action: set-camera` |
| `set_avatar_emoji` | `POST room` `meta.action: set-avatar-emoji` |
| `play_audio`, `play_sound` | `POST room` `meta.action: play-audio` / `play-sound` |
| `get_working_memory`, `post_understanding` | `GET` / `POST /api/working-memory` |
| `list_preferences`, `set_preference` | `GET` / `POST /api/preferences` |
| `suggest_bot_names`, `list_visual_assets` | `GET /api/name-suggestions`, `GET /api/visual-assets` |

## Recording and diagnostics

| Tool | Endpoint |
| --- | --- |
| `start_recording`, `stop_recording` | `POST /api/call/record` with `on: true` / `false` |
| `get_call_screenshot` | `POST /api/call-screenshot` |
| `get_session_log` | `GET /api/session-log`; with `instance`, the website's log store instead |
| `get_call_log` | `GET /api/call-log?callId=` |
| `list_log_instances` | The website's log store, not the local API |

## What the MCP layer adds

Beyond the endpoints, the server keeps a little state per agent session:
the room it joined, the bot name it locked, and the `since` cursor between
polls. Its tool descriptions also carry the conversational contract (keep
calling `wait_for_speech`, keep spoken lines short, when to go passive),
which the HTTP API does not impose. If you build a client of your own, that
contract is the part worth copying.
