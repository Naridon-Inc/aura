//! Removing a Manager task's own copy of the project once the user is done
//! with it.

use tauri::{AppHandle, State};

use super::{ensure_attached, save_and_kick, ManagerRuntime};
use crate::manager::worktree::{self, TaskCopyRemoval};
use crate::manager::ManagerTaskStatus;

/// Remove task `task_id`'s copy (see `manager::worktree::remove`) and forget
/// it on the task. A running task keeps its copy. Without `force`, a copy
/// that still holds unsaved work comes back as `Kept` with that work listed;
/// `force` is the user's go-ahead after reading it.
#[tauri::command]
pub async fn manager_remove_task_worktree(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    task_id: usize,
    force: bool,
) -> Result<TaskCopyRemoval, String> {
    let state = ensure_attached(&runtime, &session_id).await?;
    let (repo_root, path) = {
        let s = state.lock().unwrap();
        let task = s.task(task_id).ok_or_else(|| format!("no task #{task_id} in this session"))?;
        if task.status == ManagerTaskStatus::Running {
            return Err(format!("task #{task_id} is still running in its copy"));
        }
        let path = task
            .worktree_path
            .clone()
            .ok_or_else(|| format!("task #{task_id} has no copy of its own"))?;
        (task.project_root.clone(), path)
    };

    let outcome = crate::blocking::run(move || worktree::remove(&repo_root, &path, force)).await?;
    if outcome == TaskCopyRemoval::Removed {
        {
            let mut s = state.lock().unwrap();
            if let Some(task) = s.task_mut(task_id) {
                task.worktree_path = None;
            }
            s.touch();
        }
        save_and_kick(&app, &runtime, &session_id).await;
    }
    Ok(outcome)
}
