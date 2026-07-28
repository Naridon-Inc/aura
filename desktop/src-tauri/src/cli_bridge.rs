//! CLI ↔ shell bridge for the Manager's CLI brain (Claude Code / Gemini /
//! Codex). The brain runs as a subprocess that has its own native tools
//! (Bash/Read/Edit/...) — it can't call our Rust-side `ask_user` /
//! `propose_plan` tools directly. Instead, the brain shells out to:
//!
//!   `aura ask-user "Q?" --kind choice --options "A,B,C"`
//!   `aura propose-plan --json '{...}'`
//!
//! Those CLI commands connect to the same UNIX socket we use for the
//! permission shim (`~/.aura/run/aura-shell-mcp.sock`) and write a
//! discriminated envelope. This module owns the envelope shapes + the
//! `BridgeRegistry` of in-flight requests waiting on a UI answer.
//!
//! Flow for `ask_user`:
//!
//!   claude (bash) → `aura ask-user`
//!                       ▼ socket envelope `{kind: ask_user, ...}`
//!                  cmd_permission_socket
//!                       ▼ register oneshot, set ManagerSession.pending_question
//!                       ▼ emit `manager:<sid>` snapshot
//!                  React renders QuestionCard, user clicks
//!                       ▼ manager_answer_question
//!                       ▼ resolve oneshot with answer string
//!                  cmd_permission_socket writes `{answer: "..."}` back
//!                       ▼
//!                  `aura ask-user` prints answer, exits 0
//!                       ▼
//!                  claude's bash tool returns the answer to claude

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// Envelope kinds the socket dispatches on. `permission` is the legacy
/// shape used by `aura-shell-mcp`; the others are the Manager bridge.
/// Kept as a documentation enum — the actual dispatch in
/// `cmd_permission_socket::handle_connection` peeks `kind` directly so
/// it can fall back to the unstructured permission shape.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BridgeRequest {
    /// Default (no `kind` field) is permission — handled in
    /// cmd_permission_socket directly. Listed here for completeness.
    Permission(serde_json::Value),
    AskUser(AskUserPayload),
    ProposePlan(ProposePlanPayload),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AskUserPayload {
    pub session_id: String,
    pub question: String,
    #[serde(default)]
    pub options: Vec<String>,
    /// `"choice" | "multi_choice" | "text"` — matches `QuestionKind`.
    pub shape: String,
}

