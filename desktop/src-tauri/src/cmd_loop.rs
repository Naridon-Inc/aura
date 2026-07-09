//! Loop-unify — the Tauri surface over the shared `aura-loop` dependency
//! graph (`<repo>/.aura/a2a/`).
//!
//! `aura-loop` is the SHARED model (see `aura-loop/src/lib.rs`): the CLI's
//! `aura loop run` and this app both read one `ready_view` over one on-disk
//! store, so the chat's ready-set and the runner's ready-set can never
//! drift. This module is the desktop half:
//!
//!   * **W2 — board + Jira → DAG sync** (`loop_sync_board`): project the
//!     human task board (`.aura/tasks/`, incl. Jira-imported cards) into the
//!     graph, idempotently, carrying each card's `board_task_id` +
//!     `external_source`/`external_id` provenance and reconciling
//!     `dependencies` into `depends_on` edges.
//!   * **W3 — chat reads the unified ready_view** (`loop_ready_view`): one
//!     serializable snapshot of ready / blocked / working / done the chat's
//!     `/loop` tools render.
//!   * **W4 — runner dispatches into the native Aura brain**
//!     (`loop_run_native`): take the ready-set, claim each node with a lease,
//!     and fan it out through the SAME `manager::dispatcher` the Orchestrator
//!     uses — so the loop runs on Aura's own brain, not a shelled-out CLI. A
//!     background reconciler maps each lane's terminal state back onto the
//!     graph node (Done→complete, Failed→fail, Cancelled/Conflict→released).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use aura_loop::crew::{CrewMeta, CrewRegistry};
use aura_loop::run_log::{RunLedger, RunRecord};
use aura_loop::{
    crews_summary, goals_summary, ready_set, ready_view, BoardProjection, CrewSummary, GoalSummary,
    LoopGraph, LoopTask, RunScope, UpsertKind, STATE_COMPLETED, STATE_FAILED, STATE_PAUSED,
    STATE_SUBMITTED, STATE_WORKING,
};

use crate::cmd_tasks::Task;
use crate::manager::brain::manager::BrainManager;
use crate::manager::brain::types::{ChatChunk, ChatMessage, ChatRequest};
use crate::manager::dispatcher::{self, DispatcherState, ExternalLaneInit};

// ─── DTOs (the crate's `ReadyView` has a tuple in `blocked`, which doesn't
//     serialize cleanly; flatten it for the wire) ──────────────────────────

#[derive(Serialize)]
pub struct BlockedNode {
    pub task: LoopTask,
    /// Dependency ids that aren't `completed` yet (or are missing).
    pub unmet: Vec<String>,
}

#[derive(Serialize)]
pub struct ReadyCounts {
    pub ready: usize,
    pub blocked: usize,
    pub working: usize,
    pub done: usize,
    /// W-B: nodes parked out of the ready set by a pause.
    pub paused: usize,
    pub other: usize,
}

#[derive(Serialize)]
pub struct ReadyViewDto {
    pub ready: Vec<LoopTask>,
    pub blocked: Vec<BlockedNode>,
    pub working: Vec<LoopTask>,
    pub done: Vec<LoopTask>,
    /// W-B: paused nodes (held back from the ready set, resumable).
    pub paused: Vec<LoopTask>,
    pub other: Vec<LoopTask>,
    pub counts: ReadyCounts,
    /// W-B: per-goal rollup so each goal node can carry its own Run/Pause
    /// controls. Empty when no node carries a `goal:` tag.
    pub goals: Vec<GoalSummary>,
    /// W-C: per-crew rollup so the surface can show crews side-by-side and
    /// run/pause a second crew while the first works.
    pub crews: Vec<CrewSummary>,
}

fn read_view(graph: &LoopGraph) -> ReadyViewDto {
    let all = graph.list();
    let view = ready_view(&all);
    let counts = ReadyCounts {
        ready: view.ready.len(),
        blocked: view.blocked.len(),
        working: view.working.len(),
        done: view.done.len(),
        paused: view.paused.len(),
        other: view.other.len(),
    };
    ReadyViewDto {
        ready: view.ready,
        blocked: view
            .blocked
            .into_iter()
            .map(|(task, unmet)| BlockedNode { task, unmet })
            .collect(),
        working: view.working,
        done: view.done,
        paused: view.paused,
        other: view.other,
        counts,
        goals: goals_summary(&all),
        crews: crews_summary(&all),
    }
}

/// The lease holder this desktop process stamps when it claims a node —
/// `desktop:<pid>`. Carrying the pid (not an anonymous "aura-loop") lets a
/// later read tell a lease held by THIS live app apart from one a crashed or
/// closed PRIOR app instance abandoned.
fn desktop_holder() -> String {
    format!("desktop:{}", std::process::id())
}

/// Self-heal stuck `working` nodes before the surface reads them, so the board
/// can never sit lying that an agent is "on it" when nothing is. Two cases:
///
///   * **Lease expired** — `reclaim_stale` returns it to the ready set. Covers
///     both CLI (`aura loop run`) and desktop runs once the 30-min TTL lapses.
///   * **Lease held by a prior desktop instance** (`desktop:<pid>` ≠ this
///     process) — reclaimed immediately, without waiting out the TTL. The
///     desktop app is a singleton: a desktop lease stamped by a different pid
///     can only be a closed/crashed run whose in-memory reconciler died with
///     it, so there is no live agent behind it. This collapses the "phantom
///     working" window from the full lease to a single Crew refresh. A CLI
///     (`aura-loop`) lease is left to the expiry path, since that process may
///     genuinely still be running in a terminal.
///
/// A no-op when nothing is stuck — live leases owned by this process are
/// preserved untouched.
fn reclaim_for_view(graph: &LoopGraph) {
    graph.reclaim_stale();
    let mine = desktop_holder();
    for t in graph.list() {
        if t.status != STATE_WORKING {
            continue;
        }
        if let Some(l) = &t.lease {
            if l.holder.starts_with("desktop:") && l.holder != mine {
                let _ = graph.set_status(&t.id, STATE_SUBMITTED);
            }
        }
    }
}

// ─── W3: ready_view ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn loop_ready_view(repo_root: String) -> Result<ReadyViewDto, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    // Re-arm any orphaned `working` node on every refresh — an app killed
    // mid-run leaves the node it leased stuck `working` until its lease expires
    // (and its in-memory reconciler is gone), so without this the surface shows
    // a forever-spinner with no agent behind it.
    reclaim_for_view(&graph);
    Ok(read_view(&graph))
}

// ─── W2: board + Jira → DAG sync ────────────────────────────────────────

#[derive(Serialize)]
pub struct LoopSyncResult {
    pub created: usize,
    pub updated: usize,
    /// Total nodes considered (active frontier + pulled-in dependency targets).
    pub synced: usize,
    /// `depends_on` edges (re)established from board `dependencies`.
    pub edges: usize,
}

/// Map a board card to an A2A lifecycle state, reading the canonical
/// `state_id` first and only falling back to the legacy `status` string.
/// This matters for Jira-imported cards: the import sets `state_id` (the
/// column the board shows) but can leave `status` stale, so a Closed ticket
/// pulled in as a dependency must still resolve as `completed` (and unblock
/// its dependents) rather than re-appear as ready work. A human's
/// `in_progress` is NOT a runner lease, so it maps to `submitted` — `working`
/// is reserved for nodes a loop lease owns.
fn map_status(t: &Task) -> String {
    match t.state_id.as_str() {
        // A cancelled blocker will never complete; treat it as resolved so it
        // doesn't stall everything waiting on it.
        "completed" | "cancelled" => STATE_COMPLETED,
        "backlog" | "unstarted" | "started" => match t.status.as_str() {
            "done" => STATE_COMPLETED,
            _ => STATE_SUBMITTED,
        },
        // Unknown / custom state — defer to the legacy string.
        _ => match t.status.as_str() {
            "done" => STATE_COMPLETED,
            _ => STATE_SUBMITTED,
        },
    }
    .to_string()
}

/// Whether a board card belongs on the plan canvas. Discarded work — closed,
/// cancelled, or archived — is kept off so the flow shows only what's genuinely
/// left to do. Reads `state_id` (the column the board actually displays the
/// card in), because a Jira import can leave the legacy `status` stale behind a
/// correct `state_id` — which is exactly why closed Jira tickets were leaking
/// onto the canvas while the board itself looked fine.
fn is_plannable(t: &Task) -> bool {
    if t.archived_at.is_some() {
        return false;
    }
    let terminal_state = matches!(
        t.state_id.as_str(),
        "completed" | "cancelled" | "done" | "canceled"
    );
    !(terminal_state || t.status == "done")
}

