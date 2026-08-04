---
name: onboarding-call
description: Run a guided, live setup call that walks the user through configuring this bot, name, voice, emoji, background, whiteboard style, skills, and after-call routine
argument-hint: "[meet code] [BotName] (same room/profile routing as /call and /join-call)"
disable-model-invocation: true
allowed-tools: Read Glob Edit mcp__vibeconferencing__start_call mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__reload_whiteboard mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__suggest_bot_names mcp__vibeconferencing__list_visual_assets mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_mode mcp__vibeconferencing__leave_call mcp__vibeconferencing__end_session
---

Run a guided **setup call**: a live Meet where this bot walks the user through configuring
itself, instead of having a normal open-ended conversation. Triggered by the panel's
"Setup" button, or by hand with `/onboarding-call`.

This is `/call`'s sibling (same room mechanics, different walkthrough). If you haven't read
`/call` or `/join-call`, the tool reference there (`wait_for_speech`, `speak`,
`get_room_info` status polling, mode table, chat, whiteboard sharing) all applies here
unchanged. This skill only covers what's different: the scripted walkthrough.

## Step 1: Get into a call — joining one that exists, or starting a fresh one

`get_room_info` FIRST, before `start_call`.

- Already `in-call`? You are where you need to be. Skip to Step 2.
- Not in a call, but it reports **detected Google Meet URLs**? Someone has a call open right
  now. `join_call` that room instead of creating one.
- Nothing detected? `start_call` (`bot_name` only if `$ARGUMENTS` names one), then wait for
  `Call status: in-call`.

Creating a second Meet when one is already open is worse than it sounds: the user ends up in
a different room from the person they were talking to, and the call they were actually in
carries on without them. Setting yourself up is not a reason to move the meeting.

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

**Offer names first. Do not start by testing the one you happen to have.**

A brand-new bot is given a name automatically so it is not called "Unnamed bot" — that is a
placeholder, not a choice, and the user has not seen it before this moment. Jumping straight
to "let's check that <name> works" reads as though it has been decided.

1. `suggest_bot_names` and put them on the whiteboard as a grid, with your current name shown
   as the one you have for now. Say something like *"I've been given <name> — here are some
   others. Take one of these, or tell me anything you like."*
2. Let them pick from the board or invent their own. Both are fine; the board exists so
   nobody has to invent a name cold.
3. `set_preference("botName", "<name>")`.

Then, and only then, check the name actually works in conversation: say it aloud a couple of
times and confirm you hear it come back correctly (`wait_for_speech` / `read_transcripts`).

**Keep the reason to yourself.** You are checking that you reliably notice when someone says
your name — that depends on how the name comes back through the call's captions, which is
your problem, not theirs. Say *"let me make sure I catch it when you say it"*, then just try
it. Do NOT explain transcription, captions, or Google Meet: it is machinery the user did not
ask about and cannot act on, and it makes choosing a name sound like a technical decision
rather than a fun one. If a name genuinely does not come back reliably, say that plainly —
*"I keep mishearing that one"* — and offer the alternatives, still without the mechanism.

**Your Meet tile still says the OLD name — Meet takes the display name at join and will not
change it in place.** You can fix that without ending the call, but only in this exact order:

1. Tell them what is about to happen: *"I'll pop out and straight back in so the name sticks
   — give me a couple of seconds."*
2. `leave_call`
3. `join_call` with the SAME room id, immediately.

**Leave BEFORE you rejoin, never the other way round.** Joining again while still in the room
puts a second participant there and leaves the first sitting inert — a zombie the user has to
clear up.

Why this is safe, and why it looks like it should not be: `leave_call` does begin tearing the
call down, and if you leave and never come back it ends your session. But leaving first opens
the after-call work window (five minutes by default), and you are alive for all of it — so a
rejoin inside that window is an ordinary join, and the teardown is cancelled when you come
back. What you must not do is dawdle: rejoin as the very next tool call, not after a
conversation.

If the rejoin fails for any reason, say so and carry on with the setup — the name is already
saved either way and applies to the next call regardless.

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
anyone; the same face in each, side by side, answers the question instantly.

**Size the images first — this is not optional.** The source files have wildly different
intrinsic sizes (the fluent3d PNG is hundreds of pixels, the noto SVG is tiny) and markdown
cannot size an image, so a plain grid renders one giant face beside three small ones and
reads as "these sets differ in quality". Columns end up uneven too, because the table sizes
itself around whatever the widest image happens to be.

Both problems are CSS, so set it before drawing the grid:

```
set_whiteboard_style("table { table-layout: fixed; width: 100% } td { text-align: center; vertical-align: middle; padding: 8px } table img { height: 84px; width: auto; margin: 0 auto } .native-face { font-size: 68px; line-height: 1 }")
```

`table-layout: fixed` is the part that equalises the columns; the `height` on images is what
makes four different files look like one set of options. (Step 4e picks a board style
properly and replaces this — by then the grids are done.)

`list_visual_assets` gives you a 🙂 from each image set as an absolute path. One row of
images, one row of names:

| ![fluent3d](/path/…/1f642.png) | ![twemoji](/path/…/1f642.svg) | <span class="native-face">🙂</span> |
|---|---|---|
| fluent3d | twemoji | native |