/// Wire envelope from `aura propose-plan` over the UNIX socket. Cursor-
/// parity rich shape — the simple title/summary/todos form still works
/// because every rich field is `#[serde(default)]`. The brain can opt
/// into deeper plan content as its prompt graduates from "draft a list"
/// to "draft a full design doc".
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProposePlanPayload {
    pub session_id: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub baseline: Option<String>,
    #[serde(default)]
    pub architecture_mermaid: Option<String>,
    #[serde(default)]
    pub phases: Vec<PlanPhasePayload>,
    #[serde(default)]
    pub deliverables: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    #[serde(default)]
    pub todos: Vec<PlanTodo>,
    /// Bucket A2 — when true the propose-plan envelope skips the Scout
    /// fan-out even if it would otherwise trigger. Set by Scout itself
    /// when it emits its own internal "summary-of-findings" plan, so we
    /// don't recurse into another Scout pass on the consolidated draft.
    #[serde(default)]
    pub force_skip_scout: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlanPhasePayload {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub file_refs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlanTodo {
    pub description: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub file_refs: Vec<String>,
    /// Bucket N1 — teammate email/username this todo is assigned to.
    /// Threaded into the a2a task's `assignee_user_id` on the cloud
    /// when the user clicks Build, and rendered as a teammate badge on
    /// the PlanCard's todo row.
    #[serde(default)]
    pub assignee: Option<String>,
    /// What "done" looks like for this step, in plain language — the outcome
    /// the Crew can later prove. On Build it's minted into the goal ledger and
    /// linked to this step's task; the PlanCard renders it as the goal line.
    #[serde(default)]
    pub goal: Option<String>,
    /// The plain-language verify plan for this step — the exact checks that
    /// confirm the goal is met ("Build succeeds", "Sign-in returns a session").
    /// Becomes the goal's `acceptance` and the task's acceptance criteria, and
    /// renders as a checklist under the goal on the PlanCard + task detail.
    #[serde(default)]
    pub acceptance: Vec<String>,
    /// Optional breakdown into sub-steps. When present this step becomes a
    /// grouping (an epic container that is NOT itself dispatched) and each
    /// sub-step becomes a real child board task the Crew runs on its own,
    /// carrying its own goal + verify plan. Empty for a leaf step the Crew
    /// runs directly.
    #[serde(default)]
    pub subtasks: Vec<PlanSubtask>,
}

/// One sub-step of a [`PlanTodo`]. Each becomes a runnable child board task on
/// Build with its own goal + verify plan, so the Crew works it independently.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlanSubtask {
    pub description: String,
    /// Optional agent best suited to this sub-step (claude / gemini / …).
    #[serde(default)]
    pub agent: Option<String>,
    /// What "done" looks like for this sub-step, in plain language.
    #[serde(default)]
    pub goal: Option<String>,
    /// The verify plan for this sub-step's goal.
    #[serde(default)]
    pub acceptance: Vec<String>,
}

/// In-flight requests keyed by `request_id` (uuid). The `oneshot::Sender`
/// is held by the socket task that's awaiting the user's answer; the
/// `manager_answer_question` / `manager_plan_decision` Tauri command
/// fires it from the UI side.
pub struct BridgeRegistry {
    /// `aura ask-user` — answer string flows back as the response.
    pending_questions: Mutex<HashMap<String, oneshot::Sender<String>>>,
    /// `aura propose-plan` — build, revise, or cancel flows back.
    pending_plans: Mutex<HashMap<String, oneshot::Sender<PlanDecision>>>,
}

/// Resolution of a `propose_plan` round-trip. `Build` carries a list of
/// A2A v1.2 task ids — one per plan todo, in todo order — minted by
/// `manager_decide_plan` when the user clicked Build. The brain reads
/// these on stdout and threads them through subsequent
/// `aura subagent spawn --a2a-task-id <id>` invocations so the local
/// DAG row lines up with the remote a2a task in the cloud. Empty when
/// cloud sync is off or the mint failed — brain falls back to spawning
/// without an a2a tag in that case.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "verb", rename_all = "snake_case")]
pub enum PlanDecision {
    Build {
        #[serde(default)]
        a2a_task_ids: Vec<String>,
        /// Bucket K2 — UUID of the `task_kind=plan` envelope task that
        /// `a2a_task_ids` are children of. None when cloud minting is
        /// off or the parent mint failed; the brain still gets per-todo
        /// ids in that case but can't post status against the parent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plan_task_id: Option<String>,
    },
    /// The user wants another planning pass before approving execution.
    /// Feedback is returned to the proposing brain as a tool result so it
    /// can amend the plan and call `propose_plan` again.
    Revise { feedback: String },
    Cancel,
}

impl BridgeRegistry {
    pub fn new() -> Self {
        Self {
            pending_questions: Mutex::new(HashMap::new()),
            pending_plans: Mutex::new(HashMap::new()),
        }
    }

    /// Register a question waiter. Returns the receiver the socket task
    /// awaits; the matching `tx` will be fired by `manager_answer_question`
    /// when the user clicks an option in the UI.
    pub fn register_question(&self, request_id: String) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.pending_questions.lock().unwrap().insert(request_id, tx);
        rx
    }

    /// Resolve a pending question. Returns false if no matching id was
    /// registered (already answered, or never sent — defensive).
    pub fn resolve_question(&self, request_id: &str, answer: String) -> bool {
        let mut map = self.pending_questions.lock().unwrap();
        match map.remove(request_id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    pub fn register_plan(&self, request_id: String) -> oneshot::Receiver<PlanDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending_plans.lock().unwrap().insert(request_id, tx);
        rx
    }

    pub fn resolve_plan(&self, request_id: &str, decision: PlanDecision) -> bool {
        let mut map = self.pending_plans.lock().unwrap();
        match map.remove(request_id) {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }
}

impl Default for BridgeRegistry {
    fn default() -> Self {
        Self::new()
    }
}
