#!/bin/zsh
# scheduled-meet-test.sh — wrapper for the LaunchAgent that runs the automated
# Meet test on a schedule (Stan's always-on Mac mini). Runs `pnpm test:meet:ci`
# (spawn fleet → drive → teardown), captures a full timestamped log, and appends
# a one-line JSON result so history/trends are reviewable.
#
# Invoked by com.vibeconferencing.meet-test.plist via `zsh -lc` so it inherits
# the user's full PATH (node/pnpm). See scripts/SCHEDULING.md to install.

set -u
REPO="/Users/wanderingstan/Developer/vibeconferencing"
RESULTS="$HOME/vibeconf-test-results"
mkdir -p "$RESULTS"

# launchd gives a minimal PATH even under -l on some setups; belt-and-suspenders.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/current/bin:$PATH"

STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
LOG="$RESULTS/run-$STAMP.log"

cd "$REPO" || { echo "repo not found: $REPO"; exit 3; }

echo "=== meet-test scheduled run $STAMP ===" | tee "$LOG"
echo "node: $(command -v node) $(node -v 2>/dev/null)" | tee -a "$LOG"
echo "pnpm: $(command -v pnpm) $(pnpm -v 2>/dev/null)" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# Run the one-shot DMG target — the scheduled run on the always-on Mac mini
# drives the PACKAGED app so it tests the exact artifact an average user runs
# (no source-vs-package fidelity gap). Capture everything, preserve exit code.
pnpm test:meet:dmg 2>&1 | tee -a "$LOG"
CODE=${pipestatus[1]:-$?}   # zsh: exit code of pnpm, not tee

echo "" | tee -a "$LOG"
echo "=== exit code: $CODE ===" | tee -a "$LOG"

# Pull the harness's SIGNALS summary lines into a one-line JSON history entry.
stalls=$(grep -oE '\([0-9]+ real stall' "$LOG" | tail -1 | grep -oE '[0-9]+' || echo "?")
fails=$(grep -oE 'failed steps: +[0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || echo "?")
overlaps=$(grep -oE 'cross-bot speak overlaps \(<1.2s\): [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || echo "?")

printf '{"ts":"%s","exit":%s,"stalls":"%s","fails":"%s","overlaps":"%s","log":"%s"}\n' \
  "$STAMP" "$CODE" "$stalls" "$fails" "$overlaps" "$(basename "$LOG")" >> "$RESULTS/results.jsonl"

# --- EXPERIMENTAL: real-agent fuzzing test (#267 item 5) — NEW, take with a grain
# of salt. Real Claude agents run the 'smoke' mission and an LLM judge grades it.
# Best-effort and DECOUPLED from the primary signal above: the `|| true` means it
# NEVER changes this run's exit code, and it writes its OWN verdict line to
# $RESULTS/agent-fuzz/results.jsonl (so the deterministic dmg result stays clean).
# It self-spawns + tears down its own source-mode fleet. Costs tokens (real agents)
# and depends on the same display-on + unlocked conditions as any live test. Delete
# this block to disable. ---
echo "" | tee -a "$LOG"
echo "=== real-agent fuzz test (experimental, grain of salt) $STAMP ===" | tee -a "$LOG"
node scripts/agent-fuzz-test.mjs --mission smoke --duration 170 2>&1 | tee -a "$LOG" || true

# Keep only the last 30 full logs (history line in results.jsonl is permanent).
ls -1t "$RESULTS"/run-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

exit "$CODE"
