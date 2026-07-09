//! Human-task ("JIRA-style") tracker — per-repo CRUD over a JSON file at
//! `<repoRoot>/.aura/tasks/tasks.json`. Frontend renders a kanban board +
//! list; future cloud sync wraps the same shape on the aura-cloud side.
//!
//! Distinct from `a2a_tasks` (agent-to-agent dispatch records in
//! `cmd_manager`). This module is for human work tracking: title,
//! description, assignee, priority, status, labels, linked PR, linked
//! chat message.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LinkedPr {
    pub repo: String,
    pub number: u64,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    /// Monotonic per-repo identifier exposed in the UI as
    /// `AURA-{sequence_id}`. Plane-style human-friendly handle. Allocated
    /// on create from `<repo>/.aura/tasks/_meta.json`. Older rows that
    /// were written before this field existed deserialize as `0` and are
    /// healed lazily on first load (see `backfill_sequence_ids`).
    #[serde(default)]
    pub sequence_id: u64,
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Legacy free-form status string: "backlog" | "in_progress" |
    /// "in_review" | "done". Kept on the wire so older clients keep
    /// working, but new code should read `state_id` and look the state
    /// up in the per-repo state catalog (`task_states.json`). The two
    /// are mirrored at write-time and healed on read; see
    /// `backfill_states`.
    pub status: String,
    /// OO.3 canonical state pointer. References an entry in the per-
    /// repo state catalog at `<repo>/.aura/tasks/task_states.json`. The
    /// catalog ships a default set of `backlog | unstarted | started |
    /// completed | cancelled` on first read; users can add custom
    /// states. Empty string on rows written before OO.3 — `tasks_list`
    /// heals these by mapping the legacy `status` field through
    /// `legacy_status_to_state_id`.
    #[serde(default)]
    pub state_id: String,
    /// Legacy free-form priority string. Kept on the wire for back-
    /// compat; the canonical OO.3 form is the same string but
    /// constrained to the 5-stop ladder `urgent | high | medium | low |
    /// none`. Existing rows are normalized in-place on read via
    /// `normalize_priority`.
    #[serde(default = "default_priority")]
    pub priority: String,
    /// Legacy single-assignee handle. Kept on the wire for back-compat.
    /// New code should read `assignee_ids` instead; that array is
    /// healed from this field at read time so a row never has one
    /// without the other.
    #[serde(default)]
    pub assignee: Option<String>,
    /// OO.3 multi-assignee. List of git handles (matching
    /// `TeamMember::handle`). Order is preserved as the avatar-stack
    /// order in the UI. Backfilled from the singular `assignee` on
    /// read so existing tasks surface their owner correctly; writes go
    /// through `assignee_ids` and the singular `assignee` is mirrored
    /// to the first entry for legacy readers.
    #[serde(default)]
    pub assignee_ids: Vec<String>,
    /// AI agent assigned to this task (claude, gemini, codex, etc.).
    /// Surfaced as a chip alongside `assignee` so humans + agents can
    /// share the same board with clear ownership.
    #[serde(default)]
    pub agent_assignee: Option<String>,
    #[serde(default)]
    pub reporter: Option<String>,
    /// Legacy free-form label strings. Kept on the wire; the canonical
    /// OO.3 form is `label_ids` which points at entries in the per-repo
    /// label catalog (`task_labels.json`). On read, any string in
    /// `labels` is auto-imported into the catalog and the resulting id
    /// is appended to `label_ids`; on write, `labels` is mirrored from
    /// the catalog names.
    #[serde(default)]
    pub labels: Vec<String>,
    /// OO.3 label pointer list. References entries in the per-repo
    /// label catalog at `<repo>/.aura/tasks/task_labels.json`. Empty on
    /// rows written before OO.3 — `tasks_list` heals these from
    /// `labels`.
    #[serde(default)]
    pub label_ids: Vec<String>,
    #[serde(default)]
    pub linked_pr: Option<LinkedPr>,
    #[serde(default)]
    pub linked_message_id: Option<String>,
    /// RFC3339 date (no time) — `YYYY-MM-DD`. Surfaced on the card as a
    /// pill and used by sort-by-due.
    #[serde(default)]
    pub due_date: Option<String>,
    /// RFC3339 date (no time) — `YYYY-MM-DD`. When set, used as the
    /// Gantt bar's left edge; otherwise the bar starts at `created_at`.
    #[serde(default)]
    pub start_date: Option<String>,
    /// Effort estimate in story points or hours (caller decides). Used
    /// by sprint summing and capacity views.
    #[serde(default)]
    pub estimate: Option<f32>,
    /// Parent task id. Subsumes the legacy `epic_id` semantically: when
    /// parent points at an `is_epic=true` task the Epics view picks it
    /// up exactly like before; when it points at a regular task the
    /// Plane-style sub-task hierarchy uses it. Read paths fall back to
    /// `epic_id` when `parent_id` is missing; create/update mirror the
    /// two so older clients keep working.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Legacy parent-epic field kept on the wire for back-compat. Treat
    /// as equivalent to `parent_id` when reading. New code should write
    /// `parent_id`; this field is mirrored so old readers still see it.
    #[serde(default)]
    pub epic_id: Option<String>,
    /// True when this task IS an epic (a container for child tasks).
    /// Epics show as cards in their own swimlane.
    #[serde(default)]
    pub is_epic: bool,
    /// Free-text objective / OKR link (e.g. "Q3-O1 KR2: ship v0.3.0").
    /// First-class so the goals tree can index it.
    #[serde(default)]
    pub objective: Option<String>,
    /// Tasks that must complete before this one (other task IDs).
    /// Cycle detection happens at sort time.
    #[serde(default)]
    pub dependencies: Vec<String>,
    /// Linked A2A bead id when this task was minted from / to an
    /// agent-to-agent run. The bead is the source of truth for agent
    /// execution; the task tracks the human framing.
    #[serde(default)]
    pub bead_id: Option<String>,
    /// Sprint / iteration this task belongs to (free-form slug).
    #[serde(default)]
    pub sprint: Option<String>,
    /// OO.4 — Plane-style Cycle pointer. References a row in
    /// `<repo>/.aura/tasks/task_cycles.json` (see `cmd_tasks_cycles`).
    /// Empty on rows written before OO.4 — the heal pass leaves them
    /// `None` since "no cycle" is a real value. The heal pass also
    /// clears this pointer when the referenced cycle was deleted out
    /// from under the task, so a stale id never lingers.
    #[serde(default)]
    pub cycle_id: Option<String>,
    /// OO.4 — Plane-style Module pointer. References a row in
    /// `<repo>/.aura/tasks/task_modules.json` (see `cmd_tasks_modules`).
    /// Same heal semantics as `cycle_id`.
    #[serde(default)]
    pub module_id: Option<String>,
    /// RFC3339 archive timestamp. Reserved for Phase 3 (Plane-parity
    /// archive flow); not yet written by any command. Tasks with a
    /// non-null `archived_at` will eventually be hidden from default
    /// views and surface in a dedicated Archive slice.
    #[serde(default)]
    pub archived_at: Option<String>,
    /// QQ.1 — External-system source slug ("jira", "linear", "github",
    /// "sentry", or a custom MCP server name). Set when the row was
    /// imported from an MCP server; the pair `(external_source,
    /// external_id)` is the upsert key for re-imports.
    #[serde(default)]
    pub external_source: Option<String>,
    /// QQ.1 — Stable id in the source system (e.g. Jira issue key
    /// `ACME-123`, Linear identifier, GitHub `repo#42`). Combined with
    /// `external_source` to dedupe on re-import so running the same
    /// JQL twice doesn't create N copies.
    #[serde(default)]
    pub external_id: Option<String>,
    /// QQ.1 — Clickable URL back to the source-system record.
    /// Rendered as a chip on the task card + detail pane.
    #[serde(default)]
    pub external_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_priority() -> String {
    "medium".into()
}

// ─── OO.3 ontology constants ───────────────────────────────────────────
//
// Plane-style 5-stop priority ladder. The legacy `low|medium|high` set
// maps onto the middle three rungs; anything we don't recognise gets
// flattened to `none` so a corrupted row never crashes the kanban.
//
// `urgent` is the new "drop everything" rung — distinct from `high` so
// teams can use them independently. `none` is the "no priority set"
// sentinel; both Plane and Linear treat it as a real value rather than
// a null, which lets the priority filter chip render it explicitly.

pub const PRIORITIES: [&str; 5] = ["urgent", "high", "medium", "low", "none"];

/// Coerce any legacy priority value to a 5-stop slug. Unknown values
/// fall through to `none` rather than panicking so a hand-edited
/// `tasks.json` with garbage in `priority` stays loadable.
fn normalize_priority(p: &str) -> String {
    match p.to_ascii_lowercase().as_str() {
        "urgent" => "urgent",
        "high" => "high",
        "medium" => "medium",
        "low" => "low",
        "none" | "" => "none",
        _ => "none",
    }
    .to_string()
}

/// Legacy `status` → canonical `state_id` mapping. The keys mirror the
/// strings the v0.2.30 schema wrote; the values are the IDs of the
/// default states minted by `ensure_default_states`. Anything we
/// don't recognise falls through to `unstarted` (the "fresh" state)
/// so a stray status string doesn't disappear off the board.
fn legacy_status_to_state_id(status: &str) -> &'static str {
    match status {
        "backlog" => "backlog",
        "in_progress" => "started",
        "in_review" => "started",
        "done" => "completed",
        "todo" => "unstarted",
        _ => "unstarted",
    }
}

/// Reverse of `legacy_status_to_state_id` for the back-compat write
/// path. Maps each canonical state group back to the v0.2.30 status
/// string an older reader would expect. Custom states (anything
/// outside the default set) collapse onto the closest legacy bucket
/// driven by the state's `group` field.
fn state_to_legacy_status(state: &TaskState) -> &'static str {
    match state.group.as_str() {
        "backlog" => "backlog",
        "unstarted" => "backlog",
        "started" => "in_progress",
        "completed" => "done",
        "cancelled" => "done",
        _ => "backlog",
    }
}

#[derive(Default, Serialize, Deserialize)]
struct TaskFile {
    #[serde(default)]
    tasks: Vec<Task>,
}

fn tasks_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("tasks.json")
}

fn load(repo_root: &Path) -> Result<TaskFile, String> {
    let p = tasks_path(repo_root);
    if !p.exists() {
        return Ok(TaskFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save(repo_root: &Path, file: &TaskFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&tasks_path(repo_root), file)
}

// ─── Live-sync apply (#218) ─────────────────────────────────────────────
//
// `cmd_tasks_sync` pulls task mutations off the chat rail and hands them
// here to land in `tasks.json`. The merge is **last-writer-wins** keyed
// on the mutation's RFC3339 timestamp. This path writes via the same
// `load`/`save` the local commands use but deliberately does NOT route
// through `tasks_update` — that would re-broadcast and loop the rail.
// `tasks_list` re-runs the heal pipeline on the next read, so a raw
// remote snapshot (already healed on the sender) is safe to drop in.

/// One mutation pulled off the rail. `Upsert` is boxed because `Task` is
/// large and we don't want a fat enum variant on the common `Delete`.
pub(crate) enum RemoteOp {
    /// Full task snapshot + its `updated_at` (the LWW key).
    Upsert(Box<Task>, String),
    /// Task id + the delete moment (the LWW key).
    Delete(String, String),
}

/// Compare two RFC3339 timestamps chronologically, falling back to a
/// lexical compare when either fails to parse (lexical order matches
/// chronological order for same-offset, fixed-precision RFC3339).
fn rfc3339_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    match (
        chrono::DateTime::parse_from_rfc3339(a),
        chrono::DateTime::parse_from_rfc3339(b),
    ) {
        (Ok(da), Ok(db)) => da.cmp(&db),
        _ => a.cmp(b),
    }
}

/// Apply a seq-ordered batch of remote mutations LWW into `tasks.json`,
/// loading and saving exactly once. Returns `(applied_ids, removed_ids)`.
/// An in-batch tombstone map stops an earlier upsert from resurrecting a
/// task a later delete removed; a *newer*-timestamped upsert after a
/// delete legitimately re-creates it (a real concurrent edit).
pub(crate) fn apply_remote_batch(
    repo_root: &Path,
    ops: Vec<RemoteOp>,
) -> Result<(Vec<String>, Vec<String>), String> {
    if ops.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut file = load(repo_root)?;
    let mut applied: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    // id -> delete timestamp seen earlier in this same batch.
    let mut tombstones: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for op in ops {
        match op {
            RemoteOp::Upsert(task, ts) => {
                // If a delete earlier in this batch tombstoned this id,
                // only resurrect when this upsert is strictly newer.
                if let Some(dts) = tombstones.get(&task.id) {
                    if rfc3339_cmp(&ts, dts) != std::cmp::Ordering::Greater {
                        continue;
                    }
                    tombstones.remove(&task.id);
                }
                if let Some(existing) = file.tasks.iter_mut().find(|t| t.id == task.id) {
                    if rfc3339_cmp(&ts, &existing.updated_at) == std::cmp::Ordering::Greater {
                        let id = task.id.clone();
                        *existing = *task;
                        applied.push(id);
                    }
                } else {
                    let id = task.id.clone();
                    file.tasks.push(*task);
                    applied.push(id);
                }
            }
            RemoteOp::Delete(id, ts) => {
                if let Some(pos) = file.tasks.iter().position(|t| t.id == id) {
                    // A local edit strictly newer than the delete wins —
                    // the task survives (LWW).
                    let local_newer = rfc3339_cmp(&file.tasks[pos].updated_at, &ts)
                        == std::cmp::Ordering::Greater;
                    if !local_newer {
                        file.tasks.remove(pos);
                        removed.push(id.clone());
                    }
                }
                tombstones.insert(id, ts);
            }
        }
    }

    if !applied.is_empty() || !removed.is_empty() {
        save(repo_root, &file)?;
    }
    Ok((applied, removed))
}

// ─── Sequence allocator ─────────────────────────────────────────────────
//
// Plane-style `AURA-{n}` identifiers are minted from a monotonic counter
// persisted to `<repo>/.aura/tasks/_meta.json`. We avoid touching the
// hot `tasks.json` write path so corruption of one file can't take the
// other down. Allocation is read-modify-write under the same
// write-tmp-then-rename atomicity as `save` — Tauri commands are
// awaited sequentially per webview, so the only realistic contention
// is between this process and an external `aura` CLI invocation; the
// rename is atomic at the filesystem layer on macOS/Linux which is the
// only guarantee `tasks.json` relies on today.
//
// First-run backfill: if `_meta.json` is missing we scan all tasks,
// find `max(sequence_id)`, set `next_seq = max + 1`. Tasks that still
// have `sequence_id == 0` after the file has been read are healed
// in-place via `backfill_sequence_ids` so the kanban never shows a row
// labelled "AURA-0".

#[derive(Default, Serialize, Deserialize)]
struct TaskMeta {
    #[serde(default)]
    next_seq: u64,
}

fn meta_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("_meta.json")
}

