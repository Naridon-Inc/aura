<p align="center">
  <img src="https://img.shields.io/badge/version-0.10.1-white?style=flat-square" />
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/lang-Rust-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%2B%20Gemini%20CLI-green?style=flat-square" />
</p>

<h1 align="center">Aura</h1>
<p align="center"><strong>Git tracks files. Aura tracks logic.</strong></p>

<p align="center">
Block AI drift. Catch architectural leaks. Rewind one function, not the whole commit.<br>
<strong>See exactly where your AI credits go.</strong>
</p>

---

Aura is a semantic layer on top of Git. It builds an **AST Merkle-Graph** of your codebase — tracking functions, classes, and their relationships instead of text diffs. It also gives you **complete visibility into AI token consumption** across all your projects.

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
