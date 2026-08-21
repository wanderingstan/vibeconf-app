#!/bin/bash
# vibeconf-attach.sh — one command to land inside your bot's agent session on its
# cloud box.
#
#   vibeconf-attach                 # your default box (VIBECONF_BOX, or "vibeconf-stan")
#   vibeconf-attach seth            # resolves the EC2 Name tag "vibeconf-seth"
#   vibeconf-attach --list          # what boxes exist, and their state
#   vibeconf-attach --sessions      # what tmux sessions are on the box
#   vibeconf-attach --shell         # a shell on the box, as the bot's user (ubuntu)
#   vibeconf-attach --shell-raw     # ...as ssm-user instead (rarely what you want)
#   vibeconf-attach --run 'CMD'     # run CMD on the box, print its output, exit its code
#   vibeconf-attach seth --run 'CMD'  # box name comes BEFORE --run
#   vibeconf-attach --screen        # see the app's screen, in your browser (noVNC)
#   vibeconf-attach --screen-vnc    # same, but for a native VNC client on :5900
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

MODE="attach"; BOX=""; ALLOW_START=1; RUN_CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE="list" ;;
    --sessions) MODE="sessions" ;;
    --shell) MODE="shell" ;;
    --shell-raw) MODE="shell-raw" ;;
    # Everything after --run is the remote command, so it must come last. The
    # `break` skips the loop's trailing shift, which would eat the first word.
    --run) MODE="run"; shift; RUN_CMD="$*"; break ;;
    --screen) MODE="screen" ;;
    --screen-vnc) MODE="screen-vnc" ;;
    --stop) MODE="stop" ;;
    --no-start) ALLOW_START=0 ;;
    # Print the header comment down to the first "WHY" section, rather than a
    # hardcoded line range: adding a mode used to silently push the last one out
    # of --help while dragging in three lines of unrelated prose.
    -h|--help)
      awk 'NR==1 {next} /^# WHY/ {exit} /^#/ {sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0 ;;
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

# ALL matches, not the first one. This used to `awk '{print $1}'` and silently
# take whichever came back first — which went wrong the moment two instances
# shared a Name tag (a second vibeconf-stan was launched by mistake, and this
# quietly picked the older one and then reported it as unreachable). Picking
# arbitrarily between two machines someone might be working on is worse than
# refusing, so an ambiguous name is now a hard stop that shows the candidates.
IDS=$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$')
COUNT=$(printf '%s\n' "$IDS" | grep -c . || true)
[ "$COUNT" -ge 1 ] || die "no instance tagged Name=$TAG (try --list)"
if [ "$COUNT" -gt 1 ]; then
  echo "vibeconf-attach: $COUNT instances are tagged Name=$TAG:" >&2
  aws_ ec2 describe-instances --instance-ids $IDS \
    --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,Launched:LaunchTime}' \
    --output table >&2
  die "ambiguous — retag or terminate one, or pass the instance id directly"
fi
ID=$(printf '%s\n' "$IDS" | head -1)

STATE=$(aws_ ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text)
echo "→ $TAG ($ID) is $STATE" >&2

# Stopping is its own mode and never implies starting — otherwise a typo'd
# `--stop` on an already-stopped box would boot it, which is the opposite of
# what someone reaching for that flag wants.
if [ "$MODE" = "stop" ]; then
  case "$STATE" in
    stopped|stopping) echo "→ already $STATE, nothing to do" >&2; exit 0 ;;
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
  echo "→ starting it (takes ~40s, then SSM needs a moment to register)" >&2
  aws_ ec2 start-instances --instance-ids "$ID" >/dev/null || die "could not start $TAG"
  aws_ ec2 wait instance-running --instance-ids "$ID" || die "$TAG never reached running"
fi

# SSM registration lags "running" — the agent has to dial out and get credentials
# from its instance profile. Poll rather than sleep a guess.
printf '→ waiting for SSM' >&2
ONLINE=""
for _ in $(seq 1 30); do
  ONLINE=$(aws_ ssm describe-instance-information --filters "Key=InstanceIds,Values=$ID" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)
  [ "$ONLINE" = "Online" ] && break
  printf '.' >&2; sleep 5
done
echo >&2
[ "$ONLINE" = "Online" ] || die "$TAG never came Online in SSM (instance profile missing, or the agent is unhappy)"

