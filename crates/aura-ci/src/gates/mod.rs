//! Gates — the semantic verbs Aura already owns, wrapped as ordered pipeline
//! steps.
//!
//! **Dependency direction.** `aura-ci` must NOT depend on `aura-cli`, or we'd
//! get a crate cycle (the CLI depends on this crate). So the semantic *facts*
//! that live in the CLI — the staged `AstNode`s, the diff sets, the stated
//! intent, the active-goal proof, and the real `build_verify` runner — are
//! handed IN by the CLI via [`GateContext`]. A gate is a pure function over
//! those pre-computed facts; it never re-parses the tree or re-runs git.
//!
//! The one heavy fact, the `build` runner, is modeled as a boxed closure
//! (`run_build`) so `aura-ci` can invoke `aura_cli::build_verify::verify`
//! WITHOUT a dependency on `aura-cli` — the CLI wires the closure when it
//! builds the context.

use crate::model::{Status, StepResult};

mod build;
mod goal_aligned;
mod intent_match;
mod no_secrets;
mod no_stubs;
mod taste;

/// A minimal, dependency-free view of one AST node, projected from the CLI's
/// `aura_cli::models::AstNode`. Carries exactly the fields the gates read so
/// `aura-ci` need not depend on the CLI's model.
#[derive(Debug, Clone, Default)]
pub struct CiNode {
    pub identifier: Option<String>,
    pub kind: String,
    pub file_path: Option<String>,
    pub start_line: Option<u32>,
    pub contains_secret: bool,
    pub is_stub: bool,
}

/// The verdict of the real `build_verify::verify` run, projected by the CLI so
/// the `build` gate need not know the CLI's `BuildStatus` type.
#[derive(Debug, Clone)]
pub struct BuildOutcome {
    /// "green" | "red" | "skipped".
    pub status: String,
    /// Per-adapter lines (e.g. "cargo-check: green") for the disclosure detail.
    pub checks: Vec<BuildCheck>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct BuildCheck {
    pub name: String,
    /// "green" | "red" | "skipped" | "timeout".
    pub status: String,
    pub stderr_tail: Option<String>,
}

/// One alignment score sample (goal-aligned / intent-match), projected by the
/// CLI from `goals::build::prove_active_on_commit` / `intent_vs_actual`.
#[derive(Debug, Clone)]
pub struct AlignmentFact {
    /// Human label ("Add OAuth login", or the commit message).
    pub label: String,
    /// Engine verdict string ("verified" | "partial" | "not_wired" |
    /// "unknown") OR a raw score interpreted against the step threshold.
    pub verdict: Option<String>,
    /// Numeric alignment score (0.0–1.0) when the gate is score-driven.
    pub score: Option<f64>,
    /// Parts proven / total, for the disclosure detail.
    pub ok: usize,
    pub total: usize,
}

/// One taste finding, projected from `taste::check::Violation`.
#[derive(Debug, Clone)]
pub struct TasteFinding {
    pub file_path: String,
    pub rule_statement: String,
    pub reason: String,
}

/// Everything a gate might read, computed once by the CLI and handed in. Every
/// field is optional: a gate whose facts weren't gathered (e.g. `build` on a
/// `manual` run with no closure wired) cleanly reports `Skip`.
#[derive(Default)]
pub struct GateContext {
    /// Staged / changed AST nodes (pre-commit: the index; pr: base..head).
    pub nodes: Vec<CiNode>,
    /// Identifiers of nodes that already exist on `secret_allowlist` — the
    /// `no-secrets` gate honors the same allowlist the inline gate does.
    pub secret_allowlist: Vec<String>,
    /// Active-goal alignment (goal-aligned gate). `None` = no active goal.
    pub goal: Option<AlignmentFact>,
    /// Intent↔AST alignment for the staged work (intent-match gate).
    pub intent: Option<AlignmentFact>,
    /// Taste findings against the staged diff (taste gate). `None` = the
    /// facts weren't gathered (e.g. dev-mode bypass) → the gate skips.
    pub taste: Option<Vec<TasteFinding>>,
    /// The wired-in `build_verify::verify` call. Boxed so `aura-ci` invokes it
    /// without depending on `aura-cli`. `None` = no build facts available →
    /// the `build` gate skips.
    pub run_build: Option<Box<dyn Fn(u64) -> BuildOutcome + Send + Sync>>,
}

/// A semantic gate: a pure verdict over the pre-computed [`GateContext`].
pub trait Gate {
    /// The gate id as it appears in the TOML (`no-secrets`, `build`, …).
    fn id(&self) -> &'static str;
    /// The default `blocking` posture when the TOML doesn't say. Secrets and
    /// stubs default to blocking; alignment/taste default to advisory.
    fn default_blocking(&self) -> bool;
    /// The plain-language step name shown in the Checks surface when the TOML
    /// doesn't supply one (e.g. "No half-finished code"). Single source of
    /// truth for default labels — `parse.rs` reads this, no duplication.
    fn default_name(&self) -> &'static str;
    /// Evaluate the gate. `name` is the step's plain-language label;
    /// `blocking`/`budget_secs`/`threshold` come from the resolved step.
    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult;
}

/// The per-step knobs handed to a gate at evaluation time.
#[derive(Debug, Clone, Copy)]
pub struct GateOpts {
    pub blocking: bool,
    pub budget_secs: Option<u64>,
    pub threshold: Option<f64>,
}

/// Resolve a gate id to its implementation. Unknown ids resolve to `None`, and
/// the executor records a `Skip` with a clear "unknown gate" note — never a
/// crash, never a fake pass.
pub fn resolve(id: &str) -> Option<Box<dyn Gate>> {
    match id {
        "no-secrets" => Some(Box::new(no_secrets::NoSecretsGate)),
        "no-stubs" => Some(Box::new(no_stubs::NoStubsGate)),
        "goal-aligned" => Some(Box::new(goal_aligned::GoalAlignedGate)),
        "intent-match" => Some(Box::new(intent_match::IntentMatchGate)),
        "taste" => Some(Box::new(taste::TasteGate)),
        "build" => Some(Box::new(build::BuildGate)),
        _ => None,
    }
}

/// Shared helper: build a `StepResult` for a gate step.
pub(crate) fn gate_result(
    name: &str,
    gate_id: &str,
    status: Status,
    blocking: bool,
    summary: String,
    detail: Option<String>,
    duration_ms: u64,
) -> StepResult {
    StepResult {
        name: name.to_string(),
        kind: format!("gate:{}", gate_id),
        status,
        // A skipped gate never blocks regardless of its declared posture.
        blocking: blocking && status != Status::Skip,
        summary,
        detail,
        duration_ms,
    }
}
