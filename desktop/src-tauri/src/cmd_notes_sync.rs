//! Pages (notes) live-sync over the chat rail (#219 / docs/plan/30).
//!
//! Pages are plain markdown under `<repoRoot>/.aura/notes/**.md` and — unlike
//! gitignored tasks — are committed to git, so they already travel between
//! members on push/pull. This module adds **real-time** sync on top, reusing
//! the exact substrate #218 built for tasks: shared, shareable note mutations
//! ride the already-deployed chat rail as JSON envelopes on a reserved,
//! UI-hidden system channel (`__aura_pages_sync`). Same room
//! (`effective_room_id` → per-repo), same outbox/retry, same "cloned repo =
//! member" auth — zero cloud change, no server deploy.
//!
//! - **Publish** (automatic): `notes_write` calls `publish_note_upsert` after
//!   persisting; `notes_delete` calls `publish_note_delete` after removing
//!   (reading visibility *before* the unlink). Both gate on the page being
//!   **shared** — private member drafts never broadcast.
//! - **Receive**: `pages_sync_poll` pulls the hidden channel by cloud `seq`
//!   since a per-device cursor, LWW-merges into the notes tree via
//!   `cmd_notes::apply_remote_note_batch` (direct write — no re-publish loop),
//!   and reports whether anything changed so the UI can refetch.
//!
//! Solo repos stay silent: every entry point gates on
//! `cmd_team::team_has_peers` (more than one committer in git history), shared
//! with the tasks rail, so a lone developer's pages are never POSTed to the
//! public cloud unprompted.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cmd_notes::{NoteFrontmatter, NoteScope, RemoteNoteOp};

/// Reserved channel slug. `slugify_channel` keeps `_`, so this survives
/// intact; it is never registered in `manifest.channels`, so the chat surface
/// never lists or renders it. Independent of the tasks channel and its cursor.
const SYNC_CHANNEL: &str = "__aura_pages_sync";

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn local_device_id(repo_root: &str) -> String {
    crate::cmd_device::effective_identity(Path::new(repo_root))
        .map(|d| d.device_id)
        .unwrap_or_default()
}

// ── Wire format ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct NoteSyncEnvelope {
    #[serde(default = "env_version")]
    v: u8,
    /// "upsert" | "delete".
    op: String,
    /// Note scope (team / channel / member) — serializes lowercase.
    scope: NoteScope,
    /// Channel id or member handle; empty for `Team`.
    #[serde(default)]
    bucket: String,
    /// Note id (file stem).
    id: String,
    /// Full on-disk file text (frontmatter sandwich + body) — present on
    /// `upsert`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
    /// Mutation moment (RFC3339) — the LWW key. For `upsert` this mirrors the
    /// note's `updated_at`; for `delete` it's the delete moment.
    #[serde(default)]
    ts: String,
    /// Originating device id — lets the poller skip its own echoes.
    #[serde(default)]
    origin: String,
}

fn env_version() -> u8 {
    1
}

impl NoteSyncEnvelope {
    fn upsert(scope: &NoteScope, bucket: &str, id: &str, raw: &str, ts: String, origin: String) -> Self {
        Self {
            v: 1,
            op: "upsert".to_string(),
            scope: scope.clone(),
            bucket: bucket.to_string(),
            id: id.to_string(),
            raw: Some(raw.to_string()),
            ts,
            origin,
        }
    }

    fn delete(scope: &NoteScope, bucket: &str, id: &str, ts: String, origin: String) -> Self {
        Self {
            v: 1,
            op: "delete".to_string(),
            scope: scope.clone(),
            bucket: bucket.to_string(),
            id: id.to_string(),
            raw: None,
            ts,
            origin,
        }
    }
}

// ── Publish (called from cmd_notes after a local write) ─────────────────

fn publish(repo_root: &str, env: &NoteSyncEnvelope) {
    let body = match serde_json::to_string(env) {
        Ok(b) => b,
        Err(_) => return,
    };
    let msg = crate::cmd_team::new_system_message(repo_root, SYNC_CHANNEL, body);
    // Best-effort: the rail's outbox + retry loop owns durability from here,
    // exactly like a chat send. A failure to even enqueue must never fail the
    // underlying note mutation, which has already been persisted locally.
    let _ = crate::cmd_team::persist_and_deliver(repo_root, msg);
}

