# Aura Semantic PR Review Engine PRD

## 1. Product Vision
Aura PR Review transforms pull request review from reviewing lines of text to reviewing architectural decisions and semantic impact.

## 2. Problem Statement
AI agents generate 4k–50k LOC per session, non-linear code, cross-module changes, and silent side-effects. Current PR tools only show text diffs.

## 3. Core Product Principles
- Local-first by default
- Deterministic semantic output
- Human-in-the-loop

## 4. MVP Scope (v0.3 Target)
- AST diff vs base
- Logic node detection (Modified, Added, Deleted)
- Intent mismatch detection
- Blast radius traversal (Merkle-Graph outbound/inbound)
- Basic invariant engine (`production.aura.json`)
- CLI output only (`aura pr review --base main`)

## 5. Phase 2 & Enterprise
- GitHub Checks integration
- Cross-branch semantic detection
- Org-wide graph sync (Enterprise)
- Node-level RBAC (Enterprise)
