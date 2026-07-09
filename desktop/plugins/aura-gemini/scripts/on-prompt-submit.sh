#!/bin/bash
# Hook script for Gemini CLI BeforeAgent event
# Sends a structured Aura notification when the user submits a prompt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

QUERY=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
if [ -n "$QUERY" ] && [ ${#QUERY} -gt 200 ]; then
    QUERY="${QUERY:0:197}..."
fi

BODY=$(build_payload "$INPUT" "prompt_submit" \
    --arg query "$QUERY")

"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

echo '{}'
