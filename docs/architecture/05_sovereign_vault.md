# The Sovereign Vault & Zero-Trust RBAC

## The Problem with Cloud RAG
Competitors (like Entire.io) require enterprises to upload their raw, unredacted, proprietary chat transcripts and source code to centralized SaaS servers to generate vector embeddings. For regulated industries (Banking, Healthcare, Defense), this is a fatal security violation.

## Local Sovereign Execution
Aura is a Sovereign Enclave. 
1. **Redaction:** Before intent is ever processed, Aura uses Shannon Entropy mathematics to identify and scrub high-entropy secrets (API keys, PII) locally.
2. **Embeddings:** The 768-dimensional neural vectors are generated via API, but the resulting RAG database is stored completely locally inside the `.git` folder.

## Zero-Trust Virtual Workspaces (The Stub Engine)
When enterprises hire external contractors, they want to provide a compiling codebase without leaking proprietary algorithms. 
Aura's `generate-stubs` engine solves this. 
1. It reads an `rbac.json` file.
2. It locates proprietary functions via AST.
3. Instead of blindly deleting them (which breaks statically typed languages like Rust or TS), it queries the local LLM to synthesize a **Type-Safe Semantic Mock**.
4. The contractor receives a repository that compiles and runs perfectly, while the real algorithms remain safely inside the company's internal "Sovereign Vault."
