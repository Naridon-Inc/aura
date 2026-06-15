// Aura Loop — local-first dependency graph + ready-set.
//
// This is Aura's native answer to a dependency-aware issue graph (the
// "Beads" shape) plus the ready-set the autonomous loop runner (the
// "Ralph"/hew shape) consumes, built generically on top of the existing
// A2A task spine rather than as a bolted-on third-party tool.
//
// This crate is the SHARED model: `aura-cli` builds its CLI runner on it
// (`aura loop run`) and `aura-shell` builds the native-brain loop driver
// on it ("Aura runs its own loop"). Both consume one `ready_view` over one
// on-disk store so the chat's ready-set and the runner's ready-set can
// never drift.
//
// WHERE THIS SITS
//   * `.aura/tasks/`  — human tickets (the Kanban board). Flat, claim/comment.
//   * `.aura/plans/`  — Manager-loop wave XML.
//   * `.aura/a2a/`    — THIS: the agent-to-agent dependency GRAPH. Each
//                       node is one work item with explicit `depends_on`
//                       edges, mirroring the cloud `a2a_tasks` row shape
//                       field-for-field so a node syncs up to the cloud
//                       A2A graph (and back) with no translation layer.
//                       Board tasks (incl. Jira-imported ones) project into
//                       this graph via the board→DAG sync, carrying their
//                       `board_task_id` + `external_source`/`external_id`.
//
// WHAT THE GRAPH ADDS OVER THE A2A TREE
//   The cloud A2A schema already models a containment TREE
//   (`parent_task_id`, kinds plan|wave|task|subtask). The graph adds the
//   two pieces a tree can't express:
//     1. `depends_on` — many-to-many ordering edges across the tree, so
//        "task B can't start until A AND C are done" is first-class.
//     2. the READY SET — the transitive closure query "every node whose
//        dependencies are all completed and which isn't itself done or
//        in-flight". This is what the loop runner consumes each tick.
//
// CRASH RECOVERY
//   A node the runner picks up is moved to `working` with a `lease`
//   (holder + expiry). The ready-set is re-derived from the on-disk
//   truth every tick, so a killed runner simply leaves a stale lease;
//   the next tick reclaims any `working` node whose lease expired back to
//   `submitted` and it re-enters the ready set. No in-memory queue to
//   lose.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Pure, brain-free planning helpers (chunk the orderless pile + apply a
/// declarative plan). Shared by the desktop "plan an order" command and the
/// agent-facing `aura loop plan` surface (CLI + MCP).
pub mod planning;

// ── A2A v1.2 lifecycle states. Kept spelling-identical to
// `aura-cloud/src/a2a_tasks.rs` so a local node and its cloud mirror
// share one status vocabulary.
pub const STATE_SUBMITTED: &str = "submitted";
pub const STATE_WORKING: &str = "working";
pub const STATE_INPUT_REQUIRED: &str = "input-required";
pub const STATE_COMPLETED: &str = "completed";
pub const STATE_FAILED: &str = "failed";
pub const STATE_CANCELED: &str = "canceled";
pub const STATE_REJECTED: &str = "rejected";
pub const STATE_AUTH_REQUIRED: &str = "auth-required";

pub const TERMINAL_STATES: &[&str] =
    &[STATE_COMPLETED, STATE_FAILED, STATE_CANCELED, STATE_REJECTED];

// ── Task kinds, mirroring the cloud "Bucket K" hierarchy.
pub const KIND_PLAN: &str = "plan";
pub const KIND_WAVE: &str = "wave";
pub const KIND_TASK: &str = "task";
pub const KIND_SUBTASK: &str = "subtask";

pub fn is_terminal(status: &str) -> bool {
    TERMINAL_STATES.contains(&status)
}

/// Priority weight for ready-set ordering. Higher = picked first.
fn priority_weight(p: &str) -> i32 {
    match p.to_lowercase().as_str() {
        "critical" => 3,
        "high" => 2,
        "medium" => 1,
        _ => 0,
    }
}

/// A working lease. Set when the runner claims a node so a crashed
/// runner's node can be reclaimed once the lease expires.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lease {
    pub holder: String,
    pub acquired_at: i64,
    pub expires_at: i64,
}

