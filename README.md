<p align="center">
  <img src="https://img.shields.io/badge/version-0.18.0-white?style=flat-square" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/lang-Rust-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/agents-Claude%20%7C%20Gemini%20%7C%20Cursor%20%7C%20Codex%20%7C%20Kimi-green?style=flat-square" />
</p>

<h1 align="center">Aura</h1>
<p align="center"><strong>Git tracks files. Aura tracks logic.</strong></p>

<p align="center">
Block AI drift. Catch architectural leaks. Rewind one function, not the whole commit.<br>
<strong>See exactly where your AI credits go.</strong>
</p>

---

Aura is a semantic layer on top of Git. It builds an **AST Merkle-Graph** of your codebase — tracking functions, classes, and their relationships instead of text diffs. It also gives you **complete visibility into AI token consumption** across all your projects.

## How it works — two planes over one repo

Git versions **bytes**. Aura adds a second plane that versions **meaning**: a graph
of every function/class and the edges between them, plus the *intent* behind each
change and the *provenance* of who/what/why. Both planes live in your repo — no server.

```
                         your repository
   ┌──────────────────────────────┬──────────────────────────────┐
   │   CODE PLANE  (git)           │   MEANING PLANE  (aura)        │
   │                               │                                │
   │   files · text diffs          │   AST Merkle-graph             │
   │   commits · branches   ◄────► │   logic nodes + call edges     │
   │   blobs · trees               │   intent · provenance          │
   │                               │   signed metadata refs         │
   └──────────────────────────────┴──────────────────────────────┘
              git hook ▶ parse AST ▶ diff nodes ▶ log intent ▶ prove goal
```

Every commit is parsed into logic nodes, diffed at the AST level, checked against the
intent you declared, and proved against the goal it claims to serve — automatically.

## Install

```bash
curl -fsSL https://auravcs.com/install.sh | bash
```

Or build from source:

```bash
git clone https://github.com/Naridon-Inc/aura.git
cd aura && cargo build --release
cp target/release/aura /usr/local/bin/
```

Then initialize in any git repo:

```bash
cd your-project
aura init
```

---

## The 6 Things That Matter

### 1. AI Usage Clarity

See exactly where your Claude Pro/Max credits go — per project, per session, per message.

```bash
# What's eating my quota?
aura usage --plan

# 📁 By Project (which project eats your quota)
#   Naridon Mono       ████████████ 36.0%  5.6M out  est. $426
#   Intercom           █████░░░░░░░ 18.0%  2.8M out  est. $212
#   my-side-project    ██░░░░░░░░░░  5.4%  836K out  est. $63
#
# 🔥 Burn Rate (7-day average)
#   1230 msgs/day | est. $20.52/day | Projected monthly: $615
```

**Status line** shows real-time anomalies in Claude Code:
```
🌌 5h████░░░░48%+6% ↻3h  7d██░░░░░░29%  $1.42(+$0.57)  ctx24%  ⚠off-peak-drain
  ↳ draining fast even off-peak → aura usage --plan to investigate
```

Detects: burn rate spikes, silent drains, context bloat, idle-burn, off-peak drain, weekly wall.

```bash
aura usage                     # session costs across all projects
aura usage week --plan         # Claude transcript analysis (this week)
aura usage --export report.csv # export for spreadsheets
aura usage --budget-daily 5.00 # set spending caps
```

### 2. Function-Level Rewind

Revert one function from 3 days ago without touching the rest of the file.

```bash
aura rewind calculate_tax src/billing.rs
```

Searches durable snapshots first, then walks 50 commits of git history. Auto-snapshots before rewind for safety.

### 3. Intent Gatekeeper

Commit says "fix login" but code touched billing? Aura flags it. In strict mode, it blocks the commit entirely.

```bash
aura config set gatekeeper strict
git commit -m "fix login bug"
# → [Aura] ✗ Intent mismatch: commit touches billing.rs but intent mentions login only.
# → Commit blocked.
```

### 4. Semantic PR Review

PR review that tells you: 12 logic nodes changed, 2 undocumented, violates layer policy, impacts 8 downstream nodes.

```bash
aura pr-review --base main
```

