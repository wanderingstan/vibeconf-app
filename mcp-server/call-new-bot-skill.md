---
name: call-new-bot
description: Turn THIS Claude session into a bot and bring it into a call — creates a new bot that resumes this session, then joins the call already in progress (or a fresh Meet if there is none)
argument-hint: "[meet code | Meet URL | Slack huddle URL | Zoom/Teams link] [BotName]  — both optional; no call given = join the call in progress, else start a new Meet"
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

1. Works out **which call** the bot should join (below).
2. Creates a new profile (a real, separate bot — its own name, voice, logins
   and port). Never an existing one: it does not rename or move a bot that is
   already running, so nothing is pulled out of the call it is in.
3. Seeds that profile with **this session's working directory and session name**,
   so its first act is resuming this session rather than starting a new one.
4. Launches it straight into that call, with its agent behind it.

All of it is one call: the `adopt-session-as-bot` handler. The seeding has to
happen *before* the launch, because resuming is the bot's first act — there is
no later moment to apply it.

### Which call

In this order, first match wins:

1. **A call you named.** A Meet code (`abc-defg-hij`), a Meet URL, a Slack huddle
   URL (`https://app.slack.com/client/<team>/<channel>`), or a Zoom or Teams
   meeting link.
2. **A call already in progress**: one any running Vibeconferencing bot on this
   machine is in (or joining). Several bots in the same meeting count as one call.
3. **A Meet open in your browser** (Chrome, Brave or Safari tab scan; macOS only).
4. **Nothing found** → a fresh Google Meet is created, the bot joins it, and your
   browser opens to it.

At steps 2 and 3, **more than one distinct call means the app asks rather than
guesses**: nothing is created, and the reply lists the candidates.

A bot joining a call **already in progress** joins as a participant. It does not
run its guided setup there (that is a conversation with you, not with the room);
it stays flagged for setup and gets it on a call of its own.

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

## Step 2: Parse the arguments, and decide the name

`$ARGUMENTS` may carry a **call** and/or a **name**, in either order. A token is
the call if it is a Meet code (`xxx-xxxx-xxx`) or a URL (`meet.google.com`,
`app.slack.com/client/…`, `zoom.us/…`, `teams.live.com` / `teams.microsoft.com`).
Pass it through as `target` exactly as given; the app does the parsing. Whatever
is left is the bot name. No call token → omit `target` and let the app find one.

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
  -d "$(jq -nc --arg w "$(pwd)" --arg s "<session name>" --arg b "<bot name>" --arg t "<call, or empty>" \
        '{workdir:$w, session:$s, botName:$b} + (if $t == "" then {} else {target:$t} end)')"
```

Any running instance will do as the receiver: the new bot is always a new
profile on its own port, whichever app you ask.

Read the reply:

- **`ok: true`** — `profile` is the new bot's profile, and `call` says where it
  went: `call.source` is `explicit`, `in-progress`, `browser` or `new` (with
  `call.url`, the link to the fresh Meet). The bot is joining; someone in the
  meeting may need to **admit** it.
- **`needsChoice: true`** — more than one call is in progress. Nothing was
  created. Show the user `candidates` (room id, and which bots are in each) and
  ask which one; then run Step 3 again with that room as `target`.
- **`ok: false`** with `error` — say it plainly. A Zoom or Teams call a bot is
  already in cannot be rejoined from its room id alone; ask for the link.

## Step 4: Hand over

Tell the user plainly what now exists and what to do next:

- A new bot, named, **resuming this session** — it knows what you know.
- **Which call it is joining**, and why (the one you named, the one already in
  progress, the Meet in your browser, or a new Meet whose link you give them).
- It has **not** been through setup: it has context but has never chosen a voice,
  emoji or background. In a fresh Meet that is the first thing it does; in a call
  already in progress it skips it, and setup is the button at the top of its
  Settings screen for later.
- **This session keeps running.** Adopting does not end or move it. Two things now
  resume the same session, so do not drive both at once — finish here, then talk
  to the bot.

## What this does NOT do

- It does not move an existing bot. `/join-call <code> <name>` drives a bot that
  is already running; this always makes a new one.
- It does not run setup in someone else's call. The new bot is flagged for it
  (`onboardingCallComplete: false`) and runs it only in a call of its own.
- It does not copy anything. The bot **resumes** this session — same session, not
  a fork. Both this terminal and the bot are the same continuous history.
