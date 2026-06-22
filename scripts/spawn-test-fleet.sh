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
#   scripts/spawn-test-fleet.sh            # 2 bots (Jimmy, Samantha)
#   scripts/spawn-test-fleet.sh 3          # 3 bots (adds Cosmo)
#   scripts/spawn-test-fleet.sh 2 --kill   # stop a previously-spawned fleet
#
# Prints the --bots string to hand to meet-test.mjs.
#
# NOTE on Google sign-in: a fresh test profile starts LOGGED OUT → the bot joins
# as a guest and the meet host must admit it (and it may hit the guest-view
# captions path). For unattended auto-admit, sign each test profile into Google
# ONCE (it persists, post-beta21): launch one, open the app, Settings → "Sign in
# to Google as bot". Do this per profile the first time.

set -e
REPO="/Users/wanderingstan/Developer/vibeconferencing"
ELECTRON="$REPO/electron-app"
NAMES=(Jimmy Samantha Cosmo Dizzy)        # display names by index
BASE_PORT=7901

N="${1:-2}"
if ! [[ "$N" =~ '^[0-9]+$' ]]; then echo "usage: $0 [count] [--kill]"; exit 1; fi
if (( N < 1 || N > 4 )); then echo "count must be 1–4"; exit 1; fi

# --kill: stop instances on the test ports.
if [[ "$2" == "--kill" ]]; then
  echo "▶ Stopping test fleet…"
  for i in $(seq 1 $N); do
    port=$((BASE_PORT + i - 1))
    pid=$(lsof -ti tcp:$port 2>/dev/null || true)
    if [[ -n "$pid" ]]; then echo "  • killing pid $pid on $port"; kill "$pid" 2>/dev/null || true; fi
  done
  echo "✓ done"
  exit 0
fi

echo "▶ Spawning $N test bot(s) — agent-less, isolated profiles"
BOTS_ARG=""
for i in $(seq 1 $N); do
  profile="test$i"
  port=$((BASE_PORT + i - 1))
  name="${NAMES[$i]}"
  echo "  • $name — profile=$profile port=$port"
  nohup zsh -c "cd '$ELECTRON' && pnpm dev -- --profile=$profile --local-port=$port --bot-name=$name" \
    >"/tmp/vibeconf-$profile.log" 2>&1 &
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
