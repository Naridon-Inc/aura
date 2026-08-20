//! Every slash command each agent CLI actually ships, so the chat composer's
//! `/` menu is that CLI's real menu and not a curated handful.
//!
//! WHERE THIS COMES FROM. There is no in-repo catalog to read: `aura-agents`
//! knows how to LAUNCH each CLI and `agents/policy.json` knows how to CONFIGURE
//! it, but neither knows what the REPL will accept once it is up — that
//! vocabulary lives inside the CLI. So each list below was read out of the
//! installed product itself:
//!
//!   - **claude** — Claude Code 2.1.220. Its command objects survive in the
//!     bun-compiled bundle as `{type:"local"|"local-jsx"|"prompt", name, …}`
//!     with the description the menu shows; the union with the natives already
//!     proven by `lib/slashCommands.ts` keeps anything a newer build stopped
//!     declaring inline (`/cost`, `/vim`).
//!   - **gemini** — Gemini CLI's `BuiltinCommandLoader.allDefinitions`, which
//!     is literally the array the CLI registers, so this is its top level in
//!     full. Sub-commands (`/model set`, `/chat save`) are NOT separate rows —
//!     they are typed after the parent, and `args` says so where it matters.
//!   - **cursor** — cursor-agent's own `R.push({id, title, description})`
//!     registry, minus the rows that are `/config` SETTINGS rather than
//!     commands (`vim-mode`, `max-mode`, the `permissions-*` pair, the
//!     `show-*` trio, `approval-mode`, `channel`, `attribute-*`) and minus its
//!     internal debug entries (`throw`, `debug-test`, `pq`).
//!   - **kimi** — Kimi Code's TUI command table, read from its bundle with the
//!     descriptions and aliases it registers.
//!   - **codex** — the hard one, and the one place this file is knowingly
//!     partial. Codex is a Rust binary: its command NAMES are string literals
//!     the linker deduplicates against the rest of the image, so the run that
//!     survives in rodata holds only the names that appear nowhere else. Every
//!     name below was read out of that run or is quoted verbatim by Codex's own
//!     copy (`/mcp verbose`, "Try /model to pick a different model"). Codex's
//!     descriptions live in a separate contiguous run, so a handful are paired
//!     by meaning rather than by offset. Commands whose descriptions we can see
//!     but whose names we cannot confirm are deliberately absent: an absent
//!     command is a small gap, a wrong one is an "unknown command" every time
//!     someone picks it.
//!
//!   - **opencode** — OpenCode 1.18.11, and the cleanest read of the five. Its
//!     TUI registers every command as an object that carries its own slash
//!     trigger inline (`{id:"model.choose", …, keybind:"mod+'", slash:"model"}`),
//!     so the list below is `slash:` scanned exhaustively out of the bundle —
//!     thirteen triggers, no more and no fewer. The summaries are OpenCode's
//!     OWN English strings, lifted from the `command.<id>.description` entries
//!     of its i18n table (it ships seventeen languages; we take the English
//!     one), falling back to its `command.<id>` title where it declares no
//!     description. Nothing here is paraphrased.
//!
//!   - **pi** — Pi 0.83.0, and the only one that needed no reverse-engineering
//!     at all: it ships its `BUILTIN_SLASH_COMMANDS` array as readable ESM in
//!     the published package, one object per command carrying the description
//!     its own menu prints. The list below is that array, in its order and its
//!     words. Pi extensions register further commands at runtime, which is not
//!     knowable statically — the built-ins are what every install has.
//!
//! Not listed, and why: **antigravity/agy** fetches its commands from its
//! server (`GetSlashCommands` in the binary) — its set is only knowable at
//! runtime, so guessing it statically would be exactly the mistake this file
//! avoids. It gets the chat view with no `/` menu until we can read it
//! honestly.
//!
//! Re-read this whenever a CLI is upgraded; a command that has been renamed is
//! a menu row that fails when clicked.

