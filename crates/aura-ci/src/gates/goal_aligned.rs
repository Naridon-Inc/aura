//! `goal-aligned` gate — seams into `goals::build::prove_active_on_commit`
//! (`aura-cli/src/goals/build.rs` ≈40). The CLI proves the active goal against
//! the committed code (AST-only, free) and hands the verdict in via
//! [`GateContext::goal`]. Advisory by default: a goal that isn't fully built
//! yet is information, not a reason to block the commit. `Unknown` (no active
//! goal / never decomposed) is a clean `Skip`, never a fail.

use crate::gates::{gate_result, AlignmentFact, Gate, GateContext, GateOpts};
use crate::model::{Status, StepResult};

pub struct GoalAlignedGate;

impl Gate for GoalAlignedGate {
    fn id(&self) -> &'static str {
        "goal-aligned"
    }

    fn default_blocking(&self) -> bool {
        false
    }

    fn default_name(&self) -> &'static str {
        "Builds toward the goal"
    }

    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult {
        let Some(fact) = ctx.goal.as_ref() else {
            return gate_result(
                name,
                self.id(),
                Status::Skip,
                opts.blocking,
                "No goal is linked to this work yet.".to_string(),
                None,
                0,
            );
        };

        let (status, summary) = classify(fact);
        let detail = Some(format!(
            "Goal: {}\nParts built: {} of {}",
            fact.label, fact.ok, fact.total
        ));
        gate_result(name, self.id(), status, opts.blocking, summary, detail, 0)
    }
}

/// Map the engine verdict to a CI status + plain-language summary.
fn classify(fact: &AlignmentFact) -> (Status, String) {
    match fact.verdict.as_deref() {
        Some("verified") => (
            Status::Pass,
            format!("This delivers the goal “{}”.", fact.label),
        ),
        Some("partial") => (
            Status::Fail,
            format!(
                "Part of the goal “{}” is built ({} of {} parts).",
                fact.label, fact.ok, fact.total
            ),
        ),
        Some("not_wired") => (
            Status::Fail,
            format!("None of the goal “{}” is built yet.", fact.label),
        ),
        // Unknown / never-decomposed → not a failure, just can't tell.
        _ => (
            Status::Skip,
            format!("Can't tell yet whether this builds “{}”.", fact.label),
        ),
    }
}
