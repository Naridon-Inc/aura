#!/usr/bin/env bash
# Build the final, portable, CLI-complete Aura AppImage for Linux.
#
# Arch-aware: `ARCH=x86_64` (built under qemu on an Apple-Silicon host) or
# `ARCH=arm64` (built natively in an arm64 container). `LD_ARCH` is the
# linuxdeploy/appimage arch spelling (`x86_64` / `aarch64`) and the suffix on
# the artifact name (`Aura-x86_64.AppImage` / `Aura-aarch64.AppImage`).
#
# WHY this exists instead of `tauri build`'s own AppImage step:
#   1. On x86_64 (qemu) the AppImage *runtime's* self-launch path crashes —
#      running linuxdeploy / appimagetool as AppImages throws
#      `std::logic_error: subprocess failed (exit code 2)` before doing any
#      work. (Proof: `--appimage-extract` alone works; running the *extracted*
#      inner ELF `AppRun` works; only the runtime's extract-and-run wrapper is
#      broken under qemu.) tauri's bundler also zeroes the AppImage magic bytes
#      (offset 8–10) of its cached linuxdeploy, so we can't even shim that path
#      with a script (the shebang gets shredded).
#   2. On BOTH arches tauri bundles neither the `aura` CLI nor the
#      `aura-shell-mcp` permission-gate sidecar — both are resolved next to the
#      main binary at runtime (the Linux analogue of macOS app:bundle-cli/-mcp).
#   So we own the whole AppImage step here: keep a PRISTINE linuxdeploy in our
#   own cache dir (tauri never touches it), run it via its extracted inner ELF
#   AppRun (no runtime self-launch), inject the two companion binaries into the
#   AppDir tauri assembled, then pack once → libs + CLIs + AppImage.
#
# Runs INSIDE the Linux build container, AFTER `tauri build` has assembled
# `Aura.AppDir`. Idempotent.
set -euo pipefail

ARCH="${ARCH:-x86_64}"
case "$ARCH" in
  arm64|aarch64) LD_ARCH=aarch64 ;;
  x86_64|amd64)  LD_ARCH=x86_64 ;;
  *) echo "✗ unknown ARCH: $ARCH (use arm64 | x86_64)"; exit 2 ;;
esac

TARGET_DIR="${CARGO_TARGET_DIR:-/build/target}"
# Our own tools dir on the persistent cache volume — separate from tauri's
# `${HOME}/.cache/tauri`, which tauri mangles (magic-byte zeroing). Keyed by
# arch so a multi-arch cache volume never mixes an x86_64 linuxdeploy with an
# aarch64 one.
TOOLS="${HOME:-/root}/.cache/aura-appimage-tools/$LD_ARCH"
# linuxdeploy per arch: tauri's mirror carries the (proven) x86_64 build; the
# upstream continuous release carries aarch64.
case "$LD_ARCH" in
  x86_64)  LD_URL="https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-x86_64.AppImage" ;;
  aarch64) LD_URL="https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-aarch64.AppImage" ;;
esac
GTK_URL="https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh"

mkdir -p "$TOOLS"
LD_APPIMAGE="$TOOLS/linuxdeploy-$LD_ARCH.AppImage"

# 1. Pristine linuxdeploy + gtk plugin (download once; never written by tauri).
if [ ! -f "$LD_APPIMAGE" ]; then
  echo "── fetching pristine linuxdeploy ($LD_ARCH)"
  curl -fsSL -o "$LD_APPIMAGE" "$LD_URL"
  chmod +x "$LD_APPIMAGE"
fi
if [ ! -f "$TOOLS/linuxdeploy-plugin-gtk.sh" ]; then
  echo "── fetching linuxdeploy gtk plugin"
  curl -fsSL -o "$TOOLS/linuxdeploy-plugin-gtk.sh" "$GTK_URL"
  chmod +x "$TOOLS/linuxdeploy-plugin-gtk.sh"
fi

# 2. Extract the inner ELF AppRun once (extract-only works under qemu AND in a
#    FUSE-less container; the extract-and-run wrapper does not). Run linuxdeploy
#    via this ELF.
#
#    First neutralize the AppImage type-2 magic (3 bytes `AI\x02` at offset 8):
#    the container's binfmt_misc matches that magic and routes the file to a
#    handler that isn't present here → "Exec format error". Zeroing the magic
#    (exactly what tauri's bundler does) makes the kernel exec it as the plain
#    ELF AppImage runtime, so `--appimage-extract` runs. Harmless to repeat.
if [ ! -x "$TOOLS/ld-extracted/squashfs-root/AppRun" ]; then
  echo "── neutralizing AppImage magic + extracting linuxdeploy inner ELF"
  dd if=/dev/zero of="$LD_APPIMAGE" bs=1 seek=8 count=3 conv=notrunc status=none
  rm -rf "$TOOLS/ld-extracted"; mkdir -p "$TOOLS/ld-extracted"
  ( cd "$TOOLS/ld-extracted" && "$LD_APPIMAGE" --appimage-extract >/dev/null )
