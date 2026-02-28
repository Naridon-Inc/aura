# Aura: The Operational Trust Manifesto

This document codifies the final psychological and operational boundary of Aura. It acknowledges that the true moat of this technology is not the AST engine or the RAG database, but **operational trust under stress**.

## 1. The UX of `aura doctor` (Emotional Safety)
Aura will never act like a scolding linter. When the system detects a misconfiguration (e.g., CI stripping Git notes), it must frame the warning as a protective measure, not a user failure.

*   **The Law of Tone:** Warnings must be actionable, calm, and explicitly state *why* the fix helps the user.
*   **Example Output:**
    ```text
    ℹ️  Aura: History Sync Paused
    Hey! We noticed your Git notes aren't syncing to the remote. 
    Fixing this ensures your team doesn't lose the AI history you just generated.
    Run `aura doctor --fix` and we'll handle it for you.
    ```

## 2. Ancestral Archaeology (Epoch Consolidation)
When `aura gc` flattens deep derivation chains (A -> B -> C -> D) to maintain performance, it must not destroy the history.
*   **The Law of Compression:** The intermediate nodes are mathematically squashed, but the *metadata* (the RAG intents, the timestamps) is archived into an `ancestry_trail` array within the new canonical node `D`.
*   **The UI Implication:** The dashboard defaults to showing `D` for speed. But an auditor can click `[View Ancestry]` to expand the compressed timeline and read the 6-month evolutionary history of that specific logic block.

## 3. The 50ms Telemetry Pipeline
Failing open (aborting the hook if parsing exceeds 50ms) is mandatory to protect the developer's workflow. But Aura cannot be blind to its own failures.
*   **The Law of Silent Learning:** When a parse is skipped, Aura logs the `file_path`, `byte_size`, and `agent_id` to a local SQLite telemetry table (`.git/aura_telemetry.db`). 
*   **Auto-Ignore:** If Aura detects that `src/generated/schema.ts` triggers the timeout 3 times in a row, it automatically appends that file to the `.auraignore` file, silently optimizing itself without bothering the developer.

## 4. The Merciless Wedge
We will ruthlessly hide complexity. 
*   **The Law of Invisibility:** When a user runs `aura init`, there will be no mention of "Gatekeepers," "Sovereign Vaults," or "RBAC." There will be no massive `aura.config.json` generated in their root directory. 
*   **The Core Loop:** Aura exists purely to answer `aura ask` and execute `aura rewind`. The Enterprise features are architecturally present in the binary but remain completely dark and inaccessible until an organization explicitly activates an Enterprise license key. Aura must feel like a boring, reliable utility—until the moment it saves a developer 4 hours of debugging.

## Conclusion: The True Moat
Anyone can build an AST parser or a vector database. The defensibility of Aura lies in its **Epistemic Honesty**. 

It is the only tool that explicitly models uncertainty (`[HEURISTIC_SCRAPE]`). It is the only tool that fails open to protect human panic moments. It never rewrites code silently. It is designed, from the ground up, to be the most dependable piece of infrastructure in the Agentic Era.
