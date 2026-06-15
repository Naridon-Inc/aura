//! Git-worktree lifecycle helper for running loop tasks in parallel.
//!
//! A [`LoopWorktree`] is a throwaway git worktree dedicated to a single loop
//! task, checked out on its own branch. Paths are sibling directories of the
//! repo (`<parent>/<repo-name>-aura-loop-<safeid>`) and branches are named
//! `loop/<safeid>`, where `<safeid>` is a deterministic, ref-safe slug of the
//! task id. Merge-back is a plain `git merge --no-ff` — when the aura AST
//! merge-driver is configured it resolves clean cases automatically. Discard
//! is best-effort: it removes the worktree and deletes the branch, ignoring a
//! `branch -D` failure on an already-merged branch.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A git worktree dedicated to one loop task, on its own branch.
pub struct LoopWorktree {
    /// Sibling dir: `<parent>/<repo-name>-aura-loop-<safeid>`.
    pub path: PathBuf,
    /// Branch name: `loop/<safeid>`.
    pub branch: String,
}

/// Create a fresh worktree off `base` (default: current HEAD of `repo_root`) for
/// `task_id`, on a new branch `loop/<safeid>`. Idempotent-ish: if the target
/// path already exists, returns an `Err` with a clear message so the caller can
/// fall back to sequential execution. Uses
/// `git -C <repo_root> worktree add -b <branch> <path> [<base>]`.
pub fn create(repo_root: &Path, task_id: &str, base: Option<&str>) -> Result<LoopWorktree, String> {
    let safe = safe_id(task_id);
    let (path, branch) = paths_for(repo_root, &safe);

    if path.exists() {
        return Err(format!(
            "loop worktree path already exists: {} (skipping parallel run for task '{}')",
            path.display(),
            task_id
        ));
    }

    let repo_str = repo_root.to_string_lossy().into_owned();
    let path_str = path.to_string_lossy().into_owned();

    let mut args: Vec<String> = vec![
        "-C".to_string(),
        repo_str,
        "worktree".to_string(),
        "add".to_string(),
        "-b".to_string(),
        branch.clone(),
        path_str,
    ];
    if let Some(b) = base {
        args.push(b.to_string());
    }

    let out = Command::new("git")
        .args(&args)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }

    Ok(LoopWorktree { path, branch })
}

/// Merge the worktree's branch back into the current branch of `repo_root` with
/// a no-fast-forward merge: `git -C <repo_root> merge --no-ff --no-edit <branch>`.
/// On conflict (non-zero exit), returns `Err` with the git stderr so the caller
/// can decide (the aura AST merge-driver, if configured, resolves clean cases
/// automatically).
pub fn merge_back(repo_root: &Path, wt: &LoopWorktree) -> Result<(), String> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let out = Command::new("git")
        .args(["-C", &repo_str, "merge", "--no-ff", "--no-edit", &wt.branch])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    Ok(())
}

/// Tear down the worktree: `git -C <repo_root> worktree remove --force <path>`
/// then `git -C <repo_root> branch -D <branch>`. Best-effort — both are
/// attempted and errors collected. Returns `Err` only if the worktree removal
/// genuinely failed; a `branch -D` failure (e.g. on an already-merged branch)
/// is logged into the error context but does not by itself fail the call.
/// Never panics.
pub fn discard(repo_root: &Path, wt: &LoopWorktree) -> Result<(), String> {
    let repo_str = repo_root.to_string_lossy().into_owned();
    let path_str = wt.path.to_string_lossy().into_owned();

    // 1. Remove the worktree — this is the one that must succeed.
    let remove_err: Option<String> = match Command::new("git")
        .args(["-C", &repo_str, "worktree", "remove", "--force", &path_str])
        .output()
    {
        Ok(out) if out.status.success() => None,
        Ok(out) => Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
        Err(e) => Some(format!("spawn git: {e}")),
    };

    // 2. Delete the branch — best-effort, failure is tolerated (already merged,
    //    or never created). We don't surface this as a hard error on its own.
    let _ = Command::new("git")
        .args(["-C", &repo_str, "branch", "-D", &wt.branch])
        .output();

    match remove_err {
        Some(e) => Err(format!(
            "failed to remove loop worktree {}: {}",
            wt.path.display(),
            e
        )),
        None => Ok(()),
    }
}

