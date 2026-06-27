# Architecture — Triggers & Tiers

Status: **living reference** · Branch: `main` (merged) · Last updated 2026-06-26

This is the canonical map of *what fires when, with what context, on which model, to
decide what* in a live call. It complements [two-tier-design.md](./two-tier-design.md)
(the why) and [active-listening](../) work (#245). If you change a trigger, update this
table.

## The one-line mental model

- **Slow model (Claude) owns the WORDS** — the real Response, and the *content* of
  banked probes.
- **Fast model (Apple on-device) owns the CLOCK and the ROUTING** — am I addressed? is
  this an opening? who is the current speaker→addressee pair?
- **`workingMemory`** (`understanding` / `people` / `engagement`) is the shared
  blackboard: the fast tier writes it, both tiers read it.

The fast tier is Apple's on-device `FoundationModels` via an OpenAI-compat wrapper
(see #243 / #258). LM Studio is no longer part of the design; any OpenAI-compat
endpoint still works for power users via `ackEndpoint` / `ackModel`.

## Triggers

| Mechanism | Trigger | Context fed to model | Model | Decides / Sets | Gate (pref) |
|---|---|---|---|---|---|
| **Ack (triage)** | A turn *settles* (floor-open; bot → "thinking"). Not every caption. | `lastUtterance`, `recentTranscript` (12), `roster`, **`engagement`**, `mode` | Apple (fast) | "Are we being addressed *this* turn?" → if yes, fire an instant ack filler to cover slow-model latency. Non-authoritative. | `shadowPhrase` |
| **Comprehend** | Every X words (`comprehendCharThreshold`) | `transcript`, prior `workingMemory`, `roster` | Apple (fast) | Sets `understanding` / `stance` / `people` (legacy fossil; `stance` unused now) | `comprehendCharThreshold > 0` |
| **Engagement** | Same trigger as Comprehend (runs in parallel) | `transcript`, `roster` — deliberately **no** bot self-reference | Apple (fast) | Sets **`engagement`** — the current speaker→addressee pair; the bot is placed relative to it in plain code (`placeEngagement`) | rides comprehend trigger |
| **Background Tick** | Every X words (`backgroundTickWords`), polled @ 2.5 s; resolves a `wait_for_speech` waiter (reason `background_tick`) → wakes the slow session | recent transcript turns; the slow session has full context + tools | Claude (slow) | **Do NOT speak.** Silently update understanding (optionally `post_understanding`) and optionally **bank** a short probe (`bank_probe`) for later firing | `backgroundTickWords > 0` |
| **Probe firing** | Brief silence after speech stops (`probeSilenceMs`); fast "completeness gate" confirms a real opening | `lastUtterance`, `recentTranscript`, `roster` | Apple gate (fast) fires **slow-banked** content | "Is this a genuine opening?" → speak a pre-banked probe (or a generic). Suppressed when the bot is addressed by name (that wants a real answer). | `probeFiring` |
| **Response** | Silence resolution — a genuine break (`wait_for_speech` resolves `silence`; also `chat`, `timeout`) | resolved transcript turns; full context + **all MCP tools** | Claude (slow) | Generate + speak the real turn; run tool calls (whiteboard, etc.). **Two-phase by prompt** — (a) a quick spoken reply with no tools, then (c) optional deeper tool work + a brief follow-up `speak` (see the note below). | always (the core loop) |

## Notes / gotchas

- **Only Response is always-on.** Every other row is an opt-in experiment gated by a
  pref on this branch. "Current architecture" = the Response core loop, plus whichever
  experiments are switched on.
- **Two distinct "quick utterance" sources — don't conflate them.**
  1. **The Ack filler is NOT inside Response** — it's a separate *fast* trigger
     (builtin/triage) fired at the "thinking" transition to cover slow-model latency.
     A participant can hear it *before* the slow model has produced anything.
  2. **Response itself is two-phase, by prompt.** Within a single Response wake the
     slow model is instructed (`mcp-server/join-call-skill.md`, Step 3) to **(a)** speak
     ONE short sentence *immediately, before any tool call*, then **(b)** decide if more
     is needed, and **(c)** only if so, do the deeper tool work (whiteboard, lookups…)
     and `speak` a brief follow-up with the result. This is agent behavior driven by the
     skill prompt, not enforced by code — the `speak` tool is just "say this", and many
     turns end after phase (a). So on a turn the bot is addressed in, the audible
     sequence can be: **ack filler (fast)** → **phase (a) quick reply (slow, no tools)**
     → **phase (c) follow-up (slow, after tools)**.
- **The Tick never speaks.** It wakes Claude to *think and bank*, not to talk. The
  decision to actually utter an interjection is the separate **Probe firing** row — a
  fast opening-gate firing slow-pre-written content. That split (*slow owns the words,
  fast owns the clock*) is the heart of the #245 active-listening design.
- **`engagement` is its own model call**, not part of Comprehend. Folding it into
  Comprehend's bundled JSON made the small model anchor the bot in every exchange
  (0/3 when the floor shifts away); an isolated "who's the pair?" prompt is reliable
  (see `electron-app/engagement.js` and the #243 writeup).
- **Triage decides ack yes/no**, not the ack *phrase* — the filler text comes from the
  ack subsystem (`electron-app/ack/`, builtin phrases or `phrase.js`).
- **`wait_for_speech` resolution reasons** (the slow loop's wake causes):
  `silence` (real break → Response), `background_tick` (mid-stream think), `chat`
  (new chat message), `timeout` (no speech in the window — just call it again).

## Where each lives in code

| Mechanism | Producer trigger (local-server) | Handler (main.js) | Model module |
|---|---|---|---|
| Ack (triage) | `onShadowPhrase` (at the "thinking" transition) | `onShadowPhrase` | `electron-app/triage.js` |
| Comprehend | `onComprehensionDue` | `onComprehensionDue` | `electron-app/comprehend.js` |
| Engagement | `onComprehensionDue` (parallel) | `onComprehensionDue` | `electron-app/engagement.js` |
| Background Tick | `_scheduleBackgroundTick` → `_resolveWaiter(…, 'background_tick')` | the slow session's tick prompt (`mcp-server/server.js`) | Claude |
| Probe firing | `_maybeProbeOpening` → `onProbeOpening` → `fireProbe` | `onProbeOpening` | Apple gate + banked text |
| Response | `_resolveWaiter(…, 'silence')` | the slow session (`/join-call`) | Claude |
