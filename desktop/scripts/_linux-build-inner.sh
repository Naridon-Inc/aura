#!/usr/bin/env bash
# Runs INSIDE the Linux build container (see Dockerfile.linux / build-linux.sh).
# Native compile for the container's arch — no --target, no cross toolchain.
set -euo pipefail

ARCH="${ARCH:-arm64}"
MODE="${MODE:-probe}"

cd /work/aura-shell
echo "── inner: arch=$ARCH mode=$MODE  rustc=$(rustc --version)  bun=$(bun --version)"

# dist is a named volume mounted INSIDE the /work bind mount. That nesting is
# fragile: if a process on the host rewrites aura-shell/dist while this container
# runs — which a concurrent macOS `tauri build` does, because its
# beforeBuildCommand is the same `bun run build` and vite empties outDir — the
# nested mount stops covering the path, and everything this container writes to
# dist lands on the HOST instead of the volume.
#
# It fails silently and looks like success from in here: the build writes dist,
# the freshness re-check reads back the very files it just wrote, and the
# container exits 0. The next container mounts the volume cleanly, sees the dist
# from hours ago, and refuses to compile. That is 0.19.33's Linux pair failing
# twice with "frontend dist is older than /work/aura-shell/src" seconds after
# reporting "frontend dist rebuilt", and near-certainly also the earlier failure
# where tauri could not read 68 of 149 assets mid-compile — the host build was
# emptying dist underneath it.
#
# One stat call tells us which we have. A live volume is a different device from
# the bind mount; the host's own dist directory is the same device.
assert_dist_is_the_volume() {
  local when="$1" dev_dist dev_work
  dev_dist="$(stat -c %d /work/aura-shell/dist 2>/dev/null || echo x)"
  dev_work="$(stat -c %d /work/aura-shell 2>/dev/null || echo y)"
  if [ "$dev_dist" = "$dev_work" ]; then
    echo "✗ $when: /work/aura-shell/dist is not the aura-linux-dist volume —"
    echo "  it resolves to the host's own dist directory (same device as /work)."
    echo "  Writing there corrupts the host checkout and leaves the volume stale."
    echo "  Cause: something on the host rewrote aura-shell/dist while this"
    echo "  container was running. Do not run a macOS and a Linux build of the"
    echo "  same checkout at the same time — they share that directory."
    exit 5
  fi
}
assert_dist_is_the_volume "at startup"

# tauri-build embeds the frontend dist at compile time, so whatever sits in dist
# when the Rust compile starts is the UI this release ships — there is no later
# step that would notice it is out of date.
#
# dist is a container-private named volume (see build-linux.sh), NOT the host's
# dist: the host cannot refresh it, and it survives between builds. So presence
# is not freshness. Testing only that the directory was non-empty meant a dist
# left behind by an earlier build was reused silently — 0.19.33's first Linux
# pair embedded a frontend built before that release's own What's New existed,
# while macOS (which runs tauri's beforeBuildCommand) embedded the current one.
# Two platforms of one release, shipping different UI, with nothing in the log
# except "reusing existing frontend dist".
#
# Compare the stamp against the frontend inputs from the bind-mounted repo and
# rebuild when any of them is newer.
DIST_STAMP=/work/aura-shell/dist/index.html
FRONTEND_INPUTS=(
  /work/aura-shell/src
  /work/aura-shell/public
  /work/aura-shell/index.html
  /work/aura-shell/package.json
  /work/aura-shell/bun.lock
  /work/aura-shell/vite.config.ts
)

# Prints the first frontend input newer than the stamp, or nothing if dist is
# current. -quit stops at the first hit, so this stays cheap on a large src/.
newer_than_dist() {
  find "${FRONTEND_INPUTS[@]}" -newer "$DIST_STAMP" -print -quit 2>/dev/null || true
}

dist_reason=""
if [ ! -s "$DIST_STAMP" ]; then
  dist_reason="frontend dist missing"
