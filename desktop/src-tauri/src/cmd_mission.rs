//! Mission Control — Aura's single-pane agent-orchestration overview.
//!
//! One Tauri command, `mission_state`, that aggregates the agent / crew /
//! automation activity that ALREADY EXISTS in each registered project's stores
//! into one typed envelope (`MissionState`). Nothing here invents activity: it
//! reads the same on-disk stores the rest of the app writes —
//!
//!   * **Crew live + queued + recent**: the shared `aura_loop` dependency graph
//!     (`<repo>/.aura/a2a/`) via `aura_loop::ready_view` + the crew run ledger
//!     (`<repo>/.aura/crew/runs.jsonl`, `aura_loop::run_log::RunLedger`).
//!   * **Proof**: the goals ledger (`<repo>/.aura/goals.jsonl`) joined onto a
//!     run by its short commit sha (the same join `aura goals` uses).
//!   * **Automations (triggers + their runs)**: `<repo>/.aura/automations.json`
//!     via the `cmd_automations` model (`Automation` + `RunRecord`).
//!   * **Host (Aura Runner)**: honest liveness from the loop leases — a
//!     `runner:`-prefixed un-expired lease means a runner is online; a runner
//!     config on disk means configured-but-unknown; nothing means not set up.
//!
//! This file is the THIN gather layer (IO behind small wrappers). All the
//! merge / dedupe / cap / title-resolution logic — and its unit tests — live in
//! the pure `merge` submodule so they test from in-memory fixtures with no IO.

mod merge;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use aura_loop::run_log::RunLedger;
use aura_loop::{ready_view, LoopGraph, LoopTask, KIND_WAVE};

// MissionState is the command's return type; the field structs
// (MissionRun/MissionTrigger/MissionHost/MissionProject/MissionProof) live in
// `merge` and are reached through it — re-exporting them here too only adds
// unused-import noise, so keep the surface to the envelope type.
pub use merge::MissionState;
use merge::{
    host_envelope, merge_state, AutomationRunInput, CrewNodeInput, CrewRunNodeInput, ProofInput,
    RootInput, TriggerInput,
};

// ─── The command ──────────────────────────────────────────────────────────

/// Aggregate Mission Control state across the given roots (or every registered
/// project root when `roots` is `None`). Best-effort per root: a missing or
/// corrupt store in one repo contributes nothing and NEVER fails the call.
#[tauri::command]
pub async fn mission_state(roots: Option<Vec<String>>) -> Result<MissionState, String> {
    let roots = roots.unwrap_or_else(crate::cmd_projects::registered_roots);

    let mut inputs: Vec<RootInput> = Vec::new();
    for r in roots.iter().filter(|r| !r.trim().is_empty()) {
        inputs.push(gather_root(r).await);
    }

    // Host is global, not per-repo: a runner online for ANY root means online.
    let (configured, online) = host_facts(&roots);

    Ok(merge_state(&inputs, host_envelope(configured, online)))
}

// ─── Per-root gather (IO; each piece best-effort) ─────────────────────────

/// Gather one project root's stores into the pure `RootInput`. Every reader is
/// fault-tolerant: a missing dir / corrupt file yields an empty piece.
async fn gather_root(root: &str) -> RootInput {
    let name = project_name(root);
    let path = Path::new(root);

    let nodes = list_loop_nodes(path);
    let crew_nodes = crew_node_inputs(&nodes);
    let crew_runs = crew_run_inputs(path);
    let proofs = load_proofs(path);
    let (triggers, automation_runs) = load_automations(root).await;

    RootInput {
        root: root.to_string(),
        name,
        crew_nodes,
        crew_runs,
        proofs,
        triggers,
        automation_runs,
    }
}

/// The display name for a root — its registered label if we have one, else the
/// path basename (the same convention `projects_register` uses as a fallback).
fn project_name(root: &str) -> String {
    if let Some(label) = registered_label(root) {
        return label;
    }
    Path::new(root)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(root)
        .to_string()
}

/// Look up a root's human label from the registry (`~/.aura/projects.json`).
fn registered_label(root: &str) -> Option<String> {
    let path = projects_registry_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let entries: Vec<RegistryEntry> = serde_json::from_str(&raw).ok()?;
    entries
        .into_iter()
        .find(|e| e.root == root)
        .map(|e| e.label)
        .filter(|l| !l.trim().is_empty())
}

