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
#   scripts/spawn-test-fleet.sh 2 --dmg    # drive the INSTALLED app (/Applications)
#   scripts/spawn-test-fleet.sh 2 --built  # drive the freshly-BUILT app (dist/)
#   scripts/spawn-test-fleet.sh 2 --kill   # stop a previously-spawned fleet
#
# Three sources, all agent-less:
#   (default) SOURCE   — pnpm dev; active development.
#   --dmg     INSTALLED — /Applications/Vibeconferencing.app; the exact artifact
#                         an average user runs. The scheduled mini run uses --dmg.
#   --built   BUILT    — the newest electron-builder output under
#                         electron-app/dist/mac*/Vibeconferencing.app, i.e. the
#                         DMG you just built BEFORE installing it. Use this to
#                         test a fresh build without clobbering the installed app.
# --dmg and --built both exercise the real packaged artifact (asar, build.files);
# they differ only in WHICH copy — installed vs just-built.
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

# Flag parsing (position-independent): a numeric arg = count; --kill / --dmg /
# --built flags.
N=2
KILL=0
DMG=0
BUILT=0
SLACK=0
SLACK_URL=""
for a in "$@"; do
  case "$a" in
    --kill)        KILL=1 ;;
    --dmg)         DMG=1 ;;
    --built)       BUILT=1 ;;
    --slack)       SLACK=1 ;;
    --slack-url=*) SLACK_URL="${a#--slack-url=}" ;;
    <->)           N="$a" ;;   # zsh: <-> matches an integer
    *) echo "usage: $0 [count] [--dmg|--built] [--slack --slack-url=URL] [--kill]"; exit 1 ;;
  esac
done
if (( N < 1 || N > 4 )); then echo "count must be 1–4"; exit 1; fi

# Slack bots use a DISTINCT profile namespace — signed into a Slack ACCOUNT (one-
# time manual login per profile), not Google/guest. Meet bots = test1.., Slack
# bots = slacktest1.. So `--slack --kill` reaps the right ones too.
PROFILE_BASE=$( (( SLACK )) && echo "slacktest" || echo "test" )

# --kill: stop instances on the test ports (works regardless of how they launched).
if (( KILL )); then
  echo "▶ Stopping test fleet…"
  for i in $(seq 1 $N); do
    port=$((BASE_PORT + i - 1))
    profile="${PROFILE_BASE}$i"
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

# Slack launch args: --provider=slack + the channel to auto-join. Each slacktestN
# profile must be signed into a (distinct) Slack account ONCE first — there's no
# guest path. Do that one-time login manually, e.g.:
#   cd electron-app && pnpm dev -- --provider=slack --profile=slacktest1 \
#     --slack-url=https://app.slack.com/client/<team>/<channel>   # then log in, close
EXTRA_ARGS=""
if (( SLACK )); then
  [[ -n "$SLACK_URL" ]] || { echo "✗ --slack needs --slack-url=https://app.slack.com/client/<team>/<channel>"; exit 1; }
  EXTRA_ARGS="--provider=slack --slack-url=$SLACK_URL"
fi

# Packaged-app modes exercise the real artifact (asar, build.files) — no
# source-vs-package fidelity gap. --dmg = the INSTALLED app (/Applications); the
# exact thing users run. --built = the freshly-BUILT app under electron-app/dist
# (this checkout's latest electron-builder output), so you can test a build
# WITHOUT installing it over the current /Applications copy. Default = source.
if (( DMG && BUILT )); then
  echo "✗ choose one of --dmg (installed) or --built (dist/), not both"; exit 1
fi
PKG=0          # 1 = launch a packaged .app by path (dmg or built); 0 = source
APP=""
if (( DMG )); then
  APP="/Applications/Vibeconferencing.app"
  [[ -d "$APP" ]] || { echo "✗ Installed app not found at $APP — install the DMG first (or use --built / drop the flag for source)"; exit 1; }
  PKG=1
  echo "▶ Spawning $N test bot(s) from the INSTALLED app (--dmg): $APP"
elif (( BUILT )); then
  # Newest electron-builder output for THIS checkout: dist/mac*/Vibeconferencing.app
  # (mac-arm64 / mac / mac-universal). (N)=nullglob so no match → empty (no error
  # under set -e); om = order by mtime, newest first → [1] is the latest build.
  built=("$ELECTRON"/dist/mac*/Vibeconferencing.app(Nom))
  APP="${built[1]}"
  [[ -n "$APP" && -d "$APP" ]] || { echo "✗ No built app under $ELECTRON/dist/mac*/ — run 'pnpm dist:fast' in electron-app first (or use --dmg / drop the flag for source)"; exit 1; }
  PKG=1
  echo "▶ Spawning $N test bot(s) from the BUILT app (--built): $APP"
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
  profile="${PROFILE_BASE}$i"
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
  if (( PKG )); then
    # open -n = new instance (profiles bypass the single-instance lock). It
    # returns immediately and runs detached; we wait/kill by port below, and the
    # app writes its own session log under the profile's userData
    # (…/profiles/testN/logs), so no stdout redirect needed. Launch by explicit
    # bundle PATH ("$APP") so we run exactly the chosen copy (installed vs built),
    # not whatever LaunchServices resolves the app NAME to.
    # ${=WINFLAGS}: zsh word-splits the flags into separate argv entries.
    open -n "$APP" --args --profile="$profile" --local-port="$port" --bot-name="$name" ${=WINFLAGS} ${=EXTRA_ARGS}
  else
    nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --profile=$profile --local-port=$port --bot-name=$name $WINFLAGS $EXTRA_ARGS" \
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
if (( SLACK )); then
  echo "    node scripts/slack-test.mjs --bots $BOTS_ARG --slack-url=$SLACK_URL"
else
  echo "    node scripts/meet-test.mjs --bots $BOTS_ARG"
fi
echo ""
echo "  Stop it with: $0 $N --kill"
