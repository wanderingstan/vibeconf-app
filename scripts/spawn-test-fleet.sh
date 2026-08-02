#!/bin/zsh
# spawn-test-fleet.sh — boot N bot app instances for AUTOMATED testing, with NO
# Claude agents (the meet-test.mjs harness is the brain). Each instance runs in a
# DEDICATED, ISOLATED test profile so runs don't pollute — or get polluted by —
# the real Jimmy/Samantha environments.
#
#   profile   = test-meet-guest-1, …  (isolated userData: …/profiles/<name>;
#               class prefix is test-meet-guest / test-meet-google / test-slack)
#   port      = 7901, 7902, …     (distinct range from real bots 7865/7866)
#   bot-name  = Alice, Jimmy, Cosmo, …  (Meet display name; the harness keys
#               scenarios on this — profile is just the sandbox, name is identity)
#
# Profile instances skip the Claude-terminal integration automatically, so this
# only launches the apps. Drive them with: node scripts/meet-test.mjs
#
# Usage:
#   scripts/spawn-test-fleet.sh            # 2 bots from SOURCE (Alice, Jimmy)
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
NAMES=(Alice Jimmy Cosmo Dizzy)           # display names by index (Alice=-1, Jimmy=-2)
# Base local-server port for the fleet (bots use BASE_PORT, BASE_PORT+1, …).
# Override with VIBECONF_BASE_PORT to run a fleet that WON'T collide with the
# on-push CI smoke or the nightly (both use the 7901 default) — e.g. the long
# name-transcription audit runs on 7911/7912.
BASE_PORT="${VIBECONF_BASE_PORT:-7901}"

# Flag parsing (position-independent): a numeric arg = count; --kill / --dmg /
# --built flags.
N=2
KILL=0
DMG=0
BUILT=0
SLACK=0
SLACK_URL=""
GOOGLE=0
DEVTOOLS=0
WITH_AGENTS=0            # --with-agents: attach a real Claude agent per bot (#267 item 5)
FUZZ_ROOM=""            # --room=CODE   passed to spawn-agents.mjs
FUZZ_MISSION=""         # --mission=KEY passed to spawn-agents.mjs
for a in "$@"; do
  case "$a" in
    --kill)        KILL=1 ;;
    --dmg)         DMG=1 ;;
    --built)       BUILT=1 ;;
    --slack)       SLACK=1 ;;
    --slack-url=*) SLACK_URL="${a#--slack-url=}" ;;
    --google)      GOOGLE=1 ;;
    --devtools)    DEVTOOLS=1 ;;
    --with-agents) WITH_AGENTS=1 ;;
    --room=*)      FUZZ_ROOM="${a#--room=}" ;;
    --mission=*)   FUZZ_MISSION="${a#--mission=}" ;;
    <->)           N="$a" ;;   # zsh: <-> matches an integer
    *) echo "usage: $0 [count] [--dmg|--built] [--slack --slack-url=URL] [--google] [--devtools] [--with-agents --room=CODE --mission=KEY] [--kill]"; exit 1 ;;
  esac
done
if (( N < 1 || N > 4 )); then echo "count must be 1–4"; exit 1; fi

# Each identity gets its OWN profile namespace so they don't clobber each other
# and `--kill` reaps the right ones. The names share a `test-` prefix so all test
# profiles sort together and guest-vs-google is obvious (#282):
#   guest Meet (default)    = test-meet-guest-1..   (logged OUT — tests the guest join path)
#   Google-signed-in Meet   = test-meet-google-1..  (--google; signed INTO a bot Google account
#                                                    ONCE via Settings → "Sign in as bot";
#                                                    needed for invite-only / Workspace meets)
#   Slack                   = test-slack-1..        (--slack; signed into a Slack account once)
# Keeping the guest class login-free means we KEEP testing the non-Google guest
# path even after adding signed-in profiles for the Workspace/history-on target.
if   (( SLACK ));  then PROFILE_BASE="test-slack"
elif (( GOOGLE )); then PROFILE_BASE="test-meet-google"
else                   PROFILE_BASE="test-meet-guest"
fi

