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

/// The Crew run ledger — one durable record per `aura loop run`.
pub mod run_log;

/// The crew registry — durable identity for parallel crews (`.aura/crew/crews.json`).
pub mod crew;

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
/// Held-back state: a human (or the goal control surface) parked this node so
/// the runner skips it. NOT terminal — `resume` moves it back to `submitted`
/// and it re-enters the ready set. Aura-native; has no cloud A2A mirror, so it
/// is treated as `submitted` when syncing up.
pub const STATE_PAUSED: &str = "paused";

pub const TERMINAL_STATES: &[&str] =
    &[STATE_COMPLETED, STATE_FAILED, STATE_CANCELED, STATE_REJECTED];

// ── Task kinds, mirroring the cloud "Bucket K" hierarchy.
pub const KIND_PLAN: &str = "plan";
pub const KIND_WAVE: &str = "wave";
pub const KIND_TASK: &str = "task";
pub const KIND_SUBTASK: &str = "subtask";

// ── Placement: which machine a node is allowed to run on.
//
// One graph, two kinds of muscle. A refactor that needs your keychain, your
// simulator or your eyes belongs on the laptop; a four-hour migration belongs
// on a box that stays awake after you shut the lid. Before placement the graph
// could only express "somebody drain this", so whichever process reached the
// node first ran it — and the answer changed depending on who was awake.
//
// A node with no placement stays exactly that: anyone may take it. That is the
// historical behaviour and the default, so an existing graph drains unchanged.
/// Pin to a machine a person is sitting at. Cloud runners skip it.
pub const PLACE_LOCAL: &str = "local";
/// Send to a runner. The laptop leaves it alone and offers it to the board.
pub const PLACE_CLOUD: &str = "cloud";

pub fn is_terminal(status: &str) -> bool {
    TERMINAL_STATES.contains(&status)
}

/// Normalise a placement word, or `None` for "anywhere".
///
/// Unrecognised text is `None` rather than an error: placement is an
/// optimisation, and a graph written by a newer Aura (or hand-edited) must
/// still drain on an older one. Failing closed here would strand work.
pub fn normalize_place(raw: &str) -> Option<&'static str> {
    match raw.trim().to_lowercase().as_str() {
        PLACE_LOCAL | "laptop" | "here" => Some(PLACE_LOCAL),
        PLACE_CLOUD | "remote" | "runner" | "box" => Some(PLACE_CLOUD),
        _ => None,
    }
}

/// Is this node's `working` state owned by a different machine?
///
/// A lease is a LOCAL crash-recovery device: it says "a runner on this disk
/// holds this node, and if the lease goes stale that runner died". Placement
/// breaks that inference. A node we placed on a box and handed to the board is
/// genuinely working — just not here — and it has no local lease, so the usual
/// "no lease means crashed" reading is exactly backwards for it. Reclaiming one
/// would put work back in the ready set while a box is still running it, and
/// the two runs would race over the same branch.
///
/// The board is the authority for these. If the box dies, the board's own
/// expiry says so, and `cloud-sync` adopts that answer — this machine does not
/// get to invent it.
pub fn is_running_elsewhere(task: &LoopTask) -> bool {
    task.lease.is_none()
        && task.remote_id.is_some()
        && task.place.as_deref().and_then(normalize_place) == Some(PLACE_CLOUD)
}

