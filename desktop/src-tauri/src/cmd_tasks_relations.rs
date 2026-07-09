//! Plane-parity task relations — typed cross-task links beyond the
//! `parent_id` / `dependencies` shapes already on `Task`.
//!
//! Persisted to `<repoRoot>/.aura/tasks/task_relations.json` as a flat
//! list. The file is intentionally separate from `tasks.json` so
//! relation churn never rewrites the hot task ledger.
//!
//! Relation kinds:
//!   * `blocked_by` — A is blocked by B. Mirrored as B `blocks` A.
//!   * `blocks`     — A blocks B. Mirrored as B `blocked_by` A.
//!   * `duplicates` — Symmetric: A duplicates B iff B duplicates A.
//!   * `relates_to` — Symmetric: A relates_to B iff B relates_to A.
//!
//! The mirror happens at write time inside `tasks_relations_create`
//! and at delete time inside `tasks_relations_delete` so a single
//! frontend action produces a consistent pair (or removes one) without
//! the caller having to know the inverse.
//!
//! Activity hooks: `tasks_relations_create` emits a `linked` event on
//! both endpoint tasks; `tasks_relations_delete` emits `unlinked`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One directed relation row. The mirror pair (when applicable) is a
/// second row with the swapped endpoints and the inverse kind; we
/// never collapse them into a single row because Plane's UI lets you
/// delete the pair from either side and the delete-one-side semantics
/// would be ambiguous otherwise.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TaskRelation {
    /// Stable id ("rel_<uuid>"). Acts as the React key + the parameter
    /// for `tasks_relations_delete`.
    pub id: String,
    /// The "from" endpoint. For `blocked_by` this is the task that is
    /// blocked; for `blocks` this is the blocker; for the symmetric
    /// kinds either direction is legitimate.
    pub source_id: String,
    /// The "to" endpoint. See `source_id` for kind-specific semantics.
    pub target_id: String,
    /// One of `blocked_by | blocks | duplicates | relates_to`.
    pub kind: String,
    pub created_at: String,
}

#[derive(Default, Serialize, Deserialize)]
struct RelationFile {
    #[serde(default)]
    relations: Vec<TaskRelation>,
}

fn relations_path(repo_root: &Path) -> PathBuf {
    repo_root
        .join(".aura")
        .join("tasks")
        .join("task_relations.json")
}

fn load_relations(repo_root: &Path) -> Result<RelationFile, String> {
    let p = relations_path(repo_root);
    if !p.exists() {
        return Ok(RelationFile::default());
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {}", p.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {}", p.display(), e))
}

fn save_relations(repo_root: &Path, file: &RelationFile) -> Result<(), String> {
    crate::fs_atomic::write_json_pretty(&relations_path(repo_root), file)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_relation_id() -> String {
    format!("rel_{}", uuid::Uuid::new_v4())
}

/// Canonical kinds the backend accepts. Anything else gets rejected
/// with an explicit error so a typo on the wire surfaces as a clear
/// message rather than a silently-stored garbage row.
const VALID_KINDS: [&str; 4] = ["blocked_by", "blocks", "duplicates", "relates_to"];

/// Returns the kind that should be written on the mirror row. For the
/// asymmetric pair this swaps blocked_by ↔ blocks; for the symmetric
/// kinds the inverse is the same kind (so the mirror has the same
/// `kind` but swapped endpoints).
fn inverse_kind(kind: &str) -> &'static str {
    match kind {
        "blocked_by" => "blocks",
        "blocks" => "blocked_by",
        "duplicates" => "duplicates",
        "relates_to" => "relates_to",
        _ => kind_static(kind),
    }
}

