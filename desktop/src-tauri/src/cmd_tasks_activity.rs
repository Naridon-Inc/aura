//! Plane-parity activity log — append-only timeline of every mutation
//! a task receives. Persisted to `<repoRoot>/.aura/tasks/task_activity.jsonl`
//! so each event is one line of JSON; the log can grow forever without
//! re-serialising the whole file on every write.
//!
//! Events are emitted implicitly from the mutation paths in
//! `cmd_tasks` (task create / update / state change / assignee diff
//! / label diff), `cmd_tasks_comments` (comment add), `cmd_tasks_relations`
//! (link / unlink) and `cmd_tasks_bulk` (one event per affected task in
//! a bulk op). The read surface is `tasks_activity_list(task_id, limit?)`
//! — newest-first, capped at the supplied limit (or all rows when omitted).
//!
//! `actor_handle` is the git handle of the human who triggered the
//! event when the backend can identify them; otherwise `"system"`. The
//! frontend may pass an explicit handle through the upcoming
//! identity-aware mutation paths; until then we default to `"system"`
//! so the activity surface keeps rendering rather than crashing on a
//! missing field.
//!
//! Commands:
//!   - `tasks_activity_list(task_id, limit?)`
//!   - `tasks_activity_clear(task_id)`

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One row of the per-repo activity timeline. `payload` is free-form
/// JSON so future event kinds can add structured fields without a
/// schema bump — the frontend renders unknown kinds with a generic
/// "X changed" message.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskActivity {
    /// Stable id ("act_<uuid>"). Used as the React key in the timeline
    /// view; also the `id` the `tasks_activity_clear` call would
    /// reference if we add per-event delete later.
    pub id: String,
    /// The task this event belongs to. Acts as the partition key for
    /// `tasks_activity_list(task_id)`.
    pub task_id: String,
    /// Canonical event kind. One of:
    ///   "created" | "updated" | "state_changed" | "assigned" |
    ///   "unassigned" | "labeled" | "unlabeled" | "linked" |
    ///   "unlinked" | "commented".
    /// Stored as a free-form string so future kinds don't break older
    /// readers — the frontend has a switch over the canonical set and
    /// renders unknown values with a generic "X" prefix.
    pub kind: String,
    /// Git handle of the actor responsible for the event. `"system"`
    /// when the mutation came from a non-attributable code path
    /// (e.g. a heal pass).
    pub actor_handle: String,
    /// Event-specific structured payload. Examples:
    ///   - state_changed → {"from": "backlog", "to": "started"}
    ///   - assigned → {"added": ["ashiq"]}
    ///   - labeled → {"added": ["bug"], "removed": ["frontend"]}
    ///   - linked → {"target_id": "task_abc", "kind": "blocked_by"}
    #[serde(default)]
    pub payload: serde_json::Value,
    pub created_at: String,
}

fn activity_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join(".aura")
        .join("tasks")
        .join("task_activity.jsonl")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_activity_id() -> String {
    format!("act_{}", uuid::Uuid::new_v4())
}

/// Append a single activity row to the jsonl log. Idempotent w.r.t.
/// directory creation: ensures the parent dir exists first so a fresh
/// repo doesn't need a separate init step. Errors propagate so the
/// caller (the mutation that triggered the event) can surface them
/// rather than silently dropping audit entries.
///
/// This is the canonical write path — both the public Tauri commands
/// and the internal emit hooks call through it.
pub fn append_activity(
    repo_root: &Path,
    task_id: &str,
    kind: &str,
    actor_handle: &str,
    payload: serde_json::Value,
) -> Result<TaskActivity, String> {
    let p = activity_path(repo_root);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let entry = TaskActivity {
        id: new_activity_id(),
        task_id: task_id.to_string(),
        kind: kind.to_string(),
        actor_handle: if actor_handle.trim().is_empty() {
            "system".into()
        } else {
            actor_handle.to_string()
        },
        payload,
        created_at: now_iso(),
    };
    let line = serde_json::to_string(&entry).map_err(|e| format!("serialize: {}", e))?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
        .map_err(|e| format!("open {}: {}", p.display(), e))?;
    writeln!(f, "{}", line).map_err(|e| format!("write: {}", e))?;
    Ok(entry)
}

