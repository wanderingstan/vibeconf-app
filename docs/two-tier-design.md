# Two-Tier Model Architecture — Design

Status: **design / experiment** · Branch: `feat/two-tier` (off `feat/llm-ack`) · Drafted 2026-06-14

## Goal

Replace the single-slow-model + fast-ack design with a genuine two-tier split, so the
bot reacts in real time without paying slow-model latency on every turn, and can speak
*immediately* when called on even after sitting silent through minutes of human discussion.

## The core problem with today's architecture

Today the **slow session drives**: the `/join-call` Claude session long-polls
`wait_for_speech`, decides every response itself, and the fast-ack LLM only plays a
filler phrase ("Mm-hmm") to hide that latency. Two consequences:

1. Every substantive turn waits on Opus/Fable — seconds of latency, garnished with an ack.
2. While the bot is silent on the sidelines, the slow session is **blocked** in
   `wait_for_speech` doing nothing. When finally called on, it must digest minutes of
   transcript in real time — slow and brittle.

## The inversion

| | Slow tier | Fast tier |
|---|---|---|
| **Is** | the user's subscription `/join-call` session (Opus/Fable) | a capable **local** model via the openai-compat interface |
| **Owns** | "what are we actually building / what matters" | "what do I say right now, and when" |
| **Reacts to** | consult requests + ambient "refresh understanding" | speech + chat events |
| **Cadence** | seconds, occasional, background | sub-second, continuous |
| **Cost** | flat (subscription) | free (local compute) |
| **Outputs** | `understanding` + `stance` (workingMemory) + consult answers | `speak` / `update_whiteboard` |

Key reframe: the slow tier is **"the session that knows what we're working on,"** not
merely "the smarter model." Its value is *context the human is steering*, not raw IQ.
`consult_slow` means "ask the part of me that's been in the room with the human."

### Why local model for the fast tier (not Agent SDK / Channels)

- The **Claude Agent SDK** bills metered API credits — ruinous for a tier that fires on
  every utterance for an hour. The interactive slow session is covered by the flat
  subscription; the fast tier must not be metered.
- **Channels** (research preview) only push events into a session; they don't choose the
  model and don't change the billing story.
- A **local model** (LM Studio / Ollama via `ack/openai-compat.js`, which we already
  built) is free, and *we* own the invocation loop in Node — we call it whenever a speech
  event lands or a timer fires. No new dependency, no streaming-generator machinery, full
  control over context.

**Constraint discovered in testing (2026-06-14): the fast tier must be a NON-reasoning
model.** A reasoning/thinking model (tried Qwen3.5-9B) deliberates out loud and, on a
trivial phrasing task, spiralled into a minute-long repetition loop. `/no_think` was not
honored, and our `stripThink()` backstop only catches `<think>…</think>` tags — it does
*not* catch plain-text "Thinking Process:" reasoning, so we can't scrub it after the fact.
The fast tier's job is "no deliberation, just phrase," so a reasoning-first model fights
the goal architecturally. Pick a plain instruct model.

**Chosen fast-tier model: `qwen2.5-7b-instruct-mlx` (4-bit).** On M2 Pro / 32GB it
returns a one-sentence reply in ~1.15s cold (~630ms TTFT + ~0.5s generation at ~44 tok/s),
clean EOS stop, no thinking wrapper. TTFT improves with the `warmup()` KV-cache preload.
Comfortable memory headroom alongside Electron + Meet.

## Central data structure: `workingMemory`

(Named to avoid collision with the shared **whiteboard** feature. This is the bot's
private, internal mental state — not a shared artifact.)

Lives in `local-server`, maintained continuously by the **slow** model *while the bot is
silent*, read by the **fast** model to phrase a response instantly:

```
workingMemory = {
  understanding: "...",   // slow model's running read of the discussion (churns)
  stance:        "...",   // the point I'd make if the floor opened right now (churns)
  people:        "...",   // accumulating notes on who's in the call (persists)
  updatedAt, updatedBy
}
```

The slow model pre-chews substance in the background, so the call-on moment is cheap:
the fast model does **phrasing only** (read `stance` + last utterance → one spoken
sentence, <500ms) rather than catching up on minutes of transcript in real time.

**Why three fields, not one** — they have different *lifecycles*. `understanding` and
`stance` churn (rewritten on every refresh as the topic moves). `people` accumulates:
"Bob is the CEO," "Sarah is the AI expert," "John joined but hasn't spoken" are true
regardless of the current topic and must survive a topic-read refresh. Folding people
into `understanding` would drop the roster every time the slow model re-reads the
discussion. `people` is also distinct from the mechanical `this.participants` presence
list (who's here / speaking *now*) — it's *semantic* knowledge only the slow model can
derive, and it's queried differently (the fast model wants "who's the decision-maker"
independent of the topic).

All fields are concrete enough to **log, diff, and show in the troubleshooting panel** so
we can watch the slow model's read evolve live during a call. Partial updates are
supported — refresh just the topic read without disturbing accumulated people notes.

