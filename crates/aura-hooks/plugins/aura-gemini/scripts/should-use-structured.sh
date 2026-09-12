#!/bin/bash
# Determines whether the current Aura Shell build supports structured CLI
# agent notifications. See aura-claude for full docs.

should_use_structured() {
    [ -z "${AURA_CLI_AGENT_PROTOCOL_VERSION:-}" ] && return 1
    return 0
}
