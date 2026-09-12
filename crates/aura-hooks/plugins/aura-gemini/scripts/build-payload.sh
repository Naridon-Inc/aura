#!/bin/bash
# Builds a structured JSON notification payload for aura://cli-agent.

PLUGIN_CURRENT_PROTOCOL_VERSION=1

negotiate_protocol_version() {
    local aura_version="${AURA_CLI_AGENT_PROTOCOL_VERSION:-1}"
    if [ "$aura_version" -lt "$PLUGIN_CURRENT_PROTOCOL_VERSION" ] 2>/dev/null; then
        echo "$aura_version"
    else
        echo "$PLUGIN_CURRENT_PROTOCOL_VERSION"
    fi
}

build_payload() {
    local input="$1"
    local event="$2"
    shift 2

    local protocol_version
    protocol_version=$(negotiate_protocol_version)

    local session_id cwd project
    session_id=$(echo "$input" | jq -r '.session_id // empty' 2>/dev/null)
    cwd=$(echo "$input" | jq -r '.cwd // empty' 2>/dev/null)
    project=""
    if [ -n "$cwd" ]; then
        project=$(basename "$cwd")
    fi

    jq -nc \
        --argjson v "$protocol_version" \
        --arg agent "gemini" \
        --arg event "$event" \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg project "$project" \
        "$@" \
        '{v:$v, agent:$agent, event:$event, session_id:$session_id, cwd:$cwd, project:$project} + $ARGS.named'
}
