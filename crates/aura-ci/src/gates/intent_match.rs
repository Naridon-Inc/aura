//! `intent-match` gate — seams into `intent_vs_actual` (the alignment score in
//! `aura-cli/src/intent_vs_actual.rs`). The CLI computes how well the stated
//! intent matches the actual AST changes and hands the score in via
//! [`GateContext::intent`]. Advisory by default — a low score is a "did the AI
//! do something it didn't say?" flag, surfaced but not blocking. The step's
//! `threshold` (default 0.5) sets the pass line.

use crate::gates::{gate_result, Gate, GateContext, GateOpts};
use crate::model::{Status, StepResult};

pub struct IntentMatchGate;

/// Default minimum alignment score to pass, when the step doesn't set one.
const DEFAULT_THRESHOLD: f64 = 0.5;

impl Gate for IntentMatchGate {
    fn id(&self) -> &'static str {
        "intent-match"
    }

    fn default_blocking(&self) -> bool {
        false
    }

    fn default_name(&self) -> &'static str {
        "Did what it said"
    }

    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult {
        let Some(fact) = ctx.intent.as_ref() else {
            return gate_result(
                name,
                self.id(),
                Status::Skip,
                opts.blocking,
                "No stated intent to compare against.".to_string(),
                None,
                0,
            );
        };

        let Some(score) = fact.score else {
            return gate_result(
                name,
                self.id(),
                Status::Skip,
                opts.blocking,
                "Couldn't measure how well the change matches its intent.".to_string(),
                None,
                0,
            );
        };

        let threshold = opts.threshold.unwrap_or(DEFAULT_THRESHOLD);
        let pct = (score * 100.0).round() as i64;
        let (status, summary) = if score >= threshold {
            (
                Status::Pass,
                format!("The change matches what it set out to do ({}% aligned).", pct),
            )
        } else {
            (
                Status::Fail,
                format!(
                    "The change only partly matches what it set out to do ({}% aligned).",
                    pct
                ),
            )
        };
        let detail = Some(format!(
            "Stated: {}\nAlignment score: {:.2} (pass line {:.2})",
            fact.label, score, threshold
        ));
        gate_result(name, self.id(), status, opts.blocking, summary, detail, 0)
    }
}