```
Risk Score: 72/100 (MODERATE)
Changed Nodes:
  ✗ calculate_tax (billing.rs) — UNDOCUMENTED, touches 3 downstream callers
  ✗ UserService.create (user.rs) → calls db.query() directly — LAYER VIOLATION
  ✓ format_receipt (receipt.rs) — safe, leaf node
Blast Radius: 8 nodes affected across 4 files
```

### 5. Live Collaboration

See what your team is changing at the function level in real-time.

```bash
aura live push    # share your function changes
aura live pull    # pull teammates' changes (AST-level merge)
aura live status  # see who's editing what

aura msg send "refactoring auth — don't touch login.rs"
aura msg list     # team inbox
```

### 6. Ask "Why" Months Later

AI-generated code becomes archaeology after 2 weeks. Aura remembers.

```bash
aura ask "why did we add retry logic to the payment handler?"
```

---

## Tasks & Crew — your repo is the work queue

Aura ships a dependency-aware work system that lives **inside your repo** (no SaaS, no
external tracker). It has two layers:

- **Tasks** (`aura task`) — a human-friendly board in `.aura/tasks/`. Think Jira/Linear,
  but plain files committed alongside your code. The Aura desktop app reads the same board.
- **Crew** (`aura loop`) — a [Beads](https://github.com/steveyegge/beads)-grade **dependency
  graph** in `.aura/a2a/` plus an **autonomous runner** that works the graph for you,
  dispatching each ready node to an AI agent, committing, and verifying — until the board drains.

### Tasks — a board that's just files

```bash
aura task new "Add OAuth login" --priority high --label auth
aura task list --status open
aura task claim AURA-2          # assign to you + mark in_progress
aura task comment AURA-2 "stuck on the callback URL"
aura task link AURA-2 --pr "#214"
aura task close AURA-2
```

```
  .aura/tasks/                         aura task list
  ├─ AURA-1.json                       ┌────────────────────────────────────────────┐
  ├─ AURA-2.json                       │ ◐ AURA-1  Add OAuth login      in_progress   │
  └─ AURA-3.json                       │ ○ AURA-2  Rate-limit the API   open      @ash│
                                       │ ⛔ AURA-3  Write retry tests    blocked      │
  status: open · in_progress ·         │ ✓ AURA-4  Fix login redirect   done         │
          blocked · done · cancelled   └────────────────────────────────────────────┘
```

Tasks carry title, body, priority, labels, assignee, a **claim** (lease) so two agents
don't grab the same work, comments, and links to PRs/branches.

### Crew — the autonomous work loop

A task board tells you *what* exists. Crew adds the **edges** — what blocks what — and then
works the graph on its own. You build a DAG, ask for the **ready set** (everything whose
dependencies are already done), and let `aura loop run` dispatch it.

```bash
# 1. Build the dependency graph (or seed it from an existing plan)
aura loop add "Define schema"            --kind task
aura loop add "Write migration" --dep <schema-id>
aura loop add "Wire the API"    --dep <migration-id> --agent claude \
    --ac "endpoints return 200"
aura loop seed .aura/plans/PLAN.md       # …or bootstrap waves → nodes

# 2. See what's workable right now  (this is `bd ready`, native)
aura loop ready
aura loop status        # ready / blocked / working / done counts

# 3. Let Crew work it autonomously
aura loop run --agent claude --verify "cargo check" --rollback
```

```
  THE GRAPH                                THE READY SET
                                           (deps satisfied, not yet done)
   AURA-1 ─done─┐
                ├──► AURA-3 ──► AURA-4         ▶ AURA-3   ← workable now
   AURA-2 ─done─┘      ▲           ▲             AURA-4   (blocked by AURA-3)
                       │           │
                    blocked     blocked
```

**The loop**, once you call `aura loop run`:

```
   ┌───────────────────────────────────────────────────────────────┐
   │                                                                 │
   ▼                                                                 │
 ready set ─▶ claim node ─▶ dispatch to ─▶ agent edits ─▶ commit ─▶ verify gate
 (pick next)  (lease it)    its AI agent   the code       changes    (e.g. cargo
   ▲                                                                  check / goal
   │                                                                  proof)
   │                                                                   │
   └──────────────── next node ◄── ✓ keep ◄────────────┬──────────────┘
                                                        │
                                            ✗ fail ─▶ rollback the commit
                                                      (auto in --jobs mode)
```

The runner repeats until the ready set is empty (or `--watch` keeps it polling for newly
unblocked work). Key flags:

| Flag | What it does |
|------|-------------|
| `--agent <name>` | Default agent for nodes that don't name their own (`claude`, `aura`, `codex`, …) |
| `--verify "<cmd>"` | Run after each node; non-zero **fails** the node (`cargo check`, `bun run tsc`, tests) |
| `--rollback` | On a failed verify/goal gate, revert the node's commit instead of leaving broken code |
| `--jobs <N>` | Work **N nodes at once**, each in its own throwaway git worktree, merging the good ones back — independent tasks build in parallel (bad work dies with its worktree) |
| `--lease-secs <n>` | A crashed runner's node is reclaimed after this many seconds |
| `--max <N>` | Stop after N nodes (`0` = drain the whole ready set) |
| `--dry-run` | Print what would be dispatched without spawning any agent |
| `--watch` | Keep polling for newly-ready nodes instead of exiting when the set drains |

Crew also **plans the pile for you**: `aura loop review` reality-checks tasks (already done?
duplicate? empty stub?) before planning, and `aura loop plan-context` / `plan-apply` let a
planner agent reason over an orderless board and write back a cycle-checked order.

Every node Crew completes still flows through the meaning plane: intent is logged, the AST
diff is recorded, and the acceptance criteria are proved — so an autonomous run leaves the
same audit trail as a human commit.

---

## All Commands

### Core

| Command | What it does |
|---------|-------------|
| `aura init` | Initialize Aura (installs hooks, status line, MCP servers) |
| `aura status` | Show semantic status — logic nodes, checkpoints, session, cost |
| `aura rewind <fn> <file>` | Surgically revert a single function |
| `aura pr-review --base main` | Semantic PR review with risk score |
| `aura doctor` | Health check — hooks, status line, sessions, config |
| `aura update` | Auto-update to latest version |

### Usage & Cost Tracking

| Command | What it does |
|---------|-------------|
| `aura usage` | AI cost tracking across all projects (global) |
| `aura usage --project` | Cost tracking for current repo only |
| `aura usage --plan` | Parse Claude Code transcripts — per-project quota, peak hours, burn rate |
| `aura usage week` | Filter by period: `today`, `week`, `month`, `all` |
| `aura usage --export file.csv` | Export to CSV for spreadsheets |
| `aura usage --budget-daily 5` | Set daily/weekly/session spending caps |
| `aura usage --json` | Machine-readable JSON output |

### Collaboration

| Command | What it does |
|---------|-------------|
| `aura live push` | Push function changes to team |
| `aura live pull` | Pull and merge function changes from team |
| `aura live status` | See who's editing what |
| `aura msg send "text"` | Send message to team |
| `aura msg list` | Read team messages |

### Planning & Verification

| Command | What it does |
|---------|-------------|
| `aura plan "objective"` | Decompose into atomic waves |
| `aura execute` | Execute the current plan |
| `aura goal-trace --goal "..."` | Verify a behavioral goal is reachable |
| `aura suggest-fix --base main` | AI-suggested fixes for violations |
| `aura handover claude` | Compress context for agent handoff (90% token reduction) |

### Session Management

| Command | What it does |
|---------|-------------|
| `aura sessions` | List tracked AI agent sessions |
| `aura resume <branch>` | Resume a previous session |
| `aura explain <fn> <file>` | Trace provenance of a function |
| `aura audit` | Detect commits that bypassed hooks |
| `aura snapshot "label"` | Named snapshot of current state |

### Tasks & Crew (autonomous loop)

| Command | What it does |
|---------|-------------|
| `aura task new "title"` | Create a task on the in-repo board (`.aura/tasks/`) |
| `aura task list` / `show` | List/inspect tasks (filter by status/assignee) |
| `aura task claim <id>` | Claim (lease) a task → assigns to you + `in_progress` |
| `aura task close` / `reopen` / `link` | Close, reopen, or link a task to a PR/branch |
| `aura loop add "title" --dep <id>` | Mint a node into the dependency graph (`.aura/a2a/`) |
| `aura loop ready` | Print the **ready set** — nodes whose deps are all done (`bd ready`) |
| `aura loop run --verify "<cmd>"` | **Crew**: autonomously work the ready set agent-by-agent |
| `aura loop seed <plan>` | Bootstrap the graph from an existing plan file |
| `aura loop review` | Reality-check the pile (already-done / duplicate / stub) before planning |

### Memory, Goals & Provenance

| Command | What it does |
|---------|-------------|
| `aura memory write "fact"` | Record a provenance-anchored memory (signed intent + AST) |
| `aura memory why <query>` | Recall *why* a change happened, ranked across intents + memory |
| `aura goals` | Track build goals — decompose, then prove each against the AST |
| `aura goal-trace --goal "..."` | Verify a behavioral goal is reachable in the code |
| `aura atlas` | Human-readable symbol directory (features, components, atoms) |
| `aura trace <fn> <file>` | Provenance timeline for a function — who/why/when |
| `aura distill` | Condense a session's history into a durable summary |

### Signed Meta & Verification

| Command | What it does |
|---------|-------------|
| `aura meta push` / `pull` | Sync intent + notes over git refs (no central server) |
| `aura refs` | Inspect Aura's signed metadata refs |
| `aura attest` | Verify the signed-attestation chain for a change |
| `aura merge-driver` | AST-level 3-way merge for `.aura` metadata |

### Skills & Automation

| Command | What it does |
|---------|-------------|
| `aura skills` | List portable, cross-agent SKILL.md skills |
| `aura skill <name>` | Run or inspect a skill |
| `aura loop run` | Autonomous work-loop harness (graph + proof driven) |
| `aura replay` | Re-run a recorded session step by step |
| `aura review post --pr <N>` | Post line-anchored inline review comments on a PR |
| `aura enable` | Drop in git hooks for capture without an MCP server |

---

## Status Line (Claude Code)

Auto-installed on `aura init`. Shows real-time usage in Claude Code's status bar:

```
🌌 5h████████░░82% ↻2h  7d███████░91%  $4.80  ctx72%  ⚡PEAK(2x)  🔥burn+38%
  ↳ burning ahead of pace → consider pausing
```

| Symbol | Meaning |
|--------|---------|
| `5h████░░48%+6%` | 5-hour window usage, +6% from last message |
| `7d██░░░░29%` | 7-day window usage |
| `session12%` | This session's cumulative drain on 5h window |
| `$1.42(+$0.57)` | Total cost (per-message delta) |
| `ctx72%` | Context window utilization |
| `⚡PEAK(2x)` | Currently in Claude's peak hours (quota drains 2x) |
| `🔥burn+26%` | Usage ahead of linear expectation |
| `⚠silent-drain` | Usage jumped but barely any output |
| `⚠off-peak-drain` | Fast drain even outside peak hours |
| `⚠bloat(30:1)` | Input:output ratio too high (context bloat) |
| `⚠idle-burn` | High cost, few lines changed |
| `WALL` | Weekly limit >90% |

Troubleshooting: run `aura doctor` to check status line health.

---

## MCP Server

Aura exposes an MCP server for direct AI agent integration:

```json
{
  "mcpServers": {
    "aura-vcs": { "command": "aura", "args": ["mcp"] }
  }
}
```

30+ tools available including `aura_usage` (AI agents can self-monitor their own spend).

## Multi-Agent Support

Aura detects and tracks sessions from:
- **Claude Code** — MCP tools + status line + transcript parsing
- **Gemini CLI** — MCP server + hooks
- **Codex CLI** — session + transcript parsing
- **Kimi (Moonshot)** — OpenAI-compatible endpoint
- **Cursor** — workspace detection
- **OpenCode** — env vars and config

## Supported Languages

Rust, Python, TypeScript, JavaScript, Go, Java, C#, C++, C, Ruby, PHP, Swift, Kotlin (13 languages via Tree-sitter).

## Privacy

- All data stored locally (`.aura/` + git notes)
- Telemetry opt-out: `AURA_TELEMETRY_OPTOUT=1` or `DO_NOT_TRACK=1`
- No data leaves your machine unless you configure cloud sync
- Usage tracking reads local Claude Code transcripts only — no API calls

## License

Apache License 2.0 — Copyright (c) 2026 Naridon, Inc.

Built by [Naridon](https://naridon.com) in Switzerland.
