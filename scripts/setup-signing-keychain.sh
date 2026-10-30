#!/usr/bin/env bash
#
# Give this Mac a keychain that automation can unlock, so builds over SSH can
# sign. Run it once, in a Terminal at the Mac's own screen (macOS asks you to
# approve exporting the key). Rerun with --rebuild after renewing the cert.
#
#   scripts/setup-signing-keychain.sh [--rebuild]
#
# Why: the login keychain stays locked to SSH sessions, even while you're logged
# in at the screen, so codesign fails there with errSecInternalComponent. This
# copies the Developer ID identity into its own keychain, whose random password
# lives in a file only this user can read. scripts/with-signing.sh unlocks it.
#
# Passwords go to `security` over stdin, never as arguments, because other
# accounts on the Mac can read process arguments.

set -euo pipefail

IDENTITY="Developer ID Application: Stanley James (PNPVJ6J7X2)"
KEYCHAIN="$HOME/Library/Keychains/vibeconf-signing.keychain-db"
PASSWORD_FILE="$HOME/.config/vibeconf/signing-keychain-password"
LOGIN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
APPLE_CA_URLS=(
  https://www.apple.com/certificateauthority/DeveloperIDCA.cer
  https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
)

die() { echo "✗ $*" >&2; exit 1; }

if [[ -n "${SSH_TTY:-}${SSH_CONNECTION:-}" ]]; then
  die "Run this at the Mac's own screen, not over SSH: macOS has to ask you to approve exporting the key."
fi
if [[ -e "$KEYCHAIN" && "${1:-}" != "--rebuild" ]]; then
  die "$KEYCHAIN already exists. Use --rebuild to replace it (after renewing the cert, say)."
fi

security find-identity -v -p codesigning "$LOGIN_KEYCHAIN" | grep -qF "\"$IDENTITY\"" \
  || die "\"$IDENTITY\" isn't a valid identity in the login keychain."

WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

EXPORT_PASSWORD=$(openssl rand -hex 32)
KEYCHAIN_PASSWORD=$(openssl rand -hex 32)

echo "→ Exporting the identity. Approve the macOS prompt (Always Allow isn't needed)."
printf 'export -k "%s" -t identities -f pkcs12 -P %s -o "%s"\n' \
  "$LOGIN_KEYCHAIN" "$EXPORT_PASSWORD" "$WORK/identity.p12" | security -i >/dev/null
[[ -s "$WORK/identity.p12" ]] || die "The export produced nothing (was the prompt denied?)."

echo "→ Fetching Apple's Developer ID intermediate certificates."
i=0
for url in "${APPLE_CA_URLS[@]}"; do
  i=$((i + 1))
  curl -fsS "$url" -o "$WORK/ca$i.cer" || die "Couldn't download $url"
done

if [[ -e "$KEYCHAIN" ]]; then
  echo "→ Replacing the old signing keychain."
  security delete-keychain "$KEYCHAIN"
fi

echo "→ Creating $KEYCHAIN"
{
  printf 'create-keychain -p %s "%s"\n' "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  printf 'set-keychain-settings "%s"\n' "$KEYCHAIN" # no auto-lock: with-signing.sh unlocks per build
  printf 'unlock-keychain -p %s "%s"\n' "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  printf 'import "%s" -k "%s" -P %s -T /usr/bin/codesign -T /usr/bin/productbuild\n' \
    "$WORK/identity.p12" "$KEYCHAIN" "$EXPORT_PASSWORD"
  printf 'import "%s" -k "%s" -t cert\n' "$WORK/ca1.cer" "$KEYCHAIN"
  printf 'import "%s" -k "%s" -t cert\n' "$WORK/ca2.cer" "$KEYCHAIN"
  printf 'set-key-partition-list -S apple-tool:,apple:,codesign: -s -k %s "%s"\n' \
    "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
} | security -i >/dev/null

# codesign only finds identities in keychains on the search list.
read -r -a SEARCH_LIST <<<"$(security list-keychains -d user | tr -d '"' | grep -vF "$KEYCHAIN" | xargs)"
security list-keychains -d user -s "$KEYCHAIN" "${SEARCH_LIST[@]}"

(umask 077; mkdir -p "$(dirname "$PASSWORD_FILE")"; printf '%s\n' "$KEYCHAIN_PASSWORD" >"$PASSWORD_FILE")
chmod 600 "$PASSWORD_FILE"

security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "\"$IDENTITY\"" \
  || die "The identity isn't valid in the new keychain."

security lock-keychain "$KEYCHAIN"
cp /usr/bin/true "$WORK/signtest"
if "$(dirname "$0")/with-signing.sh" --no-notarize \
    codesign --force --timestamp=none --sign "$IDENTITY" "$WORK/signtest" 2>/dev/null; then
  echo "✓ Done. From SSH, verify with: scripts/with-signing.sh --check"
else
  die "The keychain was created, but a test signature failed."
fi
