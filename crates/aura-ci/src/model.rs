//! Semantic CI — the declarative pipeline model.
//!
//! A *pipeline* is a named, ordered list of *steps*, each of which is either a
//! `run` (an ordinary shell command, e.g. `cargo test`) or a `gate` (one of
//! Aura's semantic verbs — `no-secrets`, `no-stubs`, `goal-aligned`, `build`,
//! `taste`, `intent-match`). Pipelines fire on *triggers* (`pre-commit`,
//! `pre-push`, `pr`, `manual`) — the same hooks Aura already runs.
//!
//! These types are the single source of truth shared by the local hook path
//! (`aura ci run`) and the cloud workflow export (`aura ci export`). Everything
//! is `serde`-derived so a `PipelineRun` round-trips to JSON for the desktop
//! "Checks" surface and a `Pipeline` round-trips to/from `.aura/pipelines/*.toml`.

use serde::{Deserialize, Serialize};

/// When a pipeline (or a single step) is allowed to fire. A step with no
/// explicit `on` inherits its pipeline's triggers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Trigger {
    /// Git pre-commit hook — runs against the staged index. Cheap, blocking
    /// gates live here (secrets, half-finished code).
    PreCommit,
    /// Git pre-push hook — runs against the about-to-be-pushed range. The
    /// heavier `build` gate (cargo/tsc/go/mypy) lives here.
    PrePush,
    /// A pull request, in the cloud workflow. The exported GitHub Action runs
    /// the pipeline with this trigger against `base..head`.
    Pr,
    /// Run by hand (`aura ci run --trigger manual`) — fires every step
    /// regardless of its own `on`, for "show me everything right now".
    Manual,
}

impl Trigger {
    /// Parse a CLI/TOML trigger token. Accepts both kebab (`pre-commit`) and
    /// the short forms a human types (`pr`, `commit`, `push`).
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "pre-commit" | "precommit" | "commit" => Some(Trigger::PreCommit),
            "pre-push" | "prepush" | "push" => Some(Trigger::PrePush),
            "pr" | "pull-request" | "pullrequest" => Some(Trigger::Pr),
            "manual" | "run" => Some(Trigger::Manual),
            _ => None,
        }
    }

    /// The kebab token used in TOML + the exported YAML.
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::PreCommit => "pre-commit",
            Trigger::PrePush => "pre-push",
            Trigger::Pr => "pr",
            Trigger::Manual => "manual",
        }
    }
}

/// What a step actually does. Exactly one of these per `[[step]]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum StepKind {
    /// A semantic verb Aura already owns. The string is the gate id
    /// (`no-secrets`, `no-stubs`, `goal-aligned`, `build`, `taste`,
    /// `intent-match`). Resolved to a `Gate` impl by `gates::resolve`.
    Gate(String),
    /// An ordinary shell command, run verbatim. The runner (GitHub) provides
    /// the compute; Aura just orders + reports it.
    Run(String),
}

/// One declared step in a pipeline.
// No `Eq`: `threshold: Option<f64>` (f64 is not `Eq`). `PartialEq` is enough
// for the tests and for any caller that wants to compare steps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Step {
    /// Plain-language name shown in the "Checks" surface
    /// (e.g. "No half-finished code"). Falls back to the gate/command.
    pub name: String,
    /// Gate verb or shell command.
    pub kind: StepKind,
    /// Which triggers fire this step. Empty = inherit the pipeline's triggers.
    #[serde(default)]
    pub on: Vec<Trigger>,
    /// When `true`, a `Fail`/`Timeout` here fails the whole run (and the
    /// pre-commit/CI job). When `false`, the step is advisory — recorded,
    /// shown, but never blocks. Each gate carries a sensible default; the
    /// TOML can override it.
    pub blocking: bool,
    /// Wall-clock budget for this step in seconds. `None` = the gate's own
    /// default (e.g. `build` uses a 90s default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_secs: Option<u64>,
    /// Optional numeric threshold a gate interprets (e.g. `intent-match`
    /// minimum alignment score, 0.0–1.0). Ignored by gates that don't use it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
}

