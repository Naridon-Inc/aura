//! Tasks live-sync over the chat rail (#218 / docs/plan/29).
//!
//! `.aura/tasks/tasks.json` is gitignored, so tasks never travel over
//! git — a live rail is the *only* cross-member path. Rather than add a
//! proprietary `aura-cloud` endpoint (which would need a server deploy),
//! task mutations ride the **already-deployed chat rail** as JSON
//! envelopes on a reserved, UI-hidden system channel (`__aura_tasks_sync`).
//! Same room (`effective_room_id` → per-repo), same outbox/retry, same
//! "cloned repo = member" auth — zero cloud change.
//!
//! - **Publish** (automatic): `tasks_create`/`tasks_update`/`tasks_delete`
//!   call `publish_upsert`/`publish_delete` after persisting locally. The
//!   envelope is handed to the shared rail primitive
//!   `cmd_team::persist_and_deliver`.
//! - **Receive**: `tasks_sync_poll` pulls the hidden channel by cloud
//!   `seq` since a per-device cursor, LWW-merges into `tasks.json` via
//!   `cmd_tasks::apply_remote_batch` (direct write — no re-publish loop),
//!   and reports whether anything changed so the UI can refetch.
//!
//! Solo repos stay silent: every entry point gates on
//! `members.len() > 1` (more than one committer in git history) so a lone
//! developer's tasks are never POSTed to the public cloud unprompted.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cmd_tasks::{RemoteOp, Task};

/// Reserved channel slug. `slugify_channel` keeps `_`, so this survives
/// intact; it is never registered in `manifest.channels`, so the chat
/// surface never lists or renders it.
const SYNC_CHANNEL: &str = "__aura_tasks_sync";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// True when this repo is a real team (more than one committer). The
/// chat rail defaults to the public `auravcs.com` origin, so an ungated
/// publish would push a solo developer's tasks to the cloud unprompted.
/// Shared with the pages sync rail (#219) via `cmd_team::team_has_peers`.
fn team_sync_enabled(repo_root: &str) -> bool {
    crate::cmd_team::team_has_peers(repo_root)
}

fn local_device_id(repo_root: &str) -> String {
    crate::cmd_device::effective_identity(Path::new(repo_root))
        .map(|d| d.device_id)
        .unwrap_or_default()
}

// ── Wire format ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct TaskSyncEnvelope {
    #[serde(default = "env_version")]
    v: u8,
    /// "upsert" | "delete".
    op: String,
    /// Full task snapshot — present on `upsert`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task: Option<Task>,
    /// Target id — present on `delete`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    /// Mutation moment (RFC3339) — the LWW key. For `upsert` this mirrors
    /// the task's `updated_at`; for `delete` it's the delete moment.
    #[serde(default)]
    ts: String,
    /// Originating device id — lets the poller skip its own echoes.
    #[serde(default)]
    origin: String,
}

fn env_version() -> u8 {
    1
}

impl TaskSyncEnvelope {
    fn upsert(task: &Task, origin: String) -> Self {
        Self {
            v: 1,
            op: "upsert".to_string(),
            ts: task.updated_at.clone(),
            origin,
            task: Some(task.clone()),
            task_id: None,
        }
    }

    fn delete(id: &str, ts: String, origin: String) -> Self {
        Self {
            v: 1,
            op: "delete".to_string(),
            ts,
            origin,
            task: None,
            task_id: Some(id.to_string()),
        }
    }
}

// ── Publish (called from cmd_tasks after a local write) ─────────────────

fn publish(repo_root: &str, env: &TaskSyncEnvelope) {
    let body = match serde_json::to_string(env) {
        Ok(b) => b,
        Err(_) => return,
    };
    let msg = crate::cmd_team::new_system_message(repo_root, SYNC_CHANNEL, body);
    // Best-effort: the rail's outbox + retry loop owns durability from
    // here, exactly like a chat send. A failure to even enqueue (e.g. an
    // unwritable `.aura/team/`) must never fail the underlying task
    // mutation, which has already been persisted locally.
    let _ = crate::cmd_team::persist_and_deliver(repo_root, msg);
}

