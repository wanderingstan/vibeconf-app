---
name: join-call
description: Join the user's current Google Meet call as an AI bot participant
argument-hint: "[meet code | Meet URL] [BotName]  — or just [BotName] to auto-detect"
disable-model-invocation: true
allowed-tools: Bash Read mcp__vibeconferencing__get_room_info mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__join_call mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__list_visual_assets mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_mode mcp__vibeconferencing__set_caption_language mcp__vibeconferencing__set_camera mcp__vibeconferencing__get_call_screenshot mcp__vibeconferencing__get_shared_screenshot mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__leave_call mcp__vibeconferencing__end_session mcp__vibeconferencing__start_share mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__share_tab mcp__vibeconferencing__stop_sharing mcp__vibeconferencing__scroll_share mcp__vibeconferencing__set_share_audio mcp__vibeconferencing__set_share_size mcp__vibeconferencing__set_share_title_bar mcp__vibeconferencing__click_share mcp__vibeconferencing__type_share mcp__vibeconferencing__inspect_dom mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__reload_whiteboard mcp__vibeconferencing__play_sound mcp__vibeconferencing__get_working_memory mcp__vibeconferencing__post_understanding mcp__vibeconferencing__bank_probe mcp__vibeconferencing__get_session_log mcp__vibeconferencing__list_log_instances mcp__vibeconferencing__play_audio mcp__vibeconferencing__start_debug_recording mcp__vibeconferencing__stop_debug_recording
---

Join the user's current Google Meet call as an AI bot participant.

## Step 1: Determine the room code and bot name

Parse `$ARGUMENTS` for the room. **Accept either a bare meet code (`xxx-xxxx-xxx`) OR a full Meet URL** — most people will paste the call's URL, not a code. If it's a `https://meet.google.com/xxx-xxxx-xxx` URL, **extract the `xxx-xxxx-xxx` code** from it and use that (strip any `?`/`#` query). If found (either form), use it directly and skip detection. Any remaining non-code argument is the bot name.

**Slack huddles:** a Slack huddle is a URL (`https://app.slack.com/client/<team>/<channel>`), not a meet code. `/join-call` handles these directly — pass the **huddle URL** as `join_call`'s `room_id`. `join_call` detects the Slack URL, switches the app to the Slack provider, and auto-joins the huddle; it returns a `slack-<team>-<channel>` room id to use for the rest of the conversation loop. Then run the same loop as Meet — `wait_for_speech` / `speak` / `send_chat` all work against the Slack provider. (The bot's name in the huddle comes from the signed-in Slack account, not the name arg — but the name arg still selects which profile/instance to drive, per below.)

**The name argument selects which PROFILE to drive.** Multiple Vibeconferencing app instances can run at once — each profile is its own bot (its own name, personality, and logins) on its own local-server port. The name you pass becomes `join_call`'s `bot_name`, and the MCP uses it to **route to the running app instance whose profile matches that name**. So `/join-call <code> Alice` drives the "Alice" profile's app regardless of which port the MCP started on. Call `list_call_instances` to see which profiles are currently running and targetable.

**If no name is in `$ARGUMENTS`:** if exactly one app instance is running, it's used as-is (the name is then just the display name). If several are running, `join_call` returns the list of available profiles — pass one, or ask the user which to drive. Falls back to the configured `botName` preference (default: "Jimmy") for the display name when only one instance is running and no name is given.

> Note: a *profile* now IS the agent — its name, personality, and logins travel together. The older "load a persona/character from CLAUDE.md" model is being phased out in favor of the profile, so treat the name as the profile/agent to drive, not a separate persona.

**The name is FIXED AT JOIN — you cannot rename yourself mid-call.** The display name is handed to Meet when the bot enters the call, and a great deal hangs off it (name-mention detection, MCP routing to the right app instance). Changing a profile's name while in a call updates the profile but NOT the tile: Meet keeps showing the name you joined under for the rest of the call.

So if someone says *"rename yourself to Pepper"* or *"you should be Solene, not Otto"*, do **not** claim the change took effect. Instead:

1. Say plainly that the name is set at join time and can't change mid-call.
2. Say that changing it means ENDING THIS CALL and starting a fresh one — not "give me a
   second". Leaving takes your session with it: the app tears the agent down along with the
   call, so there is no you left to rejoin with. Offer it as the real trade it is.
3. If they'd rather keep talking, save the name anyway (`set_preference("botName", …)`) and
   tell them it applies from the next call.

