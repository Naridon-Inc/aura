//! The declared state, turned into the ordered work that realises it.
//!
//! ## The order is the design
//!
//! ```text
//!   preflight  →  toolchain  →  package  →  deps  →  service
//! ```
//!
//! Each stage is the ground the next one stands on. A package manager has to
//! exist before it can install anything; a toolchain has to exist before the
//! packages that assume it; `npm ci` needs the Node the toolchain stage pinned;
//! and a service is started last because starting a database before the code
//! that migrates it is how you get a half-initialised one.
//!
//! Preflight is its own stage rather than a hidden part of each install for one
//! reason: the message. A box without `mise` fails every toolchain entry with a
//! shell's `mise: not found` buried in the output of a command that looked like
//! it was about Node. As a step of its own it reads "this place has no `mise`,
//! which the spec needs" — one line, once, naming the actual problem.
//!
//! ## Scope
//!
//! [`Scope::Environment`] is the machine's own state — toolchains, packages,
//! services. [`Scope::Full`] adds the project's dependency manifests via
//! `[worktree] setup`. The split exists because those two have very different
//! costs to re-run: asking `brew` whether it has ripgrep is milliseconds, and
//! `npm ci` is not. A fresh worktree wants `Full`; a box being re-converged
//! every hour usually wants `Environment`.

use crate::managers::{package_commands, toolchain_commands, sq, UnknownManager};
use crate::spec::EnvSpec;

/// Which layers to realise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Toolchains, packages and services — what the machine itself must be.
    Environment,
    /// The above plus `[worktree] setup`, the project's own dependency install.
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Preflight,
    Toolchain,
    Package,
    Deps,
    Service,
}

impl StepKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            StepKind::Preflight => "preflight",
            StepKind::Toolchain => "toolchain",
            StepKind::Package => "package",
            StepKind::Deps => "deps",
            StepKind::Service => "service",
        }
    }
}

/// One thing the place must be, and how to ask and how to make it so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    /// Stable across runs and machines, so two reports can be compared.
    pub id: String,
    /// One line a person reads.
    pub title: String,
    pub kind: StepKind,
    /// Exits 0 when the place is already like this. `None` means "always do it".
    pub check: Option<String>,
    /// Makes it so. `None` means the spec described a state without saying how
    /// to reach it — the step can report, never fix.
    pub apply: Option<String>,
    /// Re-asked after `apply`, polled up to `wait_secs`. Defaults to `check`.
    pub verify: Option<String>,
    /// How long to keep re-asking `verify`. Only services need this: an install
    /// is done when its command exits, a database is not.
    pub wait_secs: u32,
}

impl Step {
    /// What to ask after applying — the explicit verify, else the check.
    pub fn verify_command(&self) -> Option<&str> {
        self.verify.as_deref().or(self.check.as_deref())
    }
}

/// An ordered plan, bound to the spec revision and digest it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// `[env] version` — the project's own revision number.
    pub version: u32,
    /// `sha256:…` of the spec these steps realise.
    pub digest: String,
    pub steps: Vec<Step>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    Manager(UnknownManager),
    Digest(String),
}

