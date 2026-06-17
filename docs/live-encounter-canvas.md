# Live Encounter Canvas — design direction

> Status: **draft for the Wed Jun 17 session** (Seth + Stan). Author: Coltrane.
> Grounded in the Jun 14 call + a code audit of `vibeconferencing`, `spirit-agentv`,
> and `spirit/canvas-kit`. This is a direction doc, not a spec — the contract pieces
> are marked **[needs Stan]**.

## 1. The thesis

Today an "encounter" is split across **two planes that share zero state**:

- **The Meet grid** — where *presence & personality* live. The bot avatar is a
  transient emoji stream painted into a virtual camera
  (`extension/page-inject.js` `VirtualCamera`; state machine in
  `electron-app/local-server.js` `_setBotState` → idle / listening / thinking /
  speaking / yielding). Expressive, but **trapped in a fixed tile** and it **never
  touches the board**.
- **The canvas** — where the *durable artifact* lives. Versioned markdown snapshots
  (`whiteboard:{room}` + a 50-deep history list), optionally mirrored to Spirit
  displays via `electron-app/canvas-bridge.js` as `document.update` events.

The avatar doesn't know what's on the board; the board doesn't know the avatar
exists. **The goal of the "live encounter canvas" is to collapse these two planes
into one surface where agents are _present on the artifact_, not floating beside it.**

This is also the product reframe from the call: *rooms are the product, calls are
visits, bots are residents not laptop marionettes; the board is the room's memory.*

## 2. The keystone: a two-layer canvas

Everything persistent today is full-snapshot versioned markdown. Everything
transient (emoji state, "anyone speaking") is **local-only and lands nowhere
shared.** There is no shared ephemeral channel. That absence is the missing
primitive. Split the canvas cleanly:

| Layer | Exists today? | Carries | Latency | Persistence |
|---|---|---|---|---|
| **Document** | ✅ yes | versioned content, liner notes, artifacts | ~seconds | ledgered, replayable |
| **Presence** | ❌ **new** | cursors, avatar position, **gaze/pointing (deixis)**, attention, live reactions | ~100ms, lossy | never persisted |

The **presence layer is where the avatar joins the canvas.** In canvas-kit terms
it's a new event class — `presence.*` — that rides alongside `document.update` /
`artifact.*` but **never enters the ledger**. **[needs Stan]** canvas-kit is
deliberately durable-only today (SPEC v0.3 §"out of scope" excludes cursors/OT), so
this is a genuine contract addition.

### The two-tier mapping (why this is the same architecture as the call)

The layer split maps exactly onto the fast/slow model split Stan was describing:

- **Fast / local model → presence layer.** Gaze, pointing, quick reactions, acks —
  instant, cheap, lossy. (Already partly true: the ack/emoji machine is the
  fastest loop we have.)
- **Slow / cloud model → document layer.** Deliberate writes, liner notes,
  synthesis.

Presence-vs-document **is** fast-brain-vs-slow-brain, expressed spatially. Build the
two-layer canvas and the two-tier model falls out of it for free.

## 3. The avatar question — direction reverses

**Short answer to "what should we take over from tv.spiritprotocol's avatar work":
nothing on rendering — it's the other way around.**

`spirit-agentv` (the tv.spiritprotocol.io display) has **no visual avatar**. Agent
presence there is text-only: a phase label + presence-mode label
(`app/display/display-client.tsx:841`) and a colored "live" dot
(`app/audience/solienne/solienne-audience-canvas.tsx:100`). Vibeconf's emoji
`VirtualCamera` (animated face, volume-reactive mouth, idle/think/speak/yield
states, custom SVG background) is **the most developed avatar in the fleet.**

So the avatar *rendering* should be **contributed upstream** (vibeconf → canvas-kit →
spirit-agentv displays), not adopted. What we *should* adopt from canvas-kit is the
**state vocabulary and document model** that lets our avatar become a shared canvas
primitive.

### Adopt / Share / Skip (from `spirit-agentv` + `@spirit/canvas-kit`)

