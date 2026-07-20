# Vibeconferencing — desktop app

The macOS desktop app that puts **AI agents into your video calls as real participants**. A bot joins a Google Meet call (or Slack huddle), *hears* the conversation, *speaks* back via text-to-speech, shows a virtual-camera avatar, and shares a live whiteboard — all driven by an AI agent (e.g. Claude Code) through a bundled MCP server.

This is the open-source **client**. It connects to the hosted vibeconferencing.com backend for room sync, the shared whiteboard, and sign-in (both configurable — see below).

## What's in here

| Dir | What it is |
|-----|------------|
| `electron-app/` | The Electron app: audio pipeline, virtual camera, Meet/Slack automation, turn-taking, the local control server, and the settings UI. |
| `mcp-server/` | The Model Context Protocol server the agent talks to — tools like `join_call`, `wait_for_speech`, `speak`, `update_whiteboard`, `set_voice`. Bundled into the app. |
| `extension/` | Injected page scripts (Runway avatar bridge, LiveKit client). Bundled into the app. |

## How it works

```
 AI agent (Claude Code)  ──MCP──▶  mcp-server  ──HTTP──▶  Electron app  ──▶  Google Meet / Slack
   (speak, listen,                 (bundled)              (audio in/out,        (as a real
    whiteboard, …)                                        virtual camera)        participant)
```

The agent never touches WebRTC. It calls MCP tools; the app does the real-time media work (captures call audio for transcription, plays synthesized speech into a virtual mic, renders the avatar/whiteboard into a virtual camera) and drives the Meet/Slack UI.

## Build

Requires Node 18+ and [pnpm](https://pnpm.io). From `electron-app/`:

```bash
cd electron-app
pnpm install
pnpm dev      # run from source
pnpm dist     # build a signed/notarized .dmg (needs Apple Developer creds; use dist:fast to skip notarization)
```

The build bundles `../mcp-server` and `../extension` as app resources, so keep this repo's layout intact.

## Tests

Unit tests run with no build and no install (just Node ≥ 18):

```bash
npm test        # node --test tests/*.test.mjs
```

They cover the app's pure logic — agent working dirs, config scoping, profile
resolution, launch-command quoting, turn-taking / probe gating, whiteboard
layout, TTS chunking, updates, and more (196 tests). The `tests/e2e/` suite
drives real Meet/Slack calls and needs the fleet harness (a later migration).

## Backend

By default the app talks to the hosted **vibeconferencing.com** service (room sync, shared whiteboard, sign-in). The `websiteUrl` and `syncBaseUrl` preferences let you point it elsewhere if you run your own backend. The hosted backend and web frontend are not part of this repository.

## License

[MIT](./LICENSE) © 2026 Stan James
