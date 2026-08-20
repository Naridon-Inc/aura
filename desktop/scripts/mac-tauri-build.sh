#!/usr/bin/env bash
# Aura desktop — macOS `tauri build` wrapper.
#
# Usage: scripts/mac-tauri-build.sh <target-triple>
#          aarch64-apple-darwin | x86_64-apple-darwin
#
# Exists for one reason: to guarantee tauri's bundler finds Apple's xattr.
#
# After compiling, the macOS bundler shells out to `xattr -cr <Aura.app>` to
# strip extended attributes before signing, and resolves `xattr` through PATH.
# Anaconda ships its own `xattr` (the old pyobjc script) in ~/anaconda3/bin,
# and that has no `-r` flag. When anaconda precedes /usr/bin — which is the
# default once `conda init` has touched a shell profile — the bundle step dies
# with:
#
#     failed to bundle project failed to remove extra attributes from app
#     bundle: `failed to run xattr`
#
# and it dies AFTER the full release compile, so the cost of hitting it is the
# whole build. `@tauri-apps/cli` is pinned as `^2`, so a routine `bun install`
# can introduce the xattr step on a machine that never saw it before; that is
# how 0.19.33's arm64 leg first hit it.
#
# The fix is a directory holding one symlink to /usr/bin/xattr, put at the front
# of PATH. Prepending /usr/bin wholesale would also work, but would silently
# re-order every other tool the build resolves; this moves exactly the one that
# is wrong.
set -euo pipefail

TARGET="${1:?target triple required: aarch64-apple-darwin | x86_64-apple-darwin}"

SHIM_DIR="$(mktemp -d)"
cleanup() { rm -f "$SHIM_DIR/xattr"; rmdir "$SHIM_DIR" 2>/dev/null || true; }
trap cleanup EXIT

ln -s /usr/bin/xattr "$SHIM_DIR/xattr"
export PATH="$SHIM_DIR:$PATH"

# Prove the tool can do the job now, rather than discovering it can't at the end
# of a release compile. A probe dir has no xattrs, so this is purely a flag check.
PROBE="$(mktemp -d)"
if ! xattr -cr "$PROBE" 2>/dev/null; then
  rmdir "$PROBE"
  echo "✗ 'xattr -cr' does not work with the xattr on PATH ($(command -v xattr))."
  echo "  tauri's bundler needs Apple's /usr/bin/xattr and something is shadowing it."
  exit 3
fi
rmdir "$PROBE"
echo "── xattr: $(command -v xattr) → $(readlink "$SHIM_DIR/xattr") (supports -cr)"

# Build ONLY the .app. tauri.conf sets `targets: all`, so tauri would also run
# its own DMG step — and we throw that DMG away regardless: aura-shell-mcp and
# the aura CLI are inserted into Aura.app afterwards, so the image has to be
# rebuilt from the re-signed, notarized, stapled bundle. scripts/make-dmg.sh does
# that (and is the one that carries the Applications symlink the updater needs —
# see its header, GitHub issue #5).
#
# Building it twice is not merely wasted minutes: tauri's bundle_dmg.sh failed
# outright on 0.19.33's arm64 leg, mounting a scratch image it then left behind,
# and took the whole build down with it — after the compile, the .app, and the
# signing had all succeeded. Nothing downstream wanted its output. So don't ask
# for it.
#
# createUpdaterArtifacts is true in tauri.conf.json, which makes the bundler tar
# up the .app and sign it with TAURI_SIGNING_PRIVATE_KEY. That tarball is useless
# here for the same reason the DMG is: it is made from the app as it exists right
# now, before aura-shell-mcp and the CLI are inserted and before notarization
# staples the ticket into the bundle. ship-*/tar-mac-app.sh builds the real one
# from the stapled app and sign-artifacts.sh signs it. Asking for it anyway just
# means the build dies at the very end with "A public key has been found, but no
# private key" unless the key happens to be exported — which is how 0.19.33's
# arm64 leg failed once the DMG step above stopped masking it.
#
# Overridden per-invocation rather than in tauri.conf.json: the Linux legs run
# the same config and their AppImage updater artifact IS the shipped one.
bun run tauri build --target "$TARGET" --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