else
  stale_src="$(newer_than_dist)"
  if [ -n "$stale_src" ]; then
    dist_reason="frontend dist is older than $stale_src"
  fi
fi

# `dist` mode exists solely so the rebuild happens in a DIFFERENT container from
# the compile. A container that writes dist and then compiles against it in the
# same run hands the compile a pre-rewrite view of the directory: the arm64 leg
# of 0.19.33 rebuilt dist, then tauri's asset embedding failed to read 68 of the
# 149 JS assets — exactly the files the rebuild had added over the previous dist,
# with the other 152 names unchanged and readable. The x86_64 leg compiled the
# same dist minutes later without a single read error, because a previous
# container had written it. So: rebuild here, exit, and let the caller start a
# fresh container to compile.
if [ "$MODE" = "dist" ]; then
  if [ -z "$dist_reason" ]; then
    echo "── frontend dist is current (newer than every frontend source)"
    exit 0
  fi
  echo "── $dist_reason — installing JS deps + building"
  bun install --frozen-lockfile || bun install
  bun run build
  # Re-check after the build, not just before: vite empties and rewrites the
  # directory, and the host can lose the mount out from under us at any point
  # during those two minutes.
  assert_dist_is_the_volume "after the frontend build"
  # A build that exits 0 having written nothing would put us straight back where
  # we started, so confirm the stamp actually moved ahead of the sources.
  [ -s "$DIST_STAMP" ] || { echo "✗ frontend build produced no $DIST_STAMP"; exit 4; }
  still_stale="$(newer_than_dist)"
  if [ -n "$still_stale" ]; then
    echo "✗ frontend build left dist older than $still_stale — refusing to embed a stale UI"
    exit 4
  fi
  echo "── frontend dist rebuilt"
  exit 0
fi

# Every other mode only checks. Building here is what caused the failure above,
# and a stale dist is what this whole block exists to prevent, so there is
# nothing safe left to do but stop.
if [ -n "$dist_reason" ]; then
  echo "✗ $dist_reason"
  echo "  Refusing to embed it. Run this image with MODE=dist first — build-linux.sh"
  echo "  does that as a separate container before every probe/full build."
  exit 4
fi
echo "── frontend dist is current (newer than every frontend source)"

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

# Park a per-arch copy the moment this leg finishes, because bundle/ is NOT a
# safe place to leave one. Both arches build the same package name at the same
# version into the same shared volume, and tauri's bundler clears deb/ and
# appimage/ for that name before it writes — so the second leg to run deletes
# the first leg's artifacts out from under it. 0.19.34's arm64 AppImage and .deb
# disappeared exactly that way, minutes after the build that made them reported
# success. pack-linux.sh reads this stash first, so the order the two legs run
# in, and how long the copy-out waits, both stop mattering.
STASH="/build/target/_artifacts/$ARCH"
rm -rf "$STASH"
mkdir -p "$STASH"
case "$ARCH" in
  arm64)  stash_ai="Aura-aarch64.AppImage"; stash_deb_suffix="_arm64.deb" ;;
  x86_64) stash_ai="Aura-x86_64.AppImage";  stash_deb_suffix="_amd64.deb" ;;
esac
stash_ai_path="$(find /build/target -path "*release/bundle/appimage/$stash_ai" | head -1)"
# Newest matching .deb: the volume still holds this arch's debs going back to
# 0.19.5, and only the one this build just sealed belongs in the stash.
stash_deb_path="$(find /build/target -path "*release/bundle/deb/*$stash_deb_suffix" -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
[ -n "$stash_ai_path" ]  || { echo "✗ stash: no $stash_ai to park"; exit 3; }
[ -n "$stash_deb_path" ] || { echo "✗ stash: no *$stash_deb_suffix to park"; exit 3; }
cp -f "$stash_ai_path" "$stash_deb_path" "$STASH/"
echo "── parked for pack-linux: $STASH/$(basename "$stash_ai_path")  $STASH/$(basename "$stash_deb_path")"

echo "✓ FULL linux/$ARCH bundle built"
