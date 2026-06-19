---
name: join-call
description: Join the user's current Google Meet call as an AI bot participant
argument-hint: "[room_code] [BotName]  — or just [BotName] to auto-detect"
disable-model-invocation: true
allowed-tools: Bash Read mcp__vibeconferencing__get_room_info mcp__vibeconferencing__join_call mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_mode mcp__vibeconferencing__set_camera mcp__vibeconferencing__get_call_screenshot mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__leave_call mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__stop_sharing mcp__vibeconferencing__scroll_share mcp__vibeconferencing__inspect_dom mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__get_working_memory
---

Join the user's current Google Meet call as an AI bot participant.

## Step 1: Determine the room code and bot name

Parse `$ARGUMENTS` for a meet code (pattern: `xxx-xxxx-xxx`). If found, use it directly and skip detection. Any non-code argument is the bot name.

**If no bot name is in `$ARGUMENTS`**, check your loaded `CLAUDE.md` context for a persona / character name. If the project's CLAUDE.md describes you as a specific character (e.g. "You are Coltrane, a jazz facilitator…"), use that name as your bot name. The persona name becomes your Meet display name AND your conversational identity. Pass it to `join_call` via the `bot_name` parameter — the app persists it before navigating to Meet, so it'll appear correctly in the participant list.

If neither `$ARGUMENTS` nor CLAUDE.md supplies a name, fall back to the user's configured `botName` preference (default: "Jimmy").

Examples:
- `/join-call abc-defg-hij` -> room code `abc-defg-hij`, name from CLAUDE.md persona or "Jimmy"
- `/join-call abc-defg-hij Stanbot` -> room code `abc-defg-hij`, bot name "Stanbot" (arg wins over CLAUDE.md)
- `/join-call Stanbot` -> auto-detect room, bot name "Stanbot"
- `/join-call` -> auto-detect room, name from CLAUDE.md persona or "Jimmy"

**If no room code in arguments**, first check if the Vibeconferencing app has already detected a call:

Call `get_room_info` (no room_id needed). Its response tells you one of three things:

1. **The app is already in a call** — the reply will be a full room info block that starts with `Room: xxx-xxxx-xxx` and includes a `Call status:` line (e.g. `in-call`, `joining`, `waiting-to-be-admitted`). This is authoritative — use that room code and skip detection entirely.
2. **Detected Meet URLs** — the reply starts with `Not in a call. Detected Google Meet URLs:`. Extract the meet code from the first URL.
3. **Nothing detected** — fall back to AppleScript below.

Authoritative active-call info wins over detected URLs: detected URLs come from a separate periodic scan of Chrome/Brave tabs and can go stale once the app has joined. If `get_room_info` reports an active room, use it and do NOT second-guess with AppleScript.

AppleScript fallback (only when `get_room_info` returns no active call and no detected URLs):
```
osascript -e 'tell application "System Events"
  set chromeRunning to exists process "Google Chrome"
  set braveRunning to exists process "Brave Browser"
end tell
set allURLs to ""
if chromeRunning then
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with "https://meet.google.com/" then
          set allURLs to allURLs & URL of t & linefeed
        end if
      end repeat
    end repeat
  end tell
end if
if braveRunning then
  tell application "Brave Browser"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with "https://meet.google.com/" then
          set allURLs to allURLs & URL of t & linefeed
        end if
      end repeat
    end repeat
  end tell
end if
allURLs'
```

Extract the meet code (the `xxx-xxxx-xxx` part). If no valid Meet URL found, ask the user to paste one.

## Step 2: Ensure the app is running and in the call

```
curl -sf "${VIBECONF_BASE_URL:-http://127.0.0.1:7865}/api/sync/no-room" >/dev/null && echo "RUNNING" || echo "NOT_RUNNING"
```

(Checks whether the app instance configured for this MCP client is reachable. `VIBECONF_BASE_URL` may point at a non-default port when multiple local app instances are running. A bare `pgrep Vibeconferencing` is unreliable — it matches orphaned MCP server processes from past sessions, giving false positives.)

- If **NOT_RUNNING**: Launch it:

```
open -a Vibeconferencing \
  --meet-url=https://meet.google.com/<ROOM_CODE> \
  --bot-name="<BOT_NAME>" &
disown
```

