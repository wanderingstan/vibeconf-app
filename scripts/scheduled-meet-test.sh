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
# $HOME/.local/bin is where `claude` lives — needed by the agent-fuzz step, which
# spawns the CLI (without it the 3am run hit `spawn claude ENOENT`).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.nvm/versions/node/current/bin:$PATH"

STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
LOG="$RESULTS/run-$STAMP.log"

cd "$REPO" || { echo "repo not found: $REPO"; exit 3; }

# --- optional screen recording of each live-call lane. OFF by default; set
# VIBECONF_RECORD=1 to enable. Records the screen while a lane runs and keeps the
# .mov per policy — VIBECONF_RECORD_KEEP=fails (default) keeps only FAILING runs'
# videos, =all keeps every run; the newest VIBECONF_RECORD_MAX (default 5) are kept
# and older ones pruned. Files: $RESULTS/recordings/<lane>-<STAMP>.mov. Useful for
# the unattended 3am run — see what a flaky lane actually did on screen (e.g. the
# Slack 2nd-bot huddle-join, #412). NOTE: screencapture needs Screen Recording
# permission in the launchd context; if the first recorded nightly yields a tiny/
# black .mov, grant Screen Recording to the agent's shell (Terminal/zsh). ---
REC="${VIBECONF_RECORD:-0}"
REC_DIR="$RESULTS/recordings"
REC_KEEP="${VIBECONF_RECORD_KEEP:-fails}"
REC_MAX="${VIBECONF_RECORD_MAX:-5}"

