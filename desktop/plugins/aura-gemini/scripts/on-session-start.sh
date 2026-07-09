#!/bin/bash
# Hook script for Gemini CLI SessionStart event
# Emits a structured Aura notification with the plugin version.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

if ! command -v jq &>/dev/null; then
    echo '{"systemMessage": "Aura notifications require jq. Install with brew install jq or apt install jq."}'
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

PLUGIN_VERSION=$(jq -r '.version // "unknown"' "$SCRIPT_DIR/../gemini-extension.json" 2>/dev/null)

BODY=$(build_payload "$INPUT" "session_start" \
    --arg plugin_version "$PLUGIN_VERSION")
"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

echo '{}'