#[derive(serde::Deserialize)]
struct RegistryEntry {
    label: String,
    root: String,
}

fn projects_registry_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("projects.json");
    Some(p)
}

// ─── Crew nodes (aura_loop graph) ─────────────────────────────────────────

/// All loop nodes for a root (overlaying lease sidecars). Missing dir → empty.
fn list_loop_nodes(root: &Path) -> Vec<LoopTask> {
    LoopGraph::at(root).list()
}

/// Project the live (working) + queued (ready/blocked) crew nodes into the flat
/// merge input. We classify with the SAME `ready_view` the runner + chat use so
/// the overview can never drift from the board: only `working` and `submitted`
/// nodes become live/queued rows; terminal nodes are surfaced via the run
/// ledger join instead.
fn crew_node_inputs(nodes: &[LoopTask]) -> Vec<CrewNodeInput> {
    let view = ready_view(nodes);
    let wave_labels = wave_label_map(nodes);

    let mut out: Vec<CrewNodeInput> = Vec::new();

    for t in &view.working {
        out.push(crew_node_input(t, &wave_labels, t.depends_on.clone()));
    }
    // `submitted` nodes split into ready (no unmet deps) + blocked (unmet deps).
    // Both are "queued" in Mission Control; the blocked ones carry their unmet
    // dep ids as waitingOn, the ready ones their full dependency list (already
    // satisfied, but still the honest "after these" lineage).
    for t in &view.ready {
        out.push(crew_node_input(t, &wave_labels, t.depends_on.clone()));
    }
    for (t, unmet) in &view.blocked {
        out.push(crew_node_input(t, &wave_labels, unmet.clone()));
    }

    out
}

fn crew_node_input(
    t: &LoopTask,
    wave_labels: &HashMap<String, String>,
    waiting_dep_ids: Vec<String>,
) -> CrewNodeInput {
    CrewNodeInput {
        id: t.id.clone(),
        title: t.title.clone(),
        agent: t.agent_kind.clone().filter(|s| !s.trim().is_empty()),
        status: t.status.clone(),
        depends_on: waiting_dep_ids,
        wave_label: wave_labels.get(&t.id).cloned(),
        lease_acquired_at_secs: t.lease.as_ref().map(|l| l.acquired_at),
        commit: t.commit_sha.clone(),
        error: t.error_message.clone(),
        // The desktop has no real per-node steer command today, so we never
        // claim steerable. (Flip to a carried-in bit if/when a steer seam lands.)
        steerable: false,
        created_at: t.created_at,
        updated_at: t.updated_at,
    }
}

/// Map every task id → its wave label ("wave N"), derived from the `wave` kind
/// nodes in creation order. A task's wave is the wave node it descends from via
/// `parent_task_id`. Tasks not under a wave get no label (honest: no wave).
fn wave_label_map(nodes: &[LoopTask]) -> HashMap<String, String> {
    // 1) Number the wave nodes in creation order.
    let mut waves: Vec<&LoopTask> = nodes.iter().filter(|t| t.task_kind == KIND_WAVE).collect();
    waves.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let mut wave_index: HashMap<String, usize> = HashMap::new();
    for (i, w) in waves.iter().enumerate() {
        wave_index.insert(w.id.clone(), i + 1);
    }
    if wave_index.is_empty() {
        return HashMap::new();
    }

    // 2) For each node, walk up parent links until we hit a wave node.
    let by_id: HashMap<&str, &LoopTask> = nodes.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut out: HashMap<String, String> = HashMap::new();
    for t in nodes {
        if let Some(n) = wave_index.get(&t.id) {
            out.insert(t.id.clone(), format!("wave {n}"));
            continue;
        }
        let mut cursor = t.parent_task_id.clone();
        let mut hops = 0;
        while let Some(pid) = cursor {
            if hops > 16 {
                break; // cycle guard
            }
            if let Some(n) = wave_index.get(&pid) {
                out.insert(t.id.clone(), format!("wave {n}"));
                break;
            }
            cursor = by_id.get(pid.as_str()).and_then(|p| p.parent_task_id.clone());
            hops += 1;
        }
    }
    out
}

// ─── Crew run ledger (recent done/failed) ─────────────────────────────────

