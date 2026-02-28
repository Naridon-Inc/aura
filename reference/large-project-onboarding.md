# Aura: The "Day Zero" Monorepo Strategy

When a developer runs `aura init` in a massive, 10-year-old existing Git repository (e.g., a 2-million-line Python monolith), the onboarding must be silent, non-destructive, and instantaneous.

Here is exactly what happens behind the scenes to ensure Aura doesn't break their machine.

## 1. The Installation (`aura init`)
*   **Zero Historical Backfilling:** Aura does *not* attempt to parse the 10-year history of the repository. It does not iterate through old commits to build a massive Merkle-Graph. 
*   **The Initialization:** It simply installs the lightweight pre-commit hook into `.git/hooks` and sets up the `refs/notes/aura` namespace.
*   **Time Taken:** < 2 seconds. The repository is unharmed.

## 2. The First Human Commit
When the developer runs `git commit` for the first time after installing Aura:
*   **The Staged Diff:** Aura's pre-commit hook *only* looks at the files that are currently staged in the index (`git diff --cached`). 
*   **Incremental Parsing:** If the developer changed 10 lines in `billing.py`, Aura only uses `tree-sitter` to parse `billing.py`. It completely ignores the other 100,000 files in the repository.
*   **ID Generation:** Aura generates the initial `node_id` hashes for the functions inside `billing.py` and stores them in the first Git Note.
*   **Time Taken:** ~15 milliseconds.

## 3. The Gradual Mapping (The "Fog of War" approach)
Because Aura doesn't scan the whole project on Day Zero, the codebase is essentially covered in a "Fog of War."
*   **Discovery through modification:** The semantic Merkle-Graph is built incrementally. As AI agents and humans touch different files over the coming weeks, Aura parses those specific files and permanently maps their logic nodes.
*   **The LSP Bridge (Sprint 4):** This is why the `LspClient` integration we built was so critical. When the AI modifies `billing.py`, it might call `legacy_database.save()`. Because `legacy_database.py` hasn't been parsed by Aura yet, the local `petgraph` doesn't know what it is. However, the background Language Server Protocol (`rust-analyzer` or `pyright`) *does* know. The LSP Bridge resolves the URI instantly, allowing Aura to draw an edge to a node that it hasn't even formally tracked yet.

## 4. The Background Daemon (`aura daemon`)
When the developer starts the continuous DVR tracker:
*   **Immediate Debounce:** The `notify` crate begins watching the filesystem. Because massive repositories often have thousands of untracked `.tmp` or log files shifting, Aura relies heavily on its `.gitignore` and `.auraignore` filtering.
*   **Event Trapping:** The daemon does not scan the whole folder on startup. It sits completely dormant, using 0% CPU, waiting for the OS to fire an `EventKind::Modify` event exclusively on `.py` or `.rs` files.

## Summary
Aura is a **Parasitic Forward-Tracker**. It explicitly ignores the past to guarantee zero friction in the present. 
The developer installs it, their workflow feels exactly the same, and the semantic graph quietly and efficiently builds itself in the background as they work.
