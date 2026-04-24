---
name: join-call
description: Join the user's current Google Meet call as an AI bot participant
argument-hint: "[room_code] [BotName]  — or just [BotName] to auto-detect"
disable-model-invocation: true
allowed-tools: Bash mcp__vibeconferencing__get_room_info mcp__vibeconferencing__join_call mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__leave_call mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__stop_sharing
---

Join the user's current Google Meet call as an AI bot participant.

## Step 1: Determine the room code

Parse `$ARGUMENTS` for a meet code (pattern: `xxx-xxxx-xxx`). If found, use it directly and skip detection. Any non-code argument is the bot name.

Examples:
- `/join-call abc-defg-hij` -> room code `abc-defg-hij`, bot name "Samantha"
- `/join-call abc-defg-hij Stanbot` -> room code `abc-defg-hij`, bot name "Stanbot"
- `/join-call Stanbot` -> auto-detect room, bot name "Stanbot"
- `/join-call` -> auto-detect room, bot name "Samantha"

**If no room code in arguments**, first check if the Vibeconferencing app has already detected a call:

Call `get_room_info` (no room_id needed). If it returns detected Meet URLs, extract the meet code from the first one and use it.

If `get_room_info` returns no detected URLs, fall back to AppleScript:
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
pgrep -f "Vibeconferencing" >/dev/null 2>&1 && echo "RUNNING" || echo "NOT_RUNNING"
```

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

1. Call `wait_for_speech` to listen (blocks until someone speaks and pauses)
2. Respond naturally using `speak` — keep it to 1-2 sentences since it's spoken aloud
3. If the conversation involves visual content (code, diagrams, lists), also call `update_whiteboard` with markdown or Mermaid
4. Go back to step 1

Guidelines:
- Be a helpful, natural conversational participant
- Keep spoken responses short — people can ask you to elaborate
- Use the whiteboard for anything visual (code, diagrams, structured info)
- If someone says goodbye or asks you to leave, say goodbye via `speak`, then call `leave_call` to hang up. Then stop the loop.
- If `wait_for_speech` times out with no speech, call it again — people may just be quiet. The bot may still be joining the Meet call or waiting to be admitted. Do NOT relaunch the app or check `get_room_info` — just keep calling `wait_for_speech`.
- If someone asks you to change your voice, use `list_voices` to see options, then `set_voice` to change it. You can also use the `voice` parameter in `speak` for a one-off voice change. Have fun with it!
- NEVER kill or relaunch the Vibeconferencing app during the conversation loop. If speech isn't coming through, keep polling — the app handles joining automatically.
