<div align="center">

# 🌌 Aura
**Aura = function-level history + why-layer, stored in git, MCP-first.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Website](https://img.shields.io/badge/Website-auravcs.com-10b981)](https://auravcs.com)

**Git tracks text lines. Aura tracks mathematical logic.** <br>
*Built in Rust for native integration with Cursor, Claude Code, and Aider.*

</div>

---

## 🛑 The Wedge: Why Aura exists

Standard Git tracks characters. When an AI (like Cursor or Claude) hallucinates a 4,000 line refactor across 8 files, `git revert` gives you an unresolvable wall of red and green conflicts.

Aura acts as a **parasitic meta-layer** on top of Git. It parses your code into an Abstract Syntax Tree (AST) locally. It maps the *logic* (functions, classes) instead of the *text*.

If your AI breaks a function, Aura allows you to surgically rewind just that exact AST node without breaking the rest of the generated code around it.

**Used by Naridon in production on an 80,000 LOC monorepo.**

---

## 🚀 The First 90 Seconds

**1. Initialize Aura**
Hook Aura into your existing Git repo. You keep your existing workflow; Aura just runs in the background.
```bash
$ aura init
> ✓ Hooks installed (Aura is now parasitic to Git)
```

**2. Track Logic Automatically**
Start the background DVR to capture semantic snapshots while you (or your agents) vibe code.
```bash
$ aura daemon
> 👁️  Aura Daemon watching for AST changes...
```

**3. Ask & Rewind (The Semantic Scalpel)**
When production breaks, ask the Merkle-Graph why an agent wrote a specific block of code, then surgically revert the hallucination.
```bash
$ aura ask "Why did we switch to exponential backoff here?"
> 🤖 Intent Found: "Claude-3.5 refactored retry_logic to comply with AWS rate limits."

$ aura rewind retry_logic
> ✓ Surgically replaced AST node. Zero merge conflicts.
```

*(Optional: Use `aura rewind --amnesia retry_logic` to also wipe the hallucination from your agents local memory so it stops looping).*

---

## 🛠️ Installation

**Option 1: Quick Install (macOS / Linux)**
Downloads the pre-compiled binary from GitHub Releases.
```bash
curl -fsSL https://auravcs.com/install.sh | bash
```

**Option 2: Cargo Build (Fallback)**
If you have Rust installed, you can compile from source:
```bash
cargo install --git https://github.com/Naridon-Inc/aura.git
```

---

## 🗺️ Roadmap & Known Limitations

**Known Limitations:**
- Currently supports Rust, Python, JavaScript, and TypeScript via `tree-sitter`. (Go and Java support coming soon).
- Heavy Merkle-Graph extraction can cause slight delays (50-200ms) during massive `git commit` operations.
- The `aura arbitrate` auto-fixer currently relies on external APIs (Gemini/Claude/OpenAI) and requires an API key in `aura config`.

**What we are building next:**
- Native Homebrew tap (`brew install aura-vcs`)
- Native apt/deb repositories for Linux CIs.
- Deeper native MCP server hooks for local ollama models.

---

## 📦 Extended Features (Optional Modules)

### Native GSD (GetShitDone) Orchestration
To prevent "Context Rot" during massive agentic coding sessions, Aura includes a built-in orchestrator that forces LLMs into an interactive planning workflow.
```bash
$ aura plan "Build a new Stripe billing module"
> ✓ Synthesized 3 atomic XML execution plans.
```

### The Sovereign Vault (Enterprise)
Aura scrubs API keys locally using Shannon Entropy algorithms and stores vector embeddings directly inside your local `.git` folder, ensuring zero-trust privacy for proprietary code.

## 📜 License
Aura Core is released under the permissive **Apache 2.0 License**. 
