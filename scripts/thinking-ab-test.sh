#!/bin/zsh
# thinking-ab-test.sh — A/B the agent's extended-thinking budget against response
# latency (#responsiveness; proposed by Gabriel on the 2026-08-10 call).
#
# Hypothesis: for quick conversational turns, hidden reasoning rarely earns its
# seconds — capping (or effectively disabling) the thinking budget should cut
# leg D (resolve→first speak) without hurting the LLM-judge verdict.
#
# How it works: the real-agent fuzz harness (`agent-fuzz-test.mjs`) spawns
# `claude` directly from this process tree, so environment flows through —
# `CLAUDE_EFFORT` set here reaches every test agent (spawn-agents.mjs spreads
# process.env). No app changes needed. Effort is the supported thinking knob:
# MAX_THINKING_TOKENS exists but is buggy (forces thinking on every request —
# anthropics/claude-code#5257), so arms are effort levels, not token caps.
# (App-spawned production agents strip CLAUDE_EFFORT via agent-spawn.js's
# denylist; the fuzz path deliberately does not, which is what makes this A/B
# possible without app changes.)
#
# Each arm runs the same mission; after each arm the test profiles'
# fresh session logs are snapshotted into a per-arm folder, and latency-audit.py
# prints one table per arm at the end. Compare the `D claude` rows (and the
# judge PASS/FAIL in each arm's fuzz-test output) to read the result.
#
# Usage:
#   scripts/thinking-ab-test.sh                       # arms: control + low
#   scripts/thinking-ab-test.sh --arms control,low,medium
#   scripts/thinking-ab-test.sh --mission smoke --duration 240 --runs 3
#
#   --arms      comma list: "control" (env unset) and/or CLAUDE_EFFORT levels (low|medium|high)
#   --mission   agent-missions.mjs key (default: smoke)
#   --duration  seconds per run (default: 180)
#   --runs      repeats per arm (default: 1; latency stats want >=3)
#
# One arm at a time, sequentially — the arms share the test fleet ports.

set -e
setopt null_glob

REPO="${0:A:h:h}"
ARMS="control,low"
MISSION="smoke"
DURATION=180
RUNS=1
for a in "$@"; do
  case "$prev" in
    --arms) ARMS="$a" ;;
    --mission) MISSION="$a" ;;
    --duration) DURATION="$a" ;;
    --runs) RUNS="$a" ;;
  esac
  prev="$a"
done

STAMP=$(date +%Y%m%dT%H%M%S)
OUT="$HOME/vibeconf-test-results/thinking-ab/$STAMP"
mkdir -p "$OUT"
PROFILES="$HOME/Library/Application Support/Vibeconferencing/profiles"

echo "▶ thinking A/B — arms: $ARMS, mission: $MISSION, ${DURATION}s x $RUNS run(s)/arm"
echo "  results → $OUT"

for arm in ${(s:,:)ARMS}; do
  ARM_DIR="$OUT/$arm"
  mkdir -p "$ARM_DIR"
  if [[ "$arm" == "control" ]]; then
    unset CLAUDE_EFFORT
    echo "\n━━ arm: control (CLAUDE_EFFORT unset) ━━"
  else
    export CLAUDE_EFFORT="$arm"
    echo "\n━━ arm: CLAUDE_EFFORT=$arm ━━"
  fi

  for run in $(seq 1 $RUNS); do
    MARK=$(date +%s)
    echo "— run $run/$RUNS —"
    node "$REPO/scripts/agent-fuzz-test.mjs" --mission "$MISSION" --duration "$DURATION" \
      2>&1 | tee -a "$ARM_DIR/fuzz-run-$run.log" || echo "  (run $run reported failure — logs kept)"
    # Snapshot session logs written since this run started, from every test profile.
    for f in "$PROFILES"/test-*/logs/session-*.log; do
      [[ $(stat -f %m "$f") -ge $MARK ]] && cp "$f" "$ARM_DIR/$(basename ${f:h:h})-$(basename $f)"
    done
  done
  echo "  arm '$arm' session logs: $(ls "$ARM_DIR" | grep -c 'session-' || true)"
done

echo "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Latency per arm (compare the 'D claude' rows):"
for arm in ${(s:,:)ARMS}; do
  echo "\n═══ arm: $arm ═══"
  python3 "$REPO/scripts/latency-audit.py" "$OUT/$arm"/*session-*.log || echo "  (no cycles captured)"
done
echo "\nJudge verdicts: grep -h 'PASS\\|FAIL' $OUT/*/fuzz-run-*.log"
