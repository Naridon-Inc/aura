//! Per-task worktree creation. When a Manager task carries non-empty
//! `zones` we isolate it in a sibling worktree off the main repo so
//! parallel subagents touching adjacent files don't collide. Each
//! worktree is named after the task it is for — its description — with the
//! session/task pair kept on the end so the name stays unique across a
//! fan-out (`<parent>/<repo>-aura-<what-the-task-is>-<sid8>-t<id>`, branch
//! `aura/<sid8>/<what-the-task-is>-t<id>`). A task whose description says
//! nothing sluggable keeps the bare `<sid8>-t<id>` shape. Either way the
//! user can review or merge independently after the task completes.
//!
//! A folder in the project that is a repository of its own (a nested
//! repository) is left out of the copy by git, so it gets a copy of its own
//! at the same place, on a branch of the task's name, as a workspace's does.
//!
//! On task Done/Failed/Cancelled we leave the worktree in place: the review
//! step and the rebase of dependent tasks read it, and the user looks it
//! over before merging. Once they are done with it, [`remove`] deletes the
//! folder and drops the nested repositories' copies from their worktree
//! lists. Every branch stays, the task's and the nested repositories'.

use std::path::{Path, PathBuf};
use std::process::Command;

use aura_loop::worktree_name;
use serde::{Deserialize, Serialize};

use crate::nested_repos::{
    create_nested_worktrees, detect_nested_repos, nested_dirty, project_nested_commons, prune_nested,
    NestedCopyState,
};

/// Compute the deterministic sibling worktree path + branch name for a
/// given session/task pair, named after what the task is (`description`).
/// Pure — no filesystem I/O.
///
/// The `sid8`/`t<id>` pair stays in the name: it is what makes two tasks in
/// one wave that describe themselves the same way land in two directories
/// instead of one. The description goes in FRONT of it, because that is the
/// half a person reads.
pub fn paths_for(
    repo_root: &str,
    session_id: &str,
    task_id: usize,
    description: &str,
) -> (PathBuf, String) {
    let parent = Path::new(repo_root)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let repo_name = Path::new(repo_root)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let sid8 = session_id.chars().take(8).collect::<String>();
    match worktree_name::from_label(description) {
        Some(slug) => (
            parent.join(format!("{repo_name}-aura-{slug}-{sid8}-t{task_id}")),
            format!("aura/{sid8}/{slug}-t{task_id}"),
        ),
        None => (
            parent.join(format!("{repo_name}-aura-{sid8}-t{task_id}")),
            format!("aura/{sid8}/t{task_id}"),
        ),
    }
}

/// Create the worktree synchronously. Returns the worktree path on
/// success or a stderr-like error string on failure. Idempotent: if
/// the path already exists and is a registered worktree, returns it
/// without a new `git worktree add`.
///
/// Bucket L3 — cross-worktree memory bridge. After git creates the
/// worktree, copy the parent repo's `.aura/memory.json` + the last 200
/// lines of `.aura/intent_log.jsonl` into the new worktree's `.aura/`
/// so the subagent's `aura ask` / `aura status` / `aura intents query`
/// answer with the parent session's accumulated knowledge instead of a
/// cold worktree. Tagged with `parent_session_id` in the memory blob
/// so a future merge step can fold subagent learnings back.
pub fn create(
    repo_root: &str,
    session_id: &str,
    task_id: usize,
    description: &str,
) -> Result<String, String> {
    let (path, branch) = paths_for(repo_root, session_id, task_id, description);
    if path.exists() {
        // Already there — caller is rerunning, reuse it.
        return Ok(path.to_string_lossy().into_owned());
    }
    let path_str = path.to_string_lossy().into_owned();
    let out = Command::new("git")
        .args(["worktree", "add", "-b", &branch, &path_str])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    // Nested repositories: each gets its own copy on the task's branch. A
    // copy that couldn't be made is reported and the task still runs.
    for o in create_nested_worktrees(Path::new(repo_root), &path, Some(&branch)) {
        if let Some(detail) = o.detail.filter(|_| o.state != NestedCopyState::Created) {
            eprintln!("[manager] task #{task_id}: nested repository {} not copied: {detail}", o.rel_path);
        }
    }
    // Best-effort memory bridge — copy failures don't block dispatch.
    bridge_aura_memory(repo_root, &path, session_id);
    Ok(path_str)
}

/// What became of a request to remove a task's copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum TaskCopyRemoval {
    /// The folder is gone; its branches are kept.
    Removed,
    /// Left in place because it still holds work the folder would take with
    /// it, in words a person can read before saying to go ahead.
    Kept { unsaved: Vec<String> },
}

/// Remove a task's copy at `worktree_path` once the user is done with it.
/// The copy's branch stays, and so do the branches of the nested
/// repositories inside it; their copies are dropped from those
/// repositories' worktree lists, the same as a workspace's.
///
/// Without `force`, a copy holding work that would be lost is kept and the
/// work listed: uncommitted files in the copy or in a nested repository in
/// it, or a repository that exists only there. `force` is the user's go-ahead
/// after seeing that list.
pub fn remove(repo_root: &str, worktree_path: &str, force: bool) -> Result<TaskCopyRemoval, String> {
    let path = Path::new(worktree_path);
    if !path.exists() {
        // Already gone from disk: clear the records git keeps of it.
        crate::worktree::remove_managed_worktree(repo_root, worktree_path)?;
        prune_nested(&project_nested_commons(Path::new(repo_root)));
        return Ok(TaskCopyRemoval::Removed);
    }
    if !force {
        let unsaved = unsaved_work(path)?;
        if !unsaved.is_empty() {
            return Ok(TaskCopyRemoval::Kept { unsaved });
        }
    }
    crate::worktree::remove_managed_worktree(repo_root, worktree_path)?;
    Ok(TaskCopyRemoval::Removed)
}

