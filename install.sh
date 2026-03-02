#!/bin/bash
# Aura Semantic Engine - Universal Installation Script
# https://auravcs.com

set -e

echo ""
echo "========================================================"
echo "    Aura Semantic Engine : v0.2.6-alpha (Open Source)   "
echo "========================================================"
echo ""

# Detect OS and Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

echo "✨ Installing Aura Semantic Engine..."

VERSION="v0.2.6-alpha"
REPO="Naridon-Inc/aura"

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

BINARY_NAME="aura-${ASSET_OS}-${ASSET_ARCH}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"

echo "⬇️  Attempting to download pre-compiled binary for Aura ${VERSION}..."

if curl --output /dev/null --silent --head --fail "$DOWNLOAD_URL"; then
    # Download binary
    curl -sSL -o aura_bin "$DOWNLOAD_URL"
    chmod +x aura_bin
    sudo mv aura_bin /usr/local/bin/aura || { echo "❌ Failed to move binary to /usr/local/bin (try running with sudo)."; exit 1; }
    echo "✓ Aura installed successfully to /usr/local/bin/aura"
else
    echo "⚠️ Pre-compiled binary not found for ${VERSION}."
    echo "🔨 Falling back to compiling from source via Cargo..."
    
    if ! command -v cargo &> /dev/null; then
        echo "❌ Rust and Cargo are not installed. Please install Rust (https://rustup.rs/) to compile Aura."
        exit 1
    fi
    
    # Clone and build
    TMP_DIR=$(mktemp -d)
    git clone https://github.com/${REPO}.git "$TMP_DIR"
    cd "$TMP_DIR"
    cargo install --path . --locked
    echo "✓ Aura compiled and installed successfully to ~/.cargo/bin/aura"
    
    # Clean up
    cd - > /dev/null
    rm -rf "$TMP_DIR"
fi

echo ""
echo "🚀 Aura is ready!"
echo "Run 'aura init' inside any Git repository to begin tracking semantic AI decisions."
