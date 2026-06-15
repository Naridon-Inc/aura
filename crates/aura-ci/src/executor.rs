//! Executor — run a pipeline's steps in declared order against a
//! [`GateContext`], collecting one [`StepResult`] each, and roll them up into a
//! [`PipelineRun`].
//!
//! Semantics:
//! * Steps run in declared order. Order is meaningful — a `run` step that builds
//!   an artifact can precede a gate that inspects it.
//! * A `gate` step resolves its verb to a [`Gate`] impl and evaluates it over
//!   the pre-computed facts (no I/O, fast). An unknown gate id is a clean
//!   `Skip` with a clear note — never a crash, never a fake pass.
//! * A `run` step shells out the command with a wall budget (default 120s),
//!   killing it on timeout. `Pass` on exit 0, `Fail` on non-zero, `Timeout`
//!   when the budget is exceeded.
//! * Blocking is recorded per step; the run is `blocked` iff any *blocking*
//!   step failed. We do NOT short-circuit — every step runs so the surface can
//!   show the full picture ("4 passed, 1 needs a look") in one pass.

use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::gates::{self, GateContext, GateOpts};
use crate::model::{Pipeline, Status, Step, StepKind, StepResult, Trigger};

/// Default wall budget for a `run` step when the TOML doesn't set `budget_secs`.
const DEFAULT_RUN_BUDGET_SECS: u64 = 120;

/// Run `pipeline` for `trigger` against `ctx`, in `root`. `run` steps execute
/// with their cwd set to `root`.
pub fn run(
    pipeline: &Pipeline,
    trigger: Trigger,
    ctx: &GateContext,
    root: &std::path::Path,
) -> crate::model::PipelineRun {
    let start = Instant::now();
    let steps = pipeline.steps_for(trigger);

    let mut results = Vec::with_capacity(steps.len());
    for step in steps {
        results.push(run_step(step, ctx, root));
    }

    crate::model::PipelineRun::finalize(
        pipeline.name.clone(),
        trigger,
        results,
        start.elapsed().as_millis() as u64,
    )
}

fn run_step(step: &Step, ctx: &GateContext, root: &std::path::Path) -> StepResult {
    match &step.kind {
        StepKind::Gate(id) => run_gate(step, id, ctx),
        StepKind::Run(cmd) => run_command(step, cmd, root),
    }
}

fn run_gate(step: &Step, id: &str, ctx: &GateContext) -> StepResult {
    let Some(gate) = gates::resolve(id) else {
        // Unknown verb — record it plainly, never block, never fake a pass.
        return StepResult {
            name: step.name.clone(),
            kind: format!("gate:{}", id),
            status: Status::Skip,
            blocking: false,
            summary: format!("Unknown check `{}` — skipped.", id),
            detail: Some(
                "This pipeline names a gate Aura doesn't recognize. Valid gates: \
                 no-secrets, no-stubs, goal-aligned, intent-match, taste, build."
                    .to_string(),
            ),
            duration_ms: 0,
        };
    };

    let opts = GateOpts {
        blocking: step.blocking,
        budget_secs: step.budget_secs,
        threshold: step.threshold,
    };
    gate.evaluate(&step.name, ctx, opts)
}

fn run_command(step: &Step, cmd: &str, root: &std::path::Path) -> StepResult {
    let start = Instant::now();
    let budget = Duration::from_secs(step.budget_secs.unwrap_or(DEFAULT_RUN_BUDGET_SECS));

    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return StepResult {
            name: step.name.clone(),
            kind: "run".to_string(),
            status: Status::Skip,
            blocking: false,
            summary: "Nothing to run (empty command).".to_string(),
            detail: None,
            duration_ms: 0,
        };
    }

    // Run through the shell so `run = "cargo test && cargo clippy"` works.
    let mut child = match Command::new("sh")
        .arg("-c")
        .arg(trimmed)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return StepResult {
                name: step.name.clone(),
                kind: "run".to_string(),
                status: Status::Fail,
                blocking: step.blocking,
                summary: "Couldn't start this command.".to_string(),
                detail: Some(format!("$ {}\n{}", trimmed, e)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let id = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait());
    });

    match rx.recv_timeout(budget) {
        Ok(Ok(status)) => {
            let mut out_buf = Vec::new();
            let mut err_buf = Vec::new();
            if let Some(mut s) = stdout {
                let _ = std::io::Read::read_to_end(&mut s, &mut out_buf);
            }
            if let Some(mut s) = stderr {
                let _ = std::io::Read::read_to_end(&mut s, &mut err_buf);
            }
            let dur = start.elapsed().as_millis() as u64;
            if status.success() {
                StepResult {
                    name: step.name.clone(),
                    kind: "run".to_string(),
                    status: Status::Pass,
                    blocking: step.blocking,
                    summary: format!("`{}` passed.", trimmed),
                    detail: tail_detail(trimmed, &out_buf, &err_buf),
                    duration_ms: dur,
                }
            } else {
                StepResult {
                    name: step.name.clone(),
                    kind: "run".to_string(),
                    status: Status::Fail,
                    blocking: step.blocking,
                    summary: format!("`{}` failed.", trimmed),
                    detail: tail_detail(trimmed, &out_buf, &err_buf),
                    duration_ms: dur,
                }
            }
        }
        Ok(Err(e)) => StepResult {
            name: step.name.clone(),
            kind: "run".to_string(),
            status: Status::Fail,
            blocking: step.blocking,
            summary: "This command errored while running.".to_string(),
            detail: Some(format!("$ {}\n{}", trimmed, e)),
            duration_ms: start.elapsed().as_millis() as u64,
        },
        Err(_) => {
            // Budget exceeded — best-effort kill (the child was moved into the
            // waiter thread, so kill by pid, mirroring build_verify).
            let _ = Command::new("kill").arg(id.to_string()).status();
            StepResult {
                name: step.name.clone(),
                kind: "run".to_string(),
                status: Status::Timeout,
                blocking: step.blocking,
                summary: format!("`{}` took too long and was stopped.", trimmed),
                detail: Some(format!("Budget: {}s", budget.as_secs())),
                duration_ms: start.elapsed().as_millis() as u64,
            }
        }
    }
}

