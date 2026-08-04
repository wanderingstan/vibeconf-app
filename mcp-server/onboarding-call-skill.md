---
name: onboarding-call
description: Run a guided, live setup call that walks the user through configuring this bot, name, voice, emoji, background, whiteboard style, skills, and after-call routine
argument-hint: "[meet code] [BotName] (same room/profile routing as /call and /join-call)"
disable-model-invocation: true
allowed-tools: Read Glob Edit mcp__vibeconferencing__start_call mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__reload_whiteboard mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__list_visual_assets mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_mode mcp__vibeconferencing__leave_call mcp__vibeconferencing__end_session
---

Run a guided **setup call**: a live Meet where this bot walks the user through configuring
itself, instead of having a normal open-ended conversation. Triggered by the panel's
"Setup" button, or by hand with `/onboarding-call`.

This is `/call`'s sibling (same room mechanics, different walkthrough). If you haven't read
`/call` or `/join-call`, the tool reference there (`wait_for_speech`, `speak`,
`get_room_info` status polling, mode table, chat, whiteboard sharing) all applies here
unchanged. This skill only covers what's different: the scripted walkthrough.

## Step 1: Start the call

Same as `/call`: call `start_call` (`bot_name` only if `$ARGUMENTS` names one), then wait
for `Call status: in-call` via `get_room_info`.

## Step 2: Say what's about to happen

Before anything else, set expectations: this is a working session, not small talk.

> "Hi! I'm not fully configured yet, so let's set that up together while you're both
> here. Everything's going up on the whiteboard as we go. Say 'skip' on anything, or just
> leave the call whenever; I'll use sensible defaults for whatever's left."

## Step 3: Put the whiteboard on screen — ONCE, before the first step

Call `share_whiteboard` now, before the first `update_whiteboard`.

This is easy to skip and invisible when you do. `update_whiteboard` only sets the board's
CONTENT; it does not present it. Without a share you will happily write every step to a
board nobody can see, the call will look like the bot is saying nothing useful, and you
will have no way to tell from your side — the tool calls all succeed.

Once per call, not once per step. Re-sharing a board that is already up interrupts the
presentation everyone is already watching.

## Step 4: Walk the steps

Work through the steps below **in order**. For each one:

1. `update_whiteboard` with that step's content (options, current value, instructions):
   the board is the primary UI for every step, not speech. Keep what you say short; the
   board carries the detail.
2. `speak` a brief prompt.
3. If the content is long enough that it might scroll off one screen (this mainly means
   the skills step below), `send_chat` the whiteboard's shareable URL from `get_room_info`
   (the `?mode=whiteboard` one) so the user can open it full-size in a browser tab.
4. `wait_for_speech` for their answer. Also check `read_chat` if `wait_for_speech` flags
   unread messages; either channel is a valid way to answer.
5. If they say "skip", or `wait_for_speech` times out a couple of times in a row, apply
   that step's default and move on: don't stall the call over one step.
6. Otherwise apply the answer (see per-step notes) and briefly confirm what you set before
   moving to the next step.

**Check for an early exit between every step**, not just at the start: call `get_room_info`
and see whether the user's still there. If they've left, stop the walkthrough right there,
apply defaults for whatever's left unset, and skip to Step 5.

### 4a. Name

Explain that you're about to say a couple of candidate names out loud so you can both hear
how Google's live transcript renders them back: a name that doesn't transcribe cleanly is
worth knowing before it's stuck. Say each candidate 2-3 times, then check the transcript
(`wait_for_speech` / `read_transcripts`) for how it actually came back. Once they pick one,
`set_preference("botName", "<name>")`.

If a name was already chosen by the app's desktop setup wizard before this call started,
skip straight to the transcription check on that name (no need to ask again from scratch),
just confirm it holds up.

### 4b. Voice

`list_voices` to see what's available (ElevenLabs voices, if a key is configured, plus the
OS's built-in voices). Put the list on the whiteboard. Then actually let them **hear**
candidates in the call: `speak` a short sample line in each voice via `speak`'s `voice`
parameter, cycling through 3-4 options as they say "next" / "that one". Once picked,
`set_voice` (or `set_preference("ttsVoiceId", ...)` / `set_preference("macosVoice", ...)`
as appropriate to what `set_voice` needs).

If no ElevenLabs key is configured, say so plainly and offer to open elevenlabs.io for
them (mention it; you can't open a browser yourself from here), then continue with the
built-in OS voice as the default rather than blocking on it.

### 4c. Emoji set

**Show the sets, do not list them.** "fluent3d, twemoji, openmoji, noto" means nothing to
anyone; the same four faces side by side answers the question instantly.

`list_visual_assets` gives you a 🙂 from each set as an absolute path. Put them on the board
as a row of images with the set name under each, e.g. a markdown table with the images in
one row and the names in the next:

| ![fluent3d](/path/from/list_visual_assets/1f642.png) | ![twemoji](/path/…/1f642.svg) |
|---|---|
| fluent3d | twemoji |

`native` has no image — it is the OS's own emoji font — so add it as a final text cell
saying so ("native — whatever this computer already uses").

Once picked, `set_preference("emojiSet", "<set>")`.

### 4d. Background

**One grid, all of them at once** — not a slideshow. `list_visual_assets` returns every
preset with its absolute path; put them in a markdown table as images with the name under
each, so the whole choice is visible in a glance and they can just say "the forest one".

Make the LAST cell of the grid a text cell rather than an image:

> **…or describe one**
> Tell me the image you'd like and I'll make it.

That cell is the point of the step: the presets are a starting menu, not the limit, and
nobody discovers the custom path from a list of eight filenames.

Once picked, read that SVG file and `set_preference("avatarBackgroundSvg", "<svg source>")`,
plus `set_preference("avatarBackgroundCaption", "<short label>")` so it's recallable later.
If they describe their own instead, generate the SVG the same way you would mid-call and set
the caption to their description.

### 4e. Whiteboard style

Render the same short sample content in 2-3 different `set_whiteboard_style` presets, one
after another, so they see real differences rather than describing CSS in the abstract.
Once picked, leave that style set (it's already applied; no further action needed beyond
confirming it stuck).

### 4f. Skills

**This is the one step most likely to scroll: post the whiteboard URL to chat here even
if you didn't need to for earlier steps.** `Glob` the user's `.claude/skills/*/SKILL.md`
yourself (this machine's normal skill directory) and put the full list on the whiteboard:
name and one-line description per skill, not just a name. Ask which ones this bot should
use, and when. Once they answer, `Edit` this bot's own `CLAUDE.md` (in the agent's working
directory) to add a "## Skills" section recording the decision, so it persists across
sessions rather than living only in this call's memory.

### 4g. After-call routine

Whiteboard lists what's realistically available given the tools actually connected to this
session (e.g. email summary if a Gmail-capable MCP is present, posting notes somewhere if a
messaging one is). Ask what they'd like done automatically after calls: a summary email,
nothing, something else. `Edit` CLAUDE.md to add an "## After-call routine" section with
the decision.

## Step 5: Wrap up

`update_whiteboard` with a summary of everything decided (or defaulted). `speak` a short
close:

> "All set, here's what I've got. You can change any of this later just by asking me."

Then continue as a normal call would from here: if they keep talking, you can either
`leave_call` if they're done, or just keep going as a regular conversation (the same loop
`/join-call` describes) if they want to use the bot for something else right away.
