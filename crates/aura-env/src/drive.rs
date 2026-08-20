//! The pump: which command next, and what its answer meant.
//!
//! ## Why this is not a function that takes a closure
//!
//! There are two callers and they are shaped differently. The CLI runs commands
//! with [`std::process::Command`] and blocks. The desktop app runs them through
//! `Place::sh`, which is `async` and may be crossing an ssh connection. A single
//! `fn apply(plan, run: impl Fn(&str) -> i32)` serves the first and not the
//! second; an async trait serves the second and drags a runtime into the first;
//! two loops serve both and start disagreeing the first time one of them learns
//! something — which is exactly the failure this whole programme exists to stop.
//!
//! So the loop is inverted. [`Run::next`] hands out one command, the caller runs
//! it however it runs things, [`Run::answer`] takes the exit code back. All the
//! judgement — the order, whether a check means skip, how long to keep asking a
//! database if it is ready yet, what counts as failure — lives here, once, and
//! is unit-testable without spawning a single process.
//!
//! ## What a step can end up as
//!
//! * [`StepState::AlreadyAtSpec`] — the check passed; nothing was run.
//! * [`StepState::Brought`] — it was applied and then verified.
//! * [`StepState::Unsatisfied`] — the place is not like this and the spec did
//!   not say how to make it so. A pinned toolchain with no manager, or a missing
//!   `brew`. Not a crash and not a success: a fact to report.
//! * [`StepState::Failed`] — a command ran and did not work.
//!
//! The distinction between the last two is the useful one. "Postgres wouldn't
//! start" and "this box doesn't have mise and nothing here can give it one" send
//! you to entirely different places, and a run that flattens both into `false`
//! sends you to neither.

use serde::{Deserialize, Serialize};

use crate::lock::TrustState;
use crate::plan::{Plan, Step, StepKind};
use crate::spec::SPEC_SCHEMA;

/// How often to re-ask a service whether it is ready.
const POLL_MS: u64 = 2_000;
/// How much of a command's output to keep on a failure. Enough to read the
/// error, not enough to turn a report into a log file.
const DETAIL_MAX: usize = 400;

/// Which question is being asked of a step right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Is the place already like this?
    Check,
    /// Make it so.
    Apply,
    /// Is it so now?
    Verify,
}

/// One command to run somewhere, with enough context to narrate it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    /// 0-based position of the step in the plan, for progress.
    pub index: usize,
    pub total: usize,
    pub step_id: String,
    pub title: String,
    pub kind: StepKind,
    pub phase: Phase,
    pub command: String,
    /// Wait this long before running. Non-zero only when re-asking a service
    /// whether it has come up — the caller sleeps, because only the caller
    /// knows whether it is allowed to block a thread or must yield.
    pub delay_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    AlreadyAtSpec,
    Brought,
    Unsatisfied,
    Failed,
}

impl StepState {
    /// Is the place at spec for this step, however it got there?
    pub fn is_met(&self) -> bool {
        matches!(self, StepState::AlreadyAtSpec | StepState::Brought)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepOutcome {
    pub id: String,
    pub title: String,
    pub kind: StepKind,
    pub state: StepState,
    /// Exit code of the command that decided it; 0 when nothing ran.
    pub code: i32,
    /// What the failing command said, trimmed. Empty on success.
    pub detail: String,
}

/// What happened when a place was brought to a spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvReport {
    pub schema: String,
    /// `[env] version` the place was brought to.
    pub version: u32,
    pub digest: String,
    /// Whether the spec that was applied was one anyone should have trusted.
    pub trust: TrustState,
    pub steps: Vec<StepOutcome>,
    /// Every step met.
    pub at_spec: bool,
    /// Something on this place actually changed.
    pub changed: bool,
}

impl EnvReport {
    /// One line for a human.
    pub fn summary(&self) -> String {
        if self.steps.is_empty() {
            return "nothing declared".into();
        }
        let met = self.steps.iter().filter(|s| s.state.is_met()).count();
        let brought = self
            .steps
            .iter()
            .filter(|s| s.state == StepState::Brought)
            .count();
        if self.at_spec {
            if brought == 0 {
                format!("already at spec v{} ({} checks)", self.version, met)
            } else {
                format!("brought to spec v{} ({brought} changed)", self.version)
            }
        } else {
            let short: Vec<&str> = self
                .steps
                .iter()
                .filter(|s| !s.state.is_met())
                .map(|s| s.title.as_str())
                .collect();
            format!("not at spec v{}: {}", self.version, short.join(", "))
        }
    }

