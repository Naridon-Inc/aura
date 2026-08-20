//! What a place has, set against what the project asks it for.
//!
//! ## The bug this is against
//!
//! "It works on my machine." Two places, one project, one of them fails, and the
//! only way anybody has ever found out why is by sitting down on both and typing
//! `command -v` until something differs. Everything needed to answer it in one
//! call already existed and was in two halves that had never been introduced:
//!
//! * [`Place::capabilities`] knows what a place actually HAS — the agent CLIs,
//!   git, tmux, aura — off one `command -v` probe either mode can be sent.
//! * [`Place::env_state`] knows what the project ASKS FOR — the toolchains,
//!   packages and services declared in `.aura/settings.toml` — and whether each
//!   is satisfied.
//!
//! Neither is the answer on its own. The probe cannot say a missing binary was
//! ever wanted, and the spec cannot say what a place has that nobody declared —
//! which is exactly where "works here, not there" lives, because the thing that
//! differs between two boxes is almost always the thing nobody wrote down.
//! Joined, they are a diff.
//!
//! ## The four standings, and why "extra" is one of them
//!
//! | | asked for | not asked for |
//! |---|---|---|
//! | **here** | [`Standing::Present`] | [`Standing::Unasked`] |
//! | **not here** | [`Standing::Missing`] | *no line at all* |
//!
//! The empty corner is deliberate: a place is not short of something nobody
//! wanted, and a report that listed every binary the world has would be a report
//! nobody reads.
//!
//! [`Standing::Unasked`] is the half that is easy to leave out and is the whole
//! reason this is a diff rather than a checklist. A place holding a tool the spec
//! never mentions is not a fault — it is the answer to why the same commit
//! behaves differently over there, and the fix is usually to declare it so every
//! place brings itself to it.
//!
//! The fifth answer, [`Standing::Disputed`], is when the two sources are asked
//! about the same name and say different things: `brew list ripgrep` succeeds and
//! `command -v ripgrep` fails, so it is installed and not on the PATH the work
//! runs under. That is a real and genuinely confusing state, and collapsing it
//! into either "present" or "missing" throws away the only clue.
//!
//! ## Every mode, or it is worth nothing
//!
//! The governing rule of this programme is that no feature lands in one place-
//! mode only, and drift is the feature where that would bite hardest: a report
//! you can only get about a box is useless, because the comparison you actually
//! want is the box against the laptop it works on. So this is one function on
//! `Place`, and the conformance matrix asks every mode for it — see
//! `place_conformance`'s W14.

use std::collections::BTreeMap;

use aura_env::{EnvReport, Plan, Scope, StepKind, TrustState};
use serde::{Deserialize, Serialize};

use super::place::Place;
use super::place_contract::Capabilities;
use super::place_env::Declared;

/// The tools a place needs before any of this app's promises hold, whatever the
/// project declares.
///
/// Not a matter of taste and not the spec's business: without `git` there is no
/// work to push, and without `tmux` nothing started here outlives the connection
/// that started it — no durable sessions, no attaching, no coming back tomorrow.
/// A place short of either is short of it whether or not anyone wrote it down,
/// which is why these two are asked for by this file rather than by a settings
/// file that may not exist.
const FLOOR: [(&str, &str); 2] = [
    (
        "git",
        "Without git this place cannot clone, commit or push — the work here \
         would have no way back to the project.",
    ),
    (
        "tmux",
        "Without tmux nothing started here outlives its connection: close the \
         lid or lose wifi and the session is gone rather than waiting for you.",
    ),
];

/// Where one line of the report sits in the stack.
///
/// The order is the order things have to exist in, which is also the order a
/// person should read them in: a missing runtime is why the toolchain step
/// failed, and a missing toolchain is why the package one did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    /// The floor above — plus anything the spec needs before it can install
    /// (`mise`, `brew`), which the plan calls preflight.
    Runtime,
    /// A coding-agent CLI. Never required, always worth knowing about: this is
    /// the list that differs most between two places and is declared least.
    Agent,
    Toolchain,
    Package,
    /// The project's own `[worktree] setup` — its dependency manifests.
    Deps,
    Service,
}