/// Board's 5-stop priority → the graph's 4-stop ready-ordering weight.
fn map_priority(p: &str) -> String {
    match p.to_lowercase().as_str() {
        "urgent" => "critical",
        "high" => "high",
        "medium" => "medium",
        _ => "low", // low | none
    }
    .to_string()
}

/// Board hierarchy → A2A `task_kind`. An epic is a container (plan); a card
/// with a parent is a subtask; everything else is a task.
fn map_kind(t: &Task) -> String {
    if t.is_epic {
        aura_loop::KIND_PLAN
    } else if t.parent_id.is_some() {
        aura_loop::KIND_SUBTASK
    } else {
        aura_loop::KIND_TASK
    }
    .to_string()
}

#[tauri::command]
pub async fn loop_sync_board(repo_root: String) -> Result<LoopSyncResult, String> {
    let tasks = crate::cmd_tasks::tasks_list(repo_root.clone()).await?;
    let graph = LoopGraph::at(Path::new(&repo_root));

    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();

    // Scope: the active frontier (everything still plannable) PLUS any card an
    // active one needs in view — a done/cancelled dependency (so a "blocked on
    // a completed task" edge resolves instead of stalling on a missing node)
    // and the card's parent epic (so the flow can cluster it under that epic
    // even when the epic itself isn't in the active frontier). Discarded work —
    // closed, cancelled, archived — is filtered by `is_plannable`, so we never
    // drag the historical / Jira-junk board into the canvas.
    let mut want: HashSet<String> = HashSet::new();
    for t in &tasks {
        if is_plannable(t) {
            want.insert(t.id.clone());
            for d in &t.dependencies {
                if by_id.contains_key(d.as_str()) {
                    want.insert(d.clone());
                }
            }
            if let Some(parent) = &t.parent_id {
                if by_id.contains_key(parent.as_str()) {
                    want.insert(parent.clone());
                }
            }
        }
    }

    // Pass 1 — upsert every wanted card; build board-id → graph-node-id.
    let mut node_for_board: HashMap<String, String> = HashMap::new();
    let mut created = 0usize;
    let mut updated = 0usize;
    for t in &tasks {
        if !want.contains(&t.id) {
            continue;
        }
        // Carry the sprint as a synthetic `sprint:<slug>` tag alongside the
        // board's own labels. Tags already travel through the projection and
        // the canvas only reads tags by prefix, so this groups work by sprint
        // without a schema change or a stray visible chip.
        let mut tags = t.labels.clone();
        if let Some(sprint) = t.sprint.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            tags.push(format!("sprint:{sprint}"));
        }
        let proj = BoardProjection {
            board_task_id: t.id.clone(),
            title: t.title.clone(),
            input: t.description.clone(),
            priority: map_priority(&t.priority),
            kind: map_kind(t),
            status: map_status(t),
            agent_kind: t.agent_assignee.clone(),
            // Resolved in pass 2 once every node exists (like deps), so a child
            // can point at its epic's graph node for clustering.
            parent_task_id: None,
            external_source: t.external_source.clone(),
            external_id: t.external_id.clone(),
            tags,
            // The real human who owns this card (legacy single, else first of
            // the multi-assignee list) — shown on every node beside the agent.
            assignee: t
                .assignee
                .clone()
                .or_else(|| t.assignee_ids.first().cloned()),
        };
        let (node, kind) = graph
            .upsert_from_board(proj)
            .map_err(|e| format!("upsert {}: {e}", t.id))?;
        match kind {
            UpsertKind::Created => created += 1,
            UpsertKind::Updated => updated += 1,
        }
        node_for_board.insert(t.id.clone(), node.id);
    }

    // Pass 2 — reconcile `dependencies` into `depends_on` edges now that
    // every referenced node exists. `add_dep` is idempotent + cycle-checked;
    // a benign "already" / cycle / missing-target error is skipped, not fatal.
    let mut edges = 0usize;
    for t in &tasks {
        let Some(node_id) = node_for_board.get(&t.id) else {
            continue;
        };
        for dep_board_id in &t.dependencies {
            if let Some(dep_node_id) = node_for_board.get(dep_board_id) {
                if graph.add_dep(node_id, dep_node_id).is_ok() {
                    edges += 1;
                }
            }
        }
        // Point the card at its epic's graph node, so the canvas can cluster a
        // big board into readable epic lanes. Resolved here for the same reason
        // deps are: every referenced node now exists.
        if let Some(parent_board) = &t.parent_id {
            if let Some(parent_node) = node_for_board.get(parent_board) {
                let _ = graph.set_parent(node_id, parent_node);
            }
        }
    }

    Ok(LoopSyncResult {
        created,
        updated,
        synced: node_for_board.len(),
        edges,
    })
}

// ─── W4: runner dispatches into the native Aura brain ───────────────────

#[derive(Serialize)]
pub struct DispatchedNode {
    pub node_id: String,
    pub lane_id: String,
    pub title: String,
}

#[derive(Serialize)]
pub struct LoopRunResult {
    pub wave_id: String,
    pub dispatched: Vec<DispatchedNode>,
    /// Ready nodes left unscheduled this run (when `max` capped the batch).
    pub ready_remaining: usize,
}

/// Compose the brain's first-turn objective from a loop node — title, then
/// the body, then any acceptance criteria, so the native brain has the full
/// brief without re-reading the board.
fn build_objective(t: &LoopTask) -> String {
    let mut s = t.title.clone();
    if !t.input.trim().is_empty() {
        s.push_str("\n\n");
        s.push_str(t.input.trim());
    }
    if let Some(ac) = &t.acceptance_criteria {
        if !ac.trim().is_empty() {
            s.push_str("\n\nAcceptance criteria:\n");
            s.push_str(ac.trim());
        }
    }
    s
}

/// One dispatched node, paired to the lane that mirrors it on the canvas. The
/// reader task attributes the CLI's per-node stderr to a lane by matching the
/// `→ <short_id> …` marker to `short_id`, and reconciles the final outcome
/// against the graph node `node_id`.
struct LaneTarget {
    lane_id: String,
    node_id: String,
    short_id: String,
    title: String,
}

#[tauri::command]
pub async fn loop_run_native(
    app: AppHandle,
    state: State<'_, Arc<DispatcherState>>,
    repo_root: String,
    max: Option<usize>,
    // W-B: drain only one goal's nodes; W-C: drain only one crew's nodes.
    // Either or both narrow the ready set; both `None` runs the whole graph.
    goal: Option<String>,
    crew: Option<String>,
) -> Result<LoopRunResult, String> {
    // Thin wrapper over `run_native_dispatch` so the SAME real dispatch can be
    // driven from inside the process (a plan Build auto-starting the Crew the
    // instant the user clicks Build) without re-plumbing a `State` extractor.
    run_native_dispatch(app, state.inner().clone(), repo_root, max, None, goal, crew).await
}

