#!/bin/zsh
# record-run.sh — record the screen while running an arbitrary command, then keep a
# compressed .mp4 of the run. Ad-hoc companion to the nightly's keep-on-fail recorder
# (rec_run in scheduled-meet-test.sh). The wrapped command's stdout/stderr pass
# through untouched, and this script exits with the command's exit code, so it's a
# transparent prefix you can put in front of anything:
#
#   scripts/record-run.sh -- pnpm test:slack:ci
#   scripts/record-run.sh --label slack-join --fails-only -- pnpm test:slack:ci
#   scripts/record-run.sh --raw -- pnpm test:meet:ci
#
# Flags (before the command; `--` separator is optional):
#   --label NAME    filename prefix (default: "run")
#   --out DIR       output dir (default: ~/vibeconf-test-results/recordings)
#   --fails-only    keep the recording only if the command exits non-zero
#   --raw           also keep the original (4K) .mov (default: only the compressed mp4)
#   --no-compress   keep the raw .mov and skip compression (implies --raw)
#
# NOTE: screencapture needs Screen Recording permission for the invoking shell. In an
# interactive Terminal that's usually already granted; a tiny/black file means it's not.

set -u
LABEL="run"
OUTDIR="$HOME/vibeconf-test-results/recordings"
FAILS_ONLY=0
KEEP_RAW=0
COMPRESS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="$2"; shift 2;;
    --out) OUTDIR="$2"; shift 2;;
    --fails-only) FAILS_ONLY=1; shift;;
    --raw) KEEP_RAW=1; shift;;
    --no-compress) COMPRESS=0; KEEP_RAW=1; shift;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    --) shift; break;;
    *) break;;  # first non-flag token starts the command
  esac
done

[[ $# -gt 0 ]] || { echo "usage: $0 [--label NAME] [--out DIR] [--fails-only] [--raw] [--no-compress] -- <command...>"; exit 2; }

# Sanitize the label for a filename (spaces/slashes → dashes).
LABEL="${LABEL//[^A-Za-z0-9._-]/-}"
mkdir -p "$OUTDIR"
STAMP="$(date +%Y-%m-%dT%H-%M-%S)"
RAW="$OUTDIR/${LABEL}-${STAMP}.mov"

if ! command -v screencapture >/dev/null 2>&1; then
  echo "✗ screencapture not found — running without recording"
  "$@"; exit $?
fi

echo "▶ recording → $RAW"
screencapture -v -k "$RAW" >/dev/null 2>&1 &
RPID=$!

# Run the wrapped command with full stdio passthrough.
"$@"
CODE=$?

kill -INT "$RPID" 2>/dev/null
# Let screencapture finalize the file on SIGINT; force-kill if it stalls — a
# near-instant wrapped command can SIGINT it at ~0s of footage, which hangs the
# finalize. Real recordings (seconds+) finalize well within this window.
for _ in {1..10}; do kill -0 "$RPID" 2>/dev/null || break; sleep 0.5; done
kill -KILL "$RPID" 2>/dev/null
wait "$RPID" 2>/dev/null
sleep 1

if (( FAILS_ONLY )) && (( CODE == 0 )); then
  rm -f "$RAW"
  echo "✓ command passed (exit 0) — recording discarded (--fails-only)"
  exit $CODE
fi

FINAL="$RAW"
if (( COMPRESS )) && command -v ffmpeg >/dev/null 2>&1; then
  MP4="$OUTDIR/${LABEL}-${STAMP}.mp4"
  if ffmpeg -y -i "$RAW" -vf "scale=1280:-2" -c:v libx264 -preset veryfast -crf 28 -an "$MP4" >/dev/null 2>&1; then
    FINAL="$MP4"
    (( KEEP_RAW )) || rm -f "$RAW"
  else
    echo "  (ffmpeg compression failed — keeping the raw .mov)"
  fi
fi

echo "✓ recording saved: $FINAL ($(du -h "$FINAL" 2>/dev/null | cut -f1))  [command exit $CODE]"
exit $CODE
