# Vibeconferencing Local API: endpoint reference

Generated from [`openapi.yaml`](openapi.yaml) (version 0.8.64) by `scripts/gen-api-reference.py`. Do not edit by hand; edit the spec.

Base URL `http://127.0.0.1:7865` unless the endpoint says otherwise. Every request needs `Authorization: Bearer <token>` unless marked open. See the [guide](README.md) for the model, and the [explorer](https://vibeconferencing.com/api) for try-it.

## Contents

- [Discovery](#discovery)
- [Calls](#calls)
- [Listening](#listening)
- [Speaking](#speaking)
- [Whiteboard](#whiteboard)
- [Chat](#chat)
- [Behaviour](#behaviour)
- [Recording](#recording)
- [Memory](#memory)
- [Preferences](#preferences)
- [Diagnostics](#diagnostics)
- [Realtime voice](#realtime-voice)
- [Directory](#directory)

## Discovery

Find running bots and read their state without a token.

### `GET /api/sync/no-room`

**Bot status, no token needed** (no token needed)

Coarse state of this bot: whether it is in a call, which room, its
name, port and profile, and any call links it has noticed in your
browser. This is the ping the MCP server and the directory use to
find bots, so it stays open.

Responses:

| Status | |
| --- | --- |
| `404` | Not this bot's route. Nothing else is served without a token. → [Error](#error) |
| `200` | The bot's status. → [StatusResponse](#statusresponse) |

## Calls

Join and leave calls on any supported platform.

### `POST /api/call/start`

**Create a new Google Meet and join it**

Asks vibeconferencing.com for a fresh Meet that anyone with the link
can join, sends the bot into it, and by default opens the link in
your browser. Google Meet only. The bot must be signed in to
vibeconferencing.com.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `openBrowser` | boolean | Open the new Meet in the user's browser. |
| `spawnAgent` | boolean | Also start an agent session for this call. |

Responses:

| Status | |
| --- | --- |
| `200` | The Meet was created and the bot is joining. |
| `502` | The website refused or failed. → [CodedError](#codederror) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `POST /api/call/join`

**Join a Google Meet by URL**

A convenience for Meet links. For every platform, including Meet,
the general form is `POST /api/sync/{roomId}` with a `join`,
`join-zoom`, `join-teams` or `join-slack` action.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `url` (required) | string |  |
| `spawnAgent` | boolean |  |

Responses:

| Status | |
| --- | --- |
| `200` | Joining, or already in that call. |
| `400` | Not a Meet URL (`code: bad-url`). → [CodedError](#codederror) |
| `502` | The join failed. → [CodedError](#codederror) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Listening

Hear the room. One long-poll does the work.

### `GET /api/sync/{roomId}`

**Read the transcript, or wait for someone to finish speaking**

Without `wait`, returns immediately with everything since `since`.
With `wait`, blocks until a participant finishes a sentence (a pause
of `silence` seconds), until a chat message or screen change wakes
it, or until `wait` seconds pass. Either way the response carries
the transcript entries since your cursor, the whiteboard, who is in
the call, who is speaking, and the bot's own state.

Use `asOf` from each response as the next `since`.

Only one waiter per bot. A second waiter from the same `bot` name
displaces the first, which returns with `displaced: true`. A waiter
from a different bot name gets `409 wrongInstance`, because one agent
drives one bot.

The bot may leave on its own: nobody showed up, it was left alone,
or the call ended. The poll then returns with `autoLeft: true` and
an `autoLeftReason`.

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `roomId` (required) | path | string | The call. A Meet code (`abc-defg-hij`), or `zoom-<meeting>`, `teams-<id>`, `slack-<team>-<channel>`; for a call the bot answered, `telegram-<user id>`, `whatsapp-<number>` or `phone-<number>` (read it from `roomId` in the status). Lowercase letters, digits and hyphens. If the bot has no room yet, the first request's id becomes its room, except an answered-call id, which returns 410. |
| `since` | query | string | Cursor. Return entries after this ISO timestamp. Omit for everything the bot has. |
| `wait` | query | integer | Seconds to block for speech. `0` or absent returns now. Clamped to the bot's `defaultMaxWaitForSpeechSec` preference. |
| `silence` | query | number | Seconds of quiet that count as "finished speaking". Minimum 1. Defaults to the `defaultSilenceSeconds` preference (1.4). |
| `bot` | query | string | The caller's bot name. Lets the bot tell its own agent from a stray one. |

Responses:

| Status | |
| --- | --- |
| `200` | Transcript and room state. When waiting, this arrives after speech, a wake, or the timeout. → [RoomResponse](#roomresponse) |
| `409` | Another bot name already has a waiter on this instance. → [WrongInstance](#wronginstance) |
| `410` | A Telegram, WhatsApp or phone room that is not the live call. Those are answered, never joined, so an old room id is gone. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Speaking

Say things aloud through the bot's microphone.

### `POST /api/sync/{roomId}`

**Speak, write the board, or run a call action**

The write side of the room. One request can carry any combination of:

- `transcript`: lines for the bot to **speak** through its microphone.
- `whiteboard`: new board content (markdown and Mermaid).
- `whiteboardStyle`: CSS for the board.
- `reloadWhiteboard`: re-render whatever is shared.
- `meta.action`: one call action (join, leave, share, mode, camera, and so on). See the `meta` schema for every action and its fields.

`sender` is required and names the agent; it also registers the
sender as present in the room. Results come back under `results`,
one key per thing you asked for.

Speech is gated by the call's etiquette. In `silent` mode the line is
refused with `reason: mode-silent`. If someone is talking and the
line's `urgency` is below 0.5, it is stashed and replayed at the next
gap (`reason: user-speaking-stashed`). Before the bot is admitted,
lines are queued (`queuedUntilInCall: true`).

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `roomId` (required) | path | string | The call. A Meet code (`abc-defg-hij`), or `zoom-<meeting>`, `teams-<id>`, `slack-<team>-<channel>`; for a call the bot answered, `telegram-<user id>`, `whatsapp-<number>` or `phone-<number>` (read it from `roomId` in the status). Lowercase letters, digits and hyphens. If the bot has no room yet, the first request's id becomes its room, except an answered-call id, which returns 410. |

Request body (`application/json`):

[SyncRequest](#syncrequest)

Example (Say a line):

```json
{
  "sender": "my-agent",
  "role": "bot",
  "transcript": [
    {
      "text": "Three options. I'll put them on the board.",
      "emoji": "😄",
      "urgency": 0.4
    }
  ]
}
```

Example (Write the board):

```json
{
  "sender": "my-agent",
  "role": "bot",
  "whiteboard": {
    "content": "# Options\n\n1. Ship Friday\n2. Ship Monday with the fix\n3. Split the release\n\n```mermaid\nflowchart LR\n  A[Decide] --> B[Ship]\n```"
  }
}
```

Example (Join a Zoom call):

```json
{
  "sender": "my-agent",
  "role": "bot",
  "meta": {
    "action": "join-zoom",
    "url": "https://zoom.us/j/1234567890?pwd=abc"
  }
}
```

Example (Hang up):

```json
{
  "sender": "my-agent",
  "role": "bot",
  "meta": {
    "action": "leave"
  }
}
```

Responses:

| Status | |
| --- | --- |
| `200` | One result per requested effect. → [SyncResponse](#syncresponse) |
| `400` | Missing `sender`, or an action with a bad field. → [Error](#error) |
| `409` | A board write for a room that is not the current one. |
| `410` | A Telegram, WhatsApp or phone room that is not the live call. Those are answered, never joined, so an old room id is gone. |
| `401` | Missing or wrong bearer token. → [Error](#error) |
| `415` | A POST without `Content-Type: application/json`. → [Error](#error) |

## Whiteboard

Show markdown, Mermaid, images or any URL to the room.

### `POST /api/whiteboard-asset`

**Make a local image available to the board**

Registers an absolute path on this machine and returns an opaque
`http://127.0.0.1:{port}/asset/{token}` URL you can embed in board
markdown. Images and PDFs only.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `path` (required) | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | Registered. |
| `400` | Not an absolute path, missing file, or unsupported type. → [Error](#error) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `GET /asset/{token}`

**Serve a registered asset** (no token needed)

The token in the path is the capability; no bearer token needed. Not cached.

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `token` (required) | path | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | The file bytes. |
| `404` | Unknown token. |

### `GET /api/whiteboard-history`

**Earlier versions of the board**

Proxied from vibeconferencing.com, where the board is synced. Always HTTP 200; look at `success`.

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `room` | query | string | Defaults to the current room. |
| `offset` | query | integer |  |
| `limit` | query | integer |  |

Responses:

| Status | |
| --- | --- |
| `200` | A page of versions, or a failure with `success: false`. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `GET /api/fonts`

**Font families installed on this machine**

For `whiteboardStyle` CSS.

Responses:

| Status | |
| --- | --- |
| `200` | Families. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Chat

Read and post in the platform's text chat.

### `POST /api/chat`

**Read or send a chat message**

`action: read` returns the platform's text chat and clears the
bot's unread count. `action: send` posts a message. On Meet the chat
pane is opened for about a second to do either; speaker detection
pauses and resumes on its own.

Request body (`application/json`):

*Read*

| Field | Type | |
| --- | --- | --- |
| `action` | `read` |  |

*Send*

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `send` |  |
| `text` (required) | string |  |

Example:

```json
{
  "action": "read"
}
```

Example:

```json
{
  "action": "send",
  "text": "Room link: https://vibeconferencing.com/room/abc-defg-hij"
}
```

Responses:

| Status | |
| --- | --- |
| `200` | The messages, or the send result. |
| `400` | Empty `text` on send. → [Error](#error) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Behaviour

Modes, camera, avatar, and the language the bot listens in.

### `GET /api/name-suggestions`

**Candidate bot names from the app's curated pool**

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `count` | query | integer |  |

Responses:

| Status | |
| --- | --- |
| `200` | Names. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `GET /api/visual-assets`

**Bundled avatar faces and background presets**

Responses:

| Status | |
| --- | --- |
| `200` | Absolute paths to the sample art. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Recording

Record the call to disk.

### `POST /api/call/record`

**Start or stop recording the call**

Records one audio file per track (the bot's own voice and each
remote participant where the platform sends them separately) plus a
video of the bot's view, muxed to one mp4 when stopped.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `on` | boolean |  |

Responses:

| Status | |
| --- | --- |
| `200` | Recording state changed. |
| `409` | Could not change state (for example, not in a call). |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Memory

The bot's private working memory for the current call.

### `GET /api/working-memory`

**Read the bot's working memory for this call**

Responses:

| Status | |
| --- | --- |
| `200` | The memory. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `POST /api/working-memory`

**Update the bot's working memory**

At least one field is required. The memory is shown on the bot's panel and returned with every poll.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `understanding` | string | The running read of what is being discussed. |
| `stance` | string | The bot's point of view. |
| `people` | string | Who is here and what they want. |
| `engagement` | string | How involved the bot should be right now. |
| `updatedBy` | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | The updated memory. |
| `400` | No fields given. → [Error](#error) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `POST /api/bank-probe`

**Stash a short interjection for the next natural opening**

Active listening. Give the bot a two-to-six word line ("Which
version?", "Is that the free tier?") and it says it at the next
pause without the agent round-trip.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `text` (required) | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | Stashed. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Preferences

Read and change the bot's settings.

### `GET /api/preferences`

**List every user-settable preference**

Current value, default, type and description for each. Secrets are never returned.

Responses:

| Status | |
| --- | --- |
| `200` | The preference list. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `POST /api/preferences`

**Change one preference, or several at once**

A batch is validated as a whole; one bad item rejects all of them. Some keys need an app restart, which the response says.

Request body (`application/json`):

*One*

| Field | Type | |
| --- | --- | --- |
| `key` (required) | string |  |
| `value` (required) | any | Must match the preference's type. |

*Batch*

| Field | Type | |
| --- | --- | --- |
| `updates` (required) | array of object |  |

Responses:

| Status | |
| --- | --- |
| `200` | Applied. |
| `400` | Unknown key, wrong type, or empty batch. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Diagnostics

Logs and screenshots for debugging a call.

### `POST /api/call-screenshot`

**Screenshot the call as the bot sees it**

Tiles, names, mic icons, captions, shared content. Returns a PNG path on this machine.

Responses:

| Status | |
| --- | --- |
| `200` | Saved. → [PathResult](#pathresult) |
| `500` | Not in a call, or capture failed. → [Error](#error) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `POST /api/shared-screenshot`

**Screenshot what the bot is sharing**

What participants are seeing right now. Returns a PNG path on this machine.

Responses:

| Status | |
| --- | --- |
| `200` | Saved. → [PathResult](#pathresult) |
| `500` | Nothing is being shared. → [Error](#error) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `GET /api/session-log`

**Recent lines of the bot's session log**

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `lines` | query | integer |  |
| `grep` | query | string | Case-insensitive regex to filter lines. |

Responses:

| Status | |
| --- | --- |
| `200` | Log lines. |
| `401` | Missing or wrong bearer token. → [Error](#error) |

### `GET /api/call-log`

**One call's slice of the session log**

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `callId` (required) | query | string | From `callId` in any room response. |

Responses:

| Status | |
| --- | --- |
| `200` | The slice. |
| `400` | Missing `callId`. → [Error](#error) |
| `401` | Missing or wrong bearer token. → [Error](#error) |

## Realtime voice

Extra controls when the bot runs on a speech-to-speech model. Experimental.

### `POST /api/realtime/hold`

**Keep the realtime voice quiet for a while**

Only when the bot is running a speech-to-speech session. Otherwise 409.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `seconds` (required) | number |  |
| `reason` | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | Holding. |
| `409` | No realtime session is live. → [Error](#error) |

### `POST /api/realtime/brief`

**Hand the realtime voice a fact, silently**

The note goes into the voice model's context without being spoken. Only during a realtime session.

Request body (`application/json`):

| Field | Type | |
| --- | --- | --- |
| `note` (required) | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | Briefed. |
| `400` | Missing `note`. → [Error](#error) |
| `409` | No realtime session is live. → [Error](#error) |

## Directory

The app's directory of running bots, on port 7864. No token.

### `GET /api/instances`

**Every running bot on this machine** (on `http://127.0.0.1:7864`, no token needed)

Live, so a bot that just started appears within a moment. Start here to find a bot's port.

Responses:

| Status | |
| --- | --- |
| `200` | The bots. |

### `GET /api/detected-calls`

**Call links the app has noticed in your browser** (on `http://127.0.0.1:7864`, no token needed)

Responses:

| Status | |
| --- | --- |
| `200` | Links. |

### `GET /api/health`

**Is the app running?** (on `http://127.0.0.1:7864`, no token needed)

Responses:

| Status | |
| --- | --- |
| `200` | Yes. |

### `POST /api/launch`

**Start a bot** (on `http://127.0.0.1:7864`, no token needed)

Starts the named profile as a new bot process, or reports the one already running.

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `profile` | query | string | Profile name. Omit for the default bot. |

Responses:

| Status | |
| --- | --- |
| `200` | Started, or already running. |

### `POST /api/select`

**Show a bot's panel in the app window** (on `http://127.0.0.1:7864`, no token needed)

Parameters:

| Name | In | Type | |
| --- | --- | --- | --- |
| `profile` | query | string |  |

Responses:

| Status | |
| --- | --- |
| `200` | Selected. |

## Schemas

### Error

| Field | Type | |
| --- | --- | --- |
| `success` (required) | `False` |  |
| `error` (required) | string |  |

### CodedError

| Field | Type | |
| --- | --- | --- |
| `success` | `False` |  |
| `code` | string | A short machine code such as `signed-out`, `rate-limited`, `bad-url`. |
| `detail` | string |  |

### PathResult

| Field | Type | |
| --- | --- | --- |
| `success` | boolean |  |
| `path` | string | Absolute path to a PNG on this machine. |

### CallStatus

Where the bot is in a call's life.

One of: `idle`, `navigating`, `joining`, `waiting-to-be-admitted`, `in-call`, `after-call-work`, `call-complete`

### Mode

`active` answers on every pause. `passive` stays quiet until named. `silent` listens and acts but never speaks.

One of: `active`, `passive`, `silent`

### StatusResponse

| Field | Type | |
| --- | --- | --- |
| `success` | boolean |  |
| `roomId` | string or null |  |
| `callId` | string or null |  |
| `callStartedAt` | string or null |  |
| `currentMeetUrl` | string or null |  |
| `detectedMeetUrls` | array of string |  |
| `detectedSlackHuddleUrl` | string or null |  |
| `status` | object |  |

### TranscriptEntry

| Field | Type | |
| --- | --- | --- |
| `id` | string |  |
| `roomId` | string |  |
| `participantName` | string |  |
| `role` | `member` or `bot` |  |
| `text` | string |  |
| `isFinal` | boolean |  |
| `timestamp` | string |  |
| `voice` | string | Bot lines only. |
| `urgency` | number | Bot lines only. |

### Participant

| Field | Type | |
| --- | --- | --- |
| `name` | string |  |
| `speaking` | boolean |  |
| `isSelf` | boolean |  |

### Whiteboard

| Field | Type | |
| --- | --- | --- |
| `content` | string | Markdown, with Mermaid fences. |
| `version` | integer |  |
| `lastModified` | string or null |  |
| `lastEditor` | string or null |  |
| `changed` | boolean |  |

### WorkingMemory

| Field | Type | |
| --- | --- | --- |
| `understanding` | string |  |
| `stance` | string |  |
| `people` | string |  |
| `engagement` | string |  |
| `updatedAt` | string |  |
| `updatedBy` | string |  |

### RoomStatus

The bot's own state. Returned with every room read.

| Field | Type | |
| --- | --- | --- |
| `callStatus` | [CallStatus](#callstatus) | Where the bot is in a call's life. |
| `botState` | string | The avatar's state: `idle`, `listening`, `thinking`, `speaking`, `yielding`, and so on. |
| `mode` | [Mode](#mode) | `active` answers on every pause. `passive` stays quiet until named. `silent` listens and acts but never speaks. |
| `anyoneSpeaking` | boolean |  |
| `audioFloorSpeaking` | boolean |  |
| `floorBusy` | boolean | Someone has the floor; a low-urgency line would wait. |
| `sharing` | boolean | The bot is screen-sharing. |
| `someoneElsePresenting` | boolean |  |
| `presenterName` | string or null |  |
| `captionsOn` | boolean | The bot can hear. Captions are how it listens. |
| `localServerUrl` | string |  |
| `localServerPort` | integer |  |
| `localProfile` | string or null |  |
| `agentWorkdir` | string or null |  |
| `errors` | array of object |  |
| `permissions` | object |  |
| `lastResponseMs` | number or null |  |
| `responsePerf` | object |  |
| `workingMemory` | [WorkingMemory](#workingmemory) |  |
| `chatUnread` | integer |  |
| `roomUrl` | string or null | The room on vibeconferencing.com. |
| `whiteboardUrl` | string or null |  |
| `screenShareUrl` | string or null | What the share window has loaded. |
| `sessionLogPath` | string or null |  |
| `calendarEventContext` | object or null |  |

### RoomResponse

| Field | Type | |
| --- | --- | --- |
| `success` | boolean |  |
| `roomId` | string |  |
| `callId` | string or null |  |
| `asOf` | string | Use as the next `since`. |
| `waited` | boolean |  |
| `elapsed` | integer | Seconds the poll blocked. |
| `continuationOfPriorResponse` | boolean | The speaker is still on the same thought you already answered. |
| `previousAckPhrase` | string or null | A filler the bot already said while you were thinking. Do not repeat it. |
| `voiceRequests` | array or null |  |
| `replayedBargeInStash` | object or null |  |
| `discardedBargeInStash` | object or null |  |
| `speechTruncated` | object or null | A line the bot cut short because someone spoke over it. |
| `transcript` | object |  |
| `whiteboard` | [Whiteboard](#whiteboard) |  |
| `chatUnread` | integer |  |
| `members` | array of object | Agents that have posted to this room. |
| `participants` | array of [Participant](#participant) |  |
| `screenShares` | array of object |  |
| `detectedMeetUrls` | array of string |  |
| `detectedSlackHuddleUrl` | string or null |  |
| `currentMeetUrl` | string or null |  |
| `status` | [RoomStatus](#roomstatus) | The bot's own state. Returned with every room read. |
| `displaced` | boolean | Another waiter from the same bot took over this poll. |
| `aborted` | boolean |  |
| `callFailed` | boolean |  |
| `chatWake` | boolean | Woke because a chat message arrived. |
| `screenWake` | boolean | Woke because the shared screen changed. |
| `backgroundTick` | boolean |  |
| `autoLeft` | boolean |  |
| `autoLeftReason` | `no-show` or `left-alone` or `call-ended` |  |
| `autoLeftDetail` | string |  |

### WrongInstance

| Field | Type | |
| --- | --- | --- |
| `success` | `False` |  |
| `wrongInstance` | `True` |  |
| `error` | string |  |
| `instance` | object |  |

### SpeechLine

| Field | Type | |
| --- | --- | --- |
| `text` (required) | string | Spoken as written. Keep it short; it plays in real time. |
| `voice` | string | One-off voice override. |
| `emoji` | string | The face the avatar wears while saying it. |
| `urgency` | number | Below 0.5 waits for a gap. At or above, may play over a speaker. |

### SyncRequest

| Field | Type | |
| --- | --- | --- |
| `sender` (required) | string | Your agent's id. Registers you as present. |
| `role` | `bot` or `member` | `bot` lines are spoken. `member` lines are transcript only. |
| `ownerName` | string |  |
| `displayName` | string |  |
| `versions` | object |  |
| `transcript` | array of [SpeechLine](#speechline) |  |
| `whiteboard` | object |  |
| `whiteboardStyle` | string | CSS applied to the board. |
| `reloadWhiteboard` | boolean |  |
| `meta` | [Action](#action) | One call action. `action` picks the kind; the other fields belong to that kind. |

### Action

One call action. `action` picks the kind; the other fields belong to that kind.

One of: [JoinMeet](#joinmeet), [JoinByUrl](#joinbyurl), [Bare](#bare), [ShareWhiteboard](#sharewhiteboard), [ShareTab](#sharetab), [LoadUrl](#loadurl), [ScrollShare](#scrollshare), [SetShareSize](#setsharesize), [SetShareTitleBar](#setsharetitlebar), [SetShareAudio](#setshareaudio), [ShareClick](#shareclick), [ShareType](#sharetype), [FindShareElement](#findshareelement), [EvalShare](#evalshare), [InspectDom](#inspectdom), [Limit](#limit), [PlayAudio](#playaudio), [PlaySound](#playsound), [SetMode](#setmode), [SetCamera](#setcamera), [SetAvatarEmoji](#setavataremoji), [SetCaptionLanguage](#setcaptionlanguage)

### JoinMeet

Join a Google Meet. The bot clicks through pre-join, then waits to be admitted. The name is locked for the call.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `join` |  |
| `meetCode` | string | Defaults to the room id in the path. |
| `botName` | string |  |
| `force` | boolean | Tear down a working call and rebuild it. Without it a repeat join is a no-op. |

### JoinByUrl

Join by the platform's own link. Zoom handles the waiting room; Teams the guest lobby; Slack needs the app signed in to that workspace. There is no join for Telegram, WhatsApp or phone; the bot answers those when called.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `join-zoom` or `join-teams` or `join-slack` |  |
| `url` (required) | string |  |

### Bare

`leave` hangs up; if after-call work is on, the bot enters that phase instead of shutting down. `end-session` finishes after-call work and releases the app. `stop-sharing` ends the screen share.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `leave` or `end-session` or `stop-sharing` |  |

### ShareWhiteboard

Present the bot's share window (the board, or a loaded URL) into the call.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `share-whiteboard` |  |
| `shareType` | string |  |

### ShareTab

Share a specific Chrome or Brave tab by URL. macOS only.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `share-tab` |  |
| `url` (required) | string |  |
| `appName` | string |  |

### LoadUrl

Load any web page into the share window instead of the board.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `load-url` |  |
| `url` (required) | string |  |

### ScrollShare

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `scroll-share` |  |
| `direction` | `down` or `up` or `top` or `bottom` |  |
| `amount` | number |  |

### SetShareSize

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-share-size` |  |
| `width` | integer |  |
| `height` | integer |  |

### SetShareTitleBar

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-share-title-bar` |  |
| `visible` (required) | boolean |  |

### SetShareAudio

Mute the sound from what is shared without stopping the share. Meet and Zoom.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-share-audio` |  |
| `muted` (required) | boolean |  |

### ShareClick

A real mouse click in the shared page. Prefer a selector over coordinates.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `share-click` |  |
| `selector` | string |  |
| `x` | number |  |
| `y` | number |  |
| `button` | `left` or `right` or `middle` |  |
| `clickCount` | integer |  |

### ShareType

Real key events in the shared page.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `share-type` |  |
| `text` | string |  |
| `key` | string |  |
| `modifiers` | array of `shift` or `control` or `alt` or `meta` |  |
| `selector` | string | Focus this element first. |

### FindShareElement

Find an element in the shared page from a plain-language description.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `find-share-element` |  |
| `description` (required) | string |  |
| `maxResults` | integer |  |

### EvalShare

Run JavaScript in the shared page and return the result.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `eval-share` |  |
| `expression` (required) | string |  |

### InspectDom

Read matched elements' outerHTML from the call page or the shared page.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `inspect-dom` |  |
| `target` | `meet` or `share` |  |
| `selector` | string |  |
| `maxElements` | integer |  |
| `maxChars` | integer |  |

### Limit

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `read-share-console` or `read-share-network` |  |
| `limit` | integer |  |

### PlayAudio

Play an audio file into the call through the bot's microphone. One of `url`, `path`, `audioData`.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `play-audio` |  |
| `url` | string |  |
| `path` | string | Absolute path on this machine. |
| `audioData` | string |  |
| `emoji` | string |  |
| `uninterruptible` | boolean |  |

### PlaySound

Play a bundled sound effect by catalogue name.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `play-sound` |  |
| `name` (required) | string |  |
| `emoji` | string |  |

### SetMode

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-mode` |  |
| `mode` (required) | [Mode](#mode) | `active` answers on every pause. `passive` stays quiet until named. `silent` listens and acts but never speaks. |

### SetCamera

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-camera` |  |
| `on` (required) | boolean |  |

### SetAvatarEmoji

Override the resting faces for the rest of the call. An empty string clears one.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-avatar-emoji` |  |
| `idle` | string |  |
| `listening` | string |  |
| `yielding` | string |  |

### SetCaptionLanguage

The language the bot listens in. Google Meet only today; other platforms return `ok: false`.

| Field | Type | |
| --- | --- | --- |
| `action` (required) | `set-caption-language` |  |
| `language` (required) | string | BCP-47. A bare `de` takes the first regional variant the platform lists. |

### SyncResponse

| Field | Type | |
| --- | --- | --- |
| `success` | boolean |  |
| `roomId` | string |  |
| `asOf` | string |  |
| `results` | object | One key per effect requested. Action results use the camelCased action name (`join`, `leave`, `setMode`, `shareClick`, and so on). |

### Preference

| Field | Type | |
| --- | --- | --- |
| `key` | string |  |
| `scope` | `app` or `profile` |  |
| `type` | string |  |
| `value` | any |  |
| `default` | any |  |
| `description` | string |  |
| `min` | number |  |
| `max` | number |  |
| `minItems` | integer |  |
| `requiresRestart` | boolean |  |
| `isDefault` | boolean |  |

### Instance

| Field | Type | |
| --- | --- | --- |
| `port` | integer |  |
| `baseUrl` | string |  |
| `profile` | string or null | `null` is the default bot. |
| `botName` | string |  |
| `configuredBotName` | string |  |
| `callStatus` | [CallStatus](#callstatus) | Where the bot is in a call's life. |
| `headless` | boolean |  |
| `roomId` | string or null |  |