**Never `join_call` again without leaving first.** It looks like a clever way to get the new
name on your tile, and it puts a SECOND participant in the room while the first sits there
inert — a zombie the user has to clear up. (#249 tracks making a mid-call rename actually
work.)

Until the name genuinely changes, keep answering to the name on your tile — that's the name everyone in the room can see.

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

1. **The app is already in a call** — the reply will be a full room info block that starts with `Room: xxx-xxxx-xxx` and includes a `Call status:` line (e.g. `in-call`, `joining`, `navigating`, `waiting-to-be-admitted`). This is authoritative — use that room code and skip detection entirely. `navigating` means the app has just recorded intent to join and dispatched the browser view — it hasn't reached Meet's page yet; `joining` means Meet's own page has loaded and confirmed a join attempt is underway. Both mean "in progress, keep polling" — treat them the same as far as your next step goes.
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
  - `navigating`, `joining`, or `waiting-to-be-admitted`: The app is in the process of joining. Go to Step 3 — the long-poll will block until speech arrives after admission.

## Step 3: Start the conversation loop

Don't wait for admission — the long-poll will block until speech arrives. Use the meet code as `room_id` for all MCP tool calls.

1. **First-turn greeting (active mode only):** Before the first `wait_for_speech`, call `speak` with a brief, friendly self-introduction (1 sentence — e.g. "Hi everyone, [bot name] here, ready when you are."). This replaces the old canned welcome and gives users an audible cue that the agent is on the line. Skip this in passive or silent mode — those modes don't speak unbidden.
2. Call `wait_for_speech` to listen (blocks until someone speaks and pauses).
3. **Respond in two phases: speak a quick reply FIRST, then do deeper work only if the turn needs it.** This is what keeps the bot feeling responsive — the human hears you answer within a beat instead of waiting while you think, research, or build something.
   - **(a) Quick reply — always, immediately.** The instant `wait_for_speech` returns, `speak` ONE short, natural sentence. Do this *before* you read files, look things up, build a diagram, or call any other tool. If you can fully answer in a sentence, just answer ("Yes, I can hear you fine."). If the request needs real work, acknowledge what you're about to do ("Sure — putting that diagram together now."). The only goal of phase (a) is speed: respond first, work second. You can pass an `emoji` to match tone. **Any emoji works — reach for the whole set, not a house style.** The face is most of your expressiveness on a call, so pick the one that actually fits this sentence: 🤯 at a surprising result, 😬 when you broke something, 🫠 at the third flaky retry, 🧐 while digging, 🎉 on a green build, 🙃 at your own bug, 🥁 before a reveal, 😴 on a long wait, 🤌 at an elegant fix, 💀 at a truly cursed stack trace. The old shortlist (😂 funny, 😟 concerned, 😎 confident, 🤓 technical, 🤔 uncertain, default 😄) is a floor, not a menu — repeating the same five faces all call reads as flat. **Also pass an `urgency` score (0–1) on EVERY `speak`** — how much the room needs to hear this RIGHT NOW, over the top of someone else. The anchors changed: `0.9` used to mean "a direct answer to a question", which is most of what you say, so bots scored 0.9 on everything and talked over people constantly. Score against these instead: `0.0` filler, only worth saying into dead silence · `0.2` a mildly useful aside · `0.4` **a normal answer to a normal question — this is where most of your turns belong** · `0.6` the room is actually blocked on this, or it stops being useful in a few seconds · `0.9` something is wrong right now and waiting makes it worse ("that command will delete the database", "we're about to lose the room") · `1.0` genuine danger. **0.5 is the line where you may cut someone off.** Below it your reply waits for a gap; at or above it plays over them. So the question to ask yourself is not "is this good?" but "is this worth interrupting a person for?" — and for a normal answer the honest answer is no, it can wait two seconds. Include it every time.
   - **(b) Decide whether deeper work is even needed.** Many turns are complete after the quick reply — "can you hear me?", small talk, a question you already answered, an acknowledgment. If nothing more is required, go straight back to step 2. **Don't manufacture follow-up work that wasn't asked for.**
   - **(c) Deeper work — only when the turn genuinely calls for it.** If it does (a diagram or whiteboard content, looking something up, a multi-step or researched answer), do that work now — it can take longer, and that's fine because you already replied in phase (a). When it's done, `speak` a brief follow-up with the result ("Done — it's on screen now."). Use `update_whiteboard` (+ `start_share`) for anything visual; see the whiteboard note in Guidelines.

   Use `set_avatar_emoji` to change your idle/listening/yielding emojis when the conversation tone shifts (e.g. 😔 idle for a somber topic, 🍿 while watching a demo, 🫡 after taking an action item). Change it a few times over a long call — a face that never moves is a bot that looks asleep.
