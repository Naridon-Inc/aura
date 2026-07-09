# v0.19.21 — Full monorepo: the desktop app & extension join the CLI

This cut brings the **entire project into one open-source repository**. Alongside the
`aura` CLI and the vendored engine crates, the tree now includes the **Aura desktop app**
— the Agentic Development Environment, under `desktop/` — and the **VS Code extension**
under `extensions/vscode`. Everything builds from one place. No breaking changes to the
command surface.

## Added
- **The desktop app is now in-tree.** The native Agentic Development Environment
  (`desktop/`, Tauri 2 + React 19 + Rust) — a multi-agent workspace with a Crew board,
  semantic review, function-level rewind, and a project timeline — ships in this
  repository and builds from source. Signed binaries: [auravcs.com](https://auravcs.com).
- **VS Code extension** (`extensions/vscode`) joins the tree, and the **full engine crate
  set** now lives in the same Cargo workspace (`desktop/src-tauri` included).

## Changed
- **Engine crates refreshed.** The vendored `crates/` — toon, merge, agents,
  attestation, plugin-sign, blocks, blockstore, loop, policy, ci, redact,
  prdiff — are brought up to the 0.19.21 line, tracking the semantic-CI,
  work-loop and policy improvements developed upstream.
- **Round-trip `.aura/settings.toml`.** Per-repo settings reads/writes now
  preserve comments, key order and unrelated tables on save (`toml_edit`).

## Security
- **No credentials in the source tree.** Every API / OAuth / telemetry key is
  read from the environment at runtime (with an empty/`None` fallback); the real
  values are injected only into the official builds we compile and distribute,
  never committed here. Public verification material (e.g. update-signing
  *public* keys) remains public by design.

**Full Changelog**: https://github.com/Naridon-Inc/aura/compare/v0.18.0...v0.19.21

---

# v0.18.0 — Provenance, awareness & the autonomous work loop

The largest `aura` CLI release since v0.15.1. It turns Aura from a semantic VCS
into a **provenance, awareness, and autonomy layer** that sits under any coding
agent: every change carries *why* it happened, *who* (human or agent) made it,
and *whether it still serves the goal* — and a fleet of agents can now run a
real work loop against that substrate.

This release also **re-unifies the CLI version with the Aura desktop app** (both
now on the 0.18 line) and **modularizes the engine into focused crates** vendored
under `crates/` (toon, merge, agents, attestation, plugin-sign, blocks,
blockstore, loop, policy, ci, redact, prdiff).

---

## Features

### Zero-MCP capture & the Team Radar awareness plane
Capture and awareness now work in **plain Claude Code / any agent CLI** — no MCP
server required.

- **`aura enable` / `aura disable`** — drops in (or removes) the git hooks that
  capture intent, snapshots, and provenance on every commit. Idempotent, reversible.
- **`aura radar`** — the live awareness plane. `radar wire` installs a PreToolUse
  hook so editing events emit automatically as agents work; `radar status`
  verifies both legs (git-hook `committed` events + edit events); `radar emit`
  announces explicit intent. Events are **signed metadata, never code bytes**, and
  are secret/PII-scrubbed before they leave your machine.
- **`aura identity`** — resolves the per-repo human/agent identity behind events.

### The autonomous work loop
A native DAG-driven work loop for running agents to completion against a plan.

- **`aura loop`** — computes the ready-set from a task DAG and drives it.
- **`aura loop run --jobs N`** — runs N agents in parallel, each in its own git
  worktree, behind an **acceptance gate**: work that fails the gate is rolled back
  automatically instead of landing broken.
- **`aura loop review`** + attach-targets — review and steer the loop's output.

### Goal alignment — every build stays provably tied to its goal
- **`aura goals`** — a durable, git-tracked goal ledger (`.aura/goals.jsonl`).
  Decompose a goal once; prove-on-build verifies delivery at the AST level (free,
  no AI key); a post-commit hook re-proves dynamically and stamps which
  commit/files delivered which goal.
- **`aura prove --json`** — machine-readable goal/behavior verification for CI
  and agents.

### Provenance-anchored, code-grounded memory
- **`aura memory`** — recall ranks results with **RRF over BM25 + embeddings +
  recency**; entries are provenance-bound and verified at read time; writes
  reconcile against existing memory; decay follows an Ebbinghaus × SM-2 curve.
- **`aura memory why`** — explains *why* a memory exists, traced to the change
  that created it.

### Provenance plumbing (the two-plane substrate)
Code lives in git; **meaning travels as signed metadata** alongside it.

- **`aura meta push` / `pull` / `log`** — sync the intent log as git notes, so a
  change's "why" follows the commit across machines and forks.
- **`aura refs sign` / `verify` / `push` / `pull`** — signed semantic refs.
- **`aura merge-driver`** — an AST-aware 3-way merge driver (semantic, not line, merge).
- **`aura distill`**, **`aura change-note`**, **`aura attest`** — distilled change
  summaries, structured change notes, and cross-machine seal verification.

### Reviews, CI & cross-agent continuity
- **`aura review`** — posts **line-anchored inline comments** on GitHub PRs
  (anchored via AST node start-lines, validated against the diff index), with
  role-driven reviewer/fixer selection and humanized findings.
- **`aura ci run / list / status / export`** — local declarative pipelines over
  `.aura/pipelines`.
- **`aura carryover` + `aura resume`** — hand a session from one agent CLI to
  another (Claude / Codex / Kimi readers), with secret redaction on the way out.
- **`aura usage`** — per-developer token attribution.

---

## Upgrade notes
- Backward-compatible with v0.15.x repos. New surfaces (`enable`, `radar`,
  `loop`, `goals`, `memory`, `meta`, `refs`, `ci`) are additive.
- Turn on capture in an existing repo: `aura enable`. Add awareness in an agent
  CLI: `aura radar wire`.

## Binaries
- `aura-darwin-arm64` — macOS Apple Silicon
- `aura-darwin-amd64` — macOS Intel
- `aura-linux-arm64` — Linux ARM64
- `aura-linux-amd64` — Linux x86_64

**Full Changelog**: https://github.com/Naridon-Inc/aura/compare/v0.15.1...v0.18.0