impl Lease {
    pub fn is_expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }
}

/// One node in the dependency graph. Field shape mirrors the cloud
/// `A2aTask` row so `aura loop sync` is a field-for-field mirror; the
/// graph-only additions are `depends_on`, `priority`, `agent_kind`,
/// `lease`, `remote_id`, and the board/external provenance trio
/// (`board_task_id`, `external_source`, `external_id`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopTask {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub input: String,
    #[serde(default)]
    pub acceptance_criteria: Option<String>,
    #[serde(default = "default_kind")]
    pub task_kind: String,
    #[serde(default)]
    pub parent_task_id: Option<String>,
    /// The graph edges. A node is not ready until every id here resolves
    /// to a node in `completed`.
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    /// Which agent the runner should dispatch (e.g. "claude", "aura",
    /// "codex"). `None` → the runner's `--agent` default.
    #[serde(default)]
    pub agent_kind: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub assignee: Option<String>,
    /// Working lease for crash recovery. Present only while `working`.
    #[serde(default)]
    pub lease: Option<Lease>,
    /// Cloud A2A task id once mirrored. Lets `sync` reconcile.
    #[serde(default)]
    pub remote_id: Option<String>,
    /// Human-board task id this node was projected from (`.aura/tasks`).
    /// Set by the board→DAG sync; lets the sync reconcile idempotently and
    /// lets the surface link a graph node back to its board card.
    #[serde(default)]
    pub board_task_id: Option<String>,
    /// External system this work originated in, e.g. "jira". Carried from
    /// the board task's `external_source` so a Jira-origin node keeps its
    /// provenance in the graph.
    #[serde(default)]
    pub external_source: Option<String>,
    /// External id / issue key within `external_source` (e.g. the Jira
    /// issue id or key). Lets the surface show "JIRA PROJ-123".
    #[serde(default)]
    pub external_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn default_kind() -> String {
    KIND_TASK.to_string()
}
fn default_status() -> String {
    STATE_SUBMITTED.to_string()
}
fn default_priority() -> String {
    "medium".to_string()
}

impl LoopTask {
    pub fn is_terminal(&self) -> bool {
        is_terminal(&self.status)
    }
    /// A node is a ready candidate when it's waiting to start — neither
    /// terminal, nor already in flight, nor blocked on input.
    pub fn is_pending(&self) -> bool {
        self.status == STATE_SUBMITTED
    }
    pub fn short_id(&self) -> &str {
        // ids are "t-XXXXXXXX"; show the slug after the prefix.
        self.id.strip_prefix("t-").unwrap_or(&self.id)
    }
}

/// A projection of one human-board task (`.aura/tasks/`) into the graph.
/// The board owns these fields (title, status, priority, provenance); the
/// graph owns scheduling state (lease, run result) and the `depends_on`
/// edges, which the board→DAG sync reconciles in a separate pass. Carried
/// from `aura-shell`'s board sync so the crate never needs to know the
/// board's `Task` shape.
#[derive(Debug, Clone)]
pub struct BoardProjection {
    pub board_task_id: String,
    pub title: String,
    pub input: String,
    pub priority: String,
    pub kind: String,
    /// A2A status the board state mapped to. Applied only when the node
    /// isn't mid-flight — a `working` lease is never yanked by a sync.
    pub status: String,
    pub agent_kind: Option<String>,
    pub parent_task_id: Option<String>,
    pub external_source: Option<String>,
    pub external_id: Option<String>,
    pub tags: Vec<String>,
    /// Human assignee handle carried from the board card, so the flow can
    /// group work by who owns it and show a real person on every node.
    pub assignee: Option<String>,
}

/// Whether an `upsert_from_board` minted a new node or updated an existing
/// one — surfaced so the sync can report `created` / `updated` counts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertKind {
    Created,
    Updated,
}

/// File-backed dependency-graph store under `<repo>/.aura/a2a/`.
pub struct LoopGraph {
    dir: PathBuf,
}

