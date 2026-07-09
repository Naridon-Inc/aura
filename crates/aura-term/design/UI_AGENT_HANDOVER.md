# aura-term — UI handover brief

You are the UI/UX agent working on the Rust desktop application for Aura. This document is a standalone brief. You do not need prior context — read this top to bottom and start.

Scope rule: **you build screens, views, widgets, and interaction flows. You do not wire real services, real PTYs, real agents, or real filesystems. Everything is driven by mock fixtures.** When the design stabilizes, the widget files graduate into the real `aura-term` crate.

---

## 1. What Aura is

Aura is **audit-grade infrastructure for agent-assisted coding**. It is:

- A **semantic version control** layer (AST-level, rename-proof) on top of git.
- A **policy gate** — AI agents propose changes; changes are evaluated, attested, and either approved or blocked.
- A **multi-agent orchestrator** — Claude, Codex, Gemini etc. run in parallel/relay/wave modes with cost accounting and failover.
- A **team sync fabric** — live function-level sync across teammates, zone claims to prevent edit collisions, AI-to-AI messaging (sentinel), cross-branch impact alerts.
- A **workflow daemon** — Linear-backed PRD → workspace → worker → PR automation (called Symphony).

Thirty thousand lines of Rust already ship this. It exposes itself via a CLI (~110 commands) and an MCP server (40+ tools). No GUI until now.

**aura-term** is the first-class GUI client for all of this. It is:

- A **terminal emulator** (native alacritty-backed PTY renderer on iced + GPU).
- A **block surface** where every command you run becomes a `Block` — an envelope with state machine, policy decision, attestation, cost, and provenance.
- A **team chrome** — zone claims, sentinel messages, teammate cursors visible.

Positioning: *Warp with an audit trail and multi-agent orchestration.* Competitors include opencode, Warp, Cursor, Claude Code, GitHub Copilot Workspace. None have the full collaboration matrix (human↔human, human↔AI, AI↔AI, AI↔human).

Performance target: <50MB RAM idle, <150ms cold start, native 60fps rendering. Opencode hits 24GB with a local model bundled — we stay lean because agents run out of process.

---

## 2. Core vocabulary

You must internalize these terms — they show up in every screen.

| Term | Definition |
|---|---|
| **Workspace** | A project directory. Typically a git repo root. Has a name, path, short avatar letter, last-opened timestamp. Users open many workspaces over time. |
| **Session** | One coherent user intent from shell spawn to terminate. Binds: a PTY + a working directory + a sequence of blocks + an intent log. "Session" replaces "tab" in the UI. |
| **Block** | The atomic unit. An envelope describing one proposed or executed action — a shell command, an AI agent call, a file edit, a tool use. Has: id, kind, anchor (function/file/line), intent, declared_impacts, actual_impacts, payload, state, policy_decision, attestations, provenance, extensions. |
| **Block state** | A finite-state machine: `Proposed → Gated → Running → Completed/Failed/RolledBack/Suspended/Superseded`. Some states fork. Transitions are validated and attested. |
| **Intent** | The *why* of a block. Free text + structured fields. Compared against AST changes to detect "intent poisoning" (said X, did Y). |
| **Policy decision** | The gate's verdict. One of `Auto`, `Approved`, `Denied`, `Escalated`. Attached to the block envelope. Drives whether the block can advance from `Gated → Running`. |
| **Attestation** | Cryptographic signature on a block transition. Proves who/what/when. Chains across transitions. |
| **Zone** | An advisory claim on a set of files/functions. A teammate or agent claims a zone before editing; other parties see the claim and avoid it. Claims expire on release or timeout. |
| **Sentinel** | The AI-to-AI messaging layer. Agents on different machines (or the same machine) exchange structured messages — status, handoff, question, release. |
| **Agent** | An identity that authors blocks. Humans are agents (`did:aura:user/…`); AIs are agents (`did:aura:agent/claude-code/…`). Each has a color in the UI. |
| **Mothership** | The P2P live-sync backend. Teammates connect to a shared mothership; function bodies flow between machines in real time. |
| **Handover** | A compressed session snapshot (~5% of original tokens) for context transfer between sessions or agents. |
| **Orchestrate** | Multi-agent run mode. *Wave* = sequential assignments per phase. *Duo* = two agents in relay. *Symphony* = Linear-driven autonomous. |
| **MCP tool** | A capability exposed via Model Context Protocol JSON-RPC. Agents call tools; tools side-effect the Aura state. Examples: `aura_log_intent`, `aura_snapshot`, `aura_zone_claim`. |

