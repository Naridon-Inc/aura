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
//! On task Done/Failed/Cancelled we leave the worktree in place — the
//! user reviews via the existing `WorktreeMenu` in `WorkspaceRail`. A
//! follow-up cleanup command (`manager_prune_worktrees`) can be added
//! once we trust the merge-back flow; for now we lean on git's own
//! `worktree prune` semantics.

use std::path::{Path, PathBuf};
use std::process::Command;

use aura_loop::worktree_name;

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
    // Best-effort memory bridge — copy failures don't block dispatch.
    bridge_aura_memory(repo_root, &path, session_id);
    Ok(path_str)
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
