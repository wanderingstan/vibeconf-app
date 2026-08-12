#!/bin/zsh
# name-transcription-chunked.sh — run the FULL name-transcription audit across many
# short batches so it survives the source app's ~10-15min crash window.
#
# The audit (scripts/name-transcription-test.mjs) speaks each of the ~418
# recommended bot names and reads back Meet's caption. A single unattended run
# can't finish: `pnpm dev` crashes after ~10-15 min. So we CHUNK it — each batch
# is a FRESH fleet auditing a handful of NEW names (--skip-done skips names that
# already carry a real verdict in the JSONL), then we tear the fleet down and
# start clean. The JSONL accretes the whole dataset across batches.
#
# Runs on an ISOLATED port range (7911/7912 via VIBECONF_BASE_PORT) so it never
# collides with the nightly / on-push CI, which use 7901/7902.
#
# Usage:
#   scripts/name-transcription-chunked.sh [--category all|feminine|masculine|robotic]
#                                         [--chunk N] [--batches M] [--voice NAME]
#     --category  which pool to audit           (default: all)
#     --chunk     new names per batch            (default: 12 — safely under the crash window)
#     --batches   max batches this invocation    (default: 60 — enough for all 418)
#     --voice     macOS `say` voice              (default: system default)
#
# Idempotent + resumable: re-run any time; --skip-done means finished names are
# skipped, so it just keeps going until the category is exhausted (a batch that
# audits 0 new names ends the loop early).
set -e
REPO="${VIBECONF_REPO:-${0:A:h:h}}"
cd "$REPO"

CATEGORY="all"; CHUNK=12; BATCHES=60; VOICE=""
while (( $# )); do
  case "$1" in
    --category) CATEGORY="$2"; shift 2 ;;
    --chunk)    CHUNK="$2";    shift 2 ;;
    --batches)  BATCHES="$2";  shift 2 ;;
    --voice)    VOICE="$2";    shift 2 ;;
    *) echo "usage: $0 [--category C] [--chunk N] [--batches M] [--voice NAME]"; exit 1 ;;
  esac
done

# Isolated ports so this never fights the nightly / CI fleet on 7901/7902.
export VIBECONF_BASE_PORT="${VIBECONF_BASE_PORT:-7911}"
P1="$VIBECONF_BASE_PORT"; P2="$((VIBECONF_BASE_PORT + 1))"
RESULTS="${VIBECONF_RESULTS_DIR:-$HOME/vibeconf-test-results}/name-transcription-results.jsonl"

echo "▶ chunked name audit — category=$CATEGORY chunk=$CHUNK batches≤$BATCHES ports=$P1/$P2 voice=${VOICE:-default}"

for b in $(seq 1 "$BATCHES"); do
  # Count real verdicts before this batch so we can detect "no progress" → done.
  before=$( [[ -f "$RESULTS" ]] && grep -c '"verdict":"\(EXACT\|CLOSE\|MISS\)"' "$RESULTS" || echo 0 )
  echo "── batch $b/$BATCHES (verdicted so far: $before) ──"

  # Fresh fleet on the isolated ports (guest profiles). Kill any stragglers first.
  VIBECONF_NO_RUN_TAG=1 scripts/spawn-test-fleet.sh 2 --kill >/dev/null 2>&1 || true
  VIBECONF_NO_RUN_TAG=1 scripts/spawn-test-fleet.sh 2

  set +e
  node scripts/name-transcription-test.mjs --bots "Alice:$P1,Jimmy:$P2" \
    --category "$CATEGORY" --skip-done --limit "$CHUNK" ${VOICE:+--voice "$VOICE"}
  code=$?
  set -e

  VIBECONF_NO_RUN_TAG=1 scripts/spawn-test-fleet.sh 2 --kill >/dev/null 2>&1 || true

  after=$( [[ -f "$RESULTS" ]] && grep -c '"verdict":"\(EXACT\|CLOSE\|MISS\)"' "$RESULTS" || echo 0 )
  gained=$((after - before))
  echo "   batch $b: +$gained verdict(s) (total $after), exit $code"
  # No new verdicts this batch → either the category is exhausted or the fleet
  # never came up. Either way, stop rather than spin.
  if (( gained == 0 )); then echo "   no progress — stopping (category done or fleet failed to boot)"; break; fi
done

echo "▶ done. Results: $RESULTS"
echo "  Flagged-name audio (pronunciation check): ${VIBECONF_RESULTS_DIR:-$HOME/vibeconf-test-results}/name-audio/"
