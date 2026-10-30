# Status: what was built, and what's left

As of 2026-10-30. The plan is [design.md](design.md) (drafted 2026-10-29);
this is what happened to it. Phases 0 to 4 are merged to `main`.

![Architecture: app, library core, hosts, page](diagrams/architecture.svg)

## Phases

| Phase | What | Gate in the design | Where it landed |
| --- | --- | --- | --- |
| 0 | The wire contract: `main.js` drives every call through `CallClient` | Meet and Slack E2E green, no behavior change | [#928](https://github.com/wanderingstan/vibeconf-app/pull/928) |
| 1 | One join path for every platform; WhatsApp, Telegram and Twilio become providers | All seven platforms join through one function | [#932](https://github.com/wanderingstan/vibeconf-app/pull/932) |
| 2 | `page-inject.js` split: the media core stays, the avatar and realtime voice become app plugins over `window.__vibeconfMedia` | Avatar and whiteboard work through the surfaces | [#933](https://github.com/wanderingstan/vibeconf-app/pull/933) |
| 3 | `packages/calls` is the package; the app depends on it | `pnpm dist` signs and notarizes; Electron only in `hosts/electron` | [#934](https://github.com/wanderingstan/vibeconf-app/pull/934) |
| 3b | Meet's provider stops talking IPC, like the others | (added) | [#935](https://github.com/wanderingstan/vibeconf-app/pull/935) |
| 4 | Conformance suite, Playwright host | The same suite passes for Meet on both hosts | [#936](https://github.com/wanderingstan/vibeconf-app/pull/936) |
| 4b | Zoom's and Teams' sessions move into the library | (added) | [#937](https://github.com/wanderingstan/vibeconf-app/pull/937) |
| 4c | Slack's huddle session moves in; Playwright learns its two windows | (added) | [#938](https://github.com/wanderingstan/vibeconf-app/pull/938) |
| 5 | Release | 14 green canary nights in a row | Under way (below) |

Every gate was met. Phases 3b, 4b and 4c weren't in the plan: each moved a
platform's per-call loop out of the app's preloads, which the Playwright host
needed before it could run that platform.

## Conformance

The suite (`conformance/suite.js`) runs two bots through join, roster,
hearing both ways (a played clip must come back as captions), chat, share and
leave, skipping what a platform or host can't do. Last full results:

| | Electron | Playwright |
| --- | --- | --- |
| Meet | 12/12 | 10/10 (share skipped) |
| Zoom | 12/12 | 10/10 (share skipped) |
| Teams | 12/12 | 9/10 (share skipped, one chat miss, below) |
| Slack | 12/12 | One bot verified; the two-bot run waits on a second signed-in profile |

The nightly canary (`.github/workflows/canary.yml`) runs this matrix on the
Mac mini and posts the green streak to Telegram.

## Where the build departs from the design

![Classes and contracts, as designed](diagrams/classes-and-contracts.svg)

The diagram above is the design's view. In the code today:

- **No public `Call` API yet.** The design's `join(host, { url })`, grouped
  methods (`call.mic`, `call.share`), typed `JoinError` codes and
  `defineProvider` aren't built. The surface is the wire contract
  (`core/call-provider.js`: `CallProvider`, `CALL_COMMANDS`, `CALL_EVENTS`),
  one start function per provider (`startGoogleMeet`, `startZoom`,
  `startTeams`, `startSlackHuddle`), and `launchPlaywrightHost`. Designing the
  public API is the next Phase 5 step, for review before it's built.
- **No generic `Host` interface.** The two hosts are concrete: the app's
  preloads for Electron, `hosts/playwright` for Playwright. They share the
  providers and the media core, not an interface type.
- **Not a pnpm workspace.** The app depends on `file:../packages/calls`
  (npm links it; CI installs with npm) with a pnpm `link:` override.
  electron-builder 25 won't pack a linked package from outside the app, so
  `before-pack.js` swaps in a real copy and `after-pack.js` restores the link.
- **Providers own their whole session.** Each platform's heartbeat (pre-join,
  in-call reporting, roster, captions, speaking poll) runs in the library and
  reports through provider events; the hosts only carry commands and events.
  The design had providers as DOM code with the loops left to each host.
- **The Playwright host presents as ordinary Chrome.** It drives the installed
  Google Chrome, headed, with the sandbox on, the page's CSP bypassed (Meet's
  Trusted Types otherwise refuse the provider), and `navigator.webdriver` off,
  which the Electron host already was. Meet refuses a webdriver-flagged guest
  ("You can't join this video call"). Stan authorized this on 2026-10-30.
  The design's risk table says "no stealth or anti-detection features, ever";
  that line needs revisiting in light of this (open question below).

## Open

**Before the first internal release**

- Run the release workflow for an internal app build on the package (signed,
  notarized), and use it for a while. The public launch waits until the
  library has been dogfooded through one or two internal releases.

**Platforms**

- Teams chat on Playwright: when a bot opens chat to send at the moment the
  other's message arrives, Teams never renders that message for it. The same
  sequence passes on Electron. Unexplained.
- Slack on Playwright: the second bot's profile needs a Google Workspace
  admin to clear its sign-in.
- Share and call recording on Playwright: presenting an app-owned page needs
  the WebRTC loopback the design proposes; neither is built.
- The calling apps (WhatsApp, Telegram, phone) aren't on the Playwright host.
  Their incoming-call half needs the `listen()` API (design: Incoming calls).
  WhatsApp call links are joined, not answered, and fit `join(url)`.

**Before the public launch**

- The public API, reviewed before it's built.
- README, the `hello-call` and `call-console` reference apps, a Pipecat
  transport example, a public canary status page.
- Provenance: `inject/page-inject.js` says it was adapted from the GIF-Cam
  virtual camera extension (2020); confirm it can ship under MIT.
- Test fixtures in tracked files (the Meet test room, the Slack workspace and
  channel) move out before the repo goes public.
- The repo split to `vibeconferencing-calls` and the npm publish.

**Open questions carried from the design**

- MIT, or Apache-2.0 for its patent grant?
- The "no stealth or anti-detection" principle versus the Playwright host
  turning `navigator.webdriver` off: restate the principle, or change the host?
- Support promise: which platforms get a fix-within-days commitment?
- Camera surface: page URL only, or also a raw frame stream?
- Launch story: a Pipecat transport first, or an MCP server for coding agents?
