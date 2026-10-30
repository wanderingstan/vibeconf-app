#!/usr/bin/env bash
#
# Run a command with everything a signed, notarized Mac build needs, from any
# shell, SSH and LaunchAgents included:
#
#   scripts/with-signing.sh pnpm --dir electron-app dist
#   scripts/with-signing.sh --check     (a test signature, no build)
#
# Unlocks the keychain from setup-signing-keychain.sh when this Mac has one (a
# Mac without one signs from its login keychain, which only works at its screen)
# and loads the notarization login from ~/.zshrc, which non-interactive shells
# don't read. Fails if that login is missing, because electron-builder would only
# warn and hand back an un-notarized app. --no-notarize skips that requirement.

set -euo pipefail

IDENTITY="Developer ID Application: Stanley James (PNPVJ6J7X2)"
KEYCHAIN="$HOME/Library/Keychains/vibeconf-signing.keychain-db"
PASSWORD_FILE="$HOME/.config/vibeconf/signing-keychain-password"

die() { echo "✗ $*" >&2; exit 1; }

NOTARIZE=1
CHECK=0
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --no-notarize) NOTARIZE=0 ;;
    --check) CHECK=1 ;;
    *) die "Unknown option $1" ;;
  esac
  shift
done

if [[ -e "$KEYCHAIN" ]]; then
  [[ -r "$PASSWORD_FILE" ]] || die "$KEYCHAIN exists but $PASSWORD_FILE doesn't. Rerun setup-signing-keychain.sh --rebuild."
  printf 'unlock-keychain -p %s "%s"\n' "$(cat "$PASSWORD_FILE")" "$KEYCHAIN" | security -i >/dev/null
  export CSC_KEYCHAIN="$KEYCHAIN"
fi

if [[ "$NOTARIZE" == 1 && "$CHECK" == 0 ]]; then
  eval "$(grep -E '^[[:space:]]*export APPLE_(ID|APP_SPECIFIC_PASSWORD|TEAM_ID)=' "$HOME/.zshrc" || true)"
  for var in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
    [[ -n "${!var:-}" ]] || die "$var isn't set, and ~/.zshrc doesn't export it. The build wouldn't be notarized."
    export "${var?}"
  done
fi

if [[ "$CHECK" == 1 ]]; then
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  cp /usr/bin/true "$WORK/signtest"
  codesign --force --timestamp=none --sign "$IDENTITY" "$WORK/signtest"
  echo "✓ Signed with $(codesign -dvv "$WORK/signtest" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
  exit 0
fi

[[ $# -gt 0 ]] || die "Nothing to run."
exec "$@"