| Item | Source | Verdict | Why |
|---|---|---|---|
| **`CanvasPhase` enum** (idle, listening, forming_response, speaking, memory_arriving, synthesizing, ended, error) | `packages/canvas-kit/src/types.ts:1` | **ADOPT** | Richer than our 5 states; aligning lets avatar state ride the bridge. We add `memory_arriving`/`synthesizing` — perfect for the two-tier "slow brain is thinking" moment. |
| **`CanvasPresenceMode` enum** (present, resting, practicing, witnessing, refusing, remembering) | `types.ts:19` | **ADOPT** | A *stance* layer we lack; maps onto our behavior modes (active/passive/silent) and the "resident" framing. |
| **`agent.reply` event** (live utterance/caption) | `types.ts:229` | **ADOPT** | Lets the board show what the agent is saying — captions on the canvas, not just in Meet. |
| **`CanvasDocumentState` (v0.3)** versioned doc + trail | `SPEC_v0.3-draft.md:47` | **ADOPT** | Exact fit for the whiteboard ledger (#220); the basis for the structured-document workstream below. |
| **`PendingCanvasArtifact`** + stale-timeout | `types.ts:181` | **ADOPT** | In-flight affordance ("agent is making something") — shimmer while the slow brain works. |
| **pure helpers**: `presence.ts`, `weather.ts`, `summaries.ts`, `state.ts` reducer | `packages/canvas-kit/src/` | **SHARE** | Zero-dep, pure. `summarizeWeather`/`summarizeDecisions` feed a "board climate" / memory-accretion UX. Prefer importing `@spirit/canvas-kit` over copying. |
| **`ArtifactCard` component** | `display-client.tsx:253` | **SKIP (study)** | Tightly coupled to HENRI/SOLIENNE/delivery semantics. Take the layout idea, rebuild for our types. |
| **display-client wall/cinema/weather views** | `display-client.tsx` | **SKIP (study)** | 1356 lines of agent-specific UI. The three-view *pattern* is inspiration only. |
| **avatar / portrait / emoji rendering** | — | **N/A — we own it** | Contribute ours upstream. |
| **ephemeral / cursors / reactions** | — | **BUILD NEW** | Doesn't exist anywhere; this is the presence layer. |

**Net:** take canvas-kit as a dependency (`@spirit/canvas-kit`), align our avatar
state machine to `CanvasPhase`/`CanvasPresenceMode`, and push avatar rendering the
other way.

## 4. The five deep workstreams (ranked by leverage)

1. **Deixis — the agent points at what it's talking about.** *(highest genius-per-line)*
   When Coltrane says "the rise, the shutdown, the lesson," the avatar's gaze
   travels to those sections and highlights each as it speaks. Requires: stable
   anchor IDs per block (today the board is one opaque string —
   `WhiteboardState.content` in `src/types.ts`), a `presence.gaze {anchor}` event,
   and gaze rendering. `compose_liner_notes` already writes section-by-section
   (`mcp-server/server.js`) — the gaze can track each section as it lands. This one
   feature makes the avatar *of* the board instead of *next to* it.

2. **Structured document model — markdown blob → addressable blocks.**
   Make the board a tree of blocks with stable IDs (still markdown-authored).
   Unlocks deixis anchors, block-level multiplayer (no more two-bots-stomping —
   which we watched happen live on the call), and **editable/visible persona
   memory**: the agent's memory of you becomes a *region on the board you can
   edit*, not a hidden profile (Jimmy's transparency point). This is the "living
   document, not a snapshot" Seth keeps describing. Adopt `CanvasDocumentState`.

3. **Avatar as a spatial entity on the canvas.**
   Lift the emoji state machine out of the Meet tile so it *also* renders as a
   moving presence puck/portrait on the canvas surface (spirit-agentv display
   especially). Same states, now with position + gaze. This is where **Lemon
   Slice** fits: the face upgrades from emoji to a talking-head video portrait *on
   the board* — the demo-reel moment for the landing page. Two registers: cheap
   emoji for working calls, rich avatar for the shared display.

4. **The perception loop — the agent can _see_ the canvas.**
   Today the agent writes the board blind (`get_call_screenshot` sees Meet, not the
   board, human edits, or where humans point). Give it a structured read of the
   document tree + presence. Then: human highlights a region → agent perceives the
   deixis → agent speaks to it. The encounter becomes bidirectional, not broadcast.

5. **Memory accretion — the board becomes the room's brain across calls.**
   Today: 50-version cap, dup-keeps-first, scoped to one call. Vision: liner notes
   append to a *persistent room doc*; the board accumulates into team memory
   ("stops being a whiteboard, becomes the team's shared memory"; north-star =
   return rate to a room). Foundationally wants block-level CRDT (Yjs/Automerge)
   under the document layer so co-editing across people, agents, and time doesn't
   clobber.

## 5. First slice (the proof)

**Deixis on `compose_liner_notes`:** the avatar's gaze visibly tracks each
liner-notes section as it's written. Smallest thing that demonstrates the whole
thesis — avatar + canvas as one plane — and it rides on machinery that already
exists (section-by-section reveal, the emoji state machine, the canvas bridge). It
forces a minimal version of workstream #2 (block anchors), which is the right place
to start.

**Build order for the slice:**
1. Minimal block anchors: split board markdown into blocks with stable IDs on write.
2. `presence.gaze { anchor, agentId }` ephemeral event (local channel first; **[needs Stan]** to land in canvas-kit).
3. Gaze rendering: avatar highlights / points to the anchored block; emoji state already drives the face.
4. Wire `compose_liner_notes` to emit a gaze event per section as it reveals.

## 6. Solo-now vs needs-Stan

- **Solo (vibeconf side, no contract changes):** prototype the presence layer as a
  local ephemeral channel; minimal block anchors; gaze rendering in the virtual
  camera; the deixis slice; take `@spirit/canvas-kit` as a dep and align the avatar
  state machine to `CanvasPhase`.
- **[needs Stan] (canvas-kit contract):** the `presence.*` event class and
  ledger-vs-ephemeral separation; how spatial position/anchors are represented;
  whether avatar state (`CanvasPhase`/`PresenceMode`) becomes a first-class presence
  event so the displays can render it; the upstream home for shared avatar rendering.

## 7. Wednesday agenda

1. Ratify the **two-layer model** (document + presence) and the `presence.*`
   contract addition to canvas-kit.
2. Agree vibeconf takes **`@spirit/canvas-kit` as a dependency** and aligns avatar
   state to `CanvasPhase`/`CanvasPresenceMode`.
3. Confirm **avatar rendering flows upstream** (vibeconf → kit/displays).
4. Green-light the **deixis first slice** + the minimal block-anchor document model.
5. Sequence against Stan's two-tier model work (presence layer = fast model).

## Appendix — key code anchors

- Avatar render + state: `extension/page-inject.js` (`VirtualCamera`),
  `electron-app/local-server.js` (`_setBotState`), `electron-app/main.js` (IPC),
  `mcp-server/server.js` (`set_avatar_emoji`), `electron-app/preferences-schema.js`
  (`avatarBackgroundSvg`).
- Whiteboard: `src/types.ts` (`WhiteboardState`), `src/Room.tsx` (`wbHistoryReducer`),
  `src/components/Whiteboard.tsx`, `api/sync/[roomId].ts`,
  `api/room/[roomId]/whiteboard-history.ts`.
- Canvas bridge: `electron-app/canvas-bridge.js`, `canvasBridge*` prefs in
  `electron-app/preferences-schema.js`; tools `post_to_canvas` / `compose_liner_notes`
  in `mcp-server/server.js`.
- Contract: `spirit/canvas-kit/` (`src/types.ts`, `src/client.ts`,
  `SPEC_v0.3-draft.md`); display: `spirit-agentv/app/display/display-client.tsx`,
  `app/audience/solienne/solienne-audience-canvas.tsx`,
  `app/api/canvas/{events,state}/route.ts`.
