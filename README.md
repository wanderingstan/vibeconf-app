# Vibeconferencing — bring your agent into a video call

Vibeconferencing is a Mac app that lets an AI agent — the one you already use in **Claude Code, Codex, or Cursor** — **join your Google Meet calls as a real participant**. It hears the conversation, talks back out loud, and — because it's your *actual* agent, not a notetaker — it **builds, researches, and acts on what's said while you're still in the call**, and can share its screen to show the work.

![A Google Meet call with two people and the bot "jimmy bot" (an emoji avatar) presenting a shared whiteboard that diagrams the call's human and bot participants alongside live notes](media/call-whiteboard.png)

## Not notes. The thing.

Most meeting AI sends a summary after everyone leaves. This works **in the call** — because the bot *is* your Claude Code / Codex / Cursor session, it can research a question, draft the email, write the code, or build the thing you're discussing, **live, while everyone's still in the room**. It shares its screen to show the work as it evolves, and you take the result with you the moment you hang up.

> **Everyone else:** a transcript, later.
> **Yours:** the first version, now.

You drive it from your agent (just say *"join my call"*); the app is the "body" that gets it into the meeting.

---

## Get in a call with your bot — about 5 minutes

**You'll need:**
- A **Mac with Apple Silicon** (M1, M2, M3, or M4)
- **Claude Code** installed and working *(Codex, Cursor, or any MCP agent also works — [see below](#using-codex-cursor-or-another-agent))*
- **Chrome or Brave** (the app uses one of these for the meeting)
- A **Google account** (so you're in the Meet too)

### 1. Download and install
Download the **`.dmg`** from the **[latest release](https://github.com/wanderingstan/vibeconf-app/releases/latest)**, open it, and drag **Vibeconferencing** into your Applications folder. Open it once — it's signed and notarized by Apple, so it just runs.

### 2. Allow the permission prompts
On first launch macOS asks for **Microphone** and **Camera** — both required (the bot speaks through a virtual mic and appears as a virtual-camera avatar). If you also want the bot to *show* its whiteboard on screen, allow **Screen Recording** too (optional).

### 3. Sign in
The app opens a browser tab to sign in at vibeconferencing.com (this powers the shared whiteboard), then hands you back to the app automatically.

### 4. Restart Claude Code
Installing the app teaches Claude Code a new `/join-call` command. Quit and reopen Claude Code once so it shows up.

### 5. Give your bot a good voice *(strongly recommended)*
Out of the box it uses the basic built-in Mac voice — fine for testing, but robotic. Pick one:

- **⭐ Best — ElevenLabs (natural, human-like):** grab a free API key at **[elevenlabs.io](https://elevenlabs.io)** → in the app press **⌘,** (App Settings) and paste the key. Then choose a voice from the People pane.
- **Free — premium Mac voices:** in **System Settings → Accessibility → Spoken Content**, download an "Enhanced" or "Premium" voice, then pick it in the app's voice selector. A big step up from the default, no account needed.
- **Local / open-source (advanced):** run a local voice engine (Kokoro/Voicebox) and point the app at it — see [docs/preferences.md](docs/preferences.md).

### 6. Start a Google Meet
Open any Google Meet in Chrome or Brave — a new meeting, a calendar event, whatever.

### 7. Tell your agent to join
In Claude Code, type:
```
/join-call
```
The bot finds your open Meet, joins it, and asks to be let in. (No need to copy any link — it detects the meeting automatically.)

### 8. Let it in, then talk to it
Click **Admit** in your Meet window when it asks. Your bot appears as a participant. Now **just talk** — after a short pause it answers *out loud*, like anyone else in the call. Say *"we're done"* (or close Claude Code) when you want it to leave.

**That's it — you're in a call with your bot. 🎉**

---

## What you can ask it

Talk in plain language, no commands needed:

![The bot's in-call side panel introducing itself — you can ask it to change its voice, change its avatar background, show or edit a whiteboard, read or post chat, take a screenshot, or switch between active/passive/silent modes — with two bots showing custom World-Cup avatar backgrounds](media/call-capabilities.png)

- *"Put a summary of what we decided on the whiteboard"*
- *"Change your voice"* · *"give yourself a beach background"*
- *"Take a screenshot of the call"* · *"read the chat"*
- *"Go quiet and just listen"* (it keeps up without speaking)

## Using Codex, Cursor, or another agent

Any MCP-capable agent can drive the bot. **Claude Code is wired up automatically** when you install the app. For other agents you point them at the app's bundled MCP server once — see **[docs/codex.md](docs/codex.md)** (Codex CLI) and the **[Quickstart](docs/quickstart.md)**.

## More docs

[Install](docs/install.md) · [Quickstart](docs/quickstart.md) · [Multi-bot setups](docs/multi-bot.md) · [Preferences](docs/preferences.md) · [What you can ask (MCP tools)](docs/mcp-tools.md) · [Modes & states](docs/modes-and-states.md) · [Troubleshooting](docs/troubleshooting.md)

---

## For developers

<details>
<summary>Repo layout, how it works, building, and tests</summary>

**What's in here**

| Dir | What it is |
|-----|------------|
| `electron-app/` | The Electron app: audio pipeline, virtual camera, Meet/Slack automation, turn-taking, the local control server, and the settings UI. |
| `mcp-server/` | The MCP server the agent talks to — tools like `join_call`, `wait_for_speech`, `speak`, `update_whiteboard`, `set_voice`. Bundled into the app. |
| `extension/` | Injected page scripts (Runway avatar bridge, LiveKit client). Bundled into the app. |
| `scripts/`, `tests/`, `docs/` | Test harness (fleet + nightly), unit/e2e tests, and user docs. |

**How it works**

```
 AI agent (Claude Code)  ──MCP──▶  mcp-server  ──HTTP──▶  Electron app  ──▶  Google Meet / Slack
   (speak, listen,                 (bundled)              (audio in/out,        (as a real
    whiteboard, …)                                        virtual camera)        participant)
```

The agent never touches WebRTC. It calls MCP tools; the app does the real-time media work (captures call audio for transcription, plays synthesized speech into a virtual mic, renders the avatar/whiteboard into a virtual camera) and drives the Meet/Slack UI.

**Build** (Node ≥ 18 and [pnpm](https://pnpm.io)):

```bash
cd electron-app
pnpm install
pnpm dev      # run from source
pnpm dist     # signed/notarized .dmg (Apple Developer creds needed; dist:fast skips notarization)
```

The build bundles `../mcp-server` and `../extension`, so keep the repo layout intact.

**Tests** — unit tests need no build or install (just Node ≥ 18):

```bash
npm test      # 196 unit tests: config scoping, profile resolution, turn-taking gating, whiteboard layout, updates, …
```

`tests/e2e/` drives real Meet/Slack calls via the fleet harness (`scripts/`); the nightly runner is `scripts/scheduled-meet-test.sh` (see `scripts/SCHEDULING.md`).

</details>

## Backend

By default the app talks to the hosted **vibeconferencing.com** service (room sync, shared whiteboard, sign-in). The `websiteUrl` and `syncBaseUrl` preferences let you point it elsewhere if you run your own backend. The hosted backend and web frontend are not part of this repository.

## License

[MIT](./LICENSE) © 2026 Stan James