/// Dispatch the ready set (optionally scoped to a `goal`/`crew`) into the real
/// `aura crew run` harness — the in-process core of [`loop_run_native`].
///
/// Exposed `pub(crate)` and taking an owned `Arc<DispatcherState>` so a plan
/// Build (`manager_decide_plan`) can hand its freshly-synced tasks straight to
/// the Crew runner — Crew is the runner, not an invisible subagent fan-out —
/// rather than only firing from the Crew surface's Run button. `jobs_override`
/// pins the worktree-agent concurrency (a Serial plan passes `Some(1)`); `None`
/// keeps the default clamp.
pub(crate) async fn run_native_dispatch(
    app: AppHandle,
    state: Arc<DispatcherState>,
    repo_root: String,
    max: Option<usize>,
    jobs_override: Option<usize>,
    goal: Option<String>,
    crew: Option<String>,
) -> Result<LoopRunResult, String> {
    let root = PathBuf::from(&repo_root);
    let graph = LoopGraph::at(&root);

    // Recover any node a crashed prior run left leased (expired lease OR a
    // lease stamped by a closed prior desktop instance), then snapshot the
    // ready set off the on-disk truth, narrowed to the requested scope.
    reclaim_for_view(&graph);
    let scope = RunScope {
        goal: goal.clone().filter(|s| !s.trim().is_empty()),
        crew: crew.clone().filter(|s| !s.trim().is_empty()),
    };
    let all = graph.list();
    let ready: Vec<LoopTask> = {
        let r = ready_set(&all);
        if scope.is_unscoped() {
            r
        } else {
            scope.filter(&r)
        }
    };
    let total_ready = ready.len();
    let take = max.unwrap_or(total_ready).min(total_ready);
    if take == 0 {
        return Ok(LoopRunResult {
            wave_id: String::new(),
            dispatched: vec![],
            ready_remaining: 0,
        });
    }

    // The nodes this run will work — the top `take` of the ready set, in the
    // SAME priority order the CLI's `scoped_ready` drains them, so the lanes we
    // register line up with the nodes `aura crew run` actually picks.
    let planned: Vec<LoopTask> = ready.into_iter().take(take).collect();

    // Register one canvas lane per planned node (label = title) so "Watch live"
    // can find the lane the instant the CLI starts on it. We deliberately do
    // NOT claim the nodes here: the bundled CLI claims each as it begins and is
    // the SINGLE writer of graph state (status + commit_sha + error). That's the
    // whole point of the swap — the desktop's "Run" now drives the same real
    // coding-agent harness as `aura crew run` (edits + commits + verify gate),
    // not a tool-less `Brain::chat` lane that can only describe.
    let wave_id = format!("crew-{}", uuid::Uuid::new_v4());
    let inits: Vec<ExternalLaneInit> = planned
        .iter()
        .map(|t| ExternalLaneInit {
            label: t.title.clone(),
            objective: build_objective(t),
        })
        .collect();
    let (lane_ids, cancel) = state.register_external_wave(&wave_id, inits);

    let lane_targets: Vec<LaneTarget> = planned
        .iter()
        .zip(lane_ids.iter())
        .map(|(t, lane_id)| LaneTarget {
            lane_id: lane_id.clone(),
            node_id: t.id.clone(),
            short_id: t.short_id().to_string(),
            title: t.title.clone(),
        })
        .collect();
    let dispatched: Vec<DispatchedNode> = lane_targets
        .iter()
        .map(|l| DispatchedNode {
            node_id: l.node_id.clone(),
            lane_id: l.lane_id.clone(),
            title: l.title.clone(),
        })
        .collect();

    // Spawn the runner in the background and return immediately — the canvas
    // already has its lanes (Queued); the reader task flips each Running →
    // Done/Failed as the real agent reports progress, streaming its output into
    // the lane's transcript so the user can watch it build.
    let bg_app = app;
    let bg_state = state.clone();
    let bg_wave = wave_id.clone();
    let run_goal = scope.goal.clone();
    let run_crew = scope.crew.clone();
    // Worktree-per-agent is the default: each dispatched node gets its own
    // throwaway git worktree + branch so concurrent agents never collide on the
    // shared tree/index, and passing work is AST-merged back. We cap concurrency
    // at 4 real coding agents (each is a full agent process) and never go below 2
    // so a single-node run still gets an isolated worktree rather than mutating
    // the live checkout under the user. `jobs_override` lets a caller pin it —
    // a Serial plan Build passes `Some(1)` to watch one task at a time.
    let run_jobs = jobs_override
        .map(|j| j.max(1))
        .unwrap_or_else(|| take.clamp(2, 4));
    tokio::spawn(async move {
        run_external_crew(
            bg_app, bg_state, root, bg_wave, lane_targets, take, run_jobs, run_goal, run_crew,
            cancel,
        )
        .await;
    });

    Ok(LoopRunResult {
        wave_id,
        dispatched,
        ready_remaining: total_ready.saturating_sub(take),
    })
}

/// Wall-clock seconds for the run ledger (the crate's RunRecord stamps are
/// caller-supplied so the engine stays clock-free for replay).
fn ledger_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Drive one `aura crew run` to completion, streaming each real coding agent's
/// per-node output into the canvas lanes so the user can watch them build.
///
/// We run the bundled CLI in its human (non-`--json`) mode on purpose: `--json`
/// suppresses ALL live progress, and the live transcript is the whole point of
/// "Watch live". Worktree-per-agent is the default (`--jobs >= 2`): every node
/// builds in its OWN throwaway git worktree on its own branch, so concurrent
/// agents never fight over one working tree or index, and only work that passes
/// its acceptance gate is merged back (via the AST merge driver the CLI installs
/// for the run). Attribution stays exact because:
///   • the CLI prints `→ <short_id> <title> [branch]` when it starts a node;
///   • each agent's streamed output line is tagged `[<short_id>] …`;
///   • settle markers carry the short id — `✓ merged <short_id> <commit>`,
///     `✗ merge <short_id> …`, `✗ failed <short_id> …`.
/// We map every line back to its lane by `short_id`. The CLI is the single
/// writer of graph state, so `commit_sha`/`status`/`error_message` on the node
/// are the source of truth; `finalize_lanes` reconciles any lane a marker didn't
/// settle against the graph after the run exits.
#[allow(clippy::too_many_arguments)]
async fn run_external_crew(
    app: AppHandle,
    state: Arc<DispatcherState>,
    repo_root: PathBuf,
    wave_id: String,
    lanes: Vec<LaneTarget>,
    max: usize,
    jobs: usize,
    goal: Option<String>,
    crew: Option<String>,
    cancel: Arc<tokio::sync::Notify>,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};

    // Nodes can name their own agent; this is only the default for nodes that
    // don't (mirrors the CLI's `--agent` default).
    let default_agent = "claude";
    // `jobs > 1` puts the CLI on its worktree path and tags each agent's output
    // line with its `[<short_id>]`; sequential mode streams untagged.
    let parallel = jobs > 1;

    let bin = crate::agent_event_listener::resolve_aura_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("crew")
        .arg("run")
        // Verified-or-reverted: a node whose work fails its acceptance gate is
        // rolled back in place instead of leaving broken code on the branch.
        .arg("--rollback")
        // Worktree-per-agent: isolate each node so agents don't collide on the
        // shared tree/index, and reconcile via the AST merge driver.
        .arg("--jobs")
        .arg(jobs.to_string())
        .arg("--agent")
        .arg(default_agent)
        .arg("--max")
        .arg(max.to_string());
    if let Some(g) = goal.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--goal").arg(g);
    }
    if let Some(c) = crew.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--crew").arg(c);
    }
    cmd.current_dir(&repo_root)
        // Plain, parseable markers — kill ANSI from the `colored` crate and any
        // child that honors NO_COLOR. We also strip ANSI defensively below.
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        // Don't let the dispatched agents inherit THIS app's manager session.
        .env_remove("AURA_MANAGER_SESSION_ID")
        .stdin(std::process::Stdio::null())
        // Human/agent log + markers go to the CLI's stderr; stdout stays empty
        // in non-json mode, so null it.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Couldn't start the crew runner: {e}");
            for l in &lanes {
                dispatcher::external_lane_failed(&app, &state, &l.lane_id, msg.clone());
            }
            state.drop_external_wave(&wave_id);
            return;
        }
    };

    let mut settled: HashSet<String> = HashSet::new();
    if let Some(stderr) = child.stderr.take() {
        let mut reader = BufReader::new(stderr).lines();
        // In parallel mode many nodes run at once, so there's no single "active"
        // lane — every output line is tagged `[<short_id>]` and every settle
        // marker names its short id. We still track the most recently started
        // lane so sequential mode (jobs == 1, untagged stream) keeps working and
        // so a settle marker with no explicit id can fall back to it.
        let mut last_started: Option<usize> = None;
        loop {
            tokio::select! {
                // "Stop this agent" (or "Stop the crew") fired the wave's
                // cancel — kill the child so the real agents actually stop.
                _ = cancel.notified() => {
                    let _ = child.start_kill();
                    break;
                }
                next = reader.next_line() => {
                    match next {
                        Ok(Some(raw)) => {
                            let clean = strip_ansi(&raw);
                            let line = clean.trim_end_matches(['\r', '\n']);
                            // A node just started — flip its lane Running
                            // (stamping the agent) and remember it as the
                            // sequential fallback target.
                            if let Some(idx) = match_start_marker(line, &lanes) {
                                last_started = Some(idx);
                                dispatcher::external_lane_started(
                                    &app, &state, &lanes[idx].lane_id, default_agent,
                                );
                                continue;
                            }
                            // A node settled — record it from the marker for
                            // instant feedback (finalize confirms it against the
                            // graph after the run). Parallel markers name the
                            // lane; sequential ones use the last-started lane.
                            if let Some(s) = match_settle_marker(line, &lanes) {
                                if let Some(idx) = s.lane.or(last_started) {
                                    let lane_id = lanes[idx].lane_id.clone();
                                    if s.ok {
                                        dispatcher::external_lane_done(
                                            &app, &state, &lane_id, s.summary,
                                        );
                                    } else {
                                        dispatcher::external_lane_failed(
                                            &app, &state, &lane_id, s.summary,
                                        );
                                    }
                                    settled.insert(lane_id);
                                    if last_started == Some(idx) {
                                        last_started = None;
                                    }
                                }
                                continue;
                            }
                            // Parallel agent output is tagged `[<short_id>] …` —
                            // route it to that lane regardless of interleaving.
                            if let Some((idx, text)) = match_prefixed_output(line, &lanes) {
                                if !text.is_empty() {
                                    dispatcher::external_lane_push(
                                        &app, &state, &lanes[idx].lane_id, &format!("{text}\n"),
                                    );
                                }
                                continue;
                            }
                            // Untagged, non-marker line. In sequential mode it's
                            // the active node's output → stream it. In parallel
                            // mode it's runner chrome (preamble / between nodes /
                            // summary) with no owning lane → drop it.
                            if !parallel {
                                if let Some(idx) = last_started {
                                    if !line.is_empty() {
                                        dispatcher::external_lane_push(
                                            &app, &state, &lanes[idx].lane_id,
                                            &format!("{line}\n"),
                                        );
                                    }
                                }
                            }
                        }
                        Ok(None) => break, // EOF — the runner exited
                        Err(_) => break,
                    }
                }
            }
        }
    }

    let _ = child.wait().await;

    // Reconcile every lane a marker didn't settle against the live graph — the
    // CLI is the single writer of node status + commit, so it's the truth.
    finalize_lanes(&app, &state, &repo_root, &lanes, &settled);
    state.drop_external_wave(&wave_id);
}