## `consult_slow` has two modes

- **Ambient** (the important one): timer- or accumulation-triggered, **non-blocking**,
  runs while the bot is quiet, refreshes `workingMemory`. This is what lets the bot stay
  warm through a long discussion it isn't part of yet.
- **On-demand**: the fast model hits a turn it can't phrase from `workingMemory`, blocks
  briefly for a targeted answer. This is the **only** place the old ack still earns its
  keep — filling the 2–10s of a real consult.

## Floor detection stays where it is

`local-server` already detects silence / floor-open (`_checkWaiters`,
`lastSpeechStoppedAt`, speaker-tracker grace). The fast model decides *whether* to take an
opening; local-server tells it *when* an opening exists. **Do not move floor detection
into the model.**

## What happens to the ack subsystem

It shrinks, doesn't die. Most turns need no ack — the fast model just answers. The ack
repurposes to one narrow job: fill the gap while an **on-demand** `consult_slow` is in
flight. `ack/openai-compat.js` is reused as the fast-model client.

## No toggle — the branch is the isolation

We deliberately do **not** add a `conversationEngine` pref. `main` (via `feat/llm-ack`)
stays the stable single-tier bot; this branch is the experiment. That avoids dual-path
`if (engine === ...)` clutter in the new code.

## Phasing

**Phase 0 — purely additive, current loop untouched.**
Prove the riskiest assumption (*can the slow model maintain a useful `workingMemory` in
the background, and can the fast model phrase a good contribution from it?*) with zero
risk to the working bot:
- Add `workingMemory` state + read/write endpoints in `local-server`.
- Slow session maintains it between its turns (new MCP tools: `post_understanding` /
  ambient `wait_for_context`).
- Upgrade the fast model; when there's an opening, let it speak a real short contribution
  drawn from `workingMemory` instead of "Mm-hmm."

**Phase 1 — invert the driver.**
Fast model becomes authoritative for speech; slow session moves fully to background
comprehension + consults. The `wait_for_speech`-drives-everything loop is retired on this
branch.

## New surface to build

- `workingMemory` state + HTTP/MCP read-write in `local-server`.
- Slow-session "background comprehension" skill mode + MCP tools
  (`wait_for_context`, `post_understanding`, `consult` answer path).
- Fast-driver module (Node, in `local-server`/`main`) that reads `workingMemory` and
  phrases via the local model through `ack/openai-compat.js`.
- Debug-overlay surfacing of `understanding` / `stance`.

## Open questions

- ~~**Local-model pick**~~ — RESOLVED 2026-06-14: `qwen2.5-7b-instruct-mlx` (4-bit). See
  the constraint + numbers under "Why local model for the fast tier" above. Qwen3.5-9B was
  rejected (reasoning loop). Larger non-reasoning models (14B) remain a future upgrade path
  if 7B phrasing proves too thin.
- ~~How aggressively to refresh `workingMemory`~~ — RESOLVED 2026-06-14: **size-based,
  not time-based.** `local-server` counts new caption chars and fires a background refresh
  when accumulation crosses `comprehendCharThreshold` (pref, default 500c). A quiet call
  burns no refreshes; a busy one refreshes proportionally to how much was said.

  **Who maintains it in the background:** the single slow session is blocked in
  `wait_for_speech` and can't do true background work, so the **local model** does the
  accumulation-triggered refresh in-process (`electron-app/comprehend.js`, via the same
  openai-compat endpoint as the fast-ack). This also tests the local model's *comprehension*
  (not just phrasing). The slow session still writes `workingMemory` on its own turns (per
  the skill) — so there are two writers; `updatedBy` (`auto` = background local model,
  bot-name = slow session) distinguishes them in the panel, which lets us compare quality
  directly. If the local model's background comprehension proves too thin, the escalation
  is a dedicated second session (Phase 1).

  Fallback before this landed: tag `checkpoint/phase0-silence-trigger` (slow session only,
  refreshing at silence boundaries).

  Still to tune: the default threshold (500c) against local-model cost vs. staleness on
  real calls.

  **Two writers → one (RESOLVED 2026-06-14).** Briefly both the background path
  (`updatedBy: auto`) and the slow session (`updatedBy: <bot-name>`) wrote workingMemory,
  and they thrashed: a log showed the slow session firing `post_understanding` every
  ~8-10s during a monologue (far more than once-per-turn; the model ignored the
  once-per-turn instruction). Fix: **background `auto` is the sole writer.**
  `post_understanding` was removed from the join-call skill's allowed-tools entirely (so
  the session physically cannot write — more robust than instructing it not to), and the
  skill now tells the session to *read* `get_working_memory` to orient. The slow session
  keeps its own full context and its separate speak path, so this doesn't affect its
  ability to respond.
- Whether the background comprehension and the fast-ack phrasing should share one LM Studio
  instance (they currently would — single loaded model serializes the two call types) or
  run on separate endpoints.
