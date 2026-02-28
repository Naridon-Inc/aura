# OpenCode Integration (preview)

Entire integrates with OpenCode via a TypeScript plugin that hooks into OpenCode's event system.

- **Bun Runtime**: Plugin requires Bun.
- **Transcript Export**: Calls `opencode export` on turn end.
- **Strategy**: Recommended to use `manual-commit` strategy.