/// After the run exits, settle any lane that wasn't already closed by a live
/// marker, reading the authoritative node state the CLI wrote to the graph.
/// A node still ready/working (never reached this pass — capped, cancelled, or
/// displaced by a newly-unblocked node) is left as-is: it's honestly still in
/// the queue, not a failure of this task, and the board reflects that.
fn finalize_lanes(
    app: &AppHandle,
    state: &DispatcherState,
    repo_root: &Path,
    lanes: &[LaneTarget],
    settled: &HashSet<String>,
) {
    let graph = LoopGraph::at(repo_root);
    for l in lanes {
        if settled.contains(&l.lane_id) {
            continue;
        }
        match graph.get(&l.node_id) {
            Some(n) if n.status == STATE_COMPLETED => {
                let summary = match n.commit_sha.as_deref() {
                    Some(sha) if !sha.is_empty() => format!("Committed {}", short_sha(sha)),
                    _ => "Finished — no new commit".to_string(),
                };
                dispatcher::external_lane_done(app, state, &l.lane_id, summary);
            }
            Some(n) if n.status == STATE_FAILED => {
                let err = n
                    .error_message
                    .clone()
                    .unwrap_or_else(|| "This task didn't pass its check.".to_string());
                dispatcher::external_lane_failed(app, state, &l.lane_id, err);
            }
            // Non-terminal (still queued/in flight) → leave the lane Queued; the
            // wave is evicted on the next dispatch and the board shows the truth.
            _ => {}
        }
    }
}

/// First 7 chars of a commit sha — the human-friendly short form.
fn short_sha(s: &str) -> String {
    s.chars().take(7).collect()
}

/// Strip ANSI CSI (`ESC [ … final`) and OSC (`ESC ] … BEL|ESC\`) escapes so
/// marker matching and the transcript stay clean even if an agent emits color.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                // CSI — consume until a final byte in 0x40..=0x7e.
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                // OSC — consume until BEL or ESC\.
                while let Some(&n) = chars.peek() {
                    if n == '\u{7}' {
                        chars.next();
                        break;
                    }
                    if n == '\u{1b}' {
                        chars.next();
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                    chars.next();
                }
            }
            // Lone ESC — drop it.
            _ => {}
        }
    }
    out
}

/// Match a CLI node-start marker (`→ <short_id> <title>`) to a lane by its
/// short id. Returns the lane index, or `None` for any other line.
fn match_start_marker(line: &str, lanes: &[LaneTarget]) -> Option<usize> {
    let rest = line.trim_start().strip_prefix('→')?;
    let token = rest.trim_start().split_whitespace().next()?;
    lanes.iter().position(|l| l.short_id == token)
}

/// A node reaching a terminal state, parsed from a settle marker.
struct Settle {
    /// The lane the marker explicitly named (parallel markers carry the short
    /// id); `None` for sequential markers that rely on the last-started lane.
    lane: Option<usize>,
    ok: bool,
    summary: String,
}

/// Parse a node-settled marker the CLI prints when a node reaches a terminal
/// state, mapping it to a lane and a plain-language summary. Recognizes both the
/// sequential forms (`✓ completed <commit?>`, `✗ failed <reason>`) and the
/// parallel `--jobs` worktree forms that carry the short id (`✓ merged <id>
/// <commit>`, `✗ merge <id> <reason>`, `✗ failed <id> <reason>`, and the
/// worktree-create failure `✗ <id> <reason>`). Returns `None` for any other
/// line. Parsing is shared with `match_prefixed_output`/`match_start_marker` so
/// the same `short_id ↔ lane` map drives all attribution.
fn match_settle_marker(line: &str, lanes: &[LaneTarget]) -> Option<Settle> {
    let lane_of = |sid: &str| lanes.iter().position(|l| l.short_id == sid);
    let t = line.trim_start();

    if let Some(rest) = t.strip_prefix('✓') {
        let (kw, after) = split_first(rest.trim_start());
        return match kw {
            // Sequential: "✓ completed <commit?>".
            "completed" => Some(Settle { lane: None, ok: true, summary: commit_summary(after) }),
            // Parallel: "✓ merged <short_id> <commit?>".
            "merged" => {
                let (sid, commit) = split_first(after);
                Some(Settle { lane: lane_of(sid), ok: true, summary: commit_summary(commit) })
            }
            _ => None,
        };
    }
    if let Some(rest) = t.strip_prefix('✗') {
        let (kw, after) = split_first(rest.trim_start());
        return match kw {
            // "✗ failed <reason>" (sequential) or, if the next token is a known
            // lane, the parallel "✗ failed <short_id> <reason>".
            "failed" => {
                let (maybe_sid, reason) = split_first(after);
                match lane_of(maybe_sid) {
                    Some(idx) => Some(Settle {
                        lane: Some(idx),
                        ok: false,
                        summary: fail_summary(reason),
                    }),
                    None => Some(Settle { lane: None, ok: false, summary: fail_summary(after) }),
                }
            }
            // Parallel merge-back failure: "✗ merge <short_id> <reason>".
            "merge" => {
                let (sid, reason) = split_first(after);
                Some(Settle { lane: lane_of(sid), ok: false, summary: fail_summary(reason) })
            }
            // Worktree-create failure: "✗ <short_id> <reason>" — the keyword
            // token IS the short id.
            other => lane_of(other).map(|idx| Settle {
                lane: Some(idx),
                ok: false,
                summary: fail_summary(after),
            }),
        };
    }
    None
}

/// Route a parallel-mode agent line tagged `[<short_id>] <text>` to its lane,
/// returning `(lane_idx, text)` with the tag stripped. `None` when the line has
/// no recognized lane tag (sequential output or runner chrome).
fn match_prefixed_output(line: &str, lanes: &[LaneTarget]) -> Option<(usize, String)> {
    let rest = line.trim_start().strip_prefix('[')?;
    let close = rest.find(']')?;
    let idx = lanes.iter().position(|l| l.short_id == &rest[..close])?;
    let text = rest[close + 1..].strip_prefix(' ').unwrap_or(&rest[close + 1..]);
    Some((idx, text.to_string()))
}

/// Split a string into its first whitespace-delimited token and the trimmed
/// remainder (`""` for each when absent).
fn split_first(s: &str) -> (&str, &str) {
    let s = s.trim_start();
    match s.split_once(char::is_whitespace) {
        Some((head, tail)) => (head, tail.trim()),
        None => (s, ""),
    }
}

/// Plain-language summary for a successful settle: a shortened commit, or a note
/// that the node finished without one (empty or parenthesised commit field).
fn commit_summary(commit: &str) -> String {
    let c = commit.trim();
    if c.is_empty() || c.starts_with('(') {
        "Finished — no new commit".to_string()
    } else {
        format!("Committed {}", short_sha(c))
    }
}

/// Plain-language summary for a failed settle: the runner's reason, or a generic
/// line when it gave none.
fn fail_summary(reason: &str) -> String {
    let r = reason.trim();
    if r.is_empty() {
        "This task didn't finish.".to_string()
    } else {
        r.to_string()
    }
}

