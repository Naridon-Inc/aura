//! Plane-parity Cycles (sprints with a defined window) — per-repo
//! CRUD over a JSON file at `<repoRoot>/.aura/tasks/task_cycles.json`.
//!
//! Distinct from the older `Sprint` registry in `cmd_tasks`: Sprint is
//! a free-form iteration slug that any task can be tagged with via
//! `Task::sprint`. Cycle is a strict Plane-style sprint object —
//! start/end dates, planned/active/completed lifecycle, and an
//! explicit `task_ids` list (the tasks themselves also carry
//! `cycle_id` so reads from either end stay in sync).
//!
//! The two surfaces co-exist deliberately: existing v0.2.30/v0.2.31
//! sprint workflows keep working, and OO.4 lays the Cycle substrate
//! that Plane's Cycle view + burndown + completion-percentage cards
//! will consume.
//!
//! Commands:
//!   - `tasks_cycles_list`
//!   - `tasks_cycles_upsert` (create-or-replace by id)
//!   - `tasks_cycles_delete` (detaches tasks pointing at the cycle)
//!   - `tasks_cycle_assign` (membership; mirrored on Task::cycle_id)
//!   - `tasks_cycle_unassign`

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Plane-style cycle = sprint with strict window + lifecycle.
///
/// `status` is one of `planned | active | completed`. The transition
/// is driver-controlled: callers flip it via `tasks_cycles_upsert`.
/// The backend does not auto-advance on date crossing because Plane
/// also leaves that to the user (lets teams roll over deliberately).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cycle {
    /// Stable slug — also the value stored on `Task::cycle_id` and the
    /// key the UI uses for routing. Generated client-side from the
    /// name; updates by sending the same `id` to upsert.
    pub id: String,
    /// Human label rendered on the cycle pill + sidebar entry.
    pub name: String,
    /// YYYY-MM-DD inclusive.
    pub start_date: String,
    /// YYYY-MM-DD inclusive.
    pub end_date: String,
    /// Free-text "what are we trying to land this sprint?" — rendered in
    /// the Sprint-view header + burndown. Folded in from the legacy
    /// `Sprint::goal` when BEAD-I unified the two iteration primitives.
    /// `#[serde(default)]` so pre-goal `task_cycles.json` files load.
    #[serde(default)]
    pub goal: String,
    /// One of `planned | active | completed`. The validator below
    /// rejects anything else so a stale client can't corrupt the file.
    /// At most one cycle is `active` at a time — enforced by
    /// `upsert_cycle_inner` (activating one demotes any other active).
    pub status: String,
    /// Explicit membership list. Kept in sync with `Task::cycle_id`
    /// by `tasks_cycle_assign` / `tasks_cycle_unassign`; the heal
    /// pass in `cmd_tasks::backfill_ontology` clears `cycle_id` on
    /// tasks whose cycle was deleted out from under them.
    #[serde(default)]
    pub task_ids: Vec<String>,
    /// BEAD-I phase 4 — frozen throughput captured at Close: Σ `points`
    /// (or done-count when the sprint had no estimates) delivered when
    /// the sprint was completed. `None` while the sprint is planned/active.
    /// Stored rather than always re-derived so the trend sparkline reads a
    /// stable historical number even if done tasks are later moved/deleted.
    /// `#[serde(default)]` so pre-velocity `task_cycles.json` files load.
    #[serde(default)]
    pub velocity: Option<f64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct CycleFile {
    #[serde(default)]
    cycles: Vec<Cycle>,
}

fn cycles_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("tasks").join("task_cycles.json")
}

