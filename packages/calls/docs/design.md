<!-- The calls library's design draft, kept as written. Exported 2026-10-30 from the Claude Doc https://claude.ai/artifact/CifYKuFLyyhcyVkXgWwXHM (rev 27); diagrams in ./diagrams were rendered from the doc's own sources. -->

> **A dated record.** This is the design as drafted on 2026-10-29, before any of it was built. What actually shipped, phase by phase, and where it departs from this draft, is in [status.md](status.md).

# Calling library extraction: design draft

2026-10-29 · Stan James

## Summary

We extract the "be a participant in a call" layer of vibeconf-app into a standalone MIT library (repo vibeconferencing-calls, package `@vibeconferencing/calls`), keep it inside this repo as a workspace package until its API holds, and make the app its first consumer. About 19k lines move; the hard work is untangling main.js (16k lines) and page-inject.js (4.5k lines), which pays off for the app even if the library never ships.

**Goals**

- One API to join, speak, hear, chat, screen share and see participants on Meet, Zoom, Teams, Slack huddles, WhatsApp, Telegram and phone (Twilio).
- Runs on the developer's own machine: an npm package, not a hosted service.
- Two hosts: Electron (what the app uses today) and Playwright with Chromium (for servers, CI, and other developers).
- The app keeps every feature it has now, with no behavior change during the migration.

**Non-goals (v1)**

- No agent, LLM, turn-taking, or MCP logic. Those stay in the app.
- No hosted bot fleet, scheduling, or calendar joins.
- No official platform SDK paths (Zoom Meeting SDK, Teams Graph media). Browser automation only, behind an interface that could take an SDK provider later.
- No avatar, whiteboard, or realtime-voice features. The library exposes a camera and a share surface; what the app draws on them is the app's business.

## Positioning

We win on three things nobody combines: an embeddable library, a permissive license, and the widest platform list. Meet, Zoom and Teams alone are a crowded market.

| Project | Shape | License | Interactive (speak, chat, share) | Beyond Meet/Zoom/Teams |
| --- | --- | --- | --- | --- |
| Recall.ai | Hosted API | Commercial | Yes | Slack huddles, Webex |
| AgentCall | Hosted backend + MIT client | MIT client only | Yes, aimed at coding agents | No |
| joinly | Docker MCP server | MIT | Speak and chat, no share | No |
| Attendee | Docker service | Elastic 2.0 (not OSI) | Yes | No |
| Vexa | Docker service | Apache-2.0 open core | Mostly listen-only | No |
| Pipecat, LiveKit Agents | Frameworks | Permissive | Yes, own rooms only | Phone, WhatsApp Business 1:1 |
| **@vibeconferencing/calls** | **npm library** | **MIT** | **Yes** | **Slack, WhatsApp, Telegram, phone** |

Pipecat and LiveKit are complements, not competitors: they lack a way into Meet/Zoom/Teams, so a Pipecat transport built on this library is a natural early integration. Survey as of 2026-10-29; Skribby, Nylas and AgentCall's backend method were not verified.

## Package boundary

The rule: the library knows about calls and media, never about agents. Speech synthesis and transcription engines are plug-ins, because they cost money and every developer will pick their own. Line counts are from `wc -l` today; the main.js figure is an estimate.

| Today (electron-app/) | Lines | Goes to |
| --- | --- | --- |
| `google-meet-provider.js`, `zoom-provider.js`, `teams-provider.js`, `slack-provider.js` | 5,870 | Library `providers/` |
| `*-selectors.js` | 1,355 | Library, next to each provider |
| `whatsapp-call.js`, `telegram-call.js`, `twilio-call.js` + their preloads | ~1,100 | Library, rewritten as real providers |
| `page-inject.js`: virtual mic, camera frame, `getUserMedia`/`getDisplayMedia` overrides, WebRTC tap, recorder | ~2,500 | Library `inject/` (runs in the page) |
| `page-inject.js`: emoji avatar modes, `Whiteboard`, `RealtimeVoice` | ~2,000 | Stays in app |
| `caption-source.js`, `zoom-captions.js`, `speech-gate.js` | ~500 | Library `hearing/` |
| `stt.js` (ElevenLabs Scribe), `tts.js`, `system-voices.js` | ~900 | Optional adapter packages |
| `call-recorder.js`, `call-media-merge.js` | ~900 | Library `recording/` (optional) |
| `slack-surface.js`, `dom-probe.js`, `audio-probe.js`, `call-phase.js`, `rejoin-guard.js`, `share-surface.js` | ~1,500 | Library core |
| main.js session, permission, display-media and activation code; `call-recording-window.js`; `share-external-tab.js` | ~2,500 (est.) | Library `hosts/electron` |
| main.js rest, `local-server.js`, `mcp-server/`, supervisor, `preferences-schema.js`, `agent-*`, `bot-*` | ~32,000 | Stays in app |

