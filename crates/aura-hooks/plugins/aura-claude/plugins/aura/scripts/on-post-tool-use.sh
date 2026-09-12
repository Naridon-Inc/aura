#!/bin/bash
# Hook script for Claude Code PostToolUse event
# Sends a structured Aura notification after a tool call completes,
# transitioning the session status from Blocked back to InProgress.

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

# Who is actually running this script. Claude is the usual answer, but not the
# only one: cursor-agent reads this same settings.local.json, remaps the event
# and tool names onto its own, and calls these hooks. Its payload carries a
# generation_id where Claude's carries a session_id, which is how the intent
# row ends up naming the agent that did the work instead of always saying
# "Claude".
AGENT="Claude"
if [ -n "$(echo "$INPUT" | jq -r '.generation_id // empty' 2>/dev/null)" ]; then
    AGENT="Cursor"
fi

# The session this edit belongs to. The console builds its Sessions feed by
# grouping intent rows that share one, so a row without it is work nobody can
# place. Claude calls it `session_id`; cursor-agent calls the same thing
# `conversation_id` — its `generation_id` is per-turn, and reading that instead
# would make every single edit its own one-second session.
SESSION=$(echo "$INPUT" | jq -r '.session_id // .conversation_id // empty' 2>/dev/null)

# Which worker inside that session, when it was a worker rather than the main
# thread. Claude Code sets `agent_id` only for a tool call made from inside a
# Task-tool sub-agent — its own docs say to read this field, not `agent_type`,
# to tell the two apart — so its absence is the signal that this was the
# session itself. Without it every sub-agent's edits arrived filed under the
# parent and there was no way back to which worker did the work.
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)

# Log one intent row, backgrounded so the tool the person is waiting on does
# not wait for us. `AURA_AGENT` is what the row is filed under: without it
# every row reads `hook_auto` and the console can say that somebody was
# working but not who.
log_intent() {
    local text=$1
    local file=${2:-}
    [ -n "$text" ] || return 0
    command -v aura >/dev/null 2>&1 || return 0

    set -- log-intent "$text" --tool "$TOOL_NAME"
    [ -n "$file" ] && set -- "$@" --file "$file"
    [ -n "$SESSION" ] && set -- "$@" --session "$SESSION"
    [ -n "$AGENT_ID" ] && set -- "$@" --subagent-id "$AGENT_ID"
    [ -n "$AGENT_ID" ] && [ -n "$AGENT_TYPE" ] && set -- "$@" --subagent-type "$AGENT_TYPE"

    AURA_AGENT="$AGENT" aura "$@" >/dev/null 2>&1 &
}

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

# Say that somebody is still in here, whatever the tool was.
#
# The console decides whether a session is running from when it was last heard
# from, and the only thing it ever heard from a terminal session was a logged
# intent — which exists only when a file changes. An agent that spends half an
# hour reading, grepping, building and driving a browser is working the whole
# time and looks finished the whole time. This is the signal that was missing,
# so it is sent for every tool, not only the ones that write.
#
# Throttled to one beat every thirty seconds. Liveness is judged in minutes —
# five, on the console side — while tool calls can fire several times a second,
# so beating on each one would be hundreds of POSTs per session buying no truth
# the first one did not already carry. The stamp lives under `TMPDIR` so a test
# can point it somewhere disposable, and a stamp that is missing or unreadable
# reads as "never beat", which errs towards sending.
#
# Backgrounded and silenced like every other call here — the person is waiting
# on the tool, not on us, and a beat that failed loudly when the laptop is
# offline would be a reason to switch the hook off.
if [ -n "$SESSION" ] && command -v aura >/dev/null 2>&1; then
    BEAT_STAMP="${TMPDIR:-/tmp}/aura-beat-${SESSION}"
    BEAT_NOW=$(date +%s)
    BEAT_LAST=$(cat "$BEAT_STAMP" 2>/dev/null || echo 0)
    case "$BEAT_LAST" in (*[!0-9]*|"") BEAT_LAST=0 ;; esac
    if [ "$((BEAT_NOW - BEAT_LAST))" -ge 30 ]; then
        echo "$BEAT_NOW" > "$BEAT_STAMP" 2>/dev/null
        printf '%s' "$INPUT" | aura beat --session "$SESSION" --agent "$AGENT" >/dev/null 2>&1 &
    fi
fi

# Deliberately outside the gate above, and that is the whole point of this
# change: it used to sit under it, so the record of what an agent changed
# depended on whether the agent happened to be running inside an Aura Shell
# tab. The same Claude session in Terminal, iTerm, over ssh or on a runner
# wrote nothing at all — no intent row, so nothing reached the cloud, so the
# console showed a repo as idle while somebody was actively editing it.
# Notifying a host terminal and writing history are unrelated concerns.
#
# Stage 10D — auto-log intent on every code-mutating tool. Manager and
# the History sidebar then have a complete trail of what each agent
# touched without the agent having to call aura_log_intent itself. Best
# effort: failure here must not block the parent tool.
case "$TOOL_NAME" in
    Edit|MultiEdit|Write|NotebookEdit)
        FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .notebook_path // empty' 2>/dev/null)
        if [ -n "$FILE_PATH" ]; then
            REL_PATH=$(repo_relative "$FILE_PATH")
            log_intent "$AGENT $TOOL_NAME on $REL_PATH" "$REL_PATH"
        fi
        ;;
    Bash|Shell)
        # `Shell` is cursor-agent's spelling of the same tool.
        # Only log Bash invocations that look like code-mutating commands
        # (sed/awk-in-place, mv, rm). Read-only commands (ls, cat, grep)
        # would flood the intent log with no signal.
        BASH_CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null | head -c 400)
        if echo "$BASH_CMD" | grep -qE "^(rm |mv |sed -i|cp .* .*|git (commit|reset|push|rebase|merge)|npm install|yarn add|bun add)"; then
            log_intent "$AGENT $TOOL_NAME: $BASH_CMD"
        fi
        ;;
esac