// Tiny helper to widen a runtime kind to &'static str only when we
// already know it's one of the four canonicals (validate_kind runs
// before this in every call path).
fn kind_static(kind: &str) -> &'static str {
    match kind {
        "blocked_by" => "blocked_by",
        "blocks" => "blocks",
        "duplicates" => "duplicates",
        "relates_to" => "relates_to",
        // Fallback; the validate pass should have rejected anything
        // else, but we never want to panic on it.
        _ => "relates_to",
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if VALID_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!(
            "invalid relation kind {:?} — must be one of {:?}",
            kind, VALID_KINDS
        ))
    }
}

/// Returns `true` if the file already contains a row with the same
/// (source, target, kind) triple. Idempotency guard for create so the
/// frontend can call this defensively without spawning duplicates.
fn already_linked(file: &RelationFile, source: &str, target: &str, kind: &str) -> bool {
    file.relations.iter().any(|r| {
        r.source_id == source && r.target_id == target && r.kind == kind
    })
}

#[tauri::command]
pub async fn tasks_relations_list(
    repo_root: String,
    task_id: Option<String>,
) -> Result<Vec<TaskRelation>, String> {
    let file = load_relations(Path::new(&repo_root))?;
    Ok(match task_id {
        Some(id) => file
            .relations
            .into_iter()
            .filter(|r| r.source_id == id || r.target_id == id)
            .collect(),
        None => file.relations,
    })
}

/// Convenience wrapper used by the detail panel — same as
/// `tasks_relations_list(Some(task_id))`. Kept as its own command so
/// the frontend can spell intent at the call site ("show me everything
/// touching this task") and so we have an unambiguous semantic hook
/// for the activity-emit pass.
#[tauri::command]
pub async fn tasks_relations_for_task(
    repo_root: String,
    task_id: String,
) -> Result<Vec<TaskRelation>, String> {
    tasks_relations_list(repo_root, Some(task_id)).await
}

/// Create a relation and (when applicable) its symmetric mirror in
/// one atomic write. Returns the primary row; the mirror is reachable
/// via `tasks_relations_for_task(target_id)`.
///
/// Validates:
///   * `source != target` (no self-links)
///   * `kind` is one of the canonical four
///   * No duplicate row (idempotent: re-creating the same triple is
///     a no-op that returns the existing row).
#[tauri::command]
pub async fn tasks_relations_create(
    repo_root: String,
    source: String,
    target: String,
    kind: String,
) -> Result<TaskRelation, String> {
    let root = Path::new(&repo_root);
    validate_kind(&kind)?;
    let source = source.trim().to_string();
    let target = target.trim().to_string();
    if source.is_empty() || target.is_empty() {
        return Err("source and target task ids are required".into());
    }
    if source == target {
        return Err("cannot relate a task to itself".into());
    }
    let mut file = load_relations(root)?;
    // Idempotency: if the primary row already exists, hand it back
    // without writing — the mirror is guaranteed to exist already too
    // because we always create them as a pair.
    if let Some(existing) = file
        .relations
        .iter()
        .find(|r| r.source_id == source && r.target_id == target && r.kind == kind)
        .cloned()
    {
        return Ok(existing);
    }
    let now = now_iso();
    let primary = TaskRelation {
        id: new_relation_id(),
        source_id: source.clone(),
        target_id: target.clone(),
        kind: kind.clone(),
        created_at: now.clone(),
    };
    file.relations.push(primary.clone());
    // Mirror — append a second row with the inverse kind unless it
    // already exists (defensive: a stale file could carry the mirror
    // without the primary).
    let mirror_kind = inverse_kind(&kind);
    if !already_linked(&file, &target, &source, mirror_kind) {
        let mirror = TaskRelation {
            id: new_relation_id(),
            source_id: target,
            target_id: source,
            kind: mirror_kind.into(),
            created_at: now,
        };
        file.relations.push(mirror);
    }
    save_relations(root, &file)?;
    // Activity hooks on both endpoints so the timeline reflects the
    // pair from either side. We swallow the result — failing to log
    // shouldn't block the user from creating the link itself.
    let _ = crate::cmd_tasks_activity::append_activity(
        root,
        &primary.source_id,
        "linked",
        "system",
        serde_json::json!({
            "target_id": primary.target_id,
            "kind": primary.kind,
        }),
    );
    let _ = crate::cmd_tasks_activity::append_activity(
        root,
        &primary.target_id,
        "linked",
        "system",
        serde_json::json!({
            "target_id": primary.source_id,
            "kind": mirror_kind,
        }),
    );
    Ok(primary)
}