- If **RUNNING**: Call `get_room_info` with the room code as `room_id` and check `Call status`:
  - `in-call`: Already joined — go to Step 3.
  - `idle` or `left`: App is running but not in this call. Call `join_call` with the room code to tell the app to navigate to the Meet and join.
  - `joining` or `waiting-to-be-admitted`: The app is in the process of joining. Go to Step 3 — the long-poll will block until speech arrives after admission.

## Step 3: Start the conversation loop

Don't wait for admission — the long-poll will block until speech arrives. Use the meet code as `room_id` for all MCP tool calls.

1. **First-turn greeting (active mode only):** Before the first `wait_for_speech`, call `speak` with a brief, friendly self-introduction (1 sentence — e.g. "Hi everyone, [bot name] here, ready when you are."). This replaces the old canned welcome and gives users an audible cue that the agent is on the line. Skip this in passive or silent mode — those modes don't speak unbidden.
2. Call `wait_for_speech` to listen (blocks until someone speaks and pauses)
3. Respond naturally using `speak` — keep it to 1-2 sentences since it's spoken aloud. You can also pass an `emoji` parameter to match the tone of your response: 😂 for funny, 😟 for sympathetic/concerned, 😎 confident, 🤓 technical, 🤔 uncertain. Skip for normal/neutral responses (default 😄). Use `set_avatar_emoji` to change your idle/listening/yielding emojis when the conversation tone shifts (e.g. 😔 idle for a somber topic).
4. If the conversation involves visual content (code, diagrams, lists), also call `update_whiteboard` with markdown or Mermaid
5. Go back to step 2

