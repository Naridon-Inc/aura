//! Data types for the durable goal ledger (`.aura/goals.jsonl`).
//!
//! A **goal** is a requirement in plain language ("users can sign in via
//! Google") plus everything that proves it: the task it belongs under, the
//! one-time *decomposition* into semantic requirements, and the *runs* that
//! re-checked those requirements against the real code over time.
//!
//! This is the engine-side twin of `aura-shell/src/lib/goalStore.ts`. The id
//! algorithm (`id_for_text`, in `store.rs`) is byte-for-byte the same djb2 hash
//! the frontend uses, so a goal born in the app and a goal born from a CLI
//! `aura prove` collapse onto ONE record instead of two. Field names are
//! snake_case to match the sibling git-tracked `.aura/intent_log.jsonl`; the
//! frontend maps them when it reads the ledger.

use serde::{Deserialize, Serialize};

/// The proof state of a goal: does the code actually deliver it?
///
/// Mirrors the engine's `aura prove --json` verdict and the frontend's
/// `GoalVerdict`. `Unknown` is "we can't tell yet" (never decomposed, or no
/// snapshot to check against) — deliberately distinct from a failure so the
/// surface never claims an unproven goal is broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Every requirement exists and is wired. "Done" really means done.
    Verified,
    /// Some requirements are met, some aren't yet.
    Partial,
    /// Nothing the goal needs is wired up yet.
    NotWired,
    /// Not yet decomposed / no code snapshot — can't tell.
    Unknown,
}

impl Verdict {
    /// Parse the engine's lowercase verdict string. Anything unrecognized is
    /// treated as `Unknown` rather than guessed.
    pub fn from_engine(s: &str) -> Self {
        match s {
            "verified" => Verdict::Verified,
            "partial" => Verdict::Partial,
            "not_wired" => Verdict::NotWired,
            _ => Verdict::Unknown,
        }
    }
}

impl Default for Verdict {
    fn default() -> Self {
        Verdict::Unknown
    }
}

/// One semantic requirement a goal needs in the code: a logic node that must
/// exist, and (optionally) a connection it must make. The decomposition is the
/// *expensive, costed* half of proving — done once by the LLM and cached here
/// so every later re-prove is a free, deterministic AST check.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Requirement {
    /// Identifier of the function/class/struct that must exist.
    pub node_name: String,
    /// "Function" | "Class" | "Struct" | "Logic" — what kind of node.
    pub node_type: String,
    /// A node this one must call/depend on, or `None` for "must merely exist".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub must_call: Option<String>,
}

/// The one-time breakdown of a goal into requirements, with provenance so we
/// know it isn't stale slop: which model produced it and when.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Decomposition {
    pub requirements: Vec<Requirement>,
    /// Unix millis the decomposition was produced.
    pub decomposed_at: u64,
    /// The model/labor that produced it (e.g. "auditor"), for provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// One proof run: a point in time where the goal's requirements were checked
/// against the code. The newest run is the goal's current state. Runs carry
/// the commit + files they were proven against so a goal links back to the
/// exact code that delivers it (the reverse code↔goal index).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalRun {
    /// Stable key for the run: a session's signed-block id, else
    /// `claude_session_id`, else `agent:timestamp`; `"adhoc"` for a manual
    /// repo-wide check. Re-recording the same `run_key` replaces, not appends.
    pub run_key: String,
    /// Human label for the run (intent headline / "Built on commit abc123").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub verdict: Verdict,
    /// Requirements met / total at the time of this run.
    pub ok: usize,
    pub total: usize,
    /// Commit sha this run proved against, when known (auto-prove on build).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// What triggered this run: "build" (auto, post-commit), "manual",
    /// "session". For "this goal proved itself when X shipped" provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<String>,
    /// Files the satisfying nodes live in — the concrete code↔goal links.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// Unix millis.
    pub at: u64,
}

/// A durable goal record: the join between a requirement, the task it serves,
/// and every run that has proven (or failed to prove) it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoalRecord {
    /// djb2 of the normalized text — shared with the frontend so the same
    /// requirement re-uses one record regardless of where it was born.
    pub id: String,
    pub text: String,
    /// Task this goal was assigned under (task uuid), if linked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// `AURA-<n>` sequence for display without a task fetch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_seq: Option<u64>,
    /// Plain-language acceptance checks — the "what to test / verify" plan a
    /// planner (or a human) wrote for this goal. Deliberately distinct from
    /// `decomposition` (the auto-derived semantic code-node requirements):
    /// these are steps a non-engineer can read and tick through ("Build
    /// succeeds", "Sign-in returns a session"), while the decomposition is the
    /// machine's AST-level proof checklist. Empty when none were provided.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub acceptance: Vec<String>,
    /// The cached one-time decomposition. `None` until first proven.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decomposition: Option<Decomposition>,
    /// Newest-first run verdicts, capped at `RUN_CAP`.
    #[serde(default)]
    pub runs: Vec<GoalRun>,
    /// Unix millis.
    pub created_at: u64,
    /// Unix millis.
    pub updated_at: u64,
}

impl GoalRecord {
    /// The goal's current proof state — its newest run, or `Unknown`.
    pub fn rollup(&self) -> (Verdict, usize, usize, Option<u64>) {
        match self.runs.first() {
            Some(r) => (r.verdict, r.ok, r.total, Some(r.at)),
            None => (Verdict::Unknown, 0, 0, None),
        }
    }
}
