# The Vibeconferencing API

Vibeconferencing is two things: a **calling API**, and a **desktop app** that
uses it to bring agents into calls.

The app runs on your machine and serves one HTTP API on `127.0.0.1`. Behind
it, the app drives each platform's own web client, so whatever you build
shows up in the call as a normal participant: a tile with a name and a face,
a microphone, a camera, chat, screen share. Your code never touches WebRTC,
captions or anyone's DOM. It joins, listens, speaks and shares through the
same few endpoints whether the call is on Google Meet, Zoom, Microsoft Teams,
a Slack huddle or a WhatsApp call link, and the same endpoints carry a
Telegram, WhatsApp or phone call that the bot has answered.

Think OpenRouter, for calls. One request shape, many providers behind it.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../media/api-layers-dark.svg">
  <img alt="Layer diagram. Top row, your code: Claude Code and Codex via MCP, curl, your app in any language, the API explorer. All feed one band, the local API at http://127.0.0.1:7865 with a bearer token and JSON: join, wait for speech, speak, chat, whiteboard, share, camera, mode, record. Below it the app drives each platform's own web client as a participant: meetings the bot joins (Google Meet, Zoom, Microsoft Teams, Slack huddles) and meetings the bot joins also include WhatsApp call links, with FaceTime planned; calls the bot answers (Telegram, WhatsApp, a phone number through Twilio; Discord planned). Bottom row, what the room sees: a tile with a name and a face, a microphone that speaks, a camera with an avatar or a board, chat messages, a screen share." src="../../media/api-layers-light.svg">
</picture>

