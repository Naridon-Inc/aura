//! Tauri commands exposing the op log + undo. The actual writer +
//! inverse implementations live in `op_log.rs`; this file just wires
//! them up to the IPC surface.

use crate::op_log::{apply_undo, read_ops, OpEntry};

#[tauri::command]
pub async fn aura_op_recent(repo_root: String, limit: Option<usize>) -> Result<Vec<OpEntry>, String> {
    let cap = limit.unwrap_or(50).min(500);
    read_ops(&repo_root, cap)
}

/// Undo a specific op by id. If `op_id` is None, undo the most recent
/// op that hasn't already been undone.
#[tauri::command]
pub async fn aura_undo_last(
    repo_root: String,
    op_id: Option<String>,
) -> Result<String, String> {
    let ops = read_ops(&repo_root, 200)?;
    let target = if let Some(id) = op_id {
        ops.into_iter()
            .find(|o| o.op_id == id)
            .ok_or_else(|| format!("no op with id {}", id))?
    } else {
        ops.into_iter()
            .find(|o| o.undone_at.is_none())
            .ok_or_else(|| "no undoable op found".to_string())?
    };
    apply_undo(&repo_root, &target)
}
