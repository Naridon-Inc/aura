# aura-agent — the hook body every non-Claude agent CLI runs

`aura-claude` and `aura-gemini` are plugin packages for one host each. This one
is not a host plugin at all: it is the single implementation of *"an agent just
changed a file, record it"*, plus the two small shims needed by the CLIs whose
hooks are modules rather than shell commands.

Aura stages it at `~/.aura/plugins/aura-agent/`, and each supported CLI is
pointed at it in whatever way that CLI supports.

## Why it is shared

Five CLIs disagree about what a tool is called, what its arguments are called,
and whether the keys are `snake_case` or `camelCase`. They agree about
everything else. Written once per CLI, the decision about what counts as a
change would exist five times — and the first time one of them learned about a
new editing tool, the other four would quietly stop noticing it.

So `scripts/on-post-tool-use.sh` reads every dialect and makes the decision
once. The shims below only translate.

## Where each CLI reads it from

| CLI | Stamped into | Mechanism |
|---|---|---|
| **codex** | `~/.codex/hooks.json` | shell command, `PostToolUse` |
| **kimi** | `~/.kimi/config.toml` `hooks = [...]` | shell command, `PostToolUse` |
| **opencode** | `~/.config/opencode/plugin/aura.js` | plugin module, `tool.execute.after` |
| **pi** | `~/.pi/agent/extensions/aura.ts` | extension module, `tool_execution_end` |
| **cursor** | *nothing of its own* | cursor-agent reads `<repo>/.claude/settings.local.json` and remaps Claude's events onto its own, so Aura's Claude stamp already covers it. Stamping `.cursor/hooks.json` as well would fire both and log every edit twice. |

All four stamps are user-global on purpose. The repo a teammate is working in
is precisely the repo Aura has never been told about, so a per-repo stamp would
miss the case this exists for.

## Requirements

- `jq` (`brew install jq` / `apt install jq`) — the payload is JSON.
- `aura` on `PATH`. Without it the hook exits 0 and does nothing.

## Licence

MIT, © 2026 Naridon Inc. See `LICENSE`.