/// Tail of stdout+stderr for the disclosure detail — mechanism on demand.
fn tail_detail(cmd: &str, out: &[u8], err: &[u8]) -> Option<String> {
    let mut s = String::from(format!("$ {}\n", cmd));
    let err_str = String::from_utf8_lossy(err);
    let out_str = String::from_utf8_lossy(out);
    let tail: Vec<&str> = err_str
        .lines()
        .chain(out_str.lines())
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if tail.is_empty() {
        return None;
    }
    s.push_str(&tail.join("\n"));
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Pipeline;

    fn ctx() -> GateContext {
        GateContext::default()
    }

    #[test]
    fn ordered_run_collects_every_step() {
        let pipeline = Pipeline {
            name: "t".into(),
            triggers: vec![Trigger::Manual],
            steps: vec![
                Step {
                    name: "first".into(),
                    kind: StepKind::Run("true".into()),
                    on: vec![],
                    blocking: true,
                    budget_secs: Some(10),
                    threshold: None,
                },
                Step {
                    name: "second".into(),
                    kind: StepKind::Run("true".into()),
                    on: vec![],
                    blocking: true,
                    budget_secs: Some(10),
                    threshold: None,
                },
            ],
        };
        let run = run(&pipeline, Trigger::Manual, &ctx(), std::path::Path::new("."));
        assert_eq!(run.steps.len(), 2);
        assert_eq!(run.steps[0].name, "first");
        assert_eq!(run.steps[1].name, "second");
        assert!(!run.blocked);
        assert_eq!(run.status, Status::Pass);
    }

    #[test]
    fn blocking_run_failure_blocks() {
        let pipeline = Pipeline {
            name: "t".into(),
            triggers: vec![Trigger::Manual],
            steps: vec![Step {
                name: "fails".into(),
                kind: StepKind::Run("false".into()),
                on: vec![],
                blocking: true,
                budget_secs: Some(10),
                threshold: None,
            }],
        };
        let run = run(&pipeline, Trigger::Manual, &ctx(), std::path::Path::new("."));
        assert_eq!(run.steps[0].status, Status::Fail);
        assert!(run.blocked);
    }

    #[test]
    fn advisory_run_failure_does_not_block() {
        let pipeline = Pipeline {
            name: "t".into(),
            triggers: vec![Trigger::Manual],
            steps: vec![Step {
                name: "advice".into(),
                kind: StepKind::Run("false".into()),
                on: vec![],
                blocking: false,
                budget_secs: Some(10),
                threshold: None,
            }],
        };
        let run = run(&pipeline, Trigger::Manual, &ctx(), std::path::Path::new("."));
        assert_eq!(run.steps[0].status, Status::Fail);
        assert!(!run.blocked, "advisory failure must not block");
        assert_eq!(run.status, Status::Pass);
    }

    #[test]
    fn unknown_gate_is_clean_skip() {
        let pipeline = Pipeline {
            name: "t".into(),
            triggers: vec![Trigger::Manual],
            steps: vec![Step {
                name: "mystery".into(),
                kind: StepKind::Gate("does-not-exist".into()),
                on: vec![],
                blocking: true,
                budget_secs: None,
                threshold: None,
            }],
        };
        let run = run(&pipeline, Trigger::Manual, &ctx(), std::path::Path::new("."));
        assert_eq!(run.steps[0].status, Status::Skip);
        assert!(!run.blocked, "unknown gate must never block");
    }

    #[test]
    fn trigger_filters_steps() {
        let pipeline = Pipeline {
            name: "t".into(),
            triggers: vec![Trigger::PreCommit, Trigger::PrePush],
            steps: vec![
                Step {
                    name: "commit-only".into(),
                    kind: StepKind::Run("true".into()),
                    on: vec![Trigger::PreCommit],
                    blocking: true,
                    budget_secs: Some(10),
                    threshold: None,
                },
                Step {
                    name: "push-only".into(),
                    kind: StepKind::Run("true".into()),
                    on: vec![Trigger::PrePush],
                    blocking: true,
                    budget_secs: Some(10),
                    threshold: None,
                },
            ],
        };
        let run = run(&pipeline, Trigger::PreCommit, &ctx(), std::path::Path::new("."));
        assert_eq!(run.steps.len(), 1);
        assert_eq!(run.steps[0].name, "commit-only");
    }
}
