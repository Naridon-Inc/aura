# Aura Productization: Distribution & Onboarding

To transform Aura from an engineering prototype into a frictionless, adopted product, we are executing a dedicated Productization Sprint. The goal is zero-friction onboarding via an interactive CLI wizard and secure global credential management.

## 1. Global Credential Vault
*   **Goal:** Eliminate `.zshrc` or local `.env` dependencies. Store API keys securely across all repositories on a developer's machine.
*   **Implementation:** Introduce `src/config.rs`. This module will manage a centralized JSON vault at `~/.aura/credentials.json`.
*   **Mechanics:** Update the `generate_embedding` (RAG) and `resolve_conflict` (Arbitrator) functions to fall back to this vault if standard environment variables are not present.

## 2. Interactive `aura init` Wizard
*   **Goal:** Replace the silent, dumb `aura enable` command with a beautiful, guided setup experience.
*   **Implementation:** Add the `dialoguer` crate to provide interactive terminal prompts (Multi-selects, Password inputs).
*   **Workflow:**
    1. Prompt the user to select which AI agents they use (Cursor, Aider, Gemini).
    2. Prompt for an optional `GEMINI_API_KEY` to enable the Autonomous Arbitrator and Vector RAG.
    3. Save the key to the Global Vault.
    4. Install the Git-Native hooks.
    5. Spin up the background `aura daemon` automatically.

## 3. The Installation Script (Future Distribution)
*   **Goal:** The ultimate "One-Liner" install.
*   **Implementation:** Draft a standardized `install.sh` shell script that mimics the behavior of major developer tools (like rustup or nvm). It fetches the binary, places it in `/usr/local/bin`, and adds it to the PATH.

---
*Commencing implementation of `config.rs` and the `dialoguer` init wizard.*
