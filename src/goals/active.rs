//! Which task is the work *for* right now?
//!
//! The spine needs to know the active task so a commit can re-prove the goals
//! that task is meant to deliver, and so the intent log can record which task
//! a change served. We resolve it cheaply, in priority order:
//!
//! 1. An explicit `.aura/active_task` marker (a task id, `AURA-<n>`, or bare
//!    number) — written when an agent claims a task or the app focuses one.
//! 2. The branch name — `feat/AURA-42-google-signin` → AURA-42.
//! 3. The newest `in_progress` task on the board — the de-facto current work.
//!
//! Every path normalizes through the board so we always return the canonical
//! `(task_uuid, AURA-seq)`. Returns `None` when nothing resolves — callers
//! treat that as "no active task", never an error.

use std::path::Path;

use serde_json::Value;

/// The active task as `(task_uuid, Some(AURA_seq))`, or `None`.
pub fn resolve(root: &Path) -> Option<(String, Option<u64>)> {
    marker(root)
        .or_else(|| branch(root))
        .or_else(|| newest_in_progress(root))
}

/// `.aura/active_task` — a task ref a human or agent pinned. Trimmed; blank =
/// no marker.
fn marker(root: &Path) -> Option<(String, Option<u64>)> {
    let p = root.join(".aura").join("active_task");
    let raw = std::fs::read_to_string(&p).ok()?;
    let r = raw.trim();
    if r.is_empty() {
        return None;
    }
    task_tuple(root, r)
}

/// Parse `AURA-<n>` out of the current branch name (case-insensitive).
fn branch(root: &Path) -> Option<(String, Option<u64>)> {
    let repo = git2::Repository::open(root).ok()?;
    let head = repo.head().ok()?;
    let name = head.shorthand()?;
    let seq = parse_aura_seq(name)?;
    task_tuple(root, &format!("AURA-{}", seq))
}

/// The newest `in_progress` task — the current work when nothing's pinned.
fn newest_in_progress(root: &Path) -> Option<(String, Option<u64>)> {
    let tasks = crate::board::list_tasks(root, Some("in_progress"), 1).ok()?;
    let t = tasks.first()?;
    let uuid = t.get("id").and_then(Value::as_str)?.to_string();
    let seq = t.get("sequence_id").and_then(Value::as_u64);
    Some((uuid, seq))
}

/// Normalize any task ref (uuid / `AURA-n` / bare number) to `(uuid, seq)` via
/// the board.
fn task_tuple(root: &Path, task_ref: &str) -> Option<(String, Option<u64>)> {
    let task = crate::board::get_task(root, task_ref).ok().flatten()?;
    let uuid = task.get("id").and_then(Value::as_str)?.to_string();
    let seq = task.get("sequence_id").and_then(Value::as_u64);
    Some((uuid, seq))
}

/// Find `AURA-<digits>` anywhere in `s`, case-insensitive, return the number.
/// No regex dep — a small hand scan.
pub fn parse_aura_seq(s: &str) -> Option<u64> {
    let lower = s.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let needle = b"aura-";
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let mut j = i + needle.len();
            let start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > start {
                if let Ok(n) = lower[start..j].parse::<u64>() {
                    return Some(n);
                }
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aura_seq_from_branch_names() {
        assert_eq!(parse_aura_seq("feat/AURA-42-google-signin"), Some(42));
        assert_eq!(parse_aura_seq("aura-7"), Some(7));
        assert_eq!(parse_aura_seq("AURA-1234"), Some(1234));
        assert_eq!(parse_aura_seq("bugfix/login"), None);
        assert_eq!(parse_aura_seq("AURA-"), None);
        assert_eq!(parse_aura_seq("master"), None);
        // First match wins when multiple are present.
        assert_eq!(parse_aura_seq("AURA-3-then-AURA-9"), Some(3));
    }
}
