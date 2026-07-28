#!/usr/bin/env bash
# Render the DMG window background from its SVG source, stamping the
# current app version into the footer.
#
# WHY THIS EXISTS
#   `make-dmg.sh` consumes background.png / background@2x.png as opaque
#   binaries. Nothing regenerated them from background.svg, so the art
#   silently rotted: the footer still read v0.19.0 twelve releases later,
#   and the lockup still drew the retired six-petal blossom long after
#   the app icon became the binary-box mark. Committed PNGs with no
#   reproducible path back to their source always drift — this closes it.
#
# RUN IT when you change background.svg, when the mark changes in
# src/components/AuraMark.tsx (the glyph's source of truth), or on a
# version bump. It is deliberately NOT wired into build-release.sh: the
# release must not gain a hard dependency on an SVG renderer being
# installed. Regenerate, eyeball, commit the PNGs.
#
#   ./scripts/build-dmg-background.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHELL_DIR="$(cd "$HERE/.." && pwd)"
DMG_DIR="$SHELL_DIR/src-tauri/dmg"
SVG="$DMG_DIR/background.svg"

# 1x is the size the Finder window is laid out against in make-dmg.sh;
# @2x is the Retina companion tiffutil pairs it with.
WIDTH=660
HEIGHT=420

[ -f "$SVG" ] || { echo "✗ missing $SVG" >&2; exit 1; }

VERSION="$(node -p "require('$SHELL_DIR/package.json').version")"
[ -n "$VERSION" ] || { echo "✗ could not read version from package.json" >&2; exit 1; }

# Renderer. The artwork leans on `feGaussianBlur` for its ambient glow,
# and partial SVG implementations drop filters *silently* — cairosvg
# renders the three glow ellipses as hard-edged blobs and calls it a
# success. A browser engine is the only thing here that gets both the
# filter and the fill rules right, so Chrome is preferred and rsvg is
# the fallback; cairosvg is deliberately not used.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  # Chrome screenshots a page, not a file, so the SVG is wrapped in a
  # zero-margin document sized to the artwork. Retina comes from the
  # device scale factor rather than a bigger window, which keeps text
  # hinting and the blur radius identical between the two outputs.
  render() {
    local svg="$1" out="$2" w="$3" scale="$4"
    local html="${TMPDIR:-/tmp}/aura-dmg-bg-$$.html"
    {
      printf '<!doctype html><meta charset="utf-8">'
      printf '<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>'
      cat "$svg"
    } > "$html"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
      --default-background-color=00000000 \
      --force-device-scale-factor="$scale" \
      --window-size="$w,$HEIGHT" \
      --screenshot="$out" "file://$html" >/dev/null 2>&1
    rm -f "$html"
    [ -s "$out" ] || { echo "✗ chrome produced no image" >&2; return 1; }
  }
elif command -v rsvg-convert >/dev/null 2>&1; then
  render() { rsvg-convert "$1" -o "$2" -w "$3" -h "$(( HEIGHT * $4 ))"; }
else
  echo "✗ need Google Chrome or rsvg-convert (brew install librsvg)" >&2
  exit 1
fi

echo "▸ stamping v$VERSION into the footer"
STAMPED="$(mktemp -t aura-dmg-bg).svg"
trap 'rm -f "$STAMPED"' EXIT
# Replace only the text node carrying id="dmg-version", so the rest of
# the artwork is passed through byte-for-byte.
VERSION="$VERSION" python3 - "$SVG" "$STAMPED" <<'PY'
import os, re, sys

src, dst = sys.argv[1], sys.argv[2]
version = os.environ["VERSION"]
svg = open(src, encoding="utf-8").read()
pattern = re.compile(r'(<text\b[^>]*\bid="dmg-version"[^>]*>)([^<]*)(</text>)', re.S)
svg, n = pattern.subn(lambda m: f"{m.group(1)}v{version}{m.group(3)}", svg)
if n != 1:
    sys.exit(f"expected exactly one id=\"dmg-version\" text node, found {n}")
open(dst, "w", encoding="utf-8").write(svg)
# Keep the checked-in SVG truthful too, so reading it never lies about
# which release it belongs to.
open(src, "w", encoding="utf-8").write(svg)
PY

echo "▸ rendering ${WIDTH}x${HEIGHT} + @2x"
render "$STAMPED" "$DMG_DIR/background.png"    "$WIDTH" 1
render "$STAMPED" "$DMG_DIR/background@2x.png" "$WIDTH" 2

echo "✓ $DMG_DIR/background.png"
echo "✓ $DMG_DIR/background@2x.png"
echo "  now eyeball them, then commit both PNGs with the SVG."
