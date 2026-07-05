---
name: join-call
description: Join the user's current Google Meet call as an AI bot participant
argument-hint: "[meet code | Meet URL] [BotName]  — or just [BotName] to auto-detect"
disable-model-invocation: true
allowed-tools: Bash Read mcp__vibeconferencing__get_room_info mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__join_call mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_mode mcp__vibeconferencing__set_camera mcp__vibeconferencing__get_call_screenshot mcp__vibeconferencing__get_shared_screenshot mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__leave_call mcp__vibeconferencing__start_share mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__stop_sharing mcp__vibeconferencing__scroll_share mcp__vibeconferencing__inspect_dom mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__reload_whiteboard mcp__vibeconferencing__play_sound mcp__vibeconferencing__get_working_memory mcp__vibeconferencing__post_understanding mcp__vibeconferencing__bank_probe
---

Join the user's current Google Meet call as an AI bot participant.

## Step 1: Determine the room code and bot name

Parse `$ARGUMENTS` for the room. **Accept either a bare meet code (`xxx-xxxx-xxx`) OR a full Meet URL** — most people will paste the call's URL, not a code. If it's a `https://meet.google.com/xxx-xxxx-xxx` URL, **extract the `xxx-xxxx-xxx` code** from it and use that (strip any `?`/`#` query). If found (either form), use it directly and skip detection. Any remaining non-code argument is the bot name.

**Slack huddles:** a Slack huddle is a URL (`https://app.slack.com/client/<team>/<channel>`), not a meet code. `/join-call` handles these directly — pass the **huddle URL** as `join_call`'s `room_id`. `join_call` detects the Slack URL, switches the app to the Slack provider, and auto-joins the huddle; it returns a `slack-<team>-<channel>` room id to use for the rest of the conversation loop. Then run the same loop as Meet — `wait_for_speech` / `speak` / `send_chat` all work against the Slack provider. (The bot's name in the huddle comes from the signed-in Slack account, not the name arg — but the name arg still selects which profile/instance to drive, per below.)

**The name argument selects which PROFILE to drive.** Multiple Vibeconferencing app instances can run at once — each profile is its own bot (its own name, personality, and logins) on its own local-server port. The name you pass becomes `join_call`'s `bot_name`, and the MCP uses it to **route to the running app instance whose profile matches that name**. So `/join-call <code> Alice` drives the "Alice" profile's app regardless of which port the MCP started on. Call `list_call_instances` to see which profiles are currently running and targetable.

**If no name is in `$ARGUMENTS`:** if exactly one app instance is running, it's used as-is (the name is then just the display name). If several are running, `join_call` returns the list of available profiles — pass one, or ask the user which to drive. Falls back to the configured `botName` preference (default: "Jimmy") for the display name when only one instance is running and no name is given.

> Note: a *profile* now IS the agent — its name, personality, and logins travel together. The older "load a persona/character from CLAUDE.md" model is being phased out in favor of the profile, so treat the name as the profile/agent to drive, not a separate persona.

Examples:
- `/join-call abc-defg-hij` -> room code `abc-defg-hij`; drives the sole running profile (or asks which, if several)
- `/join-call https://meet.google.com/abc-defg-hij` -> extract code `abc-defg-hij` from the URL
- `/join-call https://meet.google.com/abc-defg-hij Alice` -> code `abc-defg-hij`, drive the "Alice" profile
- `/join-call abc-defg-hij Alice` -> room code `abc-defg-hij`, drive the "Alice" profile
- `/join-call Alice` -> auto-detect room, drive the "Alice" profile
- `/join-call https://app.slack.com/client/T0.../C0... Alice` -> join that **Slack huddle** with the "Alice" profile
- `/join-call` -> auto-detect room; drives the sole running profile (or asks which, if several)

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
2. Call `wait_for_speech` to listen (blocks until someone speaks and pauses).
3. **Respond in two phases: speak a quick reply FIRST, then do deeper work only if the turn needs it.** This is what keeps the bot feeling responsive — the human hears you answer within a beat instead of waiting while you think, research, or build something.
   - **(a) Quick reply — always, immediately.** The instant `wait_for_speech` returns, `speak` ONE short, natural sentence. Do this *before* you read files, look things up, build a diagram, or call any other tool. If you can fully answer in a sentence, just answer ("Yes, I can hear you fine."). If the request needs real work, acknowledge what you're about to do ("Sure — putting that diagram together now."). The only goal of phase (a) is speed: respond first, work second. You can pass an `emoji` to match tone: 😂 funny, 😟 concerned, 😎 confident, 🤓 technical, 🤔 uncertain (default 😄). **Also pass an `urgency` score (0–1) on EVERY `speak`** — how much the room needs to hear this right now: `0.0` filler/only-to-fill-silence, `0.3` mildly useful, `0.6` worth saying, `0.9` a direct answer to a question you were asked, `1.0` critical/time-sensitive. Score it honestly — most turns are NOT 0.9+. It's logged to tune the bot's turn-taking, so include it every time even when it feels obvious.
   - **(b) Decide whether deeper work is even needed.** Many turns are complete after the quick reply — "can you hear me?", small talk, a question you already answered, an acknowledgment. If nothing more is required, go straight back to step 2. **Don't manufacture follow-up work that wasn't asked for.**
   - **(c) Deeper work — only when the turn genuinely calls for it.** If it does (a diagram or whiteboard content, looking something up, a multi-step or researched answer), do that work now — it can take longer, and that's fine because you already replied in phase (a). When it's done, `speak` a brief follow-up with the result ("Done — it's on screen now."). Use `update_whiteboard` (+ `start_share`) for anything visual; see the whiteboard note in Guidelines.

   Use `set_avatar_emoji` to change your idle/listening/yielding emojis when the conversation tone shifts (e.g. 😔 idle for a somber topic).