**Include `native` as a real cell, not a footnote.** It has no file because it IS the
computer's own emoji font — so just put the character 🙂 in the cell and let the machine
draw it. That is precisely what picking "native" means, so the cell is an honest preview
rather than a description of one. Wrap it so the CSS above can size it to match its
neighbours.

Label it for the machine you are actually on. You run on the same computer as the app and
your environment tells you its platform, so "whatever this Mac already uses (Apple's own)"
is *better* than a generic label when you genuinely know — it tells the user what they will
get.

The rule is only: **do not guess.** If the platform is not something you actually know, say
"whatever this machine already uses" and stop there. Naming the wrong OS, or inventing a
font vendor, is a confident-sounding error in someone's first minute with the product.

Once picked, `set_preference("emojiSet", "<set>")`.

### 4d. Background

**One grid, all of them at once** — not a slideshow. `list_visual_assets` returns every
preset with its absolute path; put them in a markdown table as images with the name under
each, so the whole choice is visible in a glance and they can just say "the forest one".

**Restyle for these before drawing the grid**, exactly as in 4c — and with different values,
because these are 16:9 scenes rather than square glyphs. Fixing the height (the emoji rule)
leaves each one a different width and the columns ragged; fixing the WIDTH is what makes a
tidy grid:

```
set_whiteboard_style("table { table-layout: fixed; width: 100% } td { width: 33%; text-align: center; vertical-align: top; padding: 8px } table img { width: 100%; height: auto; display: block }")
```

Three columns suits eight presets plus the describe-your-own cell: nine cells, a clean 3x3.

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
(Unlike the background grid this has to be sequential — the style applies to the whole board,
so they cannot sit side by side.)

**Offer the describe-it path as an equal option, not a fallback**, exactly as in 4d. Put it
on the board alongside the samples so it is visible rather than something you mention once:

> **…or describe the look you want**
> "Warmer, like a paper notebook." "Big and high-contrast." "Something playful."

`set_whiteboard_style` takes arbitrary CSS, so a description IS the native way to use it —
translating "make it look like a chalkboard" into CSS is the tool's whole purpose. Someone
who wants a particular look will describe it far better than they can pick it out of three
samples, and the presets are there for people who would rather not think about it.

Once picked, leave that style set (it's already applied; no further action needed beyond
confirming it stuck). If they describe one, apply it and show the same sample content in it
so they can see the result and adjust — "warmer", "bigger text" — rather than accepting the
first attempt out of politeness.

### 4f. What you can do — skills AND connected tools

**This is the one step most likely to scroll: post the whiteboard URL to chat here even
if you didn't need to for earlier steps.**

Two sources, and the second is the one that gets forgotten:

1. **Skills** — `Glob` the user's `.claude/skills/*/SKILL.md` (this machine's normal skill
   directory) and list name plus a one-line description each, not just names.
2. **Connected MCP servers** — look at the tools you actually have in THIS session and group
   them by server: Gmail, Google Calendar, Slack, image generation, a browser, whatever is
   wired up. You do not need to go looking for these; they are in your own tool list.

List both on the board, together, under what they let you DO rather than what they are
called — "read and send your email", "generate images", "post to Slack" — since the point is
for the user to recognise a capability, and "nanobanana" tells them nothing.

Skills alone undersell you badly: a bot listing four slash commands while quietly holding
Gmail and an image generator reads as far less capable than it is, and the user has no way
to know what was left out. This is also the material step 4g needs — someone cannot ask for
an emailed summary after each call if nobody mentioned that email is available.

Ask which of it this bot should use, and when. Then `Edit` this bot's own `CLAUDE.md` (in the
agent's working directory) to record the decision under "## Skills" / "## Tools", so it
persists across sessions rather than living only in this call's memory.

### 4g. After-call routine

Build this out of what 4f just surfaced — the connected servers are the menu. If Gmail is
wired up, "a summary in your inbox after every call" is a real offer; if Slack is, so is
"posted to a channel"; with an image generator, "a diagram of what we covered". Name the
concrete options rather than asking the open question "what would you like?", which invites
a shrug from someone who does not know what is possible.

Ask what they'd like done automatically after calls: a summary email, nothing, something
else. `Edit` CLAUDE.md to add an "## After-call routine" section with
the decision.

## Step 5: Wrap up

`update_whiteboard` with a summary of everything decided (or defaulted). `speak` a short
close:

> "All set, here's what I've got. You can change any of this later just by asking me."

**Then say what happens next, because the call does not end itself.** Two things, both of
which people otherwise sit and wonder about:

> "Tell me when you're done and I'll drop off — or if you'd like to introduce me to someone,
> invite them in and we'll carry on."

Leaving is the one that matters: setup is finished, the whiteboard is full, and there is no
obvious signal that the bot is waiting rather than working. Someone who does not know they
can simply say "you can go" will close the tab on you, or worse, sit through a silence
wondering whether something is still running.

The invite half is worth saying because this is the moment a new bot is most fun to show
someone, and nothing about a setup call suggests you can just add people to it.

Then continue as a normal call would from here: if they keep talking, you can either
`leave_call` when they say they're done, or just keep going as a regular conversation (the
same loop `/join-call` describes) if they want to use the bot for something else right away.
If someone new joins, greet them by name and carry on — you are a normal call now, not a
wizard.