When in doubt, read `aura-blocks/src/block.rs` (the envelope) and `aura-blocks/src/ops.rs` (the operations). Every other concept reduces to those two files.

---

## 3. UX shape — the macro states

The app has three major states. Every surface must render in all three.

### State A — Empty
No workspace opened. The user just launched the app or closed their last project.

- Workspace rail: only `+` (open project) and utility buttons (gear, help).
- Session sidebar: centered "No projects open" call-to-action.
- Content area: "aura" wordmark + status dot + recent projects list.
- Topbar: traffic lights + hamburger + avatar. No search.
- Ribbon: version + "no active session".

### State B — Active
A workspace is open, at least one session exists.

- Workspace rail: workspace avatars (letter in rounded square), active one has teal ring outline.
- Session sidebar: workspace header (name + path + menu), `New session` button, session list grouped into Active/Recent with state dots.
- Content area: terminal output, block cards inline, scroll indicator.
- Topbar: traffic + hamburger + search field + avatar.
- Ribbon: version + branch + zone count + test status + block count.

### State C — Collapsed
Session sidebar hidden (user toggled hamburger or on narrow windows).

- Workspace rail: same as State B.
- Session sidebar: hidden.
- Content area: expanded to fill.
- Other surfaces: unchanged.

Transitions between states must be instant — no animation in v1. Persist collapsed state to `~/.config/aura/ui_state.json`.

---

## 4. Design tokens (non-negotiable)

Copy from `aura-term/src/ui/theme.rs`. Summary:

```
Colors (dark only for v1)
  BG_0        #07080a   desktop canvas
  BG_1        #0d0f12   pane / topbar
  BG_2        #14171c   elevated card / menu
  BG_3        #1b1f26   hover on elevated
  LINE        #1f242b   strong divider
  LINE_SOFT   #16191f   soft divider (the ONE vertical between sidebar and content)
  TEXT_1      #e8ebf0   primary
  TEXT_2      #9aa2ae   secondary
  TEXT_3      #5f6773   tertiary (paths, timestamps)
  TEXT_4      #3a4049   disabled / faint (logo)
  ACCENT      #5fc9b0   Aura teal — the ONE brand color
  ACCENT_SOFT #1e3a34   accent bg
  GREEN       #4ade80   done / ready
  AMBER       #e8a340   running / attention
  RED         #ef6d6d   failed / denied
  VIOLET      #a78bfa   suspended

Type ramp (6 sizes, 6 jobs)
  SZ_DISPLAY  22px   section titles, welcome
  SZ_TITLE    17px   pane headers, workspace name
  SZ_BODY     14px   default UI text
  SZ_META     12px   timestamps, paths, badges
  SZ_MICRO    11px   kbd chips, tags

Spacing (4pt grid — no values outside this set)
  P_XS        4px
  P_SM        8px
  P_MD        12px
  P_LG        16px
  P_XL        24px

Chrome dims
  TOPBAR_H            52px
  RIBBON_H            32px
  WORKSPACE_RAIL_W    60px
  SESSION_SIDEBAR_W   296–460px (empty state wider, active narrower)
  MAC_TRAFFIC_LEFT    84px  (reserved for macOS traffic lights)
  CARD_RADIUS         12px  (window outer, and some widgets)

Agent colors
  Claude    #e86f3a  (orange)
  Codex     #6a8fab  (blue-gray)
  Gemini    #8f6fb8  (violet)
  Review    #5ba887  (green)
  Security  #d65656  (red)
  Built-in  #7e8ca0  (gray)
```

Never type raw hex or raw pixels in widget code. Always reference the token.

Visual rule: **only the window has a drawn outer border.** Inside the window there is exactly **one vertical divider** (`LINE_SOFT`, 1px) between the sidebar unit and the content area. No horizontal dividers. No card borders. No section seams. See `empty-state-mock-v5.html` for the reference design.