impl Step {
    /// Whether this step should fire for `trigger`. `Manual` fires every step.
    pub fn fires_on(&self, trigger: Trigger, pipeline_triggers: &[Trigger]) -> bool {
        if trigger == Trigger::Manual {
            return true;
        }
        if self.on.is_empty() {
            pipeline_triggers.contains(&trigger)
        } else {
            self.on.contains(&trigger)
        }
    }

    /// The gate id if this is a gate step, else `None`.
    pub fn gate_id(&self) -> Option<&str> {
        match &self.kind {
            StepKind::Gate(id) => Some(id.as_str()),
            StepKind::Run(_) => None,
        }
    }
}

/// A whole declared pipeline (one `.aura/pipelines/<file>.toml`, or the
/// built-in default when none is present).
// No `Eq`: transitively holds an `Option<f64>` via `Step`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pipeline {
    pub name: String,
    /// Triggers the pipeline as a whole responds to. A step with its own `on`
    /// narrows this further.
    #[serde(default, rename = "on")]
    pub triggers: Vec<Trigger>,
    #[serde(default, rename = "step")]
    pub steps: Vec<Step>,
}

impl Pipeline {
    /// The steps that should run for `trigger`, in declared order.
    pub fn steps_for(&self, trigger: Trigger) -> Vec<&Step> {
        self.steps
            .iter()
            .filter(|s| s.fires_on(trigger, &self.triggers))
            .collect()
    }
}

/// The verdict of a single step (or the whole run).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The gate/command succeeded.
    Pass,
    /// The gate/command found a problem.
    Fail,
    /// Not applicable / nothing to check (e.g. `build` on a repo with no
    /// recognized project type). Never blocks — it's a clean no-op.
    Skip,
    /// The step exceeded its budget and was killed.
    Timeout,
}

impl Status {
    /// Whether this status counts as a failure for a *blocking* step.
    pub fn is_failure(self) -> bool {
        matches!(self, Status::Fail | Status::Timeout)
    }

    /// The verdict glyph used by the human CLI output (mirrors GoalsPane).
    pub fn glyph(self) -> &'static str {
        match self {
            Status::Pass => "✓",
            Status::Fail => "✗",
            Status::Skip => "·",
            Status::Timeout => "⧖",
        }
    }
}

/// The recorded outcome of one step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepResult {
    /// The plain-language step name.
    pub name: String,
    /// `gate:<id>` or `run` — what kind of step produced this.
    pub kind: String,
    pub status: Status,
    /// Whether this step was blocking (so the surface can say "this one
    /// stopped the commit" vs "this one is just advice").
    pub blocking: bool,
    /// One-line plain-language summary ("No secrets in the staged code.").
    pub summary: String,
    /// Mechanism on demand: the command tail / failing nodes / stderr — shown
    /// only when a reader clicks to disclose. Never surfaced up front.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub duration_ms: u64,
}

impl StepResult {
    /// A skipped step — clean no-op, never blocks.
    pub fn skipped(name: &str, kind: &str, why: &str) -> Self {
        StepResult {
            name: name.to_string(),
            kind: kind.to_string(),
            status: Status::Skip,
            blocking: false,
            summary: why.to_string(),
            detail: None,
            duration_ms: 0,
        }
    }
}

/// The full result of running a pipeline once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PipelineRun {
    pub pipeline: String,
    pub trigger: Trigger,
    pub steps: Vec<StepResult>,
    /// The roll-up verdict: `Fail`/`Timeout` if any *blocking* step failed,
    /// else `Pass` (advisory failures don't sink the run).
    pub status: Status,
    /// True when a blocking step failed — the caller (pre-commit hook / CI
    /// job) must use this to set its exit code.
    pub blocked: bool,
    /// Plain-language headline for the surface:
    /// "Your safety checks ran — 4 passed, 1 needs a look."
    pub headline: String,
    pub duration_ms: u64,
}