# A shell AS THE BOT'S USER, not as ssm-user.
#
# SSM behaves differently by path, and the difference bites: `ssm send-command`
# runs as ROOT, while `ssm start-session` lands as SSM-USER. Neither is `ubuntu`,
# which is who owns the app, its config, its tmux sessions and its agent.
#
# Landing in /home/ssm-user meant `cat ~/.vnc/plain` failed, and — worse — the
# documented "run claude once to sign in" step would have authenticated
# ssm-user, leaving the bot itself still signed out with no obvious symptom.
#
# So drop straight into a login shell as ubuntu. -i gives the right HOME, PATH
# and profile, so anything typed here affects the bot rather than a bystander
# account. Use --shell-raw for the ssm-user shell if you ever genuinely want it.
if [ "$MODE" = "shell" ]; then
  exec aws --profile "$PROFILE_AWS" --region "$REGION" ssm start-session --target "$ID" \
    --document-name AWS-StartInteractiveCommand \
    --parameters '{"command":["sudo -u ubuntu -i"]}'
fi

if [ "$MODE" = "shell-raw" ]; then
  echo "→ raw ssm-user shell (NOT the bot's user — see --shell)" >&2
  exec aws --profile "$PROFILE_AWS" --region "$REGION" ssm start-session --target "$ID"
fi

# --run: one-shot command, output captured, exit code propagated.
#
# WHY THIS EXISTS SEPARATELY FROM --shell: --shell is an interactive SSM session
# with a TTY. A person can use it; an AGENT cannot — there is no way to feed it a
# command and read the result. Agents driving these boxes (the expected case:
# "check the log on my box", "restart the app") need exec-and-capture, which is a
# different SSM API entirely (send-command, not start-session).
#
# Four traps, all of which bit us during the #324/#329 bring-up:
#
#  1. send-command runs as ROOT, while start-session lands as ssm-user, and
#     NEITHER is `ubuntu` (who owns the app, its config and its Claude login).
#     So this re-enters as ubuntu with a login shell, matching --shell exactly.
#     Without that, `--run 'claude ...'` would silently drive the wrong account.
#  2. AWS-RunShellScript executes under dash, not bash. The outer wrapper below
#     is POSIX-only; the user's command is handed to bash explicitly.
#  3. Inline --parameters JSON mangles newlines (we once got `pipefailnsudo`),
#     so the command goes over as base64 and the JSON is passed via file://.
#  4. SSM caps captured output at ~24KB and truncates SILENTLY — a truncated
#     result reads exactly like a complete one. We detect and say so.
if [ "$MODE" = "run" ]; then
  [ -n "$RUN_CMD" ] || die "--run needs a command, e.g. --run 'systemctl status vibeconf-app'"

  B64=$(printf '%s' "$RUN_CMD" | base64 | tr -d '\n')
  PARAMS=$(mktemp -t vibeconf-run)
  trap 'rm -f "$PARAMS"' EXIT
  R="/tmp/vibeconf-run.$$.sh"
  # printf '%s\n' with multiple args emits each followed by a LITERAL \n, which
  # is what JSON wants. B64 is [A-Za-z0-9+/=] so it needs no escaping.
  SCRIPT=$(printf '%s\\n' \
    "echo '$B64' | base64 -d > $R" \
    "chown ubuntu $R && chmod 700 $R" \
    "sudo -u ubuntu -i bash $R; rc=\$?" \
    "rm -f $R" \
    "exit \$rc")
  printf '{"commands":["%s"]}' "$SCRIPT" > "$PARAMS"

  CID=$(aws_ ssm send-command --instance-ids "$ID" \
    --document-name AWS-RunShellScript --timeout-seconds 600 \
    --parameters "file://$PARAMS" --query 'Command.CommandId' --output text) \
    || die "could not send the command (is the box running? try --list)"

  # Poll rather than sleep a fixed guess: a `uptime` returns in a second, an
  # `apt install` takes minutes, and a fixed wait is wrong for both.
  for _ in $(seq 1 200); do
    STATUS=$(aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$ID" \
      --query 'Status' --output text 2>/dev/null || echo Pending)
    case "$STATUS" in InProgress|Pending|Delayed) sleep 2 ;; *) break ;; esac
  done

  OUT=$(aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$ID" \
    --query 'StandardOutputContent' --output text 2>/dev/null)
  ERR=$(aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$ID" \
    --query 'StandardErrorContent' --output text 2>/dev/null)
  RC=$(aws_ ssm get-command-invocation --command-id "$CID" --instance-id "$ID" \
    --query 'ResponseCode' --output text 2>/dev/null)

  [ -n "$OUT" ] && printf '%s\n' "$OUT"
  [ -n "$ERR" ] && printf '%s\n' "$ERR" >&2
  # Trap 4. 24000 is SSM's documented cap; at or above it, assume truncation.
  if [ "${#OUT}" -ge 24000 ] || [ "${#ERR}" -ge 24000 ]; then
    echo "vibeconf-attach: OUTPUT TRUNCATED at SSM's ~24KB limit — redirect to a file on the box and fetch it in pieces." >&2
  fi
  case "$STATUS" in
    Success|Failed) ;;
    *) echo "vibeconf-attach: command ended as $STATUS" >&2 ;;
  esac
  # Propagate the remote exit code, so `&&` chains and agent tooling behave.
  case "$RC" in ''|*[!0-9]*) exit 1 ;; *) exit "$RC" ;; esac