impl Layer {
    /// The prefix of every id in this layer.
    ///
    /// Here rather than at each `format!` because an id is the join key two
    /// places' reports are set side by side on: a layer whose prefix is spelled
    /// in two places is a layer that eventually spells it two ways, and the two
    /// reports then quietly stop lining up.
    pub fn as_str(self) -> &'static str {
        match self {
            Layer::Runtime => "runtime",
            Layer::Agent => "agent",
            Layer::Toolchain => "toolchain",
            Layer::Package => "package",
            Layer::Deps => "deps",
            Layer::Service => "service",
        }
    }
}

/// How one thing stands between what the place has and what the spec asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Standing {
    /// Asked for, and the place has not got it. The only standing that blocks.
    Missing,
    /// Asked for, and the two sources that can answer disagree about whether it
    /// is here.
    Disputed,
    /// Asked for, and here.
    Present,
    /// Here, and nothing asked for it. Not a fault — the reason two places
    /// behave differently when the spec is silent.
    Unasked,
}

impl Standing {
    /// Does this stop the place being what the project asked for?
    pub fn blocks(self) -> bool {
        matches!(self, Standing::Missing | Standing::Disputed)
    }
}

/// One line of the diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DriftItem {
    /// Stable across places and runs, so two reports can be set side by side:
    /// `runtime:tmux`, `package:brew/ripgrep`, `agent:claude`.
    pub id: String,
    /// One line a person reads — the spec's own title where there is one.
    pub title: String,
    pub layer: Layer,
    pub standing: Standing,
    /// What the place said, or what goes wrong without it. Never empty: a line
    /// that says only "missing" is a line that sends someone to the wrong file.
    pub detail: String,
    /// The command that would close this gap, when the spec said how to. `None`
    /// where the spec described a state without saying how to reach it, and for
    /// the runtime floor — Aura does not get to guess a stranger's box's package
    /// manager and run it unattended.
    pub fix: Option<String>,
}

/// A place, measured against the project it is holding.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Drift {
    /// The place this is about, in the words it calls itself.
    pub place: String,
    /// Where the spec was read from — the place's own checkout, never this
    /// laptop's, because a box building last month's branch needs last month's
    /// spec.
    pub spec_from: String,
    /// `[env] version` — the project's own revision number for its environment.
    pub version: u32,
    pub digest: String,
    /// Whether the spec that was measured against is one anyone should trust.
    pub trust: TrustState,
    /// Did the project declare an environment at all? False is a perfectly good
    /// state and changes what the report means: everything below is then what
    /// the place happens to have, with nothing to be short of.
    pub declares_environment: bool,
    /// Every line, most urgent first.
    pub items: Vec<DriftItem>,
    pub missing: usize,
    pub disputed: usize,
    /// Nothing asked for is absent or in doubt.
    pub at_spec: bool,
    /// One sentence, for a surface that has room for one.
    pub summary: String,
}

impl Drift {
    /// The lines that stop this place being what the project asked for.
    pub fn blocking(&self) -> Vec<&DriftItem> {
        self.items.iter().filter(|i| i.standing.blocks()).collect()
    }
}

impl Place {
    /// Ask this place what it has, against what the project asks it for.
    ///
    /// Two measurements of the real machine — the capability probe and every
    /// check the spec declares — joined into one diff. `agent_bins` is the
    /// candidate set the picker would offer, so the report answers the question
    /// in the same terms the rest of the app asks it.
    pub async fn drift(&self, agent_bins: &[String], scope: Scope) -> Result<Drift, String> {
        let capabilities = self.capabilities(agent_bins).await?;
        let (declared, plan, report) = self.observe_env(scope).await?;
        Ok(self.drift_of(agent_bins, &capabilities, &declared, &plan, &report))
    }

