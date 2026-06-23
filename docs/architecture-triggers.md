# Architecture — Triggers & Tiers

Status: **living reference** · Branch: `feat/background-tick` · Last updated 2026-06-23

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
| **Response** | Silence resolution — a genuine break (`wait_for_speech` resolves `silence`; also `chat`, `timeout`) | resolved transcript turns; full context + **all MCP tools** | Claude (slow) | Generate + speak the real turn; run tool calls (whiteboard, etc.). **Single-phase** — think → speak. | always (the core loop) |

## Notes / gotchas

- **Only Response is always-on.** Every other row is an opt-in experiment gated by a
  pref on this branch. "Current architecture" = the Response core loop, plus whichever
  experiments are switched on.
- **The latency cover is NOT inside Response.** There is no "short response then a
  second full call." The bit a participant hears *immediately* is either the **Ack
  filler** (triage) or a **Probe** — both separate fast triggers. Response itself just
  thinks then speaks.
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
