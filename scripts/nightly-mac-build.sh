#!/bin/bash
# nightly-mac-build.sh — the macOS build lane of the nightly, on the Mac mini.
#
# Builds, signs and NOTARIZES whatever is on origin/main into a .dmg + .zip +
# latest-mac.yml, verifies the result, files it under ~/vibeconf-builds/<date>-<sha>/,
# and writes one JSONL line the 3am digest reads. It does NOT publish, tag, or touch
# GitHub in any way — promoting a night's build to a pre-release stays a human
# decision made in daylight (see SCHEDULING.md).
#
# WHY A LANE AND NOT ITS OWN CRON: same reason as nightly-linux-lane.sh — being a
# lane means the Telegram digest, the retention policy and the "no result" alarm
# all come for free. A separate cron that fails silently is a cron nobody reads.
#
# WHY 01:00: the meet-test lane owns 03:00 and budgets 5400s, so it holds the box
# until ~04:30. Nightly failures here have historically been CPU starvation rather
# than real regressions, and a notarized Electron build is the single heaviest job
# this machine runs. 01:00 finishes well clear of it, and leaves a fresh artifact
# waiting before anyone wakes up.
#
# ---------------------------------------------------------------------------
# THE TWO TRAPS THIS SCRIPT EXISTS TO NOT FALL INTO
#
# 1. NOTARIZATION IS SKIPPED WITH A *WARNING*, NOT AN ERROR. With APPLE_ID /
#    APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID unset, electron-builder happily
#    produces a signed-but-un-notarized app and exits 0. That looks exactly like
#    success and ships an app Gatekeeper will refuse. So we assert the three vars
#    BEFORE building (exit 70) and assert `spctl` actually says
#    "source=Notarized Developer ID" AFTER (exit 11). Never trust exit 0 alone.
#
# 2. ~/.zshrc IS ONLY SOURCED FOR *INTERACTIVE* SHELLS. launchd runs us as
#    `zsh -lc`, which is a login shell but NOT interactive, so the Apple vars that
#    live in ~/.zshrc are simply absent — see CLAUDE.md. We read them from a
#    0600 env file instead, and fall back to sourcing ~/.zshrc so an existing
#    machine keeps working before that file is created.
#
# There is a third trap that is NOT solved here because it cannot be solved from a
# script: codesign needs the signing key, and the login keychain is unreachable
# from a session without GUI access (it fails with `errSecInternalComponent` on
# every file). A LaunchAgent in the Aqua session normally can reach it, but only
# while it is unlocked — and this machine's login keychain does auto-lock. If you
# want this lane to be genuinely unattended, point VIBECONF_SIGNING_KEYCHAIN at a
# dedicated keychain holding just the Developer ID identity; we unlock that
# ourselves and the GUI session stops mattering. Either way we smoke-test codesign
# up front (exit 71) so a locked keychain costs 2 seconds, not a 20-minute build
# that dies at the signing step.
# ---------------------------------------------------------------------------
set -uo pipefail

# --- configuration ---------------------------------------------------------
# Where the script fetches from. This is the primary checkout; we never build from
# it, we only borrow its object store and its remote.
REPO="${VIBECONF_BUILD_REPO:-$HOME/Developer/vibeconf-app}"
# The pinned build source. A DETACHED worktree, re-pointed at origin/main every
# night. WHY NOT JUST BUILD IN $REPO: a stray feature branch left checked out there
# has already made the nightly silently test week-old code more than once. A
# detached worktree cannot drift — whatever anyone is doing in the primary checkout,
# this lane builds origin/main or it fails loudly.
WORKTREE="${VIBECONF_BUILD_WORKTREE:-$HOME/Developer/vibeconf-nightly}"
REF="${VIBECONF_BUILD_REF:-origin/main}"
OUT="${VIBECONF_BUILD_OUT:-$HOME/vibeconf-builds}"
KEEP_DAYS="${VIBECONF_BUILD_KEEP_DAYS:-14}"
RESULTS="${VIBECONF_RESULTS_DIR:-$HOME/vibeconf-test-results}"
# 0600 file holding `export APPLE_ID=…` etc. Keeping the app-specific password out
# of both this repo and the plist is the whole point; a plist is world-readable.
ENV_FILE="${VIBECONF_BUILD_ENV:-$HOME/.config/vibeconf/build.env}"
# Optional dedicated signing keychain (see the long comment above). Unset = rely on
# the login keychain being unlocked in the GUI session.
SIGN_KEYCHAIN="${VIBECONF_SIGNING_KEYCHAIN:-}"
SIGN_KEYCHAIN_PW_FILE="${VIBECONF_SIGNING_KEYCHAIN_PW_FILE:-$HOME/.config/vibeconf/signing-keychain.pw}"
STAMP="${STAMP:-$(date +%Y%m%d-%H%M%S)}"