impl std::fmt::Display for PlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PlanError::Manager(e) => write!(f, "{e}"),
            PlanError::Digest(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for PlanError {}

/// PURE: the spec → the ordered steps that bring a place to it.
pub fn plan(spec: &EnvSpec, scope: Scope) -> Result<Plan, PlanError> {
    let mut steps: Vec<Step> = Vec::new();
    let mut later: Vec<Step> = Vec::new();
    // Preflight binaries, in first-need order and without repeats — one
    // `command -v mise` however many tools it provides.
    let mut needs: Vec<String> = Vec::new();

    let manager = spec.toolchain.manager.as_deref();
    for t in &spec.toolchain.tools {
        let d = toolchain_commands(manager, t).map_err(PlanError::Manager)?;
        if let Some(bin) = d.needs {
            if !needs.contains(&bin) {
                needs.push(bin);
            }
        }
        later.push(Step {
            id: format!("toolchain:{}", t.name),
            title: format!("{} {}", t.name, t.version),
            kind: StepKind::Toolchain,
            check: d.check,
            apply: d.apply,
            verify: None,
            wait_secs: 0,
        });
    }

    for p in &spec.packages {
        let d = package_commands(p).map_err(PlanError::Manager)?;
        if let Some(bin) = d.needs {
            if !needs.contains(&bin) {
                needs.push(bin);
            }
        }
        let scope_note = if p.global { "" } else { " (this project)" };
        later.push(Step {
            id: format!("package:{}/{}", p.manager, p.name),
            title: match &p.version {
                Some(v) => format!("{} {} via {}{}", p.name, v, p.manager, scope_note),
                None => format!("{} via {}{}", p.name, p.manager, scope_note),
            },
            kind: StepKind::Package,
            check: d.check,
            apply: d.apply,
            verify: None,
            wait_secs: 0,
        });
    }

    for bin in &needs {
        steps.push(Step {
            id: format!("preflight:{bin}"),
            title: format!("{bin} is available here"),
            kind: StepKind::Preflight,
            check: Some(format!("command -v {} >/dev/null 2>&1", sq(bin))),
            // Deliberately unfixable. Installing a package manager is a
            // decision about the machine, not about this project, and a spec
            // that quietly put Homebrew on someone's box would be a spec nobody
            // should sign.
            apply: None,
            verify: None,
            wait_secs: 0,
        });
    }
    steps.append(&mut later);

    if scope == Scope::Full {
        if let Some(cmd) = spec.lifecycle.setup.as_deref() {
            steps.push(Step {
                id: "deps:setup".into(),
                // Named by what it is, not by what it runs. A project's setup
                // line is routinely three commands joined by `&&`, and pasting
                // it into the title pushes every other step's column off the
                // screen to say something the step's `apply` already holds —
                // and which a failure quotes back verbatim anyway.
                title: "project dependencies".into(),
                kind: StepKind::Deps,
                // No check: `[worktree] setup` is the project's own command and
                // only the project knows when it is satisfied. Asking it to run
                // is the contract it has always had.
                check: None,
                apply: Some(cmd.to_string()),
                verify: None,
                wait_secs: 0,
            });
        }
    }

    for s in &spec.services {
        steps.push(Step {
            id: format!("service:{}", s.name),
            title: format!("{} running", s.name),
            kind: StepKind::Service,
            // The readiness probe IS the question "is this already up?", so a
            // service that is already serving costs one probe and no restart.
            check: s.ready.clone(),
            apply: Some(s.start.clone()),
            verify: s.ready.clone(),
            wait_secs: if s.ready.is_some() { s.wait_secs } else { 0 },
        });
    }

    Ok(Plan {
        version: spec.version,
        digest: spec.digest().map_err(PlanError::Digest)?,
        steps,
    })
}

/// PURE: the teardown commands, in reverse of the order that brought them up.
///
/// Services stop before `[worktree] archive` runs, because archive is where a
/// project puts its own cleanup and it should find the world still standing.
pub fn teardown(spec: &EnvSpec) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = spec
        .services
        .iter()
        .rev()
        .filter_map(|s| s.stop.clone().map(|c| (format!("service:{}", s.name), c)))
        .collect();
    if let Some(a) = spec.lifecycle.archive.as_deref() {
        out.push(("archive".into(), a.to_string()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::parse_spec;

    #[test]
    fn no_step_is_titled_by_a_command_that_could_run_off_the_line() {
        // Every title is a name a person reads in a column next to three
        // others. A project's `setup` is the one input here with no length
        // bound at all, so a three-command line must not become a title.
        let spec = parse_spec(
            "[worktree]\nsetup = \"npm ci && cargo build --release && ./scripts/seed.sh\"\n",
        )
        .expect("a spec");
        let p = plan(&spec, Scope::Full).expect("a plan");
        for step in &p.steps {
            assert!(
                step.title.chars().count() <= 34,
                "{:?} is too long to sit in a column",
                step.title
            );
        }
        let deps = p.steps.iter().find(|s| s.id == "deps:setup").expect("deps");
        assert_eq!(deps.title, "project dependencies");
        // The command is not lost — it is what the step actually runs.
        assert!(deps.apply.as_deref().unwrap().contains("seed.sh"));
    }

    const DOC: &str = r#"
[env]
version = 3

[env.toolchain]
manager = "mise"
node = "20.11.0"

[[env.package]]
manager = "cargo"
name = "cargo-nextest"

[[env.package]]
manager = "cargo"
name = "cargo-deny"

[[env.service]]
name  = "postgres"
start = "docker compose up -d db"
ready = "pg_isready"
stop  = "docker compose down"

[worktree]
setup   = "npm ci"
archive = "rm -rf .cache"
"#;

    fn kinds(p: &Plan) -> Vec<StepKind> {
        p.steps.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn the_stages_come_in_the_only_order_that_works() {
        let p = plan(&parse_spec(DOC).unwrap(), Scope::Full).unwrap();
        assert_eq!(
            kinds(&p),
            vec![
                StepKind::Preflight, // mise
                StepKind::Preflight, // cargo
                StepKind::Toolchain,
                StepKind::Package,
                StepKind::Package,
                StepKind::Deps,
                StepKind::Service,
            ]
        );
    }

    #[test]
    fn one_preflight_per_binary_however_many_entries_need_it() {
        let p = plan(&parse_spec(DOC).unwrap(), Scope::Full).unwrap();
        let pre: Vec<_> = p
            .steps
            .iter()
            .filter(|s| s.kind == StepKind::Preflight)
            .map(|s| s.id.as_str())
            .collect();
        assert_eq!(pre, vec!["preflight:mise", "preflight:cargo"]);
    }

    #[test]
    fn a_preflight_reports_and_never_installs_a_package_manager() {
        let p = plan(&parse_spec(DOC).unwrap(), Scope::Full).unwrap();
        let pre = p.steps.iter().find(|s| s.kind == StepKind::Preflight).unwrap();
        assert!(pre.check.is_some());
        assert!(pre.apply.is_none());
    }

    #[test]
    fn environment_scope_leaves_the_project_manifests_alone() {
        let p = plan(&parse_spec(DOC).unwrap(), Scope::Environment).unwrap();
        assert!(!kinds(&p).contains(&StepKind::Deps));
        assert!(kinds(&p).contains(&StepKind::Service));
    }

    #[test]
    fn a_service_checks_by_asking_whether_it_is_already_serving() {
        let p = plan(&parse_spec(DOC).unwrap(), Scope::Full).unwrap();
        let svc = p.steps.iter().find(|s| s.kind == StepKind::Service).unwrap();
        assert_eq!(svc.check.as_deref(), Some("pg_isready"));
        assert_eq!(svc.verify_command(), Some("pg_isready"));
        assert_eq!(svc.wait_secs, 60);
    }

    #[test]
    fn a_service_with_no_readiness_probe_is_started_and_not_polled() {
        let spec = parse_spec("[[env.service]]\nname=\"x\"\nstart=\"up\"\n").unwrap();
        let p = plan(&spec, Scope::Full).unwrap();
        assert!(p.steps[0].check.is_none());
        assert_eq!(p.steps[0].wait_secs, 0);
        assert!(p.steps[0].verify_command().is_none());
    }

    #[test]
    fn the_plan_carries_the_revision_and_digest_it_realises() {
        let spec = parse_spec(DOC).unwrap();
        let p = plan(&spec, Scope::Full).unwrap();
        assert_eq!(p.version, 3);
        assert_eq!(p.digest, spec.digest().unwrap());
    }

    #[test]
    fn a_project_that_declares_nothing_gets_no_steps() {
        let p = plan(&EnvSpec::default(), Scope::Full).unwrap();
        assert!(p.is_empty());
    }

    #[test]
    fn an_unresolvable_entry_fails_the_plan_rather_than_being_skipped() {
        let spec = parse_spec("[[env.package]]\nmanager=\"nix\"\nname=\"rg\"\n").unwrap();
        let err = plan(&spec, Scope::Full).unwrap_err();
        assert!(err.to_string().contains("nix"), "{err}");
    }

    #[test]
    fn teardown_runs_services_down_before_the_projects_own_archive() {
        let t = teardown(&parse_spec(DOC).unwrap());
        assert_eq!(
            t,
            vec![
                ("service:postgres".into(), "docker compose down".into()),
                ("archive".into(), "rm -rf .cache".into()),
            ]
        );
    }

    #[test]
    fn teardown_reverses_the_order_services_came_up_in() {
        let doc = r#"
[[env.service]]
name = "db"
start = "up db"
stop = "down db"

[[env.service]]
name = "cache"
start = "up cache"
stop = "down cache"
"#;
        let t = teardown(&parse_spec(doc).unwrap());
        assert_eq!(t[0].0, "service:cache");
        assert_eq!(t[1].0, "service:db");
    }
}
