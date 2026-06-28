# Testing

How to test the app. There are four layers, fastest → heaviest:

1. **Unit** — pure functions, no app, milliseconds.
2. **Replay / tuning** — headless, deterministic, driven by a recorded call.
3. **End-to-end** — real GUI app instances driven over HTTP (no Claude agent).
4. **Real-agent** — real Claude agents driving the bots *(planned — see bottom).*

The end-to-end layer is **agent-less by design**: a harness (`scripts/meet-test-lib.mjs`) drives each bot through its local HTTP server — the same surface the MCP tools wrap — so tests are deterministic, fast, and free. The Electron app still does all the real work (join, captions, TTS, screen-share, scraping); only the non-deterministic "brain" is replaced.

---

## 1. Unit tests — `pnpm test:unit`

`node:test` over the pure, deterministic logic (URL/room-code parsing, slug validation, huddle-title matching). No fleet, no network, instant. Run these constantly.

```bash
pnpm test:unit          # node --test "tests/*.test.mjs"
```

---

## 2. Replay / tuning — `pnpm replay*`

Replay a **recorded** conversation through a real `LocalServer` headlessly (no Electron/Meet/audio), to tune the conversation-loop knobs deterministically.

| Command | What it does |
|---|---|
| `pnpm replay:extract <session-log> --out fix.json` | Turn a call's `[caption-raw]` log lines into a replay fixture. (`--find` lists logs that have them. Needs `logRawCaptions` pref ON during the call.) |
| `pnpm replay <fixture.json> [--backgroundTickWords N] [--silence S] [--probeFiring]` | Replay a fixture; prints when `background_tick` / probes fire and when the bot would take the floor. |
| `pnpm replay:sweep <fixture.json> --silence 0.8,1.0,1.4,2.0` | **Auto-tune** (#271): run the replay across a knob's range and tabulate the outcome (e.g. `floorGrabs` per silence value → find the natural-pause knee). Real-time, so use a short fixture. |

A sample fixture (a real 90s slice) lives at `tests/fixtures/`.

---

## 3. End-to-end — spawn real bots, drive over HTTP

These spawn isolated, dedicated **profile** instances (`test-meet-guest-*` / `test-meet-google-*` / `test-slack-*`) so runs never touch your real Jimmy/Samantha. The `:ci` variants spawn → run → reap automatically (exit code gates). See **[testing-profiles.md](testing-profiles.md)** for the profile/account/port map and fresh-machine setup.

### The main suites

| Command | What it does |
|---|---|
| `pnpm test:e2e` | **Provider-parity matrix** — the *same* scenario (speak, chat round-trip, listen, screen-share) run against each `CallProvider`, in `node:test` with fleet spawn/kill hooks. Meet runs by default; Slack runs if `VIBECONF_SLACK_TEST_URL` is set. The test that catches "works on Meet, broken on Slack." |
| `pnpm test:meet:ci` | Meet scenario suite (Jimmy + Samantha): join, speak, chat, listen, whiteboard, share. Spawn → run → reap. |
| `pnpm test:slack:ci` | Same against a Slack huddle. (Channel via `SLACK_TEST_URL`; defaults to `#testing`.) |
| `pnpm test:meet:dmg` / `pnpm test:meet:built` | Meet suite against the **packaged** app (installed `/Applications` DMG, or the freshly-built `dist/`) — catches asar/build issues. |
| `pnpm test:meet` / `pnpm test:slack` | The drivers alone, assuming a fleet is already up (see *Fleet management*). Pass `--bots Jimmy:7901,Samantha:7902`. |

### Focused checks

| Command | What it does | Notes |
|---|---|---|
| `pnpm test:detect` | Open a Meet URL in Chrome, assert the app's tab-scan detection catches it. | Needs browser **Automation** permission. |
| `pnpm test:screenshot[:ci]` | Capture `get_call_screenshot` and validate a real PNG comes back. | Building block for share-verify. |
| `pnpm test:share-verify[:ci]` | **Ground-truth share check**: bot A puts a nonce on the whiteboard + shares it; bot B (the viewer) screenshots; Claude **reads the screenshot** and asserts the nonce is visible — proving pixels crossed the wire, not just that the button was clicked. | Uses the `claude` CLI (your subscription, no API key). Falls back to `ANTHROPIC_API_KEY`, else captures + prints the path for a manual eyeball. |

### Fleet management

| Command | What it does |
|---|---|
| `scripts/spawn-test-fleet.sh 2` | Boot 2 Meet bots (Jimmy, Samantha) from source. `3`/`4` adds Cosmo/Dizzy. |
| `scripts/spawn-test-fleet.sh 2 --slack --slack-url=…` | Boot 2 Slack bots (auto-join the huddle). |
| `scripts/spawn-test-fleet.sh 2 [--slack] --kill` | Graceful-leave + reap a previously-spawned fleet. |
| `scripts/spawn-test-fleet.sh 2 --dmg` / `--built` | Boot from the packaged app instead of source. |

Then drive with `pnpm test:meet --bots Jimmy:7901,Samantha:7902` (or the printed hint).

---

## Prerequisites

- **Meet tests:** none — the default test meet (`paz-sqoa-npe`) is open to guests, so logged-out profiles join unattended.
- **Slack tests:** Slack has no guest path, so each `test-slack-N` profile must be **signed into a Slack account once** (`scripts/setup-test-profiles.sh --slack`; persists). After that, `test:slack:ci` runs unattended. Both accounts must be in the test workspace/channel.
- **Detection test:** macOS **Automation** permission for the app to read browser tabs.
- **Share-verify vision:** the `claude` CLI on `PATH` and logged in (uses your subscription) — or `ANTHROPIC_API_KEY` for the API fallback. Without either it captures the screenshot for a manual look.
- **Replay tuning:** a fixture (`replay:extract` from a real call log; needs `logRawCaptions` ON during that call).

---

## 4. Real-agent fuzzing — *planned (#267)*

> **Not built yet — placeholder.**

The layers above replace the agent with a deterministic harness. The missing layer drives the bots with **real Claude agents** — the only test of the full stack (skill + MCP + the agent's judgment: when to ack, speak, yield). Because it's non-deterministic, it's a *fuzzing* test, graded by an **LLM judge**.

Planned shape:
- A `scripts/spawn-test-fleet.sh --with-agents` mode that launches the real Claude terminal + MCP per bot (today profiles deliberately skip the Claude launch), each with a "mission" prompt to exercise features.
- After the run, feed the transcript + session log to Claude: *"did both bots join, exercise {share, chat, whiteboard}, behave per mode, and leave cleanly — any loops/errors?"* → pass/fail.

Tracked in **#267**. This run also doubles as a live re-test of the conversation-loop behavior (barge-in, background-tick, scribe mode).
