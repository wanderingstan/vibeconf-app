# Playing with the bot's conversational rhythm

*Companion to the technical reference in [preferences.md](preferences.md).*

This is for tuning by feel: get in a call with your bot (other people and their
bots are fine too — encouraged, actually, since that's when timing problems
show up), talk to it like normal, and adjust a handful of settings live to see
what makes the back-and-forth feel natural versus awkward. No restart needed —
you talk, it changes, the next exchange uses the new value.

## Have the bot walk you through it

You don't have to work from this doc solo. Since your bot can read files in
this repo, just ask it directly:

> "Open docs/timing-playbook.md and walk me through testing each of
> the biggest levers, one at a time — tell me what to do to exercise each
> one, and ask me what it felt like before moving to the next."

It can then read the table below, prompt you through each test in order,
change the setting itself via `set_preference`, and note your answer in the
log — you just talk and react.

## How to change a setting

Just ask the bot in plain language, mid-call:

> "Set your barge-in grace to 800 milliseconds for this session."

> "Make your silence threshold 2.5 seconds."

It calls `set_preference` under the hood and the change is live for your next
turn. To check what's currently set:

> "What's your barge-in grace right now?"

Changes are saved to *your* bot's profile only — they don't touch anyone
else's bot in the call, and they'll still be there next time you launch
(until you change them again).

**Heads up:** because this shapes how the bot interacts with everyone in the
room, not just you, it's worth telling other people on the call when you're
about to try something extreme (a very short barge-in grace can feel like the
bot rudely cutting people off — that's the point of testing it, just don't
surprise anyone).

## The knobs worth playing with

Roughly in the order they fire during a turn — silence detection comes
first, barge-in only matters once the bot is already talking. For each one,
the "test it" column is the actual thing to *do* in the call to make that
setting's effect show up — changing a value and just continuing to chat
often won't exercise it at all.

| Setting | What it does | Test it by | Starting point |
|---|---|---|---|
| `defaultSilenceSeconds` | How long a gap before the bot assumes you're done talking | Say something with a real mid-sentence pause — *"So basically... [pause a beat] ...it just works"* — and see if the bot jumps in before you finish. Then try a value where it doesn't. | 1.4s |
| `nameMentionSilenceSeconds` | Same, but when someone says the bot's name directly | Say the bot's name, pause briefly, and time how fast it responds. Compare against a normal turn where it's *not* named. | 1.0s |
| `thinkingHoldMs` | How long the bot can sit in "thinking" before its status/face stops looking stuck | Ask something that makes it think for a while (a multi-part or open-ended question) and watch its status through the wait — does it look "stuck" before it answers? | 8s |
| `botSpeakJitterMaxMs` | Random delay before the bot starts speaking, so multiple bots don't talk in lockstep | Needs 2+ bots in the call. Ask a question to the whole room so more than one bot wants to answer at once — do they collide/overlap, or stagger cleanly? | 2s |
| `bargeInGraceMs` | How long the bot keeps talking after you start talking over it, before it actually stops | Get the bot mid-sentence on a longer answer, then deliberately talk over it. Count roughly how many words of overlap happen before it actually stops. | 2.5s |
| `autoLeaveGraceMs` | How long the bot waits alone in an empty call before leaving | Everyone else leaves the call, leaving just the bot. Time how long it stays before it exits on its own. | 10s |

Not everything is tunable this way yet — the raw voice-detection layer
(how it decides someone is making sound at all) is still hardcoded. If
something feels off at that level rather than in the turn-taking above,
note it in the log below rather than trying to chase it with these
settings — see [issue #351](https://github.com/wanderingstan/vibeconf-app/issues/351)
for the full list of what's tunable versus not.

## Suggested first session

Work through the table top to bottom, changing one setting at a time and
running its test two or three times before moving on — a single weird pause
can be a fluke, not the setting. `bargeInGraceMs` is worth doing first since
it's the one people feel most viscerally; save `botSpeakJitterMaxMs` for
whenever there happen to be two or more bots in the call, since it needs
that to test at all.

## Log

Jot down what you tried so we're not re-discovering the same thing twice.
Doesn't need to be formal — a running table in this doc, or a Slack thread,
whatever's easiest.

| Date | Setting | Value tried | Who/what was on the call | Felt like | Keep? |
|---|---|---|---|---|---|
| | | | | | |

## Resetting

To go back to the shipped default, just ask: *"Reset bargeInGraceMs to its
default."* Or check [preferences.md](preferences.md) for the full default
table and set it back explicitly.

## Where this goes next

If a handful of these turn out to matter a lot, that's the signal to build
the real settings UI (there's a mockup already sketched — ask Stan) instead
of guessing which of the ~70 timing constants deserve a slider. This doc is
the cheap way to find out first.