rec_run() {  # rec_run <lane> -- <cmd...> : run cmd (tee'd to $LOG), return its exit,
             # recording the screen and keeping the .mov per policy.
  local lane="$1"; shift
  [[ "${1:-}" == "--" ]] && shift
  if [[ "$REC" != "1" ]]; then
    "$@" 2>&1 | tee -a "$LOG"
    return ${pipestatus[1]:-$?}
  fi
  mkdir -p "$REC_DIR"
  local mov="$REC_DIR/${lane}-${STAMP}.mov"
  screencapture -v -k "$mov" >/dev/null 2>&1 &
  local rpid=$!
  "$@" 2>&1 | tee -a "$LOG"
  local code=${pipestatus[1]:-$?}
  kill -INT "$rpid" 2>/dev/null; wait "$rpid" 2>/dev/null
  if [[ "$REC_KEEP" == "all" || ( "$REC_KEEP" == "fails" && "$code" != "0" ) ]]; then
    echo "=== 📹 recording kept: $mov ($(du -h "$mov" 2>/dev/null | cut -f1)) ===" | tee -a "$LOG"
  else
    rm -f "$mov"
  fi
  # Prune: keep only the newest REC_MAX recordings.
  ls -1t "$REC_DIR"/*.mov 2>/dev/null | tail -n +$((REC_MAX + 1)) | xargs rm -f 2>/dev/null || true
  return $code
}

echo "=== meet-test scheduled run $STAMP ===" | tee "$LOG"
echo "node: $(command -v node) $(node -v 2>/dev/null)" | tee -a "$LOG"
echo "pnpm: $(command -v pnpm) $(pnpm -v 2>/dev/null)" | tee -a "$LOG"
echo "" | tee -a "$LOG"

# Run the one-shot DMG target — the scheduled run on the always-on Mac mini
# drives the PACKAGED app so it tests the exact artifact an average user runs
# (no source-vs-package fidelity gap). Capture everything, preserve exit code.
rec_run dmg-meet -- pnpm test:meet:dmg
CODE=$?   # exit code of the lane (recorded if VIBECONF_RECORD=1)

echo "" | tee -a "$LOG"
echo "=== exit code: $CODE ===" | tee -a "$LOG"

# Pull the harness's SIGNALS summary lines into a one-line JSON history entry.
stalls=$(grep -oE '\([0-9]+ real stall' "$LOG" | tail -1 | grep -oE '[0-9]+' || echo "?")
fails=$(grep -oE 'failed steps: +[0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || echo "?")
overlaps=$(grep -oE 'cross-bot speak overlaps \(<1.2s\): [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || echo "?")

printf '{"ts":"%s","exit":%s,"stalls":"%s","fails":"%s","overlaps":"%s","log":"%s"}\n' \
  "$STAMP" "$CODE" "$stalls" "$fails" "$overlaps" "$(basename "$LOG")" >> "$RESULTS/results.jsonl"

# --- main-source meet regression run (test:meet:ci) — same two-bot meet-test, but
# against the SOURCE checkout on `main` instead of the installed DMG. The DMG run
# above validates the SHIPPED artifact; this catches a regression the moment it
# lands on main, before it's ever cut into a build (the installed beta always lags
# main, so they diverge between releases). Non-gating for now — own results file,
# does NOT touch $CODE — promote into the primary exit once trusted. ---
echo "" | tee -a "$LOG"
echo "=== main-source meet regression (test:meet:ci) $STAMP ===" | tee -a "$LOG"
rec_run main-meet -- pnpm test:meet:ci
MAIN_CODE=$?
mstalls=$(grep -oE '\([0-9]+ real stall' "$LOG" | tail -1 | grep -oE '[0-9]+' || echo "?")
mfails=$(grep -oE 'failed steps: +[0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || echo "?")
printf '{"ts":"%s","exit":%s,"stalls":"%s","fails":"%s","branch":"main","log":"%s"}\n' \
  "$STAMP" "$MAIN_CODE" "$mstalls" "$mfails" "$(basename "$LOG")" >> "$RESULTS/results-main.jsonl"
echo "=== main-source meet exit: $MAIN_CODE (recorded, not gating) ===" | tee -a "$LOG"

# --- Slack backend test (test:slack:ci) — the huddle-fleet analog of the meet test
# (#265). Drives the two SIGNED-IN test-slack profiles through join/speak/hear/chat/
# whiteboard in a real Slack huddle. Non-gating — own results file. Depends on the
# one-time Slack login persisting (scripts/setup-test-profiles.sh --slack); if the
# session lapses this line goes red until it's re-done (that red IS the signal). ---
echo "" | tee -a "$LOG"
echo "=== Slack backend test (#265) $STAMP ===" | tee -a "$LOG"
rec_run slack -- pnpm test:slack:ci
SLACK_CODE=$?
sstalls=$(grep -oE '\([0-9]+ real stall' "$LOG" | tail -1 | grep -oE '[0-9]+' || echo "?")
sfails=$(grep -oE 'failed steps: +[0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$' || echo "?")
printf '{"ts":"%s","exit":%s,"stalls":"%s","fails":"%s","log":"%s"}\n' \
  "$STAMP" "$SLACK_CODE" "$sstalls" "$sfails" "$(basename "$LOG")" >> "$RESULTS/slack-results.jsonl"
echo "=== Slack test exit: $SLACK_CODE (recorded, not gating) ===" | tee -a "$LOG"

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

# --- Codex MCP wire smoke (#373) — deterministic + tokenless (agent-less fleet
# body + stdio MCP handshake/tools/get_room_info; no GUI interaction beyond app
# launch, so low flake risk). Decoupled from the primary exit like the fuzz
# block for its first nights; writes its own verdict line. PROMOTE into the
# primary exit code once it has a green streak. ---
echo "" | tee -a "$LOG"
echo "=== codex MCP smoke (#373) $STAMP ===" | tee -a "$LOG"
pnpm test:codex:ci 2>&1 | tee -a "$LOG"
CODEX_CODE=${pipestatus[1]:-$?}
printf '{"ts":"%s","exit":%s,"log":"%s"}\n' "$STAMP" "$CODEX_CODE" "$(basename "$LOG")" \
  >> "$RESULTS/codex-smoke-results.jsonl"
echo "=== codex smoke exit: $CODEX_CODE (recorded, not gating) ===" | tee -a "$LOG"

# --- Telegram digest — post a one-message summary of tonight's results to Stan's
# DM. This cron isn't a Claude session, so notify-nightly.mjs hits the Bot API
# directly with the existing bot token (~/.claude/channels/telegram/.env). Green
# digests are sent silently; a red run pings. Best-effort — the script always exits
# 0, so it never touches the gating $CODE. Disable with VIBECONF_NOTIFY=0. ---
echo "" | tee -a "$LOG"
node scripts/notify-nightly.mjs 2>&1 | tee -a "$LOG" || true

# Keep only the last 30 full logs (history line in results.jsonl is permanent).
ls -1t "$RESULTS"/run-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

exit "$CODE"
