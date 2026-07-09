//! Aura Manager — in-process orchestrator.
//!
//! Drives a DAG of `ManagerTask` records through the `aura-agents`
//! provider registry. Single-project v1 — multi-project tagging and
//! team-aware zone claims layer in 4C/4D. The Manager runs as a
//! `tokio::spawn` loop owned by `ManagerRuntime` (Tauri State); each
//! session is `Arc<Mutex<ManagerSession>>` so the loop can mutate while
//! the UI snapshot via `manager_status`.
//!
//! Persistence lives at `~/.aura/manager-sessions/<sid>.json`. Manager
//! sessions are top-level (not workspace-bound) so they survive
//! workspace switches and can later span repos in 4C.

pub mod brain;
pub mod chat;
pub mod dispatcher;
pub mod distill;
pub mod modes;
pub mod persist;
pub mod prompt;
pub mod scout;
pub mod skill;
pub mod team;
pub mod tick;
pub mod tokens;
pub mod worktree;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagerStatus {
    /// Plan staged but not yet executed. `manager_resume` flips to
    /// Running.
    AwaitingApproval,
    Running,
    Paused,
    Completed,
    Cancelled,
}

/// Bucket O — payload returned by `manager_subagent_monitor` and the
/// MCP `aura_subagent_monitor` tool. Lightweight slice of the task's
/// state so consumers don't pull the whole session JSON just to poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentMonitorView {
    pub task_id: usize,
    pub line_count: u64,
    pub recent: Vec<String>,
    pub status: ManagerTaskStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagerTaskStatus {
    Pending,
    Running,
    Done,
    Failed,
    /// User asked to take over — task waits for `manager_complete_manual`.
    ManualPending,
    Skipped,
}

/// Override modes for `manager_override`. Mirrors the plan's
/// `OverrideMode` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverrideMode {
    Skip,
    Rerun,
    Reassign,
    TakeOver,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRef {
    pub root: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagerTask {
    pub id: usize,
    pub description: String,
    /// Provider id from the `aura-agents` registry (`"claude"`,
    /// `"gemini"`, ...). `None` means smart-pick at dispatch time.
    pub agent_id: Option<String>,
    pub depends_on: Vec<usize>,
    pub status: ManagerTaskStatus,
    pub project_root: String,
    /// Zones declared at plan time. Honoured by the team-aware loop in
    /// 4D; ignored by the v1 single-project loop.
    #[serde(default)]
    pub zones: Vec<String>,
    /// Reason a task is currently blocked from dispatch (zone collision,
    /// upstream failure, ...). Surfaced in the UI ribbon.
    #[serde(default)]
    pub blocked_reason: Option<String>,
    /// Captured stdout from the agent invocation.
    #[serde(default)]
    pub output: String,
    /// Short relay summary (~200 tokens) consumed by downstream task
    /// prompts. Populated post-completion.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub completed_at: Option<u64>,
    /// Tauri channel id for the streaming `agent-stream:<channel>`
    /// events while the task is in flight. Lets the UI subscribe before
    /// the dispatch fires.
    #[serde(default)]
    pub stream_channel: Option<String>,
    /// If the task carried zones, the loop spawns it in a fresh git
    /// worktree at this path. Persisted so post-completion the user can
    /// open the worktree from the UI even after the loop forgets it.
    #[serde(default)]
    pub worktree_path: Option<String>,
    /// A2A v1.2 task id minted at plan-build time (when the user clicked
    /// Build on a `propose_plan` whose todo carried `agent_kind` info).
    /// Lets the DAG view link a local subagent run to its remote a2a
    /// task — same task, two views. `None` when cloud is not configured
    /// or the plan didn't ask for a2a tracking.
    #[serde(default)]
    pub a2a_task_id: Option<String>,
    /// Bucket L1 — snapshot ids captured BEFORE this task's subagent
    /// started writing. One id per file in `zones` that existed at
    /// dispatch time. `aura rewind --task <id>` walks this list to
    /// revert every file the subagent touched in one shot. Empty when
    /// the task had no zones, when the snapshot CLI was missing, or
    /// when the task pre-dates Bucket L.
    #[serde(default)]
    pub pre_dispatch_snapshot_ids: Vec<String>,
    /// Bucket O — bounded ring buffer of the most recent stdout/stderr
    /// lines from the subagent (cap 200). The brain calls
    /// `aura_subagent_monitor` (MCP) and the React DAG subscribes to
    /// `manager-task-stream:<sid>:<tid>` Tauri events; both consumers
    /// read out of this buffer (plus the `<sid>-<tid>.tail` file for
    /// cross-process MCP access). Empty when the task hasn't started.
    #[serde(default)]
    pub recent_output: Vec<String>,
    /// Bucket O — total stdout/stderr lines seen so far. The TaskCard
    /// shows `≈N lines` and a pulsing activity dot whenever this
    /// increments, so the user sees at a glance whether a long-running
    /// subagent is alive without expanding the stream panel.
    #[serde(default)]
    pub line_count: u64,
    /// Bucket F1 — mid-flight skill outcome that fills incrementally as
    /// the 5 signals arrive (exit/duration at finalize_task; thumbs from
    /// TaskCard rate; pr-review from a tokio::spawn after finalize;
    /// brain self-eval from `claude -p`; tokens from
    /// `parse_usage_trailer` over `recent_output`). When
    /// `ready_for_write()` returns true the row is appended to
    /// `~/.aura/agent_skills.json` via `skill::append_local`.
    /// `None` for in-flight tasks before finalize_task fires, and for
    /// tasks that pre-date the ledger (no migration; old sessions just
    /// don't write outcomes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_skill: Option<crate::manager::skill::PartialSkillOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RibbonEvent {
    PlanReady,
    TaskDispatched { task_id: usize, agent_id: String, channel: String },
    TaskCompleted { task_id: usize, exit_code: i32 },
    TaskFailed { task_id: usize, error: String },
    ZoneCollision { task_id: usize, claimer: String },
    /// jj-style auto-rebase: an upstream task completed, the loop
    /// rebased a downstream task's worktree onto the new tip, and the
    /// rebase produced merge conflicts. The downstream task is now
    /// `blocked_reason: "rebase_conflict on file X"` until the user
    /// resolves it (or aborts the worktree).
    RebaseConflict {
        task_id: usize,
        onto_ref: String,
        files: Vec<String>,
    },
    ManualOverride { task_id: usize, mode: OverrideMode },
    /// Emitted when the AST guard flags one or more function deletions
    /// in a subagent's worktree that don't match the agent's stated
    /// intent. Strict mode blocks the commit; non-strict surfaces the
    /// warning. Either way the user sees an inline system line in chat
    /// so the protection isn't silent. Driven by `intent_log.jsonl`
    /// entries written by the pre-commit hook.
    SemanticAlert {
        task_id: usize,
        deletions: Vec<String>,
        reason: String,
    },
    /// Emitted whenever the chat router produces narration on the
    /// session ("Decomposed into 3 tasks…", "I asked Claude to…").
    /// Frontend renders these in the chat scroll alongside ChatTurns.
    ManagerSpeech { text: String },
    Paused,
    Resumed,
    Cancelled,
}

/// Roles in the Manager chat thread. `User` for messages typed into the
/// Manager tab's bottom Composer; `Manager` for the router's narration
/// of what it's doing in response. `System` lands compaction digests
/// (Bucket M3) and other inline event lines (semantic alerts, rebase
/// conflicts) that the brain authored on the user's behalf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRole {
    User,
    Manager,
    System,
}