impl LoopGraph {
    pub fn at(repo_root: &Path) -> Self {
        Self {
            dir: repo_root.join(".aura").join("a2a"),
        }
    }

    pub fn ensure_dir(&self) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{}.json", id))
    }

    pub fn list(&self) -> Vec<LoopTask> {
        let mut out = Vec::new();
        let entries = match fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(_) => return out,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if path.file_name().and_then(|s| s.to_str()) == Some("_meta.json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(t) = serde_json::from_str::<LoopTask>(&text) {
                    out.push(t);
                }
            }
        }
        out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        out
    }

    /// Index by id for O(1) dependency resolution.
    pub fn index(&self) -> HashMap<String, LoopTask> {
        self.list().into_iter().map(|t| (t.id.clone(), t)).collect()
    }

    pub fn get(&self, id: &str) -> Option<LoopTask> {
        let text = fs::read_to_string(self.path_for(id)).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self, task: &LoopTask) -> std::io::Result<()> {
        self.ensure_dir()?;
        let body = serde_json::to_string_pretty(task)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(self.path_for(&task.id), body)
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let p = self.path_for(id);
        if p.exists() {
            fs::remove_file(p)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        title: String,
        input: String,
        priority: String,
        kind: String,
        depends_on: Vec<String>,
        acceptance_criteria: Option<String>,
        agent_kind: Option<String>,
        tags: Vec<String>,
    ) -> std::io::Result<LoopTask> {
        self.ensure_dir()?;
        let id = format!("t-{}", &Uuid::new_v4().to_string()[..8]);
        let now = chrono::Utc::now().timestamp();
        let task = LoopTask {
            id,
            title,
            input,
            acceptance_criteria,
            task_kind: kind,
            parent_task_id: None,
            depends_on,
            status: STATE_SUBMITTED.to_string(),
            priority,
            agent_kind,
            branch: None,
            tags,
            commit_sha: None,
            result: None,
            error_message: None,
            assignee: None,
            lease: None,
            remote_id: None,
            board_task_id: None,
            external_source: None,
            external_id: None,
            created_at: now,
            updated_at: now,
        };
        self.save(&task)?;
        Ok(task)
    }

    fn touch(task: &mut LoopTask) {
        task.updated_at = chrono::Utc::now().timestamp();
    }

    /// Add a dependency edge `id → on`. Rejected when it would create a
    /// cycle (the graph must stay a DAG or the ready-set never converges).
    pub fn add_dep(&self, id: &str, on: &str) -> Result<LoopTask, String> {
        if id == on {
            return Err("a task cannot depend on itself".into());
        }
        let idx = self.index();
        if !idx.contains_key(on) {
            return Err(format!("dependency target {on} not found"));
        }
        let mut task = idx.get(id).cloned().ok_or_else(|| format!("task {id} not found"))?;
        if task.depends_on.iter().any(|d| d == on) {
            return Ok(task); // idempotent
        }
        // Cycle check: would `on` be able to reach `id` through existing
        // edges? If so, adding id→on closes a loop.
        if reaches(&idx, on, id) {
            return Err(format!("adding {id}→{on} would create a dependency cycle"));
        }
        task.depends_on.push(on.to_string());
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    pub fn rm_dep(&self, id: &str, on: &str) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        let before = task.depends_on.len();
        task.depends_on.retain(|d| d != on);
        if task.depends_on.len() == before {
            return Err(format!("{id} does not depend on {on}"));
        }
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    pub fn set_status(&self, id: &str, status: &str) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        task.status = status.to_string();
        if is_terminal(status) {
            task.lease = None;
        }
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    /// Claim a node for execution: move to `working` and stamp a lease.
    pub fn claim(&self, id: &str, holder: &str, lease_secs: i64) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        if task.status == STATE_WORKING {
            if let Some(l) = &task.lease {
                let now = chrono::Utc::now().timestamp();
                if !l.is_expired(now) && l.holder != holder {
                    return Err(format!("{id} is leased by {} until {}", l.holder, l.expires_at));
                }
            }
        }
        let now = chrono::Utc::now().timestamp();
        task.status = STATE_WORKING.to_string();
        task.lease = Some(Lease {
            holder: holder.to_string(),
            acquired_at: now,
            expires_at: now + lease_secs.max(1),
        });
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    /// Reclaim any `working` node whose lease has expired back to
    /// `submitted` so it re-enters the ready set. Returns reclaimed ids.
    pub fn reclaim_stale(&self) -> Vec<String> {
        let now = chrono::Utc::now().timestamp();
        let mut reclaimed = Vec::new();
        for mut t in self.list() {
            if t.status == STATE_WORKING {
                let expired = t.lease.as_ref().map(|l| l.is_expired(now)).unwrap_or(true);
                if expired {
                    t.status = STATE_SUBMITTED.to_string();
                    t.lease = None;
                    Self::touch(&mut t);
                    if self.save(&t).is_ok() {
                        reclaimed.push(t.id.clone());
                    }
                }
            }
        }
        reclaimed
    }

    /// Mark a node completed and record the commit it landed in.
    pub fn complete(&self, id: &str, commit_sha: Option<String>, result: Option<serde_json::Value>) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        task.status = STATE_COMPLETED.to_string();
        task.lease = None;
        if commit_sha.is_some() {
            task.commit_sha = commit_sha;
        }
        if result.is_some() {
            task.result = result;
        }
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    pub fn fail(&self, id: &str, error_message: String) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        task.status = STATE_FAILED.to_string();
        task.lease = None;
        task.error_message = Some(error_message);
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    /// Find the graph node a board task was projected into, if any. Keyed
    /// on `board_task_id` so the board→DAG sync is idempotent.
    pub fn by_board_task(&self, board_task_id: &str) -> Option<LoopTask> {
        self.list()
            .into_iter()
            .find(|t| t.board_task_id.as_deref() == Some(board_task_id))
    }

    /// Idempotently project a human-board task into the graph, keyed by
    /// `board_task_id`. Mints a node on first sight; on re-sync updates the
    /// board-owned fields in place. Deliberately conservative about two
    /// graph-owned things:
    ///   * **status** — never overwritten while the node is `working` (its
    ///     runner lease is authoritative); otherwise mirrored from the board.
    ///   * **depends_on** — left untouched here; the sync's dep pass adds
    ///     edges via `add_dep` (cycle-checked) after every node exists.
    /// Returns the node and whether it was created or updated.
    pub fn upsert_from_board(
        &self,
        p: BoardProjection,
    ) -> std::io::Result<(LoopTask, UpsertKind)> {
        self.ensure_dir()?;
        let now = chrono::Utc::now().timestamp();
        if let Some(mut t) = self.by_board_task(&p.board_task_id) {
            t.title = p.title;
            t.input = p.input;
            t.priority = p.priority;
            t.task_kind = p.kind;
            t.agent_kind = p.agent_kind;
            t.parent_task_id = p.parent_task_id;
            t.external_source = p.external_source;
            t.external_id = p.external_id;
            t.tags = p.tags;
            t.assignee = p.assignee;
            if t.status != STATE_WORKING {
                if is_terminal(&p.status) {
                    t.lease = None;
                }
                t.status = p.status;
            }
            t.updated_at = now;
            self.save(&t)?;
            Ok((t, UpsertKind::Updated))
        } else {
            let id = format!("t-{}", &Uuid::new_v4().to_string()[..8]);
            let task = LoopTask {
                id,
                title: p.title,
                input: p.input,
                acceptance_criteria: None,
                task_kind: p.kind,
                parent_task_id: p.parent_task_id,
                depends_on: vec![],
                status: p.status,
                priority: p.priority,
                agent_kind: p.agent_kind,
                branch: None,
                tags: p.tags,
                commit_sha: None,
                result: None,
                error_message: None,
                assignee: p.assignee,
                lease: None,
                remote_id: None,
                board_task_id: Some(p.board_task_id),
                external_source: p.external_source,
                external_id: p.external_id,
                created_at: now,
                updated_at: now,
            };
            self.save(&task)?;
            Ok((task, UpsertKind::Created))
        }
    }

    /// Point a node at its epic/parent by graph id. The board sync runs this
    /// in its second pass — once every node exists — so a child card can be
    /// clustered under its epic in the flow. Idempotent; a missing node or an
    /// already-set parent is a no-op.
    pub fn set_parent(&self, id: &str, parent_graph_id: &str) -> std::io::Result<()> {
        if let Some(mut t) = self.get(id) {
            if t.parent_task_id.as_deref() != Some(parent_graph_id) {
                t.parent_task_id = Some(parent_graph_id.to_string());
                t.updated_at = chrono::Utc::now().timestamp();
                self.save(&t)?;
            }
        }
        Ok(())
    }
}

/// True if `from` can reach `to` by following `depends_on` edges. Used
/// for cycle detection before adding an edge.
fn reaches(idx: &HashMap<String, LoopTask>, from: &str, to: &str) -> bool {
    let mut seen = HashSet::new();
    let mut stack = vec![from.to_string()];
    while let Some(cur) = stack.pop() {
        if cur == to {
            return true;
        }
        if !seen.insert(cur.clone()) {
            continue;
        }
        if let Some(t) = idx.get(&cur) {
            for d in &t.depends_on {
                stack.push(d.clone());
            }
        }
    }
    false
}

/// Classification of every node against the ready-set query. A blocker
/// is a dependency that isn't `completed` (missing deps count as
/// blocking so a typo can't make a node spuriously ready).
pub struct ReadyView {
    pub ready: Vec<LoopTask>,
    pub blocked: Vec<(LoopTask, Vec<String>)>, // task + unmet dep ids
    pub working: Vec<LoopTask>,
    pub done: Vec<LoopTask>,
    pub other: Vec<LoopTask>, // failed / canceled / rejected / input-required
}

/// The heart of the graph: derive the ready-set and the full
/// classification from a snapshot of all nodes.
pub fn ready_view(tasks: &[LoopTask]) -> ReadyView {
    let by_id: HashMap<&str, &LoopTask> = tasks.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut view = ReadyView {
        ready: Vec::new(),
        blocked: Vec::new(),
        working: Vec::new(),
        done: Vec::new(),
        other: Vec::new(),
    };
    for t in tasks {
        match t.status.as_str() {
            STATE_WORKING => view.working.push(t.clone()),
            STATE_COMPLETED => view.done.push(t.clone()),
            STATE_SUBMITTED => {
                let unmet: Vec<String> = t
                    .depends_on
                    .iter()
                    .filter(|d| {
                        by_id
                            .get(d.as_str())
                            .map(|dep| dep.status != STATE_COMPLETED)
                            .unwrap_or(true) // missing dep blocks
                    })
                    .cloned()
                    .collect();
                if unmet.is_empty() {
                    view.ready.push(t.clone());
                } else {
                    view.blocked.push((t.clone(), unmet));
                }
            }
            _ => view.other.push(t.clone()),
        }
    }
    // Ready order: priority desc, then oldest first (FIFO within tier).
    view.ready.sort_by(|a, b| {
        priority_weight(&b.priority)
            .cmp(&priority_weight(&a.priority))
            .then(a.created_at.cmp(&b.created_at))
    });
    view
}

/// Convenience: just the ordered ready-set.
pub fn ready_set(tasks: &[LoopTask]) -> Vec<LoopTask> {
    ready_view(tasks).ready
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo() -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-loop-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn mk(graph: &LoopGraph, title: &str, prio: &str) -> LoopTask {
        graph
            .create(
                title.to_string(),
                format!("do {title}"),
                prio.to_string(),
                KIND_TASK.to_string(),
                vec![],
                None,
                None,
                vec![],
            )
            .unwrap()
    }

    #[test]
    fn ready_set_respects_dependencies() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "A", "high");
        let b = mk(&g, "B", "medium");
        g.add_dep(&b.id, &a.id).unwrap();

        // Only A is ready (B blocked on A).
        let ready = ready_set(&g.list());
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, a.id);

        // Complete A → B becomes ready.
        g.complete(&a.id, Some("abc123".into()), None).unwrap();
        let ready = ready_set(&g.list());
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0].id, b.id);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn ready_order_is_priority_then_age() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let _low = mk(&g, "low", "low");
        let crit = mk(&g, "crit", "critical");
        let ready = ready_set(&g.list());
        assert_eq!(ready[0].id, crit.id, "critical should lead");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn cycle_is_rejected() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "A", "medium");
        let b = mk(&g, "B", "medium");
        g.add_dep(&b.id, &a.id).unwrap();
        // a→b would close a cycle a→b→a.
        let err = g.add_dep(&a.id, &b.id);
        assert!(err.is_err(), "cycle must be rejected");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn missing_dependency_blocks() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let mut b = mk(&g, "B", "medium");
        b.depends_on.push("t-deadbeef".into()); // dangling
        g.save(&b).unwrap();
        let view = ready_view(&g.list());
        assert!(view.ready.is_empty(), "node with missing dep is not ready");
        assert_eq!(view.blocked.len(), 1);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn stale_lease_is_reclaimed() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "A", "medium");
        // Claim, then forge an already-expired lease (claim clamps lease_secs
        // to >=1, so we can't get an expired lease through the public API).
        g.claim(&a.id, "runner-1", 3600).unwrap();
        let mut working = g.get(&a.id).unwrap();
        assert_eq!(working.status, STATE_WORKING);
        let past = chrono::Utc::now().timestamp() - 10;
        if let Some(l) = working.lease.as_mut() {
            l.acquired_at = past - 3600;
            l.expires_at = past;
        }
        g.save(&working).unwrap();
        let reclaimed = g.reclaim_stale();
        assert_eq!(reclaimed, vec![a.id.clone()]);
        assert_eq!(g.get(&a.id).unwrap().status, STATE_SUBMITTED);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn upsert_from_board_is_idempotent_and_keeps_provenance() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let proj = |title: &str, status: &str| BoardProjection {
            board_task_id: "T-abc123".into(),
            title: title.into(),
            input: "do it".into(),
            priority: "high".into(),
            kind: KIND_TASK.into(),
            status: status.into(),
            agent_kind: None,
            parent_task_id: None,
            external_source: Some("jira".into()),
            external_id: Some("PROJ-7".into()),
            tags: vec![],
            assignee: None,
        };
        let (a, k1) = g.upsert_from_board(proj("first", STATE_SUBMITTED)).unwrap();
        assert_eq!(k1, UpsertKind::Created);
        assert_eq!(a.board_task_id.as_deref(), Some("T-abc123"));
        assert_eq!(a.external_source.as_deref(), Some("jira"));
        // Re-sync with a new title → SAME node, updated in place.
        let (b, k2) = g.upsert_from_board(proj("second", STATE_SUBMITTED)).unwrap();
        assert_eq!(k2, UpsertKind::Updated);
        assert_eq!(a.id, b.id, "re-sync must reuse the node");
        assert_eq!(b.title, "second");
        assert_eq!(g.list().len(), 1, "no duplicate node minted");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn upsert_does_not_yank_a_working_lease() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let proj = BoardProjection {
            board_task_id: "T-x".into(),
            title: "t".into(),
            input: String::new(),
            priority: "medium".into(),
            kind: KIND_TASK.into(),
            status: STATE_SUBMITTED.into(),
            agent_kind: None,
            parent_task_id: None,
            external_source: None,
            external_id: None,
            tags: vec![],
            assignee: None,
        };
        let (node, _) = g.upsert_from_board(proj.clone()).unwrap();
        g.claim(&node.id, "runner", 3600).unwrap();
        // A re-sync that says "submitted" must NOT downgrade a leased node.
        let (after, _) = g.upsert_from_board(proj).unwrap();
        assert_eq!(after.status, STATE_WORKING, "live lease preserved");
        assert!(after.lease.is_some());
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn live_lease_blocks_reclaim() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "A", "medium");
        g.claim(&a.id, "runner-1", 3600).unwrap();
        let reclaimed = g.reclaim_stale();
        assert!(reclaimed.is_empty(), "live lease must not be reclaimed");
        assert_eq!(g.get(&a.id).unwrap().status, STATE_WORKING);
        let _ = fs::remove_dir_all(&repo);
    }
}