fn load_meta(repo_root: &Path) -> Result<Option<TaskMeta>, String> {
    let p = meta_path(repo_root);
    if !p.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    let m: TaskMeta = serde_json::from_slice(&bytes)
        .map_err(|e| format!("parse {}: {}", p.display(), e))?;
    Ok(Some(m))
}

fn save_meta(repo_root: &Path, meta: &TaskMeta) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&meta_path(repo_root), meta)
}

/// Heal any rows that pre-date `sequence_id` by assigning them the next
/// available number, and return the meta object reflecting the post-heal
/// `next_seq`. Mutates `file` in-place. Returns `true` if anything was
/// changed so the caller can persist `tasks.json`.
fn backfill_sequence_ids(file: &mut TaskFile, meta: &mut TaskMeta) -> bool {
    let existing_max = file.tasks.iter().map(|t| t.sequence_id).max().unwrap_or(0);
    if meta.next_seq <= existing_max {
        meta.next_seq = existing_max + 1;
    }
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if t.sequence_id == 0 {
            t.sequence_id = meta.next_seq;
            meta.next_seq += 1;
            mutated = true;
        }
        // Mirror legacy epic_id <-> parent_id so both readers see the
        // same value regardless of which field the row was written
        // with. Heal in-place so subsequent reads are stable.
        match (t.parent_id.as_ref(), t.epic_id.as_ref()) {
            (None, Some(eid)) => {
                t.parent_id = Some(eid.clone());
                mutated = true;
            }
            (Some(pid), None) => {
                t.epic_id = Some(pid.clone());
                mutated = true;
            }
            _ => {}
        }
    }
    mutated
}

/// Read-modify-write the meta file to allocate one fresh sequence id.
/// Initializes from `existing_tasks` when `_meta.json` is absent so
/// repos created before this feature shipped don't restart from 1.
fn allocate_sequence_id(repo_root: &Path, existing_tasks: &[Task]) -> Result<u64, String> {
    let mut meta = load_meta(repo_root)?.unwrap_or_default();
    let existing_max = existing_tasks.iter().map(|t| t.sequence_id).max().unwrap_or(0);
    if meta.next_seq <= existing_max {
        meta.next_seq = existing_max + 1;
    }
    if meta.next_seq == 0 {
        meta.next_seq = 1;
    }
    let assigned = meta.next_seq;
    meta.next_seq += 1;
    save_meta(repo_root, &meta)?;
    Ok(assigned)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    format!("task_{}", uuid::Uuid::new_v4())
}

// ─── OO.3 State catalog ────────────────────────────────────────────────
//
// Plane-style per-project state set, persisted to
// `<repo>/.aura/tasks/task_states.json`. The first read on any repo
// seeds the file with the five canonical states the platform ships:
// `backlog | unstarted | started | completed | cancelled`. Users may
// add custom states — every state belongs to one of the canonical
// `group`s so legacy-status mirroring + ordering stay well-defined
// for custom rows too.
//
// `position` is a stable integer that drives column order on the
// board. Default states are seeded at 100/200/300/400/500 so custom
// states can slot in between without renumbering.

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskState {
    /// Stable slug ("backlog", "started", "ready-for-qa"). Used as
    /// `Task::state_id` and as the kanban column key.
    pub id: String,
    /// Human label rendered in the state pill and on the column header.
    pub name: String,
    /// Canonical bucket — one of `backlog | unstarted | started |
    /// completed | cancelled`. Drives the legacy `status` mirror and
    /// ordering when `position` ties.
    pub group: String,
    /// CSS color string ("#94a3b8") used by the state pill.
    pub color: String,
    /// Sort key for the kanban columns. Smaller renders first.
    #[serde(default)]
    pub position: i32,
    /// When true, this state is one of the five seeded defaults — the
    /// UI hides the delete affordance for these so users don't lock
    /// themselves out of the canonical workflow.
    #[serde(default)]
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct TaskStateFile {
    #[serde(default)]
    states: Vec<TaskState>,
}

fn task_states_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("task_states.json")
}

