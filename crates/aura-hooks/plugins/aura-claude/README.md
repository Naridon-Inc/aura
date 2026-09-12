# aura-claude — Claude Code plugin for Aura Shell

Forked from [warpdotdev/claude-code-warp](https://github.com/warpdotdev/claude-code-warp) (MIT, © 2025 Warp).
This fork rebrands the OSC 777 sentinel from `warp://cli-agent` to
`aura://cli-agent` and renames negotiation env vars to `AURA_CLI_AGENT_PROTOCOL_VERSION`
and `AURA_CLIENT_VERSION` so Aura Shell can ingest the same structured event
stream Warp pioneered.

## What it does

Installs Claude Code hooks (SessionStart, UserPromptSubmit, Stop, Notification,
PostToolUse, PermissionRequest) that emit a structured JSON payload over
OSC 777 to whichever terminal Claude is running in. Aura Shell parses those
payloads and updates the agent session state machine — `Blocked` when a
permission/notification is pending, `InProgress` after a prompt is submitted,
`Success` on Stop. Without these hooks Aura would have to scrape the PTY
output text, which is fragile.

## Install

From inside Claude Code:

```
/plugin marketplace add naridon-inc/aura-shell --path plugins/aura-claude
/plugin install aura@aura-claude
```

Aura Shell will offer to do this for you on first launch with a Claude tab.

## Requirements

- `jq` (`brew install jq` / `apt install jq`).
- Claude Code ≥ 2.0.0.

## Protocol

Each hook fires `\033]777;notify;aura://cli-agent;<json>\007` to `/dev/tty`.
The JSON shape:

```json
{
  "v": 1,
  "agent": "claude",
  "event": "stop|prompt_submit|permission_request|tool_complete|session_start|idle_prompt",
  "session_id": "<claude session uuid>",
  "cwd": "/abs/path",
  "project": "basename of cwd",
  "...": "event-specific fields (query, response, summary, tool_name, tool_input, plugin_version)"
}
```

Negotiation: when Aura sets `AURA_CLI_AGENT_PROTOCOL_VERSION=N` in the
PTY env, the plugin emits `min(N, plugin_version)`. When Aura is missing
or pre-protocol, the plugin no-ops.
