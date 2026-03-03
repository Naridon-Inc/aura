# Comparison: Aura vs Entire

| Feature | Aura (Current Project) | Entire (Reference) |
| :--- | :--- | :--- |
| **Primary Goal** | AI-Native Semantic Version Control (Local Brain). | Capturing AI agent sessions & unifying with code. |
| **Logic Capture** | **Semantic AST Logic** (tree-sitter hashes of functions/classes). | **Session-based** (transcripts, prompts, token usage). |
| **Context Storage** | Git branch (`aura/checkpoints/v1`) with JSON. | Git branch (`entire/checkpoints/v1`) with JSON/markdown. |
| **Integration** | Scrapes Aider, Gemini CLI, and **Cursor SQLite DB**. | Native support for Claude Code, Gemini, OpenCode. |
| **Git Integration** | Pre-commit, commit-msg, post-commit hooks. | Pre-commit hooks + shadow branches for rewind. |
| **Developer UX** | `aura ask` to query the semantic brain. | `entire explain`, `entire rewind`, `entire status`. |
| **Persistence** | Git-native storage (Local or Shared). | Git-native, shared context across team via push. |

### Key Architectural Differences

1. **Granularity**: Aura tracks *individual semantic nodes* (functions/classes) and how they change using Tree-Sitter logic hashes. Entire tracks *entire sessions* and checkpoints.
2. **Forensics**: Aura has "forensic" capabilities (e.g., scraping Cursor's internal DB). Entire relies on detected process activity and native tool integrations.
3. **Unified Brain**: Aura aims to be a cross-agent "brain" that unifies reasoning from multiple tools (Aider, Gemini, Cursor) into a single semantic timeline.