/// Bucket M1 — load-bearing turns that auto-pin into the Manager
/// brain's context window across compactions. Each variant signals
/// what KIND of memory the turn carries; the assembler (M2) treats all
/// non-None anchors identically (always include) but the React surface
/// uses the kind to render the right affordance ("📌 Plan",
/// "🔔 Semantic alert", "📌 You pinned this", ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorKind {
    /// User clicked Build / Cancel on a PlanCard. The decision text +
    /// the resulting plan_task_id are load-bearing for every
    /// downstream turn.
    PlanDecision,
    /// User answered a brain QuestionCard. Future turns reference the
    /// answer when narrating dispatches ("we picked option B because
    /// you said …").
    UserAnswer,
    /// Aura's deletion guard or PR-review surfaced a violation inline.
    /// Brain must remember not to repeat the offending move.
    SemanticAlert,
    /// User overrode a brain default in chat ("no, do X instead"). The
    /// brain's preamble already replays this; the anchor pins the
    /// turn so it survives compaction.
    ManualOverride,
    /// User right-clicked → Pin to memory. Highest-precedence anchor —
    /// never compacted, even when the model would prefer to.
    UserPin,
    /// Episode digest written by the auto-distillation step (M3). The
    /// summary itself is anchored so a follow-up compaction doesn't
    /// re-summarise it into a digest-of-a-digest.
    EpisodeDigest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: ChatRole,
    pub text: String,
    pub at: u64,
    /// Set when this user turn is the resolution of a brain QuestionCard.
    /// Carries the originating question text so the timeline can render
    /// Q+A as a single grouped element instead of an orphaned answer
    /// bubble. None for ordinary user/manager turns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_question: Option<String>,
    /// Bucket M1 — load-bearing anchor. Non-None means the turn is
    /// kept in the active brain context across every compaction. The
    /// auto-distillation step (M3) only ever rewrites turns where
    /// `anchor.is_none()`. Backwards-compatible: pre-M turns
    /// deserialize with `anchor=None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<AnchorKind>,
    /// Image attachments uploaded by the user with this turn. Each
    /// one becomes an `image` content block in the Anthropic Messages
    /// API request. Persisted inline (base64) so multi-turn
    /// conversations re-send the same images on every follow-up — the
    /// API requires the full message history each call. Composer
    /// caps each file at 20MB so the persisted JSON stays bounded.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<ChatAttachment>,
    /// WW-B1 — which brain produced this turn (a provider_id or backend
    /// id, e.g. `anthropic_native`, `cli_wrapper:gemini`,
    /// `openai_compat:moonshot`). Set on Manager/assistant turns so a
    /// mid-conversation brain swap stays legible in the timeline ("this
    /// answer came from Gemini"). None for user turns and pre-swap
    /// history. Additive: old sessions deserialize with `brain=None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain: Option<String>,
    /// Tool calls the brain made during this turn, persisted so the
    /// settled timeline can re-render the tool cards (read/edit/run/
    /// dispatch/board/page/rewind) on reload instead of dropping them
    /// the moment the live stream ends. Each entry pairs the `tool_use`
    /// (id/name/input) with its eventual `tool_result`. The renderer
    /// clubs consecutive read-only calls into one "Explored" line and
    /// consecutive world-changing calls into one living status bar —
    /// the same components the live stream uses. Additive: turns
    /// persisted before this field deserialize with an empty vec.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<PersistedToolCall>,
    /// Extended-thinking text the brain emitted before this turn's answer.
    /// The live native path deliberately treats chain-of-thought as a
    /// cosmetic and never persists it (see `cmd_brain_chat`); this field is
    /// populated ONLY when a turn is hydrated from an agent CLI transcript
    /// (`manager_import_agent_session`), where the thinking blocks are sitting
    /// on disk and are worth carrying so the imported timeline shows what the
    /// agent was reasoning about between messages. Additive: turns persisted
    /// before this field deserialize with `thinking=None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// Estimated tokens this turn SAVED by reaching for Aura's code-graph
    /// tools (the atlas map, `aura ask`) instead of grepping or reading whole
    /// files — summed across the turn's tool calls. An honest estimate
    /// (~3.5 chars/token, the engine's own constant in `orchestrate.rs`),
    /// never a measured count, so the UI always reads "Saved ~N". `None`/0 on
    /// turns that called no token-saving tool. Additive: turns persisted
    /// before this field deserialize with `saved_tokens=None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_tokens: Option<u32>,
}

