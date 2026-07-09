#!/usr/bin/env bash
# Aura desktop — Linux build driver (runs on the host; orchestrates Docker).
#
# Usage:
#   scripts/build-linux.sh <arch> <mode>
#     <arch> = arm64 | x86_64        (arm64 builds natively on Apple Silicon;
#                                      x86_64 builds under qemu emulation)
#     <mode> = probe | full
#       probe → compile the Rust app only, to surface Linux port errors fast.
#       full  → frontend build + app + `aura` CLI + AppImage bundle.
#
# The repo root is mounted at /work; cargo registry + the Linux target dir live
# on named volumes so iterative builds stay warm. The macOS target/ is never
# touched (Linux output goes to the `aura-linux-target` volume at /build/target).
set -euo pipefail

ARCH="${1:?arch arg required: arm64 | x86_64}"
MODE="${2:-probe}"

case "$ARCH" in
  arm64)  PLATFORM=linux/arm64 ;;
  x86_64) PLATFORM=linux/amd64 ;;
  *) echo "unknown arch: $ARCH (use arm64 or x86_64)"; exit 2 ;;
esac

# Repo root = parent of this script's aura-shell dir.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="aura-linux-build:22.04"

echo "▸ building Linux image ($PLATFORM)"
docker build --platform "$PLATFORM" \
  -f "$REPO_ROOT/aura-shell/docker/Dockerfile.linux" \
  -t "$IMAGE" "$REPO_ROOT/aura-shell/docker"

echo "▸ running $MODE build ($ARCH / $PLATFORM)"
# node_modules is shadowed by a container-private volume: `bun install` inside
# the container must NOT overwrite the host's macOS-native node_modules (a
# concurrent mac build may be using it, and the native esbuild/rollup binaries
# differ per-OS). dist is likewise shadowed so a container frontend build never
# races the host's.
docker run --rm --platform "$PLATFORM" \
  -v "$REPO_ROOT":/work \
  -v aura-linux-cargo:/root/.cargo/registry \
  -v aura-linux-target:/build/target \
  -v aura-linux-nodemods:/work/aura-shell/node_modules \
  -v aura-linux-dist:/work/aura-shell/dist \
  -v aura-linux-tauricache:/root/.cache \
  -e CARGO_TARGET_DIR=/build/target \
  -e ARCH="$ARCH" -e MODE="$MODE" \
  -e TAURI_VERBOSE="${TAURI_VERBOSE:-}" \
  "$IMAGE" \
  bash /work/aura-shell/scripts/_linux-build-inner.sh

echo "✓ Linux $MODE ($ARCH) done"
