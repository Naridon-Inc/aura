#!/usr/bin/env bash
# Inject the `aura` CLI into the built .deb.
#
# WHY this exists: tauri bundles the aura-shell package's own binaries
# (aura-shell, aura-pty-daemon, aura-shell-mcp) and nothing else. The `aura` CLI
# is a workspace-EXCLUDED crate, so it never reaches the .deb — and the app
# resolves `aura` next to its own binary at runtime, the same way it does on
# macOS (app:bundle-cli) and in the AppImage (_linux-appimage-bundle-cli.sh).
# Without this step a .deb install has a shell with no engine underneath it:
# no `aura mcp`, no CLI on PATH.
#
# The AppImage gets the same two companions injected into its AppDir before it
# is packed. A .deb is already packed by the time we see it, so it has to be
# opened, added to, and re-sealed — including the control metadata that dpkg
# verifies (md5sums, Installed-Size), or `debsums` and some installers complain.
#
#   ARCH=arm64 _linux-deb-bundle-cli.sh [deb-path] [aura-binary]
#
# Runs INSIDE the Linux build container, AFTER `tauri build`. Idempotent: a deb
# that already carries usr/bin/aura is left alone.
set -euo pipefail

TARGET_DIR="${CARGO_TARGET_DIR:-/build/target}"
ARCH="${ARCH:-x86_64}"
DEB="${1:-}"
CLI_BIN="${2:-$TARGET_DIR/release/aura}"

if [ -z "$DEB" ]; then
  # The bundle dir is on a persistent cache volume and accumulates every version
  # ever built here, both arches. Name the file we want outright — picking the
  # first of a glob would inject this build's CLI into some 0.19.5 deb and leave
  # the real artifact untouched.
  case "$ARCH" in
    arm64|aarch64) DEB_ARCH=arm64 ;;
    x86_64|amd64)  DEB_ARCH=amd64 ;;
    *) echo "✗ unknown ARCH: $ARCH (use arm64 | x86_64)"; exit 2 ;;
  esac
  VERSION="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /work/aura-shell/src-tauri/tauri.conf.json \
             | head -1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"//;s/"//')"
  [ -n "$VERSION" ] || { echo "✗ could not read version from tauri.conf.json"; exit 1; }
  DEB="$TARGET_DIR/release/bundle/deb/Aura_${VERSION}_${DEB_ARCH}.deb"
fi
[ -f "$DEB" ] || { echo "✗ no .deb at $DEB"; exit 1; }
[ -f "$CLI_BIN" ] || { echo "✗ aura CLI not found at $CLI_BIN (Linux build)"; exit 1; }

if dpkg-deb -c "$DEB" | grep -qE ' \./usr/bin/aura$| usr/bin/aura$'; then
  echo "✓ $(basename "$DEB") already carries usr/bin/aura — nothing to do"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
dpkg-deb -R "$DEB" "$WORK/pkg"

install -m 0755 "$CLI_BIN" "$WORK/pkg/usr/bin/aura"
echo "── injected: usr/bin/aura ($(stat -c%s "$CLI_BIN") b)"

# md5sums is what `debsums` checks an installed file tree against; a package
# carrying a file it has no checksum for reports as tampered-with.
( cd "$WORK/pkg" && md5sum usr/bin/aura >> DEBIAN/md5sums )

# Installed-Size is in KiB and is what apt shows and budgets disk against.
SIZE_KB=$(du -sk --exclude=DEBIAN "$WORK/pkg" | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: $SIZE_KB/" "$WORK/pkg/DEBIAN/control"

# Rebuild beside the original and swap in place, so a failed pack can never
# leave a half-written .deb where the release script expects a good one.
dpkg-deb --build "$WORK/pkg" "$WORK/out.deb" >/dev/null
mv -f "$WORK/out.deb" "$DEB"
echo "✓ CLI-complete deb: $DEB ($(stat -c%s "$DEB") b, installed $SIZE_KB KiB)"