/// Read the crew run ledger and flatten each run's terminal nodes into recent
/// inputs, carrying the run's end time for newest-first ordering and the run's
/// agent label when known. Missing ledger → empty.
fn crew_run_inputs(root: &Path) -> Vec<CrewRunNodeInput> {
    let runs = RunLedger::at(root).list();
    let mut out: Vec<CrewRunNodeInput> = Vec::new();
    for run in &runs {
        let agent = run_agent(&run.runner);
        for n in &run.nodes {
            // Only surface nodes that actually finished (skipped nodes never
            // ran — listing them as "done" would be dishonest).
            if n.outcome == "skipped" {
                continue;
            }
            out.push(CrewRunNodeInput {
                id: n.id.clone(),
                title: n.title.clone(),
                outcome: n.outcome.clone(),
                commit: n.commit.clone().filter(|s| !s.trim().is_empty()),
                detail: n.detail.clone().filter(|s| !s.trim().is_empty()),
                agent: agent.clone(),
                ended_at_secs: run.ended_at,
            });
        }
    }
    out
}

/// Derive a friendly agent label from a run's `runner` id. Holders look like
/// `desktop:<pid>` / `loop-<user>-<pid>` / `runner:<id>`; surfacing the raw pid
/// is noise, so we map to a short kind. `None` when it's just a machine id.
fn run_agent(runner: &str) -> Option<String> {
    let r = runner.trim();
    if r.is_empty() {
        return None;
    }
    if r.starts_with("runner:") || r.starts_with("runner-") {
        return Some("Aura Runner".to_string());
    }
    None
}

// ─── Proof (goals.jsonl) ──────────────────────────────────────────────────

/// Load every goal record's NEWEST run that has a commit, keyed by that run's
/// commit sha → {verdict, ok, total}. This is the same join `aura goals` does:
/// "what proof did this commit deliver?". A missing/corrupt ledger → empty map.
///
/// We read the ledger with a minimal local view of the record rather than
/// depending on the `aura-cli` crate (which the desktop doesn't link). Only the
/// `runs[].{commit,verdict,ok,total}` fields are needed.
fn load_proofs(root: &Path) -> HashMap<String, ProofInput> {
    let path = root.join(".aura").join("goals.jsonl");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let mut out: HashMap<String, ProofInput> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<GoalLine>(line) else {
            continue; // malformed line is skipped, not fatal
        };
        // runs are newest-first in the ledger; take the freshest run per commit.
        for run in &rec.runs {
            let Some(commit) = run.commit.as_deref().map(str::trim).filter(|s| !s.is_empty())
            else {
                continue;
            };
            out.entry(commit.to_string()).or_insert_with(|| ProofInput {
                verdict: run.verdict.clone(),
                ok: run.ok,
                total: run.total,
            });
        }
    }
    out
}

#[derive(serde::Deserialize)]
struct GoalLine {
    #[serde(default)]
    runs: Vec<GoalRunLine>,
}

#[derive(serde::Deserialize)]
struct GoalRunLine {
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    ok: u32,
    #[serde(default)]
    total: u32,
    #[serde(default)]
    commit: Option<String>,
}

// ─── Automations (triggers + runs) ────────────────────────────────────────

/// Read `<repo>/.aura/automations.json` (via the `cmd_automations` model) into
/// triggers + their latest runs. Missing/corrupt → empty. We reuse the public
/// `automations_list` reader so we never re-implement the store format.
async fn load_automations(root: &str) -> (Vec<TriggerInput>, Vec<AutomationRunInput>) {
    let automations = crate::cmd_automations::automations_list(root.to_string())
        .await
        .unwrap_or_default();
    let mut triggers: Vec<TriggerInput> = Vec::new();
    let mut runs: Vec<AutomationRunInput> = Vec::new();

    for a in &automations {
        triggers.push(TriggerInput {
            id: a.id.clone(),
            name: a.name.clone(),
            enabled: a.enabled,
            cadence_label: cadence_label(&a.trigger),
            next_run_ms: a.next_run_at.as_deref().and_then(iso_to_ms),
        });
        if let Some(rec) = &a.last_run {
            runs.push(AutomationRunInput {
                id: rec.id.clone(),
                automation_name: a.name.clone(),
                started_at_ms: iso_to_ms(&rec.started_at),
                ended_at_ms: rec.completed_at.as_deref().and_then(iso_to_ms),
                ok: rec.ok,
                summary: rec.summary.clone(),
                lane_id: rec.lane_id.clone(),
                commit: rec.commit.clone().filter(|s| !s.trim().is_empty()),
            });
        }
    }
    (triggers, runs)
}

