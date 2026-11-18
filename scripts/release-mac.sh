#!/usr/bin/env bash
# Builds Kiln for Mac (Apple silicon + Intel in one app), signs it with the
# Developer ID in your keychain, notarizes it with Apple, and staples the ticket.
#
# One-time setup (you type the secrets, they stay in your keychain):
#   xcrun notarytool store-credentials kiln-notary \
#     --key ~/path/AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <issuer-uuid>
# The App Store Connect key can be the same one Friday's release uses.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
PROFILE="${NOTARY_PROFILE:-kiln-notary}"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
npx tauri build --target universal-apple-darwin --bundles app,dmg

BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"
APP="$BUNDLE/macos/Kiln.app"
DMG="$(ls "$BUNDLE"/dmg/Kiln_*.dmg | head -1)"

codesign --verify --deep --strict "$APP"
codesign -dv "$APP" 2>&1 | grep -E "Authority=Developer ID|flags=.*runtime" || { echo "App is not Developer ID signed with hardened runtime"; exit 1; }
codesign --sign "Developer ID Application: ARUNMOZHI JOSEPH DASS (24DXLQLMPR)" --timestamp "$DMG"

xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl -a -t open --context context:primary-signature -v "$DMG"

mkdir -p release
OUT="release/Kiln-universal.dmg"   # stable name so releases/latest/download/Kiln-universal.dmg always works
cp "$DMG" "$OUT"
shasum -a 256 "$OUT" > "$OUT.sha256"
echo "Ready: $OUT"
