//! Mission Control — the PURE merge layer.
//!
//! Everything here is deterministic: it takes already-loaded, in-memory
//! per-root inputs (crew nodes, run-ledger records, crew run-node/proof rows,
//! automation triggers + run records, host facts) and folds them into the one
//! typed `MissionState` envelope the frontend codes against.
//!
//! No file IO, no clocks, no process inspection — the thin `cmd_mission`
//! command does the gathering and hands these helpers the data. That keeps the
//! whole shape unit-testable from fixtures (`cargo test mission`).
//!
//! Honest by construction: a section we have no input for is simply empty, and
//! every "is it online / steerable" bit is carried in, never guessed here.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

// ─── Wire contract (matches `aura-shell/src/lib/api.ts` VERBATIM) ─────────

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionProof {
    pub verdict: String,
    pub ok: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionRun {
    pub id: String,
    pub project: String,
    pub project_name: String,
    pub title: String,
    pub agent: Option<String>,
    /// "crew" | "automation" | "manual"
    pub source: String,
    pub source_detail: Option<String>,
    /// "working" | "queued" | "done" | "failed"
    pub state: String,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub commit: Option<String>,
    pub pr_number: Option<i64>,
    pub proof: Option<MissionProof>,
    pub waiting_on: Vec<String>,
    pub steerable: bool,
    pub error: Option<String>,
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionTrigger {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub cadence_label: String,
    pub next_run_ms: Option<i64>,
    pub project: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionHost {
    pub configured: bool,
    pub online: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionProject {
    pub root: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MissionState {
    pub live: Vec<MissionRun>,
    pub queued: Vec<MissionRun>,
    pub recent: Vec<MissionRun>,
    pub triggers: Vec<MissionTrigger>,
    pub host: MissionHost,
    pub projects: Vec<MissionProject>,
    pub capped: bool,
}

// ─── Source-state string constants ────────────────────────────────────────

pub const SOURCE_CREW: &str = "crew";
pub const SOURCE_AUTOMATION: &str = "automation";
/// A run with no crew node and no automation behind it (a hand-started agent).
/// Part of the contract; not emitted by the current gather paths yet.
#[allow(dead_code)]
pub const SOURCE_MANUAL: &str = "manual";

pub const STATE_WORKING: &str = "working";
pub const STATE_QUEUED: &str = "queued";
pub const STATE_DONE: &str = "done";
pub const STATE_FAILED: &str = "failed";

/// Cap on `recent` across ALL roots (newest-first). Anything beyond is dropped
/// and `capped` is flipped true.
pub const RECENT_CAP: usize = 40;

// ─── Per-root gathered inputs (plain data the command fills in) ───────────

/// One crew/loop node as the merge layer needs it — a flat projection of the
/// `aura_loop::LoopTask` fields we surface, plus the wave label resolved by the
/// gather step. Keeping this flat (not the crate struct) means the pure tests
/// don't depend on the loop crate.
// A flat input DTO: the gather step fills every field it can read, but the
// merge layer only reads the ones it needs today (a crew node's commit, for
// example, comes from the run ledger, not the node) — so some fields are
// carried-but-unread by design. Allow that rather than dropping contract data.
#[allow(dead_code)]
#[derive(Debug, Clone, Default)]
pub struct CrewNodeInput {
    pub id: String,
    pub title: String,
    pub agent: Option<String>,
    /// One of the `aura_loop` STATE_* strings: working / submitted /
    /// completed / failed / paused / canceled / …
    pub status: String,
    /// Dependency node ids (raw; resolved to titles by the merge layer).
    pub depends_on: Vec<String>,
    /// Wave label already resolved by the gather step, e.g. "wave 2".
    pub wave_label: Option<String>,
    /// Lease acquire time (unix secs) when a node is being worked.
    pub lease_acquired_at_secs: Option<i64>,
    /// Commit a terminal node produced, when known.
    pub commit: Option<String>,
    /// Failure detail for a failed node.
    pub error: Option<String>,
    /// Whether a real steer seam exists for this node (carried in, never
    /// guessed). The desktop has no per-node steer command today → false.
    pub steerable: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One crew run-ledger run-node (`.aura/crew/runs.jsonl` → `RunNode`) plus the
/// run's end time, flattened.
#[derive(Debug, Clone, Default)]
pub struct CrewRunNodeInput {
    pub id: String,
    pub title: String,
    /// "completed" | "merged" | "failed" | "rolled-back" | "skipped"
    pub outcome: String,
    pub commit: Option<String>,
    pub detail: Option<String>,
    pub agent: Option<String>,
    /// The run's end time (unix secs), used to order recent newest-first.
    pub ended_at_secs: Option<i64>,
}

/// One proof verdict keyed by short commit sha (built from `.aura/goals.jsonl`).
#[derive(Debug, Clone, Default)]
pub struct ProofInput {
    pub verdict: String,
    pub ok: u32,
    pub total: u32,
}

/// One automation trigger row.
#[derive(Debug, Clone, Default)]
pub struct TriggerInput {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub cadence_label: String,
    pub next_run_ms: Option<i64>,
}

/// One automation run record. In-flight (`ended_at_ms == None`) → live;
/// finished → recent. `lane_id` lets us collapse a crew+automation pair.
#[derive(Debug, Clone, Default)]
pub struct AutomationRunInput {
    pub id: String,
    pub automation_name: String,
    pub started_at_ms: Option<i64>,
    pub ended_at_ms: Option<i64>,
    pub ok: bool,
    pub summary: String,
    /// The Crew lane / node id this automation minted, if any — the dedupe key.
    pub lane_id: Option<String>,
    pub commit: Option<String>,
}

/// Everything gathered for ONE project root.
#[derive(Debug, Clone, Default)]
pub struct RootInput {
    pub root: String,
    pub name: String,
    pub crew_nodes: Vec<CrewNodeInput>,
    pub crew_runs: Vec<CrewRunNodeInput>,
    /// Short-commit-sha → proof verdict.
    pub proofs: HashMap<String, ProofInput>,
    pub triggers: Vec<TriggerInput>,
    pub automation_runs: Vec<AutomationRunInput>,
}

// ─── Title resolution (waitingOn) ─────────────────────────────────────────

/// Build the id→title map across one root's nodes so a dependency id can be
/// shown as a plain title. Unknown ids fall back to the id itself (honest —
/// "we still know there's a dependency, we just can't name it").
pub fn title_map(nodes: &[CrewNodeInput]) -> HashMap<String, String> {
    nodes
        .iter()
        .map(|n| (n.id.clone(), n.title.clone()))
        .collect()
}

fn resolve_waiting_on(deps: &[String], titles: &HashMap<String, String>) -> Vec<String> {
    deps.iter()
        .map(|d| titles.get(d).cloned().unwrap_or_else(|| d.clone()))
        .collect()
}

// ─── Crew node → MissionRun ───────────────────────────────────────────────

fn secs_to_ms(s: Option<i64>) -> Option<i64> {
    s.map(|v| v.saturating_mul(1000))
}

/// A working crew node → a live `MissionRun`.
fn working_run(n: &CrewNodeInput, root: &str, name: &str) -> MissionRun {
    let source_detail = n.wave_label.clone();
    MissionRun {
        id: format!("{root}#{}", n.id),
        project: root.to_string(),
        project_name: name.to_string(),
        title: n.title.clone(),
        agent: n.agent.clone(),
        source: SOURCE_CREW.to_string(),
        source_detail,
        state: STATE_WORKING.to_string(),
        started_at_ms: secs_to_ms(n.lease_acquired_at_secs),
        ended_at_ms: None,
        commit: None,
        pr_number: None,
        proof: None,
        waiting_on: Vec::new(),
        steerable: n.steerable,
        error: None,
        node_id: Some(n.id.clone()),
    }
}

/// A ready/submitted crew node → a queued `MissionRun`. `waiting_on` is the
/// plain titles of its (unmet) dependencies.
fn queued_run(
    n: &CrewNodeInput,
    root: &str,
    name: &str,
    titles: &HashMap<String, String>,
) -> MissionRun {
    MissionRun {
        id: format!("{root}#{}", n.id),
        project: root.to_string(),
        project_name: name.to_string(),
        title: n.title.clone(),
        agent: n.agent.clone(),
        source: SOURCE_CREW.to_string(),
        source_detail: n.wave_label.clone(),
        state: STATE_QUEUED.to_string(),
        started_at_ms: None,
        ended_at_ms: None,
        commit: None,
        pr_number: None,
        proof: None,
        waiting_on: resolve_waiting_on(&n.depends_on, titles),
        steerable: n.steerable,
        error: None,
        node_id: Some(n.id.clone()),
    }
}

const LOOP_WORKING: &str = "working";
const LOOP_SUBMITTED: &str = "submitted";
#[cfg(test)]
const LOOP_COMPLETED: &str = "completed";
#[cfg(test)]
const LOOP_FAILED: &str = "failed";

// ─── Crew run-node → recent MissionRun (with proof join) ──────────────────

fn outcome_is_failure(outcome: &str) -> bool {
    matches!(outcome, "failed" | "rolled-back")
}

/// A finished crew run-node → a recent `MissionRun`, joining proof by short sha.
fn recent_from_run_node(
    rn: &CrewRunNodeInput,
    root: &str,
    name: &str,
    proofs: &HashMap<String, ProofInput>,
) -> MissionRun {
    let failed = outcome_is_failure(&rn.outcome);
    let proof = rn
        .commit
        .as_deref()
        .and_then(|c| lookup_proof(proofs, c))
        .map(|p| MissionProof {
            verdict: p.verdict.clone(),
            ok: p.ok,
            total: p.total,
        });
    MissionRun {
        id: format!("{root}#run#{}", rn.id),
        project: root.to_string(),
        project_name: name.to_string(),
        title: rn.title.clone(),
        agent: rn.agent.clone(),
        source: SOURCE_CREW.to_string(),
        source_detail: None,
        state: if failed { STATE_FAILED } else { STATE_DONE }.to_string(),
        started_at_ms: None,
        ended_at_ms: secs_to_ms(rn.ended_at_secs),
        commit: rn.commit.clone(),
        pr_number: None,
        proof,
        waiting_on: Vec::new(),
        steerable: false,
        error: if failed { rn.detail.clone() } else { None },
        node_id: Some(rn.id.clone()),
    }
}

/// Match a proof by short OR long sha: goals.jsonl stores 12-char short shas,
/// but a run-node commit may be either. Compare on the common 12-char prefix.
fn lookup_proof<'a>(proofs: &'a HashMap<String, ProofInput>, commit: &str) -> Option<&'a ProofInput> {
    if let Some(p) = proofs.get(commit) {
        return Some(p);
    }
    let short: String = commit.chars().take(12).collect();
    if let Some(p) = proofs.get(&short) {
        return Some(p);
    }
    // The stored key might itself be a short sha that prefixes our longer one.
    proofs
        .iter()
        .find(|(k, _)| commit.starts_with(k.as_str()) || k.starts_with(&short))
        .map(|(_, v)| v)
}

// ─── Automation run → MissionRun ──────────────────────────────────────────

fn automation_live_run(a: &AutomationRunInput, root: &str, name: &str) -> MissionRun {
    MissionRun {
        id: format!("{root}#auto#{}", a.id),
        project: root.to_string(),
        project_name: name.to_string(),
        title: a.automation_name.clone(),
        agent: None,
        source: SOURCE_AUTOMATION.to_string(),
        source_detail: Some(a.automation_name.clone()),
        state: STATE_WORKING.to_string(),
        started_at_ms: a.started_at_ms,
        ended_at_ms: None,
        commit: a.commit.clone(),
        pr_number: None,
        proof: None,
        waiting_on: Vec::new(),
        steerable: false,
        error: None,
        node_id: a.lane_id.clone(),
    }
}

fn automation_recent_run(
    a: &AutomationRunInput,
    root: &str,
    name: &str,
    proofs: &HashMap<String, ProofInput>,
) -> MissionRun {
    let proof = a
        .commit
        .as_deref()
        .and_then(|c| lookup_proof(proofs, c))
        .map(|p| MissionProof {
            verdict: p.verdict.clone(),
            ok: p.ok,
            total: p.total,
        });
    MissionRun {
        id: format!("{root}#auto#{}", a.id),
        project: root.to_string(),
        project_name: name.to_string(),
        title: a.automation_name.clone(),
        agent: None,
        source: SOURCE_AUTOMATION.to_string(),
        source_detail: Some(a.automation_name.clone()),
        state: if a.ok { STATE_DONE } else { STATE_FAILED }.to_string(),
        started_at_ms: a.started_at_ms,
        ended_at_ms: a.ended_at_ms,
        commit: a.commit.clone(),
        pr_number: None,
        proof,
        waiting_on: Vec::new(),
        steerable: false,
        error: if a.ok {
            None
        } else {
            Some(a.summary.clone()).filter(|s| !s.trim().is_empty())
        },
        node_id: a.lane_id.clone(),
    }
}

// ─── The merge: per-root fold + dedupe + cap ──────────────────────────────

/// Sections produced per root, before the cross-root cap.
struct RootSections {
    live: Vec<MissionRun>,
    queued: Vec<MissionRun>,
    recent: Vec<MissionRun>,
    triggers: Vec<MissionTrigger>,
}

fn fold_root(input: &RootInput) -> RootSections {
    let root = input.root.as_str();
    let name = input.name.as_str();
    let titles = title_map(&input.crew_nodes);

    let mut live: Vec<MissionRun> = Vec::new();
    let mut queued: Vec<MissionRun> = Vec::new();
    let mut recent: Vec<MissionRun> = Vec::new();
    let mut crew_node_ids: HashSet<String> = HashSet::new();

    // Crew nodes → live (working) / queued (submitted=ready or blocked).
    // done/failed crew nodes are surfaced via the run ledger join below, so we
    // don't double-list them here.
    for n in &input.crew_nodes {
        match n.status.as_str() {
            LOOP_WORKING => {
                crew_node_ids.insert(n.id.clone());
                live.push(working_run(n, root, name));
            }
            LOOP_SUBMITTED => {
                crew_node_ids.insert(n.id.clone());
                queued.push(queued_run(n, root, name, &titles));
            }
            _ => {}
        }
    }

    // Crew run-ledger nodes → recent (done/failed), with proof join.
    for rn in &input.crew_runs {
        crew_node_ids.insert(rn.id.clone());
        recent.push(recent_from_run_node(rn, root, name, &input.proofs));
    }

    // Automation runs. A run that minted a crew node we already listed is the
    // SAME work → suppress it (prefer the crew node; its name carries via
    // sourceDetail already on the crew row is not the automation name, but the
    // dedupe contract is "appear once", and we keep the richer crew node).
    for a in &input.automation_runs {
        let dup = a
            .lane_id
            .as_deref()
            .map(|lane| crew_node_ids.contains(lane))
            .unwrap_or(false);
        if dup {
            continue;
        }
        if a.ended_at_ms.is_none() {
            live.push(automation_live_run(a, root, name));
        } else {
            recent.push(automation_recent_run(a, root, name, &input.proofs));
        }
    }

    // Triggers (the automations themselves).
    let triggers: Vec<MissionTrigger> = input
        .triggers
        .iter()
        .map(|t| MissionTrigger {
            id: format!("{root}#{}", t.id),
            name: t.name.clone(),
            enabled: t.enabled,
            cadence_label: t.cadence_label.clone(),
            next_run_ms: t.next_run_ms,
            project: root.to_string(),
        })
        .collect();

    RootSections {
        live,
        queued,
        recent,
        triggers,
    }
}

/// Merge every root's gathered inputs + a (carried-in) host fact into one
/// `MissionState`. Pure: deterministic from its arguments.
///
/// - live / queued: crew working + ready, plus in-flight automation runs.
/// - recent: done/failed crew run-nodes + finished automation runs, joined to
///   proof by short sha, newest-first, capped at `RECENT_CAP` across roots
///   (`capped` flips true when anything is dropped).
/// - triggers: every automation as a `MissionTrigger`.
/// - dedupe: an automation run that minted a crew node appears once (the crew
///   node wins).
pub fn merge_state(inputs: &[RootInput], host: MissionHost) -> MissionState {
    let mut live: Vec<MissionRun> = Vec::new();
    let mut queued: Vec<MissionRun> = Vec::new();
    let mut recent: Vec<MissionRun> = Vec::new();
    let mut triggers: Vec<MissionTrigger> = Vec::new();
    let mut projects: Vec<MissionProject> = Vec::new();

    for input in inputs {
        projects.push(MissionProject {
            root: input.root.clone(),
            name: input.name.clone(),
        });
        let mut sections = fold_root(input);
        live.append(&mut sections.live);
        queued.append(&mut sections.queued);
        recent.append(&mut sections.recent);
        triggers.append(&mut sections.triggers);
    }

    // Recent newest-first by end time (None sinks to the bottom), then cap.
    recent.sort_by(|a, b| b.ended_at_ms.cmp(&a.ended_at_ms));
    let capped = recent.len() > RECENT_CAP;
    if capped {
        recent.truncate(RECENT_CAP);
    }

    MissionState {
        live,
        queued,
        recent,
        triggers,
        host,
        projects,
        capped,
    }
}

// ─── Host label helpers (pure; liveness facts carried in) ─────────────────

/// Build the honest host envelope from two carried-in facts:
/// `configured` (an aura-runner config / a `runner:`-prefixed lease was ever
/// seen) and `online` (a `runner:`-prefixed lease is currently un-expired).
/// We NEVER mark online without a live lease.
pub fn host_envelope(configured: bool, online: bool) -> MissionHost {
    let label = if online {
        "Aura Runner online — keeps working with your laptop closed"
    } else if configured {
        "Aura Runner configured"
    } else {
        "Not set up"
    };
    MissionHost {
        // Online implies configured even if the config file wasn't found
        // (the lease is proof enough it's set up somewhere).
        configured: configured || online,
        online,
        label: label.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, title: &str, status: &str) -> CrewNodeInput {
        CrewNodeInput {
            id: id.to_string(),
            title: title.to_string(),
            status: status.to_string(),
            ..Default::default()
        }
    }

    fn root_with(name: &str, nodes: Vec<CrewNodeInput>) -> RootInput {
        RootInput {
            root: format!("/repos/{name}"),
            name: name.to_string(),
            crew_nodes: nodes,
            ..Default::default()
        }
    }

    // (a) missing store → empty section, no error (no panic, empty vecs).
    #[test]
    fn missing_stores_produce_empty_sections() {
        let input = RootInput {
            root: "/repos/empty".into(),
            name: "empty".into(),
            ..Default::default()
        };
        let state = merge_state(&[input], host_envelope(false, false));
        assert!(state.live.is_empty());
        assert!(state.queued.is_empty());
        assert!(state.recent.is_empty());
        assert!(state.triggers.is_empty());
        assert!(!state.capped);
        assert_eq!(state.projects.len(), 1);
        assert!(!state.host.configured);
        assert!(!state.host.online);
        assert_eq!(state.host.label, "Not set up");
    }

    // (b) dedupe collapses a crew+automation pair to one.
    #[test]
    fn dedupe_collapses_crew_and_automation_to_one() {
        let mut input = root_with("proj", vec![node("t-1", "Build login", LOOP_WORKING)]);
        // An automation that minted that very node (lane_id == node id), still
        // in flight → would otherwise also show live.
        input.automation_runs.push(AutomationRunInput {
            id: "run-9".into(),
            automation_name: "Nightly login build".into(),
            started_at_ms: Some(1_000),
            ended_at_ms: None,
            ok: false,
            summary: String::new(),
            lane_id: Some("t-1".into()),
            commit: None,
        });
        let state = merge_state(&[input], host_envelope(false, false));
        // Exactly ONE live row, and it's the crew node (richer), not the auto.
        assert_eq!(state.live.len(), 1);
        assert_eq!(state.live[0].source, SOURCE_CREW);
        assert_eq!(state.live[0].node_id.as_deref(), Some("t-1"));
    }

    #[test]
    fn unrelated_automation_run_is_not_deduped() {
        let mut input = root_with("proj", vec![node("t-1", "Build login", LOOP_WORKING)]);
        input.automation_runs.push(AutomationRunInput {
            id: "run-9".into(),
            automation_name: "Unrelated review".into(),
            started_at_ms: Some(1_000),
            ended_at_ms: None,
            lane_id: Some("t-OTHER".into()),
            ..Default::default()
        });
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.live.len(), 2);
    }

    // (c) recent cap + capped flag.
    #[test]
    fn recent_is_capped_and_flag_set() {
        let mut input = RootInput {
            root: "/repos/big".into(),
            name: "big".into(),
            ..Default::default()
        };
        for i in 0..(RECENT_CAP + 5) {
            input.crew_runs.push(CrewRunNodeInput {
                id: format!("r-{i}"),
                title: format!("Run {i}"),
                outcome: "completed".into(),
                ended_at_secs: Some(i as i64),
                ..Default::default()
            });
        }
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.recent.len(), RECENT_CAP);
        assert!(state.capped);
        // Newest-first: the highest ended_at must be first.
        assert_eq!(
            state.recent[0].ended_at_ms,
            Some((RECENT_CAP as i64 + 4) * 1000)
        );
    }

    #[test]
    fn recent_under_cap_is_not_flagged() {
        let mut input = RootInput {
            root: "/repos/small".into(),
            name: "small".into(),
            ..Default::default()
        };
        for i in 0..3 {
            input.crew_runs.push(CrewRunNodeInput {
                id: format!("r-{i}"),
                title: format!("Run {i}"),
                outcome: "completed".into(),
                ended_at_secs: Some(i as i64),
                ..Default::default()
            });
        }
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.recent.len(), 3);
        assert!(!state.capped);
    }

    // (d) id→title resolution for waitingOn.
    #[test]
    fn waiting_on_resolves_dep_ids_to_titles() {
        let mut blocked = node("t-2", "Wire OAuth", LOOP_SUBMITTED);
        blocked.depends_on = vec!["t-1".into(), "t-missing".into()];
        let input = root_with(
            "proj",
            vec![node("t-1", "Build login", LOOP_COMPLETED), blocked],
        );
        // Note: a completed node is NOT itself queued/live here, but its title
        // is still available for resolution via the id→title map.
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.queued.len(), 1);
        let q = &state.queued[0];
        assert_eq!(q.waiting_on, vec!["Build login".to_string(), "t-missing".to_string()]);
    }

    #[test]
    fn proof_joins_by_short_sha() {
        let mut input = RootInput {
            root: "/repos/p".into(),
            name: "p".into(),
            ..Default::default()
        };
        input.proofs.insert(
            "abc123def456".into(),
            ProofInput {
                verdict: "verified".into(),
                ok: 5,
                total: 5,
            },
        );
        // Run-node carries the LONG sha; lookup must still find it.
        input.crew_runs.push(CrewRunNodeInput {
            id: "r-1".into(),
            title: "Ship it".into(),
            outcome: "merged".into(),
            commit: Some("abc123def4567890aaaa".into()),
            ended_at_secs: Some(10),
            ..Default::default()
        });
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.recent.len(), 1);
        let proof = state.recent[0].proof.as_ref().expect("proof joined");
        assert_eq!(proof.verdict, "verified");
        assert_eq!((proof.ok, proof.total), (5, 5));
        assert_eq!(state.recent[0].state, STATE_DONE);
    }

    #[test]
    fn failed_run_node_carries_error_not_proof() {
        let mut input = RootInput {
            root: "/repos/p".into(),
            name: "p".into(),
            ..Default::default()
        };
        input.crew_runs.push(CrewRunNodeInput {
            id: "r-1".into(),
            title: "Broke build".into(),
            outcome: "failed".into(),
            detail: Some("compile error".into()),
            ended_at_secs: Some(10),
            ..Default::default()
        });
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.recent[0].state, STATE_FAILED);
        assert_eq!(state.recent[0].error.as_deref(), Some("compile error"));
        assert!(state.recent[0].proof.is_none());
    }

    #[test]
    fn host_online_label_is_honest() {
        let off = host_envelope(false, false);
        assert!(!off.online && !off.configured);
        assert_eq!(off.label, "Not set up");

        let configured = host_envelope(true, false);
        assert!(configured.configured && !configured.online);
        assert_eq!(configured.label, "Aura Runner configured");

        let online = host_envelope(false, true);
        assert!(online.online && online.configured, "online implies configured");
        assert_eq!(
            online.label,
            "Aura Runner online — keeps working with your laptop closed"
        );
    }

    #[test]
    fn working_node_carries_lease_start_and_wave() {
        let mut n = node("t-1", "Build", LOOP_WORKING);
        n.lease_acquired_at_secs = Some(42);
        n.wave_label = Some("wave 2".into());
        n.agent = Some("claude".into());
        let input = root_with("proj", vec![n]);
        let state = merge_state(&[input], host_envelope(false, false));
        assert_eq!(state.live.len(), 1);
        assert_eq!(state.live[0].started_at_ms, Some(42_000));
        assert_eq!(state.live[0].source_detail.as_deref(), Some("wave 2"));
        assert_eq!(state.live[0].agent.as_deref(), Some("claude"));
    }

    #[test]
    fn failed_loop_node_is_not_double_listed_as_live_or_queued() {
        // A failed crew NODE is surfaced via the run ledger, not as live/queued.
        let input = root_with("proj", vec![node("t-1", "Nope", LOOP_FAILED)]);
        let state = merge_state(&[input], host_envelope(false, false));
        assert!(state.live.is_empty());
        assert!(state.queued.is_empty());
    }
}
