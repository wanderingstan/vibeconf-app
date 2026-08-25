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

## What to try

1. *"What's the capital of France?"* — Pepper answers alone, ~300ms.
2. *"Write a Python function to merge two sorted lists, and explain the edge cases."*
   — it speaks a filler, calls `ask_deep_model`, and reads Claude's answer back.

The Events panel shows `HANDOFF →` / `HANDOFF ←` with the round-trip in ms.

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
