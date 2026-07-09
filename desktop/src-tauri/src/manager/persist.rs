//! Disk persistence for ManagerSession.
//!
//! Sessions live at `~/.aura/manager-sessions/<sid>.json`. Atomic writes
//! via tempfile + rename so a crash mid-flush leaves the previous JSON
//! intact. Listed via `list_session_ids()` on shell startup so the UI
//! can re-attach to in-flight sessions.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use super::ManagerSession;

/// mtime-gated parse cache, keyed by session id → (mtime_nanos, len, session).
/// `manager_list` (which the Trace/Sessions pane fires on every open) reads and
/// JSON-parses every off-runtime session file from `~/.aura/manager-sessions/`;
/// for a user with many past sessions that is the bulk of the list cost. Gating
/// on (mtime, len) makes a repeat list against unchanged files a pure clone, yet
/// `save()`'s atomic tempfile+rename moves both mtime and len, so a mutated
/// session re-parses on the next load. The healed `pending_plan` is cached too,
/// so the heal pass also only runs on a miss.
#[allow(clippy::type_complexity)]
fn load_cache() -> &'static Mutex<HashMap<String, (u128, u64, ManagerSession)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u128, u64, ManagerSession)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// (mtime as unix-epoch nanos, byte length) used to validate the load cache.
fn file_stamp(path: &Path) -> Option<(u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

pub fn sessions_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("manager-sessions");
    Some(p)
}

fn session_path(id: &str) -> Option<PathBuf> {
    let mut p = sessions_dir()?;
    p.push(format!("{id}.json"));
    Some(p)
}

pub fn save(session: &ManagerSession) -> Result<(), String> {
    let dir = sessions_dir().ok_or("HOME not set")?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = session_path(&session.id).ok_or("HOME not set")?;
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| format!("serialize: {e}"))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .suffix(".json")
        .tempfile_in(&dir)
        .map_err(|e| format!("tempfile: {e}"))?;
    tmp.write_all(json.as_bytes())
        .map_err(|e| format!("write tempfile: {e}"))?;
    tmp.persist(&path)
        .map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(())
}

pub fn load(id: &str) -> Result<ManagerSession, String> {
    let path = session_path(id).ok_or("HOME not set")?;
    let stamp = file_stamp(&path);
    if let Some(stamp) = stamp {
        if let Ok(cache) = load_cache().lock() {
            if let Some((mtime, len, session)) = cache.get(id) {
                if (*mtime, *len) == stamp {
                    return Ok(session.clone());
                }
            }
        }
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut session: ManagerSession = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    // Inventory blocker #3 — heal the approved_by/approved_at pair on
    // read so half-written rows (older shells, hand-edited JSON, merge
    // artefacts) can't surface to the UI in an inconsistent state.
    if let Some(plan) = session.pending_plan.as_mut() {
        plan.heal_approval();
    }
    if let Some((mtime, len)) = stamp {
        if let Ok(mut cache) = load_cache().lock() {
            cache.insert(id.to_string(), (mtime, len, session.clone()));
        }
    }
    Ok(session)
}

pub fn list_session_ids() -> Vec<String> {
    let Some(dir) = sessions_dir() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ManagerSession, ManagerTask, ManagerTaskStatus};

    fn task(id: usize) -> ManagerTask {
        ManagerTask {
            id,
            description: "t".into(),
            agent_id: Some("claude".into()),
            depends_on: vec![],
            status: ManagerTaskStatus::Pending,
            project_root: "/tmp".into(),
            zones: vec![],
            blocked_reason: None,
            output: String::new(),
            summary: None,
            started_at: None,
            completed_at: None,
            stream_channel: None,
            worktree_path: None,
            a2a_task_id: None,
            pre_dispatch_snapshot_ids: Vec::new(),
            recent_output: Vec::new(),
            line_count: 0,
            pending_skill: None,
        }
    }

    #[test]
    fn round_trip() {
        // Re-point HOME at a tempdir so this test doesn't pollute the
        // real `~/.aura/manager-sessions/`.
        let tmp = tempfile::tempdir().unwrap();
        // Note: set_var is process-global; tests in this module run
        // sequentially under default cargo test, so this is OK in
        // isolation but flaky under --test-threads=N. The `serial`
        // marker would harden this; keeping it simple for now.
        unsafe { std::env::set_var("HOME", tmp.path()) };

        let s = ManagerSession::new("abc".into(), "obj".into(), vec![], vec![task(1)]);
        save(&s).unwrap();
        let loaded = load("abc").unwrap();
        assert_eq!(loaded.id, "abc");
        assert_eq!(loaded.tasks.len(), 1);
        assert!(list_session_ids().contains(&"abc".to_string()));
    }
}
