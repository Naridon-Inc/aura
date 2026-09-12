//! Why an agent is about to change a file, held between the decision and the edit.
//!
//! Aura already records *what* happened to every file: the post-tool-use hook
//! logs an intent row carrying the tool, the path and the session. What it
//! could not record was *why*, because the two halves happen at different
//! moments and nothing carried state between them:
//!
//! ```text
//!   agent decides ──▶ aura_snapshot(file, why)   ← the reason exists here
//!   agent edits   ──▶ (the tool runs)
//!   hook fires    ──▶ aura log-intent --file …   ← the row is written here
//! ```
//!
//! So a reason stated at snapshot time is parked here and claimed by the row
//! that follows. The result is one short note per file per change, in the same
//! log `aura why` already reads — rather than a paragraph per commit, which is
//! all a reviewer asking about one line used to get.
//!
//! Three rules keep the record honest:
//!
//! * **A reason is consumed once.** Attaching one note to two different edits
//!   would make the second row say something nobody claimed about it.
//! * **A reason expires.** A stale note pulled onto an unrelated edit an hour
//!   later is worse than no note at all; past [`TTL`] it is dropped.
//! * **Nothing here is load-bearing.** Every path is best effort: a missing,
//!   corrupt or unwritable store costs the reason, never the edit and never
//!   the intent row.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a stated reason stays claimable.
///
/// Long enough to survive an agent that snapshots a set of files and then works
/// through them, short enough that a note never lands on a change made in a
/// different sitting.
const TTL: u64 = 30 * 60;

/// One stated reason, waiting for the edit it describes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Reason {
    /// What the agent said it was about to do to this file, and why.
    pub why: String,
    /// Unix seconds the reason was stated.
    pub at: u64,
    /// The agent conversation it was stated in, when the caller knew it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn store_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".aura").join("edit_reasons.json")
}

/// The key a reason is filed under: the path as the repository sees it.
///
/// The two sides of this exchange spell paths differently — a snapshot call
/// tends to carry an absolute path, the hook passes one relative to wherever
/// the agent happened to be running. Both are reduced to the same
/// repo-relative form so they meet.
pub fn key_for(repo_root: &Path, file: &str) -> String {
    let raw = Path::new(file);
    let absolute = if raw.is_absolute() { raw.to_path_buf() } else { repo_root.join(raw) };
    // `canonicalize` resolves `..` and symlinks but needs the file to exist —
    // which it does not, for a file the agent is about to create.
    let resolved = absolute.canonicalize().unwrap_or(absolute);
    let root = repo_root.canonicalize().unwrap_or_else(|_| repo_root.to_path_buf());
    resolved
        .strip_prefix(&root)
        .unwrap_or(&resolved)
        .to_string_lossy()
        .trim_start_matches('/')
        .to_string()
}

fn load(repo_root: &Path) -> BTreeMap<String, Reason> {
    let Ok(text) = std::fs::read_to_string(store_path(repo_root)) else {
        return BTreeMap::new();
    };
    let mut map: BTreeMap<String, Reason> = serde_json::from_str(&text).unwrap_or_default();
    let cutoff = now().saturating_sub(TTL);
    map.retain(|_, r| r.at >= cutoff);
    map
}