    /// The steps that stop this place being at spec.
    pub fn shortfalls(&self) -> Vec<&StepOutcome> {
        self.steps.iter().filter(|s| !s.state.is_met()).collect()
    }
}

/// Where a step is in its check → apply → verify sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cursor {
    Check,
    Apply,
    Verify,
}

/// A plan part-way through being realised.
#[derive(Debug, Clone)]
pub struct Run {
    plan: Plan,
    ix: usize,
    cursor: Cursor,
    /// Verify attempts left for the current step.
    polls_left: u32,
    /// Set once the first verify has been asked, so the second waits.
    verified_once: bool,
    /// The (step, phase) a command was handed out for. Guards against an answer
    /// arriving for a question nobody asked.
    pending: Option<(usize, Phase)>,
    /// Ask, never act.
    observe: bool,
    outcomes: Vec<StepOutcome>,
}

impl Run {
    /// A run that brings the place to spec.
    pub fn new(plan: Plan) -> Self {
        Run {
            plan,
            ix: 0,
            cursor: Cursor::Check,
            polls_left: 0,
            verified_once: false,
            pending: None,
            observe: false,
            outcomes: Vec::new(),
        }
    }

    /// A run that only asks: every check still runs, nothing is ever applied,
    /// and each shortfall records the command that would have fixed it.
    ///
    /// This is how a surface says "this box is two versions behind" without
    /// deciding, on the user's behalf and in the middle of a page render, to
    /// spend four minutes installing a toolchain.
    pub fn observing(plan: Plan) -> Self {
        Run {
            observe: true,
            ..Run::new(plan)
        }
    }

    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    /// The next command to run, or `None` when the plan is done.
    ///
    /// Steps with nothing left to ask are settled in here rather than in
    /// `answer`, so a caller that only ever calls `next` until it returns `None`
    /// still gets a complete report.
    pub fn next(&mut self) -> Option<Ask> {
        loop {
            let total = self.plan.steps.len();
            let step = self.plan.steps.get(self.ix)?.clone();
            match self.cursor {
                Cursor::Check => match step.check.clone() {
                    Some(cmd) => return Some(self.hand_out(&step, Phase::Check, cmd, 0, total)),
                    None => self.cursor = Cursor::Apply,
                },
                Cursor::Apply => match step.apply.clone() {
                    Some(cmd) if self.observe => {
                        self.settle(&step, StepState::Unsatisfied, 0, format!("would run: {cmd}"))
                    }
                    Some(cmd) => return Some(self.hand_out(&step, Phase::Apply, cmd, 0, total)),
                    None => {
                        // The place is not like this and nothing here can change
                        // that. Say so and move on — a spec is allowed to
                        // describe more than it can install.
                        self.settle(&step, StepState::Unsatisfied, 0, unsatisfied_detail(&step));
                    }
                },
                Cursor::Verify => match step.verify_command().map(str::to_string) {
                    Some(cmd) => {
                        let delay = if self.verified_once { POLL_MS } else { 0 };
                        self.verified_once = true;
                        return Some(self.hand_out(&step, Phase::Verify, cmd, delay, total));
                    }
                    // Applied, and nothing to check it against. The command
                    // exiting 0 is all the evidence available.
                    None => self.settle(&step, StepState::Brought, 0, String::new()),
                },
            }
        }
    }

    /// Feed back what the last [`Run::next`] command did.
    ///
    /// `detail` is whatever the command said; it is kept only when it explains
    /// a failure. An answer that does not match the outstanding question is
    /// ignored, so a caller that loses track cannot corrupt the report.
    pub fn answer(&mut self, code: i32, detail: &str) {
        let Some((ix, phase)) = self.pending.take() else {
            return;
        };
        if ix != self.ix {
            return;
        }
        let Some(step) = self.plan.steps.get(self.ix).cloned() else {
            return;
        };
        let ok = code == 0;
        match phase {
            Phase::Check => {
                if ok {
                    self.settle(&step, StepState::AlreadyAtSpec, 0, String::new());
                } else {
                    self.cursor = Cursor::Apply;
                }
            }
            Phase::Apply => {
                if ok {
                    self.cursor = Cursor::Verify;
                    self.verified_once = false;
                    self.polls_left = poll_budget(step.wait_secs);
                } else {
                    self.settle(&step, StepState::Failed, code, trim(detail));
                }
            }
            Phase::Verify => {
                if ok {
                    self.settle(&step, StepState::Brought, 0, String::new());
                } else {
                    self.polls_left = self.polls_left.saturating_sub(1);
                    if self.polls_left == 0 {
                        let detail = if step.wait_secs > 0 {
                            format!(
                                "started, but still not ready after {}s: {}",
                                step.wait_secs,
                                trim(detail)
                            )
                        } else {
                            trim(detail)
                        };
                        self.settle(&step, StepState::Failed, code, detail);
                    }
                }
            }
        }
    }