mkdir -p "$RESULTS" "$OUT"
LOG="$RESULTS/mac-build-$STAMP.log"
JSONL="$RESULTS/mac-build-results.jsonl"

# --- result bookkeeping ----------------------------------------------------
# Record a line no matter how we exit, for the same reason the linux lane does: a
# lane that dies without a result is indistinguishable from a lane that never ran,
# and the digest needs to be able to say "this broke" rather than say nothing.
exit_code=1
note="did not run"
version=""
commit=""
artifact=""
KEYCHAINS_BEFORE=""

json_escape() { printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }

record() {
  printf '{"ts":"%s","exit":%s,"note":"%s","version":"%s","commit":"%s","artifact":"%s"}\n' \
    "$STAMP" "${exit_code:-1}" "$(json_escape "$note")" \
    "$(json_escape "$version")" "$(json_escape "$commit")" "$(json_escape "$artifact")" >> "$JSONL"
}

finish() {
  # Restore the user's keychain search list if we changed it. Leaving a signing
  # keychain permanently in someone's search list is the kind of invisible side
  # effect that makes a later "why is codesign picking the wrong identity?" take
  # an afternoon.
  if [ -n "$KEYCHAINS_BEFORE" ]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $KEYCHAINS_BEFORE >/dev/null 2>&1
  fi
  record
  echo "=== mac-build finished: exit=$exit_code note=$note ==="
}
trap finish EXIT

die() { exit_code="$1"; note="$2"; echo "!!! $2"; exit "$1"; }

# Everything below is teed into the run log so a failing night is readable in the
# morning without re-running anything.
exec > >(tee -a "$LOG") 2>&1
echo "=== mac-build lane $STAMP ==="
echo "repo=$REPO worktree=$WORKTREE ref=$REF out=$OUT"

# --- 1. credentials, before anything expensive -----------------------------
if [ -f "$ENV_FILE" ]; then
  echo "--- loading $ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
else
  echo "--- $ENV_FILE not found; extracting the Apple vars from ~/.zshrc"
  # We EXTRACT the three assignments rather than source the file. Sourcing looks
  # like the obvious move and is a trap: ~/.zshrc is zsh, this script is bash, and
  # oh-my-zsh aborts the moment it is sourced by the wrong shell — silently taking
  # the whole lane down with it before a single check has run. (Caught exactly that
  # way in testing.) Note the shebang wins over the plist's `zsh -lc`, so this stays
  # true however launchd invokes us. Matching only these three `export` lines also
  # means we execute none of the rest of the file.
  eval "$(grep -E '^[[:space:]]*export[[:space:]]+APPLE_(ID|APP_SPECIFIC_PASSWORD|TEAM_ID)=' "$HOME/.zshrc" 2>/dev/null)" || true
fi

missing=""
[ -z "${APPLE_ID:-}" ] && missing="$missing APPLE_ID"
[ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && missing="$missing APPLE_APP_SPECIFIC_PASSWORD"
[ -z "${APPLE_TEAM_ID:-}" ] && missing="$missing APPLE_TEAM_ID"
[ -n "$missing" ] && die 70 "notarization creds missing:$missing — would have built a signed-but-UN-NOTARIZED app; refusing"
echo "--- notarization creds present (team $APPLE_TEAM_ID)"

# --- 2. can we actually sign? ----------------------------------------------
if [ -n "$SIGN_KEYCHAIN" ]; then
  [ -f "$SIGN_KEYCHAIN_PW_FILE" ] || die 71 "VIBECONF_SIGNING_KEYCHAIN set but no password file at $SIGN_KEYCHAIN_PW_FILE"
  echo "--- unlocking $SIGN_KEYCHAIN"
  security unlock-keychain -p "$(cat "$SIGN_KEYCHAIN_PW_FILE")" "$SIGN_KEYCHAIN" \
    || die 71 "could not unlock $SIGN_KEYCHAIN"
  # Prepend rather than replace: codesign searches this list, and blowing away the
  # login keychain here would break anything else running in this session.
  KEYCHAINS_BEFORE="$(security list-keychains -d user | sed 's/^[[:space:]]*//; s/"//g' | tr '\n' ' ')"
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$SIGN_KEYCHAIN" $KEYCHAINS_BEFORE >/dev/null \
    || die 71 "could not add $SIGN_KEYCHAIN to the search list"
fi

IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep 'Developer ID Application' | head -1 | awk '{print $2}')"
[ -n "$IDENTITY" ] || die 71 "no Developer ID Application identity visible to this session"

# The smoke test. `find-identity` succeeding proves only that the CERTIFICATE is
# readable — the private key can still be locked away, which is precisely the
# failure that looks like a broken certificate and isn't. Signing one throwaway
# byte costs nothing and tells us the truth.
SMOKE="$(mktemp -t vibeconf-signcheck)"
echo smoke > "$SMOKE"
if ! codesign --sign "$IDENTITY" --force "$SMOKE" 2>&1; then
  rm -f "$SMOKE"
  die 71 "codesign cannot use the signing key (errSecInternalComponent = keychain locked or unreachable from this session). Set VIBECONF_SIGNING_KEYCHAIN, or unlock the login keychain and disable its auto-lock."