The app keeps its HTTP API and MCP tools exactly as they are. `local-server.js`'s ~55 `on*` hooks (`onJoinZoom`, `onSendChat`, `onShareTab`, ...) get reimplemented in main.js as thin calls into the library, which is how we prove the boundary.

## Public API

A `Call` object in Node, with grouped methods and typed events, grown from today's `CallProvider` (call-provider.js). The provider is picked from the join URL. Every method is gated by a capability flag and throws `UnsupportedError` when the platform lacks it.

```ts
import { join } from '@vibeconferencing/calls';
import { playwrightHost } from '@vibeconferencing/calls/hosts/playwright';

const host = await playwrightHost({ profileDir: './profiles/alice' });
const call = await join(host, {
  url: 'https://meet.google.com/abc-defg-hij', // provider chosen from the URL
  name: 'Alice (AI)',
  identity: 'guest',                            // or 'account' (signed-in profile)
});

call.capabilities; // { captions, rawAudio, chat, share, camera, participants, speaking }

call.on('state', s => {});        // joining | lobby | in-call | left | removed | error
call.on('caption', turn => {});   // { speaker, text, final, at }
call.on('audio', frame => {});    // PCM from remote tracks, when rawAudio
call.on('participants', list => {});
call.on('speaking', ({ name, speaking }) => {});
call.on('chat', msg => {});       // { id, sender, text, at }
call.on('share', ({ presenter, active }) => {});
call.on('stall', ({ what }) => {}); // captions or roster stopped updating

const playback = await call.speak(audio); // Buffer or PCM stream; playback.done, playback.cancel()
await call.mic.setMuted(true);
await call.camera.set({ kind: 'page', url: 'http://localhost:7901/avatar' }); // or 'off'
await call.chat.send('hello');
await call.share.start({ source: { kind: 'page', url }, audio: true });
await call.share.stop();
const png = await call.screenshot();
await call.leave();
```

**Design decisions**

- **Audio in, not text in.** `speak()` takes audio. TTS is an adapter (`@vibeconferencing/calls-tts-elevenlabs`, `-system`), so the core has no paid API dependency.
- **Two ways to hear, one event.** `caption` comes from platform captions where they exist, or from an STT adapter fed by `audio` frames. This is today's `CaptionRouter` (caption-source.js), made public.
- **Camera and share are surfaces you own.** The library exposes them as pages or frames the host captures. The app's emoji avatar and whiteboard become ordinary pages drawn by the app, which is what moves ~2,000 lines out of page-inject.js.
- **Providers keep running in the page.** Today providers are DOM code inside preloads. We keep that and give each host a message bridge (Electron IPC, Playwright `exposeBinding`). The Node `Call` is a proxy over it. This is the smallest rewrite of 5,870 lines of provider code.
- **Typed join failures.** `JoinError.code` is one of `lobby-timeout`, `denied`, `auth-required`, `blocked-by-admin`, `ui-changed`. `ui-changed` (a selector miss) is the one users will hit most, so it carries the selector name and a screenshot.

**Provider plugin shape** (so outsiders can add Webex, Jitsi, Discord):

```ts
defineProvider({
  id: 'zoom',
  match: url => /zoom\.us\/(j|wc)\//.test(url),
  capabilities: { captions: true, chat: true, share: true, rawAudio: true },
  hostNeeds: { stripCsp: false, userAgent: 'chrome-desktop', popups: false },
  pageScript: './zoom/page.js', // the in-page half: DOM automation + selectors
});
```

