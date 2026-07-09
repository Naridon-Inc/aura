# Aura Shell

A native desktop client for [Aura](https://github.com/Naridon-Inc/aura) — the semantic version control engine that tracks code changes at the AST level. Aura Shell turns Aura's MCP surface into a real editor: agent tabs, planning canvases, A2A tasks across machines, and a Manager you can actually chat with.

Built with Tauri 2 + React 19 + Bun + Rust.

---

## What's inside

**Manager chat** with the agent that runs your plans. Cmd+V image paste, base64 attachments, Web Speech API dictation, Plan/Build/Ask modes, /commands and @-context.

**Multi-agent surface.** Claude Code, Gemini CLI, Codex, Cursor agent mode, Kimi-Coder, and OpenCode all spawn as real PTYs with stream-json parsing, session resume, and a history pre-roll above the live terminal for restored tabs.

**A2A Tasks panel.** Plan → wave → task → subtask, scoped to the active workspace. List + Kanban views with drag-and-drop status changes. Collections cut across plans. **Take up + worktree** claims a task, mints a managed git worktree off HEAD, and spawns the configured agent inside it as a new tab — in one click.

**Plans as openable markdown.** `Plans/<plan>.md` opens as an editor tab with checkboxes that round-trip to A2A task state.

**Managed worktrees.** `~/.aura/worktrees/<project>/<branch>/` by default, or point Aura at any folder via Settings → Engine flags → Worktrees.

**Cross-pane drag-and-drop.** Move a tab from one split pane to another by dragging it across.

**Plugin platform (preview).** Rail tiles, status pills, slash commands, MCP runners, Skills, and a JSON-RPC bridge to Worker-hosted plugins. Settings dialog manages enable/disable + permissions.

**Clipboard tray** at `~/.aura/clips/` — paste/drag images and files; survives reloads so agents can read them by absolute path.

---

## Run it

```sh
bun install
bun run tauri dev
```

Tauri's wrapper handles the Vite dev server + Rust rebuilds.

---

## Build a distributable

Apple Silicon:

```sh
bun run app:build:arm64:fast    # signed, skip notarization
bun run app:build:arm64          # signed + notarized
```

Intel + ARM universal: `bun run app:build`.

Notarization requires `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` in env. See `scripts/sign-notarize.sh`.

---

## Architecture quick map

| Layer | Where |
|---|---|
| Tauri commands (Rust) | `src-tauri/src/cmd_*.rs` |
| Agent providers | `aura-agents/src/{claude_code,gemini_cli,codex,cursor,kimi_coder,opencode}.rs` |
| Manager brain (chat loop) | `src-tauri/src/manager/brain.rs` |
| Worktree manager | `src-tauri/src/worktree.rs` |
| Plugin host bridge | `src/lib/pluginBridge/`, `src-tauri/src/plugin_host/` |
| Editor store (single source of truth) | `src/lib/editorStore.ts` |
| Settings dialog | `src/components/dialogs/SettingsDialog.tsx` |
| Right-rail Tasks panel | `src/components/rightrail/TeamTasksPanel.tsx` |
| Workspace + split layout | `src/components/{WorkspaceRail,WorkSurface}.tsx` |

---

## Recommended IDE setup

- VS Code + the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.
- Or open the workspace in Aura Shell itself once you've built it.
