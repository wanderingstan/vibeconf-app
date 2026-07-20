# Install

Vibeconferencing is macOS-only (Apple Silicon). Two install paths: a signed DMG (recommended for normal use) or running from source (for faster iteration / testing unreleased changes).

## Requirements

- macOS on Apple Silicon (M1/M2/M3/M4)
- A Google account that can join the Meet calls you want the bot in
- An MCP-speaking agent (Claude Code, Codex CLI, etc.) installed and working
- Chrome, Brave, or Safari for automatic Meet-tab detection. Firefox does not expose the macOS tab automation API, but you can paste a Meet URL into the app manually.

## Install from DMG (recommended)

1. Download `Vibeconferencing-<version>-arm64.dmg` from the [GitHub releases page](https://github.com/wanderingstan/vibeconf-app/releases/latest).
2. Open the DMG and drag **Vibeconferencing** into Applications.
3. Launch it once. macOS may ask you to confirm — the app is signed and notarized by Apple.
4. **Grant macOS permissions** when prompted (or in System Settings → Privacy & Security):
   - **Microphone** — required. Audio pipeline plumbing, even though the bot uses a virtual mic.
   - **Camera** — required. The bot's avatar is a virtual camera.
   - **Screen & System Audio Recording** — required *only if* you want the bot to share its whiteboard window into the call. Without it, the bot can still join, speak, listen, and update the whiteboard — it just can't present the whiteboard onto Meet.
5. Sign in to vibeconferencing.com when the panel prompts — needed for the shared whiteboard. The sign-in opens in your default browser and hands a token back to the app.

The first launch will auto-install the Claude Code integration (writes `~/.claude/skills/join-call/`). Restart Claude Code afterward so it picks up the new MCP tools and slash command.

## Install from source

For dev work or running unreleased main. See [RUNNING-FROM-SOURCE.md](../RUNNING-FROM-SOURCE.md) for the full walkthrough — the short version:

```bash
git clone https://github.com/wanderingstan/vibeconf-app.git
cd vibeconf-app
pnpm install              # web companion deps (optional unless running the website locally)
cd electron-app
pnpm install              # Electron app deps
pnpm dev                  # launches the app pointed at your checkout
```

Source-build caveats:
- Not signed / not notarized — macOS may require right-click → Open the first time.
- Permissions are scoped to the *dev binary path*, not `/Applications/Vibeconferencing.app`. A fresh checkout means re-granting Mic/Camera/Screen Recording.
- **Don't run the signed DMG app and `pnpm dev` simultaneously** — both bind to `127.0.0.1:7865` by default. Use `--profile=<name> --local-port=<n>` to coexist (see [Multi-bot setups](multi-bot.md)).

## Verifying the install

After launch:
- The panel window should show the version (and "profile" chip if you launched with `--profile=…`).
- `curl http://127.0.0.1:7865/api/sync/no-room` should return JSON with `localServerUrl: http://127.0.0.1:7865`.
- In Claude Code, the `/join-call` slash command should be available. If not, fully restart Claude Code.

## Troubleshooting install

| Symptom | Fix |
|---|---|
| App launches and immediately quits | An older instance is already running (single-instance lock). Quit it via Cmd-Q on the panel window, then re-launch. |
| "Electron failed to install correctly" running from source | pnpm's strict mode skipped the binary download. Run `node node_modules/.pnpm/electron@*/node_modules/electron/install.js` from `electron-app/`. |
| `/join-call` missing in Claude Code after first launch | Fully restart Claude Code — MCP servers are loaded at startup. |
| Sign-in just lands on vibeconferencing.com home instead of returning to the app | Make sure you're running v0.6.1+; earlier builds had a broken OAuth handoff for fresh installs. |
| Bot's whiteboard window is blank for unauthed viewers | Whiteboard read should work without sign-in, but if not, sign in to vibeconferencing.com first. |

## Next

- New to the app → **[Quickstart](quickstart.md)** for your first call.
- Already comfortable → **[Multi-bot setups](multi-bot.md)** for running two bots at once.
