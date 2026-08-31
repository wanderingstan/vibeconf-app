#!/usr/bin/env bash
# use-worktree-mcp.sh — point Claude Code's vibeconferencing MCP server at THIS
# checkout instead of the installed app.
#
# Why this exists: the app deliberately does NOT repoint the durable MCP config
# when it is running from a git worktree ("keeping existing MCP server path …
# instead of repointing durable config at …"), which is right — a worktree
# should not hijack the machine's real config on launch. The consequence is that
# an MCP tool ADDED in a worktree is invisible to every agent until you do this
# by hand.
#
# That cost a live debugging round: a new tool was registered, whitelisted and
# working, and the agent still reported "there is genuinely no working bridge",
# because it was talking to the installed app's server.js, which had never heard
# of it.
#
# Usage:
#   scripts/use-worktree-mcp.sh            # point at this checkout
#   scripts/use-worktree-mcp.sh --revert   # point back at the installed app
#   scripts/use-worktree-mcp.sh --status   # show where it points now
#
# Restart any Claude Code session afterwards: MCP tool lists are read once, at
# connection time, so a running session keeps the old set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$ROOT/mcp-server/server.js"
INSTALLED="/Applications/Vibeconferencing.app/Contents/Resources/mcp-server/server.js"
CFG="$HOME/.claude.json"

MODE="use"
case "${1:-}" in
  --revert) MODE="revert" ;;
  --status) MODE="status" ;;
  "") ;;
  *) echo "unknown flag: $1" >&2; exit 2 ;;
esac

[ -f "$CFG" ] || { echo "no $CFG" >&2; exit 1; }

if [ "$MODE" = "use" ] && [ ! -f "$SERVER" ]; then
  echo "no server.js at $SERVER" >&2; exit 1
fi

TARGET="$SERVER"; [ "$MODE" = "revert" ] && TARGET="$INSTALLED"

MODE="$MODE" TARGET="$TARGET" CFG="$CFG" ROOT="$ROOT" python3 - <<'PY'
import json, os, shutil, sys, time

cfg, mode, target = os.environ['CFG'], os.environ['MODE'], os.environ['TARGET']
d = json.load(open(cfg))
try:
    entry = d['mcpServers']['vibeconferencing']
except KeyError:
    sys.exit('no mcpServers.vibeconferencing in ~/.claude.json')

current = entry['args'][0]
if mode == 'status':
    where = 'THIS WORKTREE' if '/worktrees/' in current else 'installed app'
    print(f'points at: {current}\n           ({where})')
    has = 'brief' if os.path.exists(current) and '"brief",' in open(current).read() else 'no brief'
    print(f'           [{has}]')
    sys.exit(0)

if current == target:
    print(f'already pointing at:\n  {target}')
    sys.exit(0)

backup = f'{cfg}.bak-{time.strftime("%Y%m%d-%H%M%S")}'
shutil.copy2(cfg, backup)

entry['args'][0] = target
tmp = cfg + '.tmp'
with open(tmp, 'w') as f:
    json.dump(d, f, indent=2)
os.replace(tmp, cfg)

print(f'was: {current}')
print(f'now: {target}')
print(f'backup: {backup}')
print('\nRestart any Claude Code session to pick up the new tool list.')
PY