    /// The same answer, assembled from measurements already taken.
    ///
    /// Split out because the join is the part worth testing and it needs no
    /// machine on the other end: given a place deliberately behind its spec, the
    /// report it produces can be read exactly, in a suite that never dials.
    pub fn drift_of(
        &self,
        agent_bins: &[String],
        capabilities: &Capabilities,
        declared: &Declared,
        plan: &Plan,
        report: &EnvReport,
    ) -> Drift {
        let probe = probed(agent_bins, capabilities);
        let mut items = Vec::new();
        // What the spec has already spoken for, so nothing is reported twice —
        // once as a shortfall and once as a thing the place happens to have.
        let mut spoken_for: Vec<&str> = Vec::new();

        // What the spec asked for, and what the place said about each.
        for outcome in &report.steps {
            let fix = plan
                .steps
                .iter()
                .find(|s| s.id == outcome.id)
                .and_then(|s| s.apply.clone());
            let named = binary_named_by(&outcome.id);
            let met = outcome.state.is_met();
            let seen = named.and_then(|n| probe.get(n).copied());
            if let Some(n) = named {
                if seen.is_some() {
                    spoken_for.push(n);
                }
            }
            let (standing, detail) = match seen {
                // Both sources answered the same name and disagreed. Neither is
                // wrong: the package manager has it and the shell cannot find
                // it, which is a PATH the work runs under, not an install.
                Some(here) if here != met => (
                    Standing::Disputed,
                    disagreement(named.unwrap_or_default(), here, outcome.detail.trim()),
                ),
                _ if met => (Standing::Present, "at spec".to_string()),
                _ => (
                    Standing::Missing,
                    shortfall(outcome.detail.trim(), fix.as_deref()),
                ),
            };
            items.push(DriftItem {
                id: outcome.id.clone(),
                title: outcome.title.clone(),
                layer: layer_of(outcome.kind),
                standing,
                detail,
                fix,
            });
        }

        // The floor, which is asked for by this app rather than by any settings
        // file — and is therefore reported even for a project that declares
        // nothing at all.
        for (bin, consequence) in FLOOR {
            if spoken_for.contains(&bin) {
                continue;
            }
            let here = probe.get(bin).copied().unwrap_or(false);
            items.push(DriftItem {
                id: format!("{}:{bin}", Layer::Runtime.as_str()),
                title: format!("{bin} on this place"),
                layer: Layer::Runtime,
                standing: if here {
                    Standing::Present
                } else {
                    Standing::Missing
                },
                detail: if here {
                    format!("`{bin}` is here")
                } else {
                    consequence.to_string()
                },
                fix: None,
            });
        }

        // And what the place turned out to have that nobody asked for. The half
        // that makes this a diff: two places' reports set side by side differ
        // here long before they differ anywhere else.
        for (name, here) in &probe {
            let name = name.as_str();
            if !here || spoken_for.contains(&name) || FLOOR.iter().any(|(f, _)| *f == name) {
                continue;
            }
            let layer = if agent_bins.iter().any(|b| b == name) {
                Layer::Agent
            } else {
                Layer::Runtime
            };
            items.push(DriftItem {
                id: format!("{}:{name}", layer.as_str()),
                title: name.to_string(),
                layer,
                standing: Standing::Unasked,
                detail: format!(
                    "`{name}` is here and nothing declares it — a place without it \
                     behaves differently and nothing says so until it does"
                ),
                fix: None,
            });
        }

        // Most urgent first, then down the stack, then by name — so two reports
        // of the same place are the same document and can be diffed as text.
        items.sort_by(|a, b| {
            (a.standing, a.layer, &a.id).cmp(&(b.standing, b.layer, &b.id))
        });

        let missing = items
            .iter()
            .filter(|i| i.standing == Standing::Missing)
            .count();
        let disputed = items
            .iter()
            .filter(|i| i.standing == Standing::Disputed)
            .count();
        // At spec means nothing BLOCKS — not that the report is empty. A place
        // holding half a dozen things nobody declared is still exactly what the
        // project asked for, and telling somebody otherwise would make the
        // undeclared half something to clear rather than something to read.
        let at_spec = !items.iter().any(|i| i.standing.blocks());
        Drift {
            summary: summarise(
                self.label(),
                report.version,
                declared.spec.declares_environment(),
                missing,
                disputed,
            ),
            place: self.label().to_string(),
            spec_from: declared.source.clone(),
            version: report.version,
            digest: report.digest.clone(),
            trust: report.trust.clone(),
            declares_environment: declared.spec.declares_environment(),
            items,
            missing,
            disputed,
            at_spec,
        }
    }
}