fi
LD="$TOOLS/ld-extracted/squashfs-root/AppRun"

# Hand linuxdeploy the gtk plugin under a clean name on a controlled PATH so it
# resolves the plugin AND falls back to its own bundled ELF appimage output
# plugin (no standalone appimagetool AppImage — that can't self-launch either).
PLUG="$TOOLS/plugins"
mkdir -p "$PLUG"
cp -f "$TOOLS/linuxdeploy-plugin-gtk.sh" "$PLUG/linuxdeploy-plugin-gtk"
chmod +x "$PLUG/linuxdeploy-plugin-gtk"

# 3. Locate the AppDir tauri assembled (skeleton: binary + .desktop + icon).
APPDIR="$(find "$TARGET_DIR" -type d -path '*release/bundle/appimage/*.AppDir' 2>/dev/null | sort | head -1)"
[ -n "$APPDIR" ] && [ -d "$APPDIR" ] || { echo "✗ no Aura.AppDir under $TARGET_DIR (did tauri assemble it?)"; exit 1; }
WORK="$(dirname "$APPDIR")"
echo "── AppDir: $APPDIR"

# 4. Resolve + inject the two companion binaries next to the main binary.
#    Both live in the Linux target dir: `cargo build` for the app and for the
#    workspace-excluded aura CLI both run with CARGO_TARGET_DIR=/build/target, so
#    the CLI lands at $TARGET_DIR/release/aura — NOT /work/aura-cli/target, which
#    is the bind-mounted macOS checkout (a stale arm64 Mach-O host build).
MCP_BIN="$TARGET_DIR/release/aura-shell-mcp"
CLI_BIN="$TARGET_DIR/release/aura"
[ -f "$MCP_BIN" ] || { echo "✗ aura-shell-mcp not found at $MCP_BIN"; exit 1; }
[ -f "$CLI_BIN" ] || { echo "✗ aura CLI not found at $CLI_BIN (Linux build)"; exit 1; }
install -m 0755 "$MCP_BIN" "$APPDIR/usr/bin/aura-shell-mcp"
install -m 0755 "$CLI_BIN" "$APPDIR/usr/bin/aura"
echo "── injected: usr/bin/aura-shell-mcp ($(stat -c%s "$MCP_BIN") b), usr/bin/aura ($(stat -c%s "$CLI_BIN") b)"

# 5. Bundle GTK/webkit libs + pack — one inner-ELF linuxdeploy run.
#    The gtk plugin is NOT idempotent: on an AppDir where it already ran it dies
#    with `ln: … File exists`. On x86_64 the AppDir is a clean skeleton (tauri's
#    own appimage step crashed under qemu before deploying anything), so we run
#    the plugin. On native arm64 tauri's appimage step may SUCCEED and deploy
#    gtk itself — its marker `apprun-hooks/linuxdeploy-plugin-gtk.sh` is then
#    present; in that case we skip the plugin and only repack (the libs are
#    already there, we just need the injected CLIs inside the squashfs).
export LINUXDEPLOY="$LD"
export APPIMAGE_EXTRACT_AND_RUN=1
export PATH="$PLUG:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
PLUGIN_ARGS=(--plugin gtk)
if [ -f "$APPDIR/apprun-hooks/linuxdeploy-plugin-gtk.sh" ] || \
   compgen -G "$APPDIR/usr/lib/*/libgtk-3.so*" >/dev/null 2>&1; then
  echo "── gtk already deployed into the AppDir — repacking with CLIs, skipping gtk plugin"
  PLUGIN_ARGS=()
fi
echo "── linuxdeploy (inner ELF): ${PLUGIN_ARGS[*]} --output appimage"
rm -f "$WORK"/*.AppImage
( cd "$WORK" && "$LD" --appdir "$APPDIR" "${PLUGIN_ARGS[@]}" --output appimage )

# 6. Normalize the output name to the release artifact name.
OUT="$WORK/Aura-$LD_ARCH.AppImage"
PRODUCED="$(find "$WORK" -maxdepth 1 -name '*.AppImage' -type f 2>/dev/null | sort | head -1)"
[ -n "$PRODUCED" ] || { echo "✗ linuxdeploy produced no AppImage in $WORK"; exit 1; }
if [ "$PRODUCED" != "$OUT" ]; then rm -f "$OUT"; mv "$PRODUCED" "$OUT"; fi
chmod +x "$OUT"
echo "✓ CLI-complete AppImage: $OUT ($(stat -c%s "$OUT") b)"