# Bot names are Alice (-1), Jimmy (-2) across ALL classes. For --google these
# match the Google accounts signed into the google profiles (test-meet-google-1
# = alice@spiritprotocol.io, test-meet-google-2 = jimmy@spiritprotocol.io); the
# --meet-account-email pin below is derived from the same names.

# For --google, deterministically PIN each profile's Google account (#282) so
# joins use authuser=<email> and can't fall back to a stray default account. The
# email is <lowercase-bot-name>@$GTEST_EMAIL_DOMAIN — matching the accounts you
# sign the google profiles into. Override the domain via env if your bot accounts
# live elsewhere. (Pinning only SELECTS the account; you still sign each profile
# in once — the single partition starts fresh.)
GTEST_EMAIL_DOMAIN="${GTEST_EMAIL_DOMAIN:-spiritprotocol.io}"

# --kill: stop instances on the test ports (works regardless of how they launched).
if (( KILL )); then
  echo "▶ Stopping test fleet…"
  # Reap any attached real agents first (#267 item 5), before the bodies go down.
  if (( WITH_AGENTS )); then node "${0:A:h}/spawn-agents.mjs" --kill 2>/dev/null || true; fi
  # GRACEFUL LEAVE first: tell each live bot to LEAVE its call so its tile/presence
  # is dropped right away, instead of ghosting until the ~10min presence TTL. Stale
  # same-named bots from a prior run collide with the next run's bots and produce
  # flaky chat/caption failures (Stan spotted prior-run Jimmy/Samantha still in the
  # meet). The 'leave' action fires onLeaveCall regardless of room, so any valid
  # slug path works. Then settle briefly so Meet/Slack processes the hangup before
  # we SIGKILL the process out from under it.
  left=0
  for i in $(seq 1 $N); do
    port=$((BASE_PORT + i - 1))
    if curl -sf -X POST "http://127.0.0.1:$port/api/sync/fleet-leave" \
         -H 'Content-Type: application/json' -d '{"sender":"fleet-kill","meta":{"action":"leave"}}' >/dev/null 2>&1; then
      echo "  • sent leave to bot on $port"; left=1
    fi
  done
  if (( left )); then echo "  • settling 3s for call hangup…"; sleep 3; fi
  for i in $(seq 1 $N); do
    port=$((BASE_PORT + i - 1))
    profile="${PROFILE_BASE}-$i"
    # -sTCP:LISTEN: match ONLY the bot's listening socket, not clients holding an
    # open connection to it. Without this, an in-process driver (node:test's
    # call-parity matrix runs --kill from an after() hook while still holding
    # keep-alive connections to 7901/7902) is itself returned here and gets
    # SIGKILLed — the test runner kills itself mid-suite (file reported SIGTERM,
    # Slack block never ran). The standalone :ci scripts dodge it only because the
    # driver has already exited before --kill runs.
    pid=$(lsof -ti tcp:$port -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "$pid" ]]; then echo "  • killing pid $pid on $port"; kill "$pid" 2>/dev/null || true; fi
    # Port-only kill misses GUI Electron mains that aren't currently holding the
    # port — those linger as ghost participants and pile up across repeated runs,
    # causing room contention (the false chat/caption failures). Also reap by the
    # isolated --profile flag so every test instance dies regardless of port
    # state. The pattern omits the leading dashes (BSD pkill treats a pattern
    # starting with "-" as an option); "profile=test-meet-guest-1" still uniquely
    # matches the full argv and never matches the real bots (default on 7865/66).
    if pkill -f "profile=$profile" 2>/dev/null; then echo "  • reaped lingering profile=$profile process(es)"; fi
  done

  # Sweep any agent Terminal windows a test bot spawned. Fleets now launch with
  # --no-agent-terminal=true so there should be none, but an app launched by hand,
  # or an older build, still litters one per start_call — and nothing else reaps
  # them (the MCP leave_call path skips closeClaudeTerminal). Belt and braces so a
  # long night doesn't leave a screen full of windows.
  #
  # Deliberately narrow: only windows whose tab is running our `/join-call` or
  # `/call` command. It never touches a Terminal window someone is working in, so
  # this is safe to run on a machine that isn't a dedicated test box.
  if [[ "${VIBECONF_NO_TERMINAL_SWEEP:-0}" != "1" ]] && command -v osascript >/dev/null 2>&1; then
    swept=$(osascript <<'APPLESCRIPT' 2>/dev/null || echo 0
tell application "System Events"
  if not (exists process "Terminal") then return 0
end tell
set n to 0
tell application "Terminal"
  repeat with w in windows
    try
      repeat with t in tabs of w
        set cmd to ""
        try
          set cmd to (processes of t) as string
        end try
        set ttl to ""
        try
          set ttl to custom title of t
        end try
        if (cmd contains "claude") and ((ttl contains "join-call") or (ttl contains "/call") or (ttl contains "vibeconf")) then
          close w
          set n to n + 1
          exit repeat
        end if
      end repeat
    end try
  end repeat
end tell
return n
APPLESCRIPT
)
    [[ "${swept:-0}" =~ ^[0-9]+$ ]] && (( swept > 0 )) && echo "  • closed $swept agent Terminal window(s)"
  fi
  echo "✓ done"
  exit 0
