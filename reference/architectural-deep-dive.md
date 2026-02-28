# Architectural Deep Dive: Aura Resilience & Security

This document captures the rigorous engineering specifications for the "Seatbelt" layer of the Aura Semantic Engine, focusing on local security and asynchronous performance.

---

## 1. Neural Intent Redaction (The Semantic Scrubber)
**Objective:** Prevent PII (Personally Identifiable Information) and secrets from being exfiltrated to external Embedding APIs while preserving the semantic "shape" of the text.

### Implementation Details (src/redact.rs)
- **Deterministic Heuristics (Pass 1):**
    - Email Regex: `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}`
    - IPv4/IPv6 Regex: Standard network pattern matching.
    - Known Token Prefixes: `sk-`, `ghp_`, `xoxb-`, etc.
- **Information Theory Filter (Pass 2):**
    - **Shannon Entropy Calculation:** Calculate bits per character for every token.
    - **Threshold:** Tokens with entropy > 4.5 (mathematical indicator of cryptographic keys) are automatically replaced.
- **Replacement Strategy:**
    - Do not delete. Replace with category tokens (e.g., `[REDACTED_SECRET]`, `[REDACTED_IP]`) to maintain the grammatical structure for the embedding model.

### Tasks:
- [ ] Create `src/redact.rs` module.
- [ ] Implement Shannon Entropy calculator function.
- [ ] Integrate redactor into the `CaptureContext` flow before the `reqwest` call.

---

## 2. Asynchronous Neural Pipeline (Eventual Semantic Consistency)
**Objective:** Move the slow/unreliable cloud API dependency out of the critical path of the `git commit` hook to ensure 100% reliability and zero latency.

### Implementation Details (PubSub Model)
- **The Producer (Git Hook):**
    - The `pre-commit` hook stages the text intent immediately.
    - It creates a "Trigger File" in `.git/aura_queue/` named after the checkpoint UUID.
    - The hook exits instantly, allowing the Git commit to finish.
- **The Consumer (Background Daemon):**
    - The `aura daemon` uses a `tokio` thread to watch `.git/aura_queue/`.
    - When a trigger appears, it performs the Embedding API call.
- **The Neural Patching:**
    - Aura uses the `git2` crate to update the checkpoint JSON in the `aura/checkpoints/v1` branch with the new vector array.
- **Graceful Degradation:**
    - `aura ask` checks for the presence of the `intent_vector`.
    - If `null` (offline or pending), it falls back to the local `strsim` string similarity algorithm.

### Tasks:
- [ ] Create `.git/aura_queue/` directory during `aura enable`.
- [ ] Update `CaptureContext` to write trigger files instead of making blocking API calls.
- [ ] Implement the queue-watcher loop in `src/watcher.rs`.
- [ ] Implement the "Git Amend" logic in `src/checkpoint.rs` to patch existing JSON blobs with vectors.

---
*Status: Engineering Plan Finalized. Implementation Pending.*
