//! `build` gate — wraps Aura's REAL local CI runner,
//! `aura_cli::build_verify::verify`, which auto-detects the project type and
//! runs `cargo check` / `tsc --noEmit` / `go build` / `mypy` under a wall
//! budget with timeout-kill. We do NOT reimplement any of that.
//!
//! Because `aura-ci` must not depend on `aura-cli`, the CLI hands the runner in
//! as a boxed closure on [`GateContext::run_build`]. When the closure is absent
//! (e.g. the desktop `pr` run, or a `manual` run with no build wiring), the
//! gate cleanly `Skip`s rather than faking a verdict. The build gate is
//! pre-push by default (heavy) and blocking — a red build must stop the push.

use crate::gates::{gate_result, Gate, GateContext, GateOpts};
use crate::model::{Status, StepResult};

pub struct BuildGate;

/// Default wall budget for the whole build gate (mirrors the CLI's 90s save-time
/// budget); overridable per-step via `budget_secs`.
const DEFAULT_BUDGET_SECS: u64 = 90;

impl Gate for BuildGate {
    fn id(&self) -> &'static str {
        "build"
    }

    fn default_blocking(&self) -> bool {
        true
    }

    fn default_name(&self) -> &'static str {
        "The code compiles"
    }

    fn evaluate(&self, name: &str, ctx: &GateContext, opts: GateOpts) -> StepResult {
        let Some(run_build) = ctx.run_build.as_ref() else {
            return gate_result(
                name,
                self.id(),
                Status::Skip,
                opts.blocking,
                "The build check isn't available here.".to_string(),
                None,
                0,
            );
        };

        let budget = opts.budget_secs.unwrap_or(DEFAULT_BUDGET_SECS);
        let outcome = run_build(budget);

        // No recognized project type — a clean no-op, never a block.
        if outcome.status == "skipped" || outcome.checks.is_empty() {
            return gate_result(
                name,
                self.id(),
                Status::Skip,
                opts.blocking,
                "No build to run for this project.".to_string(),
                None,
                outcome.duration_ms,
            );
        }

        let timed_out = outcome.checks.iter().any(|c| c.status == "timeout");
        let any_red = outcome.checks.iter().any(|c| c.status == "red");

        let status = if timed_out {
            Status::Timeout
        } else if any_red || outcome.status == "red" {
            Status::Fail
        } else {
            Status::Pass
        };

        let ran: Vec<&str> = outcome.checks.iter().map(|c| c.name.as_str()).collect();
        let summary = match status {
            Status::Pass => format!("The code compiles — {} passed.", join_human(&ran)),
            Status::Fail => "The code doesn't compile yet — the build failed.".to_string(),
            Status::Timeout => "The build took too long and was stopped.".to_string(),
            Status::Skip => "No build to run for this project.".to_string(),
        };

        let mut lines = Vec::new();
        for c in &outcome.checks {
            lines.push(format!("• {}: {}", c.name, c.status));
            if let Some(tail) = &c.stderr_tail {
                for l in tail.lines() {
                    lines.push(format!("    {}", l));
                }
            }
        }
        let detail = if lines.is_empty() {
            None
        } else {
            Some(lines.join("\n"))
        };

        gate_result(
            name,
            self.id(),
            status,
            opts.blocking,
            summary,
            detail,
            outcome.duration_ms,
        )
    }
}

fn join_human(items: &[&str]) -> String {
    match items {
        [] => "nothing".to_string(),
        [a] => a.to_string(),
        [a, b] => format!("{} and {}", a, b),
        _ => {
            let head = &items[..items.len() - 1];
            format!("{} and {}", head.join(", "), items[items.len() - 1])
        }
    }
}