## Classes and contracts

There are two contracts. The app talks to the library only through the Call API, and the library talks to each call page only through the wire contract in call-provider.js. Each platform is a `CallProvider` subclass running inside its page.

![Classes and contracts: app, Node side, wire contract, page side](diagrams/classes-and-contracts.svg)

Phase 0 made `CallClient` the one Node-side object main.js drives. Phase 1 adds the dashed boxes: one platform table and join path, and real provider classes for WhatsApp, Telegram and Twilio. Answering incoming calls (WhatsApp, Telegram, phone) doesn't fit `CallProvider`'s join model, so it will get its own small API.

## Incoming calls

A WhatsApp, Telegram or phone bot is answered, not joined: someone calls the bot's own account, and the bot decides whether to pick up. That half doesn't fit `CallProvider`, which starts at "join this link" and covers the call once it is up. Phase 1 step 4 split the two in the app:

- **The call itself** is a provider like any other. `WhatsAppProvider`, `TelegramProvider` and `TwilioProvider` (on a shared `CallingAppProvider` base) implement the same methods as Meet, Zoom, Teams and Slack: mic, camera, chat, share, leave. Their capabilities say what each lacks: no platform captions on any of them (the bot hears through the audio tap and its own STT), no video on Telegram (#889), and audio only on a phone line.
- **Answering** stays in each app's page code for now: standby (the bot's account open, waiting), the caller allowlist and passcode gate, accept or decline, and missed calls.

The library needs a small, separate API for the answering half, alongside `Call`:

```js
const line = await calls.listen('whatsapp', { account });  // standby
line.on('incoming', async (offer) => {
  // offer.caller: { id, name, phone? }
  if (allowed(offer.caller)) {
    const call = await offer.accept();  // a Call, same as join() returns
  } else {
    await offer.decline();
  }
});
line.on('missed', (m) => {});
await line.close();
```

`offer.accept()` hands back an ordinary `Call`, so everything after the pickup is the same contract as a joined call. The allowlist and gate are policy, so they stay in the app: the library reports who is calling and the app decides. Twilio already works this way, since its gate runs on Twilio's side before the bot's phone ever rings.

## Host abstraction

A host is whatever owns the browser: it opens isolated surfaces (tabs or views), injects the provider's page script before load, bridges messages, and answers the page's media requests. Electron ships first because it is today's code; Playwright ships second and is what most outside developers will use.

![Architecture: app, library core, hosts, page](diagrams/architecture.svg)

Everything in the accent box and below it is the library; the app talks only to the core, and only the host layer knows whether Electron or Playwright is underneath.

```ts
interface Host {
  openSurface(opts: SurfaceOptions): Promise<Surface>; // profile, userAgent, stripCsp, permissions
  onDisplayMedia(handler: (req) => ShareSource): void;  // answers getDisplayMedia
  close(): Promise<void>;
}
interface Surface {
  goto(url: string): Promise<void>;
  addInitScript(src: string): Promise<void>;
  bridge(channel: string): Bridge;                      // page <-> Node messages
  screenshot(): Promise<Buffer>;
  onPopup(fn: (s: Surface) => void): void;              // Slack huddle window
  setAudioMuted(muted: boolean): void;
}
```

| Need | Electron (today) | Playwright + Chromium |
| --- | --- | --- |
| Isolated, persistent profile | `session` partition | `launchPersistentContext(userDataDir)` |
| Page code before load | preload + `executeJavaScript` | `addInitScript` |
| Page to Node messages | `ipcRenderer` / `ipcMain` | `exposeBinding` |
| CSP strip, COOP rewrite (WhatsApp) | `webRequest.onHeadersReceived` | `bypassCSP` + `page.route` header rewrite |
| Mic and camera permission | `setPermissionRequestHandler` | `grantPermissions` |
| Bot mic and camera | `getUserMedia` override in page | Same override, unchanged |
| Screen share of an app-owned page | `setDisplayMediaRequestHandler` returning a `WebFrameMain` | **Open:** WebRTC loopback from the share page to the call page (proposed, unproven) |
| Screenshot | `capturePage` | `page.screenshot` |
| Popup windows (Slack) | `setWindowOpenHandler` | `context.on('page')` |
| Call recording, video | `call-recording-window.js` | **Open:** in-page `MediaRecorder` on mixed streams, or CDP screencast |
| No background throttling | `backgroundThrottling: false` | Chromium launch flags |

