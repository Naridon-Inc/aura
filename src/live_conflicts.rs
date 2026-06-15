//! CLI-side writer for the first-class conflict store (`.aura/conflicts.jsonl`).
//!
//! The desktop owns the rich resolver (aura-shell `cmd_conflicts.rs`); this is
//! the *append* half the live-sync engine needs when it detects two peers
//! editing the same AST node. The JSON shape is kept byte-compatible with the
//! shell's `ConflictedNode` so the Conflicts surface reads CLI-written rows
//! without a translation layer.
//!
//! Why this exists: once whole-file CRDT is the disk writer
//! (`crdt_daemon::live_crdt_enabled`), the function-body pull no longer splices
//! files. A *same-function* divergence (both peers edited one logic node off
//! the same parent) must not be silently merged across a logic boundary by the
//! character-level CRDT — it is recorded here as a durable conflict for a human
//! to resolve. This is the "conflicts before they come" half of the engine.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;

/// Mirrors `aura-shell` `cmd_conflicts::ConflictedNode` field-for-field so a row
/// written here deserializes there unchanged.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictedNode {
    pub id: String,
    pub file: String,
    pub identifier: String,
    pub base_hash: String,
    pub ours: String,
    pub theirs: String,
    pub ours_agent: String,
    pub theirs_agent: String,
    pub opened_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_in_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution_body: Option<String>,
}

fn store_path() -> PathBuf {
    PathBuf::from(".aura").join("conflicts.jsonl")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_all() -> Vec<ConflictedNode> {
    let Ok(body) = fs::read_to_string(store_path()) else {
        return Vec::new();
    };
    body.lines()
        .filter_map(|l| {
            let t = l.trim();
            if t.is_empty() {
                None
            } else {
                serde_json::from_str::<ConflictedNode>(t).ok()
            }
        })
        .collect()
}

fn write_all(nodes: &[ConflictedNode]) -> bool {
    let path = store_path();
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let Ok(mut f) = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
        else {
            return false;
        };
        for node in nodes {
            let Ok(line) = serde_json::to_string(node) else {
                return false;
            };
            if writeln!(f, "{line}").is_err() {
                return false;
            }
        }
        let _ = f.sync_all();
    }
    fs::rename(&tmp, &path).is_ok()
}

/// Record a same-node divergence as a durable conflict. Deduplicates against an
/// existing *open* conflict on the same `(file, identifier, base_hash)` — Live
/// Sync re-pulls the same divergence each cycle, so this would otherwise spam
/// the store. Returns `true` only when a new row was written.
#[allow(clippy::too_many_arguments)]
pub fn record_conflict(
    file: &str,
    identifier: &str,
    base_hash: &str,
    ours: &str,
    theirs: &str,
    ours_agent: &str,
    theirs_agent: &str,
) -> bool {
    let mut nodes = read_all();
    if nodes.iter().any(|n| {
        n.resolved_at.is_none()
            && n.file == file
            && n.identifier == identifier
            && n.base_hash == base_hash
    }) {
        return false;
    }
    nodes.push(ConflictedNode {
        id: Uuid::new_v4().to_string(),
        file: file.to_string(),
        identifier: identifier.to_string(),
        base_hash: base_hash.to_string(),
        ours: ours.to_string(),
        theirs: theirs.to_string(),
        ours_agent: ours_agent.to_string(),
        theirs_agent: theirs_agent.to_string(),
        opened_at: now_secs(),
        resolved_at: None,
        resolved_in_commit: None,
        resolution_body: None,
    });
    write_all(&nodes)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared with every other cwd-mutating test in the crate (stores are
    // cwd-relative); separate mutexes would let them race on the process cwd.
    use crate::TEST_CWD_LOCK as SERIAL;

    struct CwdGuard(PathBuf);
    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn enter_tmp() -> (CwdGuard, tempfile::TempDir) {
        let g = CwdGuard(std::env::current_dir().expect("cwd"));
        let d = tempfile::tempdir().expect("tmp");
        std::env::set_current_dir(d.path()).expect("cd");
        (g, d)
    }

    #[test]
    fn dedupes_open_conflicts_but_records_new_base() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (_g, _d) = enter_tmp();

        assert!(record_conflict("a.rs", "login", "h0", "x", "y", "me", "bob"));
        // Same (file, identifier, base) while still open → no new row.
        assert!(!record_conflict("a.rs", "login", "h0", "x2", "y2", "me", "bob"));
        // A different base hash is a genuinely new divergence.
        assert!(record_conflict("a.rs", "login", "h1", "x", "z", "me", "bob"));

        let rows = read_all();
        assert_eq!(rows.len(), 2, "expected two distinct conflicts: {rows:?}");
        assert!(rows.iter().all(|r| r.resolved_at.is_none()));
        assert!(rows.iter().any(|r| r.theirs == "y" && r.base_hash == "h0"));
        assert!(rows.iter().any(|r| r.theirs == "z" && r.base_hash == "h1"));
    }
}
