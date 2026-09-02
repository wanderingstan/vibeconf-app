# Realtime Pepper

A working OpenAI Realtime (speech-to-speech, WebRTC) page whose point is the
**seam**: the fast voice model handles the conversation, and hands anything that
needs real thinking to Claude.

Standalone — it does not import from `electron-app/`. It's a reference for the
mechanics before they move into the app.

## Run it

```sh
cp .env.example .env      # add OPENAI_API_KEY
node server.mjs           # http://localhost:3005
```

No dependencies, no build. `ANTHROPIC_API_KEY` is optional: without it the
handoff still fires and is fully visible, it just returns a stub instead of a
real Claude answer.

Deploys to Vercel as-is (`vercel.json` serves `public/` + the two functions).

## Two seams, switchable

**Router (tool).** The fast model decides whether to escalate, via `ask_deep_model`.
The weakest model makes the highest-leverage call, and Claude's clock only starts
after it has finished deciding.

**Back channel (default).** The fast model never decides. Every finished turn is
dispatched to Claude in parallel while the fast model acknowledges and restates
the ask. Claude self-gates by returning `nothing_to_add`. Both clocks start at
the same instant.

## What to try

1. Small talk. Claude returns `nothing_to_add` and nothing is spoken. This is the
   case a router gets wrong silently.
2. *"Write a Python function that merges two sorted lists."* The artifact lands on
   the board; the voice line only points at it.
3. Ask something, then immediately ask something else. Watch `superseded` in the
   events: the first call is aborted mid-flight.

Amber events are **silent injections**: the fast model learns something without
being given the floor.

## The back channel

Claude streams newline-delimited JSON instead of returning one answer:

| Event | Fast model does |
|---|---|
| `working` / `progress` | Silent inject. Briefed, not voiced. |
| `nothing_to_add` | Nothing at all. |
| `interject` | Cancels the current utterance and takes the floor. |
| `final` | Queued, spoken at the next gap. |

The whole trick is that `conversation.item.create` and `response.create` are
separate calls. Create an item without creating a response and the model has
silently learned something. That is the back channel; no new transport needed.

Claude writes its own `voice_line` and a separate `artifact`. The fast model
reads the former close to verbatim rather than summarising, which is what keeps
precision from being mangled on the way out.

## Floor control

The hard part is not model quality, it is who gets to talk. All of these are
implemented in `public/index.html` and verified:

- **Never self-interrupt.** An answer arriving mid-utterance is queued, then
  flushed on `response.done`.
- **Human wins.** While the user is speaking, nothing is delivered; a barge-in
  sends `response.cancel`.
- **Staleness.** An answer two or more turns late is reframed ("going back to
  what you asked a moment ago").
- **Supersession.** A new question aborts the in-flight deep call.

## How it works

```
browser                     your server                  OpenAI
  |-- GET /api/session ------->|
  |                            |-- POST /v1/realtime/client_secrets -->|
  |<-- ephemeral secret -------|   (real API key never leaves here)
  |
  |-- getUserMedia + RTCPeerConnection
  |-- POST offer SDP (Bearer: ephemeral) ------------------------------>|
  |<-- answer SDP -----------------------------------------------------|
  |
  |== audio both ways over the peer connection ========================|
  |== JSON events over the "oai-events" data channel ==================|
```

Audio never touches your server — it's a direct peer connection. Your server
does two things: mint a ~60s ephemeral token, and answer `ask_deep_model`.

### The handoff

Declared as a normal tool in `api/session.js`. When the model calls it:

1. `response.function_call_arguments.done` arrives on the data channel
2. the page POSTs to `/api/deep`, which asks Claude
3. the answer goes back as a `function_call_output` item
4. `response.create` makes Pepper speak it

The filler line ("let me look at that") is instructed in the prompt, and it's
what makes the multi-second gap feel like a person thinking rather than a hang.

## Notes for porting into the app

- **Keep the realtime system prompt short.** Under ~300 words. It drops clauses
  from long instructions in a way text models don't. Push complexity into tool
  definitions instead.
- **Never ship the real key to the client.** Ephemeral secrets are short-lived
  by design; mint one per call.
- **Two API shapes.** OpenAI renamed both the token endpoint and the SDP
  endpoint. `api/session.js` and `postSdp()` each try new-then-old, so this
  survives the rename. Check current model names against provider docs — the
  defaults here (`gpt-realtime`, `cedar`) may have moved on.
- **Echo cancellation matters.** Without `echoCancellation: true` the model
  hears itself and interrupts itself. In the Electron app the bot's own output
  needs to be excluded from its input upstream, not just muted on the track.
- **Barge-in is free** and server-side VAD handles turn-taking. Don't rebuild it.
- **The opening must be epistemically empty.** If the fast model opens with "that's
  easy, you just..." and Claude then disagrees, the incoherence is visible and reads
  as the bot being confused. Acknowledge and restate the ask; never commit to a
  conclusion or a difficulty.
- **Gate the fan-out on "was I addressed", not on "is this hard."** Addressed-or-not
  is high-recall and cheap, and being permissive costs a wasted call rather than a
  silent miss. Debounce on end of turn so one utterance is not three dispatches.
- **Silent injects use `role: "user"` with a `[backchannel]` marker** rather than a
  system item, for the widest compatibility. They cannot trigger speech on their own
  because no `response.create` follows.