/// Read every entry in the log. Each line is parsed independently so a
/// single malformed row doesn't take the whole timeline down — corrupt
/// lines are skipped with a warning to stderr (the UI still gets the
/// surrounding entries). Returns rows in file order (oldest → newest).
fn read_all(repo_root: &Path) -> Result<Vec<TaskActivity>, String> {
    let p = activity_path(repo_root);
    if !p.exists() {
        return Ok(Vec::new());
    }
    let f = fs::File::open(&p).map_err(|e| format!("open {}: {}", p.display(), e))?;
    let reader = BufReader::new(f);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[tasks_activity] read line: {}", e);
                continue;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<TaskActivity>(trimmed) {
            Ok(row) => out.push(row),
            Err(e) => eprintln!("[tasks_activity] skip corrupt row: {} :: {}", e, trimmed),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn tasks_activity_list(
    repo_root: String,
    task_id: String,
    limit: Option<usize>,
) -> Result<Vec<TaskActivity>, String> {
    let rows = read_all(Path::new(&repo_root))?;
    // Filter then reverse so newest renders first, matching Plane's
    // activity stream. Applying the limit after the reverse means a
    // tight cap (e.g. 10) returns the *latest* 10, not the earliest.
    let mut filtered: Vec<TaskActivity> = rows
        .into_iter()
        .filter(|r| r.task_id == task_id)
        .collect();
    filtered.reverse();
    if let Some(n) = limit {
        filtered.truncate(n);
    }
    Ok(filtered)
}

/// Compact the log by dropping every row for a single task. Used by
/// the task-delete path so a deleted task doesn't leave dangling audit
/// rows behind. We rewrite the whole file rather than mark-and-sweep
/// because jsonl has no in-place delete.
#[tauri::command]
pub async fn tasks_activity_clear(repo_root: String, task_id: String) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let rows = read_all(root)?;
    let kept: Vec<TaskActivity> = rows.into_iter().filter(|r| r.task_id != task_id).collect();
    let p = activity_path(root);
    let mut buf: Vec<u8> = Vec::new();
    for row in &kept {
        let line = serde_json::to_string(row).map_err(|e| format!("serialize: {}", e))?;
        writeln!(&mut buf, "{}", line).map_err(|e| format!("write: {}", e))?;
    }
    crate::fs_atomic::write_bytes(&p, &buf)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-oo5-activity-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn append_then_list_round_trips() {
        let repo = tmp_repo("roundtrip");
        let row = append_activity(
            &repo,
            "task_a",
            "created",
            "ashiq",
            serde_json::json!({ "title": "test" }),
        )
        .unwrap();
        assert!(row.id.starts_with("act_"));
        assert_eq!(row.actor_handle, "ashiq");
        let rows = read_all(&repo).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, "task_a");
        assert_eq!(rows[0].kind, "created");
    }

    #[test]
    fn list_returns_newest_first_and_filters_by_task() {
        let repo = tmp_repo("newest");
        append_activity(&repo, "t1", "created", "ashiq", serde_json::json!({})).unwrap();
        append_activity(&repo, "t2", "created", "ashiq", serde_json::json!({})).unwrap();
        append_activity(&repo, "t1", "updated", "ashiq", serde_json::json!({})).unwrap();
        let rows = read_all(&repo).unwrap();
        assert_eq!(rows.len(), 3);
        // Filter for t1 newest-first
        let mut t1: Vec<_> = rows.into_iter().filter(|r| r.task_id == "t1").collect();
        t1.reverse();
        assert_eq!(t1.len(), 2);
        assert_eq!(t1[0].kind, "updated");
        assert_eq!(t1[1].kind, "created");
    }

    #[test]
    fn clear_drops_only_that_tasks_rows() {
        let repo = tmp_repo("clear");
        append_activity(&repo, "t1", "created", "a", serde_json::json!({})).unwrap();
        append_activity(&repo, "t2", "created", "a", serde_json::json!({})).unwrap();
        append_activity(&repo, "t1", "updated", "a", serde_json::json!({})).unwrap();
        // simulate the async tauri command with a sync shim
        let root = repo.clone();
        let rows = read_all(&root).unwrap();
        let kept: Vec<TaskActivity> = rows.into_iter().filter(|r| r.task_id != "t1").collect();
        let p = activity_path(&root);
        let tmp = p.with_extension("jsonl.tmp");
        let mut f = fs::File::create(&tmp).unwrap();
        for row in &kept {
            writeln!(f, "{}", serde_json::to_string(row).unwrap()).unwrap();
        }
        drop(f);
        fs::rename(&tmp, &p).unwrap();
        let after = read_all(&root).unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].task_id, "t2");
    }

    #[test]
    fn empty_actor_defaults_to_system() {
        let repo = tmp_repo("system");
        let row = append_activity(&repo, "t1", "created", "   ", serde_json::json!({})).unwrap();
        assert_eq!(row.actor_handle, "system");
    }

    #[test]
    fn corrupt_line_is_skipped_not_fatal() {
        let repo = tmp_repo("corrupt");
        append_activity(&repo, "t1", "created", "a", serde_json::json!({})).unwrap();
        // Inject a garbage line directly
        let p = activity_path(&repo);
        let mut f = OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "this is not json").unwrap();
        drop(f);
        append_activity(&repo, "t1", "updated", "a", serde_json::json!({})).unwrap();
        let rows = read_all(&repo).unwrap();
        // Two valid + one skipped = 2 rows survive
        assert_eq!(rows.len(), 2);
    }
}