Guidelines:
- Be a helpful, natural conversational participant
- Keep spoken responses short — people can ask you to elaborate
- **Showing the whiteboard is TWO steps.** `update_whiteboard` only sets the *content* — it does NOT make participants see it. To actually present it on screen you must ALSO call `share_whiteboard` (once per call; after that, `update_whiteboard` changes update live in the shared view). So when a user asks you to "share/show your screen" or "put X on the screen", call `update_whiteboard` to set the content AND `share_whiteboard` to present it. If you're already presenting, you only need `update_whiteboard`.
- Use the whiteboard for anything visual (code, diagrams, structured info)
- If someone says goodbye or asks you to leave, say goodbye via `speak`, then call `leave_call` to hang up. Then stop the loop.
- If `wait_for_speech` times out with no speech, call it again — people may just be quiet. The bot may still be joining the Meet call or waiting to be admitted. Do NOT relaunch the app or check `get_room_info` — just keep calling `wait_for_speech`.
- **Never silently double-poll.** If `wait_for_speech` returns ANY transcript content — even a fragment like "Now when you..." that ends mid-thought — you MUST call `speak` before the next `wait_for_speech`. Use a brief continuation prompt for fragments ("Go on?", "And...?", "What were you about to say?"). From the user's side, your silence after they spoke looks identical to a hung session. Only consecutive timeouts (no transcript content) are okay to chain without speaking.
- **Exception — continuation of what you already answered.** If `wait_for_speech` appends the note "this continues what you already responded to", the speaker is just extending the same thought you just replied to (captions kept growing). In that case do NOT respond again unless it adds genuinely new information — call `wait_for_speech` again without speaking. This is the one case where chaining on transcript content is correct; it prevents responding twice to one utterance.
- **If `wait_for_speech` returns "Session displaced: another agent started listening on this call.", STOP IMMEDIATELY.** Do not call `wait_for_speech` again, do not call `speak`, do not call `leave_call` — another Claude session has taken over the call. Tell the user the session was displaced and exit the loop. This prevents two agents fighting for the same call (which causes double responses).
- **If `wait_for_speech` returns "Call failed: the bot couldn't enter the Meet ...", STOP IMMEDIATELY.** Meet refused admission or removed the bot. Do not retry, do not call `speak` (no one is listening), do not call `leave_call` (the app has already cleaned up). Tell the user the join failed and exit the loop.
- **If `wait_for_speech` returns "Auto-left the call: everyone else left ...", STOP IMMEDIATELY.** The bot was alone in the call and signed off on its own. The app has already hung up — do not call `wait_for_speech`, `speak`, or `leave_call` again. Tell the user everyone else left and exit the loop.
- If someone asks you to change your voice, use `list_voices` to see options, then `set_voice` to change it. You can also use the `voice` parameter in `speak` for a one-off voice change. Have fun with it!
- **The whiteboard has a shareable URL.** If someone asks for the whiteboard link, call `get_room_info` and share the `Whiteboard URL (just the board…)` value (the `?mode=whiteboard` one) via `send_chat` — that's the clean board-only view. The separate full room URL is only for joining the whole room UI; don't share that when they just want the whiteboard.
- **You can read and write the Meet chat.** `wait_for_speech` appends `[Unread chat messages — call read_chat …]` whenever there's unread chat, so the natural flow is: when a lull surfaces that notice, call `read_chat`, then respond to whatever was said (aloud and/or in chat). This way you check chat at speech pauses and don't miss anyone talking. You can also `read_chat` whenever someone says they posted something. Use `send_chat` for things awkward to say aloud — links, code snippets, the room URL — or to respond in text while in silent mode. Both briefly open the chat pane (pausing speaker detection for ~1s) then reopen the people pane automatically, so use them deliberately rather than polling `read_chat` in a loop.
- **You can see what's on screen.** Call `get_call_screenshot` to capture the Meet view (participant tiles, captions, shared screen content, Meet chrome) as a PNG saved to disk. It returns the absolute path; read the file with your normal image tool to actually look at it. Reach for this when you need visual context — what someone is screen-sharing, who's on camera vs off, whether the people pane has someone with a raised hand, what a participant is reacting to. Don't spam it — it's a "look when you need to" tool, not a continuous feed.
- **Your background is customizable.** The `avatarBackgroundSvg` preference takes any SVG and renders it behind your emoji. The app auto-inlines external image references, so you can write `<image href="file:///path/to/img.png">` or an https URL directly — no base64 needed. Use it for name plates, debug overlays, themed backgrounds, or anything visual to enrich your presence in the call. Set via `set_preference("avatarBackgroundSvg", "<svg...>")`; empty string restores the default gradient.
- NEVER kill or relaunch the Vibeconferencing app during the conversation loop. If speech isn't coming through, keep polling — the app handles joining automatically.
- **Working memory (maintained for you in the background).** The app keeps a small private read of the conversation — `understanding` (what's being discussed), `stance` (the point the bot would make if the floor opened now), and `people` (who's in the call and what matters about them). This is the bot's internal mind, NOT the shared whiteboard, and it's refreshed automatically in the background as people talk — **you don't maintain it.** You may call `get_working_memory` to read it when it's useful — especially when you're suddenly called on after sitting quiet for a while, to orient fast — but treat it as a helpful sketch, not a script: always author your own reply. (You have no tool to write it; that's intentional for this experiment.)

### Behavior modes

The bot has three persistent modes — use `set_mode` when the user asks you to change how you participate:

- **`active`** (default): respond on every pause. Best when the user wants a full participant.
- **`passive`**: stay silent until your name is mentioned. Use when the user says things like "be quiet", "only speak when spoken to", "stop interrupting", "just listen".
- **`silent`**: listen and still act on requests (update the whiteboard, run tools, edit files) but never speak aloud. Use when the user says "go silent", "no more talking", "stop speaking but keep listening".

`wait_for_speech` still returns when your name is mentioned in any mode, so you can hear requests to switch back. When the user asks you to resume normal participation ("you can talk again", "be active"), call `set_mode` with `active`.

Key behaviors by mode:
| Mode | Resolves on silence | Resolves on name | Speaks | Acts (whiteboard/tools) |
|---|---|---|---|---|
| active | yes | yes | yes | yes |
| passive | no | yes | yes (when resolved) | yes |
| silent | no | yes | no (suppressed) | yes |

If you call `speak` while in silent mode, the server returns `{ ok: false, reason: 'mode-silent' }` — don't retry; the user asked for silence.

If `speak` returns "Speech dropped — the user started speaking before your response could play", a user began talking after you decided to respond. Don't retry the same message — call `wait_for_speech` to hear what they said and respond to that instead.