impl PipelineRun {
    /// Compute the roll-up verdict + headline from the collected steps.
    pub fn finalize(pipeline: String, trigger: Trigger, steps: Vec<StepResult>, duration_ms: u64) -> Self {
        let blocked = steps
            .iter()
            .any(|s| s.blocking && s.status.is_failure());

        let passed = steps.iter().filter(|s| s.status == Status::Pass).count();
        let failed = steps.iter().filter(|s| s.status.is_failure()).count();
        let status = if blocked { Status::Fail } else { Status::Pass };

        let headline = headline_for(passed, failed, blocked);

        PipelineRun {
            pipeline,
            trigger,
            steps,
            status,
            blocked,
            headline,
            duration_ms,
        }
    }
}

/// Plain-language headline — the ADE audience is non-engineers. We say what
/// happened and whether it needs a look, never jargon.
fn headline_for(passed: usize, failed: usize, blocked: bool) -> String {
    if passed == 0 && failed == 0 {
        return "No safety checks ran for this step.".to_string();
    }
    if failed == 0 {
        let p = plural(passed, "check", "checks");
        return format!("Your safety checks ran — all {} {} passed.", passed, p);
    }
    let needs = if blocked {
        format!("{} stopped the commit", failed)
    } else {
        format!("{} {} a look", failed, plural(failed, "needs", "need"))
    };
    format!(
        "Your safety checks ran — {} passed, {}.",
        passed, needs
    )
}

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 {
        one
    } else {
        many
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_round_trip() {
        for t in [Trigger::PreCommit, Trigger::PrePush, Trigger::Pr, Trigger::Manual] {
            assert_eq!(Trigger::parse(t.as_str()), Some(t));
        }
        assert_eq!(Trigger::parse("commit"), Some(Trigger::PreCommit));
        assert_eq!(Trigger::parse("push"), Some(Trigger::PrePush));
        assert_eq!(Trigger::parse("nonsense"), None);
    }

    #[test]
    fn step_fires_on_inherits_pipeline_triggers() {
        let step = Step {
            name: "x".into(),
            kind: StepKind::Gate("no-secrets".into()),
            on: vec![],
            blocking: true,
            budget_secs: None,
            threshold: None,
        };
        // Inherits pipeline triggers when its own `on` is empty.
        assert!(step.fires_on(Trigger::PreCommit, &[Trigger::PreCommit]));
        assert!(!step.fires_on(Trigger::PrePush, &[Trigger::PreCommit]));
        // Manual fires everything.
        assert!(step.fires_on(Trigger::Manual, &[Trigger::PreCommit]));
    }

    #[test]
    fn step_own_on_overrides_pipeline() {
        let step = Step {
            name: "build".into(),
            kind: StepKind::Gate("build".into()),
            on: vec![Trigger::PrePush],
            blocking: true,
            budget_secs: None,
            threshold: None,
        };
        // Pipeline fires on pre-commit, but the step pins itself to pre-push.
        assert!(!step.fires_on(Trigger::PreCommit, &[Trigger::PreCommit]));
        assert!(step.fires_on(Trigger::PrePush, &[Trigger::PreCommit]));
    }

    #[test]
    fn finalize_blocks_only_on_blocking_failure() {
        let steps = vec![
            StepResult {
                name: "secrets".into(),
                kind: "gate:no-secrets".into(),
                status: Status::Pass,
                blocking: true,
                summary: "ok".into(),
                detail: None,
                duration_ms: 1,
            },
            StepResult {
                name: "goal".into(),
                kind: "gate:goal-aligned".into(),
                status: Status::Fail,
                blocking: false, // advisory
                summary: "not wired".into(),
                detail: None,
                duration_ms: 1,
            },
        ];
        let run = PipelineRun::finalize("default".into(), Trigger::PreCommit, steps, 2);
        // Advisory failure must NOT block.
        assert!(!run.blocked);
        assert_eq!(run.status, Status::Pass);
    }

    #[test]
    fn finalize_blocks_on_blocking_failure() {
        let steps = vec![StepResult {
            name: "secrets".into(),
            kind: "gate:no-secrets".into(),
            status: Status::Fail,
            blocking: true,
            summary: "secret found".into(),
            detail: None,
            duration_ms: 1,
        }];
        let run = PipelineRun::finalize("default".into(), Trigger::PreCommit, steps, 1);
        assert!(run.blocked);
        assert_eq!(run.status, Status::Fail);
    }
}