fn load_cycles(repo_root: &Path) -> Result<CycleFile, String> {
    let p = cycles_path(repo_root);
    if !p.exists() {
        return Ok(CycleFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_cycles(repo_root: &Path, file: &CycleFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&cycles_path(repo_root), file)
}

/// Idempotent first-touch: ensures the cycles file exists on disk so
/// `cmd_tasks::backfill_ontology` can call us safely from inside the
/// `tasks_list` heal without racing on a missing parent dir. Returns
/// the loaded file (always present after this call).
fn ensure_cycles_file(repo_root: &Path) -> Result<CycleFile, String> {
    let p = cycles_path(repo_root);
    if !p.exists() {
        let empty = CycleFile::default();
        save_cycles(repo_root, &empty)?;
        return Ok(empty);
    }
    load_cycles(repo_root)
}

/// Cross-module wrapper for `cmd_tasks` — same first-touch behaviour
/// but doesn't leak the private `CycleFile` type. Returns `Ok(())` on
/// success regardless of whether the file existed; callers that need
/// the loaded rows should go through `tasks_cycles_list` instead.
pub fn ensure_cycles_file_initialized(repo_root: &Path) -> Result<(), String> {
    ensure_cycles_file(repo_root).map(|_| ())
}

/// Public read for the heal pass in `cmd_tasks`. Returns the set of
/// cycle ids that exist on disk so the heal can clear dangling
/// `Task::cycle_id` pointers (cycle deleted out from under task).
pub fn known_cycle_ids(repo_root: &Path) -> Result<Vec<String>, String> {
    Ok(load_cycles(repo_root)?
        .cycles
        .into_iter()
        .map(|c| c.id)
        .collect())
}

/// Sync-callable mirror used by `cmd_tasks::tasks_create` when the
/// caller set `cycle_id` at create time. The async `tasks_cycle_assign`
/// command can't be awaited from a non-async context cleanly, so we
/// expose the same membership-update logic as a plain function. Caller
/// must have validated that the cycle exists.
pub fn mirror_assign_task(
    repo_root: &Path,
    cycle_id: &str,
    task_id: &str,
) -> Result<(), String> {
    let mut file = ensure_cycles_file(repo_root)?;
    let now = now_iso();
    let mut mutated = false;
    for c in file.cycles.iter_mut() {
        if c.id == cycle_id {
            if !c.task_ids.contains(&task_id.to_string()) {
                c.task_ids.push(task_id.to_string());
                c.updated_at = now.clone();
                mutated = true;
            }
        } else {
            let before = c.task_ids.len();
            c.task_ids.retain(|t| t != task_id);
            if c.task_ids.len() != before {
                c.updated_at = now.clone();
                mutated = true;
            }
        }
    }
    if mutated {
        save_cycles(repo_root, &file)?;
    }
    Ok(())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

const VALID_STATUSES: [&str; 3] = ["planned", "active", "completed"];

fn validate_status(s: &str) -> Result<(), String> {
    if VALID_STATUSES.contains(&s) {
        Ok(())
    } else {
        Err(format!(
            "invalid cycle status {:?} — must be one of {:?}",
            s, VALID_STATUSES
        ))
    }
}

#[derive(Deserialize)]
pub struct CycleInput {
    pub id: String,
    pub name: String,
    pub start_date: String,
    pub end_date: String,
    /// Free-text sprint goal. `#[serde(default)]` so older clients (and
    /// the legacy sprint shim) can omit it.
    #[serde(default)]
    pub goal: String,
    /// `planned | active | completed`. Defaults to `planned` when
    /// missing so the frontend can omit it on first create.
    #[serde(default = "default_cycle_status")]
    pub status: String,
}

fn default_cycle_status() -> String {
    "planned".into()
}

/// Public sync read of every cycle on disk (first-touch ensured).
/// Used by the legacy sprint shim in `cmd_tasks` so the two iteration
/// surfaces read one store. Order is file order (creation order).
pub fn list_cycles(repo_root: &Path) -> Result<Vec<Cycle>, String> {
    Ok(ensure_cycles_file(repo_root)?.cycles)
}

#[tauri::command]
pub async fn tasks_cycles_list(repo_root: String) -> Result<Vec<Cycle>, String> {
    list_cycles(Path::new(&repo_root))
}

/// Create-or-replace by id — the sync core behind both the async
/// `tasks_cycles_upsert` command and the legacy `sprints_*` shim.
///
/// The membership list is preserved across updates so re-saving the
/// cycle window does not nuke its task pointers; assign/unassign own
/// that mutation.
///
/// Single-active invariant: when `input.status == "active"`, any OTHER
/// cycle currently `active` is demoted to `completed` in the same
/// write — there is at most one active sprint at any time. Editing the
/// already-active cycle in place (same id) is exempt, so a rename
/// doesn't complete the sprint you're editing. (The deliberate Close
/// flow is the blessed path that also captures velocity; this is the
/// data-layer guard against two actives.)
pub fn upsert_cycle_inner(repo_root: &Path, input: CycleInput) -> Result<Cycle, String> {
    let root = repo_root;
    validate_status(&input.status)?;
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err("cycle id is required".into());
    }
    if input.name.trim().is_empty() {
        return Err("cycle name is required".into());
    }
    let activating = input.status == "active";
    let mut file = ensure_cycles_file(root)?;
    let now = now_iso();
    let mut updated: Option<Cycle> = None;
    for c in file.cycles.iter_mut() {
        if c.id == id {
            c.name = input.name.clone();
            c.start_date = input.start_date.clone();
            c.end_date = input.end_date.clone();
            c.goal = input.goal.clone();
            c.status = input.status.clone();
            c.updated_at = now.clone();
            updated = Some(c.clone());
            break;
        }
    }
    if updated.is_none() {
        let cycle = Cycle {
            id: id.clone(),
            name: input.name,
            start_date: input.start_date,
            end_date: input.end_date,
            goal: input.goal,
            status: input.status,
            task_ids: Vec::new(),
            velocity: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        file.cycles.push(cycle.clone());
        updated = Some(cycle);
    }
    if activating {
        for c in file.cycles.iter_mut() {
            if c.id != id && c.status == "active" {
                c.status = "completed".into();
                c.updated_at = now.clone();
            }
        }
    }
    save_cycles(root, &file)?;
    updated.ok_or_else(|| "cycle vanished".into())
}

#[tauri::command]
pub async fn tasks_cycles_upsert(
    repo_root: String,
    input: CycleInput,
) -> Result<Cycle, String> {
    upsert_cycle_inner(Path::new(&repo_root), input)
}

/// One-time migration helper (BEAD-I): create a cycle from a legacy
/// `Sprint` row only when no cycle already owns that slug. Never
/// clobbers a cycle the user has since edited — the migration is a
/// fold-in, not an overwrite. The caller pre-resolves `status` so the
/// single-active invariant holds across the whole store (it does NOT
/// route through `upsert_cycle_inner`'s demote-to-completed, because a
/// historically-active sprint that loses the race should become
/// `planned`, not `completed`).
pub fn migrate_create_cycle_if_absent(
    repo_root: &Path,
    id: &str,
    name: &str,
    start: &str,
    end: &str,
    goal: &str,
    status: &str,
) -> Result<(), String> {
    let mut file = ensure_cycles_file(repo_root)?;
    if file.cycles.iter().any(|c| c.id == id) {
        return Ok(());
    }
    let now = now_iso();
    file.cycles.push(Cycle {
        id: id.to_string(),
        name: name.to_string(),
        start_date: start.to_string(),
        end_date: end.to_string(),
        goal: goal.to_string(),
        status: status.to_string(),
        task_ids: Vec::new(),
        velocity: None,
        created_at: now.clone(),
        updated_at: now,
    });
    save_cycles(repo_root, &file)?;
    Ok(())
}

/// Delete a cycle. Tasks pointing at the deleted cycle are detached
/// (their `Task::cycle_id` is cleared) so they don't dangle in the
/// "open this cycle" filter. The detach happens inline rather than
/// via the heal pass so callers see an immediate consistent state.
/// Sync core behind the async delete command and the legacy sprint
/// shim. Tasks pointing at the deleted cycle are detached.
pub fn delete_cycle_inner(repo_root: &Path, id: &str) -> Result<(), String> {
    let mut file = ensure_cycles_file(repo_root)?;
    let before = file.cycles.len();
    file.cycles.retain(|c| c.id != id);
    if file.cycles.len() == before {
        return Err(format!("cycle not found: {}", id));
    }
    save_cycles(repo_root, &file)?;
    crate::cmd_tasks::detach_cycle(repo_root, id)?;
    Ok(())
}

#[tauri::command]
pub async fn tasks_cycles_delete(repo_root: String, id: String) -> Result<(), String> {
    delete_cycle_inner(Path::new(&repo_root), &id)
}

/// BEAD-I phase 4 — Close a sprint. Flips `status` to `completed` and
/// freezes the delivered throughput on the cycle (`velocity`). The
/// caller (the Close flow in the UI) has already moved incomplete tasks
/// to the next sprint or backlog via assign/unassign, and computed the
/// velocity from the done set, so this is the single durable write that
/// records "this sprint shipped N". Idempotent enough to re-run: closing
/// an already-completed cycle just overwrites the velocity with the
/// freshly-passed figure. Errors when the cycle id is unknown.
pub fn close_cycle_inner(
    repo_root: &Path,
    id: &str,
    velocity: f64,
) -> Result<Cycle, String> {
    let mut file = ensure_cycles_file(repo_root)?;
    let now = now_iso();
    let mut closed: Option<Cycle> = None;
    for c in file.cycles.iter_mut() {
        if c.id == id {
            c.status = "completed".into();
            c.velocity = Some(velocity);
            c.updated_at = now.clone();
            closed = Some(c.clone());
            break;
        }
    }
    let closed = closed.ok_or_else(|| format!("cycle not found: {}", id))?;
    save_cycles(repo_root, &file)?;
    Ok(closed)
}

#[tauri::command]
pub async fn tasks_cycle_close(
    repo_root: String,
    id: String,
    velocity: f64,
) -> Result<Cycle, String> {
    close_cycle_inner(Path::new(&repo_root), &id, velocity)
}

/// Append a task to a cycle's membership list and mirror the pointer
/// onto `Task::cycle_id`. Idempotent: re-assigning the same task is
/// a no-op rather than a duplicate. Moving a task between cycles is
/// allowed — the old cycle's membership is updated as part of the
/// same write so the two never disagree.
#[tauri::command]
pub async fn tasks_cycle_assign(
    repo_root: String,
    cycle_id: String,
    task_id: String,
) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let file = ensure_cycles_file(root)?;
    if !file.cycles.iter().any(|c| c.id == cycle_id) {
        return Err(format!("cycle not found: {}", cycle_id));
    }
    mirror_assign_task(root, &cycle_id, &task_id)?;
    crate::cmd_tasks::set_task_cycle(root, &task_id, Some(&cycle_id))?;
    Ok(())
}

/// Remove a task from a cycle. Clears `Task::cycle_id` to match.
/// No-op when the task isn't in the cycle's membership list (so the
/// frontend can call this defensively on "unassign clicked" without
/// having to read state first).
#[tauri::command]
pub async fn tasks_cycle_unassign(
    repo_root: String,
    cycle_id: String,
    task_id: String,
) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = ensure_cycles_file(root)?;
    let now = now_iso();
    let mut mutated = false;
    for c in file.cycles.iter_mut() {
        if c.id == cycle_id {
            let before = c.task_ids.len();
            c.task_ids.retain(|t| t != &task_id);
            if c.task_ids.len() != before {
                c.updated_at = now.clone();
                mutated = true;
            }
        }
    }
    if mutated {
        save_cycles(root, &file)?;
    }
    crate::cmd_tasks::set_task_cycle(root, &task_id, None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-oo4-cycles-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_input(id: &str) -> CycleInput {
        CycleInput {
            id: id.into(),
            name: format!("Cycle {}", id),
            start_date: "2026-06-01".into(),
            end_date: "2026-06-14".into(),
            goal: String::new(),
            status: "planned".into(),
        }
    }

    #[test]
    fn validate_status_accepts_canonical() {
        assert!(validate_status("planned").is_ok());
        assert!(validate_status("active").is_ok());
        assert!(validate_status("completed").is_ok());
        assert!(validate_status("garbage").is_err());
        assert!(validate_status("").is_err());
    }

    #[test]
    fn ensure_cycles_file_creates_on_first_touch() {
        let repo = tmp_repo("ensure");
        assert!(!cycles_path(&repo).exists());
        let file = ensure_cycles_file(&repo).unwrap();
        assert!(file.cycles.is_empty());
        assert!(cycles_path(&repo).exists());
    }

    #[test]
    fn upsert_round_trip_preserves_membership() {
        let repo = tmp_repo("roundtrip");
        // create with empty membership
        let mut f = ensure_cycles_file(&repo).unwrap();
        let now = now_iso();
        f.cycles.push(Cycle {
            id: "c1".into(),
            name: "Cycle 1".into(),
            start_date: "2026-06-01".into(),
            end_date: "2026-06-14".into(),
            goal: String::new(),
            status: "planned".into(),
            task_ids: vec!["task_a".into(), "task_b".into()],
            velocity: None,
            created_at: now.clone(),
            updated_at: now,
        });
        save_cycles(&repo, &f).unwrap();
        // upsert rewrites name + goal; membership should survive
        let input = CycleInput {
            id: "c1".into(),
            name: "Renamed".into(),
            start_date: "2026-06-08".into(),
            end_date: "2026-06-21".into(),
            goal: "Land the burndown".into(),
            status: "active".into(),
        };
        let updated = upsert_cycle_inner(&repo, input).unwrap();
        assert_eq!(updated.goal, "Land the burndown");
        let reloaded = load_cycles(&repo).unwrap();
        let c = &reloaded.cycles[0];
        assert_eq!(c.name, "Renamed");
        assert_eq!(c.status, "active");
        assert_eq!(c.goal, "Land the burndown");
        assert_eq!(c.task_ids, vec!["task_a".to_string(), "task_b".to_string()]);
    }

    #[test]
    fn known_cycle_ids_returns_just_ids() {
        let repo = tmp_repo("ids");
        let mut f = ensure_cycles_file(&repo).unwrap();
        let now = now_iso();
        for id in ["a", "b", "c"] {
            f.cycles.push(Cycle {
                id: id.into(),
                name: id.into(),
                start_date: "2026-06-01".into(),
                end_date: "2026-06-14".into(),
                goal: String::new(),
                status: "planned".into(),
                task_ids: Vec::new(),
                velocity: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        }
        save_cycles(&repo, &f).unwrap();
        let ids = known_cycle_ids(&repo).unwrap();
        assert_eq!(ids, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn cycle_input_defaults_status_to_planned() {
        // exercise serde default path
        let raw = serde_json::json!({
            "id": "c2",
            "name": "Cycle 2",
            "start_date": "2026-07-01",
            "end_date": "2026-07-14"
        });
        let parsed: CycleInput = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.status, "planned");
    }

    #[test]
    fn sample_input_serializes_with_required_fields() {
        let i = sample_input("c1");
        let v = serde_json::to_value(&serde_json::json!({
            "id": i.id,
            "name": i.name,
            "start_date": i.start_date,
            "end_date": i.end_date,
            "status": i.status,
        }))
        .unwrap();
        assert_eq!(v["id"], "c1");
        assert_eq!(v["status"], "planned");
    }

    #[test]
    fn cycle_goal_defaults_when_absent() {
        // legacy task_cycles.json rows have no `goal` — serde fills "".
        let raw = serde_json::json!({
            "id": "c1",
            "name": "Cycle 1",
            "start_date": "2026-06-01",
            "end_date": "2026-06-14",
            "status": "planned",
            "created_at": "t",
            "updated_at": "t"
        });
        let c: Cycle = serde_json::from_value(raw).unwrap();
        assert_eq!(c.goal, "");
        assert!(c.task_ids.is_empty());
    }

    #[test]
    fn upsert_active_demotes_previous_active() {
        let repo = tmp_repo("single-active");
        // first sprint goes active
        let mut a = sample_input("a");
        a.status = "active".into();
        upsert_cycle_inner(&repo, a).unwrap();
        // second sprint also activated — first must demote to completed
        let mut b = sample_input("b");
        b.status = "active".into();
        upsert_cycle_inner(&repo, b).unwrap();
        let cycles = list_cycles(&repo).unwrap();
        let by = |id: &str| cycles.iter().find(|c| c.id == id).unwrap().status.clone();
        assert_eq!(by("a"), "completed");
        assert_eq!(by("b"), "active");
        // editing the active one in place must NOT demote itself
        let mut b2 = sample_input("b");
        b2.name = "B renamed".into();
        b2.status = "active".into();
        upsert_cycle_inner(&repo, b2).unwrap();
        assert_eq!(by("b"), "active");
        assert_eq!(
            list_cycles(&repo)
                .unwrap()
                .iter()
                .filter(|c| c.status == "active")
                .count(),
            1
        );
    }

    #[test]
    fn migrate_create_cycle_if_absent_does_not_clobber() {
        let repo = tmp_repo("migrate");
        migrate_create_cycle_if_absent(&repo, "s1", "Sprint 1", "2026-06-01", "2026-06-14", "Ship it", "active")
            .unwrap();
        // second call with different data is a no-op (slug already owned)
        migrate_create_cycle_if_absent(&repo, "s1", "CLOBBERED", "2000-01-01", "2000-01-02", "", "planned")
            .unwrap();
        let cycles = list_cycles(&repo).unwrap();
        assert_eq!(cycles.len(), 1);
        assert_eq!(cycles[0].name, "Sprint 1");
        assert_eq!(cycles[0].goal, "Ship it");
        assert_eq!(cycles[0].status, "active");
    }

    #[test]
    fn close_cycle_completes_and_freezes_velocity() {
        let repo = tmp_repo("close");
        let mut a = sample_input("s1");
        a.status = "active".into();
        upsert_cycle_inner(&repo, a).unwrap();
        // before close: active, no velocity recorded
        let before = list_cycles(&repo).unwrap();
        assert_eq!(before[0].status, "active");
        assert!(before[0].velocity.is_none());
        // close with 21 points delivered
        let closed = close_cycle_inner(&repo, "s1", 21.0).unwrap();
        assert_eq!(closed.status, "completed");
        assert_eq!(closed.velocity, Some(21.0));
        // persisted to disk
        let after = list_cycles(&repo).unwrap();
        assert_eq!(after[0].status, "completed");
        assert_eq!(after[0].velocity, Some(21.0));
        // closing an unknown cycle errors
        assert!(close_cycle_inner(&repo, "ghost", 1.0).is_err());
    }
}