/// One persisted `tool_use`/`tool_result` pair on a `ChatTurn`. Mirrors
/// the live `StreamBlock` tool shape so the settled timeline renders it
/// through the very same `describeTool` → `ToolCard` path. `result` is
/// None for a call whose result never landed (cancelled mid-turn).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedToolCall {
    pub tool_use_id: String,
    pub name: String,
    pub input: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<PersistedToolResult>,
}

/// The `tool_result` half of a `PersistedToolCall` — the executed tool's
/// output text plus whether it failed. Mirrors the API `ToolResult`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedToolResult {
    pub is_error: bool,
    pub content: String,
}

/// A user-uploaded image attachment carried on a `ChatTurn`. The
/// composer reads the file via FileReader.readAsDataURL, strips the
/// `data:<mime>;base64,` prefix, and sends `{media_type, data_base64}`
/// over the Tauri bridge. The brain's `build_request` emits one
/// `image` content block per attachment alongside the text block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAttachment {
    /// MIME type — `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
    pub media_type: String,
    /// Raw base64 (no `data:` URL prefix).
    pub data_base64: String,
    /// Original filename if provided. Cosmetic — used only for the
    /// composer's preview chip label, never sent to the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl ChatTurn {
    /// Bucket M1 — load-bearing turns survive compaction; auto-
    /// distillation skips them.
    pub fn is_load_bearing(&self) -> bool {
        self.anchor.is_some()
    }
}

/// Shape of an answer the Manager brain expects from the user. `Choice`
/// surfaces as pill buttons (single-select), `MultiChoice` as checkboxes
/// + Submit, `Text` as a freeform input. Persists on `ManagerSession`
/// so reopening a tab mid-question still shows the card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionKind {
    Choice,
    MultiChoice,
    Text,
}

/// One question inside a [`PendingQuestion`] set. The brain may batch 1–4
/// of these in a single `ask_user` call (Claude `AskUserQuestion` shape:
/// `questions:[{question, header, options, multiSelect}]`) so a small,
/// related cluster of decisions surfaces together as one card instead of a
/// slow one-at-a-time drip. `header` is the SDK's short label (a chip above
/// the question); absent for our flat single-question shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionItem {
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    pub kind: QuestionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingQuestion {
    /// For Anthropic-API-path questions, this is the brain's tool_use id —
    /// used to assemble the eventual `tool_result` when the user answers.
    /// For CLI-bridge questions (claude/gemini called `aura ask-user` via
    /// bash), this is the question_id the socket handler is waiting on.
    pub tool_use_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    pub kind: QuestionKind,
    pub at: u64,
    /// True when the question came from a CLI brain via the socket bridge
    /// (`aura ask-user`), false when from the Anthropic API tool loop.
    /// Routes the user's answer correctly: CLI = write back to a waiting
    /// socket connection, API = synthesize a tool_result for the next turn.
    #[serde(default)]
    pub from_cli: bool,
    /// The full set when the brain batched 1–4 questions in one `ask_user`
    /// call. The top-level `question`/`options`/`kind` mirror `items[0]` so
    /// single-question consumers (the CLI bridge, persisted records from
    /// before this field existed) keep working unchanged. Empty → the UI
    /// falls back to rendering the single top-level triple.
    #[serde(default)]
    pub items: Vec<QuestionItem>,
}

