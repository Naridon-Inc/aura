//! Send-once ledger for task / page notifications.
//!
//! Every notification we deliver is keyed by `(item_kind, item_id, target,
//! reason)`. A task re-save, a page re-edit, or a redundant assignment
//! must never re-DM someone who was already told — so before sending we
//! check this append-only ledger, and after a successful send we record
//! the key. The store lives at `<repo_root>/.aura/notifications/sent.jsonl`,
//! one JSON object per line.
//!
//! Everything here is best-effort: a missing directory is created, a
//! missing or corrupt file is treated as empty, and IO failures never
//! panic. The cost of a false "not sent" (a duplicate DM) is mild; the
//! cost of a crash in the notify path is not — so we bias to never
//! crashing.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The dedup identity of a single notification. Two notifications with
/// the same key are "the same event" and must be sent at most once.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LedgerKey {
    /// "task" | "page".
    pub item_kind: String,
    /// Task id, or the `<scope>/<bucket>/<id>` path for a page.
    pub item_id: String,
    /// The recipient's roster handle (lowercased by the caller).
    pub target: String,
    /// "assigned" | "mentioned".
    pub reason: String,
}

/// One persisted row: a `LedgerKey` plus the unix second it was written.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LedgerRow {
    item_kind: String,
    item_id: String,
    target: String,
    reason: String,
    ts: i64,
}

impl LedgerRow {
    fn matches(&self, key: &LedgerKey) -> bool {
        self.item_kind == key.item_kind
            && self.item_id == key.item_id
            && self.target == key.target
            && self.reason == key.reason
    }
}

/// `<repo_root>/.aura/notifications`.
fn ledger_dir(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".aura").join("notifications")
}

/// `<repo_root>/.aura/notifications/sent.jsonl`.
fn ledger_path(repo_root: &str) -> PathBuf {
    ledger_dir(repo_root).join("sent.jsonl")
}

/// True if a notification with this exact key was already recorded.
/// A missing or unreadable file means "nothing sent yet" → `false`.
pub fn already_sent(repo_root: &str, key: &LedgerKey) -> bool {
    let path = ledger_path(repo_root);
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A single corrupt line never aborts the scan — we skip it and
        // keep looking, so a partially-written tail can't mask earlier
        // legitimate sends.
        if let Ok(row) = serde_json::from_str::<LedgerRow>(line) {
            if row.matches(key) {
                return true;
            }
        }
    }
    false
}

/// Append a row recording that `key` was sent now. Creates the parent
/// directory if needed. Returns the IO error if the append genuinely
/// fails so the caller can log it, but the notify path treats a failure
/// as non-fatal (the worst case is a future duplicate DM).
pub fn record(repo_root: &str, key: &LedgerKey) -> std::io::Result<()> {
    let dir = ledger_dir(repo_root);
    fs::create_dir_all(&dir)?;
    let row = LedgerRow {
        item_kind: key.item_kind.clone(),
        item_id: key.item_id.clone(),
        target: key.target.clone(),
        reason: key.reason.clone(),
        ts: chrono::Utc::now().timestamp(),
    };
    let line = serde_json::to_string(&row)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(ledger_path(repo_root))?;
    writeln!(f, "{line}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_repo() -> PathBuf {
        let mut p = std::env::temp_dir();
        let unique = format!("aura-notify-ledger-{}", uuid::Uuid::new_v4());
        p.push(unique);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn key(target: &str, reason: &str) -> LedgerKey {
        LedgerKey {
            item_kind: "task".into(),
            item_id: "AURA-1".into(),
            target: target.into(),
            reason: reason.into(),
        }
    }

    #[test]
    fn missing_file_is_empty() {
        let repo = tmp_repo();
        assert!(!already_sent(repo.to_str().unwrap(), &key("alice", "assigned")));
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn record_then_seen() {
        let repo = tmp_repo();
        let root = repo.to_str().unwrap();
        let k = key("alice", "assigned");
        assert!(!already_sent(root, &k));
        record(root, &k).unwrap();
        assert!(already_sent(root, &k));
        // A different target/reason for the same item is NOT deduped.
        assert!(!already_sent(root, &key("bob", "assigned")));
        assert!(!already_sent(root, &key("alice", "mentioned")));
        fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn corrupt_line_is_skipped() {
        let repo = tmp_repo();
        let root = repo.to_str().unwrap();
        let k = key("carol", "mentioned");
        record(root, &k).unwrap();
        // Append garbage; the good row must still resolve.
        let mut f = OpenOptions::new()
            .append(true)
            .open(ledger_path(root))
            .unwrap();
        writeln!(f, "{{ not valid json").unwrap();
        drop(f);
        assert!(already_sent(root, &k));
        fs::remove_dir_all(&repo).ok();
    }
}
