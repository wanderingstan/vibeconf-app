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

The system prompt is **not in code** — it lives at `prompts/ack-system.md` as plain markdown, and the runner hot-reloads it on file change (one `stat()` per ack call, re-read only when mtime changes). Edit the file, the next ack uses the new prompt. **No app restart required.**

```bash
# while the app is running, just edit:
$EDITOR electron-app/ack/prompts/ack-system.md
# save, talk to the bot, the next ack uses your new prompt
```

That's where the actual quality lives — iterate freely.

### Pointing at a custom prompt file

Three ways, in priority order:

1. **`ackPromptPath` store key** in the profile's `config.json` — full path to any text file.
2. **`VIBECONF_ACK_PROMPT_PATH` env var** at app launch.
3. **Default** — the bundled `electron-app/ack/prompts/ack-system.md`.

If your custom file is missing or unreadable, the runner silently falls back to the last successfully-loaded prompt, or to a tiny hardcoded fallback baked into `openai-compat.js`. The ack call never throws because of a prompt-file issue.

### Iteration tips

- The model sees the system prompt + a user message of the form `User said: "..."\n(addressivity hint)\nRecent context:\n  ...`. Test phrases against your local model with whatever chat UI LM Studio gives you to refine wording without round-tripping through Meet.
- Few-shot examples in the prompt matter more than rule descriptions for small models. Most failures are fixable by adding a concrete "user said X → answer Y" example covering the failure case.
- Keep the prompt under ~1200 tokens — every prefill cost is paid per ack call. LM Studio caches prefix sometimes but don't count on it.

## Fast-ack feedback to the slow model

The phrase the fast model just played is surfaced back to the slow model exactly once, via the *next* `wait_for_speech` response — appears as a single line `[Previous fast-ack played: "Mm-hmm."  If it didn't fit your real response, you may briefly clarify.]`.

This lets the slow model self-correct when the ack tone contradicts the real answer. Example: the user asks something where the right answer is "no", the fast model acked with "Uh-huh." anyway. On the next turn, the slow model sees the previous ack and can briefly clarify the mismatch ("Earlier I went 'uh-huh' but the actual answer is no…").

Post-hoc (one turn delayed), not synchronous — the slow model can't avoid contradicting its own ack on the same turn, only acknowledge the mismatch afterward. A synchronous-block design where `wait_for_speech` waits for the ack decision before returning is documented as a future iteration.

## Why this isn't in the MCP server

The ack happens server-side without involving the agent — that's the whole point of acking. The local Electron app makes the decision, plays it via TTS, and the agent's real response comes a moment later. Putting this in the MCP server would round-trip through the agent and lose the latency advantage.
