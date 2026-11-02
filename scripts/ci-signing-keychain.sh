#!/usr/bin/env bash
#
# CI only: put the Developer ID identity from CSC_LINK / CSC_KEY_PASSWORD into a
# keychain of our own, and point electron-builder at it with CSC_KEYCHAIN.
#
# Why not let electron-builder import CSC_LINK itself: up to 26.16.0 it runs
# `security set-key-partition-list -k <the .p12 password>`, but -k wants the
# password of the keychain, which it set to something random. macOS rejects that
# with "The user name or passphrase you entered is not correct", whatever the
# secrets are, and macos-15 runners reject it just as macos-26 ones do. See #791.
#
# The caller must NOT pass CSC_LINK on to electron-builder, or it takes the
# broken path anyway.

set -euo pipefail

: "${CSC_LINK:?CSC_LINK secret is empty}"
: "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD secret is empty}"

keychain="$RUNNER_TEMP/vibeconf-signing.keychain-db"
p12="$RUNNER_TEMP/devid.p12"
ca="$RUNNER_TEMP/developer-id-ca.cer"
trap 'rm -f "$p12" "$ca"' EXIT

password=$(openssl rand -hex 32)
echo "::add-mask::$password"

security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"

printf '%s' "$CSC_LINK" | base64 --decode > "$p12"
security import "$p12" -k "$keychain" -f pkcs12 -P "$CSC_KEY_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/productbuild

# The .p12 may not carry the chain, and the identity isn't valid without it. If
# it does, importing the same CA fails with "already exists", which is fine: the
# find-identity check below is what decides.
for url in \
  https://www.apple.com/certificateauthority/DeveloperIDCA.cer \
  https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer; do
  curl -fsS "$url" -o "$ca"
  security import "$ca" -k "$keychain" -t cert || true
done

security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null

# codesign only looks at keychains on the search list.
existing=()
while IFS= read -r line; do
  line=${line#"${line%%[![:space:]]*}"}
  existing+=("${line//\"/}")
done < <(security list-keychains -d user)
security list-keychains -d user -s "$keychain" "${existing[@]}"

identities=$(security find-identity -v -p codesigning "$keychain")
echo "$identities"
if [[ "$identities" != *"Developer ID Application"* ]]; then
  echo "::error::no valid Developer ID Application identity after importing the .p12"
  exit 1
fi

echo "CSC_KEYCHAIN=$keychain" >> "$GITHUB_ENV"