/// Every name the capability probe answered for, and whether it was there.
///
/// A map rather than the [`Capabilities`] struct because the join asks the same
/// question of names that arrive as strings out of the spec, and `git`, `tmux`,
/// `aura` and the agent set are all just names once you are asking "did the
/// probe see this".
fn probed(agent_bins: &[String], caps: &Capabilities) -> BTreeMap<String, bool> {
    let mut seen: BTreeMap<String, bool> = BTreeMap::new();
    for bin in agent_bins {
        seen.insert(bin.clone(), caps.agents.iter().any(|a| a == bin));
    }
    seen.insert("git".into(), caps.git);
    seen.insert("tmux".into(), caps.tmux);
    seen.insert("aura".into(), caps.aura);
    seen
}

/// The binary a plan step is about, when it is about one.
///
/// Step ids are the plan's own — `toolchain:node`, `package:brew/ripgrep`,
/// `preflight:mise` — and the last segment is the name the probe would have been
/// asked. A service is not a binary and `deps` is a manifest, so both answer
/// `None` rather than a name that would be compared against a probe that never
/// covered it.
fn binary_named_by(step_id: &str) -> Option<&str> {
    let (kind, rest) = step_id.split_once(':')?;
    match kind {
        "toolchain" | "preflight" => Some(rest),
        "package" => Some(rest.rsplit('/').next().unwrap_or(rest)),
        _ => None,
    }
}

fn layer_of(kind: StepKind) -> Layer {
    match kind {
        // Preflight is "this place has `mise`" — a runtime the spec needs before
        // it can install anything, which is the floor's own question asked by a
        // settings file instead of by us.
        StepKind::Preflight => Layer::Runtime,
        StepKind::Toolchain => Layer::Toolchain,
        StepKind::Package => Layer::Package,
        StepKind::Deps => Layer::Deps,
        StepKind::Service => Layer::Service,
    }
}

/// What a missing thing says for itself.
///
/// The command that would fix it, when the spec said how — because the whole
/// value of naming a gap is being one step from closing it — and otherwise the
/// plain fact that the spec described a state without saying how to reach it.
fn shortfall(detail: &str, fix: Option<&str>) -> String {
    match (detail.is_empty(), fix) {
        (false, _) => detail.to_string(),
        (true, Some(cmd)) => format!("not here; `{cmd}` would install it"),
        (true, None) => {
            "not here, and the spec says what to have without saying how to get it".into()
        }
    }
}

/// Two sources, one name, two answers.
///
/// Spelled out in full rather than reduced to one of them, because which way
/// round it is tells you which thing to go and fix — and neither reading is
/// available once the report has picked a side.
fn disagreement(name: &str, on_path: bool, spec_said: &str) -> String {
    let said = if spec_said.is_empty() {
        String::new()
    } else {
        format!(" ({spec_said})")
    };
    if on_path {
        format!(
            "`{name}` is on the PATH here, but the spec's own check for it does not pass{said} \
             — the version that answers may not be the one the project pinned"
        )
    } else {
        format!(
            "the spec's own check for `{name}` passes{said}, but `command -v {name}` finds \
             nothing — it is installed somewhere the work's own shell cannot see"
        )
    }
}

