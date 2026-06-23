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

# ── Preflight: clear any prior test session. The agent terminals run in the
# built-in Terminal.app (opened via `osascript tell "Terminal"` at the end),
# which is a SEPARATE app from your shell's terminal (Ghostty/iTerm). So unless
# this script is itself running inside Terminal.app, we just quit Terminal.app
# wholesale to clear all stale agent windows — they reopen fresh below. (Closing
# them one-by-one is unreliable: shell-init keeps the windows "busy", so Terminal
# pops a close-confirmation sheet AppleScript can't pass.)
echo "▶ Preflight: clearing any prior test session…"
set +e  # cleanup is best-effort; a missing target must not abort the launch

# Kill agent claude sessions (+ caffeinate wrappers) and our Electron apps.
if pkill -f "/join-call" 2>/dev/null; then echo "  • killed stale agent session(s)"; fi
if pkill -f "vibeconferencing/electron-app" 2>/dev/null; then echo "  • quit a running Electron app"; fi

# Clear the stale agent Terminal.app windows.
if [ "$TERM_PROGRAM" = "Apple_Terminal" ]; then
  # Running INSIDE Terminal.app — can't quit it (would kill this script), so
  # close every window except our own. (Needs Terminal's Prompt-before-closing
  # = Never, and even then "busy" windows can resist — running from Ghostty/iTerm
  # via the branch below is the reliable path.)
  SELF_WIN=$(osascript -e 'tell application "Terminal" to id of front window' 2>/dev/null)
  if [ -n "$SELF_WIN" ]; then
    osascript 2>/dev/null <<OSA
tell application "Terminal"
  set toClose to {}
  repeat with w in windows
    try
      if (id of w) is not ${SELF_WIN} then set end of toClose to w
    end try
  end repeat
  repeat with w in toClose
    try
      close w saving no
    end try
  end repeat
end tell
OSA
    echo "  • closed other Terminal windows"
  fi
elif pgrep -x Terminal >/dev/null 2>&1; then
  # We're in Ghostty/iTerm — Terminal.app holds ONLY our agent windows. Quit it
  # wholesale (its agent processes are already killed above). It relaunches fresh
  # when we open the new agent terminals below.
  killall Terminal 2>/dev/null
  sleep 1
  echo "  • quit Terminal.app (cleared all stale agent windows)"
fi

# If something we don't manage is still holding Jimmy's port, warn (don't kill).
if curl -sf "http://127.0.0.1:7865/api/sync/no-room" >/dev/null 2>&1; then
  echo "⚠ Port 7865 is still in use after cleanup — quit it manually if the launch misbehaves."
fi
set -e

# ── Window grid geometry (debug nicety): one ROW per bot — APP on the left,
# its agent TERMINAL on the right. Jimmy = top row, Samantha = bottom row.
# Adapts to the current screen (clean on an external monitor; on the laptop the
# apps' ~1020px min width overlaps into the terminal column). Apps are CREATED
# at these coords via --window-* flags (reliable — moving them from outside via
# System Events gets reverted by the window server for some instances).
read -r SCRW SCRH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null | awk -F', ' '{print $3, $4}')"
SCRW=${SCRW:-1512}; SCRH=${SCRH:-982}
MENUBAR=28
HALFW=$(( SCRW / 2 ))
HALFH=$(( (SCRH - MENUBAR) / 2 ))
MINAPPW=1020   # 640 + PANEL_WIDTH(380): the app's enforced min width
APPW=$(( HALFW > MINAPPW ? HALFW : MINAPPW ))
TOPY=$MENUBAR
BOTY=$(( MENUBAR + HALFH ))
WINWH="--window-w=$APPW --window-h=$HALFH"
echo "  • grid ${SCRW}×${SCRH}: Jimmy row (top), Samantha row (bottom) — app left, terminal right"

# 1. Jimmy's app — default profile, port 7865, devtools. Top-LEFT.
echo "  • starting Jimmy's app (7865)…"
nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --devtools=true --bot-name=Jimmy --window-x=0 --window-y=$TOPY $WINWH" >/tmp/vibeconf-jimmy-app.log 2>&1 &

# 2. Samantha's app — bot2 profile, port 7866. Bottom-LEFT.
echo "  • starting Samantha's app (7866)…"
nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --profile=bot2 --local-port=7866 --bot-name=Samantha --window-x=0 --window-y=$BOTY $WINWH" >/tmp/vibeconf-samantha-app.log 2>&1 &

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

# Minimize the Electron DevTools windows ("Developer Tools - …") so they don't
# clutter the grid. (The apps self-position via --window-* above; only the
# DevTools windows + the terminals still need System Events.)
osascript >/dev/null 2>&1 <<'OSA'
tell application "System Events"
  repeat with p in (processes whose name is "Electron")
    repeat with w in windows of p
      try
        if (title of w) contains "Developer Tools" then set value of attribute "AXMinimized" of w to true
      end try
    end repeat
  end repeat
end tell
OSA

# 4. Open an agent Terminal per bot — Jimmy's terminal top-RIGHT, Samantha's
#    bottom-RIGHT (right column, beside each bot's app). Terminal is fresh after
#    the preflight killall, so the window each `do script` just created is
#    window 1 — capture its id right then (deterministic; titles are unreliable
#    because the bot name sits at the truncated tail). Each uses an --mcp-config
#    pinned to its app's port.
echo "  • opening agent terminals…"
osascript >/dev/null 2>&1 <<OSA
tell application "Terminal"
  do script "cd '$REPO' && claude --mcp-config '$REPO/.mcp.json' --strict-mcp-config \"/join-call $ROOM Jimmy\""
  delay 0.6
  set jId to id of window 1
  do script "cd '$SAM_DIR' && claude --mcp-config '$SAM_DIR/.mcp.json' --strict-mcp-config \"/join-call $ROOM Samantha\""
  delay 0.6
  set sId to id of window 1
  activate
  try
    set bounds of window id jId to {$HALFW, $TOPY, $SCRW, $BOTY}
  end try
  try
    set bounds of window id sId to {$HALFW, $BOTY, $SCRW, $SCRH}
  end try
end tell
OSA

echo "✓ Done. Two app windows + two agent terminals should be coming up."
echo "  App logs: /tmp/vibeconf-jimmy-app.log, /tmp/vibeconf-samantha-app.log"