/// Broadcast a created/updated page to the team over the live rail. No-op for
/// solo repos and for non-shared pages (private member drafts).
pub(crate) fn publish_note_upsert(
    repo_root: &str,
    scope: &NoteScope,
    bucket: &str,
    id: &str,
    raw: &str,
    fm: &NoteFrontmatter,
) {
    if !crate::cmd_team::team_has_peers(repo_root) {
        return;
    }
    if !crate::cmd_notes::is_shareable(scope, fm) {
        return;
    }
    let ts = fm.updated_at.clone().unwrap_or_else(now_iso);
    let env = NoteSyncEnvelope::upsert(scope, bucket, id, raw, ts, local_device_id(repo_root));
    publish(repo_root, &env);
}

/// Broadcast a page deletion to the team over the live rail. No-op for solo
/// repos. The caller (`notes_delete`) is responsible for the shareability
/// check, since it must read visibility *before* the file is removed.
pub(crate) fn publish_note_delete(repo_root: &str, scope: &NoteScope, bucket: &str, id: &str) {
    if !crate::cmd_team::team_has_peers(repo_root) {
        return;
    }
    let env = NoteSyncEnvelope::delete(scope, bucket, id, now_iso(), local_device_id(repo_root));
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
    root.join(".aura").join("notes").join("_sync_cursor.json")
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
pub struct PageSyncPollResult {
    /// True when at least one page was written or removed — the signal for the
    /// frontend to refetch `notes_list`.
    pub changed: bool,
    pub applied_ids: Vec<String>,
    pub removed_ids: Vec<String>,
    /// Cursor after this poll — surfaced for diagnostics.
    pub next_seq: i64,
}

impl PageSyncPollResult {
    fn idle(next_seq: i64) -> Self {
        Self {
            changed: false,
            applied_ids: Vec::new(),
            removed_ids: Vec::new(),
            next_seq,
        }
    }
}

/// Pull every page mutation published since the local cursor, apply them LWW
/// into the notes tree, advance the cursor, and report what changed.
/// Idempotent: replaying an already-consumed range only redoes no-op LWW
/// merges. No-op for solo repos.
#[tauri::command]
pub async fn pages_sync_poll(repo_root: String) -> Result<PageSyncPollResult, String> {
    let root = Path::new(&repo_root);
    if !crate::cmd_team::team_has_peers(&repo_root) {
        return Ok(PageSyncPollResult::idle(0));
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
    let mut ops: Vec<RemoteNoteOp> = Vec::with_capacity(rows.len());
    for row in &rows {
        if let Some(seq) = row.seq {
            if seq > max_seq {
                max_seq = seq;
            }
        }
        let env: NoteSyncEnvelope = match serde_json::from_str(&row.body) {
            Ok(e) => e,
            Err(_) => continue, // not a page envelope (or a future version) — ignore
        };
        // Skip our own echoes — applying them is harmless (idempotent LWW) but
        // would mark the poll "changed" with no real delta.
        if !env.origin.is_empty() && env.origin == device_id {
            continue;
        }
        match env.op.as_str() {
            "upsert" => {
                if let Some(raw) = env.raw {
                    ops.push(RemoteNoteOp::Upsert {
                        scope: env.scope,
                        bucket: env.bucket,
                        id: env.id,
                        raw,
                        ts: env.ts,
                    });
                }
            }
            "delete" => {
                ops.push(RemoteNoteOp::Delete {
                    scope: env.scope,
                    bucket: env.bucket,
                    id: env.id,
                    ts: env.ts,
                });
            }
            _ => {}
        }
    }

    let (applied_ids, removed_ids) = crate::cmd_notes::apply_remote_note_batch(root, ops)?;

    if max_seq != cursor.last_seq {
        save_cursor(root, &SyncCursor { last_seq: max_seq });
    }

    let changed = !applied_ids.is_empty() || !removed_ids.is_empty();
    Ok(PageSyncPollResult {
        changed,
        applied_ids,
        removed_ids,
        next_seq: max_seq,
    })
}
