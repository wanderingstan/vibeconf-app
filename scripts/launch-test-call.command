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

# 1. Jimmy's app — default profile, port 7865, devtools (matches the usual flow).
#    --bot-name=Jimmy is passed so the window-arrange step below can find this
#    app's process (Samantha already carries --bot-name).
echo "  • starting Jimmy's app (7865)…"
nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --devtools=true --bot-name=Jimmy" >/tmp/vibeconf-jimmy-app.log 2>&1 &

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

# ── Arrange windows in a 2×2 grid (debug nicety): apps on top, each agent
# terminal directly BELOW its app (Jimmy left column, Samantha right column).
# Geometry adapts to the CURRENT screen — roomy on an external monitor, cramped
# on the laptop (the app's ~1020px min width forces some overlap at half-screen).
# All best-effort; needs Automation/Accessibility (granted once).
read -r SCRW SCRH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null | awk -F', ' '{print $3, $4}')"
SCRW=${SCRW:-1512}; SCRH=${SCRH:-982}
MENUBAR=28
HALFW=$(( SCRW / 2 ))
HALFH=$(( (SCRH - MENUBAR) / 2 ))
TOPY=$MENUBAR
BOTY=$(( MENUBAR + HALFH ))

# Position an Electron app's main window by its --bot-name. "MacOS/Electron"
# excludes the launcher shell + helper procs; we target the "Vibeconferencing"
# window so a separate devtools window isn't moved instead.
arrange_app() {  # $1=botname  $2=x  $3=y
  local pid; pid=$(pgrep -f "MacOS/Electron.*bot-name=$1" | head -1)
  [ -n "$pid" ] || return
  osascript >/dev/null 2>&1 <<OSA
tell application "System Events"
  try
    set p to (first process whose unix id is $pid)
    set tw to missing value
    repeat with w in windows of p
      if (title of w) contains "Vibeconf" then set tw to w
    end repeat
    if tw is missing value then set tw to window 1 of p
    -- Size first, then re-read the ACTUAL size (the app clamps to a ~1020px
    -- min width) and clamp the position so a too-wide window stays on-screen
    -- instead of overflowing the right/bottom edge (the laptop case).
    set size of tw to {$HALFW, $HALFH}
    set sz to size of tw
    set px to $2
    set py to $3
    if (px + (item 1 of sz)) > $SCRW then set px to ($SCRW - (item 1 of sz))
    if (py + (item 2 of sz)) > $SCRH then set py to ($SCRH - (item 2 of sz))
    if px < 0 then set px to 0
    if py < $MENUBAR then set py to $MENUBAR
    set position of tw to {px, py}
  end try
end tell
OSA
}
echo "  • arranging windows (${SCRW}×${SCRH})…"
# Minimize the Electron DevTools windows ("Developer Tools - …") so they don't
# clutter the grid or get grabbed by the positioning instead of the main window.
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
arrange_app Jimmy 0 "$TOPY"
arrange_app Samantha "$HALFW" "$TOPY"

# 4. Open an agent Terminal per bot, positioning each below its app. Each uses an
#    explicit --mcp-config pinned to its app's port + --strict-mcp-config.
echo "  • opening agent terminals…"
osascript >/dev/null 2>&1 <<OSA
tell application "Terminal"
  do script "cd '$REPO' && claude --mcp-config '$REPO/.mcp.json' --strict-mcp-config \"/join-call $ROOM Jimmy\""
  delay 0.4
  try
    set bounds of front window to {0, $BOTY, $HALFW, $SCRH}
  end try
  do script "cd '$SAM_DIR' && claude --mcp-config '$SAM_DIR/.mcp.json' --strict-mcp-config \"/join-call $ROOM Samantha\""
  delay 0.4
  try
    set bounds of front window to {$HALFW, $BOTY, $SCRW, $SCRH}
  end try
  activate
end tell
OSA

echo "✓ Done. Two app windows + two agent terminals should be coming up."
echo "  App logs: /tmp/vibeconf-jimmy-app.log, /tmp/vibeconf-samantha-app.log"