---

## 5. Surface inventory — what to build

### 5.1 Chrome (always visible)

#### Topbar (52px)
**Left section:** macOS traffic-light reserve (82px empty space), hamburger button (32px, rounded 6px, toggles session sidebar).

**Right section (empty state):** avatar only.

**Right section (active state):** search field (min-width 260px, placeholder "Search sessions, commands, blocks…", `⌘K` kbd chip, opens command palette) + avatar.

**Avatar:** 30px circle, `ACCENT` bg, first letter of user's name in `BG_0` text. Click → user menu (sign in, settings, sign out).

**Behavior:** No horizontal divider below the topbar. Background continues seamlessly into the content below.

#### Workspace rail (60px, full height)
Top cluster:
- `+` icon button (38px rounded square, opens project picker dialog) — always visible
- Workspace avatars (38px rounded square) — one per open workspace, stacked vertically
  - Active: teal ring outline (`outline: 1.5px ACCENT, outline-offset: 2px`), `ACCENT_SOFT` bg, `ACCENT` letter
  - Inactive: `BG_1` bg, `TEXT_2` letter; hover → `BG_2` + `TEXT_1`

Bottom cluster (anchored to bottom via `Length::Fill` spacer):
- Settings gear (32px rounded, `TEXT_4` default, `TEXT_1` on hover)
- Help `?` (same pattern)

**Empty state:** avatars cluster hidden, only `+` at top.

#### Session sidebar (296–460px, full height)
Widthrange: 296px in active state, wider (~460px) in empty state to match opencode proportions.

**Empty state content:** centered vertical stack
- Title "No projects open" (`SZ_TITLE`, `TEXT_1`, weight 500)
- Subtitle "Open a project to get started" (`SZ_BODY`, `TEXT_3`)
- "Open project" button (rounded 8px, `BG_1` bg, `LINE_SOFT` border, folder icon + label)

**Active state content:** top-to-bottom
1. Workspace header (16px padding)
   - Title (`SZ_TITLE`, `TEXT_1`, weight 500, letter-spacing -0.01em)
   - Path (`SZ_META`, mono, `TEXT_3`, 2px top margin)
   - `...` menu button (top-right, 28px, hover `BG_1`)
2. `New session` button (38px, rounded 9px, `LINE` border, edit icon + label)
3. Section labels: "ACTIVE · N" / "RECENT · N" (`SZ_MICRO`, `TEXT_4`, uppercase, letter-spacing 0.06em)
4. Session rows (see 5.2)
5. Optional: getting-started or status card at bottom (see 5.6)

**Collapse behavior:** hamburger toggles visibility. When collapsed, width is 0 and the vertical divider moves to the rail's right edge.

#### Ribbon (32px, full width, bottom)
Left cluster (empty state):
- Version pill "aura v0.12.6" (rounded 3px, `TEXT_3`, teal dot at left)
- Dot separator
- "no active session" text (`TEXT_4`)

Left cluster (active state):
- Version pill
- Current branch name
- Zone count "2 zones claimed"
- Right cluster (flex-end): "69 tests green", "3 blocks"

All ribbon text is `SZ_MICRO`, `TEXT_4`. Dividers are `·` characters at 40% opacity.

### 5.2 Session row

Rendered in the session sidebar. Represents one terminal session.

Layout (horizontal, 8–10px padding):
- State dot (6px circle, left edge)
  - `amber` + glow box-shadow for running
  - `green` for done
  - `red` for failed
  - `text-4` for idle
- Session name (flex 1, `SZ_BODY`, `TEXT_2`, white-space nowrap + ellipsis)
- Timestamp (`SZ_MICRO`, `TEXT_4`, tabular-nums)

States:
- Resting: transparent bg
- Hover: `BG_1` bg
- Active: `BG_1` bg + 2px teal bar on left edge (via `::before`, rounded 1px)

Click → make active session (switches content area). Right-click → context menu (rename, close, move, duplicate).

### 5.3 Content area — active

**Top edge:** flush with topbar (no gap).
**Bottom edge:** flush with ribbon.
**Left edge:** 1px `LINE_SOFT` vertical divider (THE one border).
**Right edge:** flush with window outer edge.
**No card radius.** No rounded corners on this surface.

