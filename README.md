<div align="center">

# 🌌 Aura
**The Semantic Time Machine for AI-Generated Code.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Website](https://img.shields.io/badge/Website-auravcs.com-10b981)](https://auravcs.com)

**Git tracks text lines. Aura tracks mathematical logic.** <br>
*Built in Rust for native integration with Cursor, Claude Code, and Aider.*

</div>

---

## 🛑 The Problem: AI Writes Faster Than You Can Review

When you type code, you think linearly. You write a function, test it, and commit it.
When an AI (like Cursor or Claude) writes code, it operates non-linearly. It will refactor a database schema, update three API routes, and change the frontend state across 8 files in 14 seconds. 

By the time you realize the AI hallucinated on minute 12 of a 15-minute generation streak, it has already woven 4,000 lines of interdependent logic on top of the error. If you try to `git revert`, you get a massive merge conflict. If you close the IDE tab, the AI's contextual reasoning is lost forever.

## ⚡ The Solution: A Physics Engine for Code

Aura is a **Parasitic Gatekeeper** that runs silently on top of standard Git. 

Instead of tracking files using text diffs, Aura compiles your codebase into an **Abstract Syntax Tree (AST)** locally. It assigns an immutable cryptographic UUID to every function and class. 

When an AI agent modifies your code, Aura intercepts the save, extracts the AI's natural language intent, scrubs it for secrets, generates a neural embedding, and attaches the entire semantic history invisibly to your `git commit` using **Git Notes**.

---

## 🚀 The "Ah-Ha" Workflow (The Semantic Time Machine)

### 1. Ask the Brain
When production breaks and you don't know why the AI wrote a specific block of code two months ago, you don't read PR descriptions. You ask the mathematical graph:

```bash
$ aura ask "Why did we switch to exponential backoff here?"

> 🤖 Intent Found: "Claude-3.5 refactored retry_logic to use exponential backoff to comply with AWS Cognito rate limits."
> 📍 Node ID: fn_retry_logic (Hash: 8f42a1)
```

### 2. The Surgical Rewind
Standard `git revert` breaks files. Aura swaps AST bytes. You can revert a single function to its state from 3 months ago without touching the 4,000 lines of valid code the AI wrote around it.

```bash
$ aura rewind retry_logic
> ✓ Surgically replaced AST node. Zero merge conflicts.
```

### 3. Native GSD (GetShitDone) Orchestration
To prevent "Context Rot" (where an AI gets confused during a massive task), Aura forces the LLM to behave like a disciplined engineer with an **interactive planning workflow**.

```bash
$ aura plan "Build a new Stripe billing module"
> 📋 Configuring Milestone...
> ? Run plans in parallel? (Parallel/Sequential) [Parallel]
> ? Git tracking strategy? (Single/Atomic) [Atomic Commits]
> ✓ Synthesized 3 atomic XML execution plans.

$ aura execute
> 🌊 Wave 1: Executing Plan 1 in isolated context...
> 🛡️ Gatekeeper: Verified AST safety.
> ✓ Auto-committed micro-state (Checkpoint: 6af8d339).
```

---

## 🆕 What's New in v0.2.0-alpha (The "Amnesia" Release)

This release transforms Aura from a backend security prototype into a full-stack, AI-native infrastructure.

- **🧠 Aura Amnesia Protocol**: The `aura rewind --amnesia` flag now surgically reverts code AND injects a System Override into AI chat logs, instantly breaking hallucination loops.
- **🌐 Full-Stack Logic Engine**: Added native `tree-sitter` support for **TypeScript (.ts/.tsx)** and **JavaScript (.js/.jsx)**. Intent checking and surgical rewinds now work across the entire stack.
- **📋 Human-Readable Roadmaps**: `aura plan` now generates a detailed `PLAN.md` for human review alongside the machine-readable XML waves.
- **🔍 Semantic Status**: New `aura status` command provides instant visibility into Merkle-Graph metrics and security configurations.
- **⚙️ Agent-Native Config**: Automate setup with `aura config set <key> <value>`, bypassing interactive TTY menus.
- **⚡ Lightweight Dev Mode**: `aura secure-init --dev` allows solo developers to skip complex multi-sig protocols for local prototyping.

---

## 🛠️ Installation & Configuration (AI-Native DX)

Aura is distributed as a standalone, pre-compiled Rust binary. It does not require Node.js or Python.

```bash
curl -fsSL https://auravcs.com/install.sh | bash
```

Inside any existing Git repository, simply run:
```bash
aura init
```

### ⚙️ Autonomous Configuration
Aura is built for both humans and AI agents. You can configure it interactively via `aura config` or non-interactively using:
```bash
# For solo developers: Bypass heavy enterprise protocols
aura config set dev-mode true
aura secure-init --dev

# For security: Enable strict architectural enforcement
aura config set strict-mode true
```
*Aura hooks into your Git workflow instantly. You just `git commit` exactly as you always have. Aura handles the math.*

---

## 🏢 Enterprise: The Sovereign Vault

Competitors (like Entire.io) require you to upload your raw, unredacted, proprietary chat transcripts to their cloud SaaS to generate vector embeddings.

Aura is a **Sovereign Enclave**.
1. **Local Privacy:** Shannon Entropy algorithms scrub API keys locally. Vector embeddings are generated and stored completely inside your local `.git` folder.
2. **Zero-Trust Dashboards:** The `aura dashboard` command spins up a gorgeous React application locally, ensuring your proprietary AI training data never touches an external database.
3. **Agentic RBAC:** Need to hire a contractor? `aura generate-stubs` uses local LLMs to replace your proprietary algorithms with compiler-safe mock data, allowing contractors to work safely on GitHub without seeing your IP.

---

## 📜 License & Telemetry

Aura Core is released under the permissive **Apache 2.0 License**. 

Aura explicitly **fails open**. If you ask it to parse a 100,000-line minified file and it exceeds its 50ms performance budget, Aura aborts the semantic tracking and allows the human Git commit to proceed. It will never block a panicked developer trying to ship a hotfix. 

**Code is just the medium. Logic is the asset.** <br>
Welcome to the Agentic Era.
