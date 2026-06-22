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
- **The fast model's real job is classification, not voice** — and we narrowed
  *which* classification. **Addressivity triage** ("is the bot being addressed?")
  works great on the 7B (19/19 offline once we fixed a wrong-model bug) — but the
  **instant ack it would fire proved redundant**: it landed ~0.8s before the
  two-phase reply, both bounded by the same ~3s floor, so we **disabled it**. If
  turn-taking costs ~3s either way, the slow model may as well own it. **The
  surviving fast-model role is utterance-completeness** ("has the human finished
  talking yet?") — the one job that runs *inside* the silence window and so is
  **not** defeated by the latency floor, *if* the model is sub-second.
- **Apple on-device (#243) is the sub-second candidate.** Tested 2026-06-21:
  ~0.34s warm (~2–5× faster than the 7B). Addressivity quality is weaker (79% vs
  the 7B's 100%) — but completeness is a more local/syntactic task and looks more
  tractable (50%→74% on one prompt edit; iteration ongoing).
- **Active listening is built (v1), gated-off, on `feat/background-tick`.** The
  thesis — *fast model owns the clock, slow model owns the words* — is now working
  code: `wait_for_speech` can surface the slow model early (`background_tick`,
  content-triggered + jittered) so it can think and `bank_probe` short
  interjections; on a brief opening the Apple **completeness judge** fires one as a
  cheap turn-taking **bet** (right → buys ~3s of slow-model time; wrong → mild). The
  firing gate is currently too shy (the *safe* failure); tuning the (now editable)
  completeness prompt against real caption data is the next lever. See the build
  section below.
- **Streaming headless Claude Code** (`claude -p --output-format stream-json …`,
  subscription auth) is **viable and free** — but the spike showed it doesn't beat
  the ~2.5s TTFT floor for short replies, and multi-step turns (its real edge) are
  rare in a call. **DECISION (2026-06-20): parked** as a background Mode-B option;
  it would also cost the "transport your live session" dream. We continue with the
  two-phase bot and chase snappiness via the **fast ack** instead.

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

## A big product implication of streaming (decision input)

Streaming requires the app to **spawn and control** the brain process (to read its
token stream), so the brain becomes a **dedicated headless Claude Code process
with its own fresh context.** That means we **lose the "transport your live
session into the call" dream** — today (Mode A) you can run `/join-call` inside
your *own* working session and *that* session, with all its context, becomes the
bot. You can't have both: an interactive session and a headless streamer can't
co-drive one session (same collision as two bots on one app). So streaming is a
step **from Mode A (connect your Claude session) toward Mode B (dedicated polished
avatar)** — a product-direction choice, not just a perf win.

Possible hybrid: `/join-call` could *hand off* — capture your context (summary,
CLAUDE.md, project) and **seed** a fresh headless streamer with it. You transport
your *context*, not the live session.

## Streaming spike result (2026-06-20)

Ran `scripts/stream-claude-spike.mjs` (headless `claude -p` streaming). Findings:
- **Works:** text deltas stream; chunking into spoken sentences works.
- **On subscription:** `ANTHROPIC_API_KEY` not set → flat cost. The `cost_usd` in the
  result (~$0.03–0.09/reply) is **informational equivalent**, not billed. ✓ The
  dealbreaker is cleared.
- **But the latency floor is ~2–2.7s time-to-first-token**, and streaming does NOT
  remove it. First *sentence* landed at ~2.4–3.2s; full reply ~4s. For a short
  reply that's **basically the same as the two-phase slow bot** — both are
  TTFT-bound. Streaming's real win is **long/multi-step replies** (speak sentence 1
  while the rest generates) + architectural cleanliness, not short-turn latency.
- **Key reframe:** nothing beats the ~2.5s TTFT floor for the *first words* except
  a **fast-tier instant ack** (<1s "On it"). So the genuinely snappy architecture
  is **fast ack (covers TTFT) → slow model streams the real answer** — which means
  the **triage/ack tier earns its place after all**, and the near-term snappiness
  win (smart instant acks) is buildable on the CURRENT bot without the rebuild.
- Each run cold-starts a fresh session (overhead included); a persistent `--resume`
  brain would have lower recurring TTFT (unmeasured).

**Net:** streaming is viable and free, but it's a Mode-B architectural foundation
+ long-reply win, NOT a dramatic short-reply latency win. The latency lever is the
fast ack, not streaming.

## Triage, resolved: good classifier, redundant ack (2026-06-20→21)

After the streaming spike pointed back at the fast ack as "the latency lever," we
chased triage to a conclusion — and it turned into a useful *negative* result.

- **The "triage under-acks" failure was a wrong-model bug, not a capability
  ceiling.** Live, the bot was running a stale `qwen3-1.7b-mlx`, not the validated
  7B. Proven by replaying the exact logged inputs (`[triage-input]`): the **7B
  scored 19/19** on the offline harness (`scripts/triage-eval.mjs`), the 1.7B
  failed them. Root-caused via three layered bugs: garbled multi-speaker input
  (fixed: pass the last *attributed* turn), cold-start timeouts (fixed:
  `warmupLocalModel` on join), then the model-name mismatch (the real one).
- **So we wired the instant ack** (triage YES → quick "On it" filler) — and then
  **disabled it**, because in practice it was **redundant**. The ack landed only
  ~0.8s before the two-phase slow reply (both ~3s, TTFT-bound), so it added a
  stray utterance for almost no perceived-latency gain.
- **Stan's reframe (the keeper insight):** *if* turn-taking costs ~the same three
  seconds whether the fast model gates it or not, then **let the slow model make
  the turn-taking decisions** — don't add a second brain to save a margin that
  isn't there. This is why triage-for-ack is parked.

**What survives:** classification where the fast tier's *speed* actually buys
something the slow tier can't — i.e. a judgment that must happen *before* the slow
model is even invoked. That's **utterance-completeness**.

## The Apple on-device experiment (#243, 2026-06-21)

Stan stood up `apple-to-openai` (an OpenAI-compatible wrapper over Apple
Intelligence) at `http://127.0.0.1:11535/v1`, model `apple-on-device`. We probed it:

- **Speed — the headline.** ~0.34s warm on trivial calls; ~0.6–0.95s on full
  classification calls. **~2–5× faster than the 7B** (~1.9s warm). This is the
  number the whole fast-tier idea needed, and it's the first backend that delivers
  genuinely sub-second.
- **Addressivity triage: 79% (15/19)** vs the 7B's 100%. It nails clean direct
  address but misses the *about-vs-to* nuance ("I was talking to Jimmy earlier" →
  false ack) and garbled overlapping captions. Confirms Stan's prior: a small
  model isn't a great addressivity classifier. (Possibly recoverable with prompt
  tuning — untested.)
- **Mechanics:** `json_schema` is **accepted (200) but ignored** — it freelances
  keys and wraps JSON in ```` ```json ```` fences. So structure is prompt-only; our
  `extractJson` strips the fences. The 400-fallback we added doesn't trigger here
  (harmless).

### Completeness detection — the role the latency floor can't kill

The insight (Stan's): the fast tier's speed only matters where a decision must be
made *inside the silence window*, before the slow model runs. **"Has the speaker
finished?"** is exactly that — and at ~0.34s, Apple is fast enough to gate it.

We built the offline loop, same playbook as triage:
- **`logRawCaptions` pref (beta16)** logs `[caption-raw]` — every in-flight partial
  as Meet captions grow, marked LIVE vs settled. That messy progression *is* a
  labeled dataset (settled = complete; superseded LIVE prefixes = partial).
- **`electron-app/completeness.js`** — the `judgeComplete()` classifier +
  `parseCaptionLog()`.
- **`scripts/completeness-eval.mjs`** — offline harness; built-in synthetic cases
  (runnable today) + `--log` to replay real captured captions. Reports accuracy
  **and p50/p95 latency** (latency is the make-or-break metric here).
- **First Apple run:** a naive "lean toward not-complete / function-word" prompt
  got stuck answering *partial* for everything (50%). **One de-bias edit** (judge
  grammar not punctuation; only a dangling-end is partial) → **74%, p50 ~722ms.**
  Demonstrates the seconds-per-iteration loop. **Next input: real captured
  `[caption-raw]` data** from a logging call, then keep tuning.

## The thesis this clarified: fast model owns the clock, slow model owns the words (2026-06-21)

Seth asked for the bots to "practice active listening." They can't today — no
quick reaction, no bank of things to say. But the ask reframed the whole two-tier
division of labor into the cleanest statement we've had:

- **Slow model owns the WORDS.** During conversation the bot is *not* part of, the
  slow model crafts short, context-aware **active-listening interjections** and
  banks them ready-to-fire: *"good point about latency"*, *"what about OpenAI?"*,
  plus never-stale generics (*"interesting…"*). Substance is the slow model's job —
  exactly where the fast/7B voice failed.
- **Fast model (Apple) owns the CLOCK.** It makes the purely-local timing calls:
  *is there an opening?* (the completeness judge, reused) and *did a different
  participant just grab the floor?* (back off). Timing is what a sub-second model
  is actually good at — and notably NOT the addressivity nuance it's weak at.

**Why this isn't the ack we just killed.** The disabled instant-ack fired *when the
bot was addressed* and duplicated the slow reply already coming. These fire *when
the bot is NOT addressed* — so there's no slow reply to be redundant with. Wholly
different moment, real value.

**The load-bearing insight — interjection-as-probe.** A short interjection at a
*suspected* break is a cheap turn-taking bet with asymmetric payoff: if the speaker
wasn't done, they keep going (mildly interrupted, low cost); if they *were* done,
the bot has bought ~3s for the slow model to think. This attacks the ~3s floor in a
way the ack couldn't — it converts latency into a gamble we can afford to lose.
Because the break-detection can be *softer* than the 2s "definitely done" gate, the
bot gets snappier without committing to a full answer.

**Probes are exempt from the barge-in gate (Stan).** Normal speech goes through
`bargeInGraceMs` because the bot might start a monologue over someone. A probe is
short *by construction* and fired only on a likely opening — no monologue risk — so
it bypasses the grace machinery; no yield path needed for a sub-second utterance.

**Open tensions (be honest):**
- *Staleness vs. the blocked slow model.* The slow model can't background (it's
  blocked in `wait_for_speech`), so the bank rots. Likely refill: each time the
  slow model *does* surface, it emits 2–3 bankable interjections as a side output;
  Apple select-and-fires from that small set + generics. The bank will sometimes be
  empty/stale — accept it.
- *Frequency budget.* Over-done "active listening" is worse than silence (needy
  bot). Hard rate limit + high firing bar; the low-rudeness claim only holds if the
  probes are short *and* rare.

**Cleanly-shippable first piece:** back-off detection — "a *different* participant
started → yield the floor" — is independently valuable, needed by the probe anyway,
and depends on neither the bank nor the slow model. Extends the existing
`bargeInGraceMs` to distinguish "same speaker resumed" from "new speaker grabbing
the floor." Tracked in #245 (active listening).

## Building active listening: branch `feat/background-tick` (2026-06-21)

Took the thesis from issue to working v1 on its own branch (kept off `feat/two-tier`
so Stan's beta16 data-collection call stayed on a known-good build). Everything is
gated behind default-off prefs — zero behavior change until switched on.

### Step 0 — the enabling mechanism: `wait_for_speech` returns a tagged result
The blocker that made banking impossible: the slow Claude session is stuck in
`wait_for_speech` (long-poll) and only wakes at a definitive break, so it can't
think during a stretch it isn't part of. (The ~500-char `workingMemory` refresh is
the *local* model via `comprehend()`, NOT the slow session — a point we'd been
conflating.) Fix: `wait_for_speech` can now resolve *early* with a tagged
`background_tick` result. On a tick the skill is told `[BACKGROUND TICK — do NOT
speak]` → it updates understanding / banks a probe and loops without speaking; only
a real silence still lets it talk. This is what lets the (otherwise blocked) slow
model think mid-conversation — the prerequisite for everything else.

### The trigger is content-based, not time-based
The tick fires on **new transcript words** accumulated (`backgroundTickWords`),
mirroring the proven `comprehendCharThreshold` — because the need to re-think scales
with *how much was said*, not wall-clock. A slow talker generates little to
reconsider; a dense exchange generates a lot, and content-based self-adjusts. Time
appears only as a 2.5s polling granularity, never the trigger.

### Anti-lockstep jitter
Same lineage as #230's speak-jitter: each waiter rolls its effective threshold to
`base × (1 + random·backgroundTickJitterFrac)` (default +0–30%), so two bots tick —
and later fire probes — on drifting cadences instead of in unison.

### The probe-as-bet, v1 (dropped the stale-(b) complication)
The full design banked both (a) a short probe and (b) the longer real thing; v1
banks **only short probes** and falls through to the normal fresh answer if the
probe lands. So: slow model banks via `bank_probe` (TTL `probeMaxAgeMs`, generic
fallback when empty); on a *brief* quiet (`probeSilenceMs`, shorter than the full
turn gate) the local-server runs the **Apple completeness judge** on the last
utterance; only a finished thought is a real opening → fire the freshest probe.
Guards encode the lessons: rate-limited (`probeMinIntervalMs`), **name-mention skip**
so we never probe-before-answer when addressed (the disabled-ack lesson), and probes
are short enough to clear `bargeInGraceMs` so they're fire-and-forget, never stashed
— and barge-in-exempt by construction (Stan: a sub-second utterance can't monologue
over anyone, so it needs no yield path).

### Division of labor, realized
Slow model **owns the words** (banks interjections with real substance); Apple
**owns the clock** (completeness-gates the firing). The completeness harness we built
for measurement became the live firing gate — the two halves of the branch meeting.

### Status / open
Plumbing works end-to-end and is inert by default. The **completeness gate is
currently too conservative** (holds on some genuinely-complete thoughts) — but that's
the *safe* failure (a missed probe is silence, never an interruption), and it's the
prompt-tuning target, not a bug. The prompt now lives in the editable, hot-reloaded
`electron-app/prompts/completeness-system.md` (same file the offline harness scores),
so Stan/Seth can tune the firing bar and re-run `completeness-eval.mjs` in seconds.
Next: tune against real captured `[caption-raw]` data; then **back-off detection**.

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
- `electron-app/completeness.js` — the **utterance-completeness** prompt (the live
  fast-tier candidate). Iterate with `scripts/completeness-eval.mjs`.
- `electron-app/triage.js` — the addressivity classifier (good on the 7B; ack
  parked). Iterate with `scripts/triage-eval.mjs --endpoint … --model …`.
- `electron-app/phrase.js` / `comprehend.js` — the 7B prompts for the now-parked
  fast-voice path.

## DECISION (2026-06-20): keep the two-phase bot; park streaming

We're sticking with the **slow model + two-phase response** as the bot, and
**parking the streaming rebuild as a background possibility**, for concrete
reasons:
- The spike showed streaming's latency win over two-phase is **marginal for short
  replies** (both ~2.5–3s, TTFT-bound) — its real edge is long/multi-step turns.
- **Multi-step tasks are rare in a *call*** (conversational, usually single-step)
  compared to a coding session — so streaming's main advantage mostly doesn't
  apply here. (Stan's call.)
- A rebuild would **sacrifice the "transport your live session" dream** (Mode A),
  for modest gain.

**The latency lever is the fast ack, not streaming.** So the near-term direction
is: keep iterating on snappiness on the *current* architecture — get **triage
working** (fix its prompt) so the bot can fire a smart **instant ack** ("On it",
<1s) when addressed, covering the slow model's ~2.5s TTFT, with the two-phase
answer landing behind it. No rebuild required.

Streaming stays documented and de-risked (`scripts/stream-claude-spike.mjs`,
viable on subscription) if the product ever heads toward Mode B (dedicated avatar).

> **Addendum (2026-06-21):** the "smart instant ack" plan above didn't survive
> contact. We got triage working (7B, 19/19) and wired the ack — then found it
> **redundant** against the two-phase reply (~0.8s ahead, same ~3s floor) and
> disabled it. The latency lever moved from *ack* to **utterance-completeness**
> (decide *when* it's time to respond, inside the silence window) on a sub-second
> Apple-on-device model. See the two sections above.

## Still-open (smaller) questions

- **Can completeness detection get good enough on Apple-on-device to gate the
  turn?** First pass 74% on synthetic data; needs (a) real captured `[caption-raw]`
  data and (b) more prompt tuning. Headline metric stays **latency** (must hold
  sub-second under load).
- **Apple addressivity via prompt tuning:** 79% out of the box — worth one tuning
  pass, given the speed, even if it only ever feeds a non-authoritative signal.
- The bot-vs-bot jitter / "back off when not specifically addressed" half — still
  waits on a reliable addressivity signal (now likely the 7B, not Apple).
