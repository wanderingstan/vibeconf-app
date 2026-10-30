# @vibeconferencing/calls

Be a participant in a call: join, speak, hear, chat and screen share in Google
Meet, Zoom, Teams, Slack huddles, WhatsApp, Telegram and phone calls (Twilio).

This is the calling layer of the Vibeconferencing app, being extracted into a
standalone MIT library. It lives in the app's repo as a local package until its
API holds; the app (`electron-app/`) is its first user. Not published yet.

## Layout

| Folder | What's in it |
| --- | --- |
| `core/` | The `CallProvider` contract and its IPC wire (`call-provider.js`, `call-client.js`), platform detection from a join URL (`call-target.js`), the calling-app base class, call phases |
| `providers/` | One provider per platform, with its DOM selectors next to it; Zoom's and Teams' sessions (`zoom-session.js`, `teams-session.js`: the heartbeat and speaking poll that run each call); the Twilio phone page and Voice SDK |
| `inject/` | The media core that runs inside the call page (`page-inject.js`: virtual mic and camera, the `getUserMedia` / `getDisplayMedia` overrides, audio taps, recorder), and `load.js` to put it there |
| `hearing/` | Captions and speech-to-text plumbing (`caption-source.js`, speech gate) |
| `recording/` | Per-track call recording and the ffmpeg merge |
| `hosts/electron/` | The Electron host: Slack's two surfaces, the recording windows, tab sharing, browser identity |
| `hosts/playwright/` | The Playwright host: a bot from plain Node, with Playwright driving Chrome. Meet, Zoom, Teams and Slack (see below) |
| `conformance/` | The conformance suite: the same two-bot checks for every provider on every host, plus its Playwright bot and test clip |

## Rules

- **Calls and media, never agents.** No LLM, turn-taking or MCP code here; the
  app draws its avatar and voices its agent through the media core's API
  (`window.__vibeconfMedia`) as page plugins of its own.
- **Only `hosts/electron/` requires Electron.** Anything else that needs the
  host gets it passed in.
- **Providers don't know the wire.** A provider takes commands as method calls
  and reports through its own events (`provider.on(CALL_EVENTS.x, fn)`); the
  host's preload carries both over IPC. Meet, Zoom and Teams start with
  `startGoogleMeet(host)`, `startZoom(host)` and `startTeams(host)`, which run
  the whole session in the page and ask the host for startup values (bot name,
  join mode, config).
- **Nothing reaches into the app.** No relative require leaves this folder.

`tests/calls-package-boundary.test.mjs` checks the last three.

## How the app uses it

`electron-app/package.json` depends on `file:../packages/calls` (npm links
it), with a pnpm override to `link:` (pnpm would otherwise copy it into its
store). The app requires deep paths, for example
`require('@vibeconferencing/calls/providers/zoom-provider')`.

electron-builder 25 won't pack files whose real path is outside
`electron-app/`, so `before-pack.js` swaps the link for a real copy for the
length of the pack and `after-pack.js` puts the link back.

## The Playwright host

```js
const { launchPlaywrightHost } = require('@vibeconferencing/calls/hosts/playwright');
const host = await launchPlaywrightHost({ userDataDir: '/tmp/bot-a' });
const call = await host.join(meetZoomOrTeamsLink, { botName: 'Ada' });
call.on(CALL_EVENTS.captionTurns, ({ turns }) => console.log(turns.at(-1)));
await call.setMicMuted(false);
await call.playAudioFile('hello.mp3');
await call.leave();
await host.close();
```

It needs `playwright-core` (an optional peer dependency) and drives the
installed Google Chrome, headed, with `navigator.webdriver` off as in the
Electron host (Meet refuses a webdriver-flagged guest). The media core and the
provider are
bundled (`bundle.js`) and added as init scripts; `page-host.js` is the page's
half (one entry per platform: `page-meet.js`, `page-zoom.js`, `page-teams.js`),
the Playwright counterpart of the app's call preloads.

Open:

- **Teams chat can drop a message on this host.** When the bot opens chat to
  send at the moment another participant's message arrives, Teams' web client
  never renders that message for the bot (its page has no trace of it; a
  message a few seconds earlier shows fine). Unexplained; the same sequence
  passes on the Electron host. The conformance suite catches it (Teams chat).
- **Slack needs signed-in profiles.** There is no guest path into a huddle.
  `node scripts/playwright-profile.mjs --name Alice --url https://app.slack.com`
  opens that bot's Chrome profile for a person to sign in once.
- **Not the calling apps yet.** WhatsApp, Telegram and phone calls are answered
  rather than joined (WhatsApp call links do join, and fit `join(url)`).
- **No share.** Presenting an app-owned page needs the WebRTC loopback the
  design doc proposes; the conformance suite skips share on this host.

## Conformance

`conformance/suite.js` runs two bots through join, roster, hearing both ways
(a played clip must come back as captions), chat, share and leave. A
capability the platform or the host lacks is skipped and says why. It drives
ConformanceBots, so one suite checks every host; `scripts/provider-test.mjs`
runs it (`--host electron` over the app's HTTP API, `--host playwright` here).
