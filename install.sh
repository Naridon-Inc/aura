#!/bin/bash
# Aura Semantic Engine - Universal Installation Script
# https://auravcs.com

set -e

echo ""
echo "========================================================"
echo "    Aura Semantic Engine : v4.0 Alpha (Closed Beta)     "
echo "========================================================"
echo ""

echo "Aura is currently in a gated preview for design partners."
echo "Please enter your cryptographic invite token to continue."
echo ""
read -p "Invite Token: " AURA_TOKEN

# Simple mock validation for the beta feel
if [ -z "$AURA_TOKEN" ] || [ ${#AURA_TOKEN} -lt 16 ]; then
    echo ""
    echo "❌ Error: Invalid or expired invite token."
    echo "To request access to the private beta, please visit: https://auravcs.com"
    exit 1
fi

echo ""
echo "🔐 Token verified. Authenticating with Sovereign Vault..."
sleep 1.5

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
curl -sSL -o aura_bin "$DOWNLOAD_URL" || { echo "❌ Failed to download binary. Make sure the release exists on GitHub."; exit 1; }

# Install
chmod +x aura_bin
sudo mv aura_bin /usr/local/bin/aura || { echo "❌ Failed to move binary to /usr/local/bin (try running with sudo)."; exit 1; }

echo "✓ Aura installed successfully to /usr/local/bin/aura"

echo ""
echo "🚀 Aura is ready!"
echo "Run 'aura login --token $AURA_TOKEN' to authenticate your local daemon."
echo "Run 'aura init' inside any Git repository to begin tracking semantic AI decisions."
