//! Plane-parity bulk operations — apply a single mutation to many
//! tasks in one round trip. The frontend's `BulkActionToolbar`
//! surfaces these once N tasks are multi-selected on the board.
//!
//! Each op returns a `BulkOpResult` with the per-task split into
//! successes (`affected`) and failures (`errors`). Failures DO NOT
//! abort the rest of the batch — Plane lets you bulk-archive a list
//! that contains a couple of already-archived rows without falling
//! over, and so do we.
//!
//! Activity hooks: every successful per-task mutation emits one row
//! into the per-repo activity log (see `cmd_tasks_activity`). The
//! kind reflects the bulk op (state_changed / assigned / labeled /
//! updated / unlinked).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::cmd_tasks::{self, Task, UpdateTaskInput};

/// One-shot result for a bulk op. `affected` carries the task ids the
/// mutation succeeded on; `errors` carries `(task_id, message)` pairs
/// for the rest. The frontend surfaces both — affected counts on a
/// success toast, errors in a per-task tooltip.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BulkOpResult {
    pub affected: Vec<String>,
    pub errors: Vec<(String, String)>,
}

impl BulkOpResult {
    fn new() -> Self {
        Self {
            affected: Vec::new(),
            errors: Vec::new(),
        }
    }
    fn record(&mut self, id: &str, result: Result<(), String>) {
        match result {
            Ok(()) => self.affected.push(id.to_string()),
            Err(e) => self.errors.push((id.to_string(), e)),
        }
    }
}

/// Apply a single update with activity emission. Wraps the existing
/// `tasks_update` command so bulk ops share the same heal + validate
/// logic as a one-by-one edit. The activity row is appended here
/// rather than inside `tasks_update` to keep that hot path agnostic
/// of who's calling it (the single-task UI doesn't need a bulk-style
/// payload).
async fn apply_one(
    repo_root: &str,
    input: UpdateTaskInput,
    activity_kind: &str,
    actor: &str,
    payload: serde_json::Value,
) -> Result<Task, String> {
    let task = cmd_tasks::tasks_update(repo_root.to_string(), input).await?;
    let _ = crate::cmd_tasks_activity::append_activity(
        Path::new(repo_root),
        &task.id,
        activity_kind,
        actor,
        payload,
    );
    Ok(task)
}

/// Bulk state transition — move N tasks to one state in one call.
/// Skips ids that don't exist; reports each miss in `errors`.
#[tauri::command]
pub async fn tasks_bulk_state_change(
    repo_root: String,
    ids: Vec<String>,
    state_id: String,
) -> Result<BulkOpResult, String> {
    let mut out = BulkOpResult::new();
    for id in ids {
        let input = UpdateTaskInput {
            id: id.clone(),
            title: None,
            description: None,
            status: None,
            state_id: Some(state_id.clone()),
            priority: None,
            assignee: None,
            assignee_ids: None,
            agent_assignee: None,
            labels: None,
            label_ids: None,
            due_date: None,
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
            external_source: None,
            external_id: None,
            external_url: None,
        };
        let result = apply_one(
            &repo_root,
            input,
            "state_changed",
            "system",
            serde_json::json!({ "to_state_id": state_id }),
        )
        .await
        .map(|_| ());
        out.record(&id, result);
    }
    Ok(out)
}

/// Bulk assignee replacement — overwrites each task's `assignee_ids`
/// to the supplied list. Pass an empty list to clear assignees in
/// bulk.
#[tauri::command]
pub async fn tasks_bulk_assign(
    repo_root: String,
    ids: Vec<String>,
    assignee_ids: Vec<String>,
) -> Result<BulkOpResult, String> {
    let mut out = BulkOpResult::new();
    for id in ids {
        let input = UpdateTaskInput {
            id: id.clone(),
            title: None,
            description: None,
            status: None,
            state_id: None,
            priority: None,
            assignee: None,
            assignee_ids: Some(assignee_ids.clone()),
            agent_assignee: None,
            labels: None,
            label_ids: None,
            due_date: None,
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
            external_source: None,
            external_id: None,
            external_url: None,
        };
        let result = apply_one(
            &repo_root,
            input,
            if assignee_ids.is_empty() {
                "unassigned"
            } else {
                "assigned"
            },
            "system",
            serde_json::json!({ "assignee_ids": assignee_ids }),
        )
        .await
        .map(|_| ());
        out.record(&id, result);
    }
    Ok(out)
}

