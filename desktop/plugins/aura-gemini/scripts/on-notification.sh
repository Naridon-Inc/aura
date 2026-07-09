#!/bin/bash
# Hook script for Gemini CLI Notification event
# Sends a structured Aura notification when Gemini is waiting for input.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

NOTIF_TYPE=$(echo "$INPUT" | jq -r '.notification_type // "unknown"' 2>/dev/null)
MSG=$(echo "$INPUT" | jq -r '.message // "Input needed"' 2>/dev/null)
[ -z "$MSG" ] && MSG="Input needed"

BODY=$(build_payload "$INPUT" "$NOTIF_TYPE" \
    --arg summary "$MSG")

"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

echo '{}'