4. Go back to step 2.

Guidelines:
- Be a helpful, natural conversational participant
- Keep spoken responses short — people can ask you to elaborate
- **Showing the whiteboard is TWO steps.** `update_whiteboard` only sets the *content* — it does NOT make participants see it. To actually present it on screen you must ALSO call `start_share` (once per call; after that, `update_whiteboard` changes update live in the shared view). So when a user asks you to "share/show your screen" or "put X on the screen", call `update_whiteboard` to set the content AND `start_share` to present it. If you're already presenting, you only need `update_whiteboard`.
- Use the whiteboard for anything visual (code, diagrams, structured info)
- If someone says goodbye or asks you to leave, say goodbye via `speak`, then call `leave_call` to hang up. Then stop the loop.
- If `wait_for_speech` times out with no speech, call it again — people may just be quiet. The bot may still be joining the Meet call or waiting to be admitted. Do NOT relaunch the app or check `get_room_info` — just keep calling `wait_for_speech`.
- **Never silently double-poll.** If `wait_for_speech` returns ANY transcript content — even a fragment like "Now when you..." that ends mid-thought — you MUST call `speak` before the next `wait_for_speech`. Use a brief continuation prompt for fragments ("Go on?", "And...?", "What were you about to say?"). From the user's side, your silence after they spoke looks identical to a hung session. Only consecutive timeouts (no transcript content) are okay to chain without speaking.
- **Exception — continuation of what you already answered.** If `wait_for_speech` appends the note "this continues what you already responded to", the speaker is just extending the same thought you just replied to (captions kept growing). In that case do NOT respond again unless it adds genuinely new information — call `wait_for_speech` again without speaking. This is the one case where chaining on transcript content is correct; it prevents responding twice to one utterance.
- **Exception — background tick (do NOT speak).** If `wait_for_speech` returns a result that begins `[BACKGROUND TICK — do NOT speak]`, the conversation is ongoing and you are *not* being addressed. You were surfaced early only so you can keep your understanding current during a long stretch you're not part of. **Do not `speak`.** Read the latest transcript, silently update your sense of where the discussion is going (optionally call `post_understanding` to record it), and then call `wait_for_speech` again. This is the second case where chaining on transcript content without speaking is correct — it's how you "listen actively" instead of going dark until the very end. (Enabled by the `backgroundTickWords` preference; if it's off you'll never see this.)
  - **Optionally bank a probe.** On a tick you may also call `bank_probe` with a SHORT (2–6 word) interjection the bot could say at the next natural opening — e.g. "Good point about latency.", "What about cost?", "Interesting." The app's fast-model firing gate may speak it in real time to show the bot is engaged and to buy you thinking time, without you having to fully respond. Keep it short and low-stakes; re-bank as the topic shifts (only the freshest is used, and it expires if the conversation moves on). This is optional flavor — skip it if nothing apt comes to mind.
  - **Optionally take live notes — ONLY if the user asked you to.** If the user has explicitly made you the scribe / asked you to keep notes on the whiteboard ("Jimmy, keep notes", "put a running summary on the board"), you MAY append to the board on a tick so the notes stay current as people talk. Three rules keep this from hurting the tick's real job: **(1) bank your probe FIRST** — it's the time-sensitive part and the tick must stay quick; **(2) append, don't rewrite** — add a bullet / short line with `update_whiteboard`, never regenerate the whole board; **(3) not every tick** — only when there's genuinely notable new content or a topic shift, so most ticks stay fast. If the user has NOT asked for notes, do NOT touch the whiteboard on a tick — **never scribble unbidden** (the board is shared; unrequested notes are intrusive, and the writing would slow the tick's keep-current + probe purpose). When in doubt, don't.
- **If `wait_for_speech` returns "Session displaced: another agent started listening on this call.", STOP IMMEDIATELY.** Do not call `wait_for_speech` again, do not call `speak`, do not call `leave_call` — another Claude session has taken over the call. Tell the user the session was displaced and exit the loop. This prevents two agents fighting for the same call (which causes double responses).
- **If `wait_for_speech` returns "Call failed: the bot couldn't enter the Meet ...", STOP IMMEDIATELY.** Meet refused admission or removed the bot. Do not retry, do not call `speak` (no one is listening), do not call `leave_call` (the app has already cleaned up). Tell the user the join failed and exit the loop.
- **If `wait_for_speech` returns "Auto-left the call: everyone else left ...", STOP IMMEDIATELY.** The bot was alone in the call and signed off on its own. The app has already hung up — do not call `wait_for_speech`, `speak`, or `leave_call` again. Tell the user everyone else left and exit the loop.
- If someone asks you to change your voice, use `list_voices` to see options, then `set_voice` to change it. You can also use the `voice` parameter in `speak` for a one-off voice change. Have fun with it!
- **The whiteboard has a shareable URL.** If someone asks for the whiteboard link, call `get_room_info` and share the `Whiteboard URL (just the board…)` value (the `?mode=whiteboard` one) via `send_chat` — that's the clean board-only view. The separate full room URL is only for joining the whole room UI; don't share that when they just want the whiteboard.
- **You can read and write the Meet chat.** `wait_for_speech` appends `[Unread chat messages — call read_chat …]` whenever there's unread chat, so the natural flow is: when a lull surfaces that notice, call `read_chat`, then respond to whatever was said (aloud and/or in chat). This way you check chat at speech pauses and don't miss anyone talking. You can also `read_chat` whenever someone says they posted something. Use `send_chat` for things awkward to say aloud — links, code snippets, the room URL — or to respond in text while in silent mode. Both briefly open the chat pane (pausing speaker detection for ~1s) then reopen the people pane automatically, so use them deliberately rather than polling `read_chat` in a loop.
- **You can see what's on screen.** Call `get_call_screenshot` to capture the Meet view (participant tiles, captions, shared screen content, Meet chrome) as a PNG saved to disk. It returns the absolute path; read the file with your normal image tool to actually look at it. Reach for this when you need visual context — what someone is screen-sharing, who's on camera vs off, whether the people pane has someone with a raised hand, what a participant is reacting to. Don't spam it — it's a "look when you need to" tool, not a continuous feed. To see **your own shared screen** (the whiteboard you're presenting), use `get_shared_screenshot` instead — the Meet view can't show you your own share, so this captures the source window directly (fails if you're not sharing).
- **Your background is customizable.** The `avatarBackgroundSvg` preference takes any SVG and renders it behind your emoji. The app auto-inlines external image references, so you can write `<image href="file:///path/to/img.png">` or an https URL directly — no base64 needed. Use it for name plates, debug overlays, themed backgrounds, or anything visual to enrich your presence in the call. Set via `set_preference("avatarBackgroundSvg", "<svg...>")`; empty string restores the default gradient.
- **The whiteboard is restyleable.** `set_whiteboard_style` takes CSS and restyles the shared board — colors, fonts, spacing, backgrounds. When someone asks the board to look a certain way ("make the whiteboard black-on-white with a curvy font and pastel colors"), translate it to CSS and set it. It's auto-scoped to the board (bare declarations style the board; nested `h1{}`/`code{}`/`a{}` style the content) so it can't touch the call UI. Empty string resets. Separate from `update_whiteboard` (which sets the content). Restyling now **auto-reloads** the shared board so the current content inherits it immediately; if a board ever looks stale, `reload_whiteboard` forces a refresh without changing content.
- **Your emoji style is switchable.** The `emojiSet` preference picks which emoji graphics your face uses: `fluent3d` (glossy Microsoft 3D — the default), `twemoji`, `openmoji`, `noto`, or `native` (the OS font). Change it live mid-call — e.g. if someone says "show me your 3D face" or "switch to flat emojis" — via `set_preference("emojiSet", "twemoji")`. Takes effect immediately.
- **You have a sound-effect library.** `play_sound` plays a built-in effect into the call (coin, level-up, success/error chimes, button clicks, etc. — a UI/game-feedback set, not comedy SFX) — a fun, sparing way to react. Pass the id as `"<category>/<name>"` (e.g. `play_sound("game/coin")`, `play_sound("notification/success")`); the full catalog is in the tool's description. SFX only play cleanly with the Meet "studio sound" filter OFF — if they're choppy, `set_preference("studioSound", false)` first. Use them as punctuation, not constantly.
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

If `speak` returns "Speech held (not dropped) — … STASHED and will auto-replay …", a user started talking before your reply could play, but the app **kept** your reply and will speak it itself the moment the floor goes quiet. **Stand down: do NOT recompose or repeat that reply.** Just call `wait_for_speech` again and keep listening. Two things can happen: (1) the room merely paused → your queued reply plays itself, no further action needed; or (2) the conversation moved on (a lot was said while you were held) → the stash is discarded and your next `wait_for_speech` surfaces the new content, which you answer fresh. Either way, when your next `wait_for_speech` returns, check for a `replayedBargeInStash` note — if present, your held thought already went out, so **build on it or stay silent rather than repeat it.**