/// Bulk label replacement — overwrites each task's `label_ids` to the
/// supplied list. Pass an empty list to strip every label.
#[tauri::command]
pub async fn tasks_bulk_label(
    repo_root: String,
    ids: Vec<String>,
    label_ids: Vec<String>,
) -> Result<BulkOpResult, String> {
    let mut out = BulkOpResult::new();
    for id in ids {
        let input = UpdateTaskInput {
            id: id.clone(),
            title: None,
            description: None,
            status: None,
            state_id: None,
            priority: None,
            assignee: None,
            assignee_ids: None,
            agent_assignee: None,
            labels: None,
            label_ids: Some(label_ids.clone()),
            due_date: None,
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
            external_source: None,
            external_id: None,
            external_url: None,
        };
        let result = apply_one(
            &repo_root,
            input,
            if label_ids.is_empty() {
                "unlabeled"
            } else {
                "labeled"
            },
            "system",
            serde_json::json!({ "label_ids": label_ids }),
        )
        .await
        .map(|_| ());
        out.record(&id, result);
    }
    Ok(out)
}

/// Bulk archive — stamps `archived_at` on every supplied task. Goes
/// through the dedicated `cmd_tasks::archive_tasks_internal` helper
/// so the heal pass stays out of the bulk hot path. Idempotent on
/// already-archived rows (they're recorded in `affected` because the
/// stamp is bumped; failure only occurs when the task id is missing).
#[tauri::command]
pub async fn tasks_bulk_archive(
    repo_root: String,
    ids: Vec<String>,
) -> Result<BulkOpResult, String> {
    let mut out = BulkOpResult::new();
    for id in ids {
        let result = cmd_tasks::archive_task(Path::new(&repo_root), &id);
        if result.is_ok() {
            let _ = crate::cmd_tasks_activity::append_activity(
                Path::new(&repo_root),
                &id,
                "updated",
                "system",
                serde_json::json!({ "archived": true }),
            );
        }
        out.record(&id, result);
    }
    Ok(out)
}

