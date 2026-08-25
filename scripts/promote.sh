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
# Keep gh's stderr rather than discarding it. This check used to be
# `2>/dev/null` with "no release $TAG" as the only explanation for an empty
# result, which reported a MISSING RELEASE for every possible failure: an expired
# gh auth, a gh too old for `--json` on `gh release view`, no network, a rate
# limit. Hit for real on the Mac mini (2026-08-25) against a tag that plainly
# existed, and the message sent the reader looking for the wrong thing entirely.
_err=$(mktemp)
_ispre=$(gh release view "$TAG" --repo "$REPO" --json isPrerelease -q '.isPrerelease' 2>"$_err")
_ghrc=$?
if [[ -z "$_ispre" ]]; then
  if [[ "$(cat "$_err")" == *"release not found"* ]]; then
    # gh reached GitHub and GitHub says there is no such release. The one case
    # the old message was right about.
    echo "✗ no release $TAG on $REPO — GitHub answered, and there is no such release."
    echo "  Most recent releases: $(gh release list --repo "$REPO" --limit 5 2>/dev/null | awk '{print $(NF-1)}' | tr '\n' ' ')"
    rm -f "$_err"; exit 4
  fi
  if (( _ghrc != 0 )) && [[ -s "$_err" ]]; then
    # gh failed for some OTHER reason and said why. Pass that through rather
    # than translating every failure into "the release does not exist".
    echo "✗ could not ask GitHub about $TAG on $REPO:"
    sed 's/^/    /' "$_err"
    echo "  (that is gh failing, NOT proof the release is missing — check:"
    echo "     gh auth status          # expired or wrong account?"
    echo "     gh --version            # too old for --json on 'gh release view'?"
    echo "     gh release view $TAG --repo $REPO )"
    rm -f "$_err"; exit 5
  fi
  # Succeeded, said nothing, explained nothing. Not a case we know how to read.
  echo "✗ gh returned no answer for $TAG on $REPO and no error (exit $_ghrc)."
  echo "  Try: gh release view $TAG --repo $REPO"
  rm -f "$_err"; exit 5
fi
rm -f "$_err"
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
