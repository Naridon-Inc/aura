# aura-gemini — Gemini CLI extension for Aura Shell

Forked from [warpdotdev/gemini-cli-warp](https://github.com/warpdotdev/gemini-cli-warp) (MIT, © 2025 Warp).
Same OSC 777 protocol as `aura-claude`, mapped onto Gemini CLI's hook names
(`BeforeAgent` / `AfterAgent` / `AfterTool` / `Notification` / `SessionStart`).

## Install

Drop this directory into a Gemini extensions path (e.g. `~/.gemini/extensions/aura-gemini/`)
or have Aura Shell symlink it on first launch with a Gemini tab.

## Requirements

- `jq` (`brew install jq` / `apt install jq`).
- Gemini CLI ≥ 1.0.0.