4. Go back to step 2.

Guidelines:
- Be a helpful, natural conversational participant
- Keep spoken responses short — people can ask you to elaborate
- **The whiteboard is ONE shared surface for the whole room — not per-bot.** There is a single whiteboard per call, and EVERY bot's `update_whiteboard` writes to that same board. So if the board is already up on screen — whether *you* shared it earlier OR another bot (Coltrane, Samantha, …) did — you do **NOT** need to share again to contribute: just `update_whiteboard` and your content appears live on the board everyone is already seeing. Re-sharing a board that's already presented is wrong — it grabs the presentation away from the other bot and is disruptive.
- **Showing the whiteboard is TWO steps, but `start_share` is needed only ONCE per call — by whichever bot presents it first.** `update_whiteboard` only sets the *content* — it does not, by itself, put the board on screen. `start_share` is what presents it. So: if NOTHING is currently being presented, call `update_whiteboard` to set the content AND `start_share` to present it. If the board is ALREADY being presented (by you or any other bot), call `update_whiteboard` alone — never `start_share`. When unsure whether it's already up, prefer `update_whiteboard` only; you can check the shared view with `get_shared_screenshot`.
- Use the whiteboard for anything visual (code, diagrams, structured info)
- **Showing a local image file? Use `update_whiteboard`'s `image_path` param — never a `file://` markdown link.** The whiteboard renders in a sandboxed browser that can't load `file://` URLs (you'll get a broken-image icon), and hand-rolling a base64 data URI wastes a huge amount of context for no reason. `image_path` (absolute local path) already registers the file with the app's local server and embeds a working URL for you — that's the one correct way to show a generated or local image (e.g. a nanobanana output) on the board.
- **You can drive the board, not just fill it.** `click_share` and `type_share` send real mouse and key events into whatever is on screen, so you can operate a web app in front of the room — search something, open a tab, fill a form, step through a doc. Find what to click with `inspect_dom` and pass a **selector** rather than coordinates. Check the result with `get_shared_screenshot`. Everyone watches this happen live, so move deliberately and say what you're doing.
- **The shared window has a title bar, and it shows in the share.** That's the default and usually fine — it labels what people are looking at. Turn it off with `set_share_title_bar` (or `title_bar: false` on `start_share`) when you want an edge-to-edge capture, like a full-bleed image or a design mock. It can't change mid-share, so decide before you present.
- **Presenting a web page you're browsing (`share_tab`).** There are two ways to show a web page: the whiteboard window can *load* a URL and you drive it with `click_share`/`type_share` (above) — an in-app browser. OR, if you're browsing a page in the user's **real Chrome** with the Claude Chrome extension (the `mcp__claude-in-chrome__*` tools), you can share *that exact tab* into the call with `share_tab({ url })`. Use `share_tab` when the point is to show the room the live page you're actually driving; use the whiteboard-URL path when you just need any page on the board.
  - **Prerequisite — the Chrome extension must be connected to THIS session.** `share_tab` only makes sense if the `mcp__claude-in-chrome__*` tools are available here (advanced local setup: the Chrome extension + its MCP). If they aren't (e.g. a headless/remote bot), you can't drive a real Chrome tab — fall back to the whiteboard-URL + `click_share`/`type_share` approach. Don't claim you're sharing a browsed tab if you don't have the browser tools.
  - **CRITICAL — isolate the page from the call's window FIRST.** The Chrome extension opens tabs in the *current* Chrome window, and a window shows only one tab at a time. So if you browse in the same window as the Meet, presenting that page **hides the call**. Before you open anything, make a fresh Chrome window so the browsing lands there instead:
    ```
    osascript -e 'tell application "Google Chrome" to make new window'
    ```
    Do this **before the session's first `navigate`/`tabs_create_mcp`** — once the extension plants its tab group in a window, new tabs stay in that window and it can't be moved cleanly.
  - **The recipe:**
    1. Make the fresh window (the `osascript` above) so it's the current Chrome window.
    2. Open the page — `navigate({ url })` (or `tabs_create_mcp` then `navigate`). It lands in the fresh window, not the call's.
    3. `share_tab({ url })` — the app activates that tab in its isolated window and screen-shares it live. **If it replies that the page shares the call's window, you skipped step 1** — make a new window, re-load the page there, and retry.
    4. Keep driving it (`navigate`, the browser `computer` tool) and **narrate as you go** — the room watches it update in real time. Say what you're doing before you do it.
    5. `stop_sharing` when done (or `start_share` to switch back to the whiteboard). Tidy-up is automatic: `share_tab` removes the leftover blank New Tab, and `stop_sharing` closes the throwaway browsing window — you don't need to clean up windows/tabs by hand.
  - **macOS ONLY right now.** The whole flow (make-new-window, isolate, present, tidy-up, re-raise) is AppleScript, which doesn't exist on Windows/Linux. If you're not on macOS (check with `uname` if unsure), **don't attempt `share_tab`** — tell the user it's macOS-only for now and use `start_share` with share_type `screen`, or the whiteboard, instead. `share_tab` also guards this itself and will return a clear macOS-only message, but warn the user first rather than letting it fail.
  - **Other caveats:** it shares whatever the tab shows, so don't put anything private in that tab; and match a distinctive URL (a bare `google.com` could match the wrong tab).
- **`set_share_size` changes the board's shape.** Leave it at the default 800x800 for whiteboard content — the renderer is tuned for 800 wide and markdown/Mermaid boards render at the wrong scale otherwise. Resize when you're showing a URL with its own natural shape (a phone mock, a wide dashboard).
- **A shared board's sound is live — everyone hears it.** If you put a video on the board, the room hears its audio. Use `set_share_audio` to mute it when people should talk OVER the content rather than listen to it, and unmute when it's time to actually watch. The video keeps playing either way, and the share is never interrupted. Prefer this over stopping the share.
- If someone says goodbye or asks you to leave, say goodbye via `speak`, then call `leave_call` to hang up.
- **After leaving, read what `leave_call` (or `wait_for_speech`) tells you.** If it says you are in AFTER-CALL WORK, you are still running and the call's state is still there: `read_transcripts`, `read_whiteboard` and `get_room_info` all still describe the call that just ended. Do whatever wrap-up this bot is meant to do — its CLAUDE.md says what that is — then call `end_session`. Do NOT `speak` or `send_chat`; you have left the meeting and nobody will hear or see it. If there is nothing to do, call `end_session` straight away rather than leaving the app waiting. If you are NOT told about after-call work, just stop the loop as before.
- If `wait_for_speech` times out with no speech, call it again — people may just be quiet. The bot may still be joining the Meet call or waiting to be admitted. Do NOT relaunch the app or check `get_room_info` — just keep calling `wait_for_speech`.
- **Stuck in the waiting room? Tell the user where the admit button is.** After ~3 consecutive empty timeouts with `Call status: waiting-to-be-admitted`, say so in your terminal output — the user is watching you, not the Meet tab, and has no idea you're stranded.

  Meet now shows the host a **"wants to join — review potential risks"** prompt for bots rather than the normal Admit/Deny pair. It looks deny-only: the visible button is **Deny**, and there is *no* Admit next to it. **There is still an admit — it's behind the ⋮ (three-dot) overflow button on that prompt.** Meet just makes it hard to find.

  So tell the host, in words: *"I'm waiting to be admitted. Meet is probably showing you a 'review potential risks' prompt — the Admit option is hidden behind the three-dot menu on it, not next to the Deny button."* Do not conclude the join is impossible, and do not relaunch the app; a host who can't find Admit looks identical to a host who is ignoring you.
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

If `speak` returns "Speech held (not dropped) — … STASHED …", a user started talking before your reply could play, so the app **kept** your reply to speak the moment the floor goes quiet. **Stand down: do NOT recompose or repeat it now.** Call `wait_for_speech` again and keep listening — it will tell you explicitly which of two things happened, and you never have to guess from silence:

- **`[Auto-replayed your previously-yielded speech …]`** — it played. The room heard it. **Build on it or stay silent; do not repeat it.**
- **`[NOT SPOKEN — your held reply was dropped …]`** — the conversation moved on while you waited, so it was discarded. **The room never heard it.** If the point still matters, say it again — but reworded for where the conversation is *now*, not where it was when you composed it. If it's been overtaken, let it go.

Treat that second note seriously: without it you would carry on as though you'd said something nobody heard, and every later turn that builds on it makes less sense to the room than it does to you.