/// One sentence, in the terms the person asking would use.
fn summarise(
    place: &str,
    version: u32,
    declares: bool,
    missing: usize,
    disputed: usize,
) -> String {
    if !declares {
        return format!(
            "{place} — this project declares no environment, so there is nothing to be short of; \
             below is what this place turned out to have"
        );
    }
    match (missing, disputed) {
        (0, 0) => format!("{place} is at spec v{version}"),
        (m, 0) => format!("{place} is short of spec v{version}: {m} missing"),
        (0, d) => format!("{place} against spec v{version}: {d} in doubt"),
        (m, d) => format!("{place} is short of spec v{version}: {m} missing, {d} in doubt"),
    }
}

/// What a place has against what its project asks for, without changing
/// anything.
///
/// `machine_id` absent means this laptop — the same command answers for both
/// modes, which is the only version of parity that survives a deadline.
#[tauri::command]
pub async fn place_drift(
    root: String,
    machine_id: Option<String>,
    bins: Vec<String>,
    deps: bool,
) -> Result<Drift, String> {
    let scope = if deps { Scope::Full } else { Scope::Environment };
    Place::resolve(root, machine_id.as_deref())
        .drift(&bins, scope)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aura_env::{plan, EnvSpec, StepOutcome, StepState};

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    fn bins() -> Vec<String> {
        ["claude", "codex", "gemini"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    /// A place with an address, so the report is about a box rather than about
    /// this disk — the case the whole feature exists for.
    fn a_box(root: &str) -> Place {
        Place::Box {
            machine: Box::new(crate::cmd_machines::Machine {
                id: format!("ubuntu@10.0.0.4:{root}"),
                name: "aura-runner".into(),
                host: "10.0.0.4".into(),
                user: "ubuntu".into(),
                key_path: "/Users/me/.ssh/aura-runner.pem".into(),
                box_kind: "shared".into(),
                repo_path: Some(root.into()),
                repo_branch: Some("main".into()),
                project_root: Some("/Users/me/alpha".into()),
                org_slug: Some("naridon".into()),
                added_at: 1_750_000_000,
                last_used_at: 1_750_003_600,
                forward_agent: false,
                instance_id: None,
                asleep_since: 0,
            }),
            root: root.into(),
            here: "/Users/me/alpha".into(),
        }
    }

    /// The spec, its plan, and a report in which `met` decides every step —
    /// a place that has all of it, or none of it, without a machine.
    fn measured(toml: &str, met: bool) -> (Declared, Plan, EnvReport) {
        let spec: EnvSpec = aura_env::parse_declared(toml).expect("a spec");
        let plan = plan(&spec, Scope::Full).expect("a plan");
        let steps = plan
            .steps
            .iter()
            .map(|s| StepOutcome {
                id: s.id.clone(),
                title: s.title.clone(),
                kind: s.kind,
                state: if met {
                    StepState::AlreadyAtSpec
                } else {
                    StepState::Unsatisfied
                },
                code: if met { 0 } else { 1 },
                detail: String::new(),
            })
            .collect::<Vec<_>>();
        let report = EnvReport {
            schema: aura_env::SPEC_SCHEMA.into(),
            version: spec.version,
            digest: spec.digest().unwrap_or_default(),
            trust: TrustState::Unsigned,
            steps,
            at_spec: met,
            changed: false,
        };
        let declared = Declared {
            spec,
            trust: TrustState::Unsigned,
            source: "aura-runner".into(),
        };
        (declared, plan, report)
    }

    const SPEC: &str = r#"
[env]
version = 7

[env.toolchain.node]
version = "20.11.0"
check   = "node --version | grep -q 20.11.0"
install = "mise install node@20.11.0"

[[env.package]]
manager = "custom"
name    = "ripgrep"
check   = "command -v rg"
install = "brew install ripgrep"

[[env.service]]
name  = "postgres"
start = "pg_ctl start"
ready = "pg_isready"
"#;

    #[test]
    fn a_box_behind_its_spec_reports_exactly_what_is_missing() {
        // The claim, stated as plainly as it can be: a place that has none of
        // what the project asked for names each one, says what it is short of,
        // and carries the command that would close it.
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured(SPEC, false);
        let caps = Capabilities {
            agents: vec!["claude".into()],
            git: true,
            tmux: false,
            aura: false,
        };
        let drift = place.drift_of(&bins(), &caps, &declared, &plan, &report);

        assert!(!drift.at_spec);
        assert_eq!(drift.place, "aura-runner");
        assert_eq!(drift.version, 7);
        assert!(drift.declares_environment);

        // Exactly what is missing: the three the spec declared, plus tmux —
        // which no settings file mentioned and without which nothing here
        // outlives its connection.
        let missing: Vec<&str> = drift
            .items
            .iter()
            .filter(|i| i.standing == Standing::Missing)
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(
            missing,
            vec![
                "runtime:tmux",
                "toolchain:node",
                "package:custom/ripgrep",
                "service:postgres",
            ]
        );
        assert_eq!(drift.missing, 4);

        // And each carries the way out, where the spec said what it was.
        let node = drift.items.iter().find(|i| i.id == "toolchain:node").unwrap();
        assert_eq!(node.fix.as_deref(), Some("mise install node@20.11.0"));
        assert!(node.detail.contains("mise install"), "{}", node.detail);
        assert_eq!(node.layer, Layer::Toolchain);

        // The one it does have, and which nothing asked for, is still reported —
        // that is the line that explains why the same commit behaves
        // differently here.
        let claude = drift.items.iter().find(|i| i.id == "agent:claude").unwrap();
        assert_eq!(claude.standing, Standing::Unasked);
        assert_eq!(claude.layer, Layer::Agent);
        assert!(drift.summary.contains("short of spec v7"), "{}", drift.summary);
    }

    #[test]
    fn a_place_that_has_all_of_it_says_so_without_listing_grievances() {
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured(SPEC, true);
        let caps = Capabilities {
            agents: bins(),
            git: true,
            tmux: true,
            aura: true,
        };
        let drift = place.drift_of(&bins(), &caps, &declared, &plan, &report);
        assert!(drift.at_spec);
        assert!(drift.blocking().is_empty());
        assert_eq!(drift.summary, "aura-runner is at spec v7");
        // Nothing invented: every agent it holds is named, and none of the ones
        // it does not.
        let agents: Vec<&str> = drift
            .items
            .iter()
            .filter(|i| i.layer == Layer::Agent)
            .map(|i| i.title.as_str())
            .collect();
        assert_eq!(agents, vec!["claude", "codex", "gemini"]);
    }

    #[test]
    fn an_agent_the_place_does_not_have_is_not_a_line_at_all() {
        // The empty corner of the table. A place is not short of something
        // nobody asked for, and a report that listed every absence would be one
        // nobody reads.
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured(SPEC, true);
        let caps = Capabilities {
            agents: vec![],
            git: true,
            tmux: true,
            aura: false,
        };
        let drift = place.drift_of(&bins(), &caps, &declared, &plan, &report);
        for absent in ["agent:claude", "agent:codex", "agent:gemini", "runtime:aura"] {
            assert!(
                !drift.items.iter().any(|i| i.id == absent),
                "{absent} was reported as drift and nothing ever asked for it"
            );
        }
        assert!(drift.at_spec);
    }

    #[test]
    fn a_tool_installed_where_the_work_cannot_see_it_is_neither_present_nor_missing() {
        // The state that costs a whole afternoon: `brew list` says yes, the
        // shell says no. Reported as itself, with both answers in the sentence,
        // because which way round it is decides where to go and look.
        let place = a_box("/srv/alpha");
        let (declared, plan, mut report) = measured(SPEC, true);
        let caps = Capabilities {
            agents: vec![],
            git: true,
            tmux: true,
            aura: false,
        };
        // The spec's own check passes; the probe never saw it on the PATH.
        let drift = place.drift_of(
            &["ripgrep".to_string()],
            &Capabilities {
                agents: vec![],
                ..caps.clone()
            },
            &declared,
            &plan,
            &report,
        );
        let rg = drift
            .items
            .iter()
            .find(|i| i.id == "package:custom/ripgrep")
            .unwrap();
        assert_eq!(rg.standing, Standing::Disputed);
        assert!(rg.detail.contains("command -v ripgrep"), "{}", rg.detail);
        assert!(!drift.at_spec, "a place in doubt is not a place at spec");
        assert_eq!(drift.disputed, 1);

        // And the other way round: on the PATH, spec's check unhappy.
        for s in &mut report.steps {
            if s.id == "package:custom/ripgrep" {
                s.state = StepState::Unsatisfied;
                s.detail = "wrong version".into();
            }
        }
        let drift = place.drift_of(
            &["ripgrep".to_string()],
            &Capabilities {
                agents: vec!["ripgrep".into()],
                ..caps
            },
            &declared,
            &plan,
            &report,
        );
        let rg = drift
            .items
            .iter()
            .find(|i| i.id == "package:custom/ripgrep")
            .unwrap();
        assert_eq!(rg.standing, Standing::Disputed);
        assert!(rg.detail.contains("wrong version"), "{}", rg.detail);
    }

    #[test]
    fn a_project_that_declares_nothing_still_says_what_the_place_has() {
        // Without this the feature would only work for projects that had
        // already adopted the spec — and the diff between two places is most
        // wanted precisely by the ones that have not.
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured("", true);
        let caps = Capabilities {
            agents: vec!["codex".into()],
            git: true,
            tmux: true,
            aura: false,
        };
        let drift = place.drift_of(&bins(), &caps, &declared, &plan, &report);
        assert!(!drift.declares_environment);
        assert!(drift.at_spec, "there is nothing to be short of");
        assert!(
            drift.summary.contains("declares no environment"),
            "{}",
            drift.summary
        );
        let ids: Vec<&str> = drift.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["runtime:git", "runtime:tmux", "agent:codex"]);
    }

    #[test]
    fn the_floor_is_asked_for_whether_or_not_a_settings_file_mentions_it() {
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured("", true);
        let caps = Capabilities {
            agents: vec![],
            git: false,
            tmux: false,
            aura: false,
        };
        let drift = place.drift_of(&[], &caps, &declared, &plan, &report);
        assert_eq!(drift.missing, 2);
        let tmux = drift.items.iter().find(|i| i.id == "runtime:tmux").unwrap();
        assert!(
            tmux.detail.contains("outlives its connection"),
            "a floor gap that does not say what breaks: {}",
            tmux.detail
        );
        assert!(!drift.at_spec);
    }

    #[test]
    fn a_spec_that_declares_the_floor_owns_it_rather_than_reporting_it_twice() {
        // `[[env.package]] name = "tmux"` and the floor are the same subject.
        // Two lines about one tool is how a person concludes there are two
        // tmuxes.
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured(
            "[[env.package]]\nmanager = \"custom\"\nname = \"tmux\"\ncheck = \"command -v tmux\"\ninstall = \"apt-get install -y tmux\"\n",
            false,
        );
        let caps = Capabilities {
            agents: vec![],
            git: true,
            tmux: false,
            aura: false,
        };
        let drift = place.drift_of(&[], &caps, &declared, &plan, &report);
        let about_tmux: Vec<&str> = drift
            .items
            .iter()
            .filter(|i| i.title.contains("tmux") || i.id.contains("tmux"))
            .map(|i| i.id.as_str())
            .collect();
        assert_eq!(about_tmux, vec!["package:custom/tmux"]);
        let entry = &drift.items[0];
        assert_eq!(entry.standing, Standing::Missing);
        assert_eq!(entry.fix.as_deref(), Some("apt-get install -y tmux"));
    }

    #[test]
    fn the_worst_news_is_first_and_the_same_place_reports_the_same_document() {
        let place = a_box("/srv/alpha");
        let (declared, plan, report) = measured(SPEC, false);
        let caps = Capabilities {
            agents: vec!["gemini".into(), "claude".into()],
            git: true,
            tmux: true,
            aura: true,
        };
        let once = place.drift_of(&bins(), &caps, &declared, &plan, &report);
        let twice = place.drift_of(&bins(), &caps, &declared, &plan, &report);
        assert_eq!(once, twice, "two reads of one place are not one document");

        let standings: Vec<Standing> = once.items.iter().map(|i| i.standing).collect();
        let mut sorted = standings.clone();
        sorted.sort();
        assert_eq!(standings, sorted, "the blocking lines are not at the top");
    }

    #[test]
    fn this_laptop_answers_the_same_question_in_the_same_shape() {
        // The governing rule, at the smallest scale it can be checked: the
        // report is about a place, so the local one is a place too. A real
        // checkout, a real probe, a real pump — the only thing not real is that
        // it is this disk.
        let dir = std::env::temp_dir().join(format!("aura-drift-here-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".aura")).unwrap();
        std::fs::write(
            dir.join(".aura").join("settings.toml"),
            "[env]\nversion = 3\n\n[[env.package]]\nmanager = \"custom\"\nname = \"absent-thing\"\ncheck = \"test -f absent.ok\"\ninstall = \"echo yes > absent.ok\"\n",
        )
        .unwrap();
        let place = Place::Here {
            root: dir.display().to_string(),
        };

        let drift = block_on(place.drift(&["definitely-not-a-real-binary".into()], Scope::Full))
            .expect("this laptop can be asked");
        assert_eq!(drift.version, 3);
        assert_eq!(drift.spec_from, "this laptop");
        assert!(!drift.at_spec);
        let short = drift
            .items
            .iter()
            .find(|i| i.id == "package:custom/absent-thing")
            .expect("the thing the spec asked for");
        assert_eq!(short.standing, Standing::Missing);
        assert_eq!(short.fix.as_deref(), Some("echo yes > absent.ok"));
        // Measuring changed nothing.
        assert!(!dir.join("absent.ok").exists());
        // And a real probe really ran: git is on this machine, the invented
        // binary is not, and neither answer was made up.
        assert!(drift.items.iter().any(|i| i.id == "runtime:git"));
        assert!(!drift
            .items
            .iter()
            .any(|i| i.id.contains("definitely-not-a-real-binary")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_command_answers_for_this_laptop_when_no_machine_is_named() {
        let dir = std::env::temp_dir().join(format!("aura-drift-cmd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let drift = block_on(place_drift(
            dir.display().to_string(),
            None,
            vec!["claude".into()],
            true,
        ))
        .expect("a drift report about this laptop");
        assert!(!drift.declares_environment);
        assert!(drift.summary.contains("declares no environment"));

        // Deliberately not asserting `at_spec`. The floor is measured against
        // the machine this suite is running on, and a developer without tmux is
        // genuinely short of it — a test that demanded otherwise would be
        // asserting the state of somebody's laptop rather than the code.
        let git = drift
            .items
            .iter()
            .find(|i| i.id == "runtime:git")
            .expect("the floor is reported even where nothing is declared");
        assert_eq!(
            git.standing,
            Standing::Present,
            "a checkout under `cargo test` reported no git"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
