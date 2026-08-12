#!/bin/zsh
# promote.sh — promote a release-CANDIDATE to the RELEASE channel, gated on a GREEN
# nightly of that exact version. Human-run (YOU decide when); the gate just refuses
# to promote a build the nightly is unhappy with — a seatbelt, not autopilot.
#
# THE TWO-TRACK MODEL (see the updateChannel pref):
#   • Candidates are cut as GitHub PRERELEASES, versioned CLEAN semver (0.8.20 — NOT
#     0.8.20-rc.1; a prerelease-component version would be rejected by 'release'
#     clients even after promotion). The GitHub prerelease FLAG is the only track
#     signal.
#   • Stan + Seth run the 'candidate' update channel (allowPrerelease on) → auto-get
#     candidates early. The beta-tester group + real users run 'release' → see only
#     promoted builds.
#   • This script flips the release prerelease -> latest, so 'release' clients get
#     the EXACT bits already tested — no rebuild, no re-notarize.
#
# USAGE:
#   scripts/promote.sh v0.8.20            # promote tag v0.8.20 (the 'v' is optional)
#   scripts/promote.sh 0.8.20 --force     # skip the nightly gate (emergency; warns)
#   scripts/promote.sh 0.8.20 --yes       # skip the interactive confirm (automation)
#   RESULTS_DIR=/path scripts/promote.sh …# where the nightly results.jsonl lives
#
# THE GATE: the MOST RECENT nightly gating result (results.jsonl, the DMG-meet lane)
# must have exit 0 AND have tested the version being promoted. The mini's nightly
# self-updates to the newest release (prereleases INCLUDED), so the night after you
# cut a candidate, that run tests it — then run this.
set -u

REPO="wanderingstan/vibeconf-app"
RESULTS_DIR="${RESULTS_DIR:-$HOME/vibeconf-test-results}"
FORCE=0
ASSUME_YES=0
TAG=""
for a in "$@"; do
  case "$a" in
    --force)   FORCE=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "unknown flag: $a"; exit 2 ;;
    *)         TAG="$a" ;;
  esac
done
[[ -n "$TAG" ]] || { echo "usage: promote.sh <tag|version> [--force] [--yes]"; exit 2; }
[[ "$TAG" == v* ]] || TAG="v$TAG"
VER="${TAG#v}"

command -v gh >/dev/null || { echo "✗ gh (GitHub CLI) not found"; exit 3; }

echo "▶ promote candidate $TAG (version $VER) → RELEASE channel"

# --- Sanity: the release exists and is currently a prerelease (a candidate). ---
_ispre=$(gh release view "$TAG" --repo "$REPO" --json isPrerelease -q '.isPrerelease' 2>/dev/null)
if [[ -z "$_ispre" ]]; then echo "✗ no release $TAG on $REPO"; exit 4; fi
if [[ "$_ispre" != "true" ]]; then echo "✓ $TAG is already a full release — nothing to promote."; exit 0; fi

# --- The gate: latest nightly gating result must be GREEN and for THIS version. ---
_res="$RESULTS_DIR/results.jsonl"
_last=$( [[ -f "$_res" ]] && tail -1 "$_res" || echo "" )
_field() { echo "$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$2',''))" 2>/dev/null; }

_ok=1
if [[ -z "$_last" ]]; then
  echo "  ✗ no nightly results at $_res — can't verify."; _ok=0
else
  _lv=$(_field "$_last" ver); _le=$(_field "$_last" exit); _lt=$(_field "$_last" ts)
  echo "  latest nightly: version=${_lv:-?} exit=${_le:-?} ($_lt)"
  [[ "$_lv" == "$VER" ]] || { echo "  ✗ latest nightly tested '${_lv:-?}', not '$VER' — run a nightly on the candidate first."; _ok=0; }
  [[ "$_le" == "0" ]]    || { echo "  ✗ latest nightly for this build was RED (exit ${_le:-?})."; _ok=0; }
fi

if (( _ok )); then
  echo "  ✅ gate passed: nightly green for $VER."
elif (( FORCE )); then
  echo "  ⚠️  --force: promoting DESPITE a failed gate. You own this call."
else
  echo "✗ gate failed — not promoting. (Re-run with --force once you've eyeballed it.)"; exit 6
fi

# --- Confirm (outward-facing: this changes what real users auto-install). ---
if (( ! ASSUME_YES )); then
  printf "Promote %s to the RELEASE channel now? [y/N] " "$TAG"
  read -r _reply
  [[ "$_reply" == [yY]* ]] || { echo "aborted."; exit 0; }
fi

if gh release edit "$TAG" --repo "$REPO" --prerelease=false --latest; then
  echo "✅ $TAG promoted — 'release'-channel clients pick it up on their next update check."
else
  echo "✗ gh release edit failed"; exit 7
fi