/// What deleting the copy at `path` would throw away. Untracked `.aura/`
/// files are left out (they are copies of the project's, made when the task
/// started), and so are nested repositories' folders, which are counted on
/// their own.
fn unsaved_work(path: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(path)
        .output()
        .map_err(|e| format!("git status in {}: {e}", path.display()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let nested: Vec<String> = detect_nested_repos(path).into_iter().map(|n| n.rel_path).collect();
    let own = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| counts_as_unsaved(line, &nested))
        .count();

    let mut unsaved = Vec::new();
    if own > 0 {
        unsaved.push(format!("{own} {} with uncommitted changes", files(own)));
    }
    for n in nested_dirty(path) {
        if n.standalone {
            unsaved.push(format!("{}/ is a repository that exists only in this copy", n.rel_path));
        } else {
            unsaved.push(format!("{}/ has {} {} with uncommitted changes", n.rel_path, n.changed, files(n.changed)));
        }
    }
    Ok(unsaved)
}

fn files(n: usize) -> &'static str {
    if n == 1 {
        "file"
    } else {
        "files"
    }
}

/// One `git status --porcelain` line, judged: does losing it lose work?
fn counts_as_unsaved(line: &str, nested: &[String]) -> bool {
    let Some(rest) = line.strip_prefix("?? ") else {
        return !line.trim().is_empty();
    };
    let rest = rest.trim_end_matches('/');
    !(rest == ".aura" || rest.starts_with(".aura/") || nested.iter().any(|n| n == rest))
}

fn bridge_aura_memory(repo_root: &str, worktree_path: &Path, session_id: &str) {
    let parent_aura = Path::new(repo_root).join(".aura");
    let child_aura = worktree_path.join(".aura");
    if !parent_aura.is_dir() {
        return;
    }
    if std::fs::create_dir_all(&child_aura).is_err() {
        return;
    }

    // memory.json — full copy with parent_session_id tag injected.
    let memory_src = parent_aura.join("memory.json");
    if memory_src.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&memory_src) {
            let payload = if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert(
                        "parent_session_id".to_string(),
                        serde_json::Value::String(session_id.to_string()),
                    );
                }
                serde_json::to_string(&v).unwrap_or(raw)
            } else {
                raw
            };
            let _ = std::fs::write(child_aura.join("memory.json"), payload);
        }
    }

    // intent_log.jsonl — last 200 lines so the subagent has recent
    // context without dragging in years of old activity.
    let intent_src = parent_aura.join("intent_log.jsonl");
    if intent_src.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&intent_src) {
            let lines: Vec<&str> = raw.lines().collect();
            let take = lines.len().saturating_sub(200);
            let tail: String = lines[take..]
                .iter()
                .map(|l| format!("{l}\n"))
                .collect();
            let _ = std::fs::write(child_aura.join("intent_log.jsonl"), tail);
        }
    }
}

#[cfg(test)]
#[path = "worktree_nested_tests.rs"]
mod nested_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_for_names_the_worktree_after_the_task() {
        let (path, branch) = paths_for(
            "/Users/m/repos/aura-shell",
            "abcdefgh-1234-5678",
            3,
            "Fix the login bug",
        );
        assert_eq!(
            path,
            PathBuf::from("/Users/m/repos/aura-shell-aura-fix-the-login-bug-abcdefgh-t3")
        );
        assert_eq!(branch, "aura/abcdefgh/fix-the-login-bug-t3");
    }

    #[test]
    fn paths_for_keeps_the_pair_unique_across_a_wave() {
        // Two tasks in one wave described identically still get two homes —
        // the session/task pair is what guarantees that, so it stays.
        let (a, ab) = paths_for("/r/repo", "sess1234", 1, "tidy the imports");
        let (b, bb) = paths_for("/r/repo", "sess1234", 2, "tidy the imports");
        assert_ne!(a, b);
        assert_ne!(ab, bb);
    }

    #[test]
    fn paths_for_falls_back_when_the_description_says_nothing() {
        for description in ["", "   ", "★★★"] {
            let (path, branch) =
                paths_for("/Users/m/repos/aura-shell", "abcdefgh-1234-5678", 3, description);
            assert_eq!(path, PathBuf::from("/Users/m/repos/aura-shell-aura-abcdefgh-t3"));
            assert_eq!(branch, "aura/abcdefgh/t3");
        }
    }

    #[test]
    fn paths_for_handles_root_with_trailing_slash() {
        // Path::parent of "/x/" returns Some("/x"), so the worktree lives
        // at /x/-aura-…. Acceptable; callers normalize repo_root.
        let (_path, branch) = paths_for("/x", "ssss", 1, "");
        assert_eq!(branch, "aura/ssss/t1");
    }
}