/// Delete a relation BY ID. Also deletes the symmetric mirror so the
/// pair stays consistent — callers don't have to figure out which row
/// the mirror is. No-op when the id doesn't exist (so the frontend
/// can fire deletes defensively after a click).
#[tauri::command]
pub async fn tasks_relations_delete(
    repo_root: String,
    relation_id: String,
) -> Result<(), String> {
    let root = Path::new(&repo_root);
    let mut file = load_relations(root)?;
    let target = match file.relations.iter().find(|r| r.id == relation_id).cloned() {
        Some(r) => r,
        None => return Ok(()),
    };
    let mirror_kind = inverse_kind(&target.kind);
    file.relations.retain(|r| {
        // Drop the primary row + any mirror with swapped endpoints +
        // inverse kind. Doing the filter in one pass (rather than two
        // sequential retains) is safer because the second pass would
        // mutate the borrow we just iterated.
        let is_primary = r.id == relation_id;
        let is_mirror = r.source_id == target.target_id
            && r.target_id == target.source_id
            && r.kind == mirror_kind;
        !(is_primary || is_mirror)
    });
    save_relations(root, &file)?;
    // Activity hooks — same shape as create, but the `unlinked` kind.
    let _ = crate::cmd_tasks_activity::append_activity(
        root,
        &target.source_id,
        "unlinked",
        "system",
        serde_json::json!({
            "target_id": target.target_id,
            "kind": target.kind,
        }),
    );
    let _ = crate::cmd_tasks_activity::append_activity(
        root,
        &target.target_id,
        "unlinked",
        "system",
        serde_json::json!({
            "target_id": target.source_id,
            "kind": mirror_kind,
        }),
    );
    Ok(())
}

