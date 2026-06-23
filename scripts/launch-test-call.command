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

# ── Preflight: clear any PRIOR test session so stale apps/terminals don't skew
# the run. This is deliberately TARGETED — it only touches things this script
# created: the agent Terminal windows it tags with a "vibeconf-agent" custom
# title, our dev Electron apps (matched by their app path), and leftover agent
# claude sessions (matched by "--mcp-config … /join-call"). It never closes your
# other Terminal windows, other Electron apps, or this session.
echo "▶ Preflight: clearing any prior test session…"
set +e  # cleanup is best-effort; a missing target must not abort the launch

# Order matters: KILL the processes first, THEN close their Terminal windows.
# Terminal refuses to close (via AppleScript) a window that still has a running
# process like `claude` in it — closing first was a no-op, so windows piled up.

# 1. Kill leftover agent claude sessions pinned to our mcp configs (join-call).
#    This session has no '--mcp-config … /join-call' in its argv, so it's safe.
if pkill -f "claude --mcp-config.*join-call" 2>/dev/null; then echo "  • killed a stale agent session"; fi

# 2. Quit our dev Electron app(s) — matched by our app path only (covers both
#    Jimmy and Samantha, who run from the same electron-app dir).
if pkill -f "vibeconferencing/electron-app" 2>/dev/null; then echo "  • quit a running Electron app"; fi

sleep 1  # let the killed shells drop back to an idle prompt so they're closeable

# 3. Now close the agent Terminal windows we tagged on a previous run. Collect
#    matches first, then close — closing while iterating `windows` skips entries.
osascript >/dev/null 2>&1 <<'OSA'
tell application "Terminal"
  set toClose to {}
  repeat with w in windows
    try
      if (custom title of (selected tab of w)) contains "vibeconf-agent" then set end of toClose to w
    end try
  end repeat
  repeat with w in toClose
    try
      close w saving no
    end try
  end repeat
end tell
OSA

sleep 1
# If something we don't manage is still holding Jimmy's port, warn (don't kill).
if curl -sf "http://127.0.0.1:7865/api/sync/no-room" >/dev/null 2>&1; then
  echo "⚠ Port 7865 is still in use after cleanup — an unmanaged process may hold it. Quit it manually if the launch misbehaves."
fi
set -e

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
# Tag each agent window with a "vibeconf-agent" custom title so the preflight
# above can find and close exactly these on the next run (and nothing else).
osascript >/dev/null <<OSA
tell application "Terminal"
  set jtab to do script "cd '$REPO' && claude --mcp-config '$REPO/.mcp.json' --strict-mcp-config \"/join-call $ROOM Jimmy\""
  set custom title of jtab to "vibeconf-agent-jimmy"
  set stab to do script "cd '$SAM_DIR' && claude --mcp-config '$SAM_DIR/.mcp.json' --strict-mcp-config \"/join-call $ROOM Samantha\""
  set custom title of stab to "vibeconf-agent-samantha"
  activate
end tell
OSA

echo "✓ Done. Two app windows + two agent terminals should be coming up."
echo "  App logs: /tmp/vibeconf-jimmy-app.log, /tmp/vibeconf-samantha-app.log"
