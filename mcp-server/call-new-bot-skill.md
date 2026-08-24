---
name: call-new-bot
description: Turn THIS Claude session into a bot — creates a new bot that resumes this session, so it arrives already knowing what you have been working on
argument-hint: "[BotName]  — optional; otherwise the bot proposes its own name from what this session has been doing"
disable-model-invocation: true
allowed-tools: Bash Read mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__get_room_info mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__suggest_bot_names
---

Call a new bot **into existence** from the session you are in right now.

The ordinary way to make a bot gives you a blank one that starts a fresh Claude
session. This does the opposite: it takes **this** session — with everything it
already knows about what you have been working on — and gives it a face, a voice
and the ability to join calls.

That difference is the whole point. A bot made this way can already answer
questions about the work, because it *is* the thing that did the work.

## What it actually does

1. Creates a new profile (a real, separate bot — its own name, voice and logins).
2. Seeds that profile with **this session's working directory and session name**,
   so its first act is resuming this session rather than starting a new one.
3. Launches it, on its Settings screen.

Steps 1–3 are one call: the `adopt-session-as-bot` IPC handler. The seeding has
to happen *before* the launch, because resuming is the bot's first act — there is
no later moment to apply it.

## Step 1: Work out what session you are

Two things are needed, and they only mean something together — Claude sessions are
stored **per working directory**, so a session name without its directory does not
identify anything.

**The working directory** is this session's `cwd`:

```
pwd
```

**The session name** is recorded at the head of this session's own transcript.
`claude --resume` accepts it:

```
head -2 ~/.claude/projects/"$(pwd | sed 's/[^A-Za-z0-9]/-/g')"/"$CLAUDE_CODE_SESSION_ID".jsonl
```

The first lines carry `custom-title` and `agent-name`. Use that name. If the file
has neither — a session that was never named — say so and ask the user what to
call the bot; do not guess from the directory.

## Step 2: Decide the name

**The bot proposes; the user confirms.** This is not a blank bot filling in a
form — it is a session that already knows what it has been doing, and that is a
far better first thirty seconds than a wizard.

- If `$ARGUMENTS` names a bot, use that. Done.
- Otherwise **suggest one, and say why**, from what this session has actually been
  working on: *"I've been on the auth refactor for three weeks — call me Rowan?"*
  Offer `suggest_bot_names` alternatives beside it.

**The name has to survive being said out loud.** A bot notices it is being spoken
to through Meet's captions; in passive mode that is the only thing that wakes it.
So the session's own name is only usable when a person could say it in a room —
`Rowan` yes, `pr-482-refactor` no. The app applies this test itself
(`addressable-name.js`) and falls back to a random name rather than shipping a bot
that never answers to itself, but propose something sayable in the first place.

## Step 3: Create it

```
curl -s -X POST "http://127.0.0.1:${VIBECONF_LOCAL_PORT:-7865}/api/adopt-session-as-bot" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg w "$(pwd)" --arg s "<session name>" --arg b "<bot name>" \
        '{workdir:$w, session:$s, botName:$b}')"
```

The new bot opens in its own window, on its Settings screen.

## Step 4: Hand over

Tell the user plainly what now exists and what to do next:

- A new bot, named, **resuming this session** — it knows what you know.
- It has **not** been through setup: it has context but has never chosen a voice,
  emoji or background. Its window is open on Settings, and the guided setup call
  is the button at the top.
- **This session keeps running.** Adopting does not end or move it. Two things now
  resume the same session, so do not drive both at once — finish here, then talk
  to the bot.

## What this does NOT do

- It does not join a call. Use `/call` or `/join-call` from the new bot's window.
- It does not run setup. That is `/onboarding-call`, and the new bot is flagged
  for it (`onboardingCallComplete: false`).
- It does not copy anything. The bot **resumes** this session — same session, not
  a fork. Both this terminal and the bot are the same continuous history.
