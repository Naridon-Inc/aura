#!/bin/bash
# Hook script for Gemini CLI AfterAgent event (equivalent to Claude Code Stop)
# Sends a structured Aura notification when Gemini completes a task.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

# Gemini's AfterAgent provides prompt and prompt_response directly — no
# transcript parsing required.
QUERY=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
RESPONSE=$(echo "$INPUT" | jq -r '.prompt_response // empty' 2>/dev/null)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

if [ -n "$QUERY" ] && [ ${#QUERY} -gt 200 ]; then
    QUERY="${QUERY:0:197}..."
fi
if [ -n "$RESPONSE" ] && [ ${#RESPONSE} -gt 200 ]; then
    RESPONSE="${RESPONSE:0:197}..."
fi

BODY=$(build_payload "$INPUT" "stop" \
    --arg query "$QUERY" \
    --arg response "$RESPONSE" \
    --arg transcript_path "$TRANSCRIPT_PATH")

"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"

echo '{}'
