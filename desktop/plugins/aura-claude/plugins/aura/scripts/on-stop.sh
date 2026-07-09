#!/bin/bash
# Hook script for Claude Code Stop event
# Sends a structured Aura notification when Claude completes a task

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

# Skip if a stop hook is already active (prevents double-notification)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
    exit 0
fi

# Extract the last user prompt and assistant response from the transcript.
# Small delay to allow Claude Code to flush the current turn to the transcript
# file. The Stop hook fires before the transcript is fully written.
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
sleep 0.3
QUERY=""
RESPONSE=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    # Last human prompt: user-typed messages have content that is either a
    # plain string or an array containing {type:"text"} blocks. Tool-result
    # messages have content arrays containing only {type:"tool_result"}
    # blocks. Filter to messages with at least one "text" block (or a plain
    # string).
    QUERY=$(jq -rs '
        [
            .[] | select(.type == "user") |
            if .message.content | type == "string" then .
            elif [.message.content[] | select(.type == "text")] | length > 0 then .
            else empty
            end
        ] | last |
        if .message.content | type == "array"
        then [.message.content[] | select(.type == "text") | .text] | join(" ")
        else .message.content // empty
        end
    ' "$TRANSCRIPT_PATH" 2>/dev/null)

    RESPONSE=$(jq -rs '
        [.[] | select(.type == "assistant" and .message.content)] | last |
        [.message.content[] | select(.type == "text") | .text] | join(" ")
    ' "$TRANSCRIPT_PATH" 2>/dev/null)

    if [ -n "$QUERY" ] && [ ${#QUERY} -gt 200 ]; then
        QUERY="${QUERY:0:197}..."
    fi
    if [ -n "$RESPONSE" ] && [ ${#RESPONSE} -gt 200 ]; then
        RESPONSE="${RESPONSE:0:197}..."
    fi
fi

BODY=$(build_payload "$INPUT" "stop" \
    --arg query "$QUERY" \
    --arg response "$RESPONSE" \
    --arg transcript_path "$TRANSCRIPT_PATH")

"$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"