/** One row of a CLI's `/` menu. `name` carries no leading slash because that is
 *  what the composer's command chip holds; `args` is the rest of the usage line,
 *  shown as a hint after the name. */
export type CliCommand = {
  name: string;
  summary: string;
  args?: string;
};

/** Keyed by the registry agent id (`AgentTab.agentId`). */
export const AGENT_CLI_CATALOG: Record<string, CliCommand[]> = {
  claude: [
    { name: "add-dir", summary: "Add a new working directory" },
    { name: "advisor", summary: "Let Claude consult a stronger model at key moments" },
    { name: "agents", summary: "Open Claude Code's agents picker" },
    { name: "artifacts", summary: "Browse your published and shared artifacts" },
    { name: "auto-mode-setup", summary: "Set up and customise auto mode — environment context, plus optional rule tweaks" },
    { name: "autocompact", summary: "Set how full the context gets before auto-summarizing" },
    { name: "autofix-pr", summary: "Monitor and autofix any issues with the current PR" },
    { name: "background", summary: "Send this session to the background and free the terminal" },
    { name: "batch", summary: "Plan a large change; background agents each open a PR" },
    { name: "branch", summary: "Create a branch of the current conversation at this point" },
    { name: "brief", summary: "Toggle brief-only mode" },
    { name: "btw", summary: "Ask a quick side question without interrupting the main conversation" },
    { name: "bug", summary: "Report a bug or share your conversation" },
    { name: "cd", summary: "Move this session to a new working directory" },
    { name: "chrome", summary: "Open Claude in Chrome settings" },
    { name: "claude-api", summary: "Build and debug apps that use the Claude API" },
    { name: "claude-in-chrome", summary: "Let Claude browse and interact with pages in your Chrome" },
    { name: "clear", summary: "Start a new session with empty context; previous session stays on disk (resumable with /resume)" },
    { name: "color", summary: "Set the prompt bar color for this session" },
    { name: "compact", summary: "Free up context by summarizing the conversation so far" },
    { name: "config", summary: "Open settings" },
    { name: "context", summary: "Visualize current context usage as a colored grid" },
    { name: "copy", summary: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)" },
    { name: "cost", summary: "Show Claude Code's cost summary" },
    { name: "daemon", summary: "Manage background services and routines" },
    { name: "debug", summary: "Turn on debug logging and investigate problems" },
    { name: "design", summary: "Grant or revoke Claude agent access to your Design projects" },
    { name: "design-login", summary: "Authorize design-system access for /design-sync with your claude.ai account" },
    { name: "design-sync", summary: "Push your design system components to claude.ai/design" },
    { name: "desktop", summary: "Continue the current session in Claude Desktop" },
    { name: "diff", summary: "View uncommitted changes and per-turn diffs" },
    { name: "doctor", summary: "Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory files, slow hooks, updates, permissions" },
    { name: "effort", summary: "Set effort level for model usage" },
    { name: "explain-usage", summary: "See where this session’s tokens went, in plain words" },
    { name: "export", summary: "Export the current conversation to a file or clipboard" },
    { name: "feedback", summary: "Send feedback to Anthropic or report a bug" },
    { name: "fewer-permission-prompts", summary: "Pre-approve safe read-only commands based on your usage" },
    { name: "focus", summary: "Toggle focus view: just your prompt, summary, and response" },
    { name: "fork", summary: "Spawn a background agent that inherits the full conversation" },
    { name: "goal", summary: "Set a goal Claude checks before stopping" },
    { name: "help", summary: "Show help and available commands" },
    { name: "hooks", summary: "View hook configurations for tool events" },
    { name: "ide", summary: "Manage IDE integrations and show status" },
    { name: "import", summary: "Import config from another AI coding agent" },
    { name: "init", summary: "Initialize new CLAUDE.md file(s) and optional skills/hooks with codebase documentation" },
    { name: "insights", summary: "Generate a report analyzing your Claude Code sessions" },
    { name: "install", summary: "Install Claude Code native build" },
    { name: "install-github-app", summary: "Set up Claude GitHub Actions for a repository" },
    { name: "install-slack-app", summary: "Install the Claude Slack app" },
    { name: "keybindings", summary: "Open your keyboard shortcuts file" },
    { name: "login", summary: "Sign in with your Anthropic account" },
    { name: "logout", summary: "Sign out from your Anthropic account" },
    { name: "loop", summary: "Repeat a prompt or command on an interval (e.g. /loop 5m /foo)" },
    { name: "loops", summary: "List, create, and delete loops" },
    { name: "mcp", summary: "Manage MCP servers" },
    { name: "memory", summary: "Open a memory file in your editor" },
    { name: "mobile", summary: "Show QR code to download the Claude mobile app" },
    { name: "model", summary: "Set the AI model for Claude Code", args: "<model>" },
    { name: "passes", summary: "Share a free week of Claude Code with friends and earn usage credits" },
    { name: "pause-memory", summary: "Pause automemory for this session" },
    { name: "permissions", summary: "Manage allow and deny tool permission rules" },
    { name: "plan", summary: "Enable plan mode or view the current session plan" },
    { name: "plan-artifact", summary: "Publish a plan as a shareable Artifact" },
    { name: "plugin", summary: "Manage Claude Code plugins" },
    { name: "powerup", summary: "Discover Claude Code features through quick interactive lessons" },
    { name: "privacy-settings", summary: "View and update your privacy settings" },
    { name: "radio", summary: "Listen to Claude FM lo-fi radio" },
    { name: "recap", summary: "Generate a one-line session recap now" },
    { name: "release-notes", summary: "View release notes" },
    { name: "reload-plugins", summary: "Activate pending plugin changes in the current session" },
    { name: "reload-skills", summary: "Pick up skills added or changed on disk during this session" },
    { name: "remote-control", summary: "Control this session from your phone or claude.ai/code" },
    { name: "remote-env", summary: "Choose the default environment for cloud agents" },
    { name: "rename", summary: "Rename the current conversation" },
    { name: "resume", summary: "Resume a previous conversation" },
    { name: "review", summary: "Review a GitHub pull request; for your working diff use /code-review" },
    { name: "rewind", summary: "Restore the code and/or conversation to a previous point" },
    { name: "run", summary: "Launch this project’s app to see your change working" },
    { name: "run-skill-generator", summary: "Create a skill that knows how to run this project’s app" },
    { name: "schedule", summary: "Create and manage routines: cloud agents on a schedule" },
    { name: "scroll-speed", summary: "Adjust mouse wheel scroll speed" },
    { name: "session", summary: "Show cloud session URL and QR code" },
    { name: "setup-bedrock", summary: "Reconfigure Amazon Bedrock authentication, region, or model pins" },
    { name: "setup-cowork", summary: "Guided setup — pick a role, install a plugin, try a skill, connect tools" },
    { name: "setup-vertex", summary: "Reconfigure Google Vertex AI authentication, project, region, or model pins" },
    { name: "skill-doctor", summary: "Show which loaded skills are unused and costing context" },
    { name: "skills", summary: "List available skills" },
    { name: "status", summary: "Show Claude Code status including version, model, account, API connectivity, and tool statuses" },
    { name: "statusline", summary: "Set up Claude Code's status line UI" },
    { name: "stickers", summary: "Order Claude Code stickers" },
    { name: "stop", summary: "Stop this background session; transcript and worktree are kept" },
    { name: "subtask", summary: "Send a subagent off with your full context; its result comes back here" },
    { name: "tasks", summary: "View and manage everything running in the background" },
    { name: "team-onboarding", summary: "Help teammates ramp on Claude Code with a guide from your usage" },
    { name: "teleport", summary: "Resume a Claude Code session from claude.ai" },
    { name: "terminal-setup", summary: "Enable Option+Enter key binding for newlines and disable the audible bell" },
    { name: "theme", summary: "Change the theme" },
    { name: "tui", summary: "Set the terminal UI renderer (default | fullscreen)" },
    { name: "ultraplan", summary: "Claude Code on the web drafts a plan you can edit and approve" },
    { name: "ultrareview", summary: "Find and verify bugs in your branch using Claude Code on the web" },
    { name: "update", summary: "Switch to the latest version (conversation continues)" },
    { name: "update-config", summary: "Change settings: hooks, permissions, environment variables" },
    { name: "upgrade", summary: "Upgrade to Max for higher rate limits and more Opus" },
    { name: "usage", summary: "Show session cost, plan usage, and activity stats" },
    { name: "usage-credits", summary: "Configure usage credits or request them from your admin when you hit a limit" },
    { name: "version", summary: "Show this session's version (autoupdate may have a newer one)" },
    { name: "vim", summary: "Toggle vim keybindings in Claude Code" },
    { name: "voice", summary: "Toggle voice mode" },
    { name: "web-setup", summary: "Set up Claude Code on the web with your GitHub account" },
    { name: "wellbeing", summary: "Configure optional break reminders and quiet-hours nudges" },
    { name: "whiteboard", summary: "Sketch on a whiteboard Artifact you can send to Claude" },
    { name: "workflows", summary: "Browse running and completed workflows" },
    { name: "workshop", summary: "Workshop a document through artifact decisions" },
  ],
  gemini: [
    { name: "about", summary: "Show version info" },
    { name: "agents", summary: "Manage agents" },
    { name: "auth", summary: "Manage authentication" },
    { name: "bug", summary: "Submit a bug report" },
    { name: "bug-memory", summary: "Capture a V8 heap snapshot to disk to attach to a bug report" },
    { name: "chat", summary: "Browse auto-saved conversations and manage chat checkpoints" },
    { name: "clear", summary: "Clear the screen and start a new session" },
    { name: "commands", summary: "Manage custom slash commands. Usage: /commands [list|reload]" },
    { name: "compress", summary: "Compresses the context by replacing it with a summary" },
    { name: "copy", summary: "Copy the last result or code snippet to clipboard" },
    { name: "corgi", summary: "Toggles corgi mode" },
    { name: "directory", summary: "Manage workspace directories" },
    { name: "docs", summary: "Open full Gemini CLI documentation in your browser" },
    { name: "editor", summary: "Set external editor preference" },
    { name: "export-session", summary: "Export the current session to a JSON file" },
    { name: "extensions", summary: "Manage extensions" },
    { name: "footer", summary: "Configure which items appear in the footer (statusline)" },
    { name: "gemma", summary: "Check local Gemma model routing status" },
    { name: "help", summary: "For help on gemini-cli" },
    { name: "hooks", summary: "Manage hooks" },
    { name: "ide", summary: "Manage IDE integration" },
    { name: "init", summary: "Analyzes the project and creates a tailored GEMINI.md file" },
    { name: "mcp", summary: "Manage configured Model Context Protocol (MCP) servers" },
    { name: "memory", summary: "Commands for interacting with memory" },
    { name: "model", summary: "Manage model configuration", args: "set <model>" },
    { name: "permissions", summary: "Manage folder trust settings and other permissions" },
    { name: "plan", summary: "Switch to Plan Mode and view current plan" },
    { name: "policies", summary: "Manage policies" },
    { name: "privacy", summary: "Display the privacy notice" },
    { name: "quit", summary: "Exit the cli" },
    { name: "restore", summary: "Restore a tool call, resetting conversation and file history to that point" },
    { name: "resume", summary: "Browse auto-saved conversations and manage chat checkpoints" },
    { name: "rewind", summary: "Jump back to a specific message and restart the conversation" },
    { name: "settings", summary: "View and edit Gemini CLI settings" },
    { name: "setup-github", summary: "Set up GitHub Actions" },
    { name: "shortcuts", summary: "Toggle the shortcuts panel above the input" },
    { name: "skills", summary: "List, enable, disable, or reload Gemini CLI agent skills" },
    { name: "stats", summary: "Check session stats. Usage: /stats [session|model|tools]" },
    { name: "tasks", summary: "Toggle background tasks view" },
    { name: "terminal-setup", summary: "Configure terminal keybindings for multiline input" },
    { name: "theme", summary: "Change the theme" },
    { name: "tools", summary: "List available Gemini CLI tools. Use /tools desc to include descriptions." },
    { name: "upgrade", summary: "Upgrade your Gemini Code Assist tier for higher limits" },
    { name: "vim", summary: "Toggle vim mode on/off" },
    { name: "voice", summary: "Toggle voice dictation mode" },
  ],
  codex: [
    { name: "app", summary: "continue this session in the Desktop app" },
    { name: "approve", summary: "approve one retry of a recent auto-review denial" },
    { name: "archive", summary: "archive this session and exit" },
    { name: "btw", summary: "ask a quick side question without derailing the main thread" },
    { name: "clear", summary: "clear the terminal and start a new chat" },
    { name: "compact", summary: "summarize conversation to prevent hitting the context limit" },
    { name: "copy", summary: "copy last response as markdown" },
    { name: "diff", summary: "show git diff (including untracked files)" },
    { name: "exit", summary: "exit Codex" },
    { name: "fork", summary: "fork the current chat" },
    { name: "ide", summary: "include current selection, open files, and other context from your IDE" },
    { name: "import", summary: "import setup, this project, and recent chats from Claude Code" },
    { name: "init", summary: "create an AGENTS.md file with instructions for Codex" },
    { name: "keymap", summary: "remap TUI shortcuts" },
    { name: "logout", summary: "log out of Codex" },
    { name: "mcp", summary: "list configured MCP tools; use /mcp verbose for details" },
    { name: "model", summary: "choose what model and reasoning effort to use" },
    { name: "new", summary: "start a new chat during a conversation" },
    { name: "pets", summary: "choose or hide the terminal pet" },
    { name: "ps", summary: "list background terminals" },
    { name: "quit", summary: "exit Codex" },
    { name: "raw", summary: "toggle raw scrollback mode for copy-friendly terminal selection" },
    { name: "rename", summary: "rename the current thread" },
    { name: "resume", summary: "resume a saved chat" },
    { name: "review", summary: "review my current changes and find issues" },
    { name: "rollout", summary: "print the rollout file path" },
    { name: "sandbox-add-read-dir", summary: "let sandbox read a directory: /sandbox-add-read-dir <absolute_path>" },
    { name: "setup-default-sandbox", summary: "set up elevated agent sandbox" },
    { name: "side", summary: "start a side conversation in an ephemeral fork" },
    { name: "status", summary: "show current session configuration and token usage" },
    { name: "statusline", summary: "configure which items appear in the status line" },
    { name: "usage", summary: "view account usage or use a usage limit reset" },
    { name: "vim", summary: "toggle Vim mode for the composer" },
  ],
  cursor: [
    { name: "about", summary: "Show CLI version, system, and account info (copies to clipboard)" },
    { name: "agent", summary: "Full agent capabilities with tool access" },
    { name: "apply-changes-locally", summary: "Apply this cloud agent's diffs into the working tree" },
    { name: "ask", summary: "Toggle ask mode (Q&A, read-only; no edits or command execution)" },
    { name: "btw", summary: "Ask on the side without disrupting the main chat; replies are not saved to history" },
    { name: "changes", summary: "Review changes — Conversation, Unstaged, Staged (when present), and Committed" },
    { name: "checkout-locally", summary: "Check out the current cloud agent's branch" },
    { name: "clear", summary: "Start a new chat session" },
    { name: "command", summary: "Manage custom commands" },
    { name: "commit", summary: "Ask the agent to stage and commit changes" },
    { name: "compress", summary: "Summarize the conversation to reduce context" },
    { name: "config", summary: "Configure CLI settings interactively" },
    { name: "copy-conversation-id", summary: "Copy current conversation ID" },
    { name: "copy-request-id", summary: "Copy last request ID" },
    { name: "cursor", summary: "Alias for /open" },
    { name: "debug", summary: "Toggle debug mode or submit a prompt in debug mode" },
    { name: "exit", summary: "Exit" },
    { name: "feedback", summary: "Share feedback with the team" },
    { name: "help", summary: "Show help (/help [cmd])" },
    { name: "jobs", summary: "Open active background tasks list" },
    { name: "logout", summary: "Sign out from Cursor" },
    { name: "mcp", summary: "Manage MCP servers (list, login, enable, disable, list-tools)" },
    { name: "model", summary: "Select model (Tab to edit)" },
    { name: "open", summary: "Open the repository's git root in Cursor" },
    { name: "plan", summary: "Create a plan or show existing plan with options" },
    { name: "plugin", summary: "Manage plugins - view installed, browse marketplace, install/uninstall" },
    { name: "quit", summary: "Exit" },
    { name: "rename", summary: "Rename the current chat session" },
    { name: "resume", summary: "Open the picker or switch by id with '/resume <id>'" },
    { name: "rule", summary: "Manage Cursor rules" },
    { name: "setup-terminal", summary: "Configure your terminal for newlines" },
    { name: "shell", summary: "Enter Shell Mode (hint: type ! on an empty line)" },
    { name: "skills", summary: "Open skills menu" },
    { name: "static-indicator", summary: "Toggle static divider and highlighting (/static-indicator [on|off|toggle|status])" },
    { name: "switch", summary: "Switch to a cloud agent by id" },
    { name: "sync-theme", summary: "Re-detect terminal theme and refresh UI" },
    { name: "usage", summary: "Show AI usage stats" },
  ],
  kimi: [
    { name: "add-dir", summary: "Add or list an additional workspace directory" },
    { name: "auto", summary: "Toggle Auto mode: fully autonomous, agent decides everything without asking" },
    { name: "btw", summary: "Ask a forked side agent a question" },
    { name: "compact", summary: "Compact the conversation context" },
    { name: "copy", summary: "Copy the last assistant message to the clipboard" },
    { name: "editor", summary: "Set the external editor for Ctrl-G" },
    { name: "effort", summary: "Switch thinking effort" },
    { name: "exit", summary: "Exit the application" },
    { name: "experiments", summary: "Manage experimental features" },
    { name: "export-debug-zip", summary: "Export current session as a debug ZIP archive" },
    { name: "export-md", summary: "Export current session as a Markdown file" },
    { name: "feedback", summary: "Send feedback to make Kimi Code better" },
    { name: "fork", summary: "Fork the current session" },
    { name: "goal", summary: "Start or manage an autonomous goal" },
    { name: "help", summary: "Show available commands and shortcuts" },
    { name: "init", summary: "Analyze the codebase and generate AGENTS.md" },
    { name: "login", summary: "Select a platform and authenticate" },
    { name: "logout", summary: "Log out of a configured provider" },
    { name: "mcp", summary: "Show MCP server status" },
    { name: "model", summary: "Switch LLM model" },
    { name: "new", summary: "Start a fresh session in the current workspace" },
    { name: "permission", summary: "Select permission mode" },
    { name: "plan", summary: "Toggle plan mode" },
    { name: "plugins", summary: "Manage plugins" },
    { name: "provider", summary: "Manage AI providers (add / delete / refresh)" },
    { name: "reload", summary: "Reload session and apply config.toml settings plus tui.toml UI preferences" },
    { name: "reload-tui", summary: "Reload only tui.toml UI preferences" },
    { name: "sessions", summary: "Browse and resume sessions" },
    { name: "settings", summary: "Open TUI settings" },
    { name: "status", summary: "Show current session and runtime status" },
    { name: "swarm", summary: "Toggle swarm mode or run one task in swarm mode" },
    { name: "tasks", summary: "Browse background tasks" },
    { name: "theme", summary: "Set the terminal UI theme" },
    { name: "title", summary: "Set or show session title" },
    { name: "undo", summary: "Withdraw the last prompt from the transcript" },
    { name: "usage", summary: "Show session tokens + context window + plan quotas" },
    { name: "version", summary: "Show version information" },
    { name: "web", summary: "Open the current session in the Web UI by starting a new server" },
    { name: "yolo", summary: "Toggle YOLO mode: auto-approve tool actions, but the agent may still ask questions" },
  ],
  // OpenCode's whole slash surface — every command in its TUI that declares a
  // `slash:` trigger, in its own words. It is a short list because OpenCode
  // puts most of its controls on keybinds rather than slash lines; a command
  // that has no trigger cannot be typed, so it is not a row here.
  opencode: [
    { name: "agent", summary: "Switch to the next agent" },
    { name: "compact", summary: "Summarize the session to reduce context size" },
    { name: "fork", summary: "Create a new session from a previous message" },
    { name: "mcp", summary: "Toggle MCPs" },
    { name: "model", summary: "Select a different model" },
    { name: "new", summary: "New session" },
    { name: "open", summary: "Open file" },
    { name: "redo", summary: "Redo the last undone message" },
    { name: "share", summary: "Share this session and copy the URL to clipboard" },
    { name: "terminal", summary: "Toggle terminal" },
    { name: "undo", summary: "Undo the last message" },
    { name: "unshare", summary: "Stop sharing this session" },
    { name: "workspace", summary: "Enable or disable multiple workspaces in the sidebar" },
  ],

  // Pi's built-in commands, exactly as it declares them: its
  // `BUILTIN_SLASH_COMMANDS` array ships uncompiled in the package, one object
  // per command with the description its own menu prints and an
  // `argumentHint` where the command takes one. So this is the whole list, in
  // Pi's order and in Pi's words — twenty-two rows, nothing paraphrased.
  //
  // Extensions can register more at runtime (Pi's own help says so), which
  // this cannot know statically. The built-ins are what every install has.
  pi: [
    { name: "settings", summary: "Open settings menu" },
    { name: "model", summary: "Select model (opens selector UI)", args: "<provider/model>" },
    { name: "scoped-models", summary: "Enable/disable models for Ctrl+P cycling" },
    {
      name: "export",
      summary: "Export session (HTML default, or specify path: .html/.jsonl)",
    },
    { name: "import", summary: "Import and resume a session from a JSONL file" },
    { name: "share", summary: "Share session as a secret GitHub gist" },
    { name: "copy", summary: "Copy last agent message to clipboard" },
    { name: "name", summary: "Set session display name" },
    { name: "session", summary: "Show session info and stats" },
    { name: "changelog", summary: "Show changelog entries" },
    { name: "hotkeys", summary: "Show all keyboard shortcuts" },
    { name: "fork", summary: "Create a new fork from a previous user message" },
    { name: "clone", summary: "Duplicate the current session at the current position" },
    { name: "tree", summary: "Navigate session tree (switch branches)" },
    { name: "trust", summary: "Save project trust decision for future sessions" },
    { name: "login", summary: "Configure provider authentication", args: "<provider>" },
    { name: "logout", summary: "Remove provider authentication" },
    { name: "new", summary: "Start a new session" },
    { name: "compact", summary: "Manually compact the session context" },
    { name: "resume", summary: "Resume a different session" },
    {
      name: "reload",
      summary:
        "Reload keybindings, extensions, skills, prompts, themes, and context files",
    },
    { name: "quit", summary: "Quit pi" },
  ],
};