/// A plan the CLI brain wants the user to confirm before execution.
/// Surfaces in chat as a condensed PlanCard (title + summary + n todos +
/// "Open" CTA) AND as a full PlanTab in the WorkSurface that auto-opens
/// the moment this plan lands. Cursor-parity rich content: `objective`
/// (deeper prose than `summary`), `baseline` (current state markdown),
/// `architecture_mermaid` (mermaid graph syntax), `phases` (numbered
/// implementation steps with file refs), `deliverables`, `tests`, plus
/// the existing `todos`. Every rich field is optional and falls back to
/// the simple title/summary/todos shape so older brains keep working
/// without changes — the upgrade path is purely additive.
///
/// Build → the bridge resolves with `PlanDecision::Build` and the brain
/// continues (fans out via `aura a2a-task create` per todo, then
/// Bucket A3 — live state of an in-flight Scout pass. We snapshot the
/// brain's draft plan here while specialists run; the dashboard
/// renders a `ScoutCard` (3 rows + findings stream) and a `QaWave`
/// chips block when the brain has consolidated questions for the
/// user. Once `status` reaches `Done` the (annotated) draft is
/// promoted into `pending_plan` for the normal Build/Cancel flow.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingScout {
    pub id: String,
    /// Manager-side request_id (matches the bridge waiter) — the
    /// `aura propose-plan` process is parked on this id until Scout
    /// promotes the draft into `pending_plan` and the user clicks
    /// Build/Cancel.
    pub request_id: String,
    pub plan_draft: crate::cli_bridge::ProposePlanPayload,
    pub status: ScoutStatus,
    pub specialists: Vec<SpecialistRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qa_wave: Option<QaWave>,
    /// Number of Q&A waves run so far. Hard cap is 2 (after which we
    /// finalize regardless of what the brain says).
    #[serde(default)]
    pub waves_run: u8,
    /// Brain's free-form notes after the latest consolidation pass.
    /// Threaded into the promoted PendingPlan as a leading paragraph
    /// so the user sees what the specialists agreed on.
    #[serde(default)]
    pub consolidated_notes: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScoutStatus {
    Spawning,
    Running,
    AwaitingQa,
    Finalizing,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecialistKind {
    Architecture,
    Security,
    Ux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecialistStatus {
    Pending,
    Running,
    Done,
    Failed,
}

/// One specialist's findings — `summary` is a one-line digest, the
/// full structured payload (severity-tagged findings + open questions)
/// rides in `findings`/`questions`. Renders as one row in the
/// ScoutCard, expandable to show the full payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecialistRun {
    pub kind: SpecialistKind,
    pub status: SpecialistStatus,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub findings: Vec<crate::manager::skill::ScoutFinding>,
    /// Open questions the specialist surfaced. The brain consolidates
    /// these across all 3 specialists and asks the user a grouped
    /// subset (`QaWave`).
    #[serde(default)]
    pub questions: Vec<SpecialistQuestion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// Pre-consolidation question from a specialist. The brain picks
/// which of these (across all 3 specialists) to surface to the user
/// in a `QaWave`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecialistQuestion {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub options: Vec<String>,
}

/// One round of grouped questions surfaced to the user. The brain
/// consolidates specialist questions into ≤5 questions per wave; if a
/// second wave is needed (brain says `can_proceed=false`) we run one
/// more, then hard-cap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QaWave {
    /// Wave number (1 or 2).
    pub wave: u8,
    pub group_title: String,
    pub questions: Vec<SpecialistQuestion>,
    /// Answers indexed by question.id. Empty until the user replies.
    #[serde(default)]
    pub answers: std::collections::HashMap<String, String>,
}

/// `aura subagent spawn`); Cancel → bridge resolves Cancel, brain
/// replans.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPlan {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    /// Richer multi-paragraph objective. When present, the PlanTab
    /// renders this as the lead "Objective" section instead of `summary`.
    /// `summary` stays as the one-line synopsis used by the inline card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    /// Markdown describing what the current code/system looks like — the
    /// "before" state the plan is improving on. Renders as a "Current
    /// Baseline" section in the PlanTab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
    /// Raw mermaid graph syntax (e.g. `flowchart TD\n  A --> B`). Rendered
    /// as a diagram in the "Proposed Architecture" section of the PlanTab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture_mermaid: Option<String>,
    /// Numbered implementation phases. Each phase has a title, a markdown
    /// body, and optional file refs that become clickable links into the
    /// editor. Renders as the "Implementation Plan" section.
    #[serde(default)]
    pub phases: Vec<PlanPhase>,
    /// Bulleted deliverables — what the user gets when the plan lands.
    #[serde(default)]
    pub deliverables: Vec<String>,
    /// Bulleted test plan — how we verify the plan worked.
    #[serde(default)]
    pub tests: Vec<String>,
    /// Atomic todos that get fanned out to subagents on Build. Each todo
    /// becomes one a2a-task on Build (Wave D).
    #[serde(default)]
    pub todos: Vec<PendingPlanTodo>,
    /// Bucket D — segmented control on PlanCard overriding the dispatch
    /// loop's zone-overlap heuristic. Auto = current behaviour;
    /// Parallel = ignore zone overlaps and let worktrees race;
    /// Serial = strict one-at-a-time even when zones are disjoint.
    /// Snapshotted onto the session at Build time so changing the
    /// dropdown after Build has no effect on an in-flight plan.
    #[serde(default)]
    pub parallelism: PlanParallelism,
    /// Inventory blocker #3 (2026-05-20 audit) — explicit approval row.
    /// `approved_by` is the handle (`display_name` or `email`) of the
    /// user who clicked Approve on the PlanCard; `approved_at` is a
    /// unix-seconds timestamp matching the rest of this struct's time
    /// fields (`at`, ribbon entries, etc). Both `None` for fresh plans
    /// and for any plan persisted before this field landed —
    /// `#[serde(default)]` makes the migration silent. A plan can be
    /// Built without ever being Approved (legacy path) but once
    /// approved both fields stay set for the lifetime of the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_at: Option<u64>,
    pub at: u64,
}

