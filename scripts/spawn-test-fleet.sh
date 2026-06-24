#!/bin/zsh
# spawn-test-fleet.sh — boot N bot app instances for AUTOMATED testing, with NO
# Claude agents (the meet-test.mjs harness is the brain). Each instance runs in a
# DEDICATED, ISOLATED test profile so runs don't pollute — or get polluted by —
# the real Jimmy/Samantha environments.
#
#   profile   = test1, test2, …   (isolated userData: …/profiles/testN)
#   port      = 7901, 7902, …     (distinct range from real bots 7865/7866)
#   bot-name  = Jimmy, Samantha, Cosmo, …  (Meet display name; the harness keys
#               scenarios on this — profile is just the sandbox, name is identity)
#
# Profile instances skip the Claude-terminal integration automatically, so this
# only launches the apps. Drive them with: node scripts/meet-test.mjs
#
# Usage:
#   scripts/spawn-test-fleet.sh            # 2 bots from SOURCE (Jimmy, Samantha)
#   scripts/spawn-test-fleet.sh 3          # 3 bots (adds Cosmo)
#   scripts/spawn-test-fleet.sh 2 --dmg    # drive the INSTALLED packaged app
#                                          #   (real-artifact fidelity; mini/CI)
#   scripts/spawn-test-fleet.sh 2 --kill   # stop a previously-spawned fleet
#
# --dmg vs source: --dmg launches /Applications/Vibeconferencing.app so automated
# testing exercises the exact build users run (catches packaging-only bugs). Plain
# (source) is for active development. The scheduled mini run uses --dmg.
#
# Prints the --bots string to hand to meet-test.mjs.
#
# NOTE on Google sign-in: NOT needed for the default test meet (paz-sqoa-npe) —
# it's open for anyone to join as a guest, no account and no host admission. So a
# fresh, logged-out test profile joins it unattended. That's exactly why it's the
# default: the most open/unrestricted place to test. (Sign-in only matters for
# RESTRICTED meets — e.g. a cross-org host that requires auto-admit; for those,
# sign each profile into Google once via Settings → "Sign in to Google as bot",
# which now persists post-beta21.)

set -e
# Dir-agnostic: default to this script's own repo (scripts/ -> repo root via
# zsh ${0:A:h:h}), so it works from any worktree/clone. Override with
# VIBECONF_REPO to point at a specific checkout.
REPO="${VIBECONF_REPO:-${0:A:h:h}}"
ELECTRON="$REPO/electron-app"
NAMES=(Jimmy Samantha Cosmo Dizzy)        # display names by index
BASE_PORT=7901

# Flag parsing (position-independent): a numeric arg = count; --kill / --dmg flags.
N=2
KILL=0
DMG=0
for a in "$@"; do
  case "$a" in
    --kill) KILL=1 ;;
    --dmg)  DMG=1 ;;
    <->)    N="$a" ;;   # zsh: <-> matches an integer
    *) echo "usage: $0 [count] [--dmg] [--kill]"; exit 1 ;;
  esac
done
if (( N < 1 || N > 4 )); then echo "count must be 1–4"; exit 1; fi

# --kill: stop instances on the test ports (works regardless of how they launched).
if (( KILL )); then
  echo "▶ Stopping test fleet…"
  for i in $(seq 1 $N); do
    port=$((BASE_PORT + i - 1))
    profile="test$i"
    pid=$(lsof -ti tcp:$port 2>/dev/null || true)
    if [[ -n "$pid" ]]; then echo "  • killing pid $pid on $port"; kill "$pid" 2>/dev/null || true; fi
    # Port-only kill misses GUI Electron mains that aren't currently holding the
    # port — those linger as ghost participants and pile up across repeated runs,
    # causing room contention (the false chat/caption failures). Also reap by the
    # isolated --profile flag so every testN instance dies regardless of port
    # state. The pattern omits the leading dashes (BSD pkill treats a pattern
    # starting with "-" as an option); "profile=testN" still uniquely matches the
    # full argv and never matches the real bots (default/bot2 on 7865/7866).
    if pkill -f "profile=$profile" 2>/dev/null; then echo "  • reaped lingering profile=$profile process(es)"; fi
  done
  echo "✓ done"
  exit 0
fi

