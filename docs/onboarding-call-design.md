# Onboarding call (design sketch)

Status: **sketch, not yet built.** Captures the design discussion from
[#247](https://github.com/wanderingstan/vibeconf-app/issues/247) (feedback
from Bethany) so it isn't lost between conversations.

## What this is

A live Google Meet call where a freshly-configured bot walks the user through
setting itself up: name, voice, emoji set, avatar background, whiteboard
style, which Claude skills to use, and what to do for after-call work. It's
triggered explicitly ("run a setup call"), not something that happens
silently in the background.

Naming: this is the **onboarding call**, distinct from the existing `onboarding:*`
desktop wizard (main.js:7964-8115, permissions, installing Claude, a
bot-name spinner via `onboarding:suggest-bot-name`, gated by
`store.onboardingComplete`). That wizard runs before any call ever happens.
The intent is for the onboarding call to eventually **supersede** the wizard
entirely, most of what the wizard does today (pick a name, etc.) can be done
better live, in a call, where the bot can actually demonstrate itself (e.g.
testing whether Google Transcription can hear its own chosen name). Until
that migration happens, the two coexist; new code for this feature should be
named `onboarding-call` / `onboardingCall`, not bare `onboarding`, to keep
them distinguishable in the codebase.

## Why in-call, not a settings form

The user is captive in the Meet for the duration, so this doubles as a guided
tutorial and a working sanity-check, not a form to rush through. The bot
should say up front that the user can leave (or say "skip") at any point and
defaults will be used for whatever's left, partial completion is a fine
outcome, not a failure state.

## Design principle: whiteboard-first

Every step's content (options, current pick, instructions) renders on the
**whiteboard** via `update_whiteboard`, not read aloud as a list. Speech stays
short, "pick a name, it's up on the board" / "say it once so I can hear it
back." This is deliberate: it's a gentle, hands-on introduction to the
whiteboard feature itself, which many users (see Bethany's feedback) don't
know they can drive.

For anything too long to fit on one screen without scrolling (the skills
list is the clear case), the bot posts the whiteboard's real URL into chat via
`send_chat`. This needs zero new plumbing, `get_room_info` already surfaces
`whiteboardUrl` as `${websiteUrl}/room/${roomId}?mode=whiteboard&surface=viewer`
(local-server.js:3274). It's also a second, free feature-introduction moment.

## Components

**1. `electron-app/onboarding-call/slides/*.md`**, one markdown template per
step (`01-name.md`, `02-voice.md`, `03-emoji.md`, `04-background.md`,
`05-whiteboard-style.md`, `06-skills.md`, `07-after-call.md`, `08-done.md`),
rendered via the existing `update_whiteboard` tool. `{{placeholders}}` get
filled at runtime (live-enumerated voice list, discovered skills, etc.). No
new whiteboard rendering code needed, this reuses the existing
markdown+Mermaid pipeline.

**2. Trigger**, reuses the existing "Call `<bot>` now" mechanism rather than
inventing a new join path: `joinBtn` (panel.html:107) → `onStartCall(opts)` →
`createAndJoinMeet(opts)` (main.js:1120, :3192). Add a second small
button/checkbox in the preferences panel, "Run setup call," that passes
`{ onboardingCall: true }` through the same `opts`. The bot checks that flag
once `in-call` fires and enters the guided flow instead of normal free
conversation.

**3. `electron-app/skills/onboarding-call/SKILL.md`**, the actual control
logic. Installed the same way the existing `join-call`/`call` skills are
(main.js:5353-5488). Behavior is agent-driven (the bot is a real Claude Code
instance with tool access), not a hardcoded state machine in Electron, this
skill *is* the state machine, expressed as instructions.

**4. Background presets**, `electron-app/backgrounds/presets/*.svg`
(`city`, `clouds`, `desert`, `forest`, `mountains`, `night`, `ocean`,
`skyline`), already made, copied in as-is. They already match
`avatarBackgroundSvg`'s expected shape (landscape, `viewBox="0 0 1280 720"`,
cover-fit safe, preferences-schema.js:262-278), so the background step can
just cycle through them with no new asset work.

