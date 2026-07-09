#!/usr/bin/env bash
# Wrapper: load Tauri updater signing key + notarization creds, then
# run `tauri build` followed by sign-notarize.sh.
#
# Why: the updater .tar.gz needs TAURI_SIGNING_PRIVATE_KEY at the
# `tauri build` step, while sign-notarize.sh needs APPLE_ID/APPLE_PASSWORD/
# APPLE_TEAM_ID after. Pre-load everything so non-interactive shells
# (CI, agents) can run the same path as a developer's terminal.
#
# Usage:  scripts/build-release.sh <arch>     where <arch> = arm64 | intel
#
# Inputs (read, never echoed):
#   ~/.tauri/aura-shell.key            → TAURI_SIGNING_PRIVATE_KEY
#   ~/.tauri/aura-shell.password       → TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#   ~/.aura-notarize.env               → APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID

set -euo pipefail

ARCH="${1:?arch arg required: arm64 | intel}"

case "$ARCH" in
  arm64) TARGET=aarch64-apple-darwin ;;
  intel) TARGET=x86_64-apple-darwin  ;;
  *) echo "unknown arch: $ARCH (use arm64 or intel)"; exit 2 ;;
esac

KEY_FILE="$HOME/.tauri/aura-shell.key"
PW_FILE="$HOME/.tauri/aura-shell.password"
NOTARIZE_ENV="$HOME/.aura-notarize.env"

if [ ! -f "$KEY_FILE" ]; then
  echo "✗ missing $KEY_FILE — Tauri updater signing key required."
  exit 1
fi
if [ ! -f "$PW_FILE" ]; then
  echo "✗ missing $PW_FILE — Tauri updater key password required."
  exit 1
fi
if [ ! -f "$NOTARIZE_ENV" ]; then
  echo "✗ missing $NOTARIZE_ENV — Apple notarization creds required."
  echo "  Expected: APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID"
  exit 1
fi

# ── CLI ⇄ app version parity guard ─────────────────────────────────────────
# The desktop app ships its own `aura` CLI and installs it on launch, comparing
# on major.minor (cmd_doctor_cli.rs). The CLI crate (aura-cli) is workspace-
# EXCLUDED, so a release that bumps the app via a branch merge — not
# set-version.sh — silently leaves aura-cli behind. The app then bundles a
# stale CLI and every user sees a forever-"outdated" chip that re-installs the
# same old binary. That must never ship: fail the build loudly on drift.
APP_VER="$(node -p "require('./package.json').version")"
CLI_VER="$(perl -ne 'if(/^version = "([^"]+)"/){print $1; last}' ../aura-cli/Cargo.toml)"
if [ "$APP_VER" != "$CLI_VER" ]; then
  echo "✗ version drift: app is $APP_VER but aura-cli/Cargo.toml is $CLI_VER" >&2
  echo "  Fix: scripts/set-version.sh $APP_VER  (it stamps aura-cli too), then rebuild." >&2
  exit 1
fi
echo "▸ CLI ⇄ app version parity OK ($APP_VER)"

# Ensure native macOS xattr beats anaconda's shadow.
export PATH="/usr/bin:/usr/sbin:/bin:/sbin:$PATH"

# Read signing creds into env (never printed).
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$PW_FILE")"
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD

# Source notarization creds.
set -a
# shellcheck disable=SC1090
. "$NOTARIZE_ENV"
set +a

# ── Product telemetry key (PostHog EU) ─────────────────────────────────────
# The public write-only ingestion token is kept OUT of the open-source tree.
# We bake it at build time via Rust's option_env!("AURA_POSTHOG_KEY") so
# release builds can send anonymous product analytics (consent-gated in
# telemetry.rs). Absent → telemetry is a silent no-op; the build still
# succeeds (so contributors without the key can build a working app).
POSTHOG_ENV="$HOME/.aura-posthog.env"
if [ -f "$POSTHOG_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$POSTHOG_ENV"
  set +a
  if [ -n "${AURA_POSTHOG_KEY:-}" ]; then
    echo "▸ telemetry key present — baking PostHog ingestion into the build"
  else
    echo "⚠ $POSTHOG_ENV has no AURA_POSTHOG_KEY — telemetry will be a no-op"
  fi
else
  echo "⚠ no $POSTHOG_ENV — building without product telemetry (silent no-op)"
fi

echo "▸ building $ARCH ($TARGET)"
bun run tauri build --target "$TARGET"

# Bundle MCP binary into the .app then re-sign + notarize.
echo "▸ bundling aura-shell-mcp into .app"
bun run "app:bundle-mcp:$ARCH"

# Build + bundle the matching aura CLI into the .app so the desktop ships
# its own CLI. sign-notarize.sh signs every executable in Contents/MacOS,
# so the bundled binary is Developer-ID-signed + notarized along with the
# app — then the shell installs it in place on launch (cmd_doctor_cli.rs).
echo "▸ building + bundling aura CLI into .app"
bun run "app:bundle-cli:$ARCH"

echo "▸ signing + notarizing"
bash scripts/sign-notarize.sh "$ARCH"

echo "✓ $ARCH release built, signed, notarized"
