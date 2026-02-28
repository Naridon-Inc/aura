# Aura Integrations

This directory contains integrations and extensions that connect the Aura Semantic VCS with various development environments and AI agents.

## 📂 Contents

### 1. Cursor / VS Code Extension (`cursor-extension/`)
A native IDE plugin that captures developer intent at the moment of code modification.
*   **Features**: Auto-prompt on save, manual intent logging via Command Palette.
*   **Installation**: See [cursor-extension/README.md](./cursor-extension/README.md).

### 2. Gemini CLI Skill (`aura-integration/`)
A skill definition for the Gemini CLI agent.
*   **Purpose**: Allows the Gemini AI to automatically log its reasoning to `.gemini.intent` whenever it modifies code.
*   **Mechanism**: The local Aura Git hook reads this file during commit to bind AI intent to the AST changes.
*   **Usage**: Place this skill in your agent's skill directory or load it dynamically.

---

## 🤝 Contributing

To add a new integration (e.g., for IntelliJ, Neovim, or another AI agent):
1.  Create a new subdirectory.
2.  Implement the logic to capture intent.
3.  Send the intent to the Aura Core via the CLI (`aura capture`) or the local MCP server.