fi
rm -f "$SMOKE"
echo "--- codesign smoke test OK (identity $IDENTITY)"

# --- 3. pin the source -----------------------------------------------------
if [ ! -d "$WORKTREE/.git" ] && [ ! -f "$WORKTREE/.git" ]; then
  echo "--- creating detached worktree at $WORKTREE"
  git -C "$REPO" fetch --quiet origin main || die 72 "git fetch failed in $REPO"
  git -C "$REPO" worktree add --detach "$WORKTREE" "$REF" || die 72 "could not create worktree at $WORKTREE"
fi
git -C "$WORKTREE" fetch --quiet origin main || die 72 "git fetch failed in $WORKTREE"
git -C "$WORKTREE" checkout --quiet --detach "$REF" || die 72 "could not check out $REF"
# Discard anything a previous run or a stray hand left behind, but NOT -x: node_modules
# is untracked and reinstalling it nightly would add minutes for no benefit.
git -C "$WORKTREE" reset --hard --quiet || die 72 "git reset failed"
git -C "$WORKTREE" clean -fd --quiet || true

commit="$(git -C "$WORKTREE" rev-parse --short HEAD)"
version="$(node -p "require('$WORKTREE/electron-app/package.json').version" 2>/dev/null)"
[ -n "$version" ] || die 72 "could not read version from electron-app/package.json"
echo "--- building $version @ $commit"

# --- 4. build --------------------------------------------------------------
cd "$WORKTREE/electron-app" || die 72 "no electron-app dir in $WORKTREE"
# Stale artifacts are worse than a slow build: a previous night's .dmg left in dist/
# would be picked up by the copy step below and filed under tonight's SHA.
rm -rf dist

pnpm install --frozen-lockfile || die 73 "pnpm install failed"

# `-p never` is not paranoia. build.publish in package.json points at the GitHub
# repo, so electron-builder will happily upload to a release the moment a
# GH_TOKEN/GITHUB_TOKEN turns up in the environment — and this lane's whole
# contract is that it never touches GitHub. Today no token is set; that is luck,
# and luck is not a release policy.
pnpm exec electron-builder -p never || die 10 "electron-builder failed (see $LOG)"

# --- 5. verify -------------------------------------------------------------
# Against the .app, NOT the .dmg. electron-builder notarizes and staples the .app
# and THEN wraps it, so the .dmg legitimately reports unsigned/unstapled — a
# documented dead end that has eaten real debugging time. Do not "fix" this by
# checking the .dmg.
APP="dist/mac-arm64/Vibeconferencing.app"
[ -d "$APP" ] || die 12 "no $APP after a successful build"

SPCTL="$(spctl -a -vvv "$APP" 2>&1)"
echo "$SPCTL"
grep -q 'source=Notarized Developer ID' <<<"$SPCTL" \
  || die 11 "spctl did not say 'source=Notarized Developer ID' — the app is signed but NOT notarized"

STAPLE="$(xcrun stapler validate "$APP" 2>&1)"
echo "$STAPLE"
grep -q 'The validate action worked' <<<"$STAPLE" \
  || die 11 "stapler validate failed — the notarization ticket is not attached"

# --- 6. file the artifacts -------------------------------------------------
DEST="$OUT/$(date +%Y%m%d)-$commit"
mkdir -p "$DEST"
copied=0
for f in dist/*"$version"*.dmg dist/*"$version"*-mac.zip dist/*.blockmap dist/latest-mac.yml; do
  [ -e "$f" ] || continue
  cp -p "$f" "$DEST/" && copied=$((copied + 1))
done
# Glob on the VERSION, never a bare extension — dist/ is shared with the Windows and
# Linux targets when someone runs those by hand, and `dist/*.dmg` would eventually
# scoop up something that is not tonight's build.
[ "$copied" -ge 3 ] || die 12 "expected at least dmg + zip + latest-mac.yml in $DEST, copied $copied"

ln -sfn "$DEST" "$OUT/latest"
artifact="$DEST"
du -sh "$DEST" | sed 's/^/--- /'

# --- 7. retention ----------------------------------------------------------
# ~285MB a night. Two weeks is ~4GB, which is nothing on this box, and is long
# enough that a regression noticed on a Friday can still be bisected against
# Monday's build.
find "$OUT" -maxdepth 1 -type d -name '20*' -mtime "+$KEEP_DAYS" -print -exec rm -rf {} + 2>/dev/null

exit_code=0
note="ok"
echo "=== built $version @ $commit → $DEST ==="
exit 0
