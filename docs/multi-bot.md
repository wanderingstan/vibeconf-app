# Multi-bot setups

Two bots in one call, on one machine. Or a Claude bot and a Codex bot side by side. This page covers the moving parts.

## The problem

Each Electron app instance:
- Holds a **single-instance lock** (only one app instance per macOS user by default)
- Binds a **local HTTP server on `127.0.0.1:7865`** so the agent's MCP server can talk to it
- Shares one **userData directory** (preferences, login, session logs)
- Auto-installs Claude Code's MCP config pointed at itself on first launch

For a single bot, this is exactly what you want. For two bots, every line above is a collision.

## The solution: profiles + custom ports

Three flags work together:

| Flag | Env var | What it does |
|---|---|---|
| `--profile=<name>` | `VIBECONF_PROFILE` | Bypass single-instance lock. Isolate userData under `~/Library/Application Support/Vibeconferencing/profiles/<name>/`. Skip the Claude MCP install (so this instance doesn't steal the primary bot's config). |
| `--local-port=<n>` | `VIBECONF_LOCAL_PORT` | Pin the local-server's starting port. If busy, still auto-increments. |
| (per-MCP-client) | `VIBECONF_BASE_URL` | Tells the MCP server which local app to talk to. Set this on the agent process, not the app. |

### Common recipe: two bots on one machine

**Machine layout:**

```
Default app instance ──────── 127.0.0.1:7865 ──────── Claude Code (bot A: Samantha)
Profiled app instance ─────── 127.0.0.1:7866 ──────── Claude Code (bot B: Coltrane)
                              or                       or
                                                       Codex CLI (bot C: Codex)
```

**Launch sequence:**

```bash
# 1. Launch the default instance (or use the DMG-installed app from Applications)
cd electron-app
pnpm dev

# 2. In a second terminal, launch a second app instance with its own profile and port
cd electron-app
pnpm dev -- --profile=codex --local-port=7866
```

Both panel windows are now open. The second one shows a yellow `codex` chip in the header so you know which is which.

### Pointing a second MCP client at the second instance

The MCP server reads `VIBECONF_BASE_URL` at spawn to decide which local app it's connected to.

**For Claude Code (second instance):** edit `~/.claude/mcp_settings.json` (or the relevant per-project config) to add a second MCP server entry pointing at port 7866. Or use the [Codex installer template](#codex-cli) as a reference.

**For Codex CLI:** there's a ready-made installer:

```bash
# from repo root
npm run install:codex-mcp -- \
  --base-url=http://127.0.0.1:7866 \
  --bot-name=Codex
```

This writes a `vibeconferencing` MCP entry into `~/.codex/config.toml` pointing at port 7866. Restart Codex CLI so it picks up the new MCP server.

To verify the wiring before joining a real call:

```bash
npm run smoke:codex-mcp -- \
  --base-url=http://127.0.0.1:7866 \
  --bot-name=Codex
```

Expect output including `Codex MCP smoke passed`, `Profile: codex`, and a `get_room_info` response with the right `Local server:` URL.

### Each profile has its own Google login

This is a feature, not a bug. The Codex profile can be signed into a different Google account than the default profile — so the two bots appear in the call as distinct participants with their own identities. Sign in once per profile (Vibeconferencing panel → Sign in with Google).

## What lives where

```
~/Library/Application Support/Vibeconferencing/
├── (default profile state — prefs, session, logs)
├── logs/                            ← session logs for the default instance
└── profiles/
    └── codex/
        ├── (Codex profile prefs, session, login)
        └── logs/                    ← session logs for the codex instance
```

`get_room_info` from each MCP client returns its own `Local server:` URL and `Profile:` value, so you can always confirm which bot you're talking to.

## Codex CLI

Treat Codex as a first-class agent like Claude Code: it loads the MCP server, calls the same tools, and joins the same way. The differences are entirely on the installer side (config file path + format).

See `scripts/install-codex-mcp.mjs` — it's also the template for wiring other MCP clients (Gemini, local model runners) in the future. Adding a new client = a new installer script with the same shape.

A common Codex first prompt for a resident code-reviewer bot:

```
You're joining a call as Codex, the resident code reviewer. Your job is to
take what the group agrees on and implement / review actual code changes.
Join the current Meet via /join-call, then wait for instructions.
```

## Automated test fleet (agent-less)

The recipes above *drive* bots by hand (or by an agent). For **automated regression testing** there's a separate, agent-less path: `scripts/spawn-test-fleet.sh` boots N bots in dedicated, isolated `test-meet-*` / `test-slack-*` profiles on ports `7901+`, and `scripts/meet-test.mjs` runs them through a scripted scenario (join, speak, whiteboard share, chat send/read, listen) — deterministic, zero Claude agents, zero tokens. The bots join the open guest meet `paz-sqoa-npe` (no sign-in needed). Exit code is non-zero on any failed step or stall, so it can gate CI.

```bash
pnpm test:meet:ci       # run from SOURCE (active development)
pnpm test:meet:dmg      # the INSTALLED app — /Applications/Vibeconferencing.app
pnpm test:meet:built    # the freshly-BUILT app — electron-app/dist/mac*/…app
```

Each spawns the fleet, runs the scenario, and tears it down (`spawn-test-fleet.sh N --kill`, which reaps both the port holders and any lingering GUI mains by `--profile`).

**Installed vs built — and why both exist.** `--dmg` and `--built` both exercise the real packaged artifact (asar, `build.files`), catching packaging-only bugs that source runs miss. They differ only in *which copy*:

| Target | Runs | Use when |
|---|---|---|
| `test:meet:dmg` | `/Applications/Vibeconferencing.app` (installed) | testing exactly what users — and the scheduled nightly — run |
| `test:meet:built` | newest `electron-app/dist/mac*/Vibeconferencing.app` | testing a fresh build **without** installing it over `/Applications` |

The trap `--built` avoids: after `pnpm dist:fast`, your new build sits in `dist/` *uninstalled* while `/Applications` still holds the old app — so `test:meet:dmg` tests the stale install and silently "passes," making the fresh build's changes look missing. `test:meet:built` drives the `dist/` bundle directly (launched by explicit path):

```bash
cd electron-app && pnpm dist:fast   # builds dist/…/Vibeconferencing.app (no install)
cd .. && pnpm test:meet:built       # drives that build directly
```

Both resolve paths relative to the checkout they run from (the script is dir-agnostic), so `--built` always finds *that* worktree's latest build.

## Mental model

Think of each profile as a separate **persona** in spirit (your name in Meet, your voice, your Google login, your prefs), even though under the hood "persona" is a future UX concept built on top of these primitives. See issue #207 for where this is headed: a single `--as <persona-name>` launcher that resolves to the right profile + port + MCP install.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Second `pnpm dev` exits immediately | You forgot `--profile=…`. Without it, the single-instance lock kills the new launch. |
| Port already in use | The local-server auto-increments past a busy port, but the MCP client still points at the original. Either kill the conflict or use `--local-port=<free port>` and update the MCP client's `VIBECONF_BASE_URL`. |
| Both bots show the same name in Meet | They're using the same Google account. Sign one profile out and into a different account, or change the `botName` pref in the profiled instance's panel. |
| MCP `get_room_info` returns the wrong port | The MCP server's `VIBECONF_BASE_URL` is stale. Edit the MCP config and restart the agent. |
| Claude Code's MCP config keeps getting rewritten | The default-profile app rewrites it on every launch. Either always run that bot from the same profile, or move the secondary bot to Codex / another MCP-speaking client. |