fi

# --screen: SEE the app, not just its agent. Needed for the once-per-box
# interactive logins (vibeconferencing.com + Calendar access, Claude Code),
# which are OAuth flows in a real window and cannot be done from a shell.
#
# The box already runs xvfb + x11vnc + noVNC as systemd services (set up during
# the #324 bring-up), with x11vnc bound to LOOPBACK — so it is not reachable
# from the internet and must be tunnelled. This forwards it over SSM: no inbound
# port, no SSH key, no IP allowlist entry to churn when you change locations.
# --screen defaults to noVNC IN A BROWSER, not a native VNC client, because
# macOS Screen Sharing REFUSES a tunnelled connection: pointed at
# vnc://localhost:5900 it decides you are connecting to your own Mac and says
# "You cannot control your own screen." The guard is on the ADDRESS, so no
# choice of local port gets around it.
#
# The box already runs noVNC (websockify on 127.0.0.1:6080 in front of the VNC
# server), so tunnelling 6080 and opening a browser avoids the client question
# altogether — and needs nothing installed on the Mac.
if [ "$MODE" = "screen" ]; then
  LOCAL_PORT="${VIBECONF_WEB_LOCAL_PORT:-6080}"
  URL="http://localhost:$LOCAL_PORT/vnc.html?host=localhost&port=$LOCAL_PORT"
  echo "→ forwarding $TAG:6080 (noVNC) → localhost:$LOCAL_PORT over SSM"
  echo "→ opening $URL"
  echo "   password: in ~/.vnc/passwd on the box (set at bring-up)"
  echo "→ Ctrl-C here closes the tunnel"
  # WAIT for the port to actually accept a connection before opening the
  # browser. This was `sleep 4`, and 4s is not enough for SSM to negotiate the
  # session — the browser opened first and showed ERR_CONNECTION_REFUSED, which
  # looks like a broken tunnel rather than an early one. Poll, then open, and
  # say so if it never comes up. Backgrounded so the exec below still owns the
  # terminal and Ctrl-C still closes the tunnel.
  (
    for _ in $(seq 1 40); do
      if nc -z localhost "$LOCAL_PORT" 2>/dev/null; then
        command -v open >/dev/null && open "$URL"
        exit 0
      fi
      sleep 1
    done
    echo "" >&2
    echo "vibeconf-attach: the tunnel never came up on localhost:$LOCAL_PORT." >&2
    echo "  If the line below shows an error, that is the real problem." >&2
  ) &
  exec aws --profile "$PROFILE_AWS" --region "$REGION" ssm start-session --target "$ID" \
    --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"6080\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
fi

# For a REAL VNC client (RealVNC, TigerVNC — not macOS Screen Sharing, see
# above). Kept because a native client handles clipboard and scaling better than
# the browser does.
if [ "$MODE" = "screen-vnc" ]; then
  LOCAL_PORT="${VIBECONF_VNC_LOCAL_PORT:-5901}"
  echo "→ forwarding $TAG:5900 → localhost:$LOCAL_PORT over SSM"
  echo "→ point a VNC client at localhost:$LOCAL_PORT"
  echo "   NOTE: macOS Screen Sharing.app will refuse this (\"cannot control your"
  echo "   own screen\") — it rejects localhost regardless of port. Use --screen,"
  echo "   or a third-party client."
  echo "   password: in ~/.vnc/passwd on the box"
  echo "→ Ctrl-C here closes the tunnel"
  exec aws --profile "$PROFILE_AWS" --region "$REGION" ssm start-session --target "$ID" \
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
exec aws --profile "$PROFILE_AWS" --region "$REGION" ssm start-session --target "$ID" \
  --document-name AWS-StartInteractiveCommand \
  --parameters "{\"command\":[\"sudo -u ubuntu tmux attach -t $TARGET\"]}"
