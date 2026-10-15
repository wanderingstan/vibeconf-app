---
name: onboarding-call
description: Run a short live setup call. The bot pre-picks every setting, shows them on one whiteboard card, and lets the user get to work, change one thing, or see a demo
argument-hint: "[meet code] [BotName] (same room/profile routing as /call and /join-call)"
disable-model-invocation: true
allowed-tools: Read Glob Edit Bash(defaults read -g AppleLocale) Bash(locale) mcp__vibeconferencing__start_call mcp__vibeconferencing__join_call mcp__vibeconferencing__list_call_instances mcp__vibeconferencing__get_room_info mcp__vibeconferencing__wait_for_speech mcp__vibeconferencing__speak mcp__vibeconferencing__update_whiteboard mcp__vibeconferencing__share_whiteboard mcp__vibeconferencing__reload_share mcp__vibeconferencing__set_whiteboard_style mcp__vibeconferencing__read_chat mcp__vibeconferencing__send_chat mcp__vibeconferencing__suggest_bot_names mcp__vibeconferencing__list_visual_assets mcp__vibeconferencing__list_voices mcp__vibeconferencing__set_voice mcp__vibeconferencing__set_avatar_emoji mcp__vibeconferencing__list_preferences mcp__vibeconferencing__set_preference mcp__vibeconferencing__set_caption_language mcp__vibeconferencing__set_mode mcp__vibeconferencing__start_recording mcp__vibeconferencing__stop_recording mcp__vibeconferencing__leave_call mcp__vibeconferencing__end_session
---

Run a short **setup call**: a live Meet where this bot shows the user how it is configured
and gets out of the way. Triggered by the panel's "Setup" button, or by hand with
`/onboarding-call`.

This is `/call`'s sibling (same room mechanics). If you haven't read `/call` or
`/join-call`, the tool reference there (`wait_for_speech`, `speak`, `get_room_info` status
polling, mode table, chat, whiteboard sharing) all applies here unchanged.

`/join-call` and `/call` both check the `onboardingCallComplete` preference and redirect
here automatically when it's unset, so most runs of this skill are a bot's first time.

**This used to be a walkthrough of nine questions, and people said it took too long.** Stan
decided on 2026-10-15 to replace it with one screen of defaults: pick everything yourself,
show it on one card, say one sentence, and let the user decide what happens next. **The fast
path asks zero questions.**

**Check `list_preferences` for `onboardingCallComplete` first.** If it's already `true`,
someone is re-running this on purpose to change something. Run the same steps, but the card
shows the bot's CURRENT values (not fresh defaults: never overwrite a choice they made last
time), and the sentence in Step 4 asks what they'd like to change. The card is the menu of
what can be reconfigured: it lists the SAME items the "Changing one setting" reference below
covers, so they can name one.

## Step 1: Get into a call, joining one that exists or starting a fresh one

`get_room_info` FIRST, before `start_call`.

- Already `in-call`? You are where you need to be. Skip to Step 2.
- Not in a call, but it reports **detected Google Meet URLs**? Someone has a call open right
  now. `join_call` that room instead of creating one.
- Nothing detected? `start_call` (`bot_name` only if `$ARGUMENTS` names one), then wait for
  `Call status: in-call`.

Creating a second Meet when one is already open puts the user in a different room from the
person they were talking to. Setting yourself up is not a reason to move the meeting.

