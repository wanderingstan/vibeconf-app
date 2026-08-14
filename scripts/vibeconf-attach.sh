#!/bin/bash
# vibeconf-attach.sh — one command to land inside your bot's agent session on its
# cloud box.
#
#   vibeconf-attach                 # your default box (VIBECONF_BOX, or "vibeconf-stan")
#   vibeconf-attach seth            # resolves the EC2 Name tag "vibeconf-seth"
#   vibeconf-attach --list          # what boxes exist, and their state
#   vibeconf-attach --sessions      # what tmux sessions are on the box
#   vibeconf-attach --shell         # a plain shell instead of the agent session
#   vibeconf-attach --no-start      # refuse to start a stopped box
#
# WHY SSM AND NOT SSH: no inbound port, no key to hand around, no IP allowlist to
# churn every time someone moves between home and a coffee shop — access is IAM,
# so adding a person is a policy change and removing them is too. The box's SSH
# allowlist holds ONE /32 at a time and scripts/cloud-ta-allow-ip.sh replaces it
# by default, which means two people using it lock each other out. That does not
# scale past one human, and this is meant for several.
#
# WHY tmux: the agent runs inside a tmux session (linuxAgentTmux, #329), so this
# attaches to the SAME live session the bot is being driven by. You see what it is
# doing and you can type at it — which is the whole point, and the thing headless
# agent hosting cannot offer. Detach with Ctrl-B then D; the agent keeps running.
set -uo pipefail

REGION="${VIBECONF_AWS_REGION:-us-east-2}"
PROFILE_AWS="${VIBECONF_AWS_PROFILE:-vibeconf-ta}"
DEFAULT_BOX="${VIBECONF_BOX:-vibeconf-stan}"

aws_() { aws --profile "$PROFILE_AWS" --region "$REGION" "$@"; }
die() { echo "vibeconf-attach: $*" >&2; exit 1; }

MODE="attach"; BOX=""; ALLOW_START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --sessions) MODE="sessions" ;;
    --shell) MODE="shell" ;;
    --no-start) ALLOW_START=0 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) BOX="$1" ;;
  esac
  shift
done

if [ "$MODE" = "list" ]; then
  # Every vibeconf-* box, so "which ones exist and are any of them costing me
  # money right now" is one command rather than a console visit.
  aws_ ec2 describe-instances --filters "Name=tag:Name,Values=vibeconf-*" \
    --query 'Reservations[].Instances[].{Name:Tags[?Key==`Name`]|[0].Value,State:State.Name,Id:InstanceId,Type:InstanceType}' \
    --output table
  exit 0
fi

BOX="${BOX:-$DEFAULT_BOX}"
# Accept a bare name ("seth") or the full tag ("vibeconf-seth"), because both are
# what people will actually type.
case "$BOX" in vibeconf-*) TAG="$BOX" ;; *) TAG="vibeconf-$BOX" ;; esac

ID=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | awk '{print $1}')
[ -n "$ID" ] || die "no instance tagged Name=$TAG (try --list)"

STATE=$(aws_ ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
echo "→ $TAG ($ID) is $STATE"

if [ "$STATE" != "running" ]; then
  [ "$ALLOW_START" = "1" ] || die "$TAG is $STATE and --no-start was given"
  echo "→ starting it (takes ~40s, then SSM needs a moment to register)"
  aws_ ec2 start-instances --instance-ids "$ID" >/dev/null || die "could not start $TAG"
  aws_ ec2 wait instance-running --instance-ids "$ID" || die "$TAG never reached running"
fi

# SSM registration lags "running" — the agent has to dial out and get credentials
# from its instance profile. Poll rather than sleep a guess.
printf '→ waiting for SSM'
ONLINE=""
for _ in $(seq 1 30); do
  ONLINE=$(aws_ ssm describe-instance-information --filters "Key=InstanceIds,Values=$ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  [ "$ONLINE" = "Online" ] && break
  printf '.'; sleep 5
done
echo
[ "$ONLINE" = "Online" ] || die "$TAG never came Online in SSM (instance profile missing, or the agent is unhappy)"

if [ "$MODE" = "shell" ]; then
  exec aws_ ssm start-session --target "$ID"
fi

# Which tmux session? DISCOVERED, not guessed: the name is
# vibeconf-<profile>-<port> (see linux-terminal.js), and a box can run more than
# one profile. Asking the box is the only way to be right.
LIST_CMD=$(aws_ ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["sudo -u ubuntu tmux ls 2>/dev/null || true"]' \
  --query 'Command.CommandId' --output text 2>/dev/null)
[ -n "$LIST_CMD" ] || die "ssm send-command failed (does this identity have ssm:SendCommand on $ID?)"
SESSIONS=""
for _ in $(seq 1 15); do
  ST=$(aws_ ssm get-command-invocation --command-id "$LIST_CMD" --instance-id "$ID" --query Status --output text 2>/dev/null)
  case "$ST" in Success|Failed|TimedOut|Cancelled) break ;; esac
  sleep 2
done
SESSIONS=$(aws_ ssm get-command-invocation --command-id "$LIST_CMD" --instance-id "$ID" \
  --query StandardOutputContent --output text 2>/dev/null)

if [ "$MODE" = "sessions" ]; then
  [ -n "$SESSIONS" ] && echo "$SESSIONS" || echo "(no tmux sessions on $TAG)"
  exit 0
fi

TARGET=$(printf '%s\n' "$SESSIONS" | grep -o '^vibeconf-[^:]*' | head -1)
if [ -z "$TARGET" ]; then
  echo "No agent session on $TAG yet."
  echo "  The session appears when the bot joins a call, and only when"
  echo "  linuxAgentTmux is ON for that box (it is off by default — #329)."
  echo "  Use --shell to get a plain shell, or --sessions to see what is there."
  exit 3
fi

echo "→ attaching to $TARGET   (detach with Ctrl-B then D — the agent keeps running)"
# sudo -u ubuntu because SSM lands as root while the app, and therefore the tmux
# session, belongs to ubuntu. Without it you get "no server running".
exec aws_ ssm start-session --target "$ID" \
  --document-name AWS-StartInteractiveCommand \
  --parameters "{\"command\":[\"sudo -u ubuntu tmux attach -t $TARGET\"]}"
