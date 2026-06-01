# Running a Codex bot in a call

End-to-end setup for using OpenAI's Codex CLI as a Vibeconferencing bot. Takes ~5 minutes if you already have the app installed.

For the bigger picture (multiple bots side by side, profiles, ports), see [multi-bot setups](multi-bot.md). This page is just the linear "get Codex working" path.

## Prereqs

- The Vibeconferencing macOS app installed and working with at least one Meet call. If you haven't done that yet, start with [Quickstart](quickstart.md).
- Codex CLI installed and you can run a chat session in it.
- The Vibeconferencing source checkout at `~/Developer/vibeconferencing/` (or wherever you cloned it). The installer needs the path.

## Setup

### 1. Install the MCP config for Codex

From the **repo root** (not from `electron-app/`):

```bash
cd ~/Developer/vibeconferencing
npm run install:codex-mcp -- \
  --base-url=http://127.0.0.1:7866 \
  --bot-name=Codex
```

This writes a `[mcp_servers.vibeconferencing]` block to `~/.codex/config.toml` (backing up any existing config to a timestamped `.bak` next to it) pointing Codex at port **7866** — a separate Electron app instance from your default one on 7865.

> **Why a different port?** Codex gets its own profiled Electron app instance so it has its own Google login, prefs, and identity in Meet. Your default app keeps serving Claude (or whatever else) on 7865 without conflict.

To preview what the installer will write without actually writing, add `--dry-run`.

### 2. Launch the Codex-profile app instance

```bash
cd ~/Developer/vibeconferencing/electron-app
pnpm dev -- --profile=codex --local-port=7866
```

You should see:
- A second Vibeconferencing panel window open
- A yellow `codex` chip next to the version in the header (confirms it's the right profile)
- The default-profile app continues running unaffected

> Permissions are per-binary-path, so you may need to re-grant Microphone and Camera the first time. Sign in to vibeconferencing.com from this new panel window using whichever Google account you want the Codex bot to appear as in Meet.

### 3. Verify the wire (optional but recommended)

```bash
cd ~/Developer/vibeconferencing
npm run smoke:codex-mcp -- \
  --base-url=http://127.0.0.1:7866 \
  --bot-name=Codex
```

Expected: `Codex MCP smoke passed`, `Profile: codex`, and a successful `get_room_info` response. If this fails, the most common cause is the profiled app not running — go back to step 2.

### 4. Restart Codex

MCP servers load at startup, so Codex won't see the new `vibeconferencing` server until you restart it. Quit and re-launch Codex.

### 5. Confirm Codex sees the tools

In your Codex session, ask:

> List the MCP tools you have access to.

You should see entries like `join_call`, `wait_for_speech`, `speak`, `get_room_info`, `update_whiteboard`, `read_chat`, `send_chat`, `set_avatar_emoji`, and a dozen others all prefixed with the `vibeconferencing` server name.

If you don't see them: Codex didn't load the MCP server. Check `~/.codex/config.toml` has the `[mcp_servers.vibeconferencing]` block, and that you restarted Codex *after* running the installer.

## Joining a call

Codex doesn't have a `/join-call` slash command — that's a Claude Code-specific skill. Instead, just **ask in natural language**:

> Join the Google Meet I have open in Chrome.

or, if you want to be explicit:

> Use `get_room_info` to find the active Meet, then `join_call` as "Codex".

What should happen:

1. Codex calls `get_room_info` (or `join_call` directly with the Meet code).
2. The Vibeconferencing window navigates to your Meet and clicks through pre-join.
3. You click **Admit** in your own Meet window.
4. Codex receives a response that includes the conversation contract — explicitly telling it to enter a `wait_for_speech` loop and not send a final response while the call is active.
5. Codex starts calling `wait_for_speech` repeatedly. Each time you finish speaking, it returns a transcript, Codex responds via `speak`, and the loop continues.

## "Codex joined but isn't responding"

This was the most common failure mode early on. Open the troubleshooting screen in the codex panel and check the **Agent loop** line:

| What you see | What it means |
|---|---|
| `🟢 listening (1 waiter)` | Codex is in the loop, waiting for you to speak. All good. |
| `🟡 between waits (Xs)` | Codex just received a transcript and is processing / about to speak. Normal. |
| `🔴 stale 2m ago — agent likely stopped the wait_for_speech loop` | Codex fell out of the loop. Tell it: *"Continue the wait_for_speech loop until I ask you to leave."* |
| `⚪ no wait_for_speech yet — agent may not have started the loop` | Codex joined but never started listening. Same fix as above. |

The bot's avatar emoji also reflects state — see [modes-and-states.md](modes-and-states.md) for the full mapping.

## Leaving a call

Ask Codex to leave:

> Leave the call.

It should call `leave_call`. The bot's identity unlocks once the call ends, so a subsequent `join_call` can use a different name if you want.

If Codex just stops responding instead of cleanly leaving, you can also click the End Call button in the panel's troubleshooting screen.

## Per-Codex-session customization

A few common Codex setup tweaks:

- **Different Codex bot name**: rerun the installer with `--bot-name=YourName`. This sets `VIBECONF_BOT_NAME` in the MCP env. (If your codex-profile is also signed into a Google account, Meet will show the account name — see [multi-bot.md](multi-bot.md) on persona vs profile vs session.)
- **Different port**: rerun with `--base-url=http://127.0.0.1:NNNN` and launch the app with the matching `--local-port=NNNN`.
- **Add Codex skill / first-prompt instructions**: Codex's marketplace / plugin system can hold instructions. A common pattern is a Codex session starting with: *"You're joining a Meet call as a code-reviewer bot. When asked, use `join_call` and immediately start the `wait_for_speech` loop."*

## Troubleshooting checklist

| Symptom | Fix |
|---|---|
| `npm error Missing script: "smoke:codex-mcp"` | You're in `electron-app/`. Run from repo root. |
| "Connection refused" in smoke test | Codex-profile app isn't running. Launch with `pnpm dev -- --profile=codex --local-port=7866`. |
| Codex says no MCP tools available | Restart Codex (it loads MCP servers at startup). |
| Bot joins but doesn't respond | See "Codex joined but isn't responding" above. Most often: Codex didn't enter the loop. |
| Two bots show the same name in Meet | Both profiles signed into the same Google account. Sign one into a different account, or change the `botName` pref. |
| Codex MCP config keeps getting rewritten | The default-profile app (port 7865) auto-installs Claude integration — it doesn't touch `~/.codex/config.toml`. If your config gets rewritten, something else is doing it (some other tool); rerun the installer. |