    /// Seal the run. `trust` is passed in because whether the spec should have
    /// been applied at all is the caller's question, asked before any of this
    /// started — and a report that did not have to state its answer is a report
    /// that could quietly describe an unsigned spec being applied.
    pub fn finish(self, trust: TrustState) -> EnvReport {
        let at_spec = self.outcomes.iter().all(|o| o.state.is_met());
        let changed = self
            .outcomes
            .iter()
            .any(|o| o.state == StepState::Brought);
        EnvReport {
            schema: SPEC_SCHEMA.to_string(),
            version: self.plan.version,
            digest: self.plan.digest,
            trust,
            steps: self.outcomes,
            at_spec,
            changed,
        }
    }

    fn hand_out(
        &mut self,
        step: &Step,
        phase: Phase,
        command: String,
        delay_ms: u64,
        total: usize,
    ) -> Ask {
        self.pending = Some((self.ix, phase));
        Ask {
            index: self.ix,
            total,
            step_id: step.id.clone(),
            title: step.title.clone(),
            kind: step.kind,
            phase,
            command,
            delay_ms,
        }
    }

    fn settle(&mut self, step: &Step, state: StepState, code: i32, detail: String) {
        self.outcomes.push(StepOutcome {
            id: step.id.clone(),
            title: step.title.clone(),
            kind: step.kind,
            state,
            code,
            detail,
        });
        self.ix += 1;
        self.cursor = Cursor::Check;
        self.polls_left = 0;
        self.verified_once = false;
        self.pending = None;
    }
}

/// How many times to ask a service if it is ready. At least once, so a
/// zero-wait service still gets its answer read.
fn poll_budget(wait_secs: u32) -> u32 {
    let per_poll = (POLL_MS / 1000) as u32;
    (wait_secs / per_poll).max(1)
}

fn unsatisfied_detail(step: &Step) -> String {
    match step.kind {
        StepKind::Preflight => format!(
            "{} — install it on this machine, or give the entries that need it their own `install`",
            step.title
        ),
        StepKind::Toolchain => {
            "pinned, but the spec doesn't say how to obtain it — set `[env.toolchain] manager`, or give the tool its own `install`".into()
        }
        _ => "the spec describes this state but not how to reach it".into(),
    }
}