/// Broadcast a created/updated task to the team over the live rail.
/// No-op for solo repos.
pub(crate) fn publish_upsert(repo_root: &str, task: &Task) {
    if !team_sync_enabled(repo_root) {
        return;
    }
    let env = TaskSyncEnvelope::upsert(task, local_device_id(repo_root));
    publish(repo_root, &env);
}

/// Broadcast a deletion to the team over the live rail. No-op for solo
/// repos.
pub(crate) fn publish_delete(repo_root: &str, id: &str) {
    if !team_sync_enabled(repo_root) {
        return;
    }
    let env = TaskSyncEnvelope::delete(id, now_iso(), local_device_id(repo_root));
    publish(repo_root, &env);
}

// ── Receive (polled by the frontend) ────────────────────────────────────

#[derive(Default, Serialize, Deserialize)]
struct SyncCursor {
    /// Highest cloud `seq` already consumed from the sync channel.
    #[serde(default)]
    last_seq: i64,
}

fn cursor_path(root: &Path) -> PathBuf {
    root.join(".aura").join("tasks").join("_sync_cursor.json")
}

fn load_cursor(root: &Path) -> SyncCursor {
    std::fs::read(cursor_path(root))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_cursor(root: &Path, cursor: &SyncCursor) {
    let _ = crate::fs_atomic::write_json_pretty(&cursor_path(root), cursor);
}

#[derive(Serialize)]
pub struct TaskSyncPollResult {
    /// True when at least one task was inserted, replaced, or removed —
    /// the signal for the frontend to refetch `tasks_list` (which re-runs
    /// the heal pipeline the direct apply bypasses).
    pub changed: bool,
    pub applied_ids: Vec<String>,
    pub removed_ids: Vec<String>,
    /// Cursor after this poll — surfaced for diagnostics.
    pub next_seq: i64,
}

impl TaskSyncPollResult {
    fn idle(next_seq: i64) -> Self {
        Self {
            changed: false,
            applied_ids: Vec::new(),
            removed_ids: Vec::new(),
            next_seq,
        }
    }
}

/// Pull every task mutation published since the local cursor, apply them
/// LWW into `tasks.json`, advance the cursor, and report what changed.
/// Idempotent: replaying an already-consumed range only redoes
/// no-op LWW merges. No-op for solo repos.
#[tauri::command]
pub async fn tasks_sync_poll(repo_root: String) -> Result<TaskSyncPollResult, String> {
    let root = Path::new(&repo_root);
    if !team_sync_enabled(&repo_root) {
        return Ok(TaskSyncPollResult::idle(0));
    }

    let device_id = local_device_id(&repo_root);
    let cursor = load_cursor(root);
    let since = if cursor.last_seq > 0 {
        Some(cursor.last_seq)
    } else {
        None
    };

    let rows = crate::cmd_team::fetch_channel_since(&repo_root, SYNC_CHANNEL, since).await?;

    let mut max_seq = cursor.last_seq;
    let mut ops: Vec<RemoteOp> = Vec::with_capacity(rows.len());
    for row in &rows {
        if let Some(seq) = row.seq {
            if seq > max_seq {
                max_seq = seq;
            }
        }
        let env: TaskSyncEnvelope = match serde_json::from_str(&row.body) {
            Ok(e) => e,
            Err(_) => continue, // not a task envelope (or a future version) — ignore
        };
        // Skip our own echoes — applying them is harmless (idempotent LWW)
        // but would mark the poll "changed" with no real delta.
        if !env.origin.is_empty() && env.origin == device_id {
            continue;
        }
        match env.op.as_str() {
            "upsert" => {
                if let Some(task) = env.task {
                    ops.push(RemoteOp::Upsert(Box::new(task), env.ts));
                }
            }
            "delete" => {
                if let Some(id) = env.task_id {
                    ops.push(RemoteOp::Delete(id, env.ts));
                }
            }
            _ => {}
        }
    }

    let (applied_ids, removed_ids) = crate::cmd_tasks::apply_remote_batch(root, ops)?;

    if max_seq != cursor.last_seq {
        save_cursor(root, &SyncCursor { last_seq: max_seq });
    }

    let changed = !applied_ids.is_empty() || !removed_ids.is_empty();
    Ok(TaskSyncPollResult {
        changed,
        applied_ids,
        removed_ids,
        next_seq: max_seq,
    })
}
