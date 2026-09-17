---
name: pre-call-work
description: Prepare for a scheduled call before it starts, then join it when it does
argument-hint: "[meet code] [BotName]  — set by the app's calendar auto-join, not typed by hand"
disable-model-invocation: true
allowed-tools: Bash Read Bash Read mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_call_start mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__brief mcp__vibeconferencing__hold_voice mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__load_url mcp__vibeconferencing__read_whiteboard mcp__vibeconferencing__read_transcripts mcp__vibeconferencing__suggest_bot_names mcp__vibeconferencing__list_visual_assets mcp__vibeconferencing__list_fonts mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_mode mcp__vibeconferencing__set_caption_language mcp__vibeconferencing__set_camera mcp__vibeconferencing__get_call_screenshot mcp__vibeconferencing__get_shared_screenshot mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__leave_call mcp__vibeconferencing__end_session mcp__vibeconferencing__start_share mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__share_tab mcp__vibeconferencing__stop_sharing mcp__vibeconferencing__scroll_share mcp__vibeconferencing__set_share_audio mcp__vibeconferencing__set_share_size mcp__vibeconferencing__set_share_title_bar mcp__vibeconferencing__click_share mcp__vibeconferencing__type_share mcp__vibeconferencing__inspect_dom mcp__vibeconferencing__find_share_element mcp__vibeconferencing__eval_share mcp__vibeconferencing__read_share_console mcp__vibeconferencing__read_share_network mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__reload_share mcp__vibeconferencing__play_sound mcp__vibeconferencing__get_working_memory mcp__vibeconferencing__post_understanding mcp__vibeconferencing__bank_probe mcp__vibeconferencing__get_session_log mcp__vibeconferencing__get_call_log mcp__vibeconferencing__list_log_instances mcp__vibeconferencing__play_audio mcp__vibeconferencing__start_recording mcp__vibeconferencing__stop_recording
---

Prepare for a scheduled call that has not started yet, then join it when it does.

Your session was started EARLY — a few minutes before a meeting on the calendar — so that
slow work happens now, while nobody is waiting, instead of in the middle of a conversation.

**The bot has NOT joined anything. There is no call. Nobody can hear you.**

`speak`, `send_chat`, `start_share` and the rest of the in-call tools have no room to act on
yet. Calling them here does nothing useful, and `speak` in particular will queue audio that
plays the moment the bot does join — a bot that opens its meeting by saying something from
five minutes ago. Don't.

## Step 1: Work out what you're preparing for

`get_room_info` — with no call in progress it reports detected URLs and, when this session
came from a calendar event, a **Calendar context** block: the meeting's title, description,
start and end, and who is invited. That is what you are getting ready for.

The room code was also passed to this command, e.g. `/pre-call-work abc-defg-hij Jimmy`.
Hold on to it; you will need it as `room_id` once the call starts.

## Step 2: Do the preparation

Spend the window on things that would otherwise cost the room time. **In rough priority order:**

1. **Check whether this session needs compacting.** This is the reason the feature exists.
   A session that hits its context limit mid-call goes quiet for a minute while it summarises
   itself, and from the room that is indistinguishable from a hung bot. If you are anywhere
   near the limit, compact NOW, in the quiet, where it costs nothing. Cheap to do, expensive
   to skip.
2. **Read what the meeting is about.** The calendar description may name a doc, a repo, a
   PR, an issue. Open it now rather than at minute three while someone waits.
3. **Check your own recent history with these people.** Past call summaries live in
   `calls/<call-id>/summary.md`. If you met these invitees last week and promised to follow
   something up, the start of the call is a bad time to discover that.
4. **Warm anything slow that you know you will need** — a build, an index, a fetch that
   always takes a minute.

**Match the work to the time you have.** Check the clock. Two minutes of lead time is
enough for the compaction check and a skim; it is not enough to start a build. Prefer
finishing something small over abandoning something large — an interrupted job is worse
than one never started, because the call begins either way.

**Don't invent work.** If your session is fresh, the meeting is a routine standup and there
is nothing to read, you are ready. Say so and go to step 3. Idling costs money on a cloud
box, and the window is an upper limit, not a quota to spend.

**Don't change anything the room depends on.** Preparation means reading, thinking and
compacting. This is not the moment to edit the bot's own preferences, rewrite its
personality file, or start a refactor — you are about to be in a meeting, and a change made
now takes effect with nobody watching.

## Step 3: Park until the call starts

When you're ready, call `wait_for_call_start`. It blocks until the app actually joins, and
returns after about a minute if it hasn't — that's the normal outcome, not an error.

```
wait_for_call_start({ room_id: "<the code from step 1>" })
```

If it returns "not started yet", either do a little more preparation or call it again.
**Keep calling it.** The meeting is coming; the only thing that ends this loop is the join.

If you have been waiting far longer than the meeting's whole lead time, something has
changed — the event was cancelled, or the app restarted and lost the timer. Check
`get_room_info` before concluding anything, and if there is genuinely no call coming, stop
looping and end the session rather than polling forever.

## Step 4: The call has started — hand over to the normal loop

Once `wait_for_call_start` returns that the app is joining, **you are now in an ordinary
call**. Follow the `/join-call` skill from its conversation loop onward, using the room code
that tool reported (it is authoritative — if it says the app joined a different room than
you were started for, believe it, not your argument).

Concretely:

- **Do NOT call `join_call`.** The app has already joined. Calling it again is the
  duplicate-join failure (#249): a second participant in the room while the first sits inert.
- Greet the room in one short sentence if you're in active mode, and let the meeting's title
  inform it — you know what this call is about, so use that rather than a generic hello.
- Then `wait_for_speech` and run the normal loop.

**Say nothing about your preparation unless it's useful to the room.** "I read the design doc
and I have thoughts on the migration" is worth saying. "I compacted my context and warmed a
cache" is the bot talking about itself; nobody came to the meeting for that.