/// PURE, unit-testable: turn an arbitrary task id/title into a
/// filesystem-and-git-ref-safe slug. The result is lowercase, contains only
/// `[a-z0-9-]`, collapses repeated separators, is trimmed to ~32 chars, and is
/// never empty (a deterministic hash suffix is appended only when the input
/// strips to nothing, guaranteeing a stable non-empty slug).
fn safe_id(raw: &str) -> String {
    // Lowercase, map every non-[a-z0-9] char to a single '-'.
    let mut slug = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            // Collapse any run of separators / unicode into a single dash.
            slug.push('-');
            last_dash = true;
        }
    }

    // Trim to ~32 chars, then strip leading/trailing dashes so we never produce
    // a path-traversing or ref-illegal token (no leading '-', no trailing '-').
    if slug.len() > 32 {
        slug.truncate(32);
    }
    let trimmed = slug.trim_matches('-');

    if trimmed.is_empty() {
        // Everything stripped away (e.g. pure-unicode or pure-punctuation id):
        // fall back to a deterministic 8-char hash of the original input so the
        // slug is non-empty and stable across runs (no rng, no clock).
        format!("id-{}", short_hash(raw))
    } else {
        trimmed.to_string()
    }
}

/// PURE, unit-testable: compute `(worktree_path, branch)` for a `repo_root` and
/// an already-sanitized `safe` id, matching the sibling-dir scheme
/// `<parent>/<repo-name>-aura-loop-<safe>` with branch `loop/<safe>`. Factored
/// out of [`create`] so it can be tested without touching git.
fn paths_for(repo_root: &Path, safe: &str) -> (PathBuf, String) {
    let parent = repo_root
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let repo_name = repo_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo");
    let path = parent.join(format!("{repo_name}-aura-loop-{safe}"));
    let branch = format!("loop/{safe}");
    (path, branch)
}

/// Deterministic 8-hex-char hash (FNV-1a) of `raw`. Used only as a non-empty
/// fallback in [`safe_id`]; not cryptographic, no rng, no clock.
fn short_hash(raw: &str) -> String {
    // 64-bit FNV-1a.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in raw.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:08x}", (hash as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_id_uuid() {
        let s = safe_id("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
        // Truncated to 32 chars (the trailing group is cut), then dash-trimmed.
        assert_eq!(s, "3f2504e0-4f89-41d3-9a0c-0305e82c");
        assert!(s.len() <= 32);
        assert!(s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert!(!s.starts_with('-') && !s.ends_with('-'));
    }

    #[test]
    fn safe_id_ticket_handle() {
        assert_eq!(safe_id("AURA-203"), "aura-203");
    }

    #[test]
    fn safe_id_title_with_punctuation() {
        // Spaces and punctuation collapse to single dashes; no trailing dash.
        assert_eq!(safe_id("Fix the thing!!"), "fix-the-thing");
    }

    #[test]
    fn safe_id_empty_falls_back_to_nonempty() {
        let s = safe_id("");
        assert!(!s.is_empty(), "empty input must yield a non-empty slug");
        assert!(s.starts_with("id-"));
        // Deterministic across calls.
        assert_eq!(s, safe_id(""));
    }

    #[test]
    fn safe_id_pure_unicode_punct_falls_back() {
        // No ascii-alphanumerics survive — must hit the hash fallback, non-empty.
        let s = safe_id("日本語 — ★★★");
        assert!(!s.is_empty());
        assert!(s.starts_with("id-"));
        assert!(s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert!(!s.starts_with("-") && !s.ends_with('-'));
    }

    #[test]
    fn safe_id_unicode_with_ascii_keeps_ascii() {
        // Mixed input keeps the ascii-alphanumeric run, unicode → separator.
        assert_eq!(safe_id("café-99"), "caf-99");
    }

    #[test]
    fn safe_id_collapses_repeats_and_trims() {
        assert_eq!(safe_id("___a   b___"), "a-b");
        assert_eq!(safe_id("--lead-and-trail--"), "lead-and-trail");
    }

    #[test]
    fn paths_for_sibling_scheme() {
        let (path, branch) = paths_for(Path::new("/home/dev/myrepo"), "aura-203");
        assert_eq!(path, PathBuf::from("/home/dev/myrepo-aura-loop-aura-203"));
        assert_eq!(branch, "loop/aura-203");
    }

    #[test]
    fn paths_for_repo_at_filesystem_root() {
        // repo_root has no parent → fall back to /tmp, never panic.
        let (path, branch) = paths_for(Path::new("/"), "x9");
        assert_eq!(branch, "loop/x9");
        // file_name() of "/" is None → repo_name falls back to "repo".
        assert_eq!(path, PathBuf::from("/tmp/repo-aura-loop-x9"));
    }

    #[test]
    fn paths_for_relative_repo_root() {
        let (path, branch) = paths_for(Path::new("repo"), "t1");
        // parent of a bare relative name is "" → joined onto "" stays relative.
        assert_eq!(branch, "loop/t1");
        assert_eq!(path, PathBuf::from("repo-aura-loop-t1"));
    }
}
