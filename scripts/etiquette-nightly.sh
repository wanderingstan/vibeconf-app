#!/bin/zsh
# etiquette-nightly.sh — run the etiquette rules unattended, ONE RULE PER FLEET.
#
# WHY ONE RULE PER FLEET, when the suite can run all of them in a single go:
# because a full run's reds are not trustworthy. #494 measured it — the same
# build, same fleet, scored 4 reds in a ten-rule run and 2/2, 6/6 and a clean
# pass when the same rules were run in small groups. The failures track POSITION
# IN A LONG RUN, not behaviour.
#
# #494 is unfixed and its own suggested approach is instrumentation, i.e. R&D.
# But it also records the finding that makes this lane possible today: single-rule
# and small-subset runs ARE authoritative. So this trades wall-clock for
# trustworthiness — a fresh fleet per rule costs ~25s of boot and buys a red that
# means something.
#
# That trade is the entire point. A nightly lane whose reds have to be manually
# re-tested before anyone believes them is the impression-based loop the suite
# was built to replace, wearing a cron job.
#
#   scripts/etiquette-nightly.sh --room <meet-code> [--budget-sec 900] [--only a,b]
#
# Writes one JSON row per rule to $RESULTS/etiquette-results.jsonl.
# Exit: 0 all attempted rules held · 1 a rule failed · 2 could not run at all.

set -uo pipefail
HERE="${0:A:h}"
REPO="${HERE:h}"
RESULTS="${VIBECONF_TEST_RESULTS:-$HOME/vibeconf-test-results}"
OUT="$RESULTS/etiquette-results.jsonl"
mkdir -p "$RESULTS"

ROOM=""; BUDGET=1500; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --room) ROOM="$2"; shift 2 ;;
    --budget-sec) BUDGET="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$ROOM" ]] || { echo "🔴 etiquette: no --room given"; exit 2; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
row() {  # rule verdict note
  printf '{"ts":"%s","stamp":"%s","rule":"%s","verdict":"%s","note":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STAMP" "$1" "$2" "$(print -r -- "$3" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')" >> "$OUT"
}

# The rule list comes from the suite itself, so a rule added there is picked up
# here without anyone remembering to edit two files.
if [[ -n "$ONLY" ]]; then
  RULES=(${(s:,:)ONLY})
else
  RULES=(${(f)"$(grep -oE "^    id: '[a-z0-9-]+'" "$REPO/scripts/etiquette-test.mjs" | sed -E "s/.*'(.*)'/\1/")"})
fi
(( ${#RULES} )) || { echo "🔴 etiquette: no rules found to run"; exit 2; }
echo "=== etiquette: ${#RULES} rule(s), one fleet each, ${BUDGET}s budget, room $ROOM ==="

START=$SECONDS
FAILED=0; RAN=0
for rule in "${RULES[@]}"; do
  ELAPSED=$(( SECONDS - START ))
  if (( ELAPSED >= BUDGET )); then
    # A rule the budget cut off is NOT a passing rule. Say so per rule, or a
    # truncated run reads as a clean one — the exact failure the lane ledger in
    # scheduled-meet-test.sh exists to prevent.
    row "$rule" "not-run" "budget of ${BUDGET}s exhausted after ${RAN} rule(s)"
    echo "  ⏭  $rule — budget exhausted"
    continue
  fi

  # A FRESH FLEET, every time. See the header, and the suite's own warning:
  # "the same build scored 3/7 from a clean boot and 0/7 after several --keep
  # runs on the same build".
  "$REPO/scripts/spawn-test-fleet.sh" 2 --kill >/dev/null 2>&1
  node "$REPO/scripts/etiquette-prep.mjs" >/dev/null 2>&1
  if ! "$REPO/scripts/spawn-test-fleet.sh" 2 >/dev/null 2>&1; then
    row "$rule" "no-fleet" "could not spawn the two-bot fleet"
    echo "  ⚠️  $rule — no fleet"
    continue
  fi

  OUT_TXT="$(node "$REPO/scripts/etiquette-test.mjs" --room "$ROOM" --only "$rule" 2>&1)"
  CODE=$?
  RAN=$(( RAN + 1 ))
  # The suite prints "  pass  <id>  <claim>" / "  FAIL  <id>  ↳ <note>".
  NOTE="$(print -r -- "$OUT_TXT" | grep -E "^\s+(pass|FAIL)\s+$rule" -A1 | tail -2 | tr '\n' ' ')"
  if (( CODE == 0 )); then
    row "$rule" "pass" "$NOTE"; echo "  ✅ $rule"
  else
    row "$rule" "fail" "$NOTE"; echo "  ❌ $rule — $NOTE"
    FAILED=$(( FAILED + 1 ))
  fi
done

"$REPO/scripts/spawn-test-fleet.sh" 2 --kill >/dev/null 2>&1
echo "=== etiquette: ${RAN}/${#RULES} rules run, ${FAILED} failed ==="
(( FAILED )) && exit 1
(( RAN )) || exit 2
exit 0