**Your name must be right BEFORE you join**: Meet takes the display name at join and will
not change it in place. It almost always is already, because every way of creating a bot
("New bot…", the first-run wizard, a brand-new profile's first launch) seeds a random name
from the curated pool. If `botName` still reads "Unnamed bot" and you are not yet in a call,
`suggest_bot_names` with `count: 1` (one random pick, minus names other bots here use), then
`set_preference("botName", ...)`, then join. Already in the call under the placeholder? Set
it the same way and note on the card that the tile updates next call. Do not leave and
rejoin for a name nobody asked for: that is the rename procedure, for when they ask.

## Step 2: Pick everything yourself, silently

No questions in this step. Read `list_preferences` once and fill in the card from what is
already set; a new bot is seeded with most of this at creation.

| Setting | Default |
|---|---|
| Name | `botName` (seeded at random; see Step 1) |
| Language | the computer's locale (below) |
| Voice | whatever `ttsVoiceId` / `macosVoice` already names; else the system default voice |
| Personality | none: plain Claude (or whichever agent is really running underneath) |
| Emoji set | `emojiSet` as set (the app default) |
| Background | `avatarBackgroundCaption`: new bots get a random preset at creation. If it is somehow empty, pick one from `list_visual_assets` at random and set it as the Background reference describes |
| Whiteboard style | the default board style |
| After-call routine | whatever this bot's `CLAUDE.md` already says to do; else "nothing" |
| Skills & tools | one line naming what your connected tools let you do ("email, images, Slack") |

**Language from the computer's locale.** Captions are transcribed in ONE configured
language, and you hear the room by reading them, so this is the one default that can break
the call if it is wrong.

1. If `captionLanguage` is already set (the first-run wizard asks), use it. It was applied
   when you joined.
2. Otherwise read the locale: `defaults read -g AppleLocale` on macOS (`en_US`, `de_DE`),
   `locale` on Linux (`LANG=en_GB.UTF-8`).
3. **English** (`en_*`)? `set_caption_language` with the matching tag (`en_GB` → `en-GB`,
   anything else English → `en-US`) and move on. No question.
4. **Not English, or the read failed?** Fall back to the Language reference below, and run
   it BEFORE the card (`share_whiteboard` first, per Step 3), with the detected language
   highlighted on the board if you have one.
   It is the only question that may come before the card, and only for these users: a card
   read out in the wrong language, then answered through the wrong captions, is not a fast
   path for anybody. Once it lands, speak that language for the rest of the call.

## Step 3: Put the whiteboard on screen, with one card

`share_whiteboard` first, then `update_whiteboard` with the card. `update_whiteboard` only
sets the board's CONTENT; it does not present it, and without the share every tool call
succeeds while nobody sees anything.

Once per call, not once per step. Re-sharing a board that is already up interrupts the
presentation everyone is watching. **The one exception: a share does NOT survive leaving the
call.** After any rejoin (a requested rename is the usual one), `share_whiteboard` again
before the next update. If you are unsure whether the board is up, `get_shared_screenshot`
tells you in one call; prefer checking to guessing, because the failure is silent both ways.

**The card has to fit one 800px screen: the whiteboard cannot scroll.** A compact table, one
short line per row, no images, no explanations:

> ## 👋 Hi, I'm Juno
>
> | | |
> |---|---|
> | ✏️ Name | Juno |
> | 🌐 Language | English (US) |
> | 🔊 Voice | Rachel |
> | 🎭 Personality | Just me, no persona |
> | 😀 Emoji | fluent3d |
> | 🖼️ Background | snowy-hills |
> | 🎨 Whiteboard | Default |
> | 📋 After calls | Nothing yet |
> | 🧰 I can use | email, calendar, images |
>
> **Just tell me if you want to change any of these.**
> Or ask for a demo, or get right to work.

## Step 4: Say one sentence, and mark setup done

ONE short phrase. Not a readout of the settings: the card carries them, and reading nine rows
aloud is the slow walkthrough again by another route. Stan's wording, close enough:

> "I've put all my settings on the whiteboard. Let me know if you want to change anything,
> get a demo, or get right to work."

On a re-run: *"Here's how I'm set up. What would you like to change?"*

Then, silently, `set_preference("onboardingCallComplete", true)`. Every setting now has a
value, so setup is done whatever they say next: a user who leaves right now, or never
changes a thing, has been through onboarding. This is what `/join-call` and `/call` check to
decide whether a *future* call should redirect here. Set it once the card is up and the
sentence is said, not earlier: a bot that never got as far as showing its settings has not
been onboarded.

## Step 5: Three paths. Follow theirs

`wait_for_speech` (and `read_chat` when it flags unread messages; either channel is an
answer). Then:

1. **Get right to work.** They say so, or just start talking about something else, or say
   nothing at all. Setup is already finished (Step 4). Don't confirm, don't recap, don't ask
   a follow-up: carry on as a normal call, the same loop `/join-call` describes. This is the
   zero-question path and it must stay that way.
2. **Change one thing.** Handle just that item, using its section under "Changing one
   setting" below: same tools, same board tricks. Then `update_whiteboard` the card with the
   new value, confirm in a few words, and go back to waiting. Don't offer the next item;
   they can see the card.
3. **A demo.** Step 6.

**Never ask anyone to say a bare number.** Tested on 2026-08-04: saying "one" produced NOTHING
in the captions, while "option one" and "Deutsch" came through immediately. So for any list
on the board, label the entries **"Option 1", "Option 2"**, not "1.", "2.". That way
someone reading "Option 3" says "option three" without being told; bare digits invite
exactly the bare number you cannot hear.

## Step 6: The demo, when they ask for one

Settings are a form; the demo is the product. Pulling up a website, reading a screen share,
playing a game: the things that make someone say "oh, it can do *that*".

**Put the menu on the whiteboard**, replacing the card. Bare speech here leaves the screen
showing settings at the most interesting moment. `update_whiteboard` with a titled list
("Things I can do"), grouped into a handful of short categories with an emoji per line,
drawn from "Demos that always work" below, the add-on demos under "Only offer what this
machine can actually do" when they're installed, and the list this step ends with. Keep it
to one screen: grouped, one short line each.

Then pick ONE thing off the board and **do** it live, rather than describing the whole menu
aloud:

> "Want me to draw something, or play a quick game on the whiteboard?"

Doing five things back to back turns a setup call into a product tour nobody asked for; one
good demo sells the rest of the board better than reading it aloud would.

Don't open with "before I go". Nothing has suggested you are leaving, and saying it invites
them to end the call one sentence before the best part of it.

### Only offer what this machine can actually do

**This is the part to get right.** Offer from the skills and connected MCP servers you
actually have in THIS session (your own tool list; see "What you can do" below), not from the
product page. A demo that opens with "watch me generate an image" and then discovers there
is no image tool is a worse ending than no demo at all: the last thing they see is the bot
failing at its own showcase.

That is an argument for offering the right *version* of a demo, not for offering less. Two
common traps, and **neither one means "skip the demo"**:

- **Drawing.** A photorealistic image needs an image MCP server (nanobanana or similar), and
  many installs have none. That is not a reason to drop the offer: *you can write SVG*, and
  the Background reference below does the same for a described background. Hand-
  written SVG is genuinely good for the things people ask for on a call — a diagram, a logo
  sketch, a chart, a cartoon — so offer to *draw* rather than to *generate a photo*, and put
  the result on the board. Then make the upsell, once, in a sentence: *"That's me drawing it
  by hand. Plug in an image generator and I can do photographic stuff — and with a video
  model, short clips too."* That lands better than the photo would have, because they just
  watched you do the hard version.
- 🌐 **Drive a live browser tab** (`share_tab`) needs the Claude-in-Chrome extension
  installed and connected. Without it the bot can still put a URL on the whiteboard, which
  is a fine demo in itself — just do not promise a driven, logged-in browser you cannot
  drive. When it IS connected, put it on the board as a named option, not just a sentence:
  it is one of the biggest reactions available.

  When you *do* have it, **make it a search you then refine out loud** — that is the demo,
  not the page load. Put it on the board with two named options and let them pick, rather
  than deciding for them:

  - ✈️ **Find a flight** — the safe default, and the one to lead with. Open Google Flights,
    find a flight from their city to somewhere, then take three follow-ups from the room —
    "non-stop only", "business class", "leave Friday instead" — and drive each one live
    while they watch. What sells it is the second and third refinement: a bot that loads a
    URL is a bookmark, a bot that narrows a search while you talk is a person at the
    keyboard. Use *their* city; a route they actually fly is worth ten of a generic one.
  - 🍔 **Order food** (Uber Eats or similar) — only when the room actually wants it: several
    people present, they raise or accept the idea themselves, and a logged-in account is
    already available. It spends real money, so **never place an order without an explicit
    spoken yes from whoever is paying**, confirm the order and address back before
    submitting, and if anyone hesitates, go back to flights.

The rule is not "only demo what is installed", it is **never promise a capability you do not
have**. Offer the version you can actually deliver, deliver it, and name what an add-on would
buy them. Don't check by trying it in front of them, and if you are genuinely unsure, offer
something else.

### Demos that always work, with nothing else installed

These need only the tools this skill already used, so they are safe on any install and make
a good default pair:

- 🎮 **A game on the whiteboard** — hangman, twenty questions, a quiz. Reliably the biggest
  reaction, and it uses nothing but `update_whiteboard` and speech.
- 🗺️ **Diagrams** — `update_whiteboard` renders Mermaid, so a mind map, a flowchart, or a
  data chart (pie, bar) is one tool call away, no image server required. The demo that lands
  best: ask them to describe something with real structure — how their team is organized,
  the steps in a process they just mentioned, the decision they're stuck on — and turn it
  into a live flowchart or mind map while they watch, then take one follow-up ("add a step
  for review", "split that box in two") and redraw it on the spot. A diagram that already
  existed is a screenshot; one built from what they just said, and then revised on request,
  is the actual demo.
- 📝 **Live notes** — "talk at me for thirty seconds about anything and watch the board."
  Shows the thing they will actually use it for every day.
- 🎭 **A persona** — instant, and it demonstrates that tone is theirs to set. Offer one silly
  and one *useful*, because the useful ones are what actually change how they use the bot:
  - **Parliamentarian** — runs the meeting by Robert's Rules. Motions, seconds, points of
    order, the lot.
  - **Facilitator** — keeps time, makes sure everyone has spoken, calls out when the room has
    drifted off the agenda.
  - **Mediator** — neutral, restates each side's position, finds the actual disagreement.
  - **Pirate / sports commentator** — for the laugh.

  Lead with a useful one. "I can run this as a parliamentarian" reframes the bot from a toy
  into something they would invite to a real meeting, and the silly one still gets its laugh
  straight after.
- 🔊 **Sound effects and voice switching** — a one-liner in three voices.
- 🎨 **Draw something in SVG** — "name a thing and I'll draw it on the board." No image
  server required, per the note above.
- 👀 **Reading their screen share** — ask them to share something and describe what is on it.
  Needs nothing installed on the bot's side, and it surprises people every time.
- 🤳 **Take a selfie together** — `get_call_screenshot` captures the whole call view, bot's
  own tile included, so frame it as a selfie rather than surveillance: "let's take a selfie,"
  then describe what's in the shot: your own tile first, then the guitar on the wall behind
  them, the camera that's off. It makes people sit up, because nothing else in the call
  signals that the bot can *see*. Keep it warm and
  observational: comment on what people chose to put in frame, never on how they look.
- 🎥 **Recording the call** — `start_recording` / `stop_recording` save the bot's own voice,
  everyone else's audio, and the bot's video, muxed into one `call-recording.mp4` at the end.
  Works mid-call, not just at the start; mention it can be started any time someone realizes
  the conversation is worth keeping.

### The rest of the board — put these up even if you don't demo them

These fill out the menu without needing a live demo. List them because they are true of
every install, not because you are about to do all of them:

- 📄 **Read a screen share, a chat message, or the call transcript** — "what did I say about
  that earlier?" works because the bot can look back at what already happened in the call.
- 💬 **Change how it behaves mid-call** — voices, languages, active/passive/silent listening,
  a hard stop time to watch for. All of this is just asking; nothing to install.
- 🐙 **Contribute on GitHub** — Vibeconferencing is open source. If something is missing or
  broken, they can open an issue or a PR directly:
  `github.com/wanderingstan/vibeconf-app`.

### Then hand them the list

Once the demo lands, `send_chat` the full capability list so they can browse it later:

> https://vibeconferencing.com/what-you-can-ask

Say it is there rather than reading it aloud — it has more than fits the board, including
things that need an add-on.

### Only now: say how the call ends

Held back until now on purpose: an exit offered before the demo gets taken. But
the call does not end itself, and people otherwise sit wondering. Two things:

> "Tell me when you're done and I'll drop off — or if you'd like to introduce me to someone,
> invite them in and we'll carry on."

Leaving is the one that matters: the demo is over, the whiteboard is full, and there is no
obvious signal that the bot is waiting rather than working. Someone who does not know they
can simply say "you can go" will close the tab on you, or worse, sit through a silence
wondering whether something is still running.

The invite half lands here and not earlier: they have just watched the fun half, so this is
the moment a new bot is most worth showing someone — and nothing about a setup call suggests
you can simply add people to it.

Then stop. If they want another demo, they will ask. From here you are just having a normal
call: `leave_call` when they say they're done, or keep going as a regular conversation (the
same loop `/join-call` describes). If someone new joins, greet them by name and carry on —
you are a normal call now, not a wizard.

## Changing one setting (reference)

The know-how for each row of the card. Run ONE of these when someone asks to change that
row (path 2 of Step 5), never as a sequence. Each one: put its options on the board, `speak`
a short prompt, `wait_for_speech`, apply, then put the card back with the new value. If the
section restyled the board for a grid, restore its style first (`""`, or the one they
chose). If they say "skip" or go quiet, keep what was already set.

### Language

Also the fallback Step 2 runs BEFORE the card when the computer's locale is not English or
cannot be read. It goes first for a mechanical reason, not politeness: you hear the room by
reading Meet's captions, and captions are transcribed in ONE configured language. Set to the
wrong one, Meet turns correct speech into nonsense and you answer the nonsense — confidently.
Everything after depends on it, a name most of all: checking whether "Solene" comes back
cleanly means nothing until the language is right.

**Write each language in its own language.** A list written in English is unreadable to
exactly the people this step exists for.

| # | Language | # | Language |
|---|---|---|---|
| 1 | English (US) | 9 | 中文 (普通话) |
| 2 | English (UK) | 10 | 한국어 |
| 3 | Español | 11 | العربية |
| 4 | Français | 12 | हिन्दी |
| 5 | Deutsch | 13 | Bahasa Indonesia |
| 6 | Italiano | 14 | Nederlands |
| 7 | Português | 15 | Polski |
| 8 | 日本語 | 16 | Türkçe |

Ask them to **say the language's name, as written on the board** — "Español", "日本語",
"Deutsch". That is the most reliable answer here and it is already in their own language, so
it needs no English at all.

Label the entries "Option 1", "Option 2" … per the rule above, and offer that as the
alternative: *"Say your language, or say the option number."* Short, and slowly. Never ask for
a bare number — "Deutsch" and "option three" both transcribe; "three" does not.

**If ElevenLabs is available, greet them in a few languages first.** `list_voices`: if it
lists ElevenLabs voices, a key is configured, and those voices speak other languages
transparently and pronounce them properly — one voice, any language, no switching. Say a
short hello in three or four (Spanish, French, Japanese, whichever suit the room) before
asking for the number.
Someone who does not speak English learns by ear, not from a sentence they cannot parse,
that this will work in their language.

**Skip it when there is no ElevenLabs key.** The operating system's built-in voices are tied
to a language: pushing Spanish text through an English system voice produces a mangled
accent, which advertises the opposite of what you are trying to show. With OS voices, just
ask for the number.

Then `set_caption_language` with the matching tag: 1 `en-US`, 2 `en-GB`, 3 `es-ES`,
4 `fr-FR`, 5 `de-DE`, 6 `it-IT`, 7 `pt-BR`, 8 `ja-JP`, 9 `cmn-Hans-CN`, 10 `ko-KR`,
11 `ar-x-LEVANT`, 12 `hi-IN`, 13 `id-ID`, 14 `nl-NL`, 15 `pl-PL`, 16 `tr-TR`.

If they name a language that is not on the board, just set it — the list is a shortcut for
people who cannot easily say what they want, not the limit. Meet supports far more, and a
bare tag like `es` resolves to the first regional variant it offers.

It takes a few seconds (it walks Meet's Settings dialog). Once it lands, **switch to
speaking that language yourself** for the rest of the call, and prefer a voice suited to it
(see Voice). If they picked English, say so briefly and move on — do not make a ceremony of it.

### Name

The name on the card was picked at random (Step 1) — a starting point, not a choice, and
"Unnamed bot" is a placeholder, not a choice either. When they ask to change it:
**Offer names first.**

1. `suggest_bot_names` and put them on the whiteboard as a grid, with your current name shown
   as the one you have for now. Say something like *"Here are some others. Take one of
   these, or tell me anything you like."*
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
change it in place.** A rename the user asked for is the one time a leave and rejoin is the
normal procedure (Stan, 2026-10-15). Only in this exact order:

1. Tell them what is about to happen: *"I'll pop out and straight back in so the name sticks
   — give me a couple of seconds."*
2. `leave_call`
3. `join_call` with the SAME room id, immediately.
4. **`share_whiteboard` again.** Leaving the call ended your presentation. The board still
   has everything on it, so nothing looks wrong from your side — `update_whiteboard` keeps
   succeeding, and the card and everything after it go to a screen nobody can see. Observed in a real setup call: the bot renamed itself, came back, and
   never re-shared. Do this as the tool call straight after the rejoin, before you say
   anything else.

**Leave BEFORE you rejoin, never the other way round.** Joining again while still in the room
puts a second participant there and leaves the first sitting inert — a zombie the user has to
clear up.

Why this is safe, and why it looks like it should not be: `leave_call` does begin tearing the
call down, and if you leave and never come back it ends your session. But leaving first opens
the after-call work window (five minutes by default), and you are alive for all of it — so a
rejoin inside that window is an ordinary join, and the teardown is cancelled when you come
back. What you must not do is dawdle: rejoin as the very next tool call, not after a
conversation.

If the rejoin fails for any reason, say so and carry on — the name is already
saved either way and applies to the next call regardless.

### Voice

`list_voices` to see what's available (ElevenLabs voices, if a key is configured, plus the
OS's built-in voices). Put the list on the whiteboard, labelled **"Option 1", "Option 2" …**
— a voice name is often harder to say than a language name. Then let them **hear**
candidates in the call: `speak` a short sample line in each voice via `speak`'s `voice`
parameter, cycling through 3-4 options as they say "next" / "that one". Once picked,
`set_voice` (or `set_preference("ttsVoiceId", ...)` / `set_preference("macosVoice", ...)`
as appropriate to what `set_voice` needs).

If no ElevenLabs key is configured, say so plainly and offer to open elevenlabs.io for
them (mention it; you can't open a browser yourself from here), then continue with the
built-in OS voice as the default rather than blocking on it.

### Personality / role

The default is plain Claude (or whichever agent is actually running underneath — say the
real one, not "Claude", if it's different). When they ask to change it, put concrete
examples on the board rather than asking the open question cold, since "what personality do
you want" invites a shrug from someone who has never been asked:

> **Keep me as I am** — the default, no persona
> 🏛️ **Parliamentarian** — runs meetings by the rules, motions and all
> 🕰️ **Facilitator** — keeps time, makes sure everyone's spoken
> ⚖️ **Mediator** — neutral, restates each side, finds the actual disagreement
> 🏴‍☠️ **Something for fun** — a pirate, a sports commentator, whatever they like
> **…or describe your own**

If they pick or describe one, `Edit` this bot's own `CLAUDE.md` to record it under a
"## Personality" section, in enough detail that a future session reading the file — not this
call — knows how to act: not just the label ("Parliamentarian") but what that means in
practice (formal tone, calls for motions and seconds, keeps a running agenda). This is what
makes it stick after the call ends, unlike the persona demo in Step 6, which only changes
tone for the rest of THIS conversation. If they decline, skip the edit entirely — an empty
or default "## Personality" section is noise, not a decision worth recording.

### Emoji set

**Show the sets, do not list them.** "fluent3d, twemoji, openmoji, noto, redpanda" means
nothing to anyone; the same face in each, side by side, answers the question instantly.

**Size the images first — this is not optional.** The source files have wildly different
intrinsic sizes (the fluent3d PNG is hundreds of pixels, the noto SVG is tiny) and markdown
cannot size an image, so a plain grid renders one giant face beside three small ones and
reads as "these sets differ in quality". Columns end up uneven too, because the table sizes
itself around whatever the widest image happens to be.

Both problems are CSS, so set it before drawing the grid:

```
set_whiteboard_style("table { table-layout: fixed; width: 100% } th, td { text-align: center; vertical-align: middle; padding: 8px; background: transparent } table img { height: 84px; width: auto; margin: 0 auto } .native-face { font-size: 68px; line-height: 1 }")
```

`table-layout: fixed` is the part that equalises the columns; the `height` on images is what
makes files of wildly different sizes look like one set of options.

**`background: transparent` on `th` is not cosmetic fiddling.** A markdown table's first row
IS its header row, so in the grid below the FACES land in `th` and the names land in `td` —
and the board's stylesheet gives `th` a grey fill. The result is every emoji sitting in its
own grey box with the labels underneath on the board's normal background, which reads as
though the images are broken or still loading. Transparent lets the board's own background
show through, so the faces sit on it like the rest of the content. Same reason the styles
apply to `th, td` together rather than `td` alone.

`list_visual_assets` gives you a 🙂 from each image set as an absolute path. **Use whatever
it returns — do not hardcode the list.** Sets get added (redpanda arrived this way), and a
grid built from a remembered list quietly stops offering the newest one.

Images on one row, names on the row beneath. With the bundled sets plus `native` that is
currently six cells, which is two rows of three — three columns keeps each face big enough
to actually judge, where six across shrinks them to thumbnails:

| ![fluent3d](/path/…/1f642.png) | ![redpanda](/path/…/1f642.png) | ![twemoji](/path/…/1f642.svg) |
|---|---|---|
| fluent3d | redpanda | twemoji |

| ![openmoji](/path/…/1F642.svg) | ![noto](/path/…/emoji_u1f642.svg) | <span class="native-face">🙂</span> |
|---|---|---|
| openmoji | noto | native |

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

**Someone can bring their own set.** `set_preference("emojiSet", "dir:/path/to/folder")`
points the face at a folder of images — one file per emoji, exactly like the bundled
fluent3d set. Worth mentioning only if they seem interested; it is a nice thing to offer
someone who has a brand, a mascot, or a favourite artist.

Any filename convention works (`🙂.png`, `1f642.png`, `1F642.svg`, `emoji_u1f642.png`;
png/svg/webp/gif/jpg), and a partial set is fine: anything with no file keeps the native glyph.

**You can build one for them, and there is a skill for it: `/emoji-set`.** Give it a theme
description and it generates the faces the avatar actually wears, plus a matching call
background, then points the bot at them. The bundled `redpanda` set was made exactly this
way, so it is a fair thing to promise.

It needs an image generator (nanobanana) on this machine. Without one, still mention the
folder — someone with a mascot or an artist friend can drop in their own PNGs.

One trap, if the art has text or a left/right: Meet MIRRORS the bot's own tile in its
self-view, so it looks backwards in `get_call_screenshot` and in the Bot's view window
while everyone else sees it correctly. Do not pre-flip the images to "fix" it.

### Background

**One grid, all of them at once** — not a slideshow. `list_visual_assets` returns every
preset with its absolute path; put them in a markdown table as images with the name under
each, so the whole choice is visible in a glance and they can just say "the city one".

**Restyle for these before drawing the grid**, exactly as for emoji — and with different values,
because these are 16:9 scenes rather than square glyphs. Fixing the height (the emoji rule)
leaves each one a different width and the columns ragged; fixing the WIDTH is what makes a
tidy grid:

```
set_whiteboard_style("table { table-layout: fixed; width: 100% } th, td { width: 33%; text-align: center; vertical-align: top; padding: 8px; background: transparent } table img { width: 100%; height: auto; display: block }")
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

### Whiteboard style

Render the same short sample content in 2-3 different `set_whiteboard_style` presets, one
after another, so they see real differences rather than describing CSS in the abstract.
(Unlike the background grid this has to be sequential — the style applies to the whole board,
so they cannot sit side by side.)

**Offer the describe-it path as an equal option, not a fallback**, exactly as for backgrounds. Put it
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

### What you can do — skills AND connected tools

**This is the one board most likely to scroll:** `send_chat` the whiteboard's shareable URL
from `get_room_info` (the `?mode=whiteboard` one) so they can open it full-size in a tab.

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
to know what was left out. This is also the menu the after-call routine needs — someone cannot ask for
an emailed summary after each call if nobody mentioned that email is available.

Ask which of it this bot should use, and when. Then `Edit` this bot's own `CLAUDE.md` (in the
agent's working directory) to record the decision under "## Skills" / "## Tools", so it
persists across sessions rather than living only in this call's memory.

### After-call routine

Build this out of what "What you can do" surfaces — the connected servers are the menu. If Gmail is
wired up, "a summary in your inbox after every call" is a real offer; if Slack is, so is
"posted to a channel"; with an image generator, "a diagram of what we covered". Name the
concrete options rather than asking the open question "what would you like?", which invites
a shrug from someone who does not know what is possible.

Ask what they'd like done automatically after calls: a summary email, nothing, something
else. `Edit` CLAUDE.md to add an "## After-call routine" section with
the decision.
