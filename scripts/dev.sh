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
#      conversation. Cheap to check, easy to forget. Guards BOTH start and
#      --stop, and asks call-phase.js what counts as busy rather than keeping a
#      second opinion here.
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

call_room() {
  local tok="$HOME/.vibeconferencing/local-tokens/$PORT.token"
  [ -f "$tok" ] || { echo ''; return; }
  curl -sf --max-time 3 -H "Authorization: Bearer $(cat "$tok")" \
    "http://127.0.0.1:$PORT/api/sync/no-room" 2>/dev/null \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("roomId") or (d.get("status") or {}).get("roomId") or "")' 2>/dev/null \
    || echo ''
}

# "Is it rude to kill the app right now?" — asked of the APP's own definition
# rather than a copy of it. call-phase.js isBusy() covers navigating, joining,
# waiting-to-be-admitted, in-call AND after-call-work. This script first shipped
# with its own guess ("in-call"), which missed a bot mid-join and, worse, an
# agent still doing its after-call wrap-up: killing there silently loses the
# summary or notes it was writing.
BUSY_FALLBACK="navigating joining waiting-to-be-admitted in-call after-call-work"
is_busy() {
  local st="$1" out
  out="$(node -e 'console.log(require(process.argv[1]).isBusy(process.argv[2]) ? "busy" : "free")' \
        "$ROOT/electron-app/call-phase.js" "$st" 2>/dev/null || true)"
  [ "$out" = busy ] && return 0
  [ "$out" = free ] && return 1
  # No node, or the module moved: fall back to a copy of the same list rather
  # than failing open, which is how this whole class of bug started.
  case " $BUSY_FALLBACK " in *" $st "*) return 0 ;; esac
  return 1
}

# Refuse to pull the rug out from under a live bot. Used by BOTH --stop and the
# restart path: --stop skipped this check for its first few weeks, which is the
# one hole left after the restart guard went in, and it is the command actually
# reached for most often.
guard_busy() {
  local what="$1" st room
  st="$(call_status)"
  if [ "$FORCE" != 1 ] && is_busy "$st"; then
    room="$(call_room)"
    echo "!! :$PORT is '$st'${room:+ in $room} — $what would drop the bot and kill its agent." >&2
    [ "$st" = after-call-work ] && \
      echo "   (after-call-work: the agent is still writing its wrap-up. It usually ends in seconds.)" >&2
    echo "   wait, or re-run with --force" >&2
    exit 2
  fi
  echo "$st"
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

if [ "$STOP" = 1 ]; then
  [ -n "$(running_pid)" ] && guard_busy "stopping" >/dev/null
  stop_app; exit 0
fi

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
  STATUS="$(guard_busy 'restarting')"
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