fi

# Slack launch args: --provider=slack + the channel to auto-join. Each test-slack-N
# profile must be signed into a (distinct) Slack account ONCE first — there's no
# guest path. Do that one-time login via scripts/setup-test-profiles.sh --slack,
# or manually, e.g.:
#   cd electron-app && pnpm dev -- --provider=slack --profile=test-slack-1 \
#     --slack-url=https://app.slack.com/client/<team>/<channel>   # then log in, close
# Test bots are driven by the harness (meet-test.mjs / join-route-test.mjs) over
# MCP, so the auto-spawned Claude agent is pure litter — and nothing reaped it:
# the MCP leave_call path doesn't call closeClaudeTerminal, only window-all-closed
# and the panel's leave-meet do. Every start_call left another Terminal window on
# the machine. A flag rather than an env var because `open -n --args` (below)
# does not pass the parent environment through.
EXTRA_ARGS="--no-agent-terminal=true"
if (( SLACK )); then
  [[ -n "$SLACK_URL" ]] || { echo "✗ --slack needs --slack-url=https://app.slack.com/client/<team>/<channel>"; exit 1; }
  EXTRA_ARGS="$EXTRA_ARGS --provider=slack --slack-url=$SLACK_URL"
fi
# Open detached DevTools on each spawned app (handy for live DOM debugging).
(( DEVTOOLS )) && EXTRA_ARGS="$EXTRA_ARGS --devtools=true"

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
# (the window server reverts those for some instances). Windows keep their natural
# size and are just PLACED at the grid slot (positioning only, no resize). Set
# VIBECONF_NO_WINDOW_GRID=1 to skip (e.g. a headless nightly that ignores placement).
GRID=1
[[ -n "${VIBECONF_NO_WINDOW_GRID:-}" ]] && GRID=0
if (( GRID )); then
  read -r SCRW SCRH <<< "$(osascript -e 'tell application "Finder" to get bounds of window of desktop' 2>/dev/null | awk -F', ' '{print $3, $4}')"
  SCRW=${SCRW:-1512}; SCRH=${SCRH:-982}
  MENUBAR=28
  case $N in
    1) COLS=1; ROWS=1 ;;
    2) COLS=2; ROWS=1 ;;   # 2 bots: SIDE BY SIDE. Stacking looked cleaner on
                           # paper and wasn't: the app window is narrow (~380)
                           # and tall (~666), while a half-screen row is ~477
                           # high — so the lower window opened overlapping the
                           # upper one and sat mostly hidden behind it. Two
                           # ~380-wide windows fit a 1512 display side by side
                           # with room to spare, and both stay fully visible.
    *) COLS=2; ROWS=2 ;;   # 3–4 bots: 2×2 grid
  esac
  CELLW=$(( SCRW / COLS ))
  CELLH=$(( (SCRH - MENUBAR) / ROWS ))
  echo "  • window grid ${SCRW}×${SCRH}: ${COLS}×${ROWS} slots — positioning only (natural size, no resize)"