| Where to go | What it is |
| --- | --- |
| **[The explorer](https://vibeconferencing.com/api)** | Browsable reference, and a "try it" that runs against your own bot. |
| [`openapi.yaml`](openapi.yaml) | The spec. Source of truth for every endpoint, field and status code. Import it into any client. |
| [Platforms](platforms.md) | What each platform supports: captions, chat, share, camera, language. |
| [MCP tools](mcp.md) | How the bundled MCP server's tools map onto these endpoints. |
| [Endpoint reference](reference.md) | The spec as a page of Markdown, for reading in the repo. |

## The two ideas

**One bot, one port.** A running app instance is a bot. It listens on one
port, `7865` for the default bot, and holds one call at a time. A second
bot on the same machine is a second instance on another port. The app's
**directory** on port `7864` lists them all:

```bash
curl -s http://127.0.0.1:7864/api/instances
```

```json
{ "ok": true, "instances": [
  { "port": 7865, "botName": "Jimmy", "profile": null, "callStatus": "in-call", "roomId": "abc-defg-hij" },
  { "port": 7871, "botName": "Bob",   "profile": "codex", "callStatus": "idle", "roomId": null } ] }
```

**One room, one long-poll.** A call is a room, named by the platform:
a Meet code like `abc-defg-hij`, or `zoom-<meeting>`, `teams-<id>`,
`slack-<team>-<channel>`, `whatsapp-link-<token>`, `telegram-<user id>`,
`whatsapp-<number>`, `phone-<number>`. Everything that happens in a room is read through one
endpoint, and everything the bot does in it is written through the same
path with POST.

## Authentication

Each bot mints a random token when it starts and writes it where only your
user can read it:

```bash
cat ~/.vibeconferencing/local-tokens/7865.token
```

Send it as `Authorization: Bearer <token>`. Three things need no token: the
directory on port `7864`, `GET /api/sync/no-room` (a bot's coarse status,
which is how clients find bots), and `GET /asset/{token}` (board images,
which carry their own capability in the path).

Every `POST` must be `Content-Type: application/json`. A wrong token is a
`401`; a wrong content type is a `415`. Both come back as
`{"success": false, "error": "..."}`.

The gate exists because `127.0.0.1` is not a boundary against your own
browser: any web page can `fetch()` localhost. The token file is what a page
cannot read. Set `VIBECONF_REQUIRE_TOKEN=0` in the app's environment to turn
the gate off for experiments.

## Your first call, in curl

Have the app running and a Google Meet open. Then:

```bash
PORT=7865
TOKEN=$(cat ~/.vibeconferencing/local-tokens/$PORT.token)
ROOM=abc-defg-hij     # the Meet code
API=http://127.0.0.1:$PORT/api/sync/$ROOM
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

**Join.** The bot opens the Meet, clicks through pre-join, and waits for you
to admit it.

```bash
curl -s "${H[@]}" -X POST $API -d '{"sender":"me","role":"bot","meta":{"action":"join","botName":"Jimmy"}}'
```

**Listen.** Block until someone finishes a sentence. The response carries the
transcript since your cursor, who is in the call, and the bot's state. Use
`asOf` as the next `since`.

```bash
curl -s "${H[@]}" "$API?wait=55"
```

```json
{ "success": true, "roomId": "abc-defg-hij", "asOf": "2026-10-27T17:05:41.512Z", "waited": true,
  "transcript": { "count": 1, "entries": [
    { "participantName": "Stan", "role": "member", "text": "Jimmy, can you put the three options on the board?", "timestamp": "2026-10-27T17:05:39.900Z" } ] },
  "participants": [ { "name": "Stan", "speaking": false, "isSelf": false }, { "name": "Jimmy", "speaking": false, "isSelf": true } ],
  "status": { "callStatus": "in-call", "botState": "listening", "mode": "active", "captionsOn": true } }
```

**Speak.** The line plays through the bot's microphone. The avatar wears the
emoji while it talks. Below `urgency` 0.5 the bot waits for a gap.

```bash
curl -s "${H[@]}" -X POST $API -d '{"sender":"me","role":"bot","transcript":[{"text":"Three options. On the board now.","emoji":"😄","urgency":0.4}]}'
```

**Show something.** Write the board, then share it. Markdown and Mermaid.

```bash
curl -s "${H[@]}" -X POST $API -d '{"sender":"me","role":"bot","whiteboard":{"content":"# Options\n\n1. Ship Friday\n2. Ship Monday with the fix\n3. Split the release"}}'
curl -s "${H[@]}" -X POST $API -d '{"sender":"me","role":"bot","meta":{"action":"share-whiteboard"}}'
```

**Leave.**

```bash
curl -s "${H[@]}" -X POST $API -d '{"sender":"me","role":"bot","meta":{"action":"leave"}}'
```

Swap the join action for `join-zoom`, `join-teams`, `join-slack` or
`join-whatsapp` with a `url`, and nothing else changes.

## The loop

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../media/api-loop-dark.svg">
  <img alt="Sequence diagram with three lanes: your code, the bot, the call. Your code POSTs a join action; the bot opens the link and clicks through pre-join, then appears as a participant. Inside a repeat box: your code GETs the room with wait=55 and since=asOf, which blocks until someone finishes a sentence; the bot reads the platform's own captions, chat and who is speaking; the response carries transcript entries, participants and status; your model thinks; your code POSTs a transcript line; the bot speaks through its microphone, waiting for a gap unless urgency is 0.5 or more; the response reports ok and sent. After the loop: a whiteboard write and a share-whiteboard action put the board out as a screen share; a leave action hangs up." src="../../media/api-loop-light.svg">
</picture>

`GET /api/sync/{room}?wait=55&since=<asOf>` is the whole listening side.
It returns when:

- a participant finishes speaking (a pause of `silence` seconds, default 1.4);
- a chat message arrives (`chatWake: true`);
- the shared screen changes (`screenWake: true`);
- `wait` seconds pass with nothing.

Only one waiter per bot. A new waiter from the same `bot` name displaces
the old one, which returns with `displaced: true`. A waiter from a
different bot name gets `409 wrongInstance`, because one agent drives one
bot. If the bot leaves on its own (nobody showed, it was left alone, the
call ended) the poll returns `autoLeft: true` with a reason.

The write side is `POST /api/sync/{room}`. One body can carry any mix of
`transcript` (speak), `whiteboard` (write the board), `whiteboardStyle`
(CSS), and one `meta.action`. Results come back keyed by what you asked
for. The actions:

| Action | Does |
| --- | --- |
| `join`, `join-zoom`, `join-teams`, `join-slack`, `join-whatsapp` | Join a meeting or a call link. |
| `leave`, `end-session` | Hang up; finish after-call work and release the app. |
| `share-whiteboard`, `stop-sharing`, `load-url`, `share-tab` | Present the board or any URL; share a Chrome tab (macOS). |
| `scroll-share`, `set-share-size`, `set-share-title-bar`, `set-share-audio` | Shape the share. |
| `share-click`, `share-type`, `find-share-element`, `eval-share`, `inspect-dom`, `read-share-console`, `read-share-network` | Drive the shared page like a browser automation tool. |
| `play-audio`, `play-sound` | Audio into the call through the mic. |
| `set-mode`, `set-camera`, `set-avatar-emoji`, `set-caption-language` | Behaviour. |

Field by field, every one is in the [spec](openapi.yaml) and the
[explorer](https://vibeconferencing.com/api).

## The rest of the surface

| | |
| --- | --- |
| `POST /api/call/start` | Create a fresh Google Meet and join it. |
| `POST /api/call/join` | Join a Meet by URL. The general form for every platform is the `join…` action above. |
| `POST /api/call/record` | Record the call to disk, one audio track per participant plus video. |
| `POST /api/chat` | Read or send in the platform's text chat. |
| `GET` / `POST /api/working-memory`, `POST /api/bank-probe` | The bot's private notes for this call, and a short interjection to say at the next opening. |
| `GET` / `POST /api/preferences` | Every setting, with types and defaults. Secrets never come back. |
| `POST /api/whiteboard-asset`, `GET /asset/{token}`, `GET /api/whiteboard-history`, `GET /api/fonts` | Images on the board, earlier versions, fonts for board CSS. |
| `POST /api/call-screenshot`, `POST /api/shared-screenshot`, `GET /api/session-log`, `GET /api/call-log` | What the bot sees, what it shows, and its logs. |
| `GET /api/name-suggestions`, `GET /api/visual-assets` | Names and faces to pick from. |
| `POST /api/realtime/hold`, `POST /api/realtime/brief` | When the bot runs a speech-to-speech model: hold it quiet, or hand it a fact silently. |

## Calls the bot answers

Telegram, WhatsApp and a phone number work the other way round: someone
calls the bot and it picks up, if the caller is on its allowlist. There is
no join action. The room appears in `GET /api/sync/no-room` as
`telegram-…`, `whatsapp-…` or `phone-…` while the call is live, and the
poll and speak endpoints work on it exactly as above. When the call ends
the room is gone; polling an old id returns `410 callEnded`. The
allowlists and the phone passcode are set in the app's settings, never
through the API.

## Two layers, one API

The bundled **MCP server** is a thin client of this API. Its `join_call`
tool is the join action; `wait_for_speech` is the long-poll; `speak` is a
`transcript` line. If you already drive the bot from Claude Code or Codex,
you are using this API. [mcp.md](mcp.md) has the full mapping, and it is
the quickest way to see how the pieces fit if you are coming from the
tools.

## Stability

The endpoints the MCP server depends on (calls, listening, speaking, chat,
whiteboard, behaviour, preferences) change deliberately and with notice in
release notes. Share automation and the realtime endpoints are
experimental. Routes the app uses for its own windows and hooks are not in
the spec and may change at any time. The spec's `info.version` tracks the
app version it describes.
