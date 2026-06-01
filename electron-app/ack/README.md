# ack — bot acknowledgement decider

Pluggable module for deciding whether (and what) to acknowledge before the bot's full response. Lives in the local Electron app (not the MCP server) so it runs fast and stays out of the agent's loop.

## Providers

Two implementations, swappable via store key `ackProvider`:

| Provider | Behavior |
|---|---|
| `builtin` *(default)* | Today's hardcoded logic. WordCount + random pick from `ackShortPhrases` / `ackLongPhrases`. Skips when below `ackShortMin`. |
| `openai-compat` | HTTP POST to any OpenAI-Chat-Completions endpoint. The LLM decides both whether to ack and what phrase to use. Falls back to `builtin` on timeout / network error / parse error. |

## Configuring `openai-compat`

The store keys live outside `preferences-schema.js` so the agent can't read or change them (no MCP `set_preference` access). Edit `~/Library/Application Support/Vibeconferencing/config.json` (or `…/profiles/<name>/config.json` for a profiled instance) while the app is closed:

```json
{
  "ackProvider": "openai-compat",
  "ackEndpoint": "http://127.0.0.1:1234/v1",
  "ackModel": "llama-3.2-3b-instruct",
  "ackApiKey": "",
  "ackTimeoutMs": 500
}
```

| Key | Default | Notes |
|---|---|---|
| `ackProvider` | `"builtin"` | `"builtin"` or `"openai-compat"` |
| `ackEndpoint` | `"http://127.0.0.1:1234/v1"` | LM Studio default. Append `/chat/completions` is automatic. |
| `ackApiKey` | `""` | Empty for local runners. Set for OpenAI / OpenRouter / Anthropic-via-OpenRouter. |
| `ackModel` | `"gpt-4o-mini"` | Model name as your endpoint expects. |
| `ackTimeoutMs` | `500` | Hard timeout; falls back to builtin on miss. |

## Endpoint compatibility

Anything speaking OpenAI Chat Completions works:

- **LM Studio** — load any small instruct model, start the server (default `http://127.0.0.1:1234/v1`), set `ackEndpoint` accordingly. Empty API key.
- **Ollama** — use the OpenAI-compatible endpoint `http://127.0.0.1:11434/v1`. Empty API key.
- **OpenAI** — `https://api.openai.com/v1`. API key required.
- **OpenRouter** — `https://openrouter.ai/api/v1`. API key required. Gives access to Claude, Gemini, Llama, etc.
- **llama.cpp server / vLLM / Together / Groq** — all OpenAI-compatible.

Anthropic-direct (`api.anthropic.com`) is NOT byte-compatible — use OpenRouter to reach Claude for now.

## Latency targets

- p50 below ~400ms feels natural
- p99 below the configured `ackTimeoutMs` (500 default) — beyond that, fallback fires
- Cache trivially similar inputs if you find latency variable (not yet implemented)

## Testing without a real call

The dispatcher returns a string or null. You can poke it directly from a node REPL while the app's `electron-app/` dir is the CWD:

```js
const ack = require('./ack');
// pass a fake `store` shim — or use electron-store directly
const phrase = await ack.decide({
  text: "I think we should explore three options for the refactor",
  wordCount: 11,
  addressivity: 'me-1on1',
  mode: 'active',
  recentTranscript: [],
  store: { get: (k) => undefined },
  log: console.log,
});
console.log('chose:', phrase);
```

## Prompt design

`openai-compat.js` ships a single system prompt instructing the model to either return a 1–5 word phrase or the literal token `SKIP`. The model also receives the last 3 transcript entries as context. Iterate on the prompt by editing `SYSTEM_PROMPT` in `openai-compat.js` — that's where the actual quality lives.

## Why this isn't in the MCP server

The ack happens server-side without involving the agent — that's the whole point of acking. The local Electron app makes the decision, plays it via TTS, and the agent's real response comes a moment later. Putting this in the MCP server would round-trip through the agent and lose the latency advantage.
