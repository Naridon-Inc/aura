#!/bin/bash
# Hook script for Claude Code PreToolUse event
# Sends a structured Aura notification BEFORE a tool call runs and waits for
# the loopback reply so Aura can gate the call (allow/deny/ask) and/or inject
# guidance as additionalContext.
#
# Emits to stdout the PreToolUse hook-output envelope Claude Code expects:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#     "permissionDecision":"allow|deny|ask",
#     "permissionDecisionReason":"<text>"},
#    "additionalContext":"<text>"?}
#
# Best-effort: any error path defaults to permissionDecision "allow" with an
# empty reason and no additionalContext. A hook must never block the agent
# when the loopback is slow, unreachable, or returns junk.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

INPUT=$(cat)

# Match how on-post-tool-use.sh reads the tool fields from the hook stdin.
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .input // {}' 2>/dev/null)
if [ -z "$TOOL_INPUT" ]; then
    TOOL_INPUT="{}"
fi

# build_payload already folds in session_id and cwd from $INPUT.
BODY=$(build_payload "$INPUT" "pre_tool_use" \
    --arg tool_name "$TOOL_NAME" \
    --argjson tool_input "$TOOL_INPUT")

# POST-and-capture the loopback reply. Empty on any failure → defaults below.
# Pass a long max-time (600s) so a HUMAN gate can hold the connection while the
# user confirms in the UI; the common auto-allow reply still returns in ms.
REPLY=$("$SCRIPT_DIR/aura-notify-rpc.sh" "aura://cli-agent" "$BODY" 600 2>/dev/null)

# Parse the reply defensively. Treat a non-JSON / empty reply as "no opinion".
DECISION="allow"
REASON=""
HAS_CONTEXT="false"
CONTEXT=""
if [ -n "$REPLY" ]; then
    PARSED_DECISION=$(echo "$REPLY" | jq -r '.permissionDecision // empty' 2>/dev/null)
    case "$PARSED_DECISION" in
        allow|deny|ask)
            DECISION="$PARSED_DECISION"
            ;;
    esac
    REASON=$(echo "$REPLY" | jq -r '.permissionDecisionReason // empty' 2>/dev/null)
    if echo "$REPLY" | jq -e 'has("additionalContext")' >/dev/null 2>&1; then
        HAS_CONTEXT="true"
        CONTEXT=$(echo "$REPLY" | jq -r '.additionalContext // empty' 2>/dev/null)
    fi
fi

# Emit the PreToolUse envelope. Include additionalContext only when the reply
# carried it (so we never inject an empty/null context block).
if [ "$HAS_CONTEXT" = "true" ]; then
    jq -nc \
        --arg decision "$DECISION" \
        --arg reason "$REASON" \
        --arg context "$CONTEXT" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:$decision, permissionDecisionReason:$reason}, additionalContext:$context}'
else
    jq -nc \
        --arg decision "$DECISION" \
        --arg reason "$REASON" \
        '{hookSpecificOutput:{hookEventName:"PreToolUse", permissionDecision:$decision, permissionDecisionReason:$reason}}'
fi

exit 0
