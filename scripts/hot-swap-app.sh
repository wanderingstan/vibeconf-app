#!/bin/zsh
# hot-swap-app.sh — swap the running Vibeconferencing for a freshly built one
# WITHOUT losing the bot from the call it is in.
#
# THE POINT. An agent that has been working on the app all session can build it,
# swap itself onto the new binary, and carry on in the same conversation — the
# bot vanishes for ~30s and comes back knowing everything, because its Claude
# session is name-keyed and resumes (#500). That turns "restart to test this" from
# the end of a working session into a pause in one.
#
# Proven live 2026-08-24: a 90-minute call where the bot rebuilt the app it was
# running on, swapped to it mid-conversation, and resumed without the human
# re-joining anything.
#
# WRITTEN BY THE PROCESS IT KILLS. That is the whole constraint: anything running
# as a child of the agent dies with the agent, so this must be launched detached
# (nohup … & ; disown) and must not depend on its parent for anything.
#
# IDENTIFY THE INSTANCE BY WHO HOLDS THE PORT, not by its bundle path.
#
# v1 matched `Vibeconferencing.app/Contents/MacOS/Vibeconferencing` and failed
# silently on 2026-08-24: what was actually running was a DEV run — a bare
# Electron binary out of a git worktree — so the pattern matched nothing, the old
# process kept the port and the single-instance lock, the new build quietly quit
# on launch (exactly as main.js's own comment warns), and the script reported
# success because the port was still answering. The port is the thing that
# actually matters, and lsof names its owner whatever the binary is called.
#
# Order is not negotiable: quit -> confirm the port is FREE -> launch.

usage() {
  cat <<'USAGE'
hot-swap-app.sh <app.app> <meet-code> <bot-name> [port]

  Replace the running Vibeconferencing with a freshly built one, in place,
  without the bot losing the call it is in.

  MUST be launched detached, by the agent it is about to kill:

      nohup scripts/hot-swap-app.sh \
        electron-app/dist/mac-arm64/Vibeconferencing.app \
        abc-defg-hij Jimmy 7865 > /dev/null 2>&1 &
      disown

  Log: ~/.vibeconf-relaunch/relaunch.log
USAGE
}
[ $# -lt 3 ] && { usage; exit 2; }
mkdir -p ~/.vibeconf-relaunch
LOG=~/.vibeconf-relaunch/relaunch.log
exec >> "$LOG" 2>&1
echo "=== relaunch $(date) ==="

APP="$1"; ROOM="$2"; BOT="$3"; PORT="${4:-7865}"
[ -d "$APP" ] || { echo "FATAL: no app at $APP"; exit 1; }
echo "app=$APP room=$ROOM bot=$BOT port=$PORT"

port_owner() { lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

OLD=$(port_owner)
echo "-- port $PORT held by pid ${OLD:-none}"
[ -n "$OLD" ] && ps -o command= -p "$OLD" 2>/dev/null | cut -c1-160

echo "-- asking it to quit"
osascript -e 'tell application "Vibeconferencing" to quit' 2>&1
for i in $(seq 1 30); do [ -z "$(port_owner)" ] && { echo "-- port free after $((i/2))s"; break }; sleep 0.5; done

# Still held: a dev run has no app-level quit handler to hit, so signal the pid.
if [ -n "$(port_owner)" ]; then
  P=$(port_owner); echo "-- still held by $P, TERM"
  kill "$P" 2>&1
  for i in $(seq 1 20); do [ -z "$(port_owner)" ] && break; sleep 0.5; done
  if [ -n "$(port_owner)" ]; then P=$(port_owner); echo "-- still held by $P, KILL"; kill -9 "$P" 2>&1; sleep 2; fi
fi

# NEVER launch onto a held port. The single-instance lock would make the new
# process quit on its own and the old one would answer in its place — which is
# precisely the false success v1 reported.
if [ -n "$(port_owner)" ]; then
  echo "-- FATAL: port $PORT still held by $(port_owner); refusing to launch (would be a silent no-op)"
  exit 1
fi

echo "-- launching the new build"
open -n "$APP" --args --meet-url="https://meet.google.com/$ROOM" --bot-name="$BOT" 2>&1

# Prove the NEW one came up — and that it is genuinely a different process.
for i in $(seq 1 90); do
  NEW=$(port_owner)
  if [ -n "$NEW" ] && [ "$NEW" != "$OLD" ]; then
    echo "-- new instance (pid $NEW) answering on $PORT after ${i}s"
    ps -o command= -p "$NEW" 2>/dev/null | cut -c1-160
    exit 0
  fi
  sleep 1
done
echo "-- WARNING: nothing new answered on $PORT within 90s"
exit 1
