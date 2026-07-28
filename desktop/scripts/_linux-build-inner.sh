#!/usr/bin/env bash
# Runs INSIDE the Linux build container (see Dockerfile.linux / build-linux.sh).
# Native compile for the container's arch — no --target, no cross toolchain.
set -euo pipefail

ARCH="${ARCH:-arm64}"
MODE="${MODE:-probe}"

cd /work/aura-shell
echo "── inner: arch=$ARCH mode=$MODE  rustc=$(rustc --version)  bun=$(bun --version)"

# tauri-build embeds the frontend dist at compile time; make sure it exists so
# even a `probe` Rust compile has assets to point at. Reuse a prior dist if the
# mounted repo already carries one; otherwise build it.
if [ ! -d /work/aura-shell/dist ] || [ -z "$(ls -A /work/aura-shell/dist 2>/dev/null)" ]; then
  echo "── frontend dist missing — installing JS deps + building"
  bun install --frozen-lockfile || bun install
  bun run build
else
  echo "── reusing existing frontend dist"
fi

if [ "$MODE" = "probe" ]; then
  echo "── PROBE: cargo build (Rust app only) to surface Linux port errors"
  cargo build --release --manifest-path src-tauri/Cargo.toml
  echo "── PROBE app compile OK; now the workspace-excluded aura CLI"
  cargo build --release --manifest-path /work/aura-cli/Cargo.toml
  echo "✓ PROBE compiled clean for linux/$ARCH"
  exit 0
fi

# ── full ───────────────────────────────────────────────────────────────────
echo "── FULL: bun tauri build (deb + assemble AppDir)"
bun install --frozen-lockfile || bun install

# The frontend dist is already built/ensured above, so we DISABLE tauri's own
# `beforeBuildCommand` (`bun run build`) for the container build. Re-running it
# here is not merely redundant: node_modules is a shared volume, and the
# platform-native rollup binary (`@rollup/rollup-linux-<arch>-gnu`, an OPTIONAL
# dep resolved per host arch) present in it may be the *other* arch's. vite/rollup
# then hard-crashes with "Cannot find module @rollup/rollup-linux-x64-gnu" and
# tauri aborts BEFORE compiling the app — which, combined with a stale wrong-arch
# binary on the shared target volume, silently ships the wrong architecture.
# Skipping beforeBuildCommand makes tauri consume the dist we prepared above and
# go straight to the Rust build (frontendDist in tauri.conf already points here).
#
# On x86_64 we run under qemu, where tauri's own AppImage step (linuxdeploy via
# the AppImage runtime self-launch) crashes — see _linux-appimage-bundle-cli.sh.
# tauri still builds the .deb and assembles `Aura.AppDir` BEFORE that step, so we
# tolerate the AppImage failure and produce the AppImage ourselves below. On
# arm64 (native) tauri's AppImage step works normally; treat it as required.
set +e
bun run tauri build --config '{"build":{"beforeBuildCommand":""}}' ${TAURI_VERBOSE:+--verbose}
TB_RC=$?
set -e
DEB="$(find /build/target -path '*release/bundle/deb/*.deb' -type f 2>/dev/null | sort | head -1)"
APPDIR="$(find /build/target -type d -path '*release/bundle/appimage/*.AppDir' 2>/dev/null | sort | head -1)"
# We require the .deb + assembled AppDir as proof the compile + AppDir assembly
# got far enough for our own bundler — and tolerate a non-zero tauri rc either
# way. On x86_64 tauri's own AppImage step always fails under qemu; on arm64 it
# may also fail in a FUSE-less container. In both cases our bundler re-packs the
# AppDir itself, so the only thing that actually matters is that the AppDir +
# binary exist. A genuine compile error leaves no deb/AppDir and aborts here.
if [ -z "$DEB" ] || [ -z "$APPDIR" ]; then
  echo "✗ tauri build failed before assembling deb + AppDir (rc=$TB_RC)"
  exit "$TB_RC"
fi
echo "── tauri produced deb + AppDir (rc=$TB_RC; our bundler owns the AppImage step)"

# ── arch guard ────────────────────────────────────────────────────────────────
# The target volume is SHARED across arches, so a prior build's aura-shell can
# linger even when THIS compile never ran (e.g. the frontend step aborted). The
# deb/AppDir presence check above is therefore NOT proof of a fresh, correct-arch
# binary. Verify the compiled app binary's ELF machine type matches this build's
# arch before packaging — otherwise a compile failure could ship a wrong-arch,
# unrunnable app (EM_X86_64=62/0x3E, EM_AARCH64=183/0xB7 at ELF header offset 18).
APPBIN=/build/target/release/aura-shell
[ -f "$APPBIN" ] || APPBIN="$(find /build/target -maxdepth 3 -path '*release/aura-shell' -type f 2>/dev/null | head -1)"
case "$ARCH" in
  arm64)  want_machine=183; want_name=aarch64 ;;
  x86_64) want_machine=62;  want_name=x86-64  ;;
  *) echo "✗ arch guard: unknown ARCH=$ARCH"; exit 3 ;;
esac
got_machine="$(od -An -tu2 -j18 -N2 "$APPBIN" 2>/dev/null | tr -d ' ')"
if [ "$got_machine" != "$want_machine" ]; then
  echo "✗ arch guard FAILED: $APPBIN is ELF e_machine=$got_machine, expected $want_machine ($want_name) for $ARCH."
  echo "  The $ARCH app did not compile (stale wrong-arch binary on the shared target volume). Refusing to package."
  exit 3
fi
echo "── arch guard OK: aura-shell is $want_name (ELF e_machine=$got_machine) for $ARCH"

echo "── building the aura CLI for linux"
cargo build --release --manifest-path /work/aura-cli/Cargo.toml

# Tauri does not bundle the aura CLI or the aura-shell-mcp permission-gate
# sidecar; both are resolved next to the main binary at runtime. Our bundler
# injects them into the AppDir's usr/bin and produces the portable AppImage via
# an inner-ELF linuxdeploy (the Linux equivalent of macOS app:bundle-cli/-mcp).
# Arch-aware: it owns the AppImage step that tauri can't run under qemu on
# x86_64, AND re-packs the native arm64 AppImage so it carries the two CLIs too
# (tauri's own arm64 AppImage would ship without them). See the bundler for the
# x86_64-skeleton vs arm64-already-deployed handling.
echo "── building portable CLI-complete AppImage (inner-ELF linuxdeploy, $ARCH)"
ARCH="$ARCH" bash /work/aura-shell/scripts/_linux-appimage-bundle-cli.sh

# The .deb needs the same treatment for the same reason — tauri wrote it without
# the CLI. It is already sealed by now, so the injection has to unpack and
# re-seal it rather than adding to a staging dir.
echo "── injecting the aura CLI into the deb ($ARCH)"
ARCH="$ARCH" bash /work/aura-shell/scripts/_linux-deb-bundle-cli.sh

echo "── bundle artifacts:"
find /build/target -path '*release/bundle/appimage/*.AppImage' -o -path '*release/bundle/deb/*.deb' 2>/dev/null | sort
echo "✓ FULL linux/$ARCH bundle built"
