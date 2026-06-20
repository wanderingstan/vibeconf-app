# The Two-Tier Bot: Decisions, Experiments, and What We Learned

A running log of the experiment to make the bot respond **fast *and* well** in a
live call — written so we (and Seth) can recall the path, and so nobody has to
re-derive the dead ends. Reverse-chronological at the top, narrative below.

Branch: `feat/two-tier`. Companion docs: `two-tier-design.md` (the design),
`two-tier-for-seth.md` (the plain-language pitch), `multi-bot.md` (running two bots).

---

## TL;DR (where we landed)

- **The original bet failed, in a useful way.** A fast local 7B model *cannot* be
  the bot's substantive "voice" — it's fluent but generic, and it can't carry the
  context/IQ the slow Claude session has. Settled by direct side-by-side eval.
- **What actually works today:** the **slow model (Claude Code via `/join-call`)
  is the voice**, made to *feel* fast by a **two-phase response** — speak a short
  reply immediately, then do deeper work only if the turn needs it. Good substance
  at ~3–5s, and it never leaves the human in silence.
- **The fast model's real job is triage, not voice** — a sub-second "is the bot
  being addressed / is a quick ack expected?" classifier. Promising in principle;
  underperformed in first testing (too conservative). Non-authoritative: the slow
  model always still answers, so its mistakes are cheap.
- **The likely next big move:** drive the bot off **streaming headless Claude
  Code** (`claude -p --output-format stream-json --include-partial-messages`,
  subscription auth, our MCP server attached) — speak sentences as they stream.
  Confirmed viable on the flat subscription; would get low latency *with* full
  quality. A real rebuild, not yet started.

---

## The core problem

In a live voice call, the slow Claude session gives **great** responses but takes
seconds (it digests the transcript, reasons, often uses tools). Seconds of silence
after you speak feels broken. The whole arc is about closing that latency gap
without losing the quality.

## The architecture we started with (and the original bet)

- **Slow tier** = the user's subscription Claude Code session (`/join-call`),
  driving the bot via an MCP server (speak, whiteboard, etc.). Smart, full context,
  flat cost — but slow, and *blocked* in `wait_for_speech` so it can't think in the
  background.
- **Fast tier** = a local 7B (LM Studio, openai-compat) — free, sub-second.
- **The bet:** the slow model maintains a rich `stance` (what I'd say if asked) in
  the background; the fast model just *phrases* it instantly when the floor opens.
  Fast voice, slow brain.

## What we built to test it (the shadow harness)

Rather than risk the working bot, everything fast-model ran **log-only**: at each
floor-open it drafted what it *would* say, paired in the log against what the slow
session actually said (`[shadow-eval]`). Pure measurement, zero behavior change.
This pattern — **instrument first, act second** — recurred throughout and saved us
repeatedly.

## The experiments, in order, and what each taught us

1. **Background comprehension (size-triggered).** The local model maintains
   `workingMemory {understanding, stance, people}`, refreshed when enough new
   transcript piles up (not on a timer). *Learned:* the slow session genuinely
   can't background (it's blocked), so the **7B ends up maintaining its own
   stance** — the "smart subconscious" isn't actually in the loop. This turned out
   to be the root limitation.

2. **Prompt fixes for the fast voice.** First drafts were generic essays, too long,
   announced actions they couldn't perform, and referred to the bot in the third
   person ("let Jimmy handle it" — *it was Jimmy*). A prompt rewrite (respond to the
   last speaker, one sentence, no action-announcing, "you ARE the bot") fixed the
   *style*. *Learned:* most of the badness was prompt-induced — but fixing it
   **exposed the real wall: substance.** The fast model phrases fine; it just
   doesn't *know* what the slow session knows (e.g. asked "can you read the
   whiteboard?", it bluffs; the slow session actually reads it).

3. **The verdict.** Side by side on real discussion: the slow session names people,
   builds on the specific point, stays concise and correct; the fast model is
   fluent but thin. **A 7B can't be the voice** unless a smarter model feeds it
   substance — which needs the slow model to background, the hard unsolved part.

4. **The pivot — make the *slow* model fast (two-phase).** Instead of replacing the
   good voice, hide its latency: instruct the slow session to **speak one short
   line immediately, then do deeper work only if needed.** Entirely a skill-prompt
   change, no new infra. *Result:* it works — e.g. *"You got it, Stan — putting that
   diagram together now"* (~5s) → *"Done, it's on screen…"*. The human is never left
   in silence. This is the current product.

5. **The fast model's real role — triage.** Generation was the wrong job;
   classification is the right one: "is the bot being addressed, so a quick ack is
   expected?" Non-authoritative (the slow model still answers regardless, so a
   missed ack is just a late answer, a wrong ack is just a stray "On it"). *First
   test:* underperformed — it defaulted to "ambient/no-ack" even on direct
   addresses ("Jimmy, can you…"). Likely prompt mis-calibration (± a timing
   confound), not a capability ceiling — but unproven.

6. **Bot-vs-bot lockstep (#230).** Two bots with identical timing answer in unison.
   Added a small random pre-speak jitter (when 2+ others are present) to
   decorrelate starts. The smarter "back off when not specifically addressed" half
   waits on a working triage classifier.

## The streaming realization (likely the next chapter)

The two-phase idea ("quick reply, then real work") generalizes to *N* steps by
complexity — which **is** an agentic harness, and the slow tier already runs on
one (Claude Code). So instead of hand-rolling orchestration in a prompt, **stream
the harness's output and speak as it flows.** We confirmed (via docs) this is
viable on the **flat subscription** through the headless CLI:
`claude -p --output-format stream-json --include-partial-messages --mcp-config …`
(the Agent SDK is metered — avoid it). This could supersede both the dead
fast-voice and the two-phase skill hack: stream the *good* model, get low latency
*and* quality. Not yet built; challenges include sentence-chunking for TTS,
mid-stream barge-in, and the stream pausing on tool calls.

## Things that were keepers regardless of the two-tier outcome

The experiment drove a lot of plain-good infrastructure that stands on its own:
- **Speaker detection rewrite** — mutation-rate-based, fixing intermittent deafness
  where the old className-pin watched the wrong element (the bot would silently
  miss 30–60s of speech). Plus a cyan debug border to eyeball it.
- **Self-healing in-call watcher** — recovers app state after the spurious "You
  can't join this video call" page + manual rejoin.
- **`[heard]` transcript logging** — the log is now a true record of what the bot
  hears, which made every eval after it dramatically easier to read.
- **`inspect_dom` / `start_share` rename / stop-sharing & modal hardening / the
  two-bot test rig (Samantha).**

## Prompts worth iterating on (for Seth)

These are the editable prompt surfaces (kept as files, not buried in code):
- `mcp-server/join-call-skill.md` — the **slow model's** behavior, incl. the
  two-phase loop. *This is the highest-leverage one.*
- `electron-app/ack/prompts/ack-system.md` — the filler-ack prompt.
- `electron-app/triage.js` / `phrase.js` / `comprehend.js` — the 7B prompts
  (currently inline in JS; phrase/comprehend are the now-parked fast-voice path).

## Open questions / decisions pending

- Is ~3–5s (two-phase) good enough, or do we pursue streaming for sub-2s?
- Is the triage classifier salvageable with prompt tuning, or is the addressivity
  signal better derived mechanically?
- Does the streaming rebuild justify its cost, given the two-phase bot already
  works?