impl PendingPlan {
    /// Heal-on-read: normalize the approval pair so we never end up with
    /// `approved_by = Some` but `approved_at = None` (or vice versa) on
    /// disk. Defensive against half-written rows from older shells, hand-
    /// edited JSON, or merge artefacts. Called by `persist::load` and by
    /// every read path that surfaces a plan to the UI.
    ///
    /// Rules (idempotent):
    ///   - both `Some` → leave untouched
    ///   - both `None` → leave untouched
    ///   - `approved_by = Some`, `approved_at = None` → fill `approved_at`
    ///     with the plan's `at` (best-guess: the plan's own creation
    ///     timestamp is the earliest defensible "approved at")
    ///   - `approved_by = None`, `approved_at = Some` → clear
    ///     `approved_at` (an unattributed approval is worthless for the
    ///     audit row, so drop the orphan timestamp)
    pub fn heal_approval(&mut self) {
        match (self.approved_by.as_deref(), self.approved_at) {
            (Some(name), None) => {
                if !name.trim().is_empty() {
                    self.approved_at = Some(self.at);
                } else {
                    // empty string is the same as None
                    self.approved_by = None;
                }
            }
            (None, Some(_)) => {
                self.approved_at = None;
            }
            _ => {}
        }
    }
}

/// Bucket D1 — plan-level execution parallelism. The default
/// (`Auto`) preserves the existing zone-overlap heuristic in
/// `tick::ready_tasks`. `Parallel` opts the user into concurrent
/// worktrees even when zones overlap (they accept merge risk in
/// exchange for wall-clock). `Serial` is the safe fallback when the
/// user wants to watch one task at a time.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanParallelism {
    #[default]
    Auto,
    Parallel,
    Serial,
}

/// One step in the implementation plan. `body` is markdown rendered in
/// the PlanTab; `file_refs` become inline clickable chips that open the
/// editor at that path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPhase {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub file_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPlanTodo {
    pub description: String,
    #[serde(default)]
    pub agent: Option<String>,
    /// Optional file refs scoped to this todo. The PlanTab renders them
    /// as chips next to the agent badge so the user can see exactly what
    /// the subagent will be working on.
    #[serde(default)]
    pub file_refs: Vec<String>,
    /// Bucket N1 — Optional teammate assignment. When the user says
    /// "have Alex pick up the API piece" the brain sets this to the
    /// teammate's email or username. The Build path mints the a2a
    /// task with `assignee_user_id` resolved on the cloud, and the
    /// PlanCard renders an assignee badge so the user can see who
    /// owns each todo before approving.
    #[serde(default)]
    pub assignee: Option<String>,
    /// Bucket G — auto-routing badge. When the historical Skill
    /// Ledger has ≥10 samples for this todo's taxonomy cell,
    /// `suggest_provider` returns the best-fit provider. Renders as a
    /// click-to-override `<SkillBadge>` on the PlanCard todo row. None
    /// when below threshold or stats are unavailable; brain's original
    /// `agent` pick stays the dispatched choice unless the user
    /// overrides via `manager_override_todo_agent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_provider: Option<crate::manager::skill::SkillSuggestion>,
    /// What "done" looks like for this todo, in plain language. Rendered as
    /// the goal line on the PlanCard before Build, then minted into the goal
    /// ledger and linked to this todo's board task on Build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// The plain-language verify plan — the checks that confirm the goal is
    /// met. Rendered as a checklist under the goal, and stored on both the
    /// goal (`acceptance`) and the task's acceptance criteria on Build.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance: Vec<String>,
    /// Optional sub-steps. When present this todo becomes a grouping (an epic
    /// the Crew does not run directly) and each sub-step becomes its own
    /// runnable child board task on Build, carrying its own goal + verify plan.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtasks: Vec<PendingPlanSubtask>,
}