fn save(repo_root: &Path, map: &BTreeMap<String, Reason>) {
    let path = store_path(repo_root);
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(map) else {
        return;
    };
    // Write beside and rename: several hooks can fire at once, and a reader
    // must never see half a file.
    let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Park the reason an agent gave for touching a file.
///
/// Re-stating a reason for the same file replaces the previous one: the newest
/// statement is the one describing the edit that is about to happen.
pub fn record(repo_root: &Path, file: &str, why: &str, session: Option<&str>) {
    let why = why.trim();
    if why.is_empty() {
        return;
    }
    let mut map = load(repo_root);
    map.insert(
        key_for(repo_root, file),
        Reason {
            why: why.to_string(),
            at: now(),
            session: session.map(|s| s.to_string()).filter(|s| !s.is_empty()),
        },
    );
    save(repo_root, &map);
}

/// Claim the reason for a file, removing it so no later edit can reuse it.
pub fn take(repo_root: &Path, file: &str) -> Option<Reason> {
    let mut map = load(repo_root);
    let found = map.remove(&key_for(repo_root, file));
    // Save even on a miss: loading pruned expired entries, and dropping them is
    // the point of the pass.
    save(repo_root, &map);
    found
}

/// Every reason still waiting to be claimed, newest first.
///
/// For a person asking what an agent is in the middle of, and for `aura status`
/// to say so.
pub fn pending(repo_root: &Path) -> Vec<(String, Reason)> {
    let mut all: Vec<(String, Reason)> = load(repo_root).into_iter().collect();
    all.sort_by(|a, b| b.1.at.cmp(&a.1.at));
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".aura")).unwrap();
        dir
    }

    #[test]
    fn a_reason_is_claimed_once_and_then_gone() {
        // The second edit of the same file did not state a reason, and must not
        // inherit the first one's — a row that borrows someone else's
        // explanation is a false record, not a helpful one.
        let dir = repo();
        record(dir.path(), "src/main.rs", "swap the retry to exponential backoff", Some("s1"));

        let first = take(dir.path(), "src/main.rs").expect("the reason just stated");
        assert_eq!(first.why, "swap the retry to exponential backoff");
        assert_eq!(first.session.as_deref(), Some("s1"));
        assert!(take(dir.path(), "src/main.rs").is_none(), "claimed once");
    }

    #[test]
    fn an_absolute_and_a_relative_path_are_the_same_file() {
        // The snapshot call and the hook spell the path differently. If they
        // did not meet here, every reason would be stated and never claimed.
        let dir = repo();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();

        let absolute = dir.path().join("src/main.rs").to_string_lossy().to_string();
        record(dir.path(), &absolute, "tighten the parse", None);
        assert!(take(dir.path(), "src/main.rs").is_some(), "found by its repo-relative name");
    }

    #[test]
    fn a_file_that_does_not_exist_yet_still_gets_a_key() {
        // The reason for creating a file is stated before the file exists, so
        // the key cannot depend on canonicalising it.
        let dir = repo();
        record(dir.path(), "src/brand_new.rs", "add the dialect for Kimi", None);
        assert_eq!(
            take(dir.path(), "src/brand_new.rs").map(|r| r.why),
            Some("add the dialect for Kimi".to_string())
        );
    }

    #[test]
    fn a_stale_reason_is_dropped_rather_than_attached_to_a_later_edit() {
        let dir = repo();
        let stale = BTreeMap::from([(
            "src/old.rs".to_string(),
            Reason { why: "from another sitting".into(), at: now() - TTL - 60, session: None },
        )]);
        save(dir.path(), &stale);
        assert!(take(dir.path(), "src/old.rs").is_none(), "expired, so not claimable");
    }

    #[test]
    fn restating_a_reason_replaces_it() {
        let dir = repo();
        record(dir.path(), "src/main.rs", "first thought", None);
        record(dir.path(), "src/main.rs", "what I actually did", None);
        assert_eq!(take(dir.path(), "src/main.rs").map(|r| r.why), Some("what I actually did".into()));
    }

    #[test]
    fn an_empty_reason_records_nothing() {
        // Better an intent row that says only what happened than one that
        // claims a reason nobody gave.
        let dir = repo();
        record(dir.path(), "src/main.rs", "   ", None);
        assert!(take(dir.path(), "src/main.rs").is_none());
        assert!(pending(dir.path()).is_empty());
    }

    #[test]
    fn a_corrupt_store_costs_the_reason_and_nothing_else() {
        let dir = repo();
        std::fs::write(store_path(dir.path()), "{not json").unwrap();
        assert!(take(dir.path(), "src/main.rs").is_none());
        // And it recovers: the next statement writes a clean store.
        record(dir.path(), "src/main.rs", "carry on", None);
        assert_eq!(take(dir.path(), "src/main.rs").map(|r| r.why), Some("carry on".into()));
    }
}