// ─── Manual node control (the panel's release / cancel affordance) ──────

#[tauri::command]
pub async fn loop_set_status(
    repo_root: String,
    node_id: String,
    status: String,
) -> Result<LoopTask, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    graph.set_status(&node_id, &status)
}

// ─── W-B: run controls (pause/resume) + run history ─────────────────────
//
// "Start each goal individually and pause individually." A goal node on the
// surface is a control panel: Run its subtree (`loop_run_native` with `goal`),
// Pause it (park its whole member set out of the ready set), Resume it. The
// same three verbs take a single `node_id` for one-task control, or a
// `goal`/`crew` scope for a whole subtree — backed by the shared
// `LoopGraph::pause/resume` + `pause_scope/resume_scope`. Every dispatched run
// is already journaled to `.aura/crew/runs.jsonl` (see `reconcile_wave`);
// `loop_runs` reads that ledger back for the goal node's run-history panel.

/// Park work out of the ready set. Pass `node_id` for one task, or a
/// `goal`/`crew` scope to pause a whole subtree. Returns the ids actually
/// parked (already-paused/terminal nodes are skipped) so the caller can report
/// "paused 4 tasks". A pause is advisory — an in-flight agent finishes on its
/// own; the node just won't be re-dispatched.
#[tauri::command]
pub async fn loop_pause(
    repo_root: String,
    node_id: Option<String>,
    goal: Option<String>,
    crew: Option<String>,
) -> Result<Vec<String>, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    if let Some(id) = node_id {
        let task = graph.pause(&id)?;
        return Ok(if task.status == STATE_PAUSED {
            vec![task.id]
        } else {
            Vec::new()
        });
    }
    let scope = RunScope { goal, crew };
    if scope.is_unscoped() {
        return Err("pause needs a node_id, goal, or crew".into());
    }
    Ok(graph.pause_scope(&scope))
}

/// Un-park work back into the ready set. Mirror of [`loop_pause`]: one task by
/// `node_id`, or a whole `goal`/`crew` subtree. Returns the ids re-armed.
#[tauri::command]
pub async fn loop_resume(
    repo_root: String,
    node_id: Option<String>,
    goal: Option<String>,
    crew: Option<String>,
) -> Result<Vec<String>, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    if let Some(id) = node_id {
        let was_paused = graph.get(&id).map(|t| t.status == STATE_PAUSED).unwrap_or(false);
        let task = graph.resume(&id)?;
        return Ok(if was_paused && task.status == STATE_SUBMITTED {
            vec![task.id]
        } else {
            Vec::new()
        });
    }
    let scope = RunScope { goal, crew };
    if scope.is_unscoped() {
        return Err("resume needs a node_id, goal, or crew".into());
    }
    Ok(graph.resume_scope(&scope))
}

/// The crew's run history, newest first. Each record is one dispatched run —
/// who ran it, its scope (whole graph / one goal / one crew), how many nodes it
/// attempted, and the per-node outcome + commit. This is what the goal node's
/// run-history panel reads. `limit` caps the list (default 25).
#[tauri::command]
pub async fn loop_runs(repo_root: String, limit: Option<usize>) -> Result<Vec<RunRecord>, String> {
    let mut runs = RunLedger::at(Path::new(&repo_root)).list();
    runs.truncate(limit.unwrap_or(25));
    Ok(runs)
}

// ─── W-C: multiple crews (registry + spawn) ─────────────────────────────
//
// The graph already namespaces every node by `crew_id`; the registry
// (`.aura/crew/crews.json`) gives a crew durable identity (name, creation
// time) so a second crew can exist and run in parallel with the first — even
// before any work is assigned to it. `loop_crews` joins the registry to the
// live per-crew counts; `loop_crew_spawn` mints a crew and optionally moves
// the named nodes onto it.

/// One crew as the surface shows it: its durable identity joined to live
/// lifecycle counts from the graph. A crew present in the graph but not the
/// registry (raw `crew_id` on some node) still surfaces, titled by its id.
#[derive(Serialize)]
pub struct CrewRow {
    pub meta: CrewMeta,
    pub summary: CrewSummary,
}

/// Every crew (registry ∪ crews live in the graph), "main" first. Each row
/// carries the crew's identity and its current ready/working/done/paused tally
/// so the surface can render a crew switcher with live badges.
#[tauri::command]
pub async fn loop_crews(repo_root: String) -> Result<Vec<CrewRow>, String> {
    let root = Path::new(&repo_root);
    let graph = LoopGraph::at(root);
    let registry = CrewRegistry::at(root);
    let summaries = crews_summary(&graph.list());

    let mut rows: Vec<CrewRow> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // Registry order first (main, then spawned in creation order).
    for meta in registry.list() {
        let summary = summaries
            .iter()
            .find(|s| s.crew == meta.id)
            .cloned()
            .unwrap_or_else(|| empty_crew_summary(&meta.id));
        seen.insert(meta.id.clone());
        rows.push(CrewRow { meta, summary });
    }
    // Then any crew that lives only in the graph (a raw crew_id, never
    // registered) so nothing the loop is actually running stays hidden.
    for summary in summaries {
        if seen.contains(&summary.crew) {
            continue;
        }
        let meta = CrewMeta {
            id: summary.crew.clone(),
            title: summary.crew.clone(),
            description: None,
            created_at: 0,
        };
        rows.push(CrewRow { meta, summary });
    }
    Ok(rows)
}

/// A zero-count summary for a crew that exists in the registry but has no nodes
/// yet — so a freshly-spawned empty crew still renders with a clean tally.
fn empty_crew_summary(id: &str) -> CrewSummary {
    CrewSummary {
        crew: id.to_string(),
        total: 0,
        ready: 0,
        working: 0,
        done: 0,
        paused: 0,
        blocked: 0,
        failed: 0,
        goals: Vec::new(),
    }
}

/// Mint a crew and optionally move the named graph nodes onto it. Idempotent on
/// the slugged title (a second spawn returns the existing crew), so re-running
/// is safe. Returns the crew's identity row with its (post-move) counts.
#[tauri::command]
pub async fn loop_crew_spawn(
    repo_root: String,
    title: String,
    description: Option<String>,
    task_ids: Option<Vec<String>>,
) -> Result<CrewRow, String> {
    let root = Path::new(&repo_root);
    let registry = CrewRegistry::at(root);
    let meta = registry
        .spawn(title, description, ledger_now())
        .map_err(|e| e.to_string())?;

    let graph = LoopGraph::at(root);
    if let Some(ids) = task_ids {
        for id in ids {
            // Best-effort: a missing/typo'd id shouldn't fail the whole spawn.
            let _ = graph.set_crew(&id, Some(meta.id.clone()));
        }
    }
    let summary = crews_summary(&graph.list())
        .into_iter()
        .find(|s| s.crew == meta.id)
        .unwrap_or_else(|| empty_crew_summary(&meta.id));
    Ok(CrewRow { meta, summary })
}

// ─── Plan-time reality check + attach-to-existing-goal ──────────────────
//
// Before a plan runs, catch tasks that aren't worth dispatching — already
// finished (a finished task shares the name, or a recent commit delivered it),
// a duplicate of another pending task, or an empty stub. And when new tasks are
// added, offer the existing goals they could attach to instead of always
// starting a disconnected island. Both read straight off the live graph; the
// engine lives in `aura_loop::planning` (pure, shared with the CLI/chat).

/// Recent commit subjects in `repo_root` (HEAD-first) — finished-work evidence
/// so "already done" catches work completed outside the graph. Best-effort.
fn recent_commit_subjects(repo_root: &str, n: usize) -> Vec<String> {
    let out = std::process::Command::new("git")
        .args(["-C", repo_root, "log", &format!("-{n}"), "--pretty=format:%s"])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

#[tauri::command]
pub async fn loop_review(
    repo_root: String,
    commits: Option<usize>,
) -> Result<Vec<aura_loop::planning::TaskFlag>, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    let all = graph.list();
    let done_titles = recent_commit_subjects(&repo_root, commits.unwrap_or(40));
    Ok(aura_loop::planning::review_tasks(&all, &done_titles))
}

/// A tail step of an attach target, resolved to its title for the picker and
/// its board id so the wizard can wire a new task after it through the same
/// board → sync → edge path everything else uses.
#[derive(Serialize)]
pub struct AttachTail {
    pub id: String,
    pub title: String,
    /// The board card behind this node, when it came from the board. New work
    /// names these in its `dependencies` to run after this tail.
    pub board_id: Option<String>,
}

