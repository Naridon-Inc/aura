#!/bin/bash
# Hook script for Gemini CLI AfterTool event
# Sends a structured Aura notification after a tool call completes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/should-use-structured.sh"

# Stdin can be read exactly once, and both halves below want it, so it is read
# here — before anything that might exit early — rather than inside whichever
# half happens to run first.
INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // .input // {}' 2>/dev/null)
if [ -z "$TOOL_INPUT" ]; then
    TOOL_INPUT="{}"
fi

# The session this edit belongs to. The console groups intent rows by it to
# build its Sessions feed, so a row without one is work nobody can place.
# Gemini spells it `session_id`; older payloads carry `sessionId`.
SESSION=$(echo "$INPUT" | jq -r '.session_id // .sessionId // empty' 2>/dev/null)

# The structured notification exists to tell the Aura Shell tab hosting this
# agent that the tool finished. Outside such a tab there is no host to tell,
# which is what should_use_structured is asking.
if should_use_structured; then
    source "$SCRIPT_DIR/build-payload.sh"
    BODY=$(build_payload "$INPUT" "tool_complete" \
        --arg tool_name "$TOOL_NAME" \
        --argjson tool_input "$TOOL_INPUT")
    "$SCRIPT_DIR/aura-notify.sh" "aura://cli-agent" "$BODY"
fi

# Deliberately outside the gate above, and that is the whole point of this
# change: it used to sit under it, so the record of what an agent changed
# depended on whether the agent happened to be running inside an Aura Shell
# tab. The same Gemini session in Terminal, iTerm, over ssh or on a runner
# wrote nothing at all — no intent row, so nothing reached the cloud, so the
# console showed a repo as idle while somebody was actively editing it.
# Notifying a host terminal and writing history are unrelated concerns.
#
# Stage 10D — same auto-intent-log as the Claude hook. Gemini's tool
# names map slightly differently (write_file / replace) so the case
# matches both common shapes plus generic Edit/Write.
# A path as the repository names it, not as this shell happens to see it.
#
# Both the intent log and `aura why` key on repo-relative paths, so a hook that
# strips only $PWD writes rows nothing can match the moment an agent works from
# a subdirectory. Falls back to the $PWD form when git cannot answer.
repo_relative() {
    local p=$1 root
    root=$(git -C "$(dirname "$p")" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$root" ]; then
        printf '%s' "${p#"$root"/}"
    else
        printf '%s' "${p#"$PWD"/}"
    fi
}

case "$TOOL_NAME" in
    write_file|replace|Edit|MultiEdit|Write|NotebookEdit)
        FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // .absolute_path // empty' 2>/dev/null)
        if [ -n "$FILE_PATH" ] && command -v aura >/dev/null 2>&1; then
            REL_PATH=$(repo_relative "$FILE_PATH")
            # `--file` and `--session` were missing here while the Claude hook
            # sent both: a Gemini edit logged a row nothing could place — not
            # against a file, not in a session. The console builds its Sessions
            # feed by grouping on session_id, so those rows were work nobody
            # could see.
            set -- log-intent "Gemini $TOOL_NAME on $REL_PATH" --tool "$TOOL_NAME" --file "$REL_PATH"
            [ -n "$SESSION" ] && set -- "$@" --session "$SESSION"
            AURA_AGENT="Gemini" aura "$@" >/dev/null 2>&1 &
        fi
        ;;
    run_shell_command|Bash)
        BASH_CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null | head -c 400)
        if echo "$BASH_CMD" | grep -qE "^(rm |mv |sed -i|cp .* .*|git (commit|reset|push|rebase|merge)|npm install|yarn add|bun add)"; then
            if command -v aura >/dev/null 2>&1; then
                aura log-intent "Gemini Bash: $BASH_CMD" >/dev/null 2>&1 &
            fi
        fi
        ;;
esac

echo '{}'
