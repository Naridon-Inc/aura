#!/usr/bin/env bash
# Re-sign + notarize a Tauri-built .app after we've inserted aura-shell-mcp.
#
# Why: `bun run tauri build` signs the .app, then we cp aura-shell-mcp into
# Contents/MacOS which breaks the bundle signature. We re-sign deep, send
# to notarytool, staple, then re-sign the DMG.
#
# Required env (export in shell or put in ~/.aura-notarize.env):
#   APPLE_ID         — apple-id email
#   APPLE_PASSWORD   — app-specific password from appleid.apple.com
#   APPLE_TEAM_ID    — A5S8X4RCAS (Aikolumi)
#
# Optional:
#   SKIP_NOTARIZE=1  — sign only, don't send to Apple. App still works
#                      locally + via xattr -cr but won't pass Gatekeeper
#                      cleanly on download.
#
# Usage:  scripts/sign-notarize.sh <arch>     where <arch> = arm64 | intel

set -euo pipefail

ARCH="${1:?arch arg required: arm64 | intel}"

# Pre-flight: Tauri's icon loader panics at startup if any PNG is 16-bit/channel
# (it expects 8-bit RGBA = 4 bytes/pixel). v0.2.2 shipped 16-bit icons and bricked
# every install. Abort the build if any icon regresses.
ICON_DIR="src-tauri/icons"
if [ -d "$ICON_DIR" ]; then
  if file "$ICON_DIR"/*.png 2>/dev/null | grep -q "16-bit"; then
    echo "✗ FATAL: 16-bit PNG icon detected — Tauri will panic at launch."
    file "$ICON_DIR"/*.png | grep "16-bit"
    echo "Regenerate with: magick <src> -depth 8 -define png:bit-depth=8 -define png:color-type=6 PNG32:<out>"
    exit 1
  fi
fi

case "$ARCH" in
  arm64)  TARGET_DIR="../target/aarch64-apple-darwin/release/bundle" ;;
  intel)  TARGET_DIR="../target/x86_64-apple-darwin/release/bundle"  ;;
  *) echo "unknown arch: $ARCH (use arm64 or intel)"; exit 2 ;;
esac

APP="$TARGET_DIR/macos/Aura.app"
DMG="$TARGET_DIR/dmg/Aura_local_${ARCH}.dmg"

# Try to source creds if not already in env.
if [ -z "${APPLE_ID:-}" ] && [ -f "$HOME/.aura-notarize.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.aura-notarize.env"
  set +a
fi

IDENTITY="Developer ID Application: Aikolumi Software Private Limited (A5S8X4RCAS)"
ENTITLEMENTS="src-tauri/entitlements.plist"

echo "▸ deep-signing $APP"
# Sign every nested binary first (deep signing isn't always reliable
# with hardenedRuntime + jit entitlements, so we do them explicitly).
# CRITICAL: the main bundle exe (whatever productName resolves to) MUST
# be signed last — codesign treats sibling binaries in Contents/MacOS
# as subcomponents of the main exe and rejects when it finds them
# unsigned at the time of parent sign. We read CFBundleExecutable from
# Info.plist so this works regardless of what productName becomes.
MAIN_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
MAIN_EXE="$APP/Contents/MacOS/$MAIN_NAME"
find "$APP/Contents/MacOS" -type f -perm +111 -print0 | while IFS= read -r -d '' bin; do
  if [ "$bin" = "$MAIN_EXE" ]; then
    continue
  fi
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" \
    "$bin"
done
# Sign the main exe last, then the bundle root.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$MAIN_EXE"
# Sign the bundle root.
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" \
  "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
echo "✓ app signed"

if [ "${SKIP_NOTARIZE:-0}" = "1" ]; then
  echo "⚠ SKIP_NOTARIZE=1 — skipping Apple notarization"
else
  : "${APPLE_ID:?APPLE_ID not set (put in ~/.aura-notarize.env)}"
  : "${APPLE_PASSWORD:?APPLE_PASSWORD not set (put in ~/.aura-notarize.env)}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set (put in ~/.aura-notarize.env)}"

  ZIP="$TARGET_DIR/macos/Aura-${ARCH}.zip"
  rm -f "$ZIP"
  echo "▸ zipping for notarization"
  ditto -c -k --keepParent "$APP" "$ZIP"

  echo "▸ submitting to notarytool (waits until Apple is done)"
  xcrun notarytool submit "$ZIP" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  rm -f "$ZIP"

  echo "▸ stapling ticket onto .app"
  xcrun stapler staple "$APP"
  echo "✓ app notarized + stapled"
fi

# Now rebuild the DMG with the signed/stapled app inside.
echo "▸ rebuilding DMG"
rm -f "$TARGET_DIR/dmg/Aura_local"*.dmg
mkdir -p "$TARGET_DIR/dmg"
hdiutil create -volname Aura \
  -srcfolder "$APP" \
  -ov -format UDZO \
  "$DMG"

echo "▸ signing DMG"
codesign --force --timestamp --sign "$IDENTITY" "$DMG"

if [ "${SKIP_NOTARIZE:-0}" != "1" ]; then
  echo "▸ notarizing DMG"
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  xcrun stapler staple "$DMG"
fi

echo ""
echo "✓ built: $DMG"
