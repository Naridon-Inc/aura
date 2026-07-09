#!/usr/bin/env bash
# Produce the BRANDED installer DMG we actually ship to website downloaders.
#
# Why this exists: `sign-notarize.sh` rebuilds the deliverable as a BARE dmg
# (`hdiutil create -srcfolder $APP`) — just the .app, no styled installer
# window. Tauri's own `Aura_<ver>_<arch>.dmg` HAS the styled layout
# (.background + .DS_Store + Applications symlink + window bounds) but holds the
# pass-1 app (signed before we inserted the bundled `aura` CLI) and isn't
# stapled. Neither is shippable on its own.
#
# This takes tauri's styled dmg and swaps in the FINAL app (deep-signed,
# notarized, stapled, CLI-bearing) from macos/Aura.app, keeping the styled
# layout, then re-signs + notarizes + staples the dmg. Output:
#   <target>/dmg/Aura_styled_<arch>.dmg  — styled + complete + stapled.
#
# Usage:  scripts/style-dmg.sh <arch>     where <arch> = arm64 | intel
set -euo pipefail
export PATH="/usr/bin:/usr/sbin:/bin:/sbin:$PATH"

ARCH="${1:?arch arg required: arm64 | intel}"
VER="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' src-tauri/tauri.conf.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

case "$ARCH" in
  arm64)  TARGET_DIR="../target/aarch64-apple-darwin/release/bundle"; TAURI_ARCH="aarch64" ;;
  intel)  TARGET_DIR="../target/x86_64-apple-darwin/release/bundle";  TAURI_ARCH="x64"     ;;
  *) echo "unknown arch: $ARCH (use arm64 or intel)"; exit 2 ;;
esac

STYLED="$TARGET_DIR/dmg/Aura_${VER}_${TAURI_ARCH}.dmg"
FINAL_APP="$TARGET_DIR/macos/Aura.app"
OUT="$TARGET_DIR/dmg/Aura_styled_${ARCH}.dmg"

[ -f "$STYLED" ]    || { echo "✗ styled source dmg missing: $STYLED"; exit 1; }
[ -d "$FINAL_APP" ] || { echo "✗ final app missing: $FINAL_APP"; exit 1; }

if [ -z "${APPLE_ID:-}" ] && [ -f "$HOME/.aura-notarize.env" ]; then
  set -a; . "$HOME/.aura-notarize.env"; set +a
fi
IDENTITY="Developer ID Application: Aikolumi Software Private Limited (A5S8X4RCAS)"

WORK="$(mktemp -d)"
RW="$WORK/rw.dmg"
MNT="$WORK/mnt"
TMP_OUT="$WORK/out.dmg"
mkdir -p "$MNT"
cleanup() { hdiutil detach "$MNT" >/dev/null 2>&1 || true; rm -rf "$WORK" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "▸ converting styled dmg → read-write ($VER $ARCH)"
hdiutil convert "$STYLED" -format UDRW -o "$RW" >/dev/null
# the final app carries the CLI → larger than tauri's pass-1 app; grow the volume.
hdiutil resize -size 400m "$RW" >/dev/null 2>&1 || true

echo "▸ mounting + swapping in the final stapled app"
hdiutil attach "$RW" -nobrowse -noverify -mountpoint "$MNT" >/dev/null
mv "$MNT/Aura.app" "$WORK/pass1-Aura.app"
ditto "$FINAL_APP" "$MNT/Aura.app"
sync
hdiutil detach "$MNT" >/dev/null
trap 'rm -rf "$WORK" >/dev/null 2>&1 || true' EXIT

echo "▸ compressing → UDZO"
hdiutil convert "$RW" -format UDZO -o "$TMP_OUT" >/dev/null
mv -f "$TMP_OUT" "$OUT"

echo "▸ signing dmg"
codesign --force --timestamp --sign "$IDENTITY" "$OUT"

if [ "${SKIP_NOTARIZE:-0}" != "1" ]; then
  echo "▸ notarizing dmg (waits for Apple)"
  xcrun notarytool submit "$OUT" \
    --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$OUT"
fi

echo "✓ branded installer: $OUT"
