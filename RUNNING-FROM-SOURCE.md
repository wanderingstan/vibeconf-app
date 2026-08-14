# Running Vibeconferencing from source

For faster iteration than waiting for a new DMG release. You'll get whatever's on `main` right now and can pull updates with `git pull` + restart.

## One-time setup

```bash
# Clone the repo
git clone git@github.com:wanderingstan/vibeconf-app.git
cd vibeconferencing

# Install webapp deps (only needed if you want to run the Vite preview)
pnpm install

# Install Electron app deps
cd electron-app
pnpm install

# Install MCP server deps (required — /join-call tools can't load without them)
cd ../mcp-server
pnpm install
```

### If `pnpm dev` errors with "Electron failed to install correctly"

pnpm v10 blocks dependency postinstall scripts by default, which can skip Electron's binary download. `electron-app/package.json` allows it via `pnpm.onlyBuiltDependencies: ["electron"]`, so a normal `pnpm install` should build the binary automatically.

If you still hit the error (older pnpm, or the binary didn't land), run the download once by hand:

```bash
# from electron-app/
node node_modules/.pnpm/electron@*/node_modules/electron/install.js
```

You should see `dist/` and `path.txt` appear next to `install.js` after it completes.

### ffmpeg: bundled for users, but a real requirement from source

The packaged app ships its own ffmpeg (`ffmpeg-static`, unpacked beside the asar),
so someone installing the DMG or the `.deb` never has to think about it.

From source it is a different story, because ffmpeg-static fetches its binary in a
postinstall step. Anything that skips or blocks that step leaves you with no ffmpeg
at all: `pnpm install --ignore-scripts`, pnpm's postinstall blocking, or a machine
that cannot reach GitHub's release CDN (observed on a locked-down cloud box, where
the same restriction also blocks Electron's own download above).

Two things then go quiet rather than loud:

- Call recordings never merge, since `call-media-merge.js` needs ffmpeg to mux the
  video and audio tracks together.
- **16 tests silently SKIP** rather than fail, and they are the whole
  `call-media-merge` suite. A run that reports "0 failures" while sitting out its
  most-changed module is not the reassurance it looks like.

So on Linux, install it from the distro and stop depending on the download:

```bash
sudo apt-get install -y ffmpeg
```

`resolveFfmpegPath` looks for the bundled binary first, then PATH, then a couple of
known install locations, so a system ffmpeg satisfies both the app and the tests.
To check a machine is actually covered, run the suite and look at the SKIP count,
not just the failure count:

```bash
node --test tests/*.test.mjs 2>&1 | grep -E '^# (pass|fail|skipped)'
```

One skip is expected (the PATH-lookup-fails fallback case). Seventeen means no
ffmpeg.

## Running

```bash
# from electron-app/
pnpm dev
```

This launches the app pointed at the source files in your checkout. No packaging step. Changes to `main.js`, `local-server.js`, `preload-meet.js`, etc. take effect on next restart of the app.

The MCP server is pulled from `../mcp-server/` (same checkout), so it stays in sync with the Electron app's expectations automatically. If its deps are missing the app logs a warning and leaves your existing Claude MCP config untouched — run `pnpm install` in `mcp-server/` (see setup above).

### Running multiple local app instances

The app's local agent API starts at `http://127.0.0.1:7865` by default. If that port is already busy, the app automatically tries the next port and writes the resolved `VIBECONF_BASE_URL` into Claude's MCP config.

For an explicit second local app instance, use a separate app profile and pin a different starting port:

```bash
# from electron-app/
pnpm dev -- --profile=codex --local-port=7866

# or
VIBECONF_PROFILE=codex VIBECONF_LOCAL_PORT=7866 pnpm dev
```

Call `get_room_info` to confirm the resolved `Local server:` URL and `Profile:` value. Non-Claude MCP clients, including Codex, should point their `VIBECONF_BASE_URL` at that URL so each agent controls the intended app instance.

Profiled app instances store data under their own user-data directory and skip the automatic Claude MCP integration write, so they do not repoint Claude Code away from the primary app instance.

### Codex MCP setup

The default app instance installs Codex MCP config automatically when **Agent backend** is set to **OpenAI Codex**. Restart Codex after changing that setting so it reloads `~/.codex/config.toml`.

For a profiled Codex app instance or custom port, install the Codex MCP config from the repo root:

```bash
npm run install:codex-mcp -- --base-url=http://127.0.0.1:7866 --bot-name=Codex
```

Use the `Local server:` value from `get_room_info` as `--base-url`. The app and installer write `~/.codex/config.toml` with a `vibeconferencing` MCP server entry pointing at this checkout's `mcp-server/server.js`, then Codex must be restarted to load the tool server.

For a no-write preview:

```bash
npm run install:codex-mcp -- --base-url=http://127.0.0.1:7866 --bot-name=Codex --dry-run
```

To prove the same stdio MCP path Codex will load can reach the intended app instance:

```bash
npm run smoke:codex-mcp -- --base-url=http://127.0.0.1:7866 --bot-name=Codex
```

Expected output includes `Codex MCP smoke passed`, the app `Profile: codex`, the tool count, and the `get_room_info` response with the same `Local server:` URL. If this fails, restart the profiled app instance first; if it passes but Codex cannot see the tools, restart Codex so it reloads `~/.codex/config.toml`.

Suggested first prompt for a resident code-review Codex session:

```text
You are the Vibeconferencing resident engineering participant. Stay quiet unless addressed or you have a concrete code finding. Use the vibeconferencing MCP tools to observe the call, but do implementation work in the repo. Draft PRs only, no force-push, no merge, and scan for secrets/transcripts/internal notes before pushing.
```

## Updating to latest

```bash
# from repo root
git pull origin main

# from electron-app/ — only needed if package.json changed
pnpm install

# Restart the app
```

If `pnpm install` updates Electron itself, you may need to redo the binary install above.

## Caveats vs. the signed DMG

- **No code signing / notarization.** macOS will treat this like any other unsigned app. You may need to right-click → Open the first time, or grant permissions in System Settings.
- **Permissions are scoped to the dev binary path**, not `/Applications/Vibeconferencing.app`. So a fresh source checkout means re-granting Browser Automation, etc. (System Settings → Privacy & Security).
- **MCP integration** with Claude Code points at `~/.claude/skills/join-call/`. The app's `ensureClaudeIntegration()` writes the skill files on first launch — make sure those paths reference your checkout's `mcp-server/server.js`, not a stale install.
- **Running the signed DMG and `pnpm dev` simultaneously is advanced.** The second app instance will move to the next available local port, but an MCP client only controls the instance named by its `VIBECONF_BASE_URL`.

## Reporting bugs from a source build

When filing an issue, include:
- `git log --oneline -1` from your checkout (the exact commit you're running)
- The session log path from `get_room_info` → it'll be under `~/Library/Application Support/Vibeconferencing/logs/`