# --dmg drives the INSTALLED packaged app (/Applications/Vibeconferencing.app) so
# automated testing exercises the exact artifact an average user runs — no
# source-vs-package fidelity gap (e.g. asar/build.files bugs that only show
# packaged). Default (no --dmg) runs from source for active development.
if (( DMG )); then
  APP="/Applications/Vibeconferencing.app"
  [[ -d "$APP" ]] || { echo "✗ DMG app not found at $APP — install it first (or drop --dmg to run from source)"; exit 1; }
  echo "▶ Spawning $N test bot(s) from the PACKAGED app (--dmg) — agent-less, isolated profiles"
else
  echo "▶ Spawning $N test bot(s) from SOURCE — agent-less, isolated profiles"
fi

# ── Window grid: tile the spawned app windows so a watching human can see them
# all at once. No effect on the headless harness (it drives via HTTP). Windows
# are CREATED at these coords via --window-* flags, which the app applies at
# BrowserWindow creation — reliable, unlike moving from outside via System Events
# (the window server reverts those for some instances). The CI fleet has no agent
# terminals, so each bot gets a full grid cell. Set VIBECONF_NO_WINDOW_GRID=1 to
# skip (e.g. a headless nightly run that doesn't care about placement).
GRID=1
[[ -n "${VIBECONF_NO_WINDOW_GRID:-}" ]] && GRID=0
if (( GRID )); then
  read -r SCRW SCRH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null | awk -F', ' '{print $3, $4}')"
  SCRW=${SCRW:-1512}; SCRH=${SCRH:-982}
  MENUBAR=28
  case $N in
    1) COLS=1; ROWS=1 ;;
    2) COLS=1; ROWS=2 ;;   # 2 bots: stacked full-width rows — cleanest on a laptop
    *) COLS=2; ROWS=2 ;;   # 3–4 bots: 2×2 grid
  esac
  CELLW=$(( SCRW / COLS ))
  CELLH=$(( (SCRH - MENUBAR) / ROWS ))
  MINAPPW=1020   # 640 + PANEL_WIDTH(380): the app's enforced min width
  APPW=$(( CELLW > MINAPPW ? CELLW : MINAPPW ))
  APPH=$CELLH
  echo "  • window grid ${SCRW}×${SCRH}: ${COLS}×${ROWS}, each ~${APPW}×${APPH}"
fi

BOTS_ARG=""
for i in $(seq 1 $N); do
  profile="test$i"
  port=$((BASE_PORT + i - 1))
  name="${NAMES[$i]}"
  WINFLAGS=""
  if (( GRID )); then
    idx=$(( i - 1 ))
    col=$(( idx % COLS ))
    row=$(( idx / COLS ))
    wx=$(( col * CELLW ))
    wy=$(( MENUBAR + row * CELLH ))
    WINFLAGS="--window-x=$wx --window-y=$wy --window-w=$APPW --window-h=$APPH"
    echo "  • $name — profile=$profile port=$port  @ ${wx},${wy}"
  else
    echo "  • $name — profile=$profile port=$port"
  fi
  if (( DMG )); then
    # open -n = new instance (profiles bypass the single-instance lock). It
    # returns immediately and runs detached under LaunchServices; we wait/kill by
    # port below, and the app writes its own session log under the profile's
    # userData (…/profiles/testN/logs), so no stdout redirect needed.
    # ${=WINFLAGS}: zsh word-splits the flags into separate argv entries.
    open -n -a "Vibeconferencing" --args --profile="$profile" --local-port="$port" --bot-name="$name" ${=WINFLAGS}
  else
    nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --profile=$profile --local-port=$port --bot-name=$name $WINFLAGS" \
      >"/tmp/vibeconf-$profile.log" 2>&1 &
  fi
  BOTS_ARG+="${BOTS_ARG:+,}$name:$port"
done

# Wait for every local-server to come up.
echo "▶ Waiting for local-servers…"
for i in $(seq 1 $N); do
  port=$((BASE_PORT + i - 1))
  for attempt in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:$port/api/sync/no-room" >/dev/null 2>&1; then
      echo "  ✓ port $port up"; break
    fi
    if (( attempt == 40 )); then echo "  ✗ port $port never came up — see /tmp/vibeconf-test$i.log"; fi
    sleep 1
  done
done

echo ""
echo "✓ Fleet up. Drive it with:"
echo "    node scripts/meet-test.mjs --bots $BOTS_ARG"
echo ""
echo "  Stop it with: $0 $N --kill"