/// An existing goal new work can attach to, with its tail steps named.
#[derive(Serialize)]
pub struct AttachTargetDto {
    pub goal: String,
    pub size: usize,
    pub tails: Vec<AttachTail>,
}

#[tauri::command]
pub async fn loop_attach_targets(repo_root: String) -> Result<Vec<AttachTargetDto>, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    let all = graph.list();
    let targets = aura_loop::planning::attach_targets(&all);
    Ok(targets
        .into_iter()
        .map(|t| {
            let tails = t
                .tail_ids
                .iter()
                .map(|id| {
                    let node = all.iter().find(|n| &n.id == id);
                    AttachTail {
                        id: id.clone(),
                        title: node.map(|n| n.title.clone()).unwrap_or_default(),
                        board_id: node.and_then(|n| n.board_task_id.clone()),
                    }
                })
                .collect();
            AttachTargetDto {
                goal: t.goal,
                size: t.size,
                tails,
            }
        })
        .collect())
}

// ─── "Plan a goal" — decompose a plain-language goal into a dependency DAG ─
//
// The other door into the queue. `loop_sync_board` projects an EXISTING board
// (usually a flat pile) into the graph; this takes ONE plain-language goal and
// asks the active Aura brain to break it into a small graph of build tasks —
// modelling the real shape of the work: which steps can start now, which wait
// on others (sequential), which are independent (parallel), which need several
// done first (a join). The result is minted straight into `.aura/a2a/` so it
// lands on the Crew canvas as a real flowchart, ready to Run.

#[derive(Serialize)]
pub struct PlanGoalResult {
    pub goal: String,
    /// Nodes minted into the graph.
    pub created: usize,
    /// `depends_on` edges wired between them.
    pub edges: usize,
    /// The new node ids, in plan order (index 0 = first step).
    pub node_ids: Vec<String>,
}

/// One step of a decomposed plan, parsed from the brain's JSON. `depends_on`
/// holds the 0-based indices of earlier steps that must finish first.
struct PlanStep {
    title: String,
    input: String,
    acceptance: Option<String>,
    priority: String,
    depends_on: Vec<usize>,
}

const DECOMPOSE_SYSTEM: &str = "You are Aura's project planner. You turn one goal into a small dependency graph of concrete build tasks. You reply with ONLY a JSON array — no prose, no markdown fences, no commentary.";

fn decompose_user_prompt(goal: &str) -> String {
    format!(
        "Break this goal into 3 to 8 concrete build tasks and the dependencies between them.\n\n\
GOAL:\n{goal}\n\n\
Reply with ONLY a JSON array. Each element is one task object:\n\
{{\n\
  \"title\": short imperative name (a few words),\n\
  \"details\": one or two sentences describing what to build,\n\
  \"acceptance\": one sentence on how you'd know it's done,\n\
  \"priority\": one of \"critical\", \"high\", \"medium\", \"low\",\n\
  \"depends_on\": array of 0-based indices of tasks in THIS array that must finish first\n\
}}\n\n\
Rules:\n\
- Model the REAL shape of the work. A task lists another in depends_on ONLY when it genuinely needs that task's output.\n\
- Independent tasks share no dependency — they run in parallel.\n\
- A task that needs several others done first lists all of them (a join).\n\
- At least one task must have an empty depends_on so work can start immediately.\n\
- Indices refer to position in the array (0 = first). Never reference an index that doesn't exist, and never make a task depend on itself or form a cycle.\n\
- Output ONLY the JSON array, nothing else."
    )
}

/// Coerce any model-supplied priority to the graph's four buckets.
fn norm_priority(p: &str) -> String {
    match p.trim().to_lowercase().as_str() {
        "critical" | "urgent" => "critical",
        "high" => "high",
        "low" => "low",
        _ => "medium",
    }
    .to_string()
}

