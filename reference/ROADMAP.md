# Aura: Roadmap to 11/10 (The AGI Era)

While the core Aura engine is feature-complete and successfully leapfrogs current $60M industry standards by implementing AST parsing, continuous DVR tracking, Git-native checkpointing, and agent handover protocols, the following architectural upgrades will solidify it as the definitive 11/10 infrastructure for Artificial General Intelligence (AGI).

## 1. True Vector Embeddings (Deep Semantic RAG)
**Current State:** Aura uses `strsim` (Jaro-Winkler) for basic text similarity scoring when running `aura ask`.
**The 11/10 Vision:** Integrate a local ML framework (like Hugging Face's `candle` crate) to run a quantized embedding model (e.g., `all-MiniLM-L6-v2`) entirely on the CPU.
*   **Why:** This allows for deep semantic retrieval. Instead of matching words, an agent can query: *"What is the architectural reasoning behind our database connection pooling?"* and Aura will mathematically map the concept to a checkpoint from 6 months ago.
*   **Storage:** We will embed a local vector store (like `qdrant-rs` or `hnswlib`) directly into the `.git/aura_vectors` directory.

## 2. Logic Merkle-Graph (Full `petgraph` Visualization)
**Current State:** The parser successfully extracts `dependencies` (function calls), and they are staged in the XML payload.
**The 11/10 Vision:** Fully utilize the `petgraph` crate to build a living, queryable Directed Acyclic Graph.
*   **Why:** If Agent A modifies a core database schema, Aura should instantly traverse the graph and proactively flag Agent B (working on the frontend) that its props are now "Tainted."
*   **Actionable:** Add an `aura map` command that outputs a visual DOT graph in the terminal, showing exactly how reasoning in one module physically impacts dependencies in another.

## 3. Cross-Repo Reasoning (The Global Brain)
**Current State:** Aura tracks context perfectly within a single Git repository.
**The 11/10 Vision:** Expand the engine to understand intent across multiple microservices.
*   **Why:** In the real world, an API change in `backend-repo` breaks the `frontend-repo`.
*   **Actionable:** Build a peer-to-peer syncing protocol where multiple Aura Git Hooks across different repositories can gossip with each other. If an agent working on the frontend encounters an error, it can query the Global Brain and see the intent of the agent that just modified the backend API.

---

# The Final Master Plan: Ecosystem Dominance
To make Aura the undisputed choice for any engineering team and transition it from a powerful engine to the global standard, the following four pillars must be implemented:

## 1. MCP Native Protocol (The Source of Truth)
Transition from "scraping" other tools (forensics) to becoming the Standard API. By exposing Aura as an **MCP (Model Context Protocol) Server**, agents will natively report their intent to Aura, making it the definitive, proactive Source of Truth for reasoning.

## 2. GitHub-Powered Team Dashboard (Zero-Trust Collaboration)
Leverage Aura's Git-native storage (`aura/checkpoints/v1`). Build a React/Next.js UI that aggregates these branches directly from a remote GitHub repository via their API. This gives teams the "Entire.io" web collaboration features with 100% data privacy (zero external databases).

## 3. Hybrid Rewind Engine (Scalpel + Sledgehammer)
Add an `aura snapshot` command to complement the surgical `aura rewind`. This gives users the best of both worlds: Entire's project-wide branch snapshots (the sledgehammer) and Aura's function-level AST precision (the scalpel).

## 4. Global Knowledge Graph (Distributed Tracing)
Expand the logic graph to link across different microservices using Dependency URIs. Allow teams to trace AI intent through a distributed system, linking a frontend function directly to the backend API agent that modified it.

---
*This document serves as the true north for the continued evolution of the Aura Semantic Engine.*
