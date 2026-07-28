#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# make-dmg.sh — build a proper drag-to-install macOS DMG.
#
# Why this exists:
#   `tauri build` produces a nice DMG (Applications symlink + background +
#   icon layout, per the `dmg` block in tauri.conf.json) — but we throw it
#   away, because we insert aura-shell-mcp + the aura CLI into Aura.app AFTER
#   that step and then re-sign/notarize/staple. The old rebuild used a bare
#   `hdiutil create -srcfolder Aura.app`, which packaged ONLY the app: no
#   Applications shortcut, no background, no layout. Users then ran Aura
#   straight from the mounted read-only image, and auto-update failed with
#   "Auto-install isn't supported on this drive." (GitHub issue #5.)
#
#   This rebuilds the DMG the RIGHT way from a fully-signed .app:
#     • a staging folder holding Aura.app + an Applications symlink
#     • the branded background (retina via a 1x/2x TIFF)
#     • Finder icon layout matching tauri.conf.json (app top-right, Applications
#       below it) so the drag-to-install gesture reads at a glance
#
# The Finder layout uses AppleScript, which needs a GUI login session + one-time
# Automation permission. That step is best-effort and time-boxed: if it can't
# run (headless CI, no TCC grant), we STILL ship a valid DMG that contains the
# Applications symlink — the actual bug fix — and let Finder auto-arrange. The
# critical fix never depends on AppleScript succeeding.
#
# Usage:  make-dmg.sh <app-path> <out-dmg-path> [volname]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP="${1:?app path required (…/bundle/macos/Aura.app)}"
OUT="${2:?output dmg path required}"
VOL="${3:-Aura}"

[ -d "$APP" ] || { echo "✗ app not found: $APP" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DMG_ASSETS="$SCRIPT_DIR/../src-tauri/dmg"
BG_1X="$DMG_ASSETS/background.png"
BG_2X="$DMG_ASSETS/background@2x.png"

# Icon layout — keep in lockstep with tauri.conf.json > bundle.macOS.dmg so the
# DMG looks identical whether Tauri or this script built it.
WIN_W=660 ; WIN_H=420
APP_X=470 ; APP_Y=128
APPS_X=470; APPS_Y=300
ICON_SIZE=96

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/aura-dmg.XXXXXX")"
RW="$(mktemp -u "${TMPDIR:-/tmp}/aura-rw.XXXXXX").dmg"
DEV=""

cleanup() {
  # Detach the rw image if still mounted, then drop scratch.
  if [ -n "$DEV" ]; then hdiutil detach "$DEV" -force >/dev/null 2>&1 || true; fi
  rm -rf "$STAGE" 2>/dev/null || true
  rm -f "$RW" 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Stage: app + Applications symlink + background ───────────────────────
echo "▸ staging DMG contents"
ditto "$APP" "$STAGE/$(basename "$APP")"     # ditto preserves signature + xattrs
ln -s /Applications "$STAGE/Applications"    # the drag-install target

mkdir -p "$STAGE/.background"
BG_REF=""                                    # colon-path used inside AppleScript
if [ -f "$BG_1X" ]; then
  if [ -f "$BG_2X" ] && command -v tiffutil >/dev/null 2>&1; then
    # Multi-resolution TIFF → crisp on Retina and non-Retina.
    tiffutil -cathidpicheck "$BG_1X" "$BG_2X" -out "$STAGE/.background/background.tiff" >/dev/null 2>&1 \
      && BG_REF="background.tiff"
  fi
  if [ -z "$BG_REF" ]; then
    cp "$BG_1X" "$STAGE/.background/background.png"
    BG_REF="background.png"
  fi
else
  echo "⚠ no background at $BG_1X — shipping a plain (but working) DMG"
fi

# ── 2. Create a writable image sized to the staged content + slack ──────────
STAGE_KB="$(du -sk "$STAGE" | awk '{print $1}')"
SIZE_KB=$(( STAGE_KB + 40000 ))              # ~40MB headroom for FS overhead
echo "▸ creating writable image (${SIZE_KB}k)"
rm -f "$RW"
hdiutil create -srcfolder "$STAGE" -volname "$VOL" -fs HFS+ \
  -fsargs "-c c=64,a=16,e=16" -format UDRW -size "${SIZE_KB}k" "$RW" >/dev/null

DEV="$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | grep '^/dev/' | head -1 | awk '{print $1}')"
MNT="/Volumes/$VOL"
[ -d "$MNT" ] || { echo "✗ mount failed for $RW" >&2; exit 1; }

# ── 3. Finder layout (best-effort, time-boxed, non-fatal) ───────────────────
if [ -n "$BG_REF" ]; then
  echo "▸ applying Finder layout (best-effort, 45s cap)"
  LAYOUT=$(cat <<APPLESCRIPT
on run
  tell application "Finder"
    tell disk "$VOL"
      open
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {300, 140, $((300 + WIN_W)), $((140 + WIN_H))}
      set vopts to the icon view options of container window
      set arrangement of vopts to not arranged
      set icon size of vopts to $ICON_SIZE
      set text size of vopts to 12
      set background picture of vopts to file ".background:$BG_REF"
      set position of item "$(basename "$APP")" of container window to {$APP_X, $APP_Y}
      set position of item "Applications" of container window to {$APPS_X, $APPS_Y}
      update without registering applications
      delay 1
      close
    end tell
  end tell
end run
APPLESCRIPT
)
  TIMEOUT_BIN="$(command -v gtimeout || command -v timeout || true)"
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" 45 osascript -e "$LAYOUT" >/dev/null 2>&1 \
      && echo "  ✓ layout applied" \
      || echo "  ⚠ layout skipped (headless / no automation grant) — DMG still valid"
  else
    osascript -e "$LAYOUT" >/dev/null 2>&1 \
      && echo "  ✓ layout applied" \
      || echo "  ⚠ layout skipped — DMG still valid"
  fi
fi

# Make sure the Applications symlink + .background are flushed before detach.
sync
hdiutil detach "$DEV" -force >/dev/null 2>&1 || true
DEV=""

# ── 4. Convert to a compressed, read-only image ─────────────────────────────
echo "▸ compressing → $OUT"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null

# ── 5. Prove the fix is actually in the artifact ────────────────────────────
VERIFY_DEV="$(hdiutil attach -readonly -nobrowse -noautoopen "$OUT" | grep '^/dev/' | head -1 | awk '{print $1}')"
VMNT="/Volumes/$VOL"
if [ -L "$VMNT/Applications" ]; then
  echo "  ✓ Applications symlink present → $(readlink "$VMNT/Applications")"
else
  hdiutil detach "$VERIFY_DEV" -force >/dev/null 2>&1 || true
  echo "✗ FATAL: built DMG is missing the Applications symlink" >&2
  exit 1
fi
hdiutil detach "$VERIFY_DEV" -force >/dev/null 2>&1 || true

echo "✓ DMG built: $OUT"
