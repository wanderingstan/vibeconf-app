#!/bin/bash
# vibeconf-attach.sh — one command to land inside your bot's agent session on its
# cloud box.
#
#   vibeconf-attach                 # your default box (VIBECONF_BOX, or "vibeconf-stan")
#   vibeconf-attach seth            # resolves the EC2 Name tag "vibeconf-seth"
#   vibeconf-attach --list          # what boxes exist, and their state
#   vibeconf-attach --sessions      # what tmux sessions are on the box
#   vibeconf-attach --shell         # a plain shell instead of the agent session
#   vibeconf-attach --screen        # tunnel VNC, so you can SEE the app's screen
#   vibeconf-attach --stop          # stop the box (it is costing money while up)
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
    --screen) MODE="screen" ;;
    --stop) MODE="stop" ;;
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

# Stopping is its own mode and never implies starting — otherwise a typo'd
# `--stop` on an already-stopped box would boot it, which is the opposite of
# what someone reaching for that flag wants.
if [ "$MODE" = "stop" ]; then
  case "$STATE" in
    stopped|stopping) echo "→ already $STATE, nothing to do"; exit 0 ;;
  esac
  # A running agent is doing something for someone. Say what is there before
  # pulling the floor out, rather than after.
  LIVE=$(aws_ ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --parameters 'commands=["sudo -u ubuntu tmux ls 2>/dev/null || true"]' \
    --query 'Command.CommandId' --output text 2>/dev/null)
  if [ -n "$LIVE" ]; then
    sleep 4
    OUT=$(aws_ ssm get-command-invocation --command-id "$LIVE" --instance-id "$ID" \
      --query StandardOutputContent --output text 2>/dev/null)
    [ -n "$OUT" ] && { echo "⚠️  sessions currently running on $TAG:"; echo "$OUT" | sed 's/^/     /'; }
  fi
  aws_ ec2 stop-instances --instance-ids "$ID" \
    --query 'StoppingInstances[0].CurrentState.Name' --output text
  exit 0
fi

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

# --screen: SEE the app, not just its agent. Needed for the once-per-box
# interactive logins (vibeconferencing.com + Calendar access, Claude Code),
# which are OAuth flows in a real window and cannot be done from a shell.
#
# The box already runs xvfb + x11vnc + noVNC as systemd services (set up during
# the #324 bring-up), with x11vnc bound to LOOPBACK — so it is not reachable
# from the internet and must be tunnelled. This forwards it over SSM: no inbound
# port, no SSH key, no IP allowlist entry to churn when you change locations.
if [ "$MODE" = "screen" ]; then
  LOCAL_PORT="${VIBECONF_VNC_LOCAL_PORT:-5900}"
  echo "→ forwarding $TAG:5900 → localhost:$LOCAL_PORT over SSM"
  echo "→ then, in another terminal or Finder:"
  echo "     open vnc://localhost:$LOCAL_PORT      (macOS Screen Sharing)"
  echo "   the VNC password is in ~/.vnc/passwd on the box (set at bring-up)"
  echo "→ Ctrl-C here closes the tunnel"
  exec aws_ ssm start-session --target "$ID" \
    --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"5900\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
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
