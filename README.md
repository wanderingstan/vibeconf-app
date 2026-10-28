# Vibeconferencing — any agent in any call

[Vibeconferencing](https://vibeconferencing.com/) is a desktop app that lets any AI agent (**Claude Code, Codex, Grokbot, Meta's Muse**, or any agent that speaks MCP/HTTP) **join your Google Meet, Zoom, Microsoft Teams and Slack calls as a real participant**. It hears the conversation, speaks when appropriate, and can post in chat. And because it's your *actual* agent, not a notetaker, it **builds, researches, and acts on what's said while you're still in the call**, and can share its screen to show the work.

> **Status: early and experimental.** We built this for ourselves and are sharing it as is. It runs on **macOS** (the steps below), **Linux**, including an always-on cloud box ([docs/cloud-box.md](docs/cloud-box.md)), and **Windows**. Builds for all three are in every release. It joins **Google Meet**, **Zoom**, **Microsoft Teams** and **Slack huddles**. Zoom and Teams are new in v0.8.57. See [Known rough edges](#known-rough-edges) before your first call.

<p align="center"><a href="https://vibeconferencing.com"><img alt="Download Vibeconferencing" src="https://img.shields.io/badge/Download-vibeconferencing.com-9b2c9e?style=for-the-badge" height="44"></a></p>

Or grab a build for macOS, Linux or Windows from the **[latest release](https://github.com/wanderingstan/vibeconf-app/releases/latest)**, then follow the [5-minute setup](#get-in-a-call-with-your-bot--about-5-minutes) below.

![A Google Meet call with two humans and six AI agents, each bot tile labelled with the model family behind it: Claude, Grok, Codex and Meta's Muse](media/four-model-families-one-meet.jpg)

*A real call, Sept 24, 2026: two humans and six agents from four model families (Claude, Codex, Grok, Meta's Muse) in one Meet.*

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/architecture-fluent-dark.svg">
  <img alt="Architecture diagram: swappable LLM backends (Claude, Codex, Grok, Meta's Muse, local models) talk to the Vibeconferencing desktop app over MCP or HTTP; the app handles etiquette, camera avatar, whiteboard and the audio/video pipeline, pulls speech from ElevenLabs, OpenAI Realtime or OS-native TTS and avatar video from the built-in renderer or Runway, and joins Google Meet, Zoom, Microsoft Teams, Slack huddles and Telegram as a participant" src="media/architecture-fluent-light.svg">
</picture>

Your agent is the brain; the app is the body. The agent calls MCP tools (or raw HTTP) to speak, listen and draw. The app does the real-time media work: it plays synthesized speech into a virtual mic, renders the avatar and whiteboard into a virtual camera, and drives the call's web UI so the bot shows up as a normal participant. Dashed boxes are planned or in progress.

## It is an API

The app is a **calling API** first, and a desktop app that uses it. One HTTP API on `127.0.0.1` joins Google Meet, Zoom, Microsoft Teams, Slack huddles and WhatsApp call links, and answers Telegram, WhatsApp and phone calls, with the same handful of endpoints on every one: join, wait for someone to finish speaking, speak, chat, show a board, share a screen. Think OpenRouter, for calls.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/api-layers-dark.svg">
  <img alt="Diagram, left to right. Your code (Claude Code and Codex via MCP, curl, your app, the API explorer) sends HTTP and JSON to the local API at http://127.0.0.1:7865 with a bearer token: one request shape, GET /api/sync/{room}?wait=55 to hear the room and POST /api/sync/{room} to speak, write the board or run an action. The app drives each platform's own web client as a participant: meetings the bot joins (Google Meet, Zoom, Microsoft Teams, Slack huddles, WhatsApp call links, with FaceTime planned) and calls the bot answers (Telegram, WhatsApp, a phone number through Twilio, with Discord planned). What the room sees: a tile with a name and a face, a microphone that speaks, a camera with an avatar or a board, chat messages, a screen share." src="media/api-layers-light.svg">
</picture>

Browse and try it at **[vibeconferencing.com/api](https://vibeconferencing.com/api)**, read the **[API guide](docs/api/README.md)**, or import **[`openapi.yaml`](docs/api/openapi.yaml)** into your client. The bundled MCP server is a thin client of this API; [docs/api/mcp.md](docs/api/mcp.md) maps the tools onto the endpoints.

## Not notes. The thing.

Most bots send a summary after everyone leaves. This one works **in the call**. Because the bot **is** your Claude Code / Codex / Cursor session, it can do anything your agent can do in a normal session, live in the room: research a question, send the email, update the website, analyze the data, or build the thing you're discussing. It shares its screen to show the work as it evolves, and you take the result with you the moment you hang up.

> **Everyone else:** a transcript, later.
> **Yours:** the first version, now.

![Asked for something visually compelling, one bot puts a clay "Better Call Jimmy" on the shared board while the other bot is still thinking; Seth reacts](media/made-it-while-the-other-bot-was-thinking.gif)

*A real call, Aug 11, 2026: asked for something visually compelling, one bot put a clay "Better Call Jimmy" on the board while the other was still thinking.*

You drive it from your agent (just say *"join my call"*); the app is the "body" that gets it into the meeting.

---

## Get in a call with your bot — about 5 minutes

**You'll need:**
- A **Mac** for the steps below. *(On Linux or Windows, grab the AppImage, `.deb` or installer from the same release; for an always-on Linux box in the cloud, see [docs/cloud-box.md](docs/cloud-box.md).)*
- **Claude Code** installed and working. *(Codex, Cursor, or any MCP agent works too; [see below](#using-codex-cursor-or-another-agent).)*
- A browser (whatever you already use — auto-detecting your open Meet works in Chrome, Brave, and Safari; in Firefox or anything else, paste the Meet link into the app)

### 1. Download and install
Download the **`.dmg`** from the **[latest release](https://github.com/wanderingstan/vibeconf-app/releases/latest)**, open it, and drag **Vibeconferencing** into your Applications folder. Open it once.

<p>
<img src="media/app-window-call-now.png" width="320" alt="The Vibeconferencing app window for a bot named Rosie with no Meet open: its emoji avatar over a city-bridge background and a green Call Rosie now button">
<img src="media/app-window.png" width="320" alt="The Vibeconferencing app window for a bot named Jimmy: its emoji avatar over a forest background, the Google Meet link it detected already filled in, and a green Add Jimmy to call button">
</p>

*The app is your bot's window: its name, its face, and one button to bring it into a call. With no Meet open (left), that button starts a new one. With a Meet already open in your browser (right), it finds the link for you.*

### 2. Allow the permission prompts
The app needs **no microphone, camera, or screen-recording permission**: the bot's mic and camera are virtual. One optional prompt may appear, **Browser Automation**, which lets the app find your open Meet by itself. Skip it and just paste the Meet link into the app.

### 3. Sign in *(optional)*
Signing in gets you access to the shared whiteboard. It's optional and not automatic; sign in anytime from App Settings (**⌘,**).

### 4. Restart Claude Code
Installing the app teaches Claude Code a new `/join-call` command. Quit and reopen Claude Code once so it shows up.

### 5. Start a Google Meet
Open any Google Meet in your browser: a new meeting, a calendar event, whatever.

### 6. Tell your agent to join
In Claude Code, type:
```
/join-call
```
The bot finds your open Meet, joins it, and asks to be let in. (No need to copy any link; it detects the meeting automatically.)

Prefer a click? Press **Join call** in the app instead. It opens a terminal with a fresh Claude Code session that joins the call for you.

### 7. Let it in, then talk to it
Click **Admit** in your Meet window when it asks. Your bot appears as a participant. Now **just talk**. After a short pause it answers *out loud*, like anyone else in the call. Say *"we're done"* (or close Claude Code) when you want it to leave.

**That's it. You're in a call with your bot. 🎉**

## Make it better *(optional)*

### A good voice
Out of the box the bot uses the basic built-in Mac voice: fine for testing, but robotic.

- **⭐ ElevenLabs (most natural):** grab a free API key at **[elevenlabs.io](https://elevenlabs.io)**, paste it in App Settings (**⌘,**), then choose a voice from the People pane.
- **Local / open-source (advanced):** run a local voice engine (Kokoro/Voicebox) and point the app at it. See [docs/preferences.md](docs/preferences.md).
- **Premium Mac voices (free, no account):** search "system voice" in System Settings, open the picker under **Accessibility → Spoken Content**, download an "Enhanced" or "Premium" voice, then pick it in the app's voice selector.

<details>
  <summary>How to enable premium Mac voices</summary>
 
  ![Animated walkthrough: searching "system voice" in macOS System Settings, which opens the System voice picker under Accessibility → Spoken Content where an Enhanced/Premium voice can be downloaded](media/premium-mac-voice.gif)  
  
</details>  

### Real-time voice *(experimental)*
Turn on a bot's **`realtimeVoice`** preference **before it joins** to try OpenAI's speech-to-speech model in the voice seat. Your agent stays in the call as the "slow half", feeding the voice model facts instead of speaking itself. It needs an **OpenAI API key** in App Settings (**⌘,**), and call audio goes to OpenAI for as long as the realtime session is running, so expect per-minute charges. Details: [docs/realtime-voice-in-app.md](docs/realtime-voice-in-app.md).

---

## What you can ask it

Talk in plain language, no commands needed:

- *"Put a summary of what we decided on the whiteboard"*
- *"Take notes on this meeting on the whiteboard, with diagrams"*
- *"Change your voice"* · *"give yourself a beach background"*
- *"Take a screenshot of the call"* · *"read the chat"*
- *"Go quiet and just listen"* (it keeps up without speaking)

## Using Codex, Cursor, or another agent

Any MCP-capable agent can drive the bot. **Claude Code is wired up automatically** when you install the app. For other agents you point them at the app's bundled MCP server once. See **[docs/codex.md](docs/codex.md)** (Codex CLI) and the **[Quickstart](docs/quickstart.md)**.

![Two Claude Code sessions, a Codex session and a Grok bot introduce themselves in turn in one Google Meet, each tile labelled with its model family](media/one-human-four-agents.gif)

*A real call, Sept 23, 2026: two Claude Code sessions, a Codex session and a Grok bot, taking turns in one Meet.*

## Known rough edges

Worth knowing before your first call:

- **Admitting the bot:** if Meet shows a *"review potential risks"* prompt with only a **Deny** button, **Admit is in that prompt's ⋮ menu**.
- **One shared whiteboard:** bots in the same room share one board and each update replaces it, so two bots writing at once can overwrite each other. Your agent can list and read back earlier versions with `read_whiteboard`.
- **The default voice:** without an ElevenLabs key it uses a default OS voice; [A good voice](#a-good-voice) shows better options.

If a call goes wrong, the bot's info panel has a **📤 Share this call's log** button. Clicking it sends that call's log so far and keeps sending it until the call ends; logs can contain transcript text. (Continuous remote logging is a separate setting and is off by default.)

## Contributing

Found a bug? [Open an issue](https://github.com/wanderingstan/vibeconf-app/issues/new) with what you said, what the bot did, and your app version. Want to help? Issues labelled [`good-for-bot`](https://github.com/wanderingstan/vibeconf-app/issues?q=is%3Aopen+label%3Agood-for-bot) have been vetted by a human as safe for an autonomous coding agent to attempt, so you can point your own agent at one.

## More docs

[Install](docs/install.md) · [Quickstart](docs/quickstart.md) · [The API](docs/api/README.md) · [Multi-bot setups](docs/multi-bot.md) · [Preferences](docs/preferences.md) · [What you can ask (MCP tools)](docs/mcp-tools.md) · [Modes & states](docs/modes-and-states.md) · [Troubleshooting](docs/troubleshooting.md)

---

## For developers

**What's in here**

| Dir | What it is |
|-----|------------|
| `electron-app/` | The Electron app: audio pipeline, virtual camera, Meet/Zoom/Teams/Slack automation, turn-taking, the local control server, and the settings UI. |
| `mcp-server/` | The MCP server the agent talks to (tools like `join_call`, `wait_for_speech`, `speak`, `update_whiteboard`, `set_voice`). A thin client of the local HTTP API ([docs/api/](docs/api/README.md)). Bundled into the app. |
| `extension/` | Injected page scripts (Runway avatar bridge, LiveKit client). Bundled into the app. |
| `scripts/`, `tests/`, `docs/` | Test harness (fleet + nightly), unit/e2e tests, and user docs. The visual system for the app and the website is in [docs/STYLE-GUIDE.md](docs/STYLE-GUIDE.md). |

**How it works** (see the [diagram](#how-it-works) above)

```
 AI agent (Claude Code)  ──MCP──▶  mcp-server  ──HTTP──▶  Electron app  ──▶  Meet / Zoom / Teams / Slack
   (speak, listen,                 (bundled)              (audio in/out,        (as a real
    whiteboard, …)                                        virtual camera)        participant)
```

The agent never touches WebRTC. It calls MCP tools; the app does the real-time media work (plays synthesized speech into a virtual mic, renders the avatar/whiteboard into a virtual camera) and drives the call's web UI (Meet, Zoom, Teams or Slack).

**Processes and boundaries.** The app window is one process and the parent of every bot: it starts each bot as its own child process, sees it exit and why, and shows the selected bot's panel on its stage. Each bot joins its own call. Each agent session runs its own MCP server (a stdio child of the session), which talks to its bot's local port with that bot's token, and finds the bot through the app's directory on `:7864`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="media/processes-dark.svg">
  <img alt="Process diagram, read left to right. On this Mac, each agent session (Charlie's agent in Claude Code, started with /join-call; Bob's agent in Codex, asked in plain language) runs an MCP server as its stdio child; it finds its bot through the app's directory on port 7864 and talks to the bot's local API over HTTP with a token. The vibeconferencing app is one region containing a main process (stage, sidebar, directory, bot children) and the bot processes Charlie (a Fluent emoji face, port 7885) and Bob (a red panda, port 7887), each with a local API, a panel and a call view. The main process spawns each bot as its own child over a private channel, relays the selected bot's panel onto its stage over HTTP and SSE, and finds other bots it did not start, such as one launched by hand with a --profile flag, by scanning ports. The bots join Google Meet, Zoom, Microsoft Teams and Slack Huddles, outside the machine boundary, as participants." src="media/processes-light.svg">
</picture>

Regenerate with `python3 media/processes-diagram.py`.

**Build** (Node ≥ 18 and [pnpm](https://pnpm.io)):

```bash
cd electron-app
pnpm install
pnpm dev      # run from source
pnpm dist     # signed/notarized .dmg (Apple Developer creds needed; dist:fast skips notarization)
```

`pnpm dist` reads its Apple credentials from the environment — all three are
required, and electron-builder fails the build naming the one that's missing:

```bash
export APPLE_ID=...                    # Apple Developer account email
export APPLE_APP_SPECIFIC_PASSWORD=... # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID=PNPVJ6J7X2
```

With none of them set, notarization is skipped with a warning rather than
failing — you get a signed but un-notarized app. Use `dist:fast` when that's
what you actually want.

The build bundles `../mcp-server` and `../extension`, so keep the repo layout intact.

**Tests.** Unit tests need no build or install (just Node ≥ 18):

```bash
npm test      # 196 unit tests: config scoping, profile resolution, turn-taking gating, whiteboard layout, updates, …
```

`tests/e2e/` drives real Meet/Slack calls via the fleet harness (`scripts/`); the nightly runner is `scripts/scheduled-meet-test.sh` (see `scripts/SCHEDULING.md`).

## Backend

By default the app talks to the hosted **vibeconferencing.com** service (room sync, shared whiteboard, sign-in). The `websiteUrl` and `syncBaseUrl` preferences let you point it elsewhere if you run your own backend. The hosted backend and web frontend are not part of this repository.

## License

[MIT](./LICENSE) © 2026 Stan James
