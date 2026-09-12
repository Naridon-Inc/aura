#!/bin/bash
# Hook script for Claude Code Stop event
# Sends a structured Aura notification when Claude completes a task

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Stdin can be read exactly once, and two independent things want it now: the
# desktop notification below, and the cloud transcript sync. So it is read
# first, before any gate that might exit — the notification setting governs
# notifications, not whether the console learns this conversation happened.
INPUT=$(cat)

# ─── Transcript sync ────────────────────────────────────────────────────────
#
# The post-tool-use hook tells the console *what* a session changed. This is
# the other half: what was asked. `aura transcript-sync` reads the new bytes of
# the transcript this hook was handed and posts the turns to the same
# `session_messages` endpoint the desktop app writes to, so a terminal session
# and an app session read the same way in the console — until this existed the
# app was the only thing that had ever written that table, which is why a
# session driven from a terminal had changes but no conversation.
#
# It sits above the notification gate deliberately: that gate asks whether an
# Aura Shell tab is listening, and a terminal has no such tab. This used to be
# written twice — once here without a gate, once below the notification gate
# with one — so the opt-in below could never fire (wrong side of the gate) and
# the copy that did fire asked nobody. One block, and it keeps the gate.
#
# **Off unless asked for.** A transcript is the conversation itself, not
# metadata about it, and syncing it takes it off the machine — so this is
# opt-in per person rather than a default somebody has to discover and switch
# off:
#
#     export AURA_SYNC_TRANSCRIPT=1
#
# Backgrounded and silenced: a Stop hook runs between the agent finishing and
# the person seeing it finish, and nothing here is worth a pause or a line in
# somebody's terminal.
if [ "${AURA_SYNC_TRANSCRIPT:-0}" = "1" ] && command -v aura >/dev/null 2>&1; then
    SYNC_SESSION=$(echo "$INPUT" | jq -r '.session_id // .conversation_id // empty' 2>/dev/null)
    SYNC_TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
    if [ -n "$SYNC_SESSION" ] && [ -f "$SYNC_TRANSCRIPT" ]; then
        (aura transcript-sync \
            --session "$SYNC_SESSION" \
            --transcript "$SYNC_TRANSCRIPT" >/dev/null 2>&1 &) </dev/null
        # And every worker that ran inside it, each attributed from its own
        # sidecar. SubagentStop covers the ones that finish while that hook is
        # installed; this covers the rest — workers that ran before it existed,
        # and workers whose stop hook never fired because the session was
        # interrupted. A read mark per worker makes the overlap free: whatever
        # SubagentStop already sent is not sent twice.
        (aura transcript-sync \
            --session "$SYNC_SESSION" \
            --transcript "$SYNC_TRANSCRIPT" --subagents >/dev/null 2>&1 &) </dev/null
    fi
fi

if ! should_use_structured; then
    exit 0
fi

source "$SCRIPT_DIR/build-payload.sh"

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
