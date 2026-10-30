# @vibeconferencing/calls

Be a participant in a call: join, speak, hear, chat and screen share in Google
Meet, Zoom, Teams, Slack huddles, WhatsApp, Telegram and phone calls (Twilio).

This is the calling layer of the Vibeconferencing app, being extracted into a
standalone MIT library. It lives in the app's repo as a local package until its
API holds; the app (`electron-app/`) is its first user. Not published yet.

## Layout

| Folder | What's in it |
| --- | --- |
| `core/` | The `CallProvider` contract and its IPC wire (`call-provider.js`, `call-client.js`), platform detection from a join URL (`call-target.js`), the calling-app base class, call phases, the host channel (`host-ipc.js`) |
| `providers/` | One provider per platform, with its DOM selectors next to it; the Twilio phone page and Voice SDK |
| `inject/` | The media core that runs inside the call page (`page-inject.js`: virtual mic and camera, the `getUserMedia` / `getDisplayMedia` overrides, audio taps, recorder), and `load.js` to put it there |
| `hearing/` | Captions and speech-to-text plumbing (`caption-source.js`, speech gate) |
| `recording/` | Per-track call recording and the ffmpeg merge |
| `hosts/electron/` | The Electron host: Slack's two surfaces, the recording windows, tab sharing, browser identity |

## Rules

- **Calls and media, never agents.** No LLM, turn-taking or MCP code here; the
  app draws its avatar and voices its agent through the media core's API
  (`window.__vibeconfMedia`) as page plugins of its own.
- **Only `hosts/electron/` requires Electron.** Anything else that needs the
  host gets it passed in: a provider reaches the host through
  `core/host-ipc.js`, which the host's preload sets.
- **Nothing reaches into the app.** No relative require leaves this folder.

`tests/calls-package-boundary.test.mjs` checks the last two.

## How the app uses it

`electron-app/package.json` depends on `file:../packages/calls` (npm links
it), with a pnpm override to `link:` (pnpm would otherwise copy it into its
store). The app requires deep paths, for example
`require('@vibeconferencing/calls/providers/zoom-provider')`.

electron-builder 25 won't pack files whose real path is outside
`electron-app/`, so `before-pack.js` swaps the link for a real copy for the
length of the pack and `after-pack.js` puts the link back.
