# POC: share the browser tab Claude is browsing

**Goal:** the bot presents, live, the *exact* Chrome tab the agent is driving via the
claude-in-chrome extension — "let me pull that up and show you." Because the **same agent**
holds both toolsets (it drives the tab *and* the bot), it already knows the tab's URL; that URL
is the join key. This branch (`feat/share-agent-tab`) is a working sketch of the whole path.

## The flow

```
claude-in-chrome: agent knows the URL it navigated to
        │  share_tab({ url })                         (MCP tool → mcp-server/server.js)
        ▼
POST /api/sync  meta:{ action:"share-tab", url }       (local-server dispatch)
        ▼
onShareTab(url) → startExternalTabShare(url)           (electron-app/main.js)
        │  1. AppleScript: find the Chrome tab whose URL matches, make it the ACTIVE tab
        │  2. desktopCapturer.getSources({window}) → match the window by the tab's title
        │  3. stash it in externalShareRequest, trigger Meet "Present now"
        ▼
setDisplayMediaRequestHandler → callback({ video: externalShareRequest.source })
        ▼
Meet shares that window, live — participants watch the page update as the agent browses.
```

Nothing new touches Google: it reuses the exact screen-share capture path the whiteboard
share already uses. The only new capability is *resolving a specific external tab to a
desktopCapturer source*, which is `electron-app/share-external-tab.js`.

## Why it works (the two key facts)

1. **AppleScript can make a specific tab active** in its window (`set active tab index`). We do
   *not* need to raise or focus the window — macOS ScreenCaptureKit captures a window even when
   occluded. We only need the target tab to be the visible one in its window (a window shows one
   tab at a time).
2. **A Chrome window's OS title == its active tab's page title**, which is exactly what
   `desktopCapturer.getSources({types:['window']})` returns as a source `name`. So once the tab
   is active, we match the window source by that title and hand it to `getDisplayMedia`.

## What's in this branch

| File | What |
|------|------|
| `electron-app/share-external-tab.js` | **New.** The core logic: `buildActivateTabScript`/`activateChromeTabByUrl` (AppleScript), `pickWindowSource` (source matcher, mirrors the whiteboard-share strategy + infinity-mirror exclusion), `resolveTabShareSource` (orchestrates), `listBrowserWindows`. |
| `tests/share-external-tab.test.mjs` | **New.** Unit tests for the pure pieces (escaping, script shape, matcher). `node --test` → 7/7. |
| `electron-app/main.js` | `externalShareRequest` state; a branch in `setDisplayMediaRequestHandler` that returns it; `startExternalTabShare()`; `onShareTab` wired into the local-server callbacks; `share-external-tab` IPC; cleared on stop/leave/whiteboard-switch. All marked `// POC`. |
| `electron-app/local-server.js` | `onShareTab` constructor arg + the `share-tab` `/api/sync` action dispatch. |
| `mcp-server/server.js` | **New tool `share_tab({ url, app_name? })`** — POSTs the `share-tab` action and polls `sharing` like `start_share`. |

## Try it (once wired to a running app)

1. In a call, have the agent open a page with the Chrome tools (or just have a Chrome tab open).
2. Call `share_tab({ url: "<that tab's URL>" })`.
3. The tab becomes active in its window and appears in the Meet as a live screen share.
4. Navigate the tab (via the Chrome tools) — the room sees it update in real time.
5. `stop_sharing` (or `start_share` for the whiteboard) clears it.

Manual smoke test of just the resolver, outside the app:
```bash
node -e "const m=require('./electron-app/share-external-tab.js'); m.activateChromeTabByUrl('github.com').then(console.log)"
# → { ok: true, title: '<the tab title>' }  if a Chrome tab matching 'github.com' is open
```

## Known limitations (by design — document, don't fight)

- **Window, not tab.** A window shows its active tab. If the user later switches tabs in that
  window, the share follows. Mitigation: claude-in-chrome opens its work in its **own window/tab
  group**, so the agent's tab is usually already isolated — stable title, single tab.
- **Fullscreen hides the omnibox / changes titles** — not an issue here (we match by title, not
  the address bar, and don't need the window foregrounded), but titles are dynamic, so we read
  the title immediately after activating and match right away.
- **Title collisions.** Two windows with the same active-tab title → we take the first after
  excluding our own windows. Hardening: prefer the desktopCapturer source **id**
  (`window:<CGWindowID>`) once correlated, over the title.
- **No tab audio.** Window video capture is visual-only; the tab's audio (a playing video) needs
  separate system-audio capture (a harder, separate problem). Fine for "show me the page."
- **macOS only.** Tab activation is AppleScript. Windows: swap step 1 for UI-Automation tab
  activation (see the Windows Meet-detection work); everything downstream is cross-platform.

## TODO to productionize (beyond this sketch)

- Reuse the whiteboard share's **Present-now retry loop** (generation token) instead of the
  single `triggerScreenShare` — a slow Meet join currently drops the trigger.
- Optional **`list_windows`** tool + a picker, for "share a window" without a URL.
- Correlate desktopCapturer **source id** to the AppleScript window for collision-proof matching.
- Windows path (UIA tab activation).
- Consent affordance: sharing a tab broadcasts whatever it shows — confirm in the UX.
