#!/bin/bash
# Determines whether the current Aura Shell build supports structured CLI
# agent notifications.
#
# Usage:
#   source "$SCRIPT_DIR/should-use-structured.sh"
#   if should_use_structured; then
#       # ... send structured notification
#   else
#       # ... no-op (Aura is not the host terminal, or pre-protocol)
#   fi
#
# Returns 0 (true) when structured notifications are safe to use, 1 (false)
# otherwise. Aura has no shipped legacy releases so we simply gate on the
# protocol-version env being present.

should_use_structured() {
    [ -z "${AURA_CLI_AGENT_PROTOCOL_VERSION:-}" ] && return 1
    return 0
}