fn load_task_states(repo_root: &Path) -> Result<TaskStateFile, String> {
    let p = task_states_path(repo_root);
    if !p.exists() {
        return Ok(TaskStateFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_task_states(repo_root: &Path, file: &TaskStateFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&task_states_path(repo_root), file)
}

/// Idempotent default-state seeder. Adds any missing canonical state
/// without touching customisations the user has already made. Returns
/// `true` when the file was mutated so the caller can persist.
fn ensure_default_states(file: &mut TaskStateFile) -> bool {
    let defaults: [(&str, &str, &str, &str, i32); 5] = [
        ("backlog", "Backlog", "backlog", "#94a3b8", 100),
        ("unstarted", "Todo", "unstarted", "#64748b", 200),
        ("started", "In Progress", "started", "#3b82f6", 300),
        ("completed", "Done", "completed", "#22c55e", 400),
        ("cancelled", "Cancelled", "cancelled", "#ef4444", 500),
    ];
    let now = now_iso();
    let mut mutated = false;
    for (id, name, group, color, position) in defaults {
        if !file.states.iter().any(|s| s.id == id) {
            file.states.push(TaskState {
                id: id.into(),
                name: name.into(),
                group: group.into(),
                color: color.into(),
                position,
                is_default: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            });
            mutated = true;
        }
    }
    mutated
}

/// Load the state catalog, seeding defaults on first read. Used by every
/// task command so a fresh repo "just works" without an explicit init
/// step.
fn load_or_seed_states(repo_root: &Path) -> Result<TaskStateFile, String> {
    let mut file = load_task_states(repo_root)?;
    if ensure_default_states(&mut file) {
        save_task_states(repo_root, &file)?;
    }
    Ok(file)
}

// ─── OO.3 Label catalog ────────────────────────────────────────────────
//
// Per-repo label registry at `<repo>/.aura/tasks/task_labels.json`.
// Labels carry a name + color and are referenced by `Task::label_ids`.
// On read, every legacy string in `Task::labels` is auto-imported
// (lowercased name as the id) so existing tasks keep their labels
// without manual migration. Color is seeded from a deterministic
// palette hash so the user gets stable colors out of the box.

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskLabel {
    /// Stable slug — lowercased, kebab-case of `name` by default. Used
    /// as the foreign key in `Task::label_ids`.
    pub id: String,
    /// Human label rendered on the chip ("bug", "design", "RFC").
    pub name: String,
    /// CSS color string ("#ef4444"). Falls back to a palette pick when
    /// the row is auto-imported from a legacy string.
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct TaskLabelFile {
    #[serde(default)]
    labels: Vec<TaskLabel>,
}

fn task_labels_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("task_labels.json")
}

fn load_task_labels(repo_root: &Path) -> Result<TaskLabelFile, String> {
    let p = task_labels_path(repo_root);
    if !p.exists() {
        return Ok(TaskLabelFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_task_labels(repo_root: &Path, file: &TaskLabelFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&task_labels_path(repo_root), file)
}

/// Deterministic palette for auto-imported labels. Hash the label name
/// and pick a color so the same legacy string always lands on the same
/// chip color across repos.
const LABEL_PALETTE: [&str; 10] = [
    "#ef4444", "#f59e0b", "#84cc16", "#10b981", "#06b6d4",
    "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#64748b",
];

fn palette_for(name: &str) -> &'static str {
    let mut h: u32 = 0;
    for b in name.as_bytes() {
        h = h.wrapping_mul(31).wrapping_add(*b as u32);
    }
    LABEL_PALETTE[(h as usize) % LABEL_PALETTE.len()]
}

fn slug_label_name(name: &str) -> String {
    name.trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Look up a label by id or auto-import it from a name. Returns the
/// canonical id. Idempotent — calling twice with the same name yields
/// the same id and does not double-write the file.
fn ensure_label(file: &mut TaskLabelFile, name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let id = slug_label_name(trimmed);
    if id.is_empty() {
        return None;
    }
    if file.labels.iter().any(|l| l.id == id) {
        return Some(id);
    }
    let now = now_iso();
    file.labels.push(TaskLabel {
        id: id.clone(),
        name: trimmed.to_string(),
        color: palette_for(&id).to_string(),
        created_at: now.clone(),
        updated_at: now,
    });
    Some(id)
}

/// Heal each task into the OO.3 ontology in place:
/// * `state_id` ← `legacy_status_to_state_id(status)` when empty
/// * `status` ← `state_to_legacy_status(state)` mirror after that
/// * `priority` ← `normalize_priority(...)` to 5-stop ladder
/// * `assignee_ids` ← `[assignee]` when empty and assignee is set
/// * `assignee` ← `assignee_ids.first()` when only the array is set
/// * `label_ids` ← auto-imported from `labels` strings; new entries are
///   pushed onto `label_file` so callers can persist them
/// * `labels` ← canonical names from the catalog so older readers see
///   the same chips
///
/// Returns `(tasks_mutated, labels_mutated)` so the caller knows which
/// files to write back.
fn backfill_ontology(
    tasks: &mut TaskFile,
    states: &TaskStateFile,
    labels: &mut TaskLabelFile,
) -> (bool, bool) {
    let mut tasks_mutated = false;
    let mut labels_mutated = false;
    for t in tasks.tasks.iter_mut() {
        // ── state ────────────────────────────────────────────────────
        if t.state_id.is_empty() {
            t.state_id = legacy_status_to_state_id(&t.status).to_string();
            tasks_mutated = true;
        }
        // Mirror status from the state's group so older readers see a
        // matching label even when the user is on a custom state.
        if let Some(state) = states.states.iter().find(|s| s.id == t.state_id) {
            let mirror = state_to_legacy_status(state).to_string();
            if t.status != mirror {
                t.status = mirror;
                tasks_mutated = true;
            }
        }
        // ── priority ─────────────────────────────────────────────────
        let norm = normalize_priority(&t.priority);
        if t.priority != norm {
            t.priority = norm;
            tasks_mutated = true;
        }
        // ── assignees ────────────────────────────────────────────────
        if t.assignee_ids.is_empty() {
            if let Some(a) = t.assignee.as_ref() {
                let trimmed = a.trim();
                if !trimmed.is_empty() {
                    t.assignee_ids.push(trimmed.to_string());
                    tasks_mutated = true;
                }
            }
        } else if t.assignee.is_none() {
            t.assignee = t.assignee_ids.first().cloned();
            tasks_mutated = true;
        }
        // ── labels ───────────────────────────────────────────────────
        // Auto-import every legacy string into the catalog and rebuild
        // label_ids so it stays in sync with `labels`. We then mirror
        // `labels` back from the catalog so the names normalize to the
        // catalog's canonical capitalisation.
        let mut next_ids: Vec<String> = Vec::with_capacity(t.labels.len());
        for raw in &t.labels {
            if let Some(id) = ensure_label(labels, raw) {
                if !next_ids.contains(&id) {
                    next_ids.push(id);
                }
            }
        }
        for existing_id in &t.label_ids {
            // Keep pointers the legacy `labels` array didn't surface
            // (e.g. label_ids written directly by the new API).
            if !next_ids.contains(existing_id) {
                next_ids.push(existing_id.clone());
            }
        }
        if next_ids != t.label_ids {
            t.label_ids = next_ids.clone();
            tasks_mutated = true;
        }
        // Mirror `labels` from the catalog so a stale legacy entry
        // ("bug ") gets normalised to its canonical chip ("bug").
        let mirrored: Vec<String> = t
            .label_ids
            .iter()
            .filter_map(|id| labels.labels.iter().find(|l| l.id == *id).map(|l| l.name.clone()))
            .collect();
        if mirrored != t.labels {
            t.labels = mirrored;
            tasks_mutated = true;
        }
        // Detect that we added a new label entry.
        if !t.label_ids.is_empty() {
            labels_mutated = labels_mutated
                || labels
                    .labels
                    .iter()
                    .any(|l| t.label_ids.contains(&l.id) && l.color != "");
        }
    }
    (tasks_mutated, labels_mutated)
}

#[derive(Deserialize, Default)]
pub struct CreateTaskInput {
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// Legacy free-form status (back-compat). New callers should send
    /// `state_id` instead; when both are present `state_id` wins and
    /// `status` is auto-mirrored from the state's group.
    #[serde(default)]
    pub status: Option<String>,
    /// OO.3 canonical state pointer. Optional; defaults to the state
    /// whose group is `backlog` (the first column of the kanban).
    #[serde(default)]
    pub state_id: Option<String>,
    /// 5-stop priority: `urgent | high | medium | low | none`. Anything
    /// else is normalised to `none` at write time.
    #[serde(default)]
    pub priority: Option<String>,
    /// Legacy single-assignee handle. Mirrored from `assignee_ids[0]`.
    #[serde(default)]
    pub assignee: Option<String>,
    /// OO.3 multi-assignee — list of git handles. When supplied wins
    /// over `assignee`; the singular field is mirrored to the first
    /// entry for legacy readers.
    #[serde(default)]
    pub assignee_ids: Vec<String>,
    #[serde(default)]
    pub agent_assignee: Option<String>,
    #[serde(default)]
    pub reporter: Option<String>,
    /// Legacy free-form label strings. Auto-imported into the catalog.
    #[serde(default)]
    pub labels: Vec<String>,
    /// OO.3 label-catalog pointers. When supplied wins over `labels`;
    /// the legacy `labels` array is mirrored from catalog names.
    #[serde(default)]
    pub label_ids: Vec<String>,
    #[serde(default)]
    pub linked_pr: Option<LinkedPr>,
    #[serde(default)]
    pub linked_message_id: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub estimate: Option<f32>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub epic_id: Option<String>,
    #[serde(default)]
    pub is_epic: bool,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub bead_id: Option<String>,
    #[serde(default)]
    pub sprint: Option<String>,
    /// OO.4 — Plane-style Cycle pointer. Optional on create; can be
    /// set directly here or via `tasks_cycle_assign` after the fact.
    #[serde(default)]
    pub cycle_id: Option<String>,
    /// OO.4 — Plane-style Module pointer. Same shape as `cycle_id`.
    #[serde(default)]
    pub module_id: Option<String>,
    /// QQ.1 — External-system source slug. See `Task::external_source`.
    #[serde(default)]
    pub external_source: Option<String>,
    /// QQ.1 — External-system stable id. See `Task::external_id`.
    #[serde(default)]
    pub external_id: Option<String>,
    /// QQ.1 — Clickable URL back to the source record.
    #[serde(default)]
    pub external_url: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateTaskInput {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Legacy status writer (back-compat). Prefer `state_id`.
    #[serde(default)]
    pub status: Option<String>,
    /// OO.3 canonical state pointer. When set, `status` is auto-
    /// mirrored from the state's group so older readers keep working.
    #[serde(default)]
    pub state_id: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    /// Legacy single-assignee writer (back-compat). Prefer
    /// `assignee_ids` for multi-assignee. When `assignee_ids` is set it
    /// wins; otherwise a `Some` here is wrapped into a single-element
    /// list and a `None` clears the array.
    #[serde(default)]
    pub assignee: Option<String>,
    /// OO.3 multi-assignee writer — replaces the whole list when
    /// supplied. Pass an empty array to clear.
    #[serde(default)]
    pub assignee_ids: Option<Vec<String>>,
    #[serde(default)]
    pub agent_assignee: Option<String>,
    /// Legacy labels writer — strings are auto-imported into the
    /// catalog so the corresponding `label_ids` get populated.
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    /// OO.3 labels writer — catalog ids. Wins over `labels`; the
    /// `labels` mirror is rebuilt from the catalog so older readers
    /// see canonical names.
    #[serde(default)]
    pub label_ids: Option<Vec<String>>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub estimate: Option<f32>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub epic_id: Option<String>,
    /// Promote / demote a task in-place. `Some(true)` flips on the
    /// epic flag so this task becomes a container; `Some(false)`
    /// demotes it back to a leaf. Skipped when omitted so an unrelated
    /// edit doesn't surprise-toggle.
    #[serde(default)]
    pub is_epic: Option<bool>,
    #[serde(default)]
    pub objective: Option<String>,
    #[serde(default)]
    pub dependencies: Option<Vec<String>>,
    #[serde(default)]
    pub bead_id: Option<String>,
    #[serde(default)]
    pub sprint: Option<String>,
    /// OO.4 — Plane-style Cycle pointer. Setting to `Some("")` clears
    /// the pointer; the empty string is treated as null by the
    /// backend. Prefer the dedicated `tasks_cycle_assign` /
    /// `tasks_cycle_unassign` commands for cycle membership.
    #[serde(default)]
    pub cycle_id: Option<String>,
    /// OO.4 — Plane-style Module pointer. Same clearing convention
    /// as `cycle_id`. Prefer `tasks_module_assign` /
    /// `tasks_module_unassign` for module membership.
    #[serde(default)]
    pub module_id: Option<String>,
    /// QQ.1 — External-system source slug writer. See
    /// `Task::external_source`. Setting to `Some("")` clears.
    #[serde(default)]
    pub external_source: Option<String>,
    /// QQ.1 — External-system stable id writer. Empty string clears.
    #[serde(default)]
    pub external_id: Option<String>,
    /// QQ.1 — Clickable URL writer. Empty string clears.
    #[serde(default)]
    pub external_url: Option<String>,
}

#[tauri::command]
pub async fn tasks_list(repo_root: String) -> Result<Vec<Task>, String> {
    let root = Path::new(&repo_root);
    let mut file = load(root)?;
    // ── Phase-1 heal: sequence ids + parent/epic mirror ────────────
    let needs_seq_heal = file.tasks.iter().any(|t| {
        t.sequence_id == 0
            || (t.parent_id.is_some() && t.epic_id.is_none())
            || (t.epic_id.is_some() && t.parent_id.is_none())
    }) || (!file.tasks.is_empty() && load_meta(root)?.is_none());
    let mut tasks_dirty = false;
    if needs_seq_heal {
        let mut meta = load_meta(root)?.unwrap_or_default();
        if backfill_sequence_ids(&mut file, &mut meta) {
            tasks_dirty = true;
        }
        save_meta(root, &meta)?;
    }
    // ── OO.3 ontology heal: state, priority, assignees, labels ─────
    // Seed the state + label catalogs on first read so the heal can
    // mirror status ↔ state_id and labels ↔ label_ids without a
    // race. The seed is idempotent so the second call costs one fs
    // stat and nothing else.
    let states = load_or_seed_states(root)?;
    let mut labels = load_task_labels(root)?;
    let (ont_tasks_dirty, ont_labels_dirty) = backfill_ontology(&mut file, &states, &mut labels);
    tasks_dirty = tasks_dirty || ont_tasks_dirty;
    if ont_labels_dirty || (!labels.labels.is_empty() && !task_labels_path(root).exists()) {
        save_task_labels(root, &labels)?;
    }
    // ── OO.4 heal: cycle + module pointers ─────────────────────────
    // Touch the cycle + module catalog files so they exist on disk
    // (idempotent first-touch — empty arrays for fresh repos). Then
    // clear any dangling `cycle_id` / `module_id` pointers whose
    // referenced row was deleted out from under the task.
    crate::cmd_tasks_cycles::ensure_cycles_file_initialized(root)?;
    crate::cmd_tasks_modules::ensure_modules_file_initialized(root)?;
    // ── BEAD-I migration: fold legacy sprints.json + Task::sprint into
    //    the unified Cycle store (one-time, tombstoned). Runs BEFORE we
    //    snapshot `known_cycle_ids` so freshly-folded cycles aren't seen
    //    as dangling by the pointer heal below.
    if migrate_sprints_to_cycles(root, &mut file)? {
        tasks_dirty = true;
    }
    let cycle_ids = crate::cmd_tasks_cycles::known_cycle_ids(root)?;
    let module_ids = crate::cmd_tasks_modules::known_module_ids(root)?;
    if backfill_oo4_pointers(&mut file, &cycle_ids, &module_ids) {
        tasks_dirty = true;
    }
    if tasks_dirty {
        save(root, &file)?;
    }
    Ok(file.tasks)
}

/// OO.4 heal — clear dangling `cycle_id` / `module_id` pointers.
///
/// A task can carry a stale pointer when:
///   * the file came from v0.2.31 (no cycle/module fields existed)
///   * a cycle or module was deleted while the task still pointed at it
///
/// The first case is benign — the optional fields default to `None`
/// and serde leaves them alone, so nothing to heal. The second case
/// is the real one: we drop the pointer rather than re-creating the
/// missing parent (that would silently undelete user intent).
///
/// Returns `true` when any task was mutated so the caller can persist.
fn backfill_oo4_pointers(
    file: &mut TaskFile,
    known_cycle_ids: &[String],
    known_module_ids: &[String],
) -> bool {
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if let Some(cid) = t.cycle_id.as_ref() {
            if !known_cycle_ids.iter().any(|k| k == cid) {
                t.cycle_id = None;
                mutated = true;
            }
        }
        if let Some(mid) = t.module_id.as_ref() {
            if !known_module_ids.iter().any(|k| k == mid) {
                t.module_id = None;
                mutated = true;
            }
        }
    }
    mutated
}

// ─── OO.4 cross-module helpers ────────────────────────────────────────
//
// The cycles + modules modules call back into this one to mirror the
// `Task::cycle_id` / `Task::module_id` pointer on assign/unassign and
// to detach tasks when a parent cycle/module is deleted. Keeping these
// helpers here (rather than re-implementing the load/save dance in
// each callsite) means there's one place where `tasks.json` is mutated
// — important because the heal pass on next `tasks_list` would catch
// drift but the round-trip would briefly show stale UI.

/// Set or clear a task's `cycle_id`. `None` clears the pointer; the
/// passed cycle id is NOT validated against the catalog (the caller —
/// `tasks_cycle_assign` — already validated it). Returns Ok(()) when
/// the task is missing so the cycles module can call this defensively
/// (e.g. after a task was deleted but the cycle still listed it).
pub fn set_task_cycle(
    repo_root: &Path,
    task_id: &str,
    cycle_id: Option<&str>,
) -> Result<(), String> {
    let mut file = load(repo_root)?;
    let now = now_iso();
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if t.id == task_id {
            let next = cycle_id.map(|s| s.to_string());
            if t.cycle_id != next {
                t.cycle_id = next;
                t.updated_at = now.clone();
                mutated = true;
            }
            break;
        }
    }
    if mutated {
        save(repo_root, &file)?;
    }
    Ok(())
}

/// Set or clear a task's `module_id`. Same semantics as
/// `set_task_cycle`.
pub fn set_task_module(
    repo_root: &Path,
    task_id: &str,
    module_id: Option<&str>,
) -> Result<(), String> {
    let mut file = load(repo_root)?;
    let now = now_iso();
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if t.id == task_id {
            let next = module_id.map(|s| s.to_string());
            if t.module_id != next {
                t.module_id = next;
                t.updated_at = now.clone();
                mutated = true;
            }
            break;
        }
    }
    if mutated {
        save(repo_root, &file)?;
    }
    Ok(())
}

/// Clear `cycle_id` from every task that points at the given cycle.
/// Called by `tasks_cycles_delete` immediately after the cycle is
/// removed from the catalog so the UI reflects the detach without
/// waiting for the next `tasks_list` heal.
pub fn detach_cycle(repo_root: &Path, cycle_id: &str) -> Result<(), String> {
    let mut file = load(repo_root)?;
    let now = now_iso();
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if t.cycle_id.as_deref() == Some(cycle_id) {
            t.cycle_id = None;
            t.updated_at = now.clone();
            mutated = true;
        }
    }
    if mutated {
        save(repo_root, &file)?;
    }
    Ok(())
}

/// Clear `module_id` from every task that points at the given module.
/// Mirror of `detach_cycle`.
pub fn detach_module(repo_root: &Path, module_id: &str) -> Result<(), String> {
    let mut file = load(repo_root)?;
    let now = now_iso();
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if t.module_id.as_deref() == Some(module_id) {
            t.module_id = None;
            t.updated_at = now.clone();
            mutated = true;
        }
    }
    if mutated {
        save(repo_root, &file)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn tasks_create(repo_root: String, input: CreateTaskInput) -> Result<Task, String> {
    let root = Path::new(&repo_root);
    let mut file = load(root)?;
    // Mint the AURA-{n} identifier from the meta counter BEFORE we
    // touch tasks.json so a meta-write failure doesn't leave us with a
    // task that has no sequence id. The allocator seeds itself from
    // max(existing) when _meta.json is absent (first-run backfill).
    let sequence_id = allocate_sequence_id(root, &file.tasks)?;
    // Mirror parent_id ↔ epic_id at write time so older clients that
    // only know `epic_id` still observe the parent pointer.
    let parent = input.parent_id.clone().or_else(|| input.epic_id.clone());
    let now = now_iso();
    // The local user is the actor behind this create — used both to
    // attribute the reporter when the caller left it blank and to address
    // the assign/mention DMs "from" the right person.
    let (actor_handle, actor_name) = crate::cmd_team::local_actor(&repo_root);
    // ── OO.3 catalog resolution ─────────────────────────────────────
    // Resolve the state pointer + the legacy status mirror in one pass.
    // Precedence: explicit `state_id` > explicit `status` > the
    // `backlog` default. We also seed the default state set on every
    // create so a brand-new repo lands on a populated kanban without
    // an explicit init.
    let mut state_file = load_or_seed_states(root)?;
    save_task_states(root, &state_file)?;
    let resolved_state_id = match &input.state_id {
        Some(sid) if !sid.is_empty() => sid.clone(),
        _ => {
            // Map the legacy `status` if supplied; else default to backlog.
            match &input.status {
                Some(s) => legacy_status_to_state_id(s).to_string(),
                None => "backlog".to_string(),
            }
        }
    };
    let resolved_state = state_file
        .states
        .iter()
        .find(|s| s.id == resolved_state_id)
        .cloned()
        .unwrap_or_else(|| {
            // Unknown id supplied — fall back to backlog rather than
            // erroring so a stale client doesn't break creates. Will
            // not happen in practice once the ensure_default_states
            // pass above runs, but defensive.
            ensure_default_states(&mut state_file);
            state_file
                .states
                .iter()
                .find(|s| s.id == "backlog")
                .cloned()
                .expect("backlog default seeded")
        });
    let mirrored_status = state_to_legacy_status(&resolved_state).to_string();

    // ── OO.3 label resolution ───────────────────────────────────────
    // `label_ids` wins when set; otherwise auto-import every string in
    // `labels`. Result: `label_ids` is the canonical pointer list, and
    // `labels` is rebuilt from catalog names for back-compat.
    let mut label_file = load_task_labels(root)?;
    let mut resolved_label_ids: Vec<String> = Vec::new();
    if !input.label_ids.is_empty() {
        for id in &input.label_ids {
            if !resolved_label_ids.contains(id)
                && label_file.labels.iter().any(|l| &l.id == id)
            {
                resolved_label_ids.push(id.clone());
            }
        }
    }
    for raw in &input.labels {
        if let Some(id) = ensure_label(&mut label_file, raw) {
            if !resolved_label_ids.contains(&id) {
                resolved_label_ids.push(id);
            }
        }
    }
    let mirrored_labels: Vec<String> = resolved_label_ids
        .iter()
        .filter_map(|id| label_file.labels.iter().find(|l| &l.id == id).map(|l| l.name.clone()))
        .collect();
    save_task_labels(root, &label_file)?;

    // ── OO.3 assignee resolution ────────────────────────────────────
    // `assignee_ids` wins; otherwise wrap the singular `assignee` into
    // a single-entry list. Deduplicate so the avatar stack never
    // doubles up on the same handle.
    let mut resolved_assignee_ids: Vec<String> = Vec::new();
    if !input.assignee_ids.is_empty() {
        for h in input.assignee_ids.iter().map(|s| s.trim().to_string()) {
            if !h.is_empty() && !resolved_assignee_ids.contains(&h) {
                resolved_assignee_ids.push(h);
            }
        }
    } else if let Some(a) = input.assignee.as_ref() {
        let trimmed = a.trim().to_string();
        if !trimmed.is_empty() {
            resolved_assignee_ids.push(trimmed);
        }
    }
    let mirrored_assignee = resolved_assignee_ids.first().cloned();

    let task = Task {
        id: new_id(),
        sequence_id,
        title: input.title.trim().to_string(),
        description: input.description,
        status: mirrored_status,
        state_id: resolved_state_id,
        priority: normalize_priority(
            input.priority.as_deref().unwrap_or("none"),
        ),
        assignee: mirrored_assignee,
        assignee_ids: resolved_assignee_ids,
        agent_assignee: input.agent_assignee,
        // Attribute the creator when the caller didn't name a reporter, so
        // the board shows who opened the task (and the assign DM has a real
        // "from"). Never overwrite an explicit reporter.
        reporter: input
            .reporter
            .clone()
            .filter(|r| !r.trim().is_empty())
            .or_else(|| {
                if actor_handle.is_empty() {
                    None
                } else {
                    Some(actor_handle.clone())
                }
            }),
        labels: mirrored_labels,
        label_ids: resolved_label_ids,
        linked_pr: input.linked_pr,
        linked_message_id: input.linked_message_id,
        due_date: input.due_date,
        start_date: input.start_date,
        estimate: input.estimate,
        parent_id: parent.clone(),
        epic_id: parent,
        is_epic: input.is_epic,
        objective: input.objective,
        dependencies: input.dependencies,
        bead_id: input.bead_id,
        sprint: input.sprint,
        // OO.4 — Plane Cycle + Module pointers. Empty string in either
        // field clears the pointer (matches the update path's
        // convention) so the frontend can send a single shape for
        // "clear" vs "set".
        cycle_id: input.cycle_id.filter(|s| !s.is_empty()),
        module_id: input.module_id.filter(|s| !s.is_empty()),
        archived_at: None,
        external_source: input.external_source.filter(|s| !s.is_empty()),
        external_id: input.external_id.filter(|s| !s.is_empty()),
        external_url: input.external_url.filter(|s| !s.is_empty()),
        created_at: now.clone(),
        updated_at: now,
    };
    file.tasks.push(task.clone());
    save(root, &file)?;
    // ── OO.4 mirror — keep the cycle/module catalogs in sync ───────
    // The pointer on `Task` is the source of truth, but we mirror it
    // onto the catalog's `task_ids` so a sidebar "show cycle X" view
    // can render the membership without a full task scan. We only
    // mirror when the referenced row actually exists; if it doesn't,
    // the next `tasks_list` heal clears the dangling pointer.
    if let Some(cid) = task.cycle_id.as_deref() {
        let known = crate::cmd_tasks_cycles::known_cycle_ids(root)?;
        if known.iter().any(|k| k == cid) {
            crate::cmd_tasks_cycles::mirror_assign_task(root, cid, &task.id)?;
        }
    }
    if let Some(mid) = task.module_id.as_deref() {
        let known = crate::cmd_tasks_modules::known_module_ids(root)?;
        if known.iter().any(|k| k == mid) {
            crate::cmd_tasks_modules::mirror_assign_task(root, mid, &task.id)?;
        }
    }
    // OO.5 — Activity hook: the task's birth event lands at the top of
    // its future timeline. Payload carries the human-friendly handle
    // (`AURA-{n}`) so the timeline doesn't have to cross-reference the
    // task ledger to render its label.
    let _ = crate::cmd_tasks_activity::append_activity(
        root,
        &task.id,
        "created",
        "system",
        serde_json::json!({
            "sequence_id": task.sequence_id,
            "title": task.title,
        }),
    );
    // #218 — broadcast the new task to teammates over the live rail
    // (no-op for solo repos). Best-effort; the rail owns durability.
    crate::cmd_tasks_sync::publish_upsert(&repo_root, &task);

    // Auto-DM (#auto-notify): the people this task names get a direct
    // message from the creator. Assignees → "Assigned you", anyone else
    // @-mentioned in the body → "Mentioned you". Self is skipped; non-roster
    // handles and agents are filtered inside `notify`; the ledger dedups.
    let item = crate::notify::ItemRef {
        kind: "task".to_string(),
        id: task.id.clone(),
        label: format!("AURA-{} · {}", task.sequence_id, task.title),
        deeplink: format!("aura://task/{}", task.id),
    };
    let assignees: Vec<String> = task
        .assignee_ids
        .iter()
        .filter(|h| **h != actor_handle)
        .cloned()
        .collect();
    if !assignees.is_empty() {
        crate::notify::notify(
            &repo_root,
            &actor_handle,
            &actor_name,
            &assignees,
            &item,
            crate::notify::Reason::Assigned,
        );
    }
    let mentioned: Vec<String> = crate::notify::mentions::extract_mentions(&task.description)
        .into_iter()
        .filter(|h| *h != actor_handle && !task.assignee_ids.contains(h))
        .collect();
    if !mentioned.is_empty() {
        crate::notify::notify(
            &repo_root,
            &actor_handle,
            &actor_name,
            &mentioned,
            &item,
            crate::notify::Reason::Mentioned,
        );
    }
    Ok(task)
}

// ─── QQ.1 — MCP import upsert ──────────────────────────────────────────
//
// Re-running the importer must not duplicate rows. We dedupe on
// `(external_source, external_id)` — the same identity pair MCP-side
// (e.g. `("jira", "ACME-123")`) maps to exactly one Aura task. On a
// match we patch the existing row in-place; otherwise we create a new
// one. The frontend supplies one `UpsertExternalTaskInput` per source
// record so each call is independent and the importer can show
// per-row pass/fail.

#[derive(Deserialize)]
pub struct UpsertExternalTaskInput {
    /// Source slug — "jira", "linear", "github", "sentry", or any
    /// custom MCP server name. Required.
    pub external_source: String,
    /// Source-system stable id (e.g. Jira issue key). Required.
    pub external_id: String,
    /// Optional clickable URL back to the source record.
    #[serde(default)]
    pub external_url: Option<String>,
    /// Required on initial import; on re-import, an empty string is
    /// treated as "leave the existing title alone".
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Free-form priority slug — coerced to the 5-stop ladder on save.
    #[serde(default)]
    pub priority: Option<String>,
    /// Free-form labels — auto-imported into the catalog. Useful for
    /// surfacing Jira components / Linear teams as label chips.
    #[serde(default)]
    pub labels: Vec<String>,
    /// Optional `YYYY-MM-DD` due date.
    #[serde(default)]
    pub due_date: Option<String>,
    /// Optional assignee handles. Importers typically leave this empty
    /// and let the user pick from the team-aware avatar dropdown after
    /// import; we honour it when supplied for headless paths.
    #[serde(default)]
    pub assignee_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct UpsertExternalTaskResult {
    pub task: Task,
    /// True when this call created a brand-new task. False when it
    /// patched an existing one. Lets the frontend tally
    /// "imported N · updated M" without re-querying.
    pub created: bool,
}

#[tauri::command]
pub async fn tasks_upsert_external(
    repo_root: String,
    input: UpsertExternalTaskInput,
) -> Result<UpsertExternalTaskResult, String> {
    if input.external_source.trim().is_empty() {
        return Err("external_source is required".into());
    }
    if input.external_id.trim().is_empty() {
        return Err("external_id is required".into());
    }
    let root = Path::new(&repo_root);
    let file = load(root)?;
    let existing = file.tasks.iter().find(|t| {
        t.external_source.as_deref() == Some(input.external_source.as_str())
            && t.external_id.as_deref() == Some(input.external_id.as_str())
    });
    if let Some(existing) = existing {
        let id = existing.id.clone();
        // Build an UpdateTaskInput that only carries fields the importer
        // actually wants to refresh. We intentionally don't touch
        // `assignee_ids` unless the caller supplied a non-empty list —
        // re-running a JQL shouldn't wipe a hand-picked assignee.
        let patch = UpdateTaskInput {
            id: id.clone(),
            title: if input.title.trim().is_empty() {
                None
            } else {
                Some(input.title.clone())
            },
            description: input.description.clone(),
            status: None,
            state_id: None,
            priority: input.priority.clone(),
            assignee: None,
            assignee_ids: if input.assignee_ids.is_empty() {
                None
            } else {
                Some(input.assignee_ids.clone())
            },
            agent_assignee: None,
            labels: if input.labels.is_empty() {
                None
            } else {
                Some(input.labels.clone())
            },
            label_ids: None,
            due_date: input.due_date.clone(),
            start_date: None,
            estimate: None,
            parent_id: None,
            epic_id: None,
            is_epic: None,
            objective: None,
            dependencies: None,
            bead_id: None,
            sprint: None,
            cycle_id: None,
            module_id: None,
            external_source: Some(input.external_source.clone()),
            external_id: Some(input.external_id.clone()),
            external_url: input.external_url.clone().or(Some(String::new())),
        };
        let updated = tasks_update(repo_root.clone(), patch).await?;
        return Ok(UpsertExternalTaskResult {
            task: updated,
            created: false,
        });
    }
    drop(file);
    // No match — fall through to a fresh create with the external_*
    // pointers carried on the input. Title is required here since
    // there's no existing row to leave alone.
    if input.title.trim().is_empty() {
        return Err("title is required for a new external task".into());
    }
    let create = CreateTaskInput {
        title: input.title.clone(),
        description: input.description.clone().unwrap_or_default(),
        status: None,
        state_id: None,
        priority: input.priority.clone(),
        assignee: None,
        assignee_ids: input.assignee_ids.clone(),
        agent_assignee: None,
        reporter: None,
        labels: input.labels.clone(),
        label_ids: Vec::new(),
        linked_pr: None,
        linked_message_id: None,
        due_date: input.due_date.clone(),
        start_date: None,
        estimate: None,
        parent_id: None,
        epic_id: None,
        is_epic: false,
        objective: None,
        dependencies: Vec::new(),
        bead_id: None,
        sprint: None,
        cycle_id: None,
        module_id: None,
        external_source: Some(input.external_source.clone()),
        external_id: Some(input.external_id.clone()),
        external_url: input.external_url.clone(),
    };
    let task = tasks_create(repo_root, create).await?;
    Ok(UpsertExternalTaskResult {
        task,
        created: true,
    })
}

#[tauri::command]
pub async fn tasks_update(repo_root: String, input: UpdateTaskInput) -> Result<Task, String> {
    let root = Path::new(&repo_root);
    let mut file = load(root)?;
    // Resolve catalog state up front so the inner mut-borrow doesn't
    // collide with state/label lookups. Both catalogs are seeded on
    // first read.
    let state_file = load_or_seed_states(root)?;
    let mut label_file = load_task_labels(root)?;

    // OO.5 — capture the pre-mutation snapshot so we can diff against
    // the post-mutation row and emit activity events for each
    // dimension that actually changed. Cloning here costs one alloc
    // per write — cheap relative to the JSON round trip and far
    // simpler than threading a "what changed" flag through every
    // branch below.
    let before = file
        .tasks
        .iter()
        .find(|t| t.id == input.id)
        .cloned()
        .ok_or_else(|| format!("task not found: {}", input.id))?;
    let t = file
        .tasks
        .iter_mut()
        .find(|t| t.id == input.id)
        .ok_or_else(|| format!("task not found: {}", input.id))?;
    if let Some(v) = input.title {
        t.title = v;
    }
    if let Some(v) = input.description {
        t.description = v;
    }
    // ── state ────────────────────────────────────────────────────────
    // OO.3 precedence: explicit `state_id` > explicit `status` legacy
    // writer. When state_id is set we mirror status from the catalog
    // entry's group so older readers see a sensible label. When only
    // `status` is supplied we map it through `legacy_status_to_state_id`
    // so the canonical pointer stays in sync.
    if let Some(sid) = input.state_id {
        if !sid.is_empty() {
            t.state_id = sid.clone();
            if let Some(state) = state_file.states.iter().find(|s| s.id == sid) {
                t.status = state_to_legacy_status(state).to_string();
            }
        }
    } else if let Some(s) = input.status {
        t.status = s.clone();
        t.state_id = legacy_status_to_state_id(&s).to_string();
    }
    if let Some(v) = input.priority {
        t.priority = normalize_priority(&v);
    }
    // ── assignees ────────────────────────────────────────────────────
    // OO.3 precedence: explicit `assignee_ids` > legacy `assignee`.
    // Mirror the singular field from the first entry.
    if let Some(ids) = input.assignee_ids {
        let cleaned: Vec<String> = ids
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .fold(Vec::new(), |mut acc, s| {
                if !acc.contains(&s) {
                    acc.push(s);
                }
                acc
            });
        t.assignee = cleaned.first().cloned();
        t.assignee_ids = cleaned;
    } else if let Some(v) = input.assignee {
        let trimmed = v.trim().to_string();
        if trimmed.is_empty() {
            t.assignee = None;
            t.assignee_ids.clear();
        } else {
            t.assignee = Some(trimmed.clone());
            t.assignee_ids = vec![trimmed];
        }
    }
    if let Some(v) = input.agent_assignee {
        t.agent_assignee = Some(v);
    }
    // ── labels ───────────────────────────────────────────────────────
    // OO.3 precedence: explicit `label_ids` > legacy `labels` strings.
    // When `labels` strings are supplied we auto-import them so the
    // catalog stays a strict superset of the surfaced chips.
    let mut labels_dirty = false;
    if let Some(ids) = input.label_ids {
        let cleaned: Vec<String> = ids
            .into_iter()
            .filter(|id| label_file.labels.iter().any(|l| &l.id == id))
            .fold(Vec::new(), |mut acc, id| {
                if !acc.contains(&id) {
                    acc.push(id);
                }
                acc
            });
        t.label_ids = cleaned;
        t.labels = t
            .label_ids
            .iter()
            .filter_map(|id| label_file.labels.iter().find(|l| &l.id == id).map(|l| l.name.clone()))
            .collect();
    } else if let Some(strs) = input.labels {
        let mut next_ids: Vec<String> = Vec::new();
        for raw in &strs {
            if let Some(id) = ensure_label(&mut label_file, raw) {
                if !next_ids.contains(&id) {
                    next_ids.push(id);
                    labels_dirty = true;
                }
            }
        }
        t.label_ids = next_ids;
        t.labels = t
            .label_ids
            .iter()
            .filter_map(|id| label_file.labels.iter().find(|l| &l.id == id).map(|l| l.name.clone()))
            .collect();
    }
    if let Some(v) = input.due_date {
        t.due_date = Some(v);
    }
    if let Some(v) = input.start_date {
        t.start_date = Some(v);
    }
    if let Some(v) = input.estimate {
        t.estimate = Some(v);
    }
    // parent_id is the canonical field; epic_id stays in sync so the
    // legacy wire shape keeps working. If both are sent, parent_id wins.
    if let Some(v) = input.parent_id {
        t.parent_id = Some(v.clone());
        t.epic_id = Some(v);
    } else if let Some(v) = input.epic_id {
        t.parent_id = Some(v.clone());
        t.epic_id = Some(v);
    }
    if let Some(v) = input.is_epic {
        t.is_epic = v;
    }
    if let Some(v) = input.objective {
        t.objective = Some(v);
    }
    if let Some(v) = input.dependencies {
        t.dependencies = v;
    }
    if let Some(v) = input.bead_id {
        t.bead_id = Some(v);
    }
    if let Some(v) = input.sprint {
        t.sprint = Some(v);
    }
    // OO.4 — Cycle / Module pointers. An empty string clears; any
    // other value is taken as-is. Catalog-side mirror is deferred to
    // the dedicated `tasks_cycle_assign` / `tasks_module_assign`
    // commands; the heal pass keeps things consistent on next list.
    if let Some(v) = input.cycle_id {
        t.cycle_id = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = input.module_id {
        t.module_id = if v.is_empty() { None } else { Some(v) };
    }
    // QQ.1 — External-system pointers. Empty string clears each field
    // (mirrors the cycle/module convention) so the importer can null a
    // pointer without a dedicated unset command.
    if let Some(v) = input.external_source {
        t.external_source = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = input.external_id {
        t.external_id = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = input.external_url {
        t.external_url = if v.is_empty() { None } else { Some(v) };
    }
    t.updated_at = now_iso();
    let updated = t.clone();
    save(root, &file)?;
    if labels_dirty {
        save_task_labels(root, &label_file)?;
    }
    // OO.5 — emit one activity row per dimension that changed. Swallow
    // emit failures (a broken jsonl writer must not block the update
    // itself). We intentionally compare on the canonical fields (not
    // the legacy mirrors) so a no-op write doesn't trigger spurious
    // "state_changed" rows when the caller only flipped status while
    // state_id stayed the same.
    emit_update_activity(root, &before, &updated);
    // #218 — broadcast the mutation to teammates over the live rail.
    crate::cmd_tasks_sync::publish_upsert(&repo_root, &updated);

    // Auto-DM (#auto-notify): only the people this edit NEWLY names are
    // pinged — diff before↔after so re-saves don't re-DM. Newly-added
    // assignees → "Assigned you"; handles newly @-mentioned in the body →
    // "Mentioned you". Self skipped; non-roster/agents filtered in `notify`.
    let (actor_handle, actor_name) = crate::cmd_team::local_actor(&repo_root);
    let item = crate::notify::ItemRef {
        kind: "task".to_string(),
        id: updated.id.clone(),
        label: format!("AURA-{} · {}", updated.sequence_id, updated.title),
        deeplink: format!("aura://task/{}", updated.id),
    };
    let new_assignees: Vec<String> = updated
        .assignee_ids
        .iter()
        .filter(|h| !before.assignee_ids.contains(h) && **h != actor_handle)
        .cloned()
        .collect();
    if !new_assignees.is_empty() {
        crate::notify::notify(
            &repo_root,
            &actor_handle,
            &actor_name,
            &new_assignees,
            &item,
            crate::notify::Reason::Assigned,
        );
    }
    let prev_mentions = crate::notify::mentions::extract_mentions(&before.description);
    let new_mentions: Vec<String> = crate::notify::mentions::extract_mentions(&updated.description)
        .into_iter()
        .filter(|h| {
            !prev_mentions.contains(h)
                && *h != actor_handle
                && !updated.assignee_ids.contains(h)
        })
        .collect();
    if !new_mentions.is_empty() {
        crate::notify::notify(
            &repo_root,
            &actor_handle,
            &actor_name,
            &new_mentions,
            &item,
            crate::notify::Reason::Mentioned,
        );
    }
    Ok(updated)
}

/// Walk the diff between two `Task` snapshots and emit one activity
/// row per dimension that changed. Public so the bulk + future
/// programmatic mutation paths can reuse the same diff logic. Activity
/// emission swallows errors — the caller is expected to have already
/// persisted the canonical mutation.
pub fn emit_update_activity(repo_root: &Path, before: &Task, after: &Task) {
    if before.state_id != after.state_id {
        let _ = crate::cmd_tasks_activity::append_activity(
            repo_root,
            &after.id,
            "state_changed",
            "system",
            serde_json::json!({
                "from": before.state_id,
                "to": after.state_id,
            }),
        );
    }
    if before.assignee_ids != after.assignee_ids {
        let added: Vec<String> = after
            .assignee_ids
            .iter()
            .filter(|h| !before.assignee_ids.contains(h))
            .cloned()
            .collect();
        let removed: Vec<String> = before
            .assignee_ids
            .iter()
            .filter(|h| !after.assignee_ids.contains(h))
            .cloned()
            .collect();
        if !added.is_empty() {
            let _ = crate::cmd_tasks_activity::append_activity(
                repo_root,
                &after.id,
                "assigned",
                "system",
                serde_json::json!({ "added": added }),
            );
        }
        if !removed.is_empty() {
            let _ = crate::cmd_tasks_activity::append_activity(
                repo_root,
                &after.id,
                "unassigned",
                "system",
                serde_json::json!({ "removed": removed }),
            );
        }
    }
    if before.label_ids != after.label_ids {
        let added: Vec<String> = after
            .label_ids
            .iter()
            .filter(|l| !before.label_ids.contains(l))
            .cloned()
            .collect();
        let removed: Vec<String> = before
            .label_ids
            .iter()
            .filter(|l| !after.label_ids.contains(l))
            .cloned()
            .collect();
        if !added.is_empty() {
            let _ = crate::cmd_tasks_activity::append_activity(
                repo_root,
                &after.id,
                "labeled",
                "system",
                serde_json::json!({ "added": added }),
            );
        }
        if !removed.is_empty() {
            let _ = crate::cmd_tasks_activity::append_activity(
                repo_root,
                &after.id,
                "unlabeled",
                "system",
                serde_json::json!({ "removed": removed }),
            );
        }
    }
    // Catch-all "updated" event when something else moved (title,
    // description, priority, due/start/estimate, etc.) so the timeline
    // never goes silent on a real edit.
    let other_changed = before.title != after.title
        || before.description != after.description
        || before.priority != after.priority
        || before.due_date != after.due_date
        || before.start_date != after.start_date
        || before.estimate != after.estimate
        || before.parent_id != after.parent_id
        || before.objective != after.objective
        || before.dependencies != after.dependencies
        || before.cycle_id != after.cycle_id
        || before.module_id != after.module_id
        || before.sprint != after.sprint
        || before.archived_at != after.archived_at;
    if other_changed {
        let _ = crate::cmd_tasks_activity::append_activity(
            repo_root,
            &after.id,
            "updated",
            "system",
            serde_json::json!({}),
        );
    }
}

/// Stamp `archived_at` on the supplied task. Used by the bulk-archive
/// command — and convenient for the future "archive single task" UI
/// path. Idempotent: archiving an already-archived row bumps the
/// timestamp so the bulk-op result counts it as `affected` (callers
/// that want strict "wasn't archived before" semantics should check
/// the prior value themselves).
pub fn archive_task(repo_root: &Path, id: &str) -> Result<(), String> {
    let mut file = load(repo_root)?;
    let now = now_iso();
    let mut found = false;
    for t in file.tasks.iter_mut() {
        if t.id == id {
            t.archived_at = Some(now.clone());
            t.updated_at = now.clone();
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!("task not found: {}", id));
    }
    save(repo_root, &file)?;
    Ok(())
}

/// Walk every descendant of `root_id` depth-first. The root task is
/// included as the first entry so the caller can render a single tree
/// without joining two collections. Returns Ok with an empty vec
/// when the root doesn't exist so the frontend can render a friendly
/// "no children" state without an extra round trip.
#[tauri::command]
pub async fn tasks_subtree(repo_root: String, root_id: String) -> Result<Vec<Task>, String> {
    let root = Path::new(&repo_root);
    let file = load(root)?;
    let by_id: std::collections::HashMap<String, Task> =
        file.tasks.iter().map(|t| (t.id.clone(), t.clone())).collect();
    let root_task = match by_id.get(&root_id) {
        Some(t) => t.clone(),
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    out.push(root_task);
    // Build a child-lookup map once so the walk is O(total tasks)
    // rather than O(N^2) on big trees.
    let mut children: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for t in file.tasks.iter() {
        if let Some(pid) = t.parent_id.as_ref() {
            children.entry(pid.clone()).or_default().push(t.id.clone());
        }
    }
    let mut stack: Vec<String> = children.get(&root_id).cloned().unwrap_or_default();
    // Reverse so the first child the user inserted lands at the top of
    // the rendered list (DFS without reversing would surface the last
    // child first).
    stack.reverse();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    visited.insert(root_id);
    while let Some(id) = stack.pop() {
        // Cycle guard — parent_id cycles are pathological but we
        // refuse to loop forever if a hand-edited file creates one.
        if !visited.insert(id.clone()) {
            continue;
        }
        if let Some(task) = by_id.get(&id) {
            out.push(task.clone());
        }
        if let Some(kids) = children.get(&id) {
            let mut kids = kids.clone();
            kids.reverse();
            stack.extend(kids);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn tasks_delete(repo_root: String, id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = load(root)?;
    let before = file.tasks.len();
    file.tasks.retain(|t| t.id != id);
    if file.tasks.len() == before {
        return Err(format!("task not found: {}", id));
    }
    save(root, &file)?;
    // OO.5 — drop dependent rows so deleted ids never leave dangling
    // references behind. Each helper swallows missing-file errors so
    // the delete still succeeds for a fresh repo.
    let _ = crate::cmd_tasks_relations::detach_relations_for(root, &id);
    let _ = crate::cmd_tasks_comments::detach_comments_for(root, &id);
    // Activity log is intentionally NOT wiped here — the bulk-delete
    // path appends a final "updated/deleted: true" row before this
    // runs, and the singular delete leaves the audit trail intact so
    // historical "what happened to AURA-37?" queries still answer.
    // #218 — broadcast the deletion to teammates over the live rail.
    crate::cmd_tasks_sync::publish_delete(&repo_root, &id);
    Ok(())
}

// ─── Sprints (legacy shim over Cycles) ──────────────────────────────────
//
// BEAD-I unified the two iteration primitives onto Plane's `Cycle`
// (`.aura/tasks/task_cycles.json`, `Task::cycle_id`). "Sprint" is now a
// pure label over that store, NOT a separate registry. These commands
// stay so the existing TasksBoard "Sprint" view + CreateSprintWizard
// keep working unchanged — each one translates to/from a `Cycle` under
// the hood (`Sprint.active` ⇄ `Cycle.status == "active"`).
//
// The old `.aura/tasks/sprints.json` registry is migrated into the
// Cycle store once (see `migrate_sprints_to_cycles`, run from
// `tasks_list`) and then left on disk as a tombstone. The `Sprint`
// struct + `load_sprints`/`save_sprints` below survive only to read
// that tombstone during migration and to shape the shim's I/O.

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sprint {
    /// Stable slug ("w20-2026", "sprint-7") — also the value stored on
    /// `Task::sprint`. Edits to the slug rewrite all task references.
    pub id: String,
    /// Human-facing label ("Sprint 7", "May Week 1").
    pub name: String,
    /// YYYY-MM-DD inclusive.
    pub start: String,
    /// YYYY-MM-DD inclusive.
    pub end: String,
    /// Free-text "what are we trying to land?" — shown in burndown header.
    #[serde(default)]
    pub goal: String,
    /// Only one sprint is `active` at a time; the Sprint view defaults
    /// to it. Marking another sprint active demotes the previous one
    /// inside `sprints_set_active`.
    #[serde(default)]
    pub active: bool,
    /// BEAD-I phase 4 — frozen throughput captured at Close, projected
    /// from the unified `Cycle::velocity`. `None` until the sprint is
    /// completed; the Sprint view reads it for the velocity trend.
    #[serde(default)]
    pub velocity: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct SprintFile {
    /// BEAD-I tombstone. Set once `migrate_sprints_to_cycles` has folded
    /// this registry into the unified Cycle store; thereafter the file
    /// is dead data kept for history and the migration short-circuits.
    #[serde(default)]
    migrated: bool,
    #[serde(default)]
    sprints: Vec<Sprint>,
}

fn sprints_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("sprints.json")
}

fn load_sprints(repo_root: &Path) -> Result<SprintFile, String> {
    let p = sprints_path(repo_root);
    if !p.exists() {
        return Ok(SprintFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_sprints(repo_root: &Path, file: &SprintFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&sprints_path(repo_root), file)
}

#[derive(Deserialize)]
pub struct SprintInput {
    pub id: String,
    pub name: String,
    pub start: String,
    pub end: String,
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub active: bool,
}

/// Project a unified `Cycle` back into the legacy `Sprint` shape the
/// TasksBoard "Sprint" view + CreateSprintWizard still speak.
fn cycle_to_sprint(c: &crate::cmd_tasks_cycles::Cycle) -> Sprint {
    Sprint {
        id: c.id.clone(),
        name: c.name.clone(),
        start: c.start_date.clone(),
        end: c.end_date.clone(),
        goal: c.goal.clone(),
        active: c.status == "active",
        velocity: c.velocity,
        created_at: c.created_at.clone(),
        updated_at: c.updated_at.clone(),
    }
}

/// Shared create/update body: a `Sprint` upsert is a `Cycle` upsert with
/// `active ⇄ status`. `active == false` maps to `planned` (the shim
/// can't tell "not started" from "done"; only the deliberate Close flow
/// sets `completed`). The single-active invariant lives in
/// `upsert_cycle_inner`.
fn sprint_upsert_shim(repo_root: &str, input: SprintInput) -> Result<Sprint, String> {
    let root = Path::new(repo_root);
    let status = if input.active { "active" } else { "planned" }.to_string();
    let cycle = crate::cmd_tasks_cycles::upsert_cycle_inner(
        root,
        crate::cmd_tasks_cycles::CycleInput {
            id: input.id,
            name: input.name,
            start_date: input.start,
            end_date: input.end,
            goal: input.goal,
            status,
        },
    )?;
    Ok(cycle_to_sprint(&cycle))
}

#[tauri::command]
pub async fn sprints_list(repo_root: String) -> Result<Vec<Sprint>, String> {
    let cycles = crate::cmd_tasks_cycles::list_cycles(Path::new(&repo_root))?;
    Ok(cycles.iter().map(cycle_to_sprint).collect())
}

#[tauri::command]
pub async fn sprints_create(repo_root: String, input: SprintInput) -> Result<Sprint, String> {
    sprint_upsert_shim(&repo_root, input)
}

#[tauri::command]
pub async fn sprints_update(repo_root: String, input: SprintInput) -> Result<Sprint, String> {
    sprint_upsert_shim(&repo_root, input)
}

#[tauri::command]
pub async fn sprints_delete(repo_root: String, id: String) -> Result<(), String> {
    // Detach happens inside `delete_cycle_inner` (clears `Task::cycle_id`
    // on every member). Legacy `Task::sprint` slugs were already cleared
    // by the one-time migration, so there's nothing extra to sweep.
    crate::cmd_tasks_cycles::delete_cycle_inner(Path::new(&repo_root), &id)
}

/// One-time migration (BEAD-I): fold the legacy `sprints.json` registry
/// + every per-task `Task::sprint` slug into the unified Cycle store,
/// then tombstone the registry. Idempotent via `SprintFile::migrated`.
///
/// Ordering matters: the caller runs this from `tasks_list` AFTER the
/// cycle file is first-touched but BEFORE it snapshots `known_cycle_ids`
/// for the dangling-pointer heal, so freshly-folded cycles aren't seen
/// as orphans and cleared.
///
/// Returns `true` when any task's pointers changed so the caller
/// persists `tasks.json`.
fn migrate_sprints_to_cycles(repo_root: &Path, file: &mut TaskFile) -> Result<bool, String> {
    let mut sf = load_sprints(repo_root)?;
    if sf.migrated || sf.sprints.is_empty() {
        return Ok(false);
    }
    // 1. Project each legacy sprint into a Cycle (create-if-missing).
    //    Single-active across the WHOLE store: if a cycle is already
    //    active (or an earlier sprint claimed it), later actives fold in
    //    as `planned` rather than fighting over the slot.
    let mut seen_active = crate::cmd_tasks_cycles::list_cycles(repo_root)?
        .iter()
        .any(|c| c.status == "active");
    for s in &sf.sprints {
        let status = if s.active && !seen_active {
            seen_active = true;
            "active"
        } else {
            "planned"
        };
        crate::cmd_tasks_cycles::migrate_create_cycle_if_absent(
            repo_root, &s.id, &s.name, &s.start, &s.end, &s.goal, status,
        )?;
    }
    // 2. Rewrite each task's `sprint` slug → `cycle_id` (cycle pointer
    //    wins if both were set), mirror membership, then clear `sprint`.
    let now = now_iso();
    let mut mutated = false;
    for t in file.tasks.iter_mut() {
        if let Some(slug) = t.sprint.take() {
            if t.cycle_id.is_none() && !slug.is_empty() {
                t.cycle_id = Some(slug.clone());
                let _ = crate::cmd_tasks_cycles::mirror_assign_task(repo_root, &slug, &t.id);
            }
            t.updated_at = now.clone();
            mutated = true;
        }
    }
    // 3. Tombstone the registry: keep the data, stop migrating, stop
    //    treating it as the live store.
    sf.migrated = true;
    save_sprints(repo_root, &sf)?;
    Ok(mutated)
}

// ─── Bead minting ──────────────────────────────────────────────────────
//
// `bead` is the planned name for A2A atomic-proof units (R.1 in
// docs/plan/12-v0.2.12-pr-chat-admin.md). The store does not yet exist
// in `aura-engine` or `aura-cli`; until it does, this command returns
// a real error so the UI surfaces a clear "not yet implemented" state
// rather than silently faking a mint. See PHASE 2 of #260 R.1.

#[derive(Deserialize)]
pub struct MintBeadInput {
    pub task_id: String,
    /// Optional human content snapshot (description + outcome notes) to
    /// embed in the bead payload once the substrate lands.
    #[serde(default)]
    pub content: String,
}

#[tauri::command]
pub async fn tasks_mint_bead(
    _repo_root: String,
    input: MintBeadInput,
) -> Result<String, String> {
    Err(format!(
        "tasks_mint_bead: A2A bead store not yet implemented. Task {} cannot be \
         minted until aura-engine ships the bead substrate (see plan/12-v0.2.12 #260 R.1 \
         Phase 2). Content snapshot was {} bytes.",
        input.task_id,
        input.content.len(),
    ))
}

// ─── Saved views ───────────────────────────────────────────────────────
//
// OO.2 Phase 2 — Plane-parity Saved Views. A view bundles a layout
// (board/list/spreadsheet/...), filter set (state/priority/assignee/
// labels), grouping, ordering, and the set of display properties shown
// on cards into one named slice the user can switch to in one click.
//
// Persisted to `<repo>/.aura/tasks/views.json` so views travel with the
// repo (committed by the user if they want the team to share them) —
// localStorage only holds the *active* view selection, which is per-
// machine.
//
// Schema is intentionally permissive: `filters` is a free-form JSON
// object so we can add new filter dimensions later (cycle, module,
// estimate range) without bumping the wire format. The frontend
// enforces the runtime shape; the backend just persists.

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskView {
    /// Stable slug — kebab-case, generated client-side from the name.
    /// Used as the localStorage key for "active view" and as the
    /// stable id in routing.
    pub id: String,
    /// Human label ("My open", "P0 incidents", "This sprint").
    pub name: String,
    /// Layout the view renders in. Mirrors the `ViewMode` union on the
    /// frontend: `board` | `list` | `spreadsheet` | `epics` | `sprint`
    /// | `gantt`. Stored as free-form so new layouts don't require a
    /// schema bump.
    pub layout: String,
    /// Filter object: `{ status: ["backlog"], priority: ["high"],
    /// assignee: ["@me", "owner"], labels: ["bug"], agent: ["claude"] }`.
    /// Empty arrays / missing keys mean "no filter on that dimension".
    #[serde(default)]
    pub filters: serde_json::Value,
    /// Grouping dimension: `"none" | "status" | "priority" | "assignee"
    /// | "label"`. Spreadsheet view ignores groupBy; board view's
    /// columns ARE the group.
    #[serde(default = "default_group_by")]
    pub group_by: String,
    /// Sort key: `"created" | "updated" | "priority" | "due" |
    /// "estimate" | "title"`. Direction is `order_dir`.
    #[serde(default = "default_order_by")]
    pub order_by: String,
    /// "asc" | "desc". Stored separately so the dropdown UI is two
    /// independent controls.
    #[serde(default = "default_order_dir")]
    pub order_dir: String,
    /// Which fields render on the card (board/list) or as columns
    /// (spreadsheet). Mirrors Plane's "Display Properties" check
    /// list — `id`, `assignee`, `priority`, `due`, `start`, `labels`,
    /// `estimate`, `agent`, `pr`. Missing means "use the default set"
    /// which the frontend defines.
    #[serde(default)]
    pub display_props: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn default_group_by() -> String {
    "status".into()
}
fn default_order_by() -> String {
    "updated".into()
}
fn default_order_dir() -> String {
    "desc".into()
}

#[derive(Default, Serialize, Deserialize)]
struct ViewFile {
    #[serde(default)]
    views: Vec<TaskView>,
}

fn views_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("views.json")
}

fn load_views(repo_root: &Path) -> Result<ViewFile, String> {
    let p = views_path(repo_root);
    if !p.exists() {
        return Ok(ViewFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_views(repo_root: &Path, file: &ViewFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&views_path(repo_root), file)
}

#[derive(Deserialize)]
pub struct UpsertViewInput {
    pub id: String,
    pub name: String,
    pub layout: String,
    #[serde(default)]
    pub filters: serde_json::Value,
    #[serde(default = "default_group_by")]
    pub group_by: String,
    #[serde(default = "default_order_by")]
    pub order_by: String,
    #[serde(default = "default_order_dir")]
    pub order_dir: String,
    #[serde(default)]
    pub display_props: Vec<String>,
}

#[tauri::command]
pub async fn task_views_list(repo_root: String) -> Result<Vec<TaskView>, String> {
    Ok(load_views(Path::new(&repo_root))?.views)
}

/// Create-or-replace. Idempotent on `id` so the frontend can `save`
/// the active view repeatedly without spawning duplicates.
#[tauri::command]
pub async fn task_views_upsert(
    repo_root: String,
    input: UpsertViewInput,
) -> Result<TaskView, String> {
    let root = Path::new(&repo_root);
    let mut file = load_views(root)?;
    let now = now_iso();
    let trimmed_id = input.id.trim().to_string();
    if trimmed_id.is_empty() {
        return Err("view id is required".into());
    }
    let mut updated: Option<TaskView> = None;
    for v in file.views.iter_mut() {
        if v.id == trimmed_id {
            v.name = input.name.clone();
            v.layout = input.layout.clone();
            v.filters = input.filters.clone();
            v.group_by = input.group_by.clone();
            v.order_by = input.order_by.clone();
            v.order_dir = input.order_dir.clone();
            v.display_props = input.display_props.clone();
            v.updated_at = now.clone();
            updated = Some(v.clone());
            break;
        }
    }
    if updated.is_none() {
        let view = TaskView {
            id: trimmed_id,
            name: input.name,
            layout: input.layout,
            filters: input.filters,
            group_by: input.group_by,
            order_by: input.order_by,
            order_dir: input.order_dir,
            display_props: input.display_props,
            created_at: now.clone(),
            updated_at: now,
        };
        file.views.push(view.clone());
        updated = Some(view);
    }
    save_views(root, &file)?;
    updated.ok_or_else(|| "view vanished".into())
}

#[tauri::command]
pub async fn task_views_delete(repo_root: String, id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = load_views(root)?;
    let before = file.views.len();
    file.views.retain(|v| v.id != id);
    if file.views.len() == before {
        return Err(format!("view not found: {}", id));
    }
    save_views(root, &file)?;
    Ok(())
}

#[derive(Deserialize)]
pub struct RenameViewInput {
    pub id: String,
    pub name: String,
}

#[tauri::command]
pub async fn task_views_rename(
    repo_root: String,
    input: RenameViewInput,
) -> Result<TaskView, String> {
    let root = Path::new(&repo_root);
    let mut file = load_views(root)?;
    let now = now_iso();
    let mut updated: Option<TaskView> = None;
    for v in file.views.iter_mut() {
        if v.id == input.id {
            v.name = input.name.clone();
            v.updated_at = now.clone();
            updated = Some(v.clone());
            break;
        }
    }
    save_views(root, &file)?;
    updated.ok_or_else(|| format!("view not found: {}", input.id))
}

// ─── OO.3 State catalog CRUD ───────────────────────────────────────────
//
// Per-repo state set surfaced to the frontend so the kanban can render
// its columns from data instead of a hard-coded list. The default
// states are seeded on first read; users can add custom states, edit
// existing ones (rename / recolor / reposition), or delete non-default
// states. Default states keep `is_default: true` so the UI can hide
// destructive affordances on them.

#[derive(Deserialize)]
pub struct UpsertTaskStateInput {
    pub id: String,
    pub name: String,
    /// One of `backlog | unstarted | started | completed | cancelled`.
    /// Drives ordering + legacy status mirroring for custom states.
    pub group: String,
    pub color: String,
    #[serde(default)]
    pub position: i32,
}

#[tauri::command]
pub async fn task_states_list(repo_root: String) -> Result<Vec<TaskState>, String> {
    let root = Path::new(&repo_root);
    let mut file = load_or_seed_states(root)?;
    file.states.sort_by_key(|s| s.position);
    Ok(file.states)
}

/// Create-or-replace a custom state. Defaults are not protected from
/// edits (so users can rename "Backlog" → "Triage" if they want) but
/// the `is_default` flag is preserved on update so the UI still hides
/// the delete button for them.
#[tauri::command]
pub async fn task_states_upsert(
    repo_root: String,
    input: UpsertTaskStateInput,
) -> Result<TaskState, String> {
    let root = Path::new(&repo_root);
    let mut file = load_or_seed_states(root)?;
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err("state id is required".into());
    }
    let valid_groups = ["backlog", "unstarted", "started", "completed", "cancelled"];
    if !valid_groups.contains(&input.group.as_str()) {
        return Err(format!(
            "invalid state group {:?} — must be one of {:?}",
            input.group, valid_groups
        ));
    }
    let now = now_iso();
    let mut updated: Option<TaskState> = None;
    for s in file.states.iter_mut() {
        if s.id == id {
            s.name = input.name.clone();
            s.group = input.group.clone();
            s.color = input.color.clone();
            s.position = input.position;
            s.updated_at = now.clone();
            updated = Some(s.clone());
            break;
        }
    }
    if updated.is_none() {
        let state = TaskState {
            id,
            name: input.name,
            group: input.group,
            color: input.color,
            position: input.position,
            is_default: false,
            created_at: now.clone(),
            updated_at: now,
        };
        file.states.push(state.clone());
        updated = Some(state);
    }
    file.states.sort_by_key(|s| s.position);
    save_task_states(root, &file)?;
    updated.ok_or_else(|| "state vanished".into())
}

/// Delete a custom state. Default states are protected — attempting to
/// delete one returns an error rather than silently no-oping so the
/// caller gets explicit feedback. Tasks pointing at the deleted state
/// are migrated to the closest sibling in the same `group`, falling
/// back to `unstarted` so no task ever ends up orphaned.
#[tauri::command]
pub async fn task_states_delete(repo_root: String, id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = load_or_seed_states(root)?;
    let target = file
        .states
        .iter()
        .find(|s| s.id == id)
        .cloned()
        .ok_or_else(|| format!("state not found: {}", id))?;
    if target.is_default {
        return Err(format!(
            "cannot delete default state {:?} — defaults are protected",
            id
        ));
    }
    file.states.retain(|s| s.id != id);
    // Pick a fallback: same group if any survives, otherwise `unstarted`.
    let fallback_id = file
        .states
        .iter()
        .find(|s| s.group == target.group)
        .map(|s| s.id.clone())
        .unwrap_or_else(|| "unstarted".into());
    save_task_states(root, &file)?;
    // Migrate any tasks that were on the deleted state.
    let mut tf = load(root)?;
    let now = now_iso();
    let mut mutated = false;
    for t in tf.tasks.iter_mut() {
        if t.state_id == id {
            t.state_id = fallback_id.clone();
            if let Some(fallback) = file.states.iter().find(|s| s.id == fallback_id) {
                t.status = state_to_legacy_status(fallback).to_string();
            }
            t.updated_at = now.clone();
            mutated = true;
        }
    }
    if mutated {
        save(root, &tf)?;
    }
    Ok(())
}

// ─── OO.3 Label catalog CRUD ───────────────────────────────────────────
//
// Per-repo label registry surfaced to the frontend so the label picker
// can render a real catalog rather than scraping strings out of tasks.
// Auto-imports from legacy string labels happen lazily inside
// `tasks_list` (`backfill_ontology`) — these commands let the user
// edit + create + delete labels explicitly.

#[derive(Deserialize)]
pub struct UpsertTaskLabelInput {
    /// Optional slug — when omitted, derived from `name`. Passing an
    /// existing id updates the entry in place; passing a new id (or
    /// none) creates a fresh row.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    /// CSS color string. When empty, a palette pick is derived from the
    /// label name so the user always lands on a sensible default.
    #[serde(default)]
    pub color: String,
}

#[tauri::command]
pub async fn task_labels_list(repo_root: String) -> Result<Vec<TaskLabel>, String> {
    Ok(load_task_labels(Path::new(&repo_root))?.labels)
}

#[tauri::command]
pub async fn task_labels_upsert(
    repo_root: String,
    input: UpsertTaskLabelInput,
) -> Result<TaskLabel, String> {
    let root = Path::new(&repo_root);
    let mut file = load_task_labels(root)?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("label name is required".into());
    }
    let id = input
        .id
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| slug_label_name(&name));
    if id.is_empty() {
        return Err("derived label id is empty".into());
    }
    let color = if input.color.trim().is_empty() {
        palette_for(&id).to_string()
    } else {
        input.color.trim().to_string()
    };
    let now = now_iso();
    let mut updated: Option<TaskLabel> = None;
    for l in file.labels.iter_mut() {
        if l.id == id {
            l.name = name.clone();
            l.color = color.clone();
            l.updated_at = now.clone();
            updated = Some(l.clone());
            break;
        }
    }
    if updated.is_none() {
        let label = TaskLabel {
            id,
            name,
            color,
            created_at: now.clone(),
            updated_at: now,
        };
        file.labels.push(label.clone());
        updated = Some(label);
    }
    save_task_labels(root, &file)?;
    updated.ok_or_else(|| "label vanished".into())
}

#[tauri::command]
pub async fn task_labels_delete(repo_root: String, id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = load_task_labels(root)?;
    let before = file.labels.len();
    file.labels.retain(|l| l.id != id);
    if file.labels.len() == before {
        return Err(format!("label not found: {}", id));
    }
    save_task_labels(root, &file)?;
    // Detach the deleted label from any task pointing at it so the
    // chip stops rendering. We do NOT rewrite the legacy `labels`
    // array out from under existing readers — the next `tasks_list`
    // will re-mirror it from the now-shorter `label_ids`.
    let mut tf = load(root)?;
    let now = now_iso();
    let mut mutated = false;
    for t in tf.tasks.iter_mut() {
        let before_ids = t.label_ids.len();
        t.label_ids.retain(|x| x != &id);
        if t.label_ids.len() != before_ids {
            // Rebuild legacy mirror from surviving catalog entries.
            t.labels = t
                .label_ids
                .iter()
                .filter_map(|x| file.labels.iter().find(|l| &l.id == x).map(|l| l.name.clone()))
                .collect();
            t.updated_at = now.clone();
            mutated = true;
        }
    }
    if mutated {
        save(root, &tf)?;
    }
    Ok(())
}

// ─── OO.3 migration tests ──────────────────────────────────────────────
//
// These guard the lossless idempotent backfill that powers tasks_list
// on a v0.2.30 store. Each test exercises one heal dimension and
// asserts the round-trip stays stable: read → backfill → write → read
// produces the same shape.

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_states() -> TaskStateFile {
        let mut file = TaskStateFile::default();
        ensure_default_states(&mut file);
        file
    }

    fn fixture_legacy_task(status: &str, priority: &str, assignee: Option<&str>, labels: &[&str]) -> Task {
        Task {
            id: "task_test".into(),
            sequence_id: 1,
            title: "test".into(),
            description: String::new(),
            status: status.into(),
            state_id: String::new(),
            priority: priority.into(),
            assignee: assignee.map(|s| s.into()),
            assignee_ids: Vec::new(),
            agent_assignee: None,
            reporter: None,
            labels: labels.iter().map(|s| s.to_string()).collect(),
            label_ids: Vec::new(),
            linked_pr: None,
            linked_message_id: None,
            due_date: None,
            start_date: None,
            estimate: None,
            parent_id: None,
            epic_id: None,
            is_epic: false,
            objective: None,
            dependencies: Vec::new(),
            bead_id: None,
            sprint: None,
            cycle_id: None,
            module_id: None,
            archived_at: None,
            external_id: None,
            external_source: None,
            external_url: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn legacy_status_maps_to_canonical_state_ids() {
        assert_eq!(legacy_status_to_state_id("backlog"), "backlog");
        assert_eq!(legacy_status_to_state_id("in_progress"), "started");
        assert_eq!(legacy_status_to_state_id("in_review"), "started");
        assert_eq!(legacy_status_to_state_id("done"), "completed");
        assert_eq!(legacy_status_to_state_id("todo"), "unstarted");
        assert_eq!(legacy_status_to_state_id("garbage"), "unstarted");
    }

    #[test]
    fn priority_normalizes_to_five_stop_ladder() {
        assert_eq!(normalize_priority("urgent"), "urgent");
        assert_eq!(normalize_priority("high"), "high");
        assert_eq!(normalize_priority("medium"), "medium");
        assert_eq!(normalize_priority("low"), "low");
        assert_eq!(normalize_priority("none"), "none");
        assert_eq!(normalize_priority(""), "none");
        assert_eq!(normalize_priority("critical"), "none");
        assert_eq!(normalize_priority("HIGH"), "high");
    }

    #[test]
    fn backfill_seeds_state_id_from_legacy_status() {
        let mut file = TaskFile { tasks: vec![fixture_legacy_task("in_progress", "medium", None, &[])] };
        let states = empty_states();
        let mut labels = TaskLabelFile::default();
        backfill_ontology(&mut file, &states, &mut labels);
        assert_eq!(file.tasks[0].state_id, "started");
        // status mirror stays in sync with the state's group
        assert_eq!(file.tasks[0].status, "in_progress");
    }

    #[test]
    fn backfill_wraps_single_assignee_into_array() {
        let mut file = TaskFile { tasks: vec![fixture_legacy_task("backlog", "low", Some("owner"), &[])] };
        let states = empty_states();
        let mut labels = TaskLabelFile::default();
        backfill_ontology(&mut file, &states, &mut labels);
        assert_eq!(file.tasks[0].assignee_ids, vec!["owner".to_string()]);
        assert_eq!(file.tasks[0].assignee.as_deref(), Some("owner"));
    }

    #[test]
    fn backfill_auto_imports_legacy_label_strings() {
        let mut file = TaskFile { tasks: vec![fixture_legacy_task("backlog", "medium", None, &["bug", "Postmortem"])] };
        let states = empty_states();
        let mut labels = TaskLabelFile::default();
        backfill_ontology(&mut file, &states, &mut labels);
        assert_eq!(file.tasks[0].label_ids.len(), 2);
        // catalog has both auto-imported entries
        assert_eq!(labels.labels.len(), 2);
        // legacy labels array is mirrored from canonical catalog names
        assert!(file.tasks[0].labels.contains(&"bug".to_string()));
        assert!(file.tasks[0].labels.contains(&"Postmortem".to_string()));
    }

    #[test]
    fn backfill_is_idempotent() {
        let mut file = TaskFile { tasks: vec![fixture_legacy_task("done", "high", Some("owner"), &["bug"])] };
        let states = empty_states();
        let mut labels = TaskLabelFile::default();
        let (m1, _) = backfill_ontology(&mut file, &states, &mut labels);
        assert!(m1, "first pass should mutate");
        let snapshot = file.tasks[0].clone();
        let (m2, _) = backfill_ontology(&mut file, &states, &mut labels);
        assert!(!m2, "second pass should be a no-op");
        // round-trip stays identical
        assert_eq!(snapshot.state_id, file.tasks[0].state_id);
        assert_eq!(snapshot.label_ids, file.tasks[0].label_ids);
        assert_eq!(snapshot.assignee_ids, file.tasks[0].assignee_ids);
    }

    #[test]
    fn default_state_set_covers_all_five_canonical_ids() {
        let mut file = TaskStateFile::default();
        let mutated = ensure_default_states(&mut file);
        assert!(mutated);
        let ids: Vec<&str> = file.states.iter().map(|s| s.id.as_str()).collect();
        for canonical in ["backlog", "unstarted", "started", "completed", "cancelled"] {
            assert!(ids.contains(&canonical), "missing canonical state: {}", canonical);
        }
    }

    #[test]
    fn ensure_label_dedups_by_slug() {
        let mut file = TaskLabelFile::default();
        let a = ensure_label(&mut file, "Bug").unwrap();
        let b = ensure_label(&mut file, "bug").unwrap();
        assert_eq!(a, b);
        assert_eq!(file.labels.len(), 1);
    }

    #[test]
    fn slug_label_name_collapses_runs() {
        assert_eq!(slug_label_name("Bug"), "bug");
        assert_eq!(slug_label_name("RFC / Design"), "rfc-design");
        assert_eq!(slug_label_name("  spaces  "), "spaces");
        assert_eq!(slug_label_name("---"), "");
    }

    // ── OO.4 — Cycle + Module heal tests ───────────────────────────

    fn tmp_repo(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("aura-oo4-tasks-{}-{}", name, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn backfill_oo4_clears_dangling_cycle_pointer() {
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.cycle_id = Some("ghost-cycle".into());
        let mut file = TaskFile { tasks: vec![t] };
        let mutated = backfill_oo4_pointers(&mut file, &[], &[]);
        assert!(mutated);
        assert!(file.tasks[0].cycle_id.is_none());
    }

    #[test]
    fn backfill_oo4_clears_dangling_module_pointer() {
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.module_id = Some("ghost-module".into());
        let mut file = TaskFile { tasks: vec![t] };
        let mutated = backfill_oo4_pointers(&mut file, &[], &[]);
        assert!(mutated);
        assert!(file.tasks[0].module_id.is_none());
    }

    #[test]
    fn backfill_oo4_keeps_valid_pointers() {
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.cycle_id = Some("c1".into());
        t.module_id = Some("m1".into());
        let mut file = TaskFile { tasks: vec![t] };
        let known_cycles = vec!["c1".to_string()];
        let known_modules = vec!["m1".to_string()];
        let mutated = backfill_oo4_pointers(&mut file, &known_cycles, &known_modules);
        assert!(!mutated, "valid pointers should not be cleared");
        assert_eq!(file.tasks[0].cycle_id.as_deref(), Some("c1"));
        assert_eq!(file.tasks[0].module_id.as_deref(), Some("m1"));
    }

    #[test]
    fn backfill_oo4_is_noop_on_v0_2_31_tasks_without_pointers() {
        // Tasks created in v0.2.31 have no cycle_id/module_id fields —
        // serde defaults them to None, and the heal should not mutate.
        let t = fixture_legacy_task("backlog", "medium", None, &[]);
        let mut file = TaskFile { tasks: vec![t] };
        let mutated = backfill_oo4_pointers(&mut file, &[], &[]);
        assert!(!mutated, "tasks with no OO.4 pointers should heal as no-op");
    }

    #[test]
    fn set_task_cycle_mutates_and_persists() {
        let repo = tmp_repo("setcycle");
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.id = "task_x".into();
        let file = TaskFile { tasks: vec![t] };
        save(&repo, &file).unwrap();
        set_task_cycle(&repo, "task_x", Some("c1")).unwrap();
        let loaded = load(&repo).unwrap();
        assert_eq!(loaded.tasks[0].cycle_id.as_deref(), Some("c1"));
        // clearing
        set_task_cycle(&repo, "task_x", None).unwrap();
        let loaded = load(&repo).unwrap();
        assert!(loaded.tasks[0].cycle_id.is_none());
    }

    #[test]
    fn set_task_module_mutates_and_persists() {
        let repo = tmp_repo("setmodule");
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.id = "task_y".into();
        let file = TaskFile { tasks: vec![t] };
        save(&repo, &file).unwrap();
        set_task_module(&repo, "task_y", Some("m1")).unwrap();
        let loaded = load(&repo).unwrap();
        assert_eq!(loaded.tasks[0].module_id.as_deref(), Some("m1"));
        set_task_module(&repo, "task_y", None).unwrap();
        let loaded = load(&repo).unwrap();
        assert!(loaded.tasks[0].module_id.is_none());
    }

    #[test]
    fn detach_cycle_clears_pointer_on_every_member() {
        let repo = tmp_repo("detachcycle");
        let mut t1 = fixture_legacy_task("backlog", "medium", None, &[]);
        t1.id = "a".into();
        t1.cycle_id = Some("c1".into());
        let mut t2 = fixture_legacy_task("backlog", "low", None, &[]);
        t2.id = "b".into();
        t2.cycle_id = Some("c1".into());
        let mut t3 = fixture_legacy_task("backlog", "low", None, &[]);
        t3.id = "c".into();
        t3.cycle_id = Some("c2".into());
        let file = TaskFile { tasks: vec![t1, t2, t3] };
        save(&repo, &file).unwrap();
        detach_cycle(&repo, "c1").unwrap();
        let loaded = load(&repo).unwrap();
        let map: std::collections::HashMap<String, Option<String>> =
            loaded.tasks.iter().map(|t| (t.id.clone(), t.cycle_id.clone())).collect();
        assert!(map["a"].is_none());
        assert!(map["b"].is_none());
        assert_eq!(map["c"].as_deref(), Some("c2"));
    }

    #[test]
    fn detach_module_clears_pointer_on_every_member() {
        let repo = tmp_repo("detachmodule");
        let mut t1 = fixture_legacy_task("backlog", "medium", None, &[]);
        t1.id = "a".into();
        t1.module_id = Some("m1".into());
        let mut t2 = fixture_legacy_task("backlog", "low", None, &[]);
        t2.id = "b".into();
        t2.module_id = Some("m2".into());
        let file = TaskFile { tasks: vec![t1, t2] };
        save(&repo, &file).unwrap();
        detach_module(&repo, "m1").unwrap();
        let loaded = load(&repo).unwrap();
        assert!(loaded.tasks.iter().find(|t| t.id == "a").unwrap().module_id.is_none());
        assert_eq!(
            loaded.tasks.iter().find(|t| t.id == "b").unwrap().module_id.as_deref(),
            Some("m2")
        );
    }

    // ── OO.5 — sub-issues + activity emission ──────────────────────

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn subtree_walks_parent_id_descendants_depth_first() {
        let repo = tmp_repo("subtree");
        // Tree:
        //   root
        //    ├── a
        //    │    └── a1
        //    └── b
        let mut root = fixture_legacy_task("backlog", "medium", None, &[]);
        root.id = "root".into();
        let mut a = fixture_legacy_task("backlog", "medium", None, &[]);
        a.id = "a".into();
        a.parent_id = Some("root".into());
        let mut a1 = fixture_legacy_task("backlog", "medium", None, &[]);
        a1.id = "a1".into();
        a1.parent_id = Some("a".into());
        let mut b = fixture_legacy_task("backlog", "medium", None, &[]);
        b.id = "b".into();
        b.parent_id = Some("root".into());
        // Sibling outside the tree — must NOT be returned.
        let mut other = fixture_legacy_task("backlog", "medium", None, &[]);
        other.id = "other".into();
        let file = TaskFile { tasks: vec![root, a, a1, b, other] };
        save(&repo, &file).unwrap();
        let walked = rt()
            .block_on(tasks_subtree(repo.to_string_lossy().into_owned(), "root".into()))
            .unwrap();
        let ids: Vec<&str> = walked.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"root"));
        assert!(ids.contains(&"a"));
        assert!(ids.contains(&"a1"));
        assert!(ids.contains(&"b"));
        assert!(!ids.contains(&"other"));
        // First entry is always the root so the caller can render a
        // single tree.
        assert_eq!(ids[0], "root");
    }

    #[test]
    fn subtree_returns_empty_on_missing_root() {
        let repo = tmp_repo("subtreemissing");
        let file = TaskFile { tasks: vec![] };
        save(&repo, &file).unwrap();
        let walked = rt()
            .block_on(tasks_subtree(repo.to_string_lossy().into_owned(), "ghost".into()))
            .unwrap();
        assert!(walked.is_empty());
    }

    #[test]
    fn subtree_tolerates_parent_cycle_without_looping() {
        let repo = tmp_repo("subtreecycle");
        // Pathological hand-edit: a → b → a.
        let mut a = fixture_legacy_task("backlog", "medium", None, &[]);
        a.id = "a".into();
        a.parent_id = Some("b".into());
        let mut b = fixture_legacy_task("backlog", "medium", None, &[]);
        b.id = "b".into();
        b.parent_id = Some("a".into());
        let file = TaskFile { tasks: vec![a, b] };
        save(&repo, &file).unwrap();
        let walked = rt()
            .block_on(tasks_subtree(repo.to_string_lossy().into_owned(), "a".into()))
            .unwrap();
        // Walk must terminate — we don't care about the exact order.
        assert!(walked.len() <= 2);
    }

    #[test]
    fn emit_update_activity_writes_state_changed_row() {
        let repo = tmp_repo("emitstate");
        let mut before = fixture_legacy_task("backlog", "medium", None, &[]);
        before.id = "t1".into();
        before.state_id = "backlog".into();
        let mut after = before.clone();
        after.state_id = "completed".into();
        emit_update_activity(&repo, &before, &after);
        let log_path = repo.join(".aura").join("tasks").join("task_activity.jsonl");
        let txt = std::fs::read_to_string(&log_path).unwrap();
        assert!(txt.contains("state_changed"));
        assert!(txt.contains("backlog"));
        assert!(txt.contains("completed"));
    }

    #[test]
    fn emit_update_activity_splits_assignee_add_and_remove() {
        let repo = tmp_repo("emitassign");
        let mut before = fixture_legacy_task("backlog", "medium", Some("owner"), &[]);
        before.id = "t1".into();
        before.assignee_ids = vec!["owner".into()];
        let mut after = before.clone();
        after.assignee_ids = vec!["teammate".into()];
        after.assignee = Some("teammate".into());
        emit_update_activity(&repo, &before, &after);
        let log_path = repo.join(".aura").join("tasks").join("task_activity.jsonl");
        let txt = std::fs::read_to_string(&log_path).unwrap();
        assert!(txt.contains("assigned"));
        assert!(txt.contains("unassigned"));
        assert!(txt.contains("teammate"));
        assert!(txt.contains("owner"));
    }

    #[test]
    fn archive_task_stamps_timestamp_and_errors_on_missing_id() {
        let repo = tmp_repo("arch");
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.id = "t1".into();
        let file = TaskFile { tasks: vec![t] };
        save(&repo, &file).unwrap();
        archive_task(&repo, "t1").unwrap();
        let loaded = load(&repo).unwrap();
        assert!(loaded.tasks[0].archived_at.is_some());
        let err = archive_task(&repo, "ghost").unwrap_err();
        assert!(err.contains("not found"));
    }

    // ─── #218 live-sync LWW merge (apply_remote_batch) ──────────────────

    fn mk(id: &str, title: &str, updated: &str) -> Task {
        let mut t = fixture_legacy_task("backlog", "medium", None, &[]);
        t.id = id.into();
        t.title = title.into();
        t.created_at = updated.into();
        t.updated_at = updated.into();
        t
    }

    #[test]
    fn sync_insert_when_absent() {
        let repo = tmp_repo("syncins");
        let t = mk("t1", "hello", "2026-02-01T00:00:00Z");
        let (applied, removed) = apply_remote_batch(
            &repo,
            vec![RemoteOp::Upsert(Box::new(t), "2026-02-01T00:00:00Z".into())],
        )
        .unwrap();
        assert_eq!(applied, vec!["t1".to_string()]);
        assert!(removed.is_empty());
        let loaded = load(&repo).unwrap();
        assert_eq!(loaded.tasks.len(), 1);
        assert_eq!(loaded.tasks[0].title, "hello");
    }

    #[test]
    fn sync_lww_skips_older_upsert() {
        let repo = tmp_repo("syncold");
        save(&repo, &TaskFile { tasks: vec![mk("t1", "current", "2026-02-02T00:00:00Z")] }).unwrap();
        let older = mk("t1", "stale", "2026-02-01T00:00:00Z");
        let (applied, _) = apply_remote_batch(
            &repo,
            vec![RemoteOp::Upsert(Box::new(older), "2026-02-01T00:00:00Z".into())],
        )
        .unwrap();
        assert!(applied.is_empty());
        assert_eq!(load(&repo).unwrap().tasks[0].title, "current");
    }

    #[test]
    fn sync_lww_replaces_newer_upsert() {
        let repo = tmp_repo("syncnew");
        save(&repo, &TaskFile { tasks: vec![mk("t1", "old", "2026-02-01T00:00:00Z")] }).unwrap();
        let newer = mk("t1", "fresh", "2026-02-03T00:00:00Z");
        let (applied, _) = apply_remote_batch(
            &repo,
            vec![RemoteOp::Upsert(Box::new(newer), "2026-02-03T00:00:00Z".into())],
        )
        .unwrap();
        assert_eq!(applied, vec!["t1".to_string()]);
        assert_eq!(load(&repo).unwrap().tasks[0].title, "fresh");
    }

    #[test]
    fn sync_delete_removes_present() {
        let repo = tmp_repo("syncdel");
        save(&repo, &TaskFile { tasks: vec![mk("t1", "doomed", "2026-02-01T00:00:00Z")] }).unwrap();
        let (_, removed) = apply_remote_batch(
            &repo,
            vec![RemoteOp::Delete("t1".into(), "2026-02-02T00:00:00Z".into())],
        )
        .unwrap();
        assert_eq!(removed, vec!["t1".to_string()]);
        assert!(load(&repo).unwrap().tasks.is_empty());
    }

    #[test]
    fn sync_local_edit_newer_than_delete_survives() {
        let repo = tmp_repo("syncsurv");
        save(&repo, &TaskFile { tasks: vec![mk("t1", "kept", "2026-02-05T00:00:00Z")] }).unwrap();
        // Delete stamped before the local edit → local wins, task survives.
        let (_, removed) = apply_remote_batch(
            &repo,
            vec![RemoteOp::Delete("t1".into(), "2026-02-01T00:00:00Z".into())],
        )
        .unwrap();
        assert!(removed.is_empty());
        assert_eq!(load(&repo).unwrap().tasks.len(), 1);
    }

    #[test]
    fn sync_in_batch_tombstone_blocks_stale_resurrect() {
        let repo = tmp_repo("synctomb");
        // Delete then an OLDER upsert in the same batch must not resurrect.
        let stale = mk("t1", "zombie", "2026-02-01T00:00:00Z");
        let (applied, removed) = apply_remote_batch(
            &repo,
            vec![
                RemoteOp::Delete("t1".into(), "2026-02-02T00:00:00Z".into()),
                RemoteOp::Upsert(Box::new(stale), "2026-02-01T00:00:00Z".into()),
            ],
        )
        .unwrap();
        assert!(applied.is_empty());
        assert!(removed.is_empty());
        assert!(load(&repo).unwrap().tasks.is_empty());
    }

    #[test]
    fn sync_in_batch_newer_upsert_after_delete_recreates() {
        let repo = tmp_repo("syncrec");
        let fresh = mk("t1", "reborn", "2026-02-03T00:00:00Z");
        let (applied, _) = apply_remote_batch(
            &repo,
            vec![
                RemoteOp::Delete("t1".into(), "2026-02-02T00:00:00Z".into()),
                RemoteOp::Upsert(Box::new(fresh), "2026-02-03T00:00:00Z".into()),
            ],
        )
        .unwrap();
        assert_eq!(applied, vec!["t1".to_string()]);
        assert_eq!(load(&repo).unwrap().tasks[0].title, "reborn");
    }
}
