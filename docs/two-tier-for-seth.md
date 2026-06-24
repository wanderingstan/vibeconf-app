# How we're changing the way the bot "thinks" (plain-language summary)

*A non-technical companion to [two-tier-design.md](two-tier-design.md).*

Right now the bot has a single brain: one big, smart AI model. It's great at
understanding and saying smart things, but it's slow — every time someone finishes
talking, it thinks from scratch about what to say. That's what those awkward
multi-second pauses are.

We're moving to a **two-brain setup**:

- A **fast brain** — a small AI model running right on the laptop (free, basically
  instant). It handles the quick reflexes: reacting in real time, deciding whether to
  jump in, and phrasing what to say.
- A **slow brain** — the big, smart model. It still does the deep thinking, but only
  when it's actually needed, not on every single reply.

What ties them together is the bot's **working memory** — a little running set of notes
it keeps about the conversation, updated continuously in the background *even while it's
just quietly listening*. The notes track three things: what's being discussed right now,
the point the bot would make if it got a chance to speak, and who's in the room and what
matters about them (who's the expert, who's been quiet, etc.).

Here's why that matters. Today, if the bot sits quietly through five minutes of
conversation and then gets called on, it has to scramble to catch up on everything that
was said — slow and clumsy. With working memory it's like a panelist who's been taking
notes and forming an opinion the whole time: when the moderator turns to them, they can
speak right away.

So the payoff is a bot that's **faster, cheaper to run, and stays "warm"** — present and
ready — through long stretches of conversation, instead of going cold whenever it's not
the center of attention.

**Where we are:** this is being built and tested on a separate version of the app (the
one you have is untouched). At the moment we're testing whether the small fast brain is
good enough to keep those notes sharp on its own, or whether we need to lean on the big
brain more.