/// Detach every relation row that touches `task_id`. Called by the
/// task-delete path so deleted tasks don't leave dangling references.
/// Returns `Ok(())` when the file is empty (no rows to drop) so the
/// caller can fire this defensively.
pub fn detach_relations_for(repo_root: &Path, task_id: &str) -> Result<(), String> {
    let mut file = load_relations(repo_root)?;
    let before = file.relations.len();
    file.relations
        .retain(|r| r.source_id != task_id && r.target_id != task_id);
    if file.relations.len() != before {
        save_relations(repo_root, &file)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-oo5-relations-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn validate_kind_rejects_garbage() {
        assert!(validate_kind("blocked_by").is_ok());
        assert!(validate_kind("blocks").is_ok());
        assert!(validate_kind("duplicates").is_ok());
        assert!(validate_kind("relates_to").is_ok());
        assert!(validate_kind("subtasks").is_err());
        assert!(validate_kind("").is_err());
    }

    #[test]
    fn inverse_kind_is_symmetric_for_symmetric_kinds() {
        assert_eq!(inverse_kind("blocked_by"), "blocks");
        assert_eq!(inverse_kind("blocks"), "blocked_by");
        assert_eq!(inverse_kind("duplicates"), "duplicates");
        assert_eq!(inverse_kind("relates_to"), "relates_to");
    }

    #[test]
    fn create_blocked_by_writes_symmetric_blocks_mirror() {
        let repo = tmp_repo("symmetric");
        let rel = rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "blocked_by".into(),
            ))
            .unwrap();
        assert_eq!(rel.kind, "blocked_by");
        // Reload — should see two rows: A blocked_by B + B blocks A.
        let file = load_relations(&repo).unwrap();
        assert_eq!(file.relations.len(), 2);
        let primary = file
            .relations
            .iter()
            .find(|r| r.source_id == "A" && r.target_id == "B" && r.kind == "blocked_by");
        let mirror = file
            .relations
            .iter()
            .find(|r| r.source_id == "B" && r.target_id == "A" && r.kind == "blocks");
        assert!(primary.is_some());
        assert!(mirror.is_some());
    }

    #[test]
    fn create_duplicates_is_symmetric_same_kind() {
        let repo = tmp_repo("dup");
        rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "duplicates".into(),
            ))
            .unwrap();
        let file = load_relations(&repo).unwrap();
        assert_eq!(file.relations.len(), 2);
        assert!(file
            .relations
            .iter()
            .any(|r| r.source_id == "A" && r.target_id == "B" && r.kind == "duplicates"));
        assert!(file
            .relations
            .iter()
            .any(|r| r.source_id == "B" && r.target_id == "A" && r.kind == "duplicates"));
    }

    #[test]
    fn create_is_idempotent_on_duplicate_triple() {
        let repo = tmp_repo("idem");
        let a = rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "relates_to".into(),
            ))
            .unwrap();
        let b = rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "relates_to".into(),
            ))
            .unwrap();
        // Same id back — no duplicate created.
        assert_eq!(a.id, b.id);
        let file = load_relations(&repo).unwrap();
        assert_eq!(file.relations.len(), 2);
    }

    #[test]
    fn self_link_is_rejected() {
        let repo = tmp_repo("self");
        let err = rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "A".into(),
                "relates_to".into(),
            ))
            .unwrap_err();
        assert!(err.contains("itself"));
    }

    #[test]
    fn delete_removes_primary_and_mirror_together() {
        let repo = tmp_repo("delpair");
        let primary = rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "blocked_by".into(),
            ))
            .unwrap();
        assert_eq!(load_relations(&repo).unwrap().relations.len(), 2);
        rt()
            .block_on(tasks_relations_delete(
                repo.to_string_lossy().into_owned(),
                primary.id.clone(),
            ))
            .unwrap();
        let file = load_relations(&repo).unwrap();
        assert!(file.relations.is_empty(), "mirror should be dropped too");
    }

    #[test]
    fn for_task_returns_incoming_and_outgoing() {
        let repo = tmp_repo("forboth");
        rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "blocked_by".into(),
            ))
            .unwrap();
        rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "C".into(),
                "A".into(),
                "relates_to".into(),
            ))
            .unwrap();
        // A's row count = primary blocked_by-B + mirror relates_to-C +
        // mirror blocks-from-B = 3 (the primary relates_to-A from C is
        // the row whose target is A).
        let for_a = rt()
            .block_on(tasks_relations_for_task(
                repo.to_string_lossy().into_owned(),
                "A".into(),
            ))
            .unwrap();
        // Outgoing: A blocked_by B, A relates_to C (mirror).
        // Incoming-as-target: C relates_to A (primary), B blocks A (mirror).
        assert!(for_a.len() >= 3);
        assert!(for_a.iter().any(|r| r.source_id == "A" && r.kind == "blocked_by"));
        assert!(for_a.iter().any(|r| r.target_id == "A" && r.kind == "blocks"));
    }

    #[test]
    fn detach_clears_every_row_touching_task() {
        let repo = tmp_repo("detach");
        rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "B".into(),
                "blocked_by".into(),
            ))
            .unwrap();
        rt()
            .block_on(tasks_relations_create(
                repo.to_string_lossy().into_owned(),
                "A".into(),
                "C".into(),
                "duplicates".into(),
            ))
            .unwrap();
        detach_relations_for(&repo, "A").unwrap();
        let file = load_relations(&repo).unwrap();
        assert!(
            file.relations.iter().all(|r| r.source_id != "A" && r.target_id != "A"),
            "no rows should touch A after detach",
        );
    }
}