/// A short, plain-language label for a schedule trigger, e.g.
/// "Every weekday · 9:00am" / "Daily · 9:00am" / "Weekly · Wed · 10:30am".
fn cadence_label(trigger: &crate::cmd_automations::Trigger) -> String {
    let crate::cmd_automations::Trigger::Schedule {
        cadence,
        time_hm,
        weekday,
        ..
    } = trigger;
    let time = pretty_time(time_hm);
    match cadence {
        crate::cmd_automations::Cadence::Hourly => format!("Hourly · at :{}", minute_of(time_hm)),
        crate::cmd_automations::Cadence::Daily => format!("Daily · {time}"),
        crate::cmd_automations::Cadence::Weekdays => format!("Every weekday · {time}"),
        crate::cmd_automations::Cadence::Weekly => {
            format!("Weekly · {} · {time}", weekday_name(weekday.unwrap_or(0)))
        }
    }
}

fn minute_of(time_hm: &str) -> String {
    time_hm
        .trim()
        .split_once(':')
        .map(|(_, m)| m.trim().to_string())
        .unwrap_or_else(|| "00".to_string())
}

fn weekday_name(i: u8) -> &'static str {
    match i % 7 {
        0 => "Mon",
        1 => "Tue",
        2 => "Wed",
        3 => "Thu",
        4 => "Fri",
        5 => "Sat",
        _ => "Sun",
    }
}

/// "09:00" → "9:00am", "14:30" → "2:30pm". Falls back to the raw value.
fn pretty_time(time_hm: &str) -> String {
    let t = time_hm.trim();
    let Some((h, m)) = t.split_once(':') else {
        return t.to_string();
    };
    let (Ok(h), Ok(m)) = (h.trim().parse::<u32>(), m.trim().parse::<u32>()) else {
        return t.to_string();
    };
    if h > 23 || m > 59 {
        return t.to_string();
    }
    let (h12, suffix) = match h {
        0 => (12, "am"),
        1..=11 => (h, "am"),
        12 => (12, "pm"),
        _ => (h - 12, "pm"),
    };
    format!("{h12}:{m:02}{suffix}")
}

/// Parse an RFC3339 instant to unix millis. `None` on a bad/empty value.
fn iso_to_ms(iso: &str) -> Option<i64> {
    let iso = iso.trim();
    if iso.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|d| d.timestamp_millis())
}

// ─── Host (Aura Runner) liveness — honest ─────────────────────────────────

/// Decide (configured, online) for the Aura Runner across every root.
///
/// - **online**: at least one loop node is currently being worked under a
///   `runner:`-prefixed lease that has NOT expired. A live un-expired runner
///   lease is the only thing that proves a remote runner is actually drawing
///   work — we never claim online without it.
/// - **configured**: a runner config exists on disk (the runner crate's
///   `runner.env`, or a runner-style holder was ever seen), OR online is true.
fn host_facts(roots: &[String]) -> (bool, bool) {
    let now = chrono::Utc::now().timestamp();
    let mut configured = runner_config_present();
    let mut online = false;

    for root in roots {
        for t in LoopGraph::at(Path::new(root)).list() {
            let Some(lease) = &t.lease else { continue };
            if !is_runner_holder(&lease.holder) {
                continue;
            }
            // A runner holder was seen → at least configured somewhere.
            configured = true;
            if lease.expires_at > now {
                online = true;
            }
        }
        if online {
            break;
        }
    }
    (configured, online)
}

/// Is this lease holder a remote Aura Runner (vs the local `desktop:<pid>`)?
/// CLI/runner holders are `runner:<id>`, `runner-<id>`, or the loop CLI's
/// `loop-<user>-<pid>`. Desktop holders (`desktop:<pid>`) are NOT runners.
fn is_runner_holder(holder: &str) -> bool {
    let h = holder.trim();
    if h.starts_with("desktop:") {
        return false;
    }
    h.starts_with("runner:") || h.starts_with("runner-") || h.starts_with("loop-")
}

/// Is an Aura Runner configured on this machine? The runner crate drops a
/// `runner.env` (locally `aura-runner/runner.env`, on a VM
/// `/opt/aura-runner/runner.env`). Presence of either = configured.
fn runner_config_present() -> bool {
    if Path::new("/opt/aura-runner/runner.env").exists() {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let p = PathBuf::from(home).join(".aura").join("runner.env");
        if p.exists() {
            return true;
        }
    }
    false
}