/// Pull the JSON array out of a raw model response (which may wrap it in
/// markdown fences or stray prose) and parse it into ordered plan steps.
/// Tolerant by design: a malformed element is skipped, not fatal. Returns an
/// empty vec when no array can be recovered.
fn parse_plan(raw: &str) -> Vec<PlanStep> {
    // Isolate the outermost [ … ] so leading "Here's the plan:" prose or a
    // ```json fence doesn't break the parse.
    let start = match raw.find('[') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match raw.rfind(']') {
        Some(i) if i > start => i,
        _ => return Vec::new(),
    };
    let arr: Vec<Value> = match serde_json::from_str(&raw[start..=end]) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut steps = Vec::with_capacity(arr.len());
    for el in &arr {
        let obj = match el.as_object() {
            Some(o) => o,
            None => continue,
        };
        // Accept a few key aliases so a slightly-off response still lands.
        let title = obj
            .get("title")
            .or_else(|| obj.get("action"))
            .or_else(|| obj.get("task"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let input = obj
            .get("details")
            .or_else(|| obj.get("input"))
            .or_else(|| obj.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let acceptance = obj
            .get("acceptance")
            .or_else(|| obj.get("acceptance_criteria"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let priority = obj
            .get("priority")
            .and_then(|v| v.as_str())
            .map(norm_priority)
            .unwrap_or_else(|| "medium".to_string());
        let depends_on = obj
            .get("depends_on")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as usize))
                    .collect()
            })
            .unwrap_or_default();
        steps.push(PlanStep {
            title,
            input,
            acceptance,
            priority,
            depends_on,
        });
    }
    steps
}

/// Drain the brain's chat stream to a single string of assistant text,
/// returning the *typed* `BrainError` so the caller can decide on an
/// entitlement-fallback. The decompose/order turn is plain text-in /
/// text-out — no tools — so we only need the `Text` chunks; `End` closes
/// it, an `Error` chunk or stream error surfaces.
async fn collect_text_typed(
    brain: std::sync::Arc<dyn crate::manager::brain::Brain>,
    request: ChatRequest,
) -> Result<String, crate::manager::brain::types::BrainError> {
    use crate::manager::brain::types::BrainError;
    let mut stream = brain.chat(request).await?;
    let mut out = String::new();
    while let Some(item) = stream.next().await {
        match item {
            Ok(ChatChunk::Text { text, .. }) => out.push_str(&text),
            Ok(ChatChunk::End { .. }) => break,
            // A mid-stream error chunk carries only a string; classify it as a
            // provider error so the eligibility check can still see it.
            Ok(ChatChunk::Error { message }) => {
                return Err(BrainError::Provider { status: None, message });
            }
            Err(e) => return Err(e),
            // Reasoning / tool / usage chunks aren't part of a plain decompose.
            Ok(_) => {}
        }
    }
    Ok(out)
}

/// Run a planning turn on Aura's own brain, with the SAME entitlement-fallback
/// the chat surface uses (`cmd_brain_chat`). The user's standing rule is "just
/// use what's available and work": when the active brain is the zero-config
/// cloud brain (`aura_pro`) and the cloud can't serve the turn — expired /
/// absent subscription, quota, a 5xx, or the network being down — we silently
/// retry on the best installed local brain instead of dead-ending on
/// "provider: subscription lookup failed". A failure on an explicitly-configured
/// native brain (the user's own API key) still surfaces — they need to fix that
/// key, not have it hidden.
pub(crate) async fn plan_collect(request: ChatRequest) -> Result<String, String> {
    use crate::manager::brain::{aura_pro, registry, types::BrainError};

    let mgr = BrainManager::from_disk();
    let brain = mgr.active().map_err(|e| {
        format!("No brain is set up to plan with yet ({e}). Pick one in Agent setup, then try again.")
    })?;
    let brain_id = brain.provider_id().to_string();

    match collect_text_typed(brain, request.clone()).await {
        Ok(text) => Ok(text),
        Err(e) => {
            let eligible = brain_id == aura_pro::PROVIDER_ID
                && matches!(
                    e,
                    BrainError::AuthRequired { .. }
                        | BrainError::QuotaExceeded { .. }
                        | BrainError::Provider { .. }
                        | BrainError::Api { .. }
                        | BrainError::Network { .. }
                );
            if eligible {
                if let Some(fid) = registry::first_available_fallback(&brain_id) {
                    if let Ok(fallback) = registry::build(&fid) {
                        return collect_text_typed(fallback, request)
                            .await
                            .map_err(|e2| e2.to_string());
                    }
                }
            }
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn loop_plan_goal(repo_root: String, goal: String) -> Result<PlanGoalResult, String> {
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return Err("Describe the goal you want planned first.".into());
    }

    // 1. Ask Aura's own brain to decompose the goal into a JSON DAG. Routes
    //    through `plan_collect`, so a zero-config cloud brain that can't serve
    //    the turn quietly falls back to the best installed local brain instead
    //    of dead-ending on "subscription lookup failed".
    let request = ChatRequest {
        messages: vec![ChatMessage {
            role: "user".into(),
            content: Value::String(decompose_user_prompt(&goal)),
        }],
        cwd: String::new(),
        system: Some(DECOMPOSE_SYSTEM.to_string()),
        tools: vec![],
        max_tokens: Some(2048),
        temperature: None,
        effort: None,
        fast: false,
        model: None,
        long_context: false,
        approval: None,
    };
    let raw = plan_collect(request).await?;

    // 2. Parse the plan. An unreadable response is a real failure, not a stub.
    let plan = parse_plan(&raw);
    if plan.is_empty() {
        return Err(
            "The planner didn't return a readable plan. Try rewording the goal a little.".into(),
        );
    }

    // 3. Mint every node first (deps empty), recording index → new node id, so
    //    the edges in pass 2 can resolve the plan's 0-based indices to real ids.
    let graph = LoopGraph::at(Path::new(&repo_root));
    graph.ensure_dir().map_err(|e| e.to_string())?;
    // Stamp every planned node with the goal it came from, so the canvas can
    // draw a real "Goal" banner over the whole flow (not a derived guess) and
    // every task carries the why it exists.
    let goal_tag = format!("goal:{goal}");
    let mut node_ids: Vec<String> = Vec::with_capacity(plan.len());
    for step in &plan {
        let node = graph
            .create(
                step.title.clone(),
                step.input.clone(),
                step.priority.clone(),
                aura_loop::KIND_TASK.to_string(),
                Vec::new(),
                step.acceptance.clone(),
                // Planned tasks run on Aura's own brain via `loop_run_native`.
                Some("aura".to_string()),
                vec!["planned".to_string(), goal_tag.clone()],
            )
            .map_err(|e| format!("couldn't create a task node: {e}"))?;
        node_ids.push(node.id);
    }

    // 4. Wire the dependency edges. `add_dep` is cycle-checked and idempotent;
    //    an out-of-range or cyclic index from the model is skipped, not fatal.
    let mut edges = 0usize;
    for (i, step) in plan.iter().enumerate() {
        for dep_idx in &step.depends_on {
            if *dep_idx == i {
                continue; // self-dep — ignore
            }
            if let Some(dep_id) = node_ids.get(*dep_idx) {
                if graph.add_dep(&node_ids[i], dep_id).is_ok() {
                    edges += 1;
                }
            }
        }
    }

    Ok(PlanGoalResult {
        goal,
        created: node_ids.len(),
        edges,
        node_ids,
    })
}

// ── Plan an order over EXISTING tasks ───────────────────────────────────────
// `loop_plan_goal` mints a brand-new flow from a sentence. This does the
// opposite: it takes the tasks you ALREADY have that sit in no order (a flat
// board sync is hundreds of independent cards) and works out the real
// dependencies between them — which must finish before which others can start —
// then wires those edges onto the existing nodes and names the goal they add up
// to. The pile reorganises itself into a connected flow on the canvas; nothing
// new is minted, and tasks the planner finds genuinely independent are left
// alone in the "no set order" band where they honestly belong.

#[derive(Serialize)]
pub struct PlanOrderResult {
    /// A short human summary of what was planned — the first objective when one
    /// was named, else the first goal, else empty. Drives the toast.
    pub goal: String,
    /// How many orderless tasks were handed to the planner across all groups.
    pub considered: usize,
    /// `depends_on` edges wired between existing nodes.
    pub edges: usize,
    /// How many of the considered tasks ended up connected into a flow.
    pub connected: usize,
    /// How many work-groups (epics / sprints / batches) were planned — each
    /// gets its own goal. The whole point of chunking: a 900-task board no
    /// longer loses the majority to a single 40-task pass.
    pub groups: usize,
    /// How many larger objectives the group-goals were rolled up under.
    pub objectives: usize,
    /// Work-groups left unplanned because the per-run cap was hit — surfaced,
    /// never silently dropped, so a huge board can be planned in another pass.
    pub deferred: usize,
}

const ORDER_SYSTEM: &str = "You are Aura's project planner. You are given build tasks that currently sit in no order. You work out which tasks must finish before which others can start, and you name the goal they add up to. You reply with ONLY a JSON object — no prose, no markdown fences, no commentary.";

fn order_user_prompt(listing: &str) -> String {
    format!(
        "Here are build tasks that currently run in no set order. Work out the REAL dependencies between them — which must finish before which others can start — and name the goal they add up to.\n\n\
TASKS (index: title — details):\n{listing}\n\n\
Reply with ONLY a JSON object:\n\
{{\n\
  \"goal\": short phrase naming what these tasks together deliver (a few words),\n\
  \"order\": [ {{ \"index\": <task index>, \"depends_on\": [<indices that must finish first>] }} ]\n\
}}\n\n\
Rules:\n\
- Use the SAME indices shown above. Never reference an index that isn't in the list.\n\
- A task lists another in depends_on ONLY when it genuinely needs that task's output. When in doubt, leave it independent.\n\
- Only add an entry for tasks that actually depend on something; tasks that can start immediately need no entry.\n\
- Never make a task depend on itself, and never form a cycle.\n\
- If the tasks are genuinely unrelated, return an empty \"order\" array.\n\
- Output ONLY the JSON object, nothing else."
    )
}

/// Pull `{ "goal": ..., "order": [...] }` out of a raw model response. Tolerant:
/// a malformed entry is skipped, an entry with no real dependency is dropped.
fn parse_order(raw: &str) -> (Option<String>, Vec<(usize, Vec<usize>)>) {
    let start = match raw.find('{') {
        Some(i) => i,
        None => return (None, Vec::new()),
    };
    let end = match raw.rfind('}') {
        Some(i) if i > start => i,
        _ => return (None, Vec::new()),
    };
    let val: Value = match serde_json::from_str(&raw[start..=end]) {
        Ok(v) => v,
        Err(_) => return (None, Vec::new()),
    };
    let goal = val
        .get("goal")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut out: Vec<(usize, Vec<usize>)> = Vec::new();
    if let Some(arr) = val.get("order").and_then(|v| v.as_array()) {
        for el in arr {
            let obj = match el.as_object() {
                Some(o) => o,
                None => continue,
            };
            let idx = match obj.get("index").and_then(|v| v.as_u64()) {
                Some(n) => n as usize,
                None => continue,
            };
            let deps: Vec<usize> = obj
                .get("depends_on")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default();
            if deps.is_empty() {
                continue;
            }
            out.push((idx, deps));
        }
    }
    (goal, out)
}

/// The order prompt, with optional group context. When the chunk is a known
/// epic or sprint, we tell the planner what it belongs to so the goal it names
/// is grounded in the real work, not invented from scratch.
fn order_user_prompt_grouped(listing: &str, group: Option<&str>) -> String {
    match group {
        Some(g) if !g.trim().is_empty() => format!(
            "These build tasks all belong to \"{g}\". They currently run in no set order. Work out the REAL dependencies between them — which must finish before which others can start — and name the goal they add up to.\n\n\
TASKS (index: title — details):\n{listing}\n\n\
Reply with ONLY a JSON object:\n\
{{\n\
  \"goal\": short phrase naming what these tasks together deliver (a few words),\n\
  \"order\": [ {{ \"index\": <task index>, \"depends_on\": [<indices that must finish first>] }} ]\n\
}}\n\n\
Rules:\n\
- Use the SAME indices shown above. Never reference an index that isn't in the list.\n\
- A task lists another in depends_on ONLY when it genuinely needs that task's output. When in doubt, leave it independent.\n\
- Only add an entry for tasks that actually depend on something.\n\
- Never make a task depend on itself, and never form a cycle.\n\
- If the tasks are genuinely unrelated, return an empty \"order\" array.\n\
- Output ONLY the JSON object, nothing else."
        ),
        _ => order_user_prompt(listing),
    }
}

const OBJECTIVE_SYSTEM: &str = "You are Aura's project planner. You are given the goals of a large project. You group them under a few larger OBJECTIVES — the big outcomes the project is driving toward — so the work has visibility from objective down to goal down to task. You reply with ONLY a JSON object — no prose, no markdown fences.";

fn objective_user_prompt(listing: &str) -> String {
    format!(
        "Here are the goals planned across a large project. Group them under a few larger OBJECTIVES — the major outcomes they roll up to. Most projects have between 2 and 6 objectives; do not invent more than you need.\n\n\
GOALS (index: goal):\n{listing}\n\n\
Reply with ONLY a JSON object:\n\
{{\n\
  \"objectives\": [ {{ \"name\": short phrase naming the larger outcome, \"goals\": [<goal indices that roll up to it>] }} ]\n\
}}\n\n\
Rules:\n\
- Use the SAME goal indices shown above. Every goal should belong to exactly one objective.\n\
- Keep objective names short (a few words) and outcome-shaped, not task-shaped.\n\
- Output ONLY the JSON object, nothing else."
    )
}

/// Pull `{ "objectives": [ { name, goals: [..] } ] }` out of a raw response.
fn parse_objectives(raw: &str) -> Vec<(String, Vec<usize>)> {
    let start = match raw.find('{') {
        Some(i) => i,
        None => return Vec::new(),
    };
    let end = match raw.rfind('}') {
        Some(i) if i > start => i,
        _ => return Vec::new(),
    };
    let val: Value = match serde_json::from_str(&raw[start..=end]) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<(String, Vec<usize>)> = Vec::new();
    if let Some(arr) = val.get("objectives").and_then(|v| v.as_array()) {
        for el in arr {
            let obj = match el.as_object() {
                Some(o) => o,
                None => continue,
            };
            let name = obj
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let name = match name {
                Some(n) => n,
                None => continue,
            };
            let goals: Vec<usize> = obj
                .get("goals")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default();
            if goals.is_empty() {
                continue;
            }
            out.push((name, goals));
        }
    }
    out
}

#[tauri::command]
pub async fn loop_plan_order(repo_root: String) -> Result<PlanOrderResult, String> {
    let graph = LoopGraph::at(Path::new(&repo_root));
    let all = graph.list();

    // Chunk the WHOLE orderless pile (no truncation) along the seams already in
    // the data — epic (parent) → sprint → size batches — so each chunk is a
    // focused unit a planner can reason about and EVERY task is covered. This is
    // the SAME chunking the agent-facing `aura loop plan` surface uses
    // (`aura_loop::planning`), so the desktop brain and an agent like Claude
    // build the identical graph whoever did the thinking.
    let ctx = aura_loop::planning::plan_context(&all);
    let considered = ctx.considered;
    let deferred = ctx.deferred;
    if considered < 2 {
        return Err(
            "There aren't enough unordered tasks to plan an order yet — you need at least two.".into(),
        );
    }
    let chunks = ctx.chunks;
    if chunks.is_empty() {
        return Err(
            "These tasks are all on their own — there's nothing to order between them yet.".into(),
        );
    }

    const CONCURRENCY: usize = 5; // concurrent brain passes

    // One request per chunk — each lists ONLY its own tasks, with local indices.
    let mut requests: Vec<(usize, ChatRequest)> = Vec::with_capacity(chunks.len());
    for (ci, chunk) in chunks.iter().enumerate() {
        let listing = chunk
            .node_ids
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let (title, detail) = graph
                    .get(id)
                    .map(|t| (t.title, t.input))
                    .unwrap_or_default();
                let mut line = format!("{i}: {title}");
                let d = detail.trim();
                if !d.is_empty() {
                    let snip: String = d.chars().take(160).collect();
                    line.push_str(" — ");
                    line.push_str(snip.trim());
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n");
        let request = ChatRequest {
            messages: vec![ChatMessage {
                role: "user".into(),
                content: Value::String(order_user_prompt_grouped(
                    &listing,
                    chunk.seed_goal.as_deref(),
                )),
            }],
            cwd: String::new(),
            system: Some(ORDER_SYSTEM.to_string()),
            tools: vec![],
            max_tokens: Some(2048),
            temperature: None,
            effort: None,
            fast: false,
            model: None,
            long_context: false,
            approval: None,
        };
        requests.push((ci, request));
    }

    // Run the passes CONCURRENTLY (bounded) — this IS the multi-agent planning:
    // each chunk is understood and ordered independently, so the whole board is
    // covered instead of only the first 40 tasks. Same entitlement-fallback as
    // `loop_plan_goal`, so an unavailable cloud brain never dead-ends a pass.
    use futures_util::stream;
    let raws: Vec<(usize, Result<String, String>)> = stream::iter(requests)
        .map(|(ci, req)| async move { (ci, plan_collect(req).await) })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;

    // Parse each chunk's plan; keep them in chunk order for deterministic apply.
    let mut plans: Vec<(usize, Option<String>, Vec<(usize, Vec<usize>)>)> = Vec::new();
    for (ci, raw) in raws {
        if let Ok(text) = raw {
            let (goal_opt, order) = parse_order(&text);
            plans.push((ci, goal_opt, order));
        }
    }
    plans.sort_by_key(|(ci, _, _)| *ci);

    // Apply edges + goal tags sequentially — the file-backed graph is a single
    // writer. Each connected group becomes a goal we can roll up afterwards.
    let mut total_edges = 0usize;
    let mut total_connected: HashSet<String> = HashSet::new();
    let mut goal_recs: Vec<(String, Vec<String>)> = Vec::new();
    for (ci, goal_opt, order) in plans {
        let chunk = &chunks[ci];
        let mut connected_local: HashSet<usize> = HashSet::new();
        for (idx, deps) in &order {
            for d in deps {
                if d == idx {
                    continue;
                }
                if let (Some(id), Some(on)) =
                    (chunk.node_ids.get(*idx), chunk.node_ids.get(*d))
                {
                    if graph.add_dep(id, on).is_ok() {
                        total_edges += 1;
                        connected_local.insert(*idx);
                        connected_local.insert(*d);
                    }
                }
            }
        }
        if connected_local.is_empty() {
            continue;
        }
        let goal = goal_opt
            .or_else(|| chunk.seed_goal.clone())
            .unwrap_or_else(|| chunk.label.clone());
        let goal_tag = format!("goal:{goal}");
        let mut members: Vec<String> = Vec::new();
        for idx in &connected_local {
            if let Some(id) = chunk.node_ids.get(*idx) {
                if let Some(mut node) = graph.get(id) {
                    node.tags
                        .retain(|t| !t.to_lowercase().starts_with("goal:"));
                    node.tags.push(goal_tag.clone());
                    let _ = graph.save(&node);
                    total_connected.insert(id.clone());
                    members.push(id.clone());
                }
            }
        }
        if !members.is_empty() {
            goal_recs.push((goal, members));
        }
    }

    if goal_recs.is_empty() {
        return Err(
            "The planner didn't find an order in any group — these tasks may already be independent. Try again, or order them by hand.".into(),
        );
    }

    // ── Objective pass: roll the group-goals up under a few larger OBJECTIVES,
    // so the board reads objective → goal → task and the big outcomes are
    // visible. One extra brain call; objectives stamp an `objective:<name>` tag
    // the frontend can group by. ──
    let mut objectives = 0usize;
    let mut headline = goal_recs
        .first()
        .map(|(g, _)| g.clone())
        .unwrap_or_default();
    if goal_recs.len() >= 2 {
        let listing = goal_recs
            .iter()
            .enumerate()
            .map(|(i, (g, _))| format!("{i}: {g}"))
            .collect::<Vec<_>>()
            .join("\n");
        let request = ChatRequest {
            messages: vec![ChatMessage {
                role: "user".into(),
                content: Value::String(objective_user_prompt(&listing)),
            }],
            cwd: String::new(),
            system: Some(OBJECTIVE_SYSTEM.to_string()),
            tools: vec![],
            max_tokens: Some(1024),
            temperature: None,
            effort: None,
            fast: false,
            model: None,
            long_context: false,
            approval: None,
        };
        if let Ok(text) = plan_collect(request).await {
            let objs = parse_objectives(&text);
            if let Some((name, _)) = objs.first() {
                headline = name.clone();
            }
            for (name, goal_idxs) in &objs {
                objectives += 1;
                let obj_tag = format!("objective:{name}");
                for gi in goal_idxs {
                    if let Some((_, members)) = goal_recs.get(*gi) {
                        for id in members {
                            if let Some(mut node) = graph.get(id) {
                                node.tags.retain(|t| {
                                    !t.to_lowercase().starts_with("objective:")
                                });
                                node.tags.push(obj_tag.clone());
                                let _ = graph.save(&node);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(PlanOrderResult {
        goal: headline,
        considered,
        edges: total_edges,
        connected: total_connected.len(),
        groups: goal_recs.len(),
        objectives,
        deferred,
    })
}