/// One sub-step of a [`PendingPlanTodo`]. Rendered nested under its parent on
/// the PlanCard, and minted as a runnable child board task on Build.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPlanSubtask {
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// What "done" looks like for this sub-step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// The verify plan for this sub-step's goal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RibbonEntry {
    pub at: u64,
    pub event: RibbonEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagerSession {
    pub id: String,
    pub objective: String,
    pub status: ManagerStatus,
    pub projects: Vec<ProjectRef>,
    pub tasks: Vec<ManagerTask>,
    pub ribbon: Vec<RibbonEntry>,
    /// Chat thread between the user and the Manager router. Empty for
    /// sessions started via the legacy `manager_start` flow; populated
    /// for sessions opened from the agent picker via
    /// `manager_chat_start`. Survives reload (persisted in session JSON).
    #[serde(default)]
    pub chat: Vec<ChatTurn>,
    /// Brain mid-loop state — last assistant `content` array (text + tool_use
    /// blocks), held so the next API request can include it as the assistant
    /// turn alongside the matching tool_results. Cleared once the loop
    /// reaches `end_turn`. `None` outside an active brain turn.
    #[serde(default)]
    pub pending_assistant_blocks: Option<Vec<Value>>,
    /// Brain mid-loop state — `tool_result` content blocks waiting to be
    /// sent as the next user-role message. Paired with
    /// `pending_assistant_blocks`.
    #[serde(default)]
    pub pending_tool_results: Option<Vec<Value>>,
    /// Which backend powers this session's brain. `None` = pick at first
    /// turn via `BrainBackend::detect`. Persisted so reopening a session
    /// uses the same backend across restarts.
    #[serde(default)]
    pub brain_backend: Option<brain::BrainBackend>,
    /// Session id returned by the CLI backend (e.g. claude code's
    /// `system/init` `session_id`). Threaded back as `--resume` for
    /// follow-up turns so the CLI continues the same conversation.
    #[serde(default)]
    pub cli_session_id: Option<String>,
    /// If set, the brain has paused mid-loop waiting on a user answer to
    /// this question. The frontend renders a QuestionCard; the user's
    /// reply hits `manager_answer_question` which fills the missing
    /// `tool_result` for `tool_use_id` and resumes the brain.
    #[serde(default)]
    pub pending_question: Option<PendingQuestion>,
    /// If set, the CLI brain wants the user to confirm a proposed plan
    /// before execution. Frontend renders a PlanCard; Build/Cancel hits
    /// `manager_decide_plan` which resolves the bridge waiter so the CLI
    /// brain continues (or replans).
    #[serde(default)]
    pub pending_plan: Option<PendingPlan>,
    /// Bucket A3 — Scout (architectural pre-review) state. When the
    /// brain emits a propose-plan envelope that crosses the eligibility
    /// threshold (≥3 file refs OR a deliverable that adds a new
    /// feature) we hold the draft here, fan out 3 `claude -p`
    /// specialists, consolidate findings, ask the user grouped
    /// questions, then promote the (annotated) draft into
    /// `pending_plan` for the normal Build/Cancel flow. Cleared once
    /// Scout finalises (or fails open).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_scout: Option<PendingScout>,
    /// Bucket D — snapshot of `pending_plan.parallelism` taken at Build
    /// time. The dispatch tick reads this (not the live PendingPlan,
    /// which is cleared once Build resolves the bridge) to decide how
    /// to schedule the fan-out. `Auto` is the legacy behaviour so
    /// pre-Bucket-D sessions roll forward unchanged.
    #[serde(default)]
    pub plan_parallelism: PlanParallelism,
    /// WW-B1 — mid-conversation brain override. When set, the chat-header
    /// BrainPicker has swapped this session onto a different brain; chat
    /// turns resolve this `provider_id` instead of the global active brain
    /// until the user clears (None) or changes it. Persisted so a swap
    /// survives reload. `manager_set_brain_override` is the only writer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brain_override: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

impl ManagerSession {
    pub fn new(id: String, objective: String, projects: Vec<ProjectRef>, tasks: Vec<ManagerTask>) -> Self {
        let now = now_secs();
        Self {
            id,
            objective,
            status: ManagerStatus::AwaitingApproval,
            projects,
            tasks,
            ribbon: vec![RibbonEntry { at: now, event: RibbonEvent::PlanReady }],
            chat: vec![],
            pending_assistant_blocks: None,
            pending_tool_results: None,
            brain_backend: None,
            cli_session_id: None,
            pending_question: None,
            pending_plan: None,
            pending_scout: None,
            plan_parallelism: PlanParallelism::Auto,
            brain_override: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Backfill the session title from the first user turn. A session created
    /// with no objective — the ⌘N "blank chat" path starts one with `""` —
    /// would otherwise read as "Untitled chat" forever; the first thing the
    /// user types IS its title. No-op once an objective exists, so
    /// quick-action and imported sessions keep the one they were given.
    fn seed_objective_from(&mut self, role: ChatRole, text: &str) {
        if role == ChatRole::User
            && self.objective.trim().is_empty()
            && !text.trim().is_empty()
        {
            self.objective = summarize_objective(text);
        }
    }

    pub fn push_chat(&mut self, role: ChatRole, text: String) {
        self.seed_objective_from(role, &text);
        self.chat.push(ChatTurn {
            role,
            text,
            at: now_secs(),
            answered_question: None,
            anchor: None,
            attachments: Vec::new(),
            brain: None,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
        });
        self.touch();
    }

    /// Append a turn tagged with the brain that produced it (WW-B1). Used
    /// for Manager/assistant turns so the timeline can attribute the
    /// answer to the brain that was active when it streamed — the legible
    /// half of a mid-conversation brain swap.
    pub fn push_chat_with_brain(&mut self, role: ChatRole, text: String, brain: Option<String>) {
        self.seed_objective_from(role, &text);
        self.chat.push(ChatTurn {
            role,
            text,
            at: now_secs(),
            answered_question: None,
            anchor: None,
            attachments: Vec::new(),
            brain,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
        });
        self.touch();
    }

    /// Append a user turn carrying image attachments. Each attachment
    /// becomes an `image` content block on the next API request; the
    /// text body becomes a sibling `text` block. The composer caps each
    /// file at 20MB so the persisted JSON stays bounded.
    pub fn push_chat_with_attachments(
        &mut self,
        role: ChatRole,
        text: String,
        attachments: Vec<ChatAttachment>,
    ) {
        self.seed_objective_from(role, &text);
        self.chat.push(ChatTurn {
            role,
            text,
            at: now_secs(),
            answered_question: None,
            anchor: None,
            attachments,
            brain: None,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
        });
        self.touch();
    }

    /// Bucket M1 — Append a turn that's load-bearing for the brain's
    /// memory. Used for plan decisions, semantic alerts, episode
    /// digests — anything the auto-distillation step (M3) must keep
    /// verbatim instead of summarising away.
    pub fn push_anchored(
        &mut self,
        role: ChatRole,
        text: String,
        anchor: AnchorKind,
    ) {
        self.chat.push(ChatTurn {
            role,
            text,
            at: now_secs(),
            answered_question: None,
            anchor: Some(anchor),
            attachments: Vec::new(),
            brain: None,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
        });
        self.touch();
    }

    /// Append a user turn that resolves a QuestionCard. The originating
    /// question text is stored on the turn so the chat timeline can show
    /// Q+A as one grouped element on reload (Cursor parity).
    pub fn push_answer(&mut self, answer: String, question: String) {
        self.chat.push(ChatTurn {
            role: ChatRole::User,
            text: answer,
            at: now_secs(),
            answered_question: Some(question),
            // M1 — answers to brain QuestionCards are auto-anchored.
            // The brain references "you said X" in subsequent turns,
            // so dropping these on compaction would corrupt narration.
            anchor: Some(AnchorKind::UserAnswer),
            attachments: Vec::new(),
            brain: None,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
        });
        self.touch();
    }

    pub fn touch(&mut self) {
        self.updated_at = now_secs();
        self.enforce_chat_cap();
    }

    /// Hard backstop on the raw `chat` Vec length. The brain's *context
    /// window* is bounded separately by token-budget distillation
    /// (`manager/tokens.rs` + `distill.rs`); this is a far higher ceiling on
    /// the stored history so a runaway loop can never balloon the session file
    /// without bound — a 23k-turn file once took long enough to load that the
    /// desktop chat surface hung on "Loading…" indefinitely. When we cross the
    /// cap we archive the oldest overflow to `<sid>.archive.jsonl` (recoverable,
    /// never silently dropped) and keep the most-recent turns. O(1) and a no-op
    /// until the cap is crossed, so it's safe to call after every mutation.
    fn enforce_chat_cap(&mut self) {
        const CHAT_HARD_CAP: usize = 4000;
        const CHAT_RETAIN: usize = 3000;
        if self.chat.len() <= CHAT_HARD_CAP {
            return;
        }
        let overflow = self.chat.len() - CHAT_RETAIN;
        {
            // Scope the immutable borrow so it's released before the drain.
            let archived: Vec<&ChatTurn> = self.chat[..overflow].iter().collect();
            let _ = distill::archive_turns(&self.id, &archived);
        }
        self.chat.drain(..overflow);
    }

    pub fn push_ribbon(&mut self, event: RibbonEvent) {
        self.ribbon.push(RibbonEntry { at: now_secs(), event });
        self.touch();
    }

    pub fn task_mut(&mut self, task_id: usize) -> Option<&mut ManagerTask> {
        self.tasks.iter_mut().find(|t| t.id == task_id)
    }

    pub fn task(&self, task_id: usize) -> Option<&ManagerTask> {
        self.tasks.iter().find(|t| t.id == task_id)
    }

    /// True once every task has reached a terminal status.
    pub fn is_complete(&self) -> bool {
        self.tasks.iter().all(|t| matches!(
            t.status,
            ManagerTaskStatus::Done | ManagerTaskStatus::Failed | ManagerTaskStatus::Skipped
        ))
    }
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// First non-blank line of a prompt, clipped to ~100 chars — the rule that
/// turns the first thing a user says into a session title. Lives in the
/// domain so every path that seeds an objective (new session, agent import,
/// the first-user-turn backfill) derives the title identically.
/// Strip the composer's internal steering/pipe directives off the front of a
/// user turn. The composer prepends a single bracketed line — `[AUTO MODE — …]`,
/// `[PLAN MODE — …]`, `[ASK MODE — …]`, `[BUILD MODE — …]` or `[↪ PIPED …]` —
/// so the brain honours a mode or knows the user also drove an agent PTY. That
/// wiring must reach the model but is never human-facing, so it must not become
/// the session title. Only blocks opening with a known marker are stripped, so a
/// user message that legitimately starts with `[` survives untouched. Repeats so
/// a stacked pipe + mode prefix both come off.
fn strip_steering_prefix(text: &str) -> &str {
    const MARKERS: [&str; 5] = ["AUTO MODE", "PLAN MODE", "ASK MODE", "BUILD MODE", "↪ PIPED"];
    let mut s = text.trim_start();
    loop {
        let Some(after) = s.strip_prefix('[') else { break };
        let inner = after.trim_start();
        if !MARKERS.iter().any(|m| inner.starts_with(m)) {
            break;
        }
        // No directive nests a `]`, so the first one closes the block.
        let Some(close) = after.find(']') else { break };
        s = after[close + 1..].trim_start();
    }
    s
}

pub(crate) fn summarize_objective(text: &str) -> String {
    let text = strip_steering_prefix(text);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.chars().count() > 100 {
        format!("{}…", line.chars().take(100).collect::<String>())
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: usize, deps: Vec<usize>) -> ManagerTask {
        ManagerTask {
            id,
            description: format!("task {id}"),
            agent_id: Some("claude".into()),
            depends_on: deps,
            status: ManagerTaskStatus::Pending,
            project_root: "/tmp/repo".into(),
            zones: vec![],
            blocked_reason: None,
            output: String::new(),
            summary: None,
            started_at: None,
            completed_at: None,
            stream_channel: None,
            worktree_path: None,
            a2a_task_id: None,
            pre_dispatch_snapshot_ids: Vec::new(),
            recent_output: Vec::new(),
            line_count: 0,
            pending_skill: None,
        }
    }

    #[test]
    fn summarize_objective_strips_steering_prefix() {
        // AUTO/PLAN/ASK/BUILD mode directives never become the title.
        let auto = "[AUTO MODE — Full autopilot. Keep going until done.]\n\nFix the login bug";
        assert_eq!(summarize_objective(auto), "Fix the login bug");
        let plan = "[PLAN MODE — Discuss and propose a plan FIRST.]\n\nAdd OAuth";
        assert_eq!(summarize_objective(plan), "Add OAuth");
        // Stacked pipe + mode both come off.
        let stacked =
            "[↪ PIPED — User drove the PTY.]\n\n[AUTO MODE — Full autopilot.]\n\nShip it";
        assert_eq!(summarize_objective(stacked), "Ship it");
        // A genuine message that merely opens with a bracket is untouched.
        let plain = "[urgent] please refactor the parser";
        assert_eq!(summarize_objective(plain), "[urgent] please refactor the parser");
        // No prefix at all — unchanged.
        assert_eq!(summarize_objective("hello world"), "hello world");
    }

    #[test]
    fn is_complete_only_when_all_terminal() {
        let mut s = ManagerSession::new(
            "s1".into(),
            "obj".into(),
            vec![],
            vec![task(1, vec![]), task(2, vec![1])],
        );
        assert!(!s.is_complete());
        s.tasks[0].status = ManagerTaskStatus::Done;
        assert!(!s.is_complete());
        s.tasks[1].status = ManagerTaskStatus::Failed;
        assert!(s.is_complete());
    }

    #[test]
    fn ribbon_starts_with_plan_ready() {
        let s = ManagerSession::new("s".into(), "o".into(), vec![], vec![]);
        assert_eq!(s.ribbon.len(), 1);
        assert!(matches!(s.ribbon[0].event, RibbonEvent::PlanReady));
    }

    fn empty_plan(id: &str, at: u64) -> PendingPlan {
        PendingPlan {
            id: id.into(),
            title: "T".into(),
            summary: String::new(),
            objective: None,
            baseline: None,
            architecture_mermaid: None,
            phases: vec![],
            deliverables: vec![],
            tests: vec![],
            todos: vec![],
            parallelism: PlanParallelism::Auto,
            approved_by: None,
            approved_at: None,
            at,
        }
    }

    #[test]
    fn heal_approval_fills_missing_timestamp() {
        let mut plan = empty_plan("p1", 1_700_000_000);
        plan.approved_by = Some("alice@example.com".into());
        plan.approved_at = None;
        plan.heal_approval();
        assert_eq!(plan.approved_by.as_deref(), Some("alice@example.com"));
        assert_eq!(plan.approved_at, Some(1_700_000_000));
    }

    #[test]
    fn heal_approval_clears_orphan_timestamp() {
        let mut plan = empty_plan("p2", 1_700_000_000);
        plan.approved_by = None;
        plan.approved_at = Some(1_700_000_500);
        plan.heal_approval();
        assert_eq!(plan.approved_by, None);
        assert_eq!(plan.approved_at, None);
    }

    #[test]
    fn heal_approval_treats_empty_handle_as_unapproved() {
        let mut plan = empty_plan("p3", 1_700_000_000);
        plan.approved_by = Some("   ".into());
        plan.approved_at = None;
        plan.heal_approval();
        assert_eq!(plan.approved_by, None);
        assert_eq!(plan.approved_at, None);
    }

    #[test]
    fn heal_approval_is_idempotent_on_complete_pair() {
        let mut plan = empty_plan("p4", 1_700_000_000);
        plan.approved_by = Some("bob".into());
        plan.approved_at = Some(1_700_000_999);
        plan.heal_approval();
        plan.heal_approval();
        assert_eq!(plan.approved_by.as_deref(), Some("bob"));
        assert_eq!(plan.approved_at, Some(1_700_000_999));
    }

    #[test]
    fn legacy_plan_json_decodes_with_none_approval() {
        // Simulates a plan persisted before the approved_by/approved_at
        // fields landed. Must decode cleanly with both fields = None.
        let raw = r#"{
            "id": "old-1",
            "title": "Legacy",
            "summary": "",
            "todos": [],
            "at": 1234567
        }"#;
        let plan: PendingPlan = serde_json::from_str(raw).unwrap();
        assert_eq!(plan.id, "old-1");
        assert_eq!(plan.approved_by, None);
        assert_eq!(plan.approved_at, None);
    }
}
