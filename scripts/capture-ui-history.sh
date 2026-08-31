#!/usr/bin/env bash
# capture-ui-history.sh — #615, step one: a visual changelog of the app's UI.
#
# Asks a RUNNING app to capture one of its own windows, and keeps the PNG only
# when the app actually looks different from the last frame we kept. On a quiet
# week that is zero new files; on the week the panel gets reworked it is one.
# So the directory becomes a changelog rather than a pile of near-identical
# nights, and every file in it marks a real change.
#
# THE DEADLINE: the baseline can only be captured while the CURRENT UI still
# exists. Every later frame can be reconstructed by checking out an old tag and
# running it — the one from the day before a redesign cannot. That is why this
# exists as a crude script now rather than a good one later.
#
#   ./scripts/capture-ui-history.sh [surface]      # default: panel
#
# Env:
#   VIBECONF_BASE_URL   app to ask          (default http://127.0.0.1:7865)
#   UI_HISTORY_DIR      where to keep them  (default ~/vibeconf-test-results/ui-history)
#   UI_DIFF_THRESHOLD   see below           (default 6)
#
# Exit: 0 kept or unchanged · 1 could not capture · 2 bad usage.

set -uo pipefail

SURFACE="${1:-panel}"
BASE="${VIBECONF_BASE_URL:-http://127.0.0.1:7865}"
DIR="${UI_HISTORY_DIR:-$HOME/vibeconf-test-results/ui-history}/$SURFACE"

# Mean per-pixel brightness difference, 0-255, over the 16x16 signature, above
# which two frames count as different.
#
# Not zero, and that is the whole design. The clock moves, the elapsed timer
# ticks, a status dot animates and text anti-aliases differently between any two
# captures, so an exact comparison reports "changed" every single night and
# destroys the property that makes this a changelog. Too high and a real
# redesign slips through unrecorded.
#
# 6 is a starting point, not a measured value — TUNE IT once there are a couple
# of weeks of frames to tune against. Frames are cheap; that is the right order.
THRESHOLD="${UI_DIFF_THRESHOLD:-6}"

mkdir -p "$DIR" || { echo "cannot write $DIR" >&2; exit 1; }

# #356: the local server is bearer-gated. The token is written per-port by the
# running app, so read it rather than being told it — a token passed in by hand
# goes stale the moment the app restarts and picks a new one.
PORT="$(printf '%s' "$BASE" | sed -E 's#.*:([0-9]+).*#\1#')"
TOKEN_FILE="$HOME/.vibeconferencing/local-tokens/$PORT.token"
if [ ! -r "$TOKEN_FILE" ]; then
  echo "🔴 no token at $TOKEN_FILE — the app on port $PORT is not running, or wrote its token as another user" >&2
  exit 1
fi
TOKEN="$(cat "$TOKEN_FILE")"

resp="$(curl -sS --max-time 30 -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/ui-capture?surface=$SURFACE" 2>&1)" || {
  echo "🔴 no answer from the app at $BASE — is it running?" >&2; exit 1; }

read -r ok src sig version w h <<<"$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print("false - - - - -"); raise SystemExit
print(d.get("success") and "true" or "false",
      d.get("path") or "-", d.get("signature") or "-",
      d.get("appVersion") or "-", d.get("width") or "-", d.get("height") or "-")
')"

if [ "$ok" != "true" ]; then
  echo "🔴 capture refused: $(printf '%s' "$resp" | head -c 300)" >&2
  exit 1
fi

# The newest kept frame is the reference. Comparing against the last KEPT frame
# rather than the last CAPTURED one is deliberate: it stops a slow drift of
# sub-threshold changes from accumulating unrecorded.
last_sig=""
last_file="$(ls -1 "$DIR"/*.sig 2>/dev/null | sort | tail -1)"
[ -n "$last_file" ] && last_sig="$(cat "$last_file")"

diff=999
if [ -n "$last_sig" ]; then
  diff="$(SIG_A="$last_sig" SIG_B="$sig" python3 -c '
import os,sys
a=os.environ["SIG_A"]; b=os.environ["SIG_B"]
if len(a)!=len(b) or len(a)%2:
    # A different signature LENGTH means the window was captured at a different
    # size, so the frames are not comparable — treat as changed and keep it.
    print(999); sys.exit()
pa=[int(a[i:i+2],16) for i in range(0,len(a),2)]
pb=[int(b[i:i+2],16) for i in range(0,len(b),2)]
print(round(sum(abs(x-y) for x,y in zip(pa,pb))/len(pa),2))
')"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
keep=0
if [ -z "$last_sig" ]; then
  keep=1; why="first frame — this is the baseline"
elif python3 -c "import sys; sys.exit(0 if float('$diff') > float('$THRESHOLD') else 1)"; then
  keep=1; why="changed (mean diff $diff > $THRESHOLD)"
else
  why="unchanged (mean diff $diff <= $THRESHOLD)"
fi

if [ "$keep" = 1 ]; then
  dest="$DIR/$stamp-v$version.png"
  cp "$src" "$dest" && printf '%s' "$sig" > "$DIR/$stamp-v$version.sig"
  # The app version and size sit alongside every frame, so "when did this change
  # and what shipped that day" is answerable from the folder itself.
  printf '{"ts":"%s","surface":"%s","appVersion":"%s","w":"%s","h":"%s","diff":"%s","file":"%s"}\n' \
    "$stamp" "$SURFACE" "$version" "$w" "$h" "$diff" "$(basename "$dest")" >> "$DIR/history.jsonl"
  echo "📸 kept $(basename "$dest") — $why"
else
  echo "· $SURFACE $why — not kept"
fi

rm -f "$src"
exit 0