fi

# Per-run name suffix (MEET ONLY): a SIGKILL'd bot ghosts in the Meet room until
# the ~10min presence TTL, so a fresh run reusing the same names collides with the
# ghost. A unique per-run suffix (e.g. Jimmy-r4af) sidesteps the collision; the
# graceful-leave above is the primary fix, this is belt-and-suspenders for when a
# bot crashed and never left. meet-test resolves its per-name scenario by the BASE
# name (before the last '-'), so the suffixed name still runs the right script.
# Slack identity comes from the signed-in ACCOUNT, not --bot-name, so a suffix
# there would only desync addressivity — skip it. Disable with VIBECONF_NO_RUN_TAG=1.
RUN_TAG=""
if (( ! SLACK )) && [[ -z "${VIBECONF_NO_RUN_TAG:-}" ]]; then
  RUN_TAG=$(printf 'r%x' $RANDOM)   # 15 bits → ~32k values, unique enough within a TTL window
  echo "  • per-run name suffix: -$RUN_TAG (set VIBECONF_NO_RUN_TAG=1 to disable)"
fi

BOTS_ARG=""
# Put every test profile's CLAUDE.md back to the shipped default before the run.
#
# CLAUDE.md is seeded once and never overwritten, so a test profile otherwise
# accumulates whatever anyone left in it and a run depends on history nobody
# remembers. It also keeps the real-agent missions honest about features that
# live in that file (after-call work, #139): the test should read what a fresh
# install gets, not a profile that happens to have been patched.
#
# The script refuses anything not named test-*, so a bad PROFILE_BASE can't
# reach a real bot. Failure is fatal — a run that silently skipped the reset
# would grade the wrong instructions.
for i in $(seq 1 $N); do
  node "$(dirname "$0")/reset-test-profile-instructions.mjs" "${PROFILE_BASE}-$i"
done