Two rows are open risks; the rest map one to one. Headless Chromium is likely to be detected by Meet, so the Playwright host should default to headed Chromium (under Xvfb on Linux servers). That is an assumption to test early.

## Platform capability matrix

Meet is the only platform at production quality today; the rest need hardening before we can advertise them. "Not checked" means the code survey did not confirm it either way.

| Platform | How the bot hears | Chat | Screen share | Participants | Behind `CallProvider` today | E2E test today | v1 status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Google Meet | Platform captions (`CaptionScraper`) | Yes | Yes | Yes (`DOMSpeakerTracker`) | Yes | `meet-test.mjs` + fleet | Ship |
| Zoom (web) | Platform captions (`zoom-captions.js`) | Yes | Yes | Yes | Yes | None | Beta |
| Teams (web) | Platform captions | Yes | Yes | Yes | Yes | None | Beta |
| Slack huddle | Platform captions | Yes | Yes | Yes | Partly (`join` partial, no `recoverCaptions`) | `slack-test.mjs` | Beta |
| WhatsApp (web) | Audio tap + STT | Yes (internal modules) | Not checked | Yes (internal modules) | No | None | Experimental |
| Telegram (web) | Not checked | Yes (DOM) | Not checked | Not checked | No | None | Experimental |
| Phone (Twilio) | Audio + STT | No | No | Caller only | No | None | Beta |

WhatsApp and Telegram drive a personal account through the web client, which risks account bans; label them experimental and say so in the README.

## Migration plan

Six phases, each one behavior-preserving and shippable on its own, so the app is never broken for more than one PR. Phases 0 to 2 happen in place inside electron-app/ and are worth doing even if we never publish. Sizes are guesses, not estimates.

- **Phase 0, wire the contract (M).** main.js stops sending raw `webContents.send('extension-message', ...)` (~27 sites) and talks to each call through a `CallProvider` proxy over IPC. This is the "step 3" the call-provider.js header already plans. *Gate:* `pnpm test:meet:ci` and `pnpm test:slack:ci` green, no behavior change.
- **Phase 1, one path for every platform (M).** WhatsApp, Telegram and Twilio become real providers. The `slackProviderMode` / `zoomProviderMode` / `teamsProviderMode` / `callingAppMode` flags (53 references) and the separate `activate*` functions collapse into one `join(url)`. *Gate:* all seven platforms join through one function.
- **Phase 2, split page-inject.js (L).** Media core stays; emoji avatar, `Whiteboard` and `RealtimeVoice` move to app-owned pages shown through the camera and share surfaces. *Gate:* avatar and whiteboard work through `camera.set` / `share.start`.
- **Phase 3, create the package (M).** `packages/calls` as a pnpm workspace package; move providers, selectors, inject, hearing, recording and `hosts/electron`. The app depends on it. *Gate:* `pnpm dist` signs and notarizes; no `require('electron')` in the library outside `hosts/electron`.
- **Phase 4, Playwright host and conformance suite (L).** *Gate:* the same suite passes for Meet on both hosts; Zoom and Teams get their first E2E runs.
- **Phase 5, public release (M).** README, the hello-call and call-console reference apps (next section), a Pipecat transport example, published canary status. *Gate:* nightly canaries green for 14 days running.

## Reference apps

Two tiny examples ship with the library, neither needing an API key. A paid TTS or STT key in the first five minutes is where people give up.