Content layout top-to-bottom:
- Shell output stream (mono, `SZ_BODY`, `TEXT_2`) with syntax-colored prompt lines
- Block cards interspersed with output

**Block card** (see 5.4).

Scrolling: wheel scrolls shell output + block cards together. Scroll indicator on right edge (auto-hide, hairline teal).

### 5.4 Block card

The visual unit that makes Aura different from every other terminal.

Layout:
- 2px colored left strip (the agent-identity strip — `AGENT_CLAUDE`, `AGENT_CODEX`, etc.)
- Padding `P_MD P_LG` inside
- Rounded right side (0 9px 9px 0) — flat left for the strip
- `BG_1` or `BG_2` background

Top row (UI font, not mono):
- Title (block's display name or command) — `TEXT_1`, weight 500
- State pill on right — colored dot + label ("● running · 0:14", "✓ done · 0.4s", "⚠ gated", "✗ failed")

Body section (mono or UI font depending on content):
- Condensed output preview (first N lines) OR
- Metadata: intent, actual vs declared impacts, policy decision, attestation list

Expanded state (user clicked chevron):
- Full output
- Intent in full
- Policy decision with reasoning
- Attestation chain (who signed each transition)
- Cost breakdown (tokens in/out × model rate)
- Cross-branch impacts if any
- Actions: rewind-this-block, view-full-log, export

### 5.5 Content area — empty

Centered vertical stack, no padding constraints:
- "aura" wordmark (mono, 96px, weight 300, letter-spacing 0.08em, `TEXT_4`)
- `P_LG` gap
- Status line: green dot + "ready" text (`TEXT_3`, `SZ_BODY`)
- 96px gap
- Recents block (max-width 720px):
  - Header row: "Recent projects" (`SZ_TITLE`, weight 500) + "Open project" button on right
  - Rows: mono path (`TEXT_2`, hover → `TEXT_1`) + mono timestamp (`TEXT_4`, right-aligned)
  - 8px row padding, no borders between rows

### 5.6 Status card (bottom of sidebar, active state, optional)

Surfaces ambient context without blocking. Examples:

- "Aura active · Block gate armed · 3 zones claimed" with `Status` / `View log` buttons
- "Teammate Sarah is in auth.rs" with `Message` button
- "Plan paused — 2 waves remaining" with `Resume` / `View plan` buttons
- "5 impacts from other branches" with `Review` button

Shape: rounded 9px, `BG_2` bg, no border. Title (`SZ_BODY`, `TEXT_1`). Body (`SZ_META`, `TEXT_2`). Buttons at bottom.

Priority and ranking rules TBD — mock with static content for now. Real data comes from the `sentinel-projector` + `zone-projector` + `plan-tracker` services (not yet built).

### 5.7 Command palette (overlay, ⌘K)

Fullscreen overlay modal, dims background. 600px wide, auto-height card centered.

- Search input at top (`BG_2` bg, large text, auto-focus)
- Result list below, grouped by type:
  - Sessions (recent, matching)
  - Commands (shell commands from history)
  - Blocks (recent blocks, by title)
  - Actions ("New session", "Open project", "Pause orchestration", …)
  - Agents (invokable tools via MCP)
- Each row: icon + label + keyboard shortcut chip (if any) + type badge

Keyboard: arrows to navigate, enter to execute, escape to close.

### 5.8 Block detail drawer

Slide-in from right (350px), overlays content area.

Triggered by clicking block card header or chevron.

Sections (scrollable):
- Block header (title, state, timestamps)
- Intent (free text + structured fields)
- Policy decision + reasoning
- Declared vs actual impacts (diff view)
- Attestation chain (timeline)
- Cost breakdown (per-agent, per-tool)
- Cross-branch impacts
- Related blocks (parent, siblings, supersedes)
- Actions: rewind, re-run, export, share

### 5.9 Open-project dialog

Native file picker. No UI work needed except the trigger buttons in:
- Workspace rail `+`
- Empty state sidebar CTA
- Empty state content "Open project" button
- Command palette action

### 5.10 Settings overlay

Triggered by gear icon in rail. Fullscreen overlay with left-rail nav:
- General (theme, font, window behavior)
- Agents (Claude / Codex / Gemini API keys)
- Team (mothership URL, zone preferences)
- Policy (strict mode, gate rules — read-only in v1 if locked)
- Keyboard shortcuts
- About

v1 scope: render all tabs with static inputs. No real save, just fixtures.

### 5.11 Help overlay

Triggered by `?` in rail. Cheat sheet modal:
- Keyboard shortcuts table
- Common workflows
- Documentation links
- Version + diagnostics (`aura doctor` output)

---

## 6. Feature priority tiers

Build in this order. Each tier should be demo-able standalone.

### Tier 1 — the empty state story (first demo)

1. Window chrome (topbar + rail + sidebar + content + ribbon)
2. Empty state content (wordmark + status + recents)
3. Empty state sidebar (CTA)
4. Settings gear (opens stub overlay)
5. Help `?` (opens stub overlay)
6. Hamburger toggle (collapsed state)

**Demo:** launch app → see empty state → click around chrome → collapse sidebar.

### Tier 2 — a session exists (second demo)

7. Workspace avatar in rail (active)
8. Active session sidebar with workspace header
9. `New session` button (mocks adding a session)
10. Session rows with state dots
11. Active session highlight
12. Content area with fake shell output

**Demo:** click "Open project" → workspace avatar appears → session list populates → click a session → content shows mock output.

### Tier 3 — blocks are visible

13. Block card (running state)
14. Block card (completed state)
15. Block card (failed state)
16. Block card (gated state — policy pending)
17. Block state transitions (click Approve → Gated → Running animation)
18. Block detail drawer

**Demo:** session shows blocks → click block → drawer opens with full detail.

### Tier 4 — team and orchestration

19. Status card in sidebar (zone claims)
20. Status card (teammate activity)
21. Multi-agent orchestrate view (dedicated screen or overlay)
22. Cost graph in ribbon

### Tier 5 — polish

23. Command palette (⌘K overlay)
24. Settings overlay (real form fields)
25. Help overlay with cheat sheet
26. Onboarding / first-launch flow

Anything beyond tier 5 is out of v1 scope.

---

## 7. Technical constraints

- **iced 0.14** (not Tauri, not egui, not native). Matches the real `aura-term` crate.
- **Dark theme only** in v1. Don't architect for theme switching.
- **macOS-first** for polish (traffic lights reserve, native menu bar integration). Linux/Windows must work but can look slightly different.
- **No async**, no tokio, no MCP, no PTY code in the proto crate. Pure views + fixtures.
- **Pure view functions** — each widget is `fn view<'a, M: 'a + Clone>(model, on_foo, on_bar) -> Element<'a, M>`. Generic over Message so widgets can be ported unchanged to the real app.
- **Mock data in `fixtures.rs`** — hardcoded `Workspace`, `Session`, `Block`, etc. Every edge case is a fixture function.
- **Screen switch via CLI flag** — `cargo run -- --screen empty` / `--screen active` / `--screen palette`. Lets you test every state without building a state machine.
- **Zero filesystem writes** except logging. Don't persist anything — the real app will handle that.
- **No dependencies beyond iced + serde + maybe tiny-skia / svg**. Every extra dep slows your rebuild and makes graduation harder.

---

## 8. Graduation path

When a widget's design is approved, it graduates from proto to real:

1. Copy the widget file verbatim from `aura-proto/src/widgets/` → `aura-term/src/ui/`.
2. Change the Message type param from mock → real `crate::Message`.
3. Replace `fixtures::mock_X()` calls with real state accessors.
4. Add `#[cfg(test)]` tests on the widget — builds-with-empty-data, builds-with-overflow-data, builds-with-each-state-variant.
5. Hook the real update handler in `app.rs`.

The proto crate stays alive as a design playground. New screens get built there first, then graduate.

---

## 9. What not to build

These are explicit non-goals for v1. If you find yourself considering them, stop.

- **Light theme** — dark only.
- **Animations between states** — instant transitions, no motion design.
- **Real clipboard** — the real app handles it, proto doesn't need to.
- **Real PTY** — absolutely not in the proto.
- **Real MCP calls** — absolutely not.
- **Real file dialogs that open** — the trigger exists, the dialog does nothing.
- **Custom font shipped with the app** — use system fonts (SF Pro, SF Mono on macOS; Inter, JetBrains Mono as fallbacks).
- **Icons drawn in code** — use inline SVGs copied from Lucide or Heroicons (MIT licensed), loaded via iced's svg widget.
- **Linux/Windows-specific chrome tweaks** — match macOS layout everywhere in v1, tune per-OS later.
- **Accessibility audit** — do the basics (focus rings, contrast ratios) but don't deep-invest.
- **Localization** — English only.
- **Settings persistence** — not your problem, that's the real app.

---

## 10. Reference files

In the existing `aura-term` crate (read-only for design reference):

- `aura-term/src/ui/theme.rs` — design tokens. Copy into proto verbatim.
- `aura-term/src/ui/topbar.rs` — current topbar implementation (will be replaced by your new one).
- `aura-term/src/ui/rail.rs` — current 10-pane activity rail (may be partially reused).
- `aura-term/src/ui/sidebar.rs` — existing sidebar.
- `aura-term/src/ui/pty_grid.rs` — how the PTY content area renders. You won't touch this but know it exists.
- `aura-term/design/empty-state-mock-v5.html` — **the visual target**. Open it in a browser. Use the state toggle. Match it pixel-for-pixel.
- `aura-term/design/UI_AGENT_HANDOVER.md` — this file.

Data model files (for when you need to know what a Block looks like):

- `aura-blocks/src/block.rs` — Block struct, BlockState enum, transition function.
- `aura-blocks/src/ops.rs` — BlockOp, BlockOpPayload, ordering_key.
- `aura-policy/src/lib.rs` — policy evaluation surface.

Don't read the full source unless you need to. The mock fixtures are enough for v1.

---

## 11. Open design questions (flag these for approval)

These are genuine unknowns where your call matters. Don't resolve silently — flag them.

1. **Block card expanded inline vs drawer** — tier 3 assumes drawer, but maybe inline-expand is better for short blocks. Prototype both, get sign-off.
2. **Session icon vs just a dot** — all sessions show a state dot. Should there also be a per-session icon (cargo / git / zsh / agent)?
3. **Agent identity strip position** — currently left edge of block card (2px). Alternative: top edge, or a corner badge.
4. **Ribbon vs no ribbon** — ribbon is informative but takes 32px. Some users will want it off. v1 always-on, toggleable?
5. **Workspace avatar color** — currently all teal. Should each workspace get its own color like Slack?
6. **Empty vs welcome state** — current empty state shows recent projects. For first-ever launch (no recents), what replaces them? Tutorial? Video?
7. **How do plan/orchestration states surface** — a sidebar card? A dedicated pane? An overlay?
8. **Cost graph placement** — ribbon text? A small sparkline? A dedicated drawer?
9. **Multi-agent visible simultaneously** — when orchestrate runs 3 agents, does the content area split? Tabs? Stacked block cards?
10. **Block filtering** — users will have 500 blocks per session. How do they find "all denied blocks" or "all my intent"?

Flag decisions. Prototype options. Don't just pick silently.

---

## 12. Success criteria for your worktree

You are done with proto v1 when:

- All 5 priority tiers are demoable via `--screen` flag
- All 10 open design questions above have a working prototype or explicit deferral
- Zero external I/O beyond logging
- Zero dependencies on aura-cli, aura-blocks-cli, aura-policy, etc.
- Every widget is a pure view function with a Message type param
- A README explains the three rules (no IO, no logic, no real services) and lists the fixtures
- The proto runs identically on macOS ≥12 and Linux (Windows optional)
- Cold build is under 10 seconds, incremental under 3
- A "graduation checklist" exists for each widget — what tests to add, what to rewire when porting

Ship that and the design lock is real. Port then follows mechanically.

---

## Final note

The terminal is not the product. **Blocks are the product.** The terminal is where users first see them. Every design decision should answer: *does this make the block state, intent, policy, and cost more visible?* If yes, build it. If no, cut it.

Good luck. Read `empty-state-mock-v5.html` first. Match the borders, match the spacing, and the rest flows.
