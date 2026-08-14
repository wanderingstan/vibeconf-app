#!/bin/bash
# linux-agent-terminal-check.sh — runs ON the Linux box. Proves the thing CI
# cannot: that the real app, on real Linux, spawns a real agent terminal.
#
# WHY THIS AND NOT THE UNIT SUITE: since #363 the unit tests run on
# ubuntu-latest for every PR, so a nightly copy of them would tell us nothing new
# a day later. What no GitHub runner can do is start Electron under Xvfb, join a
# call, and check that an agent process actually came up in a terminal. That is
# the #329 path, and it is the path the cloud-TA box (#324) depends on.
#
# Exits 0 on pass, non-zero on the first failed assertion. Prints one FAIL line
# per problem so the digest has something to quote.
#
#   linux-agent-terminal-check.sh [--tmux]   # --tmux opts into the tmux shape
set -uo pipefail

MODE="${1:-}"
PROFILE="nightly-linux"
SRC="$HOME/vibeconf-app"
ELECTRON="$HOME/electron-dist/electron"
ACFG="$HOME/.config/Vibeconferencing/config.json"
PORT=7865
BASE="http://127.0.0.1:$PORT"
export DISPLAY="${DISPLAY:-:99}"

fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
ok()   { echo "ok: $*"; }

cleanup() {
  pkill -f "electron-dist/electron" 2>/dev/null
  pkill -f "xterm -e" 2>/dev/null
  tmux kill-server 2>/dev/null
  true
}
trap cleanup EXIT

# --- preconditions, each reported rather than assumed ---
[ -x "$ELECTRON" ] || { echo "FAIL: no electron runtime at $ELECTRON"; exit 3; }
[ -d "$SRC/electron-app/node_modules/electron-store" ] || { echo "FAIL: deps not installed"; exit 3; }
command -v tmux  >/dev/null || echo "note: tmux absent — the tmux shape cannot be exercised"
command -v xterm >/dev/null || echo "note: xterm absent — the direct shape cannot be exercised"

pgrep -f "Xvfb $DISPLAY" >/dev/null || { nohup Xvfb "$DISPLAY" -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 & sleep 3; }
pgrep -f "Xvfb $DISPLAY" >/dev/null || { echo "FAIL: Xvfb would not start"; exit 3; }

cleanup; sleep 1

# The tmux wrapper is a preference (#329), default off. Exercise whichever shape
# was asked for, so a regression in either is caught.
if [ "$MODE" = "--tmux" ]; then
  node -e 'const f=process.argv[1],fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};c.linuxAgentTmux=true;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$ACFG"
  WANT_PLAN="tmux"
else
  node -e 'const f=process.argv[1],fs=require("fs");let c={};try{c=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};delete c.linuxAgentTmux;fs.writeFileSync(f,JSON.stringify(c,null,2))' "$ACFG"
  WANT_PLAN="direct"
fi
echo "=== shape under test: $WANT_PLAN ==="

rm -f /tmp/nightly-linux.log
VIBECONF_REQUIRE_TOKEN=0 nohup "$ELECTRON" "$SRC/electron-app" --no-sandbox \
  --profile="$PROFILE" >/tmp/nightly-linux.log 2>&1 &
sleep 14

pgrep -f "electron-dist/electron" >/dev/null || { echo "FAIL: app did not start"; tail -20 /tmp/nightly-linux.log; exit 4; }
ok "app started"

# afterCallWorkSeconds=0 through the app's OWN preferences API. A hand-edited
# config.json is NOT picked up by the running store (learned the hard way), and
# at the 300s default a leave deliberately does not tear down, which would read
# as an orphaned agent.
curl -s -m 15 -X POST "$BASE/api/preferences" -H 'Content-Type: application/json' \
  -d '{"key":"afterCallWorkSeconds","value":0}' -o /tmp/pref.json
grep -q '"success":true' /tmp/pref.json || fail "could not set afterCallWorkSeconds (digest teardown check will be unreliable)"

# spawnAgent:true — the sync join path deliberately does NOT spawn an agent
# (it assumes an agent is already driving), so /api/call/start is the route that
# exercises launchClaudeTerminal.
curl -s -m 60 -X POST "$BASE/api/call/start" -H 'Content-Type: application/json' \
  -d '{"spawnAgent":true,"openBrowser":false}' -o /tmp/start.json
ROOM=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("/tmp/start.json","utf8")).roomId||"")}catch{console.log("")}')
[ -n "$ROOM" ] || { fail "call/start returned no room: $(cat /tmp/start.json 2>/dev/null | head -c 200)"; echo "fails=$fails"; exit 5; }
ok "call started in $ROOM"
sleep 12

PLAN=$(grep -o "Linux agent terminal plan: [a-z-]*" /tmp/nightly-linux.log | tail -1 | awk '{print $NF}')
[ "$PLAN" = "$WANT_PLAN" ] || fail "expected plan '$WANT_PLAN', got '${PLAN:-none}'"
[ -n "$PLAN" ] && ok "plan: $PLAN"

# The point of the whole exercise: a real agent process, not just a log line.
AGENT=$(pgrep -f "bin/claude .*join-call" | head -1)
[ -n "$AGENT" ] || fail "no claude agent process was spawned"
[ -n "$AGENT" ] && ok "agent running (pid $AGENT)"

if [ "$WANT_PLAN" = "tmux" ]; then
  SESSION=$(tmux ls 2>/dev/null | grep -o "^vibeconf-[^:]*" | head -1)
  [ -n "$SESSION" ] || fail "no tmux session was created"
  if [ -n "$SESSION" ]; then
    ok "tmux session $SESSION"
    # The property the tmux shape exists for: the viewport is not the agent.
    pkill -f "xterm -e tmux attach" 2>/dev/null; sleep 3
    tmux has-session -t "$SESSION" 2>/dev/null \
      && ok "agent survived losing its viewport" \
      || fail "killing the viewport killed the agent"
  fi
fi

# Teardown must reap it. An agent that outlives its call keeps holding an MCP
# connection and keeps acting.
curl -s -m 20 -X POST "$BASE/api/sync/$ROOM" -H 'Content-Type: application/json' \
  -d '{"sender":"nightly","meta":{"action":"leave"}}' -o /dev/null
sleep 12
if pgrep -f "bin/claude .*join-call" >/dev/null; then
  fail "agent survived teardown (orphaned)"
else
  ok "teardown reaped the agent"
fi

echo "fails=$fails"
[ "$fails" -eq 0 ]