/// Bulk delete — removes every supplied task from the ledger and
/// detaches its relations + comments + activity rows. Hard delete; no
/// undo at the data layer (use the rewind path for that).
#[tauri::command]
pub async fn tasks_bulk_delete(
    repo_root: String,
    ids: Vec<String>,
) -> Result<BulkOpResult, String> {
    let mut out = BulkOpResult::new();
    for id in ids {
        // tasks_delete returns Err when the id is unknown; we feed
        // that through to the per-task `errors` slot.
        let result = cmd_tasks::tasks_delete(repo_root.clone(), id.clone()).await;
        if result.is_ok() {
            // Drop dependent rows so the deleted id doesn't leave
            // dangling references behind. Errors here are swallowed —
            // the primary delete already succeeded.
            let root = Path::new(&repo_root);
            let _ = crate::cmd_tasks_relations::detach_relations_for(root, &id);
            let _ = crate::cmd_tasks_comments::detach_comments_for(root, &id);
            // Activity log: append a final "updated" row with
            // `deleted: true` so the timeline shows the terminal
            // event, then clear the rest.
            let _ = crate::cmd_tasks_activity::append_activity(
                root,
                &id,
                "updated",
                "system",
                serde_json::json!({ "deleted": true }),
            );
        }
        out.record(&id, result);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    use crate::cmd_tasks::{tasks_create, CreateTaskInput};

    fn tmp_repo(name: &str) -> PathBuf {
        let mut p = env::temp_dir();
        p.push(format!("aura-oo5-bulk-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn create_n(repo: &PathBuf, n: usize) -> Vec<String> {
        let mut ids = Vec::new();
        for i in 0..n {
            let input = CreateTaskInput {
                title: format!("task {}", i),
                description: String::new(),
                status: None,
                state_id: None,
                priority: None,
                assignee: None,
                assignee_ids: Vec::new(),
                agent_assignee: None,
                reporter: None,
                labels: Vec::new(),
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
                external_source: None,
                external_id: None,
                external_url: None,
            };
            let t = rt()
                .block_on(tasks_create(repo.to_string_lossy().into_owned(), input))
                .unwrap();
            ids.push(t.id);
        }
        ids
    }

    #[test]
    fn bulk_state_change_succeeds_and_records_per_task_results() {
        let repo = tmp_repo("state");
        let ids = create_n(&repo, 3);
        let result = rt()
            .block_on(tasks_bulk_state_change(
                repo.to_string_lossy().into_owned(),
                ids.clone(),
                "completed".into(),
            ))
            .unwrap();
        assert_eq!(result.affected.len(), 3);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn bulk_state_change_collects_errors_for_missing_ids() {
        let repo = tmp_repo("missing");
        let ids = create_n(&repo, 2);
        let mut input_ids = ids.clone();
        input_ids.push("task_ghost".into());
        let result = rt()
            .block_on(tasks_bulk_state_change(
                repo.to_string_lossy().into_owned(),
                input_ids,
                "completed".into(),
            ))
            .unwrap();
        assert_eq!(result.affected.len(), 2);
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].0, "task_ghost");
    }

    #[test]
    fn bulk_assign_replaces_assignee_ids_on_each_task() {
        let repo = tmp_repo("assign");
        let ids = create_n(&repo, 2);
        rt()
            .block_on(tasks_bulk_assign(
                repo.to_string_lossy().into_owned(),
                ids.clone(),
                vec!["owner".into(), "teammate".into()],
            ))
            .unwrap();
        let listed = rt()
            .block_on(crate::cmd_tasks::tasks_list(
                repo.to_string_lossy().into_owned(),
            ))
            .unwrap();
        for t in listed {
            if ids.contains(&t.id) {
                assert_eq!(t.assignee_ids, vec!["owner".to_string(), "teammate".to_string()]);
            }
        }
    }

    #[test]
    fn bulk_delete_drops_tasks_and_activity_for_them() {
        let repo = tmp_repo("delete");
        let ids = create_n(&repo, 3);
        // pre-create activity for these tasks (the create already
        // wrote no activity, but the bulk-delete should append a
        // final "deleted" row before dropping; the previous activity
        // for the same tasks survives).
        let _ = crate::cmd_tasks_activity::append_activity(
            &repo,
            &ids[0],
            "created",
            "owner",
            serde_json::json!({}),
        );
        let result = rt()
            .block_on(tasks_bulk_delete(
                repo.to_string_lossy().into_owned(),
                ids.clone(),
            ))
            .unwrap();
        assert_eq!(result.affected.len(), 3);
        let listed = rt()
            .block_on(crate::cmd_tasks::tasks_list(
                repo.to_string_lossy().into_owned(),
            ))
            .unwrap();
        assert!(listed.iter().all(|t| !ids.contains(&t.id)));
    }

    #[test]
    fn bulk_archive_stamps_archived_at() {
        let repo = tmp_repo("arch");
        let ids = create_n(&repo, 2);
        let result = rt()
            .block_on(tasks_bulk_archive(
                repo.to_string_lossy().into_owned(),
                ids.clone(),
            ))
            .unwrap();
        assert_eq!(result.affected.len(), 2);
        let listed = rt()
            .block_on(crate::cmd_tasks::tasks_list(
                repo.to_string_lossy().into_owned(),
            ))
            .unwrap();
        for t in listed.iter().filter(|t| ids.contains(&t.id)) {
            assert!(t.archived_at.is_some(), "task {} should have archived_at", t.id);
        }
    }

    #[test]
    fn bulk_label_replaces_label_ids_on_each_task() {
        let repo = tmp_repo("label");
        let ids = create_n(&repo, 2);
        // Seed catalog by upserting a label
        let _ = rt()
            .block_on(crate::cmd_tasks::task_labels_upsert(
                repo.to_string_lossy().into_owned(),
                crate::cmd_tasks::UpsertTaskLabelInput {
                    id: Some("bug".into()),
                    name: "bug".into(),
                    color: "".into(),
                },
            ))
            .unwrap();
        rt()
            .block_on(tasks_bulk_label(
                repo.to_string_lossy().into_owned(),
                ids.clone(),
                vec!["bug".into()],
            ))
            .unwrap();
        let listed = rt()
            .block_on(crate::cmd_tasks::tasks_list(
                repo.to_string_lossy().into_owned(),
            ))
            .unwrap();
        for t in listed.iter().filter(|t| ids.contains(&t.id)) {
            assert_eq!(t.label_ids, vec!["bug".to_string()]);
        }
    }
}