/// May a process running *here* claim this node?
///
/// `here` is the caller's own placement — `PLACE_LOCAL` for the laptop,
/// `PLACE_CLOUD` for a runner. Unplaced nodes are claimable by both, so the
/// common case (nobody has said anything about placement) behaves as it always
/// has: first drainer wins.
pub fn runs_here(task: &LoopTask, here: &str) -> bool {
    match task.place.as_deref().and_then(normalize_place) {
        Some(p) => p == here,
        None => true,
    }
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
    /// Which *machine* may run this node — `local`, `cloud`, or `None` for
    /// anywhere. Sits beside `agent_kind` because it answers the same shape of
    /// question: `agent_kind` picks who does the work, `place` picks where.
    /// See [`PLACE_LOCAL`] for why a mixed graph needs this.
    #[serde(default)]
    pub place: Option<String>,
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
    /// Which **crew** this node belongs to. A crew is an independently
    /// runnable slice of the graph — `aura loop run --crew <id>` drains only
    /// its nodes, so several crews can run side-by-side without one's runner
    /// claiming another's work. `None` is the default ("main") crew, which is
    /// every node that was never assigned one.
    #[serde(default)]
    pub crew_id: Option<String>,
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
    /// The crew slug carried from the board card. When set, the projected node
    /// joins that crew — which is what lets the crew graph group a crew-filed
    /// task under its crew instead of the loose pile. `None` keeps whatever
    /// crew the node already had (a sync must not silently un-crew a node an
    /// operator explicitly assigned).
    pub crew_id: Option<String>,
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
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            // Skip the crew meta file and the gitignored lease sidecars.
            if name == "_meta.json" || name.ends_with(".lease.json") {
                continue;
            }
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(mut t) = serde_json::from_str::<LoopTask>(&text) {
                    self.overlay_lease(&mut t);
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

    fn lease_path_for(&self, id: &str) -> PathBuf {
        // Ephemeral lease state lives in a gitignored sidecar so the durable
        // task graph (`<id>.json`) can be git-tracked and synced between
        // machines without lease churn or cross-runner conflicts.
        self.dir.join(format!("{}.lease.json", id))
    }

    /// Overlay the gitignored lease sidecar onto a task read from its durable
    /// graph file. A task pulled from a peer arrives with no sidecar (leases
    /// never travel), so its `lease` stays `None` and a stale `working` node is
    /// reclaimed by `reclaim_stale`.
    fn overlay_lease(&self, task: &mut LoopTask) {
        if let Ok(text) = fs::read_to_string(self.lease_path_for(&task.id)) {
            if let Ok(lease) = serde_json::from_str::<Lease>(&text) {
                task.lease = Some(lease);
            }
        }
    }

    /// Turn whatever someone typed into a real node id.
    ///
    /// Every surface prints the short form — `crew add` answers with
    /// `479ca3d9`, `crew list` shows the same — because that is what fits on a
    /// row and what a person copies. So every verb has to take it back;
    /// printing one id and accepting another is a control that doesn't do what
    /// it says. An unambiguous prefix works too, but an ambiguous one resolves
    /// to nothing rather than to a guess: picking a node for someone is worse
    /// than telling them to be specific.
    pub fn resolve_id(&self, id: &str) -> Option<String> {
        let id = id.trim();
        if id.is_empty() {
            return None;
        }
        if self.path_for(id).exists() {
            return Some(id.to_string());
        }
        let prefixed = format!("t-{id}");
        if self.path_for(&prefixed).exists() {
            return Some(prefixed);
        }
        let mut hits = self.list().into_iter().map(|t| t.id).filter(|real| {
            real.starts_with(id)
                || real
                    .strip_prefix("t-")
                    .is_some_and(|slug| slug.starts_with(id))
        });
        let first = hits.next()?;
        hits.next().is_none().then_some(first)
    }

    pub fn get(&self, id: &str) -> Option<LoopTask> {
        let id = self.resolve_id(id)?;
        let text = fs::read_to_string(self.path_for(&id)).ok()?;
        let mut task: LoopTask = serde_json::from_str(&text).ok()?;
        self.overlay_lease(&mut task);
        Some(task)
    }

    pub fn save(&self, task: &LoopTask) -> std::io::Result<()> {
        self.ensure_dir()?;
        // Split the ephemeral lease out of the durable graph file so the graph
        // stays clean for git. The lease, if any, goes to a gitignored sidecar.
        let mut for_disk = task.clone();
        let lease = for_disk.lease.take();
        let body = serde_json::to_string_pretty(&for_disk)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        fs::write(self.path_for(&task.id), body)?;
        let lease_path = self.lease_path_for(&task.id);
        match lease {
            Some(l) => {
                let lb = serde_json::to_string_pretty(&l)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                fs::write(lease_path, lb)?;
            }
            None => {
                if lease_path.exists() {
                    fs::remove_file(lease_path)?;
                }
            }
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let p = self.path_for(id);
        if p.exists() {
            fs::remove_file(p)?;
        }
        let lp = self.lease_path_for(id);
        if lp.exists() {
            fs::remove_file(lp)?;
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
            // Unplaced by default. Callers that care set it on the returned
            // node, the same way they set `remote_id` and `branch` — the
            // constructor's positional list is long enough already.
            place: None,
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
            crew_id: None,
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
        // Both ends take the short form too — an edge is typed from two rows
        // the board just printed.
        let on = &self
            .resolve_id(on)
            .ok_or_else(|| format!("dependency target {on} not found"))?;
        let id = &self
            .resolve_id(id)
            .ok_or_else(|| format!("task {id} not found"))?;
        if id == on {
            return Err("a task cannot depend on itself".into());
        }
        let idx = self.index();
        if !idx.contains_key(on) {
            return Err(format!("dependency target {on} not found"));
        }
        let mut task = idx
            .get(id)
            .cloned()
            .ok_or_else(|| format!("task {id} not found"))?;
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
    ///
    /// Whole-graph. Correct for a supervisor that owns every crew; a runner
    /// draining one slice wants [`reclaim_stale_in`] instead.
    pub fn reclaim_stale(&self) -> Vec<String> {
        self.reclaim_stale_in(&RunScope::default())
    }

    /// Reclaim stale nodes *within one run's scope*.
    ///
    /// Several runners share a single `.aura/a2a/` on one disk, each draining
    /// its own crew. A lease is evidence about the runner that took it and
    /// nothing else, so a runner has no standing to declare another crew's
    /// node dead — its own tick says nothing about whether that runner is
    /// alive. Reclaiming across the boundary hands a node that is actively
    /// being built back to the ready set, where a third runner can claim it
    /// and do the same work twice.
    pub fn reclaim_stale_in(&self, scope: &RunScope) -> Vec<String> {
        let now = chrono::Utc::now().timestamp();
        let mut reclaimed = Vec::new();
        for mut t in self.list() {
            if !scope.matches(&t) {
                continue;
            }
            if t.status == STATE_WORKING {
                // Not ours to reclaim — a box is holding it. See
                // `is_running_elsewhere`.
                if is_running_elsewhere(&t) {
                    continue;
                }
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

    /// Park a node so the runner skips it. A `submitted` node moves to
    /// `paused`; a `working` node is paused and its lease dropped so it won't
    /// be re-dispatched (its in-flight agent, if any, finishes on its own —
    /// pause is advisory, not a kill). Terminal nodes are left as-is. Returns
    /// the (possibly unchanged) node so callers can report idempotently.
    pub fn pause(&self, id: &str) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        if is_terminal(&task.status) || task.status == STATE_PAUSED {
            return Ok(task);
        }
        task.status = STATE_PAUSED.to_string();
        task.lease = None;
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    /// Un-park a paused node back to `submitted` so it re-enters the ready
    /// set. A node that isn't paused is returned unchanged (idempotent).
    pub fn resume(&self, id: &str) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        if task.status != STATE_PAUSED {
            return Ok(task);
        }
        task.status = STATE_SUBMITTED.to_string();
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    /// Assign a node to a crew (or clear it with `None`). Lets a planner carve
    /// the graph into independently-runnable crews after the fact.
    pub fn set_crew(&self, id: &str, crew_id: Option<String>) -> Result<LoopTask, String> {
        let mut task = self.get(id).ok_or_else(|| format!("task {id} not found"))?;
        task.crew_id = crew_id;
        Self::touch(&mut task);
        self.save(&task).map_err(|e| e.to_string())?;
        Ok(task)
    }

    /// Pause every non-terminal node in `scope` (a goal and/or a crew). This
    /// is what "pause this goal" does — it parks the goal's whole member set in
    /// one call. Returns the ids actually paused (already-paused/terminal nodes
    /// are skipped), so the caller can report "paused 4 tasks".
    pub fn pause_scope(&self, scope: &RunScope) -> Vec<String> {
        let mut paused = Vec::new();
        for t in self.list() {
            if !scope.matches(&t) {
                continue;
            }
            if is_terminal(&t.status) || t.status == STATE_PAUSED {
                continue;
            }
            if self.pause(&t.id).is_ok() {
                paused.push(t.id);
            }
        }
        paused
    }

    /// Resume every paused node in `scope`. Returns the ids re-armed.
    pub fn resume_scope(&self, scope: &RunScope) -> Vec<String> {
        let mut resumed = Vec::new();
        for t in self.list() {
            if !scope.matches(&t) || t.status != STATE_PAUSED {
                continue;
            }
            if self.resume(&t.id).is_ok() {
                resumed.push(t.id);
            }
        }
        resumed
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
            // Adopt the board's crew when it names one; a board row that names
            // no crew leaves the node's crew alone, so a sync never un-crews a
            // node an operator explicitly assigned via set_crew.
            if p.crew_id.is_some() {
                t.crew_id = p.crew_id;
            }
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
                // Board cards carry no placement — a card says what to do, not
                // which machine does it. The graph node is where that gets
                // decided, so it starts open to both.
                place: None,
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
                crew_id: p.crew_id,
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
    /// Nodes a human parked with `pause`. Not ready, not blocked, not
    /// terminal — held back until `resume`. Kept in its own bucket so the
    /// surface can show "paused by you" distinctly from a failure.
    pub paused: Vec<LoopTask>,
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
        paused: Vec::new(),
        other: Vec::new(),
    };
    for t in tasks {
        match t.status.as_str() {
            STATE_WORKING => view.working.push(t.clone()),
            STATE_COMPLETED => view.done.push(t.clone()),
            STATE_PAUSED => view.paused.push(t.clone()),
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

// ── Goal / crew grouping ───────────────────────────────────────────────
// A *goal* is the `goal:<slug>` tag that `plan-apply` stamps on every task
// that adds up to it (see `planning.rs`). An *objective* is the coarser
// `objective:<name>` tag. A *crew* is an explicit `crew_id` slice. These
// pure readers let the runner scope a run and the surface group the board
// without re-deriving the convention everywhere.

fn tag_value(task: &LoopTask, prefix: &str) -> Option<String> {
    task.tags.iter().find_map(|t| {
        let lower = t.to_lowercase();
        lower
            .strip_prefix(prefix)
            .map(|rest| rest.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

/// The `goal:<slug>` a node belongs to, if tagged.
pub fn goal_of(task: &LoopTask) -> Option<String> {
    tag_value(task, "goal:")
}

/// The `objective:<name>` a node rolls up to, if tagged.
pub fn objective_of(task: &LoopTask) -> Option<String> {
    tag_value(task, "objective:")
}

/// The crew a node belongs to — its explicit `crew_id`, else the default
/// "main" crew. Always returns a concrete name so callers can group cleanly.
pub fn crew_of(task: &LoopTask) -> String {
    task.crew_id.clone().unwrap_or_else(|| "main".to_string())
}

/// Does this node match the given scope? A `None` scope matches everything;
/// otherwise the node must carry the goal/crew the scope names.
#[derive(Debug, Clone, Default)]
pub struct RunScope {
    pub goal: Option<String>,
    pub crew: Option<String>,
}

impl RunScope {
    pub fn is_unscoped(&self) -> bool {
        self.goal.is_none() && self.crew.is_none()
    }
    pub fn matches(&self, task: &LoopTask) -> bool {
        if let Some(g) = &self.goal {
            if goal_of(task).as_deref() != Some(g.as_str()) {
                return false;
            }
        }
        if let Some(c) = &self.crew {
            // A scope on the default crew ("main") also matches untagged nodes.
            if &crew_of(task) != c {
                return false;
            }
        }
        true
    }
    /// Narrow a node list to this scope.
    pub fn filter(&self, tasks: &[LoopTask]) -> Vec<LoopTask> {
        if self.is_unscoped() {
            return tasks.to_vec();
        }
        tasks.iter().filter(|t| self.matches(t)).cloned().collect()
    }
}

/// A rolled-up summary of one goal across the graph — counts by lifecycle so
/// the surface can show "Spot unusual numbers · 2/5 done · 1 paused" and the
/// goal node can carry its own Run/Pause controls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoalSummary {
    pub goal: String,
    pub total: usize,
    pub ready: usize,
    pub working: usize,
    pub done: usize,
    pub paused: usize,
    pub blocked: usize,
    pub failed: usize,
    /// Task ids in this goal, creation order — the goal's member set.
    pub task_ids: Vec<String>,
}

/// Group every tagged node into its goal and tally lifecycle counts. Nodes
/// with no `goal:` tag are skipped (they belong to no goal). Ordered by first
/// appearance so the surface lists goals in plan order.
pub fn goals_summary(tasks: &[LoopTask]) -> Vec<GoalSummary> {
    let mut order: Vec<String> = Vec::new();
    let mut by_goal: HashMap<String, GoalSummary> = HashMap::new();
    for t in tasks {
        let Some(goal) = goal_of(t) else { continue };
        let entry = by_goal.entry(goal.clone()).or_insert_with(|| {
            order.push(goal.clone());
            GoalSummary {
                goal: goal.clone(),
                total: 0,
                ready: 0,
                working: 0,
                done: 0,
                paused: 0,
                blocked: 0,
                failed: 0,
                task_ids: Vec::new(),
            }
        });
        entry.total += 1;
        entry.task_ids.push(t.id.clone());
        match t.status.as_str() {
            STATE_WORKING => entry.working += 1,
            STATE_COMPLETED => entry.done += 1,
            STATE_PAUSED => entry.paused += 1,
            STATE_FAILED => entry.failed += 1,
            STATE_SUBMITTED => {
                // ready vs blocked needs the whole-graph dependency check.
                let unmet = t.depends_on.iter().any(|d| {
                    tasks
                        .iter()
                        .find(|x| &x.id == d)
                        .map(|dep| dep.status != STATE_COMPLETED)
                        .unwrap_or(true)
                });
                if unmet {
                    entry.blocked += 1;
                } else {
                    entry.ready += 1;
                }
            }
            _ => {}
        }
    }
    order
        .into_iter()
        .filter_map(|g| by_goal.remove(&g))
        .collect()
}

/// A rolled-up summary of one crew — the unit `--crew` runs and the surface
/// shows side-by-side. Same lifecycle tally as a goal, plus the goals inside.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrewSummary {
    pub crew: String,
    pub total: usize,
    pub ready: usize,
    pub working: usize,
    pub done: usize,
    pub paused: usize,
    pub blocked: usize,
    pub failed: usize,
    pub goals: Vec<String>,
}

/// Group every node into its crew (`crew_id`, default "main") and tally.
pub fn crews_summary(tasks: &[LoopTask]) -> Vec<CrewSummary> {
    let mut order: Vec<String> = Vec::new();
    let mut by_crew: HashMap<String, CrewSummary> = HashMap::new();
    let mut goals_seen: HashMap<String, HashSet<String>> = HashMap::new();
    for t in tasks {
        let crew = crew_of(t);
        let entry = by_crew.entry(crew.clone()).or_insert_with(|| {
            order.push(crew.clone());
            CrewSummary {
                crew: crew.clone(),
                total: 0,
                ready: 0,
                working: 0,
                done: 0,
                paused: 0,
                blocked: 0,
                failed: 0,
                goals: Vec::new(),
            }
        });
        entry.total += 1;
        if let Some(g) = goal_of(t) {
            if goals_seen.entry(crew.clone()).or_default().insert(g.clone()) {
                entry.goals.push(g);
            }
        }
        match t.status.as_str() {
            STATE_WORKING => entry.working += 1,
            STATE_COMPLETED => entry.done += 1,
            STATE_PAUSED => entry.paused += 1,
            STATE_FAILED => entry.failed += 1,
            STATE_SUBMITTED => {
                let unmet = t.depends_on.iter().any(|d| {
                    tasks
                        .iter()
                        .find(|x| &x.id == d)
                        .map(|dep| dep.status != STATE_COMPLETED)
                        .unwrap_or(true)
                });
                if unmet {
                    entry.blocked += 1;
                } else {
                    entry.ready += 1;
                }
            }
            _ => {}
        }
    }
    order
        .into_iter()
        .filter_map(|c| by_crew.remove(&c))
        .collect()
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

    /// `crew add` answers with `479ca3d9` and `crew list` prints the same, so
    /// that is the id a person copies into the next command. Every verb has to
    /// take it — printing one id and accepting another sends you to `--json`
    /// to find out what the tool already told you.
    #[test]
    fn the_id_the_board_prints_is_an_id_the_board_accepts() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let t = mk(&g, "sweep the callsites", "medium");

        // The short form, exactly as `crew add` echoed it.
        assert_eq!(g.get(t.short_id()).map(|x| x.id), Some(t.id.clone()));
        // The stored form still works.
        assert_eq!(g.get(&t.id).map(|x| x.id), Some(t.id.clone()));
        // And an unambiguous prefix of either.
        assert_eq!(
            g.get(&t.short_id()[..4]).map(|x| x.id),
            Some(t.id.clone()),
            "a prefix nobody else shares resolves"
        );
        assert!(g.get("no-such-node").is_none());
    }

    /// An ambiguous prefix must resolve to nothing. Picking a node on someone's
    /// behalf is worse than making them type more.
    #[test]
    fn an_ambiguous_prefix_resolves_to_nothing() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "one", "low");
        let b = mk(&g, "two", "low");
        assert_ne!(a.id, b.id);

        // "t-" prefixes every node, so it can never mean one of them.
        assert!(g.get("t-").is_none(), "a prefix every node shares is not an id");
    }

    #[test]
    fn an_unplaced_node_still_runs_anywhere() {
        // The whole back-compat promise: a graph written before placement
        // existed must drain on both the laptop and a runner exactly as it
        // always did. If this ever fails, every existing board goes silent.
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let t = mk(&g, "ship it", "high");
        assert!(t.place.is_none());
        assert!(runs_here(&t, PLACE_LOCAL));
        assert!(runs_here(&t, PLACE_CLOUD));
    }

    #[test]
    fn a_placed_node_is_refused_by_the_other_machine() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);

        let mut here = mk(&g, "needs my keychain", "high");
        here.place = Some(PLACE_LOCAL.to_string());
        assert!(runs_here(&here, PLACE_LOCAL));
        assert!(!runs_here(&here, PLACE_CLOUD));

        let mut away = mk(&g, "four hour migration", "high");
        away.place = Some(PLACE_CLOUD.to_string());
        assert!(runs_here(&away, PLACE_CLOUD));
        assert!(!runs_here(&away, PLACE_LOCAL));
    }

    #[test]
    fn work_running_on_a_box_is_not_reclaimed_from_under_it() {
        // The node is `working` with no local lease — which for a local runner
        // means "crashed, take it back". For work handed to a box it means
        // "running somewhere else". Reclaiming it would hand the same branch to
        // a second agent while the first is still on it.
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let mut t = mk(&g, "four hour migration", "high");
        t.place = Some(PLACE_CLOUD.to_string());
        t.remote_id = Some("cloud-task-1".to_string());
        t.status = STATE_WORKING.to_string();
        t.lease = None;
        g.save(&t).unwrap();

        assert!(g.reclaim_stale().is_empty());
        assert_eq!(g.get(&t.id).unwrap().status, STATE_WORKING);
    }

    #[test]
    fn one_crews_runner_does_not_reclaim_another_crews_work() {
        // Several runners share one `.aura/a2a/` on a disk, each draining its
        // own crew. A lease is evidence about the runner that took it, so a
        // runner draining `place` has no standing to call a `env` node dead —
        // reclaiming it hands work that is actively being built back to the
        // ready set, where a third runner claims it and does it twice.
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);

        let mut mine = mk(&g, "my crew's node", "high");
        mine.crew_id = Some("place".to_string());
        mine.status = STATE_WORKING.to_string();
        mine.lease = None;
        g.save(&mine).unwrap();

        let mut theirs = mk(&g, "another crew's node", "high");
        theirs.crew_id = Some("env".to_string());
        theirs.status = STATE_WORKING.to_string();
        theirs.lease = None;
        g.save(&theirs).unwrap();

        let scope = RunScope {
            goal: None,
            crew: Some("place".to_string()),
        };
        let reclaimed = g.reclaim_stale_in(&scope);
        assert!(reclaimed.contains(&mine.id), "own crew is still recovered");
        assert!(!reclaimed.contains(&theirs.id));
        assert_eq!(g.get(&theirs.id).unwrap().status, STATE_WORKING);

        // An unscoped supervisor still sees the whole graph.
        assert!(g.reclaim_stale().contains(&theirs.id));
    }

    #[test]
    fn a_crashed_local_runner_is_still_reclaimed() {
        // The guard above must not blunt ordinary crash recovery: a node with
        // no placement, or one the box itself pulled down, still comes back.
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);

        let mut plain = mk(&g, "ordinary work", "high");
        plain.status = STATE_WORKING.to_string();
        plain.lease = None;
        g.save(&plain).unwrap();

        // What a runner's own pulled node looks like: it has a board id but no
        // placement, because placement is the *sender's* instruction.
        let mut pulled = mk(&g, "pulled from the board", "high");
        pulled.remote_id = Some("cloud-task-2".to_string());
        pulled.status = STATE_WORKING.to_string();
        pulled.lease = None;
        g.save(&pulled).unwrap();

        let reclaimed = g.reclaim_stale();
        assert_eq!(reclaimed.len(), 2, "both should come back: {reclaimed:?}");
        assert_eq!(g.get(&plain.id).unwrap().status, STATE_SUBMITTED);
        assert_eq!(g.get(&pulled.id).unwrap().status, STATE_SUBMITTED);
    }

    #[test]
    fn placement_survives_a_save_and_reload() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let mut t = mk(&g, "run it on the box", "medium");
        t.place = Some(PLACE_CLOUD.to_string());
        g.save(&t).unwrap();

        let reloaded = g.get(&t.id).unwrap();
        assert_eq!(reloaded.place.as_deref(), Some(PLACE_CLOUD));
    }

    #[test]
    fn an_unknown_placement_word_means_anywhere_not_nowhere() {
        // A node placed by a newer Aura — or by hand — must not become
        // unrunnable on a build that doesn't recognise the word. Stranding
        // work is a worse failure than ignoring a hint.
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let mut t = mk(&g, "from the future", "low");
        t.place = Some("gpu-cluster".to_string());
        assert!(runs_here(&t, PLACE_LOCAL));
        assert!(runs_here(&t, PLACE_CLOUD));
    }

    #[test]
    fn the_words_people_actually_type_are_understood() {
        assert_eq!(normalize_place("cloud"), Some(PLACE_CLOUD));
        assert_eq!(normalize_place(" REMOTE "), Some(PLACE_CLOUD));
        assert_eq!(normalize_place("box"), Some(PLACE_CLOUD));
        assert_eq!(normalize_place("local"), Some(PLACE_LOCAL));
        assert_eq!(normalize_place("Laptop"), Some(PLACE_LOCAL));
        assert_eq!(normalize_place(""), None);
    }

    #[test]
    fn lease_lives_in_gitignored_sidecar_not_the_graph_file() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let t = mk(&g, "ship it", "high");
        let a2a = repo.join(".aura").join("a2a");
        let graph_file = a2a.join(format!("{}.json", t.id));
        let sidecar = a2a.join(format!("{}.lease.json", t.id));

        // Claiming stamps a lease — in memory and in the sidecar, NEVER in the
        // durable graph file (which must stay git-clean).
        let claimed = g.claim(&t.id, "runner-a", 1800).unwrap();
        assert!(claimed.lease.is_some());
        let graph_json = fs::read_to_string(&graph_file).unwrap();
        assert!(
            graph_json.contains("\"lease\": null"),
            "graph file must not carry the lease: {graph_json}"
        );
        assert!(sidecar.exists(), "lease sidecar must exist while working");

        // get() overlays the sidecar back onto the task.
        assert_eq!(g.get(&t.id).unwrap().lease.unwrap().holder, "runner-a");

        // A peer pulls the graph file but NOT the gitignored sidecar — it sees
        // no lease, so a node stuck `working` is reclaimed back to the ready set.
        fs::remove_file(&sidecar).unwrap();
        assert!(g.get(&t.id).unwrap().lease.is_none());
        assert!(g.reclaim_stale().contains(&t.id));

        // Completing a node clears its lease sidecar.
        g.claim(&t.id, "runner-a", 1800).unwrap();
        assert!(sidecar.exists());
        g.complete(&t.id, Some("abc123".into()), None).unwrap();
        assert!(!sidecar.exists(), "completing clears the lease sidecar");
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
    fn paused_node_leaves_the_ready_set_and_resumes() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "A", "high");
        assert_eq!(ready_set(&g.list()).len(), 1, "ready before pause");
        g.pause(&a.id).unwrap();
        assert_eq!(g.get(&a.id).unwrap().status, STATE_PAUSED);
        let view = ready_view(&g.list());
        assert!(view.ready.is_empty(), "paused node is not ready");
        assert_eq!(view.paused.len(), 1, "paused node in its own bucket");
        // Resume → back in the ready set.
        g.resume(&a.id).unwrap();
        assert_eq!(ready_set(&g.list()).len(), 1, "ready again after resume");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn pause_scope_parks_a_whole_goal() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        // Two tasks tagged goal:alerts, one tagged goal:export.
        let tag = |t: &LoopTask, tag: &str| {
            let mut t = t.clone();
            t.tags.push(tag.into());
            g.save(&t).unwrap();
        };
        let a = mk(&g, "A", "high");
        tag(&a, "goal:alerts");
        let b = mk(&g, "B", "high");
        tag(&b, "goal:alerts");
        let c = mk(&g, "C", "high");
        tag(&c, "goal:export");

        let scope = RunScope { goal: Some("alerts".into()), crew: None };
        let paused = g.pause_scope(&scope);
        assert_eq!(paused.len(), 2, "both alerts tasks paused");
        assert_eq!(g.get(&c.id).unwrap().status, STATE_SUBMITTED, "export untouched");

        let goals = goals_summary(&g.list());
        let alerts = goals.iter().find(|x| x.goal == "alerts").unwrap();
        assert_eq!(alerts.paused, 2);
        assert_eq!(alerts.total, 2);

        let resumed = g.resume_scope(&scope);
        assert_eq!(resumed.len(), 2, "both alerts tasks resumed");
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn crew_scope_isolates_runnable_slices() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let a = mk(&g, "A", "high");
        let _b = mk(&g, "B", "high");
        g.set_crew(&a.id, Some("blue".into())).unwrap();
        // b stays in the default "main" crew.
        let blue = RunScope { goal: None, crew: Some("blue".into()) };
        let only_blue = blue.filter(&g.list());
        assert_eq!(only_blue.len(), 1);
        assert_eq!(only_blue[0].id, a.id);

        let crews = crews_summary(&g.list());
        assert_eq!(crews.len(), 2, "blue + main");
        assert!(crews.iter().any(|c| c.crew == "blue" && c.total == 1));
        assert!(crews.iter().any(|c| c.crew == "main" && c.total == 1));
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
            crew_id: None,
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
    fn upsert_from_board_carries_and_preserves_crew() {
        let repo = tmp_repo();
        let g = LoopGraph::at(&repo);
        let proj = |crew: Option<&str>| BoardProjection {
            board_task_id: "T-crew".into(),
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
            crew_id: crew.map(str::to_string),
        };
        // A board card that names a crew mints the node into it.
        let (a, _) = g.upsert_from_board(proj(Some("perf"))).unwrap();
        assert_eq!(a.crew_id.as_deref(), Some("perf"));
        // A later sync that names NO crew must not un-crew the node.
        let (b, _) = g.upsert_from_board(proj(None)).unwrap();
        assert_eq!(b.crew_id.as_deref(), Some("perf"), "sync must not un-crew");
        // A sync that names a different crew re-homes it.
        let (c, _) = g.upsert_from_board(proj(Some("docs"))).unwrap();
        assert_eq!(c.crew_id.as_deref(), Some("docs"));
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
            crew_id: None,
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
