---
name: call
description: Start a brand-new call with your bot — creates a Meet, sends the bot in, and opens your browser to it
argument-hint: "[BotName] [remote]  — bot picks which bot when several run; remote if you're not at the app's machine"
disable-model-invocation: true
allowed-tools: mcp__vibeconferencing__start_call mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__read_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__suggest_bot_names mcp__vibeconferencing__list_visual_assets mcp__vibeconferencing__list_fonts mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_mode mcp__vibeconferencing__set_caption_language mcp__vibeconferencing__set_camera mcp__vibeconferencing__get_call_screenshot mcp__vibeconferencing__get_shared_screenshot mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__leave_call mcp__vibeconferencing__end_session mcp__vibeconferencing__start_share mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__share_tab mcp__vibeconferencing__stop_sharing mcp__vibeconferencing__scroll_share mcp__vibeconferencing__inspect_dom mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__reload_whiteboard mcp__vibeconferencing__play_sound mcp__vibeconferencing__get_working_memory mcp__vibeconferencing__post_understanding mcp__vibeconferencing__bank_probe mcp__vibeconferencing__click_share mcp__vibeconferencing__get_session_log mcp__vibeconferencing__list_log_instances mcp__vibeconferencing__play_audio mcp__vibeconferencing__set_share_audio mcp__vibeconferencing__set_share_size mcp__vibeconferencing__set_share_title_bar mcp__vibeconferencing__type_share mcp__vibeconferencing__start_debug_recording mcp__vibeconferencing__stop_debug_recording
---

Start a **brand-new** call with the bot, then talk to it.

This is the command form of the app's "Call &lt;bot&gt; now" button. Use it when there is
**no call yet**. If a call already exists and you just want the bot in it, use
`/join-call` instead — that's the whole difference between the two.

## Step 1: Start the call

Call `start_call`. Pass `bot_name` only if `$ARGUMENTS` names one — it selects which
**profile** to drive when several app instances are running, exactly as it does for
`/join-call`. With one instance running, omit it.

```
/call             → start a call with the sole running bot
/call Alice       → start a call with the "Alice" profile's bot
/call remote      → you're NOT at the app's machine (see below)
/call Alice remote
```

The app does three things from that one call: creates a Meet anyone with the link can
join (no admit prompt, no host needed), sends the bot into it, and opens **your** browser
to the same room so you're in it too. You do not need to find or paste a link — unless
you're driving this from somewhere else, in which case see "When the user isn't at the
app's machine" below.

If it reports a problem, relay it and stop — the likely ones are being signed out of
vibeconferencing.com (sign in from the app's panel) or having started several calls in
quick succession. Do not retry in a loop; a retry that succeeds gives you a *second*
room, not another try at the first.

`start_call` returns the room id **and the join link**. Show the link when it's useful —
someone joining from another device, or a person being invited — and skip it when the
user's browser is already open in the room.

### When the user isn't at the app's machine

If `$ARGUMENTS` says `remote`, or the user has told you they're on their phone or in a
remote session, pass `open_browser: false`. No browser then opens on the app's machine —
nobody is sitting there, and a tab left in an empty call is litter at best.

Give them the join link on its own line so it's tappable. Everything after this is the
same; they join from their own device instead of a browser on the desktop.

## Step 2: Wait for the bot to be admitted

Call `get_room_info` and check the `Call status:` line. Give it a few seconds — it moves
through `joining` to `in-call`. Once it reads `in-call`, the bot is in the room and its
camera and voice are live.

## Step 3: Run the conversation

From here the loop is identical to `/join-call`, and that skill is the reference for it:

- `wait_for_speech` — blocks until someone finishes speaking, then returns what they said
- `speak` — say something out loud in the call
- `read_transcripts` / `read_chat` / `send_chat` — the rest of the room's traffic
- `update_whiteboard` / `share_whiteboard` — put something on screen
- `leave_call` — hang up when the user is done

Keep taking turns until the user says they're finished, then `leave_call`.

Leaving matters a little more here than with `/join-call`: this command created the room,
and hanging up properly closes it rather than leaving it to expire on its own.