for i in $(seq 1 $N); do
  profile="${PROFILE_BASE}-$i"
  port=$((BASE_PORT + i - 1))
  name="${NAMES[$i]}${RUN_TAG:+-$RUN_TAG}"
  # #282: pin this profile's Google account for --google runs (base name, not the
  # run-tagged display name). ${(L)...} is zsh lowercasing.
  ACCT_FLAG=""
  (( GOOGLE )) && ACCT_FLAG="--meet-account-email=${(L)NAMES[$i]}@${GTEST_EMAIL_DOMAIN}"
  WINFLAGS=""
  if (( GRID )); then
    idx=$(( i - 1 ))
    col=$(( idx % COLS ))
    row=$(( idx / COLS ))
    wx=$(( col * CELLW ))
    wy=$(( MENUBAR + row * CELLH ))
    # Position only — do NOT resize. Passing --window-w/-h made each app fill its
    # whole grid cell, which is huge/unhelpful on a large display. Omitting them
    # lets the app open at its natural default size, just placed at the grid slot.
    WINFLAGS="--window-x=$wx --window-y=$wy"
    echo "  • $name — profile=$profile port=$port  @ ${wx},${wy}"
  else
    echo "  • $name — profile=$profile port=$port"
  fi
  # Pin the free macOS voice in the test profile's config. #366 made
  # ttsApiKey APP-LEVEL (shared across profiles), so without this pin the
  # test bots would inherit the real ElevenLabs key and burn quota on every
  # scripted utterance (pre-#366 they had no key and fell back to `say`
  # implicitly). Idempotent merge — preserves whatever else is in the config.
  PROFDIR="$HOME/Library/Application Support/Vibeconferencing/profiles/$profile"
  mkdir -p "$PROFDIR"
  # Also seed onboardingComplete=true: the first-run setup wizard is a
  # focus-stealing modal, and once it can appear for ANY un-onboarded profile
  # (not just the default instance) it would pop up over these freshly-created
  # guest profiles mid-test. Idempotent merge — writes only when something changed.
  node -e 'const fs=require("fs");const p=process.argv[1]+"/config.json";let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}let d=false;if(c.ttsProvider!=="macos-say"){c.ttsProvider="macos-say";d=true;}if(c.onboardingComplete!==true){c.onboardingComplete=true;d=true;}if(d)fs.writeFileSync(p,JSON.stringify(c,null,2));' "$PROFDIR"
  # VIBECONF_REQUIRE_TOKEN=0: #201 made the local-server control API require a
  # Bearer token by default. The agent-less harness drives that API directly and
  # has no token, so with auth on every call returns {"error":"unauthorized"} and
  # the whole run cascades. Test bots are local, isolated, single-purpose — the
  # legacy no-auth server is correct here. (Passed as an ENV var, not a CLI flag,
  # because that's what local-server reads; see the launch notes below for how it
  # reaches each launch mode.)
  if (( PKG )); then
    # Launch the bundle's executable DIRECTLY (not `open -n`) so the env reaches
    # the app: `open -n --args` gets a FRESH LaunchServices environment and drops
    # caller env vars (that's why other test-only config is CLI flags). --profile
    # still bypasses the single-instance lock, so this is a separate instance just
    # like `open -n` gave us. Explicit bundle PATH ("$APP") runs exactly the chosen
    # copy (installed vs built). ${=WINFLAGS}: zsh word-splits into argv entries.
    _exec="$APP/Contents/MacOS/$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"
    VIBECONF_REQUIRE_TOKEN=0 "$_exec" --profile="$profile" --local-port="$port" --bot-name="$name" ${=ACCT_FLAG} ${=WINFLAGS} ${=EXTRA_ARGS} \
      >"/tmp/vibeconf-$profile.log" 2>&1 &
  else
    # Source: pnpm dev inherits the shell env, so the inline var reaches the app.
    nohup zsh -c "cd '$ELECTRON' && VIBECONF_REQUIRE_TOKEN=0 pnpm dev -- --profile=$profile --local-port=$port --bot-name=$name $ACCT_FLAG $WINFLAGS $EXTRA_ARGS" \
      >"/tmp/vibeconf-$profile.log" 2>&1 &
  fi
  BOTS_ARG+="${BOTS_ARG:+,}$name:$port"
done

# Wait for every local-server to come up.
echo "▶ Waiting for local-servers…"
for i in $(seq 1 $N); do
  port=$((BASE_PORT + i - 1))
  for attempt in $(seq 1 40); do
    # -m 5: bound each probe. The socket can be OPEN (server listening) while the
    # app's main thread is wedged (e.g. blocked on a modal dialog) and never
    # responds — without a max-time the readiness loop hangs indefinitely instead
    # of giving up. (Belt-and-suspenders alongside the headless dialog-skip fix.)
    if curl -sf -m 5 "http://127.0.0.1:$port/api/sync/no-room" >/dev/null 2>&1; then
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

# --with-agents (#267 item 5): now that the bot BODIES are up, attach a real
# Claude agent to each (agent-LESS by default). The agents join + run a mission;
# scripts/agent-fuzz-test.mjs waits, collects transcript+log, and LLM-judges.
if (( WITH_AGENTS )); then
  echo ""
  echo "▶ Attaching real agents (--with-agents)…"
  # Build the optional --mission as a proper word array — a ${VAR:+--mission "$VAR"}
  # expansion collapses into ONE arg in zsh, so spawn-agents never sees the flag.
  # (if-form, not `&&` — under `set -e` a false `&&` would exit the script.)
  mission_arg=()
  if [[ -n "$FUZZ_MISSION" ]]; then mission_arg=(--mission "$FUZZ_MISSION"); fi
  node "${0:A:h}/spawn-agents.mjs" --bots "$BOTS_ARG" \
    --room "${FUZZ_ROOM:-paz-sqoa-npe}" "${mission_arg[@]}"
fi
