#!/bin/bash
# nightly-linux-lane.sh — the Linux lane of the nightly, driven from the Mac mini.
#
# Starts the cloud-TA EC2 box, runs the agent-terminal check on it over SSM,
# stops it again, and writes one JSONL line the digest can read. Everything the
# other lanes get (Telegram digest, the global watchdog, retention) comes for
# free by being a lane rather than a separate cron.
#
# WHY SSM AND NOT SSH: the box's SSH allowlist holds one /32 at a time, and
# scripts/cloud-ta-allow-ip.sh REPLACES it by default. With more than one person
# (or a laptop that moves), whoever ran it last locks everyone else out — and the
# mini running nightly would be locked out by a human at a coffee shop. SSM has
# no inbound port and no allowlist: the agent dials out, and access is IAM.
#
# WHAT IT TESTS, and what it deliberately does not: NOT the unit suite. Since
# #363 that runs on ubuntu-latest for every PR, so a nightly copy would repeat
# CI a day later. This runs the part no GitHub runner can: Electron under Xvfb,
# a real call, a real agent process in a real terminal (#329) — the path the
# cloud TA (#324) depends on.
#
# Requires on the mini: awscli, and credentials for the vibeconf-ta profile with
# ssm:SendCommand + ec2:Start/StopInstances + ec2:DescribeInstances.
set -uo pipefail

PROFILE_AWS="${VIBECONF_AWS_PROFILE:-vibeconf-ta}"
REGION="${VIBECONF_AWS_REGION:-us-east-2}"
INSTANCE="${VIBECONF_TA_INSTANCE:-i-0e7b0ce1bbafe24d0}"
RESULTS="${VIBECONF_RESULTS_DIR:-$HOME/vibeconf-test-results}"
STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUT="$RESULTS/linux-results.jsonl"
mkdir -p "$RESULTS"

aws_() { aws --profile "$PROFILE_AWS" --region "$REGION" "$@"; }

# Record a result no matter how we exit. A lane that dies silently is a lane
# nobody reads — the digest must say something even when the orchestration, not
# the app, is what broke.
started_by_us=0
exit_code=1
fails=1
note="did not run"
record() {
  printf '{"ts":"%s","exit":%s,"fails":%s,"note":"%s"}\n' \
    "$STAMP" "${exit_code:-1}" "${fails:-1}" "${note//\"/}" >> "$OUT"
}
finish() {
  # Only stop the box if WE started it. Someone may be working on it — pulling
  # the floor out from under a human debugging session is worse than an idle
  # t3.large overnight, and the cost of one extra hour is pennies.
  if [ "$started_by_us" = "1" ]; then
    echo "=== stopping $INSTANCE (we started it) ==="
    aws_ ec2 stop-instances --instance-ids "$INSTANCE" --query 'StoppingInstances[0].CurrentState.Name' --output text 2>/dev/null
  else
    echo "=== leaving $INSTANCE running (it was already up before this lane) ==="
  fi
  record
}
trap finish EXIT

state=$(aws_ ec2 describe-instances --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null)
echo "=== $INSTANCE is $state ==="
if [ "$state" != "running" ]; then
  started_by_us=1
  aws_ ec2 start-instances --instance-ids "$INSTANCE" --query 'StartingInstances[0].CurrentState.Name' --output text || {
    note="could not start the instance"; exit_code=70; exit 70; }
  aws_ ec2 wait instance-running --instance-ids "$INSTANCE" || {
    note="instance never reached running"; exit_code=71; exit 71; }
fi

# SSM registration lags the instance being "running" — the agent has to dial out
# and get credentials. Poll rather than sleep a guessed amount.
echo "=== waiting for SSM to report the instance Online ==="
online=""
for _ in $(seq 1 30); do
  online=$(aws_ ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  [ "$online" = "Online" ] && break
  sleep 10
done
[ "$online" = "Online" ] || { note="SSM never came Online (agent or IAM role problem)"; exit_code=72; exit 72; }
echo "=== SSM Online ==="

# Pull current main, then run BOTH shapes: default (plain terminal) and the
# opt-in tmux wrapper. They exercise different code paths in linux-terminal.js
# and a regression in either is worth a red lane.
# The remote body. Two constraints learned by hitting them:
#
#   1. AWS-RunShellScript executes with /bin/sh (dash), NOT bash, so the outer
#      layer must stay POSIX — `set -o pipefail` here is an "Illegal option"
#      error, not a no-op. Bash-isms live inside the `bash -lc` below.
#   2. It runs as root, while the app, its config and the clone are owned by
#      ubuntu — hence sudo -u ubuntu, with -l so the login shell puts pnpm and
#      node on PATH.
REMOTE_SCRIPT=$(cat <<'REMOTE'
set -u
sudo -u ubuntu bash -lc '
  cd ~/vibeconf-app || exit 90
  git fetch -q origin main && git checkout -q main && git reset -q --hard origin/main || exit 91
  cd electron-app && pnpm install --ignore-scripts >/dev/null 2>&1
  cd ~/vibeconf-app
  chmod +x scripts/linux-agent-terminal-check.sh
  echo "### commit: $(git log --oneline -1)"
  echo "### ---- direct shape ----"
  bash scripts/linux-agent-terminal-check.sh; d=$?
  echo "### ---- tmux shape ----"
  bash scripts/linux-agent-terminal-check.sh --tmux; t=$?
  echo "### direct_exit=$d tmux_exit=$t"
  [ "$d" -eq 0 ] && [ "$t" -eq 0 ]
'
REMOTE
)

# Build the parameters as a FILE rather than a shell-quoted argument. Passing
# JSON inline meant the script's newlines crossed a shell layer and arrived
# mangled (the first two lines ran together as "pipefailnsudo"), which presents
# as a nonsense syntax error on the remote rather than as a quoting bug here.
PARAMS_FILE=$(mktemp -t vibeconf-ssm-params)
node -e '
  const fs = require("fs");
  fs.writeFileSync(process.argv[2], JSON.stringify({ commands: [process.argv[1]] }));
' "$REMOTE_SCRIPT" "$PARAMS_FILE"

cmd_id=$(aws_ ssm send-command --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --timeout-seconds 600 \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text 2>/dev/null)
rm -f "$PARAMS_FILE"
[ -n "$cmd_id" ] || { note="ssm send-command failed"; exit_code=73; exit 73; }
echo "=== ssm command $cmd_id ==="

status="Pending"
for _ in $(seq 1 60); do
  status=$(aws_ ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE" \
    --query 'Status' --output text 2>/dev/null)
  case "$status" in Success|Failed|TimedOut|Cancelled) break;; esac
  sleep 10
done

out=$(aws_ ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE" \
  --query 'StandardOutputContent' --output text 2>/dev/null)
err=$(aws_ ssm get-command-invocation --command-id "$cmd_id" --instance-id "$INSTANCE" \
  --query 'StandardErrorContent' --output text 2>/dev/null)
echo "$out"
[ -n "$err" ] && echo "--- stderr ---" && echo "$err"

# Sum the FAIL lines from both shapes so the digest can say how bad it was,
# rather than just red/green.
fails=$(printf '%s' "$out" | grep -c '^FAIL:' || true)
case "$status" in
  Success) exit_code=0; note="both shapes passed" ;;
  TimedOut) exit_code=74; note="ssm command timed out" ;;
  *) exit_code=1; note="$(printf '%s' "$out" | grep -m1 '^FAIL:' || echo "check failed")" ;;
esac
echo "=== linux lane: status=$status exit=$exit_code fails=$fails ==="
exit "$exit_code"