## Control loop (sketch, agent-side)

```
ON entering an onboarding call (opts.onboardingCall === true):
  set_mode('passive')   # own the floor; suppress comprehend()-driven free interjection
  post_understanding("Running onboarding call, guided, not free conversation")
  update_whiteboard(slide('00-welcome'))
  say: "Hi! Let's set me up together while you're both here. Say 'skip' at
        any point, or just leave the call, and I'll use sensible defaults
        for whatever's left."

FOR EACH step in [name, voice, emoji, background, whiteboard_style, skills, after_call]:
  update_whiteboard(slide_for(step))       # options + current pick, on the board
  speak(short_prompt_for(step))
  IF content_too_long_for_one_screen(step):
    send_chat("Full list here if it's easier to read: " + whiteboardUrl)
  reply = wait_for_speech(timeoutMs) OR read_chat()
  IF reply is "skip" / silence timeout:
    apply_default(step); continue
  validated = validate(step, reply)
  IF invalid: re-prompt once, then default
  ELSE: apply(step, validated)

  IF room now empty / bot alone (checked via get_room_info):
    end_session(); persist whatever was decided; stop

set_mode('active')
update_whiteboard(slide('08-done'))  # summary of everything decided
say: "All set, here's what I've got. You can change any of this later
      just by asking me."
store.set('onboardingCallCompletedAt', now)
```

## Per-step specifics

| Step | Whiteboard content | Capture | Apply |
|---|---|---|---|
| Name | Explains the transcription constraint | Bot says the candidate name 2-3x and checks how Google's live transcript actually renders it back, this is the one thing the desktop wizard can't test | `store.set('botName', ...)` |
| Voice | Lists ElevenLabs voices (`listElevenLabsVoices`) + OS voices (`list-system-voices`) | Bot cycles `speak(sample, {voice})` through candidates in-call (reuses `speakText`'s existing voice-override routing, main.js:4148-4160), no separate preview mechanism needed | `set_voice(...)`; if no ElevenLabs key, offer to open elevenlabs.io |
| Emoji set | Shows available idle/listening/yielding sets | Verbal or chat pick | `set_avatar_emoji(...)` |
| Background | Cycles the 8 presets live via `avatarBackgroundSvg` | Pick | `store.set('avatarBackgroundSvg', ...)` + caption |
| Whiteboard style | Renders the same sample content in a few `set_whiteboard_style` presets, live, in sequence | Pick | `set_whiteboard_style(...)`, persisted as a named preset |
| Skills | Bot Globs the user's `.claude/skills/*/SKILL.md` itself (own file tools, no app support exists or is needed) and lists what it found, on the whiteboard; posts `whiteboardUrl` to chat since this list is the one most likely to scroll | User says which to use and when | Written into CLAUDE.md as a "Skills" section |
| After-call work | Lists what's available given connected tools (Gmail MCP present? Slack?) | Pick: email summary, nothing, etc. | Written into CLAUDE.md as an "After-call routine" section |

## Open questions

1. **Resumability**, a bot that only gets through 2 of 7 steps (user leaves
   early) shouldn't lose that progress; store partial state
   (`onboardingCallStep`) rather than treating it as all-or-nothing.
2. **Re-running later**, should there be a voice command to redo a single
   step (e.g. "change my voice") outside of a full onboarding call? Likely
   yes, and likely trivial once the skill exists, same slide/apply logic,
   invoked standalone.
3. **Eventual wizard supersession**, once this exists and is solid, the
   desktop `onboarding:*` wizard's name-picking step in particular becomes
   redundant. Not in scope for the first build, but worth flagging so the
   wizard doesn't quietly grow features that duplicate this.