fn trim(s: &str) -> String {
    let s = s.trim();
    if s.len() <= DETAIL_MAX {
        return s.to_string();
    }
    let mut cut = DETAIL_MAX;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{plan, Scope};
    use crate::parse::parse_spec;

    /// Drive a whole plan against a canned answerer: `(code, output)` per
    /// command, chosen by looking at the command text.
    fn drive(p: Plan, mut answer: impl FnMut(&Ask) -> (i32, String)) -> EnvReport {
        let mut run = Run::new(p);
        let mut guard = 0;
        while let Some(ask) = run.next() {
            guard += 1;
            assert!(guard < 500, "the pump did not terminate");
            let (code, out) = answer(&ask);
            run.answer(code, &out);
        }
        run.finish(TrustState::Unsigned)
    }

    fn spec_doc() -> Plan {
        let doc = r#"
[env.toolchain]
manager = "mise"
node = "20.11.0"

[[env.package]]
manager = "cargo"
name = "cargo-nextest"

[[env.service]]
name  = "postgres"
start = "compose up"
ready = "pg_isready"
wait_secs = 6

[worktree]
setup = "npm ci"
"#;
        plan(&parse_spec(doc).unwrap(), Scope::Full).unwrap()
    }

    #[test]
    fn a_place_already_at_spec_runs_nothing_but_checks() {
        let mut applied = Vec::new();
        let report = drive(spec_doc(), |ask| {
            if ask.phase == Phase::Apply {
                applied.push(ask.command.clone());
            }
            (0, String::new())
        });
        // `deps:setup` has no check, so it is the one thing that always runs.
        assert_eq!(applied, vec!["npm ci".to_string()]);
        assert!(report.at_spec);
        assert!(report.changed, "npm ci ran");
        assert_eq!(
            report
                .steps
                .iter()
                .filter(|s| s.state == StepState::AlreadyAtSpec)
                .count(),
            5
        );
        assert!(report.summary().contains("brought to spec"));
    }

    #[test]
    fn a_failing_check_leads_to_an_apply_and_then_a_verify() {
        let mut seen = Vec::new();
        let report = drive(spec_doc(), |ask| {
            seen.push((ask.step_id.clone(), ask.phase));
            // Only the package is missing, and installing it works.
            let missing = ask.step_id == "package:cargo/cargo-nextest";
            match (missing, ask.phase) {
                (true, Phase::Check) => (1, "not installed".into()),
                _ => (0, String::new()),
            }
        });
        let pkg: Vec<_> = seen
            .iter()
            .filter(|(id, _)| id == "package:cargo/cargo-nextest")
            .map(|(_, p)| *p)
            .collect();
        assert_eq!(pkg, vec![Phase::Check, Phase::Apply, Phase::Verify]);
        // The verify re-runs the check, which now passes.
        assert!(report.at_spec, "{:?}", report.shortfalls());
    }

    #[test]
    fn a_check_that_never_passes_after_a_successful_install_is_a_failure() {
        let report = drive(spec_doc(), |ask| match ask.step_id.as_str() {
            // Install reports success; the tool still is not there.
            "package:cargo/cargo-nextest" if ask.phase != Phase::Apply => (1, "absent".into()),
            _ => (0, String::new()),
        });
        assert!(!report.at_spec);
        let bad = report.shortfalls();
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0].state, StepState::Failed);
    }

    #[test]
    fn a_failed_install_stops_that_step_and_not_the_run() {
        let report = drive(spec_doc(), |ask| match (ask.step_id.as_str(), ask.phase) {
            ("package:cargo/cargo-nextest", Phase::Check) => (1, String::new()),
            ("package:cargo/cargo-nextest", Phase::Apply) => (101, "network unreachable".into()),
            _ => (0, String::new()),
        });
        assert!(!report.at_spec);
        // Every other step still got its turn.
        assert_eq!(report.steps.len(), 6);
        let failed = report
            .steps
            .iter()
            .find(|s| s.id == "package:cargo/cargo-nextest")
            .unwrap();
        assert_eq!(failed.state, StepState::Failed);
        assert_eq!(failed.code, 101);
        assert_eq!(failed.detail, "network unreachable");
    }

    #[test]
    fn a_service_is_polled_until_it_is_ready_and_the_caller_is_told_to_wait() {
        let mut probes = 0;
        let mut delays = Vec::new();
        let report = drive(spec_doc(), |ask| {
            if ask.step_id != "service:postgres" {
                return (0, String::new());
            }
            match ask.phase {
                Phase::Check => (1, "no server".into()),
                Phase::Apply => (0, String::new()),
                Phase::Verify => {
                    probes += 1;
                    delays.push(ask.delay_ms);
                    // Comes up on the third probe.
                    if probes >= 3 {
                        (0, String::new())
                    } else {
                        (1, "connection refused".into())
                    }
                }
            }
        });
        assert_eq!(probes, 3);
        // First probe immediate, then paced.
        assert_eq!(delays, vec![0, POLL_MS, POLL_MS]);
        assert!(report.at_spec);
    }

    #[test]
    fn a_service_that_never_comes_up_fails_saying_how_long_it_was_given() {
        let report = drive(spec_doc(), |ask| {
            if ask.step_id == "service:postgres" && ask.phase != Phase::Apply {
                (1, "connection refused".into())
            } else {
                (0, String::new())
            }
        });
        let svc = report
            .steps
            .iter()
            .find(|s| s.id == "service:postgres")
            .unwrap();
        assert_eq!(svc.state, StepState::Failed);
        assert!(svc.detail.contains("still not ready after 6s"), "{}", svc.detail);
        // wait_secs 6 at a 2s poll = 3 attempts.
        assert!(svc.detail.contains("connection refused"));
    }

    #[test]
    fn a_missing_preflight_binary_is_unsatisfied_not_failed() {
        let report = drive(spec_doc(), |ask| {
            if ask.step_id == "preflight:mise" {
                (1, String::new())
            } else {
                (0, String::new())
            }
        });
        let pre = report
            .steps
            .iter()
            .find(|s| s.id == "preflight:mise")
            .unwrap();
        assert_eq!(pre.state, StepState::Unsatisfied);
        assert!(pre.detail.contains("install it on this machine"), "{}", pre.detail);
        assert!(!report.at_spec);
        assert!(report.summary().starts_with("not at spec"), "{}", report.summary());
    }

    #[test]
    fn a_pinned_toolchain_with_no_manager_reports_rather_than_pretends() {
        let spec = parse_spec("[env.toolchain]\nnode = \"20.11.0\"\n").unwrap();
        let report = drive(plan(&spec, Scope::Full).unwrap(), |_| (1, "v18.2.0".into()));
        assert_eq!(report.steps[0].state, StepState::Unsatisfied);
        assert!(report.steps[0].detail.contains("manager"), "{}", report.steps[0].detail);
        assert!(!report.at_spec);
    }

    #[test]
    fn an_empty_plan_finishes_at_spec_and_unchanged() {
        let report = drive(
            plan(&crate::spec::EnvSpec::default(), Scope::Full).unwrap(),
            |_| (0, String::new()),
        );
        assert!(report.at_spec);
        assert!(!report.changed);
        assert_eq!(report.summary(), "nothing declared");
    }

    #[test]
    fn a_check_only_run_never_installs_anything() {
        // Every check fails; nothing has an apply because the caller only asked
        // for the environment layer of a spec that pins without a manager.
        let spec = parse_spec("[env.toolchain]\nnode = \"20.11.0\"\nbun = \"1.1.0\"\n").unwrap();
        let mut applies = 0;
        drive(plan(&spec, Scope::Environment).unwrap(), |ask| {
            if ask.phase == Phase::Apply {
                applies += 1;
            }
            (1, String::new())
        });
        assert_eq!(applies, 0);
    }

    #[test]
    fn an_observing_run_asks_every_check_and_changes_nothing() {
        let mut run = Run::observing(spec_doc());
        let mut asked = Vec::new();
        while let Some(ask) = run.next() {
            assert_eq!(ask.phase, Phase::Check, "an observer never applies");
            asked.push(ask.step_id.clone());
            run.answer(1, "no"); // nothing on this place is at spec
        }
        let report = run.finish(TrustState::Unsigned);
        assert!(!report.at_spec);
        assert!(!report.changed, "an observation is not a change");
        // `deps:setup` has no check to ask, so it is reported without a probe.
        assert_eq!(asked.len(), 5);
        assert_eq!(report.steps.len(), 6);
        let deps = report.steps.iter().find(|s| s.id == "deps:setup").unwrap();
        assert_eq!(deps.state, StepState::Unsatisfied);
        assert_eq!(deps.detail, "would run: npm ci");
    }

    #[test]
    fn an_observing_run_still_reports_a_place_that_is_already_at_spec() {
        let mut run = Run::observing(spec_doc());
        while run.next().is_some() {
            run.answer(0, "");
        }
        let report = run.finish(TrustState::Unsigned);
        // Only `deps:setup` is unknowable without running it.
        assert_eq!(report.shortfalls().len(), 1);
        assert!(!report.changed);
    }

    #[test]
    fn an_answer_to_a_question_nobody_asked_is_ignored() {
        let mut run = Run::new(spec_doc());
        run.answer(0, "stray"); // before any next()
        assert!(run.plan().steps.len() > 1);
        let first = run.next().unwrap();
        run.answer(0, "");
        run.answer(0, ""); // duplicate for the same ask
        let second = run.next().unwrap();
        assert_ne!(first.step_id, second.step_id);
    }

    #[test]
    fn long_failure_output_is_trimmed_at_a_char_boundary() {
        let noisy = "é".repeat(1_000);
        let out = trim(&noisy);
        assert!(out.len() <= DETAIL_MAX + 4);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn a_report_serializes_for_the_surfaces_that_show_it() {
        let report = drive(spec_doc(), |_| (0, String::new()));
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["schema"], SPEC_SCHEMA);
        assert_eq!(v["trust"]["state"], "unsigned");
        assert!(v["steps"].as_array().unwrap().len() >= 5);
    }
}
