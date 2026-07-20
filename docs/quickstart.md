# Quickstart — your first call

You'll start a Google Meet, run `/join-call` in Claude Code, and have a bot show up in the call as a participant you can talk to.

Prereqs: you've [installed](install.md) the app, granted Mic/Camera permissions, and restarted Claude Code at least once after install. A Vibeconferencing account is optional for a basic call; sign-in enables hosted room sync and the shared whiteboard.

## The five-step path

### 1. Start a Google Meet

Any Meet works — a personal room, a calendar event, an instant meeting. The bot joins as a guest participant. Open the Meet in your browser like normal.

> **Tip:** "Meet" here means the Meet web app. The bot won't join Zoom, Teams, or anything else.

### 2. Launch Vibeconferencing

Open the app from Applications (or `pnpm dev` from source). The panel window shows the version and an empty Meet URL field.

You don't need to type the Meet URL — the app autodetects it from the next step.

### 3. In Claude Code, run `/join-call`

```
/join-call
```

That's it. The skill:
- Picks up the Meet URL from your active Chrome, Brave, or Safari tab automatically
- Reads your project's `CLAUDE.md` for a bot persona/character name (falls back to "Jimmy" or whatever you set in the panel's Bot Name field)
- Calls `join_call` on the MCP server
- Starts a `wait_for_speech` loop so the bot is listening

You'll see the Vibeconferencing window navigate to your Meet, click through pre-join screens, and request to be let in.

### 4. Let the bot in

Meet shows "X wants to join" — click **Admit**. The bot shows up as a participant with the persona name, a colored emoji avatar, and the bot's name on the tile.

If captions aren't already on, the bot enables them (it reads captions to "hear" you).

### 5. Talk to it

Just talk. After a brief pause, the bot will respond via TTS — you hear it in the call like any other participant. If you don't want it to speak aloud (e.g. shared room), subtitles appear on the bot's avatar instead.

To end the call: tell the bot ("we're done"), or quit Claude Code, or have the bot `leave_call`.

## What just happened under the hood

```
You ─── speak in Meet ──→ Meet caption DOM ──→ Electron extension scrape ──→ local-server
                                                                                  │
                                                                                  ↓
                                                       wait_for_speech long-poll resolves
                                                                                  │
                                                                                  ↓
              Claude Code's agent ←──── MCP stdio ─── mcp-server/server.js ──────┘
                              │
                              ↓
                          speak("…") ─── MCP ─── local-server ─── TTS ──→ virtual mic ──→ Meet audio
```

The agent never sees Meet directly. It reads transcripts and writes speech through the local server, which manages the virtual camera, virtual mic, and Meet DOM.

## Useful first commands

Once the bot is in the call, any of these work from Claude Code:

| Want to… | Ask the bot |
|---|---|
| See the whiteboard | "Look at the whiteboard" (calls `get_room_info`) |
| Draft something visually | "Write a list of X on the whiteboard" (calls `update_whiteboard`) |
| Change the voice | Open the panel → People pane → click the bot → pick a voice |
| Switch the bot's tone emoji | "Set your idle emoji to 🤔" (calls `set_avatar_emoji`) |
| Make the bot stop speaking aloud | Set mode to silent: "go silent" or via the panel |

## Common first-call gotchas

| Symptom | What it means | Fix |
|---|---|---|
| Bot sits at "Waiting to be admitted" | You haven't clicked Admit yet | Click Admit in your Meet window |
| Bot doesn't respond after you speak | Captions might not be on; or speech threshold not crossed | Check that Meet shows the CC button as enabled. Try speaking a full sentence. |
| Bot speaks over you | DOM speaker tracker missed a speech-start | Pause and let it catch up; this is an active area of work (see issue #187) |
| Audio sounds robotic | macOS system TTS voice quality varies | Pick a different voice in the panel's People pane |
| Whiteboard updates don't render | You're not signed in to vibeconferencing.com | Sign in via the panel |

## Next

- Two bots in one call → **[Multi-bot setups](multi-bot.md)**
- Bot modes (active / passive / silent), states (yielding, thinking), avatar tuning → **[Modes and states](modes-and-states.md)**
- Full list of MCP tools → **[MCP tools](mcp-tools.md)**
