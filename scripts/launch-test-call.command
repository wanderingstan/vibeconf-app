#!/bin/zsh
# launch-test-call.command — boot BOTH bots (Jimmy + Samantha) into the test Meet
# in one shot. Double-click in Finder, or run it.
#
#   Jimmy   = primary, default profile, local-server 7865 (your LM-Studio / latest-code bot)
#   Samantha= bot2 profile, local-server 7866 (the no-LM-Studio comparison bot)
#
# What it does:
#   1. launches both dev apps (backgrounded, logs in /tmp)
#   2. waits for both local-servers to be listening
#   3. opens a Terminal window per agent running `/join-call`, each pinned to its
#      app's port via --mcp-config + --strict-mcp-config
#
# Usage:
#   ./launch-test-call.command                 # default room paz-sqoa-npe
#   ./launch-test-call.command abc-defg-hij    # a different meet code

set -e
ROOM="${1:-paz-sqoa-npe}"
REPO="/Users/wanderingstan/Developer/vibeconferencing"
ELECTRON="$REPO/electron-app"
SAM_DIR="/Users/wanderingstan/Developer/vibeconf-bots/samantha"

echo "▶ Launching test call in room: $ROOM"

# Already running? (a stale Jimmy holds the default single-instance lock)
if curl -sf "http://127.0.0.1:7865/api/sync/no-room" >/dev/null 2>&1; then
  echo "⚠ Something is already on port 7865 (Jimmy may be running). Quit it first if this misbehaves."
fi

# 1. Jimmy's app — default profile, port 7865, devtools (matches the usual flow).
echo "  • starting Jimmy's app (7865)…"
nohup zsh -c "cd '$ELECTRON' && pnpm dev-with-tools" >/tmp/vibeconf-jimmy-app.log 2>&1 &

# 2. Samantha's app — bot2 profile, port 7866.
echo "  • starting Samantha's app (7866)…"
nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --profile=bot2 --local-port=7866 --bot-name=Samantha" >/tmp/vibeconf-samantha-app.log 2>&1 &

# 3. Wait for both local-servers to come up.
wait_for_port() {
  local port=$1 name=$2
  for i in {1..40}; do
    if curl -sf "http://127.0.0.1:$port/api/sync/no-room" >/dev/null 2>&1; then
      echo "  ✓ $name app ready on $port"
      return 0
    fi
    sleep 1
  done
  echo "  ✗ $name app did NOT come up on $port — check /tmp/vibeconf-$name-app.log"
  return 1
}
echo "  • waiting for apps…"
wait_for_port 7865 jimmy || exit 1
wait_for_port 7866 samantha || exit 1
sleep 2  # let the panels finish initializing before the agents call join_call

# 4. Open an agent Terminal per bot. Each uses an explicit --mcp-config pinned to
#    its app's port + --strict-mcp-config so it can't talk to the wrong app.
echo "  • opening agent terminals…"
osascript >/dev/null <<OSA
tell application "Terminal"
  do script "cd '$REPO' && claude --mcp-config '$REPO/.mcp.json' --strict-mcp-config \"/join-call $ROOM Jimmy\""
  do script "cd '$SAM_DIR' && claude --mcp-config '$SAM_DIR/.mcp.json' --strict-mcp-config \"/join-call $ROOM Samantha\""
  activate
end tell
OSA

echo "✓ Done. Two app windows + two agent terminals should be coming up."
echo "  App logs: /tmp/vibeconf-jimmy-app.log, /tmp/vibeconf-samantha-app.log"
