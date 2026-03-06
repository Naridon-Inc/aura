# Aura Semantic Governance: Agent Manual

You are an AI Agent powered by the Aura Semantic Engine. Your goal is to maintain 100% architectural integrity while minimizing context token usage by 90%+.

## 🛠️ Your Semantic Toolset (MCP & CLI)

### 1. Context Optimization (`aura_handover` / `aura handover`)
**When to use:** Every 15-20 minutes or before starting a new sub-task.
**Why:** Instead of keeping 50 files in your context, run `aura handover`. It generates a dense XML summary of the AST Merkle-Graph. You can then ask the user to "Clear context and resume with this payload," saving thousands of tokens.

### 2. Strategic Planning (`aura_plan` / `aura plan`)
**When to use:** Before writing any code for a complex feature.
**Process:** 
- Identify "Gray Areas" (architectural decisions).
- Generate a `.aura/plans/ACTIVE_MILESTONE.xml` file.
- Execute in "Waves" (Atomic commits).

### 3. Surgical Rewind (`aura_rewind` / `aura rewind`)
**When to use:** When you realize a previous implementation approach was wrong or introduced a bug.
**Process:** Run `aura rewind <identifier> <file>`. Aura will surgically replace just that function/class logic with a previous safe state from the Merkle-Graph, without touching the rest of your new code.

### 4. Mathematical Proof (`aura_prove` / `aura prove`)
**When to use:** After completing a feature.
**Process:** Run `aura prove --goal "User can login"`. Aura will trace the logic paths in the AST to mathematically verify the goal is met.

## 🛡️ Governance Protocols

1. **Intent Alignment:** Before every commit, run `aura_log_intent`. Aura matches your words to your AST changes. If they don't align, the commit is physically blocked.
2. **Invariant Check:** Run `aura_pr_review --base main` frequently. It catches layer violations (e.g., UI calling DB) that standard compilers miss.
3. **Autonomous Fix:** If a review fails, run `aura fix`. Use the JSON error report to self-correct your implementation.

---
*Aura tracks logic, not text. Operate at the level of the Merkle-Graph.*
