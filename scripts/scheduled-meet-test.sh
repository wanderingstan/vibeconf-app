#!/bin/zsh
# scheduled-meet-test.sh — wrapper for the LaunchAgent that runs the automated
# Meet test on a schedule (Stan's always-on Mac mini). Runs `pnpm test:meet:ci`
# (spawn fleet → drive → teardown), captures a full timestamped log, and appends
# a one-line JSON result so history/trends are reviewable.
#
# Invoked by com.vibeconferencing.meet-test.plist via `zsh -lc` so it inherits
# the user's full PATH (node/pnpm). See scripts/SCHEDULING.md to install.

set -u

# The self-update step below `git pull`s this very checkout, which can rewrite this
# script while zsh is still reading it — corrupting the running shell. Re-exec from
# a stable /tmp copy first so a pull can't touch the code we're executing. Guarded
# so we only copy once. Disable the whole self-update with VIBECONF_NO_SELFUPDATE=1.
if [[ "${VIBECONF_NO_SELFUPDATE:-0}" != "1" && "${VIBECONF_SELF_COPY:-0}" != "1" ]]; then
  _copy="$(mktemp -t scheduled-meet-test 2>/dev/null)" || _copy=""
  if [[ -n "$_copy" ]] && cp "$0" "$_copy" 2>/dev/null; then
    export VIBECONF_SELF_COPY=1
    exec /bin/zsh "$_copy" "$@"
  fi
fi

REPO="${0:A:h:h}"   # repo root = this scripts/ dir up one
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

# --- Self-update the artifacts before testing (Stan): pull latest `main` so the
# SOURCE lanes test HEAD, and install the latest published DMG so the DMG-meet lane
# tests the current build. Both best-effort — any failure logs and the run
# continues on whatever's already present (never touches the gating exit). Skip all
# of it with VIBECONF_NO_SELFUPDATE=1. ---
if [[ "${VIBECONF_NO_SELFUPDATE:-0}" != "1" ]]; then
  echo "=== self-update: main ===" | tee -a "$LOG"
  git -C "$REPO" fetch origin -q 2>&1 | tee -a "$LOG"
  _before=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
  git -C "$REPO" pull --ff-only origin main 2>&1 | tee -a "$LOG" || echo "  (pull failed — staying on current checkout)" | tee -a "$LOG"
  _after=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
  if [[ -n "$_before" && "$_before" != "$_after" ]]; then
    # Deps: install only if a lockfile actually changed in the pulled range (root
    # and electron-app are separate — not a workspace).
    _changed=$(git -C "$REPO" diff --name-only "$_before" "$_after" 2>/dev/null)
    echo "$_changed" | grep -q '^pnpm-lock.yaml$' && { echo "  root deps changed — pnpm install" | tee -a "$LOG"; (cd "$REPO" && pnpm install) 2>&1 | tee -a "$LOG" || true; }
    echo "$_changed" | grep -q '^electron-app/pnpm-lock.yaml$' && { echo "  electron-app deps changed — pnpm install" | tee -a "$LOG"; (cd "$REPO/electron-app" && pnpm install) 2>&1 | tee -a "$LOG" || true; }
  fi

  echo "=== self-update: DMG ===" | tee -a "$LOG"
  _app="/Applications/Vibeconferencing.app"
  _installed=$(defaults read "$_app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null)
  _tag=$(gh release list --repo wanderingstan/vibeconf-app --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null)
  _latest="${_tag#v}"
  echo "  installed=$_installed latest=$_latest" | tee -a "$LOG"
  if [[ -n "$_latest" && "$_installed" != "$_latest" ]]; then
    _dmg="/tmp/vibeconf-$_tag.dmg"; rm -f "$_dmg"
    if gh release download "$_tag" --repo wanderingstan/vibeconf-app --pattern '*arm64.dmg' --output "$_dmg" 2>&1 | tee -a "$LOG" && [[ -f "$_dmg" ]]; then
      # Version-gated, so the always-on production app is only restarted on nights a
      # new build actually drops. Quit it → replace the bundle → relaunch it.
      osascript -e 'quit app "Vibeconferencing"' 2>/dev/null; sleep 3
      pkill -f "$_app/Contents/MacOS/Vibeconferencing" 2>/dev/null; sleep 1
      _mp=$(hdiutil attach "$_dmg" -nobrowse -noverify 2>/dev/null | grep -o '/Volumes/[^"]*' | tail -1)
      if [[ -n "$_mp" && -d "$_mp/Vibeconferencing.app" ]]; then
        rm -rf "$_app" && cp -R "$_mp/Vibeconferencing.app" /Applications/ && echo "  installed $_latest ✓" | tee -a "$LOG"
        xattr -dr com.apple.quarantine "$_app" 2>/dev/null
        hdiutil detach "$_mp" -quiet 2>/dev/null
      else
        echo "  ✗ mount/copy failed — keeping $_installed" | tee -a "$LOG"
        [[ -n "$_mp" ]] && hdiutil detach "$_mp" -quiet 2>/dev/null
      fi
      open -a "$_app" 2>/dev/null || true  # relaunch the production (default-profile) instance
      rm -f "$_dmg"
    else
      echo "  ✗ DMG download failed — keeping $_installed" | tee -a "$LOG"
    fi
  else
    echo "  already current — no install (production app untouched)" | tee -a "$LOG"
  fi
  echo "" | tee -a "$LOG"
fi

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
