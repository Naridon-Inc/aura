#!/bin/bash
# Aura Semantic Engine - Universal Installation Script
# https://auravcs.com
#
# People run this as `curl -fsSL https://auravcs.com/install.sh | bash`, with no
# checkout and nothing installed but curl, so it has to stay self-contained.
#
# Environment overrides:
#   AURA_VERSION      pin a release tag (e.g. v0.18.0) instead of taking latest
#   AURA_INSTALL_DIR  where to put the binary (default /usr/local/bin)

set -e

OS="$(uname -s)"
ARCH="$(uname -m)"
REPO="Naridon-Inc/aura"

command -v curl >/dev/null 2>&1 || {
    echo "❌ curl is required to install Aura."
    exit 1
}

# Map architecture
case "$ARCH" in
    x86_64|amd64)
        ASSET_ARCH="amd64"
        ;;
    arm64|aarch64)
        ASSET_ARCH="arm64"
        ;;
    *)
        echo "❌ Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Map OS
case "$OS" in
    Linux)
        ASSET_OS="linux"
        ;;
    Darwin)
        ASSET_OS="darwin"
        ;;
    *)
        echo "❌ Unsupported operating system: $OS"
        exit 1
        ;;
esac

# The release tag is RESOLVED, never hardcoded.
#
# It used to be a literal at the top of this file — and because this script
# exists in three places (repo root, aura-cli/, and the copy deployed to
# auravcs.com) the three literals drifted apart: v0.3.0-alpha, v0.8.1 and
# v0.18.0 while the product was on 0.19.x. Every one of those tags still has
# real assets attached, so `curl | bash` cheerfully installed a years-old
# binary and reported success. Nobody bumps three copies by hand forever, so
# the fix is to stop having a number to bump.
resolve_latest_tag() {
    curl -fsSL --max-time 20 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        | head -1
}

VERSION="${AURA_VERSION:-}"
if [ -z "$VERSION" ]; then
    VERSION="$(resolve_latest_tag || true)"
fi

echo ""
echo "========================================================"
if [ -n "$VERSION" ]; then
    echo "    Aura Semantic Engine : ${VERSION} (Open Source)"
else
    echo "    Aura Semantic Engine (Open Source)"
fi
echo "========================================================"
echo ""
echo "✨ Installing Aura Semantic Engine..."

INSTALL_DIR="${AURA_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="aura-${ASSET_OS}-${ASSET_ARCH}"

install_from_source() {
    echo "🔨 Falling back to compiling from source via Cargo..."

    if ! command -v cargo >/dev/null 2>&1; then
        echo "❌ Rust and Cargo are not installed. Please install Rust (https://rustup.rs/) to compile Aura."
        exit 1
    fi
    if ! command -v git >/dev/null 2>&1; then
        echo "❌ git is required to build Aura from source."
        exit 1
    fi

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    git clone --depth 1 "https://github.com/${REPO}.git" "$TMP_DIR"

    # The repo root is a VIRTUAL manifest — `cargo install --path .` there fails
    # with "found a virtual manifest ... instead of a package manifest", which is
    # what this fallback used to do, so it never once succeeded. The CLI is its
    # own package (named `aura`) and is deliberately excluded from the workspace.
    cargo install --path "$TMP_DIR/aura-cli" --locked
    echo "✓ Aura compiled and installed successfully to ~/.cargo/bin/aura"
}

if [ -z "$VERSION" ]; then
    echo "⚠️ Could not reach GitHub to find the latest release."
    echo "   Pin one with AURA_VERSION=vX.Y.Z, or build from source now."
    install_from_source
else
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"
    echo "⬇️  Downloading pre-compiled binary for Aura ${VERSION}..."

    TMP_BIN="$(mktemp)"
    # -L to follow GitHub's redirect to the asset host, --fail so a missing asset
    # is an error. The old check omitted -L and only did a HEAD, so it read the
    # 302 as success and could not tell a real asset from an error page.
    if curl -fsSL --max-time 300 -o "$TMP_BIN" "$DOWNLOAD_URL"; then
        # Never chmod +x and install something we haven't confirmed is a binary:
        # a redirect that lands on an HTML error page would otherwise be moved
        # into place as `aura` and only fail later, confusingly.
        IS_BINARY=0
        if command -v file >/dev/null 2>&1; then
            case "$(file -b "$TMP_BIN" 2>/dev/null)" in
                *Mach-O*|*ELF*|*executable*) IS_BINARY=1 ;;
            esac
        else
            # No `file` — fall back to size. Every real build is tens of MB.
            # Written as an explicit if, not `[ … ] && IS_BINARY=1`: under `set -e`
            # a trailing AND-list that tests false makes the whole branch return
            # non-zero and kills the script.
            SIZE="$(wc -c < "$TMP_BIN" | tr -d ' ')"
            if [ "$SIZE" -gt 1000000 ]; then
                IS_BINARY=1
            fi
        fi

        if [ "$IS_BINARY" -ne 1 ]; then
            rm -f "$TMP_BIN"
            echo "❌ What downloaded from ${DOWNLOAD_URL} is not an executable."
            install_from_source
        else
            chmod +x "$TMP_BIN"
            if [ -w "$INSTALL_DIR" ]; then
                mv "$TMP_BIN" "$INSTALL_DIR/aura"
            else
                echo "🔑 ${INSTALL_DIR} needs elevated permissions:"
                sudo mv "$TMP_BIN" "$INSTALL_DIR/aura" || {
                    rm -f "$TMP_BIN"
                    echo "❌ Failed to move the binary to ${INSTALL_DIR}."
                    echo "   Set AURA_INSTALL_DIR to somewhere you can write, e.g."
                    echo "   AURA_INSTALL_DIR=\"\$HOME/.local/bin\" curl -fsSL https://auravcs.com/install.sh | bash"
                    exit 1
                }
            fi
            echo "✓ Aura ${VERSION} installed successfully to ${INSTALL_DIR}/aura"
        fi
    else
        rm -f "$TMP_BIN"
        echo "⚠️ No pre-compiled binary published for ${VERSION} on ${ASSET_OS}/${ASSET_ARCH}."
        install_from_source
    fi
fi

echo ""
echo "🚀 Aura is ready!"
echo "Run 'aura init' inside any Git repository to begin tracking semantic AI decisions."
echo ""
echo "Aura is free and open source. Two things that genuinely help:"
echo "  ★ Star the repo    https://github.com/Naridon-Inc/aura"
echo "  ◇ Join the others  https://github.com/Naridon-Inc/aura/discussions"
