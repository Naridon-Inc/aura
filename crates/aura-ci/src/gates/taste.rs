//! `taste` gate — seams into `taste::check::check_staged`
//! (`aura-cli/src/taste/check.rs`). The CLI runs the learned-style check
//! against the staged diff and hands the findings in via
//! [`GateContext::taste`]. Advisory by default, exactly like the inline
//! pre-commit taste gate (which only blocks when both strict-mode AND
//! taste-strict are on — the CLI can set `blocking` on the step to mirror
//! that). `None` findings (dev-mode bypass / facts not gathered) → `Skip`.

use crate::gates::{gate_result, Gate, GateContext, GateOpts};
use crate::model::{Status, StepResult};

pub struct TasteGate;

impl Gate for TasteGate {
    fn id(&self) -> &'static str {
        "taste"
    }

    fn default_blocking(&self) -> bool {
        false
    }

    fn default_name(&self) -> &'static str {
        "Matches the project style"
    }

    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult {
        let Some(findings) = ctx.taste.as_ref() else {
            return gate_result(
                name,
                self.id(),
                Status::Skip,
                opts.blocking,
                "Style check didn't run for this change.".to_string(),
                None,
                0,
            );
        };

        if findings.is_empty() {
            return gate_result(
                name,
                self.id(),
                Status::Pass,
                opts.blocking,
                "The change matches the project's established style.".to_string(),
                None,
                0,
            );
        }

        let summary = if findings.len() == 1 {
            "1 spot doesn't match the project's usual style.".to_string()
        } else {
            format!("{} spots don't match the project's usual style.", findings.len())
        };
        let mut lines = Vec::new();
        for f in findings.iter().take(8) {
            lines.push(format!("• {} — {}", f.file_path, f.reason));
            lines.push(format!("    rule: {}", f.rule_statement));
        }
        if findings.len() > 8 {
            lines.push(format!("• … and {} more", findings.len() - 8));
        }
        gate_result(
            name,
            self.id(),
            Status::Fail,
            opts.blocking,
            summary,
            Some(lines.join("\n")),
            0,
        )
    }
}
