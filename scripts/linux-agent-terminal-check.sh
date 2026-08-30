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
# 7866, NOT the default 7865. The primary app owns 7865, and on a box where one
# is service-managed (vibeconf-app.service on the test instance) it holds that
# port across reboots and process kills — so a lane pinned to 7865 can never get
# its own instance up. 7866+ is where profile bots already live (main.js:7126),
# and --local-port below puts our app there. The guard still stands watch: this
# removes the collision, it does not make the check unnecessary.
PORT=7866
BASE="http://127.0.0.1:$PORT"
export DISPLAY="${DISPLAY:-:99}"

fails=0
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
ok()   { echo "ok: $*"; }

# WHO HOLDS $PORT — the pid, or empty if nobody.
#
# This exists because /api/sync/no-room is deliberately an OPEN route (#356): it
# answers 200 from ANY app instance on the port, not just the one we launched.
# So when something else already owns $PORT, the readiness poll below sails
# through, prints "app started and serving", and then every authenticated call
# 401s against a stranger's app — which reads as an app regression rather than a
# port collision. That cost six nights of identical, misdiagnosed red (2026-08-25
# through 08-30): a packaged build installed as the systemd unit vibeconf-app
# .service was holding 7865, and killing the process only made systemd respawn it.
port_holder() {
  ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

# Is $1 an electron we launched? Our runtime lives under $HOME/electron-dist; a
# packaged install lives under /opt. Comparing the resolved exe (not the pid)
# keeps this true for electron's forked children, which is who may hold the
# socket rather than the pid we backgrounded.
holder_is_ours() {
  case "$(readlink -f "/proc/$1/exe" 2>/dev/null)" in
    "$(readlink -f "$ELECTRON" 2>/dev/null)") return 0 ;;
    *) return 1 ;;
  esac
}

# Report a foreign holder in the terms needed to actually clear it: what it is,
# and the unit to stop when it is service-managed (stopping it is the operator's
# call — a test script that stops arbitrary services is a worse problem than the
# one it solves).
describe_holder() {
  local pid="$1"
  echo "  pid $pid: $(ps -o args= -p "$pid" 2>/dev/null | cut -c1-100)"
  local unit
  unit=$(systemctl status "$pid" 2>/dev/null | head -1 | grep -o '[A-Za-z0-9@._-]*\.service')
  [ -n "$unit" ] && echo "  managed by systemd unit: $unit — clear with: sudo systemctl stop $unit"
}

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

# $PORT must be free BEFORE we launch. cleanup() below pkills our own electron,
# but it cannot clear a packaged or service-managed app — and a stranger on the
# port makes every check downstream meaningless.
holder=$(port_holder)
if [ -n "$holder" ] && ! holder_is_ours "$holder"; then
  echo "FAIL: port $PORT is already held by an app this lane did not start"
  describe_holder "$holder"
  echo "  the lane needs $PORT for its own instance (launched with VIBECONF_REQUIRE_TOKEN=0);"
  echo "  a foreign app enforces the #356 bearer token, so every authenticated call would 401."
  exit 3
fi

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
  --profile="$PROFILE" --local-port="$PORT" >/tmp/nightly-linux.log 2>&1 &

# POLL for the local server, don't sleep a guessed amount.
#
# This was `sleep 14`, which passed on a warm box and failed on a freshly-booted
# one: the process existed at 14s (so the pgrep check said "app started") but had
# not yet bound its port, so the very next curl got nothing and the lane reported
# a confusing "call/start returned no room". A fixed sleep is the classic way a
# nightly lane becomes flaky — it encodes the speed of the machine it was written
# on. /api/sync/no-room is the one GET that needs no auth token.
ready=""
for _ in $(seq 1 45); do
  if curl -fsS -m 3 "$BASE/api/sync/no-room" >/dev/null 2>&1; then ready=1; break; fi
  pgrep -f "electron-dist/electron" >/dev/null || break  # it died; stop waiting
  sleep 2
done
if [ -z "$ready" ]; then
  echo "FAIL: app never served $BASE (dead, or never bound its port)"
  tail -25 /tmp/nightly-linux.log
  exit 4
fi
# Serving is not enough — it must be OUR app serving. Without this, an instance
# that raced us onto the port (or was started between the precondition check and
# now) passes the open-route poll and turns the whole run into 401 noise.
holder=$(port_holder)
if [ -n "$holder" ] && ! holder_is_ours "$holder"; then
  echo "FAIL: $BASE answered, but the listener is not the app this lane launched"
  describe_holder "$holder"
  exit 4
fi
ok "app started and serving"

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
