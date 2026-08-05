#!/usr/bin/env bash
# dev.sh — start a dev build of the app, the way that actually works.
#
# `cd electron-app && pnpm dev` is fine by hand. This exists because four things
# went wrong repeatedly during a day of live testing, and every one of them cost a
# confusing test round rather than failing loudly:
#
#   1. Launched from a Claude Code session, the app inherits CLAUDE_CODE_* markers.
#      The CLI itself says what that does: "Transcript saving is off — inherited
#      CLAUDE_CODE_CHILD_SESSION marker". A dev-only difference that presents as a
#      product bug.
#   2. A worktree has no node_modules. Symlinking electron-app/ is the obvious
#      half; mcp-server/ has its own, and missing it means every spawned agent
#      gets an MCP server that dies on ERR_MODULE_NOT_FOUND, so the bot joins
#      with no tools and falls back to launching the INSTALLED app.
#   3. Restarting during a live call drops the bot and kills its agent mid-
#      conversation. Cheap to check, easy to forget.
#   4. Run in the foreground it blocks the terminal; run with & it dies with the
#      shell. Detached, with a known log path, is what you want.
#
# Usage:
#   scripts/dev.sh                 # start it
#   scripts/dev.sh --force         # start even if a call is live
#   scripts/dev.sh --stop          # stop whatever is running
#   scripts/dev.sh --devtools      # start with DevTools open
#
# Extra args after the flags go to Electron: scripts/dev.sh --profile=bot2
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_CHECKOUT="${VIBECONF_MAIN_CHECKOUT:-$HOME/Developer/vibeconf-app}"
LOG_DIR="${TMPDIR:-/tmp}/vibeconf-dev"
LOG="$LOG_DIR/app.log"
PORT="${VIBECONF_DEV_PORT:-7865}"

FORCE=0; STOP=0; DEVTOOLS=0; PASS=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    --stop) STOP=1 ;;
    --devtools) DEVTOOLS=1 ;;
    *) PASS+=("$a") ;;
  esac
done

running_pid() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }

call_status() {
  local tok="$HOME/.vibeconferencing/local-tokens/$PORT.token"
  [ -f "$tok" ] || { echo unknown; return; }
  curl -sf --max-time 3 -H "Authorization: Bearer $(cat "$tok")" \
    "http://127.0.0.1:$PORT/api/sync/no-room" 2>/dev/null \
    | python3 -c 'import sys,json;print((json.load(sys.stdin).get("status") or {}).get("callStatus") or "idle")' 2>/dev/null \
    || echo unknown
}

stop_app() {
  local pid; pid="$(running_pid)"
  [ -z "$pid" ] && { echo "nothing running on :$PORT"; return; }
  # Kill the process GROUP: Electron spawns helpers, and killing only the main
  # pid leaves them holding the port.
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do [ -z "$(running_pid)" ] && break; sleep 0.5; done
  [ -z "$(running_pid)" ] && echo "stopped" || { echo "still up, forcing"; kill -9 "$pid" 2>/dev/null || true; }
}

if [ "$STOP" = 1 ]; then stop_app; exit 0; fi

# node_modules — both of them. See (2) above.
for d in electron-app mcp-server; do
  if [ ! -e "$ROOT/$d/node_modules" ]; then
    if [ -d "$MAIN_CHECKOUT/$d/node_modules" ] && [ "$ROOT" != "$MAIN_CHECKOUT" ]; then
      ln -s "$MAIN_CHECKOUT/$d/node_modules" "$ROOT/$d/node_modules"
      echo "linked $d/node_modules from the main checkout"
    else
      echo "!! $d/node_modules missing and no main checkout to borrow from — run: pnpm install" >&2
      exit 1
    fi
  fi
done

# Don't drop someone's call without saying so. See (3).
if [ -n "$(running_pid)" ]; then
  STATUS="$(call_status)"
  if [ "$STATUS" = "in-call" ] && [ "$FORCE" != 1 ]; then
    echo "!! a call is LIVE on :$PORT — restarting drops the bot and kills its agent." >&2
    echo "   wait, or re-run with --force" >&2
    exit 2
  fi
  echo "restarting (call status: $STATUS)"
  stop_app
fi

mkdir -p "$LOG_DIR"
[ "$DEVTOOLS" = 1 ] && PASS+=("--devtools=true")

# Scrub the parent Claude session's identity. See (1). A denylist, not a
# CLAUDE_* wildcard: CLAUDE_CONFIG_DIR and friends are legitimate user config.
cd "$ROOT/electron-app"
nohup env \
  -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_BRIDGE_SESSION_ID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH \
  -u CLAUDE_PID -u CLAUDE_EFFORT \
  ./node_modules/.bin/electron . "${PASS[@]:-}" > "$LOG" 2>&1 &
disown

for _ in $(seq 1 30); do [ -n "$(running_pid)" ] && break; sleep 0.5; done
PID="$(running_pid)"
if [ -z "$PID" ]; then
  echo "!! did not come up — last lines of $LOG:" >&2
  tail -5 "$LOG" >&2
  exit 1
fi

echo "running  pid $PID  port $PORT  ($(cd "$ROOT" && git branch --show-current 2>/dev/null || echo '?'))"
echo "log      $LOG"
echo "stop     scripts/dev.sh --stop"
