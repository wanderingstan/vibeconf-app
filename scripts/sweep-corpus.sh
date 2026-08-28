#!/usr/bin/env bash
# sweep-corpus.sh — re-run the #422 detector sweep across every archived call.
#
# The tooling for this already existed (score-speaking / label-tracks /
# pool-speaking-scores). What did not exist was a way to point it at the WHOLE
# archive unattended, which is the only way a constant gets chosen on a corpus
# rather than on whichever call someone happened to look at.
#
# Designed to be run by launchd at 04:00 on the machine that physically holds
# the drive. Everything here is defensive about that: it is going to run while
# nobody is watching, and the failure mode to avoid is scoring nothing and
# saying it went fine.
#
#   ./scripts/sweep-corpus.sh [--calls DIR] [--out DIR] [--limit N] [--dry-run]
set -uo pipefail

CALLS="${VIBECONF_CALLS_DIR:-/Volumes/StanBook5-2022/Vibeconferencing/calls}"
OUT="${VIBECONF_SWEEP_OUT:-$HOME/vibeconf-sweeps}"
LIMIT=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --calls) CALLS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%dT%H%M%S)"
RUN="$OUT/$STAMP"
mkdir -p "$RUN"
LOG="$RUN/sweep.log"
say() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }

say "sweep-corpus starting"
say "  repo   $ROOT"
say "  calls  $CALLS"
say "  out    $RUN"

# Bail LOUDLY on a missing corpus. This runs at 4am against an external drive:
# an unmounted disk is the single most likely reason for a silent no-op, and a
# run that scores zero calls must not look like a run that found nothing to fix.
if [ ! -d "$CALLS" ]; then
  say "FATAL: calls directory not found — is the drive mounted?"
  exit 1
fi
n_avail=$(find "$CALLS" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$n_avail" -eq 0 ]; then
  say "FATAL: $CALLS is empty — refusing to report an empty sweep as success"
  exit 1
fi
say "  $n_avail call folder(s) visible"

scored=0; skipped=0; failed=0
for dir in "$CALLS"/*/; do
  [ "$LIMIT" -gt 0 ] && [ "$scored" -ge "$LIMIT" ] && break
  call="$(basename "$dir")"
  events="$dir/speaking-events.jsonl"

  if [ ! -s "$events" ]; then
    skipped=$((skipped+1)); echo "  skip $call — no speaking-events" >> "$LOG"; continue
  fi
  # Per-speaker audio is what makes ground truth possible. Without the tracks
  # there is nothing to label against, and scoring against our own detectors
  # would just be comparing them to each other — the exact ceiling #422 exists
  # to break.
  tracks="$(find "$dir" -maxdepth 1 -type d -name 'call-recording-tracks*' | head -1)"
  if [ -z "$tracks" ]; then
    skipped=$((skipped+1)); echo "  skip $call — no per-speaker tracks" >> "$LOG"; continue
  fi

  labels="$RUN/$call.labels.json"
  if [ "$DRY" = 1 ]; then
    say "  would score $call"
    scored=$((scored+1)); continue
  fi

  audio=$(find "$tracks" -maxdepth 1 -name '*.webm' ! -name 'video.webm' ! -name 'share*.webm' | sort)
  if [ -z "$audio" ]; then
    skipped=$((skipped+1)); echo "  skip $call — tracks dir has no per-speaker audio" >> "$LOG"; continue
  fi

  say "  labelling $call"
  # shellcheck disable=SC2086
  if ! node "$ROOT/scripts/label-tracks.mjs" $audio --out "$labels" >> "$LOG" 2>&1; then
    failed=$((failed+1)); say "  FAILED labelling $call"; continue
  fi

  # --map is NOT optional here, and getting it wrong fails SILENTLY-ish: the
  # scorer prints "no events for this participant" per track and then writes an
  # empty result. label-tracks names its speakers after the FILES (bot,
  # remote-participant-1), while speaking-events records Meet's DISPLAY names
  # ("Stan James"). The tracks manifest is the only thing that knows both, so
  # build the mapping from it rather than hoping the names line up.
  map_arg=""
  manifest="$tracks/manifest.json"
  if [ -s "$manifest" ]; then
    map_arg=$(python3 - "$manifest" <<'PYEOF'
import json, sys, os
m = json.load(open(sys.argv[1]))
pairs = []
for t in m.get("tracks", []):
    if t.get("kind") != "audio" or not t.get("name"):
        continue
    stem = os.path.splitext(t.get("file") or "")[0]
    if stem:
        pairs.append(f"{stem}={t['name']}")
print(",".join(pairs))
PYEOF
)
  fi
  if [ -z "$map_arg" ]; then
    # Better to skip than to score a call whose speakers cannot be matched: the
    # output would look like a result and mean nothing.
    skipped=$((skipped+1)); say "  skip $call — no usable track->name map in manifest"; continue
  fi
  echo "  map: $map_arg" >> "$LOG"

  say "  scoring $call"
  if ! node "$ROOT/scripts/score-speaking.mjs" \
        --events "$events" --labels "$labels" --map "$map_arg" \
        --json "$RUN/run-$call.json" >> "$LOG" 2>&1; then
    failed=$((failed+1)); say "  FAILED scoring $call"; rm -f "$RUN/run-$call.json"; continue
  fi
  scored=$((scored+1))
done

say "scored=$scored skipped=$skipped failed=$failed"

if [ "$DRY" = 1 ]; then say "dry run — nothing pooled"; exit 0; fi

if [ "$scored" -eq 0 ]; then
  say "FATAL: nothing scored. See the skip reasons above."
  exit 1
fi

# Pool across calls rather than averaging per-call medians: a 26-turn segment
# and a 300-turn one must not weigh the same. pool-speaking-scores does the
# recomputation over the raw per-turn values.
say "pooling $scored run(s)"
node "$ROOT/scripts/pool-speaking-scores.mjs" "$RUN"/run-*.json > "$RUN/pooled.txt" 2>> "$LOG" \
  || { say "FATAL: pooling failed"; exit 1; }

say "done — $RUN/pooled.txt"
echo
sed -n '1,40p' "$RUN/pooled.txt"
