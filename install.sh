#!/bin/bash
# Aura Semantic Engine - Universal Installation Script
# https://auravcs.com

set -e

# Detect OS and Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"

echo "✨ Installing Aura Semantic Engine..."

VERSION="v0.1.0-alpha"
REPO="AuraLabs/aura"

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

echo "⬇️  Downloading Aura ${VERSION} for ${ASSET_OS} (${ASSET_ARCH})..."

# Download binary
curl -sSL -o aura_bin "$DOWNLOAD_URL" || { echo "❌ Failed to download binary."; exit 1; }

# Install
chmod +x aura_bin
sudo mv aura_bin /usr/local/bin/aura || { echo "❌ Failed to move binary to /usr/local/bin (try running with sudo)."; exit 1; }

echo "✓ Aura installed successfully to /usr/local/bin/aura"

echo ""
echo "🚀 Aura is ready!"
echo "Run 'aura init' inside any Git repository to begin tracking semantic AI decisions."