|  | `hello-call` | `call-console` |
| --- | --- | --- |
| What it is | A ~30-line script, the README's first code block | One HTML page with a bot's-eye view: everything the call sends in, beside every control the bot has. Served by a ~100-line server |
| Run it | `npx @vibeconferencing/calls hello <meeting-url>` | `npx @vibeconferencing/calls console` |
| Does | Picks the platform from the URL, joins, plays a bundled confirmation clip, sends "hello" in chat, prints 30 s of captions, leaves | One button per `Call` method, greyed out when the platform lacks the capability. The incoming pane shows live captions (or STT turns), participants and who is speaking, chat, share state and call state, as the bot receives them |
| For | "Does it work on my platform?" in one command | Seeing exactly what a bot can hear and do on each platform; manual testing; bug reports |
| Doubles as | The first conformance check and the nightly canary's smoke step | The visual check while writing a new provider |

![call-console mock-up: incoming data, controls, event log (example data)](diagrams/call-console-mockup.svg)

The log at the bottom interleaves both directions, so a click on Share a page shows up as the `share.start` call going out and the platform's `share` event coming back.

Neither replaces the app's HTTP API reference, which documents the agent-facing layer (transcripts, turn-taking, working memory) and stays in vibeconf-app. No platform picker: the URL already says which platform it is, and a picker invites mismatches.

## Testing and conformance

Nightly canaries are the product: an outside developer adopts a library like this for "it still works this week," and Meet's selectors changed 22 times between June and October. We build on what already exists. `spawn-test-fleet.sh` boots isolated bots, and `meet-test-lib.mjs` drives them over HTTP.

- **Unit tests stay pure.** The ~45 platform tests in tests/ (selectors, `zoom-captions`, `caption-source`, `telegram-call`, ...) move with their modules and keep running under `node --test`.
- **One conformance suite per capability, run against every provider.** Two bots join the same room. Bot A speaks a known phrase and Bot B must caption it within a time limit. Then chat round-trips, the participant list shows both bots, share starts and is seen, and both leave cleanly. Capabilities a provider lacks are skipped, not failed.
- **Run on both hosts.** The suite takes a host factory, so the Electron and Playwright hosts are checked by the same code.
- **Canary matrix on the Mac mini, nightly.** One run per platform × host, posting to Telegram (the existing `VIBECONF_NOTIFY_CHAT`) and to a public status page. A `ui-changed` failure attaches the screenshot and selector name.
- **Fill the gaps first.** Zoom, Teams, WhatsApp, Telegram and Twilio have no E2E script today. Each needs a test room or account before it can leave beta.

## Risks and open questions

The biggest risk is maintenance, not engineering: going public makes us on call for everyone's broken joins.

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Selector churn breaks users between releases | High (Meet: 22 selector commits in 4 months) | Nightly canaries; selectors shipped as data so a patch release is one file; `ui-changed` errors that say which selector failed |
| Platform ToS action against web-client automation | Medium | Visible bot naming by default; no stealth or anti-detection features, ever; document the gray area plainly |
| WhatsApp or Telegram account bans | Medium | Experimental label; recommend dedicated accounts |
| Recording-consent lawsuits (Otter, Fireflies cases) | Medium, mostly for users | Defaults: name suffix like "(AI)", an optional join announcement, recording off by default |
| Playwright cannot share an app-owned page with audio | Unknown | Prototype the WebRTC loopback in Phase 4 week one; fall back to video-only CDP screencast |
| Headless detection on Meet | Likely | Headed Chromium under Xvfb as the default |
| A competitor (Recall, AgentCall) matches features | High | Compete on self-hosted, MIT, and platform breadth, not on any single feature |

**Open questions**

- [ ] Name: `@vibeconferencing/calls` in repo vibeconferencing-calls (decided 2026-10-29). Drops "api", which reads as a hosted service.
- [ ] License: MIT, or Apache-2.0 for its patent grant?
- [ ] Separate repo at Phase 3, or stay in the monorepo until Phase 5?
- [ ] Support promise: which platforms get a fix-within-days commitment, and which are best effort?
- [ ] Does the camera surface stay a page URL, or do we also accept a raw frame stream for non-browser callers?
- [ ] Is Pipecat-transport-first the right launch story, or an MCP-server-first one for coding agents (where AgentCall is)?
