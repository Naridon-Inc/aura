# Native GSD Orchestration (Wave Execution)

## Solving Context Rot
When an LLM is given a massive task ("Build a new billing system"), its 200k token context window fills with irrelevant files, leading to degraded performance, hallucinations, and "lazy" code generation.

Aura solves this by integrating the **GetShitDone (GSD)** methodology natively into the Rust engine.

## The Workflow (`aura plan` & `aura execute`)

### 1. The Orchestrator
When a developer runs `aura plan "Build a billing system"`, Aura does not write code. It acts as an orchestrator, querying the Gemini API to synthesize the massive request into exactly 3 atomic, highly constrained XML plans.

### 2. The Wave Runner
When the developer runs `aura execute`, Aura acts as the executor:
1. It spins up a fresh, completely isolated LLM context window.
2. It feeds the LLM **only** Plan 1 and the specific files required.
3. The LLM generates a `.patch` file.
4. Aura parses the AST, checks the Gatekeeper constraints, and commits the change.
5. Aura clears the AI's memory entirely, and spins up a new fresh window for Plan 2.

By forcing the AI to behave like a disciplined engineer executing sequential Jira tickets in fresh contexts, Aura guarantees high-quality, hallucination-free code generation.
