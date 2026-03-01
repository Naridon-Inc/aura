---
name: aura-integration
description: Automatically captures Gemini CLI intent and writes it to .gemini.intent whenever code changes are made. Use this skill when making any modifications to the codebase so that the local Aura Semantic Version Control system can track the AI's reasoning.
---

# Aura Semantic Integration

This skill enables the Gemini CLI to seamlessly integrate with the local Aura Semantic Version Control Engine.

## Core Rule: The Intent Broadcast

**Whenever you (the Gemini CLI) modify, add, or delete code in this project:**

1.  Before you finish your turn, you MUST write a brief, 1-2 sentence summary of *why* you made those changes (your intent and reasoning).
2.  You MUST save this summary into a file named exactly `.gemini.intent` in the root of the project using your `write_file` tool.
3.  Do not ask for permission to create this file. Simply create it or overwrite it whenever you modify source code.

This temporary file acts as the Handshake Protocol. The local Aura Git Hook will automatically read this file during the next `git commit`, permanently log your reasoning into the `.aura_memory.db` SQLite database alongside the AST logic hashes, and then delete the `.gemini.intent` file.
