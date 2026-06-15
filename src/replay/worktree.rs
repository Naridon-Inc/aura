//! Isolated git worktrees for Replay Lab.
//!
//! Each replayed agent runs in its own throwaway worktree so concurrent /
//! sequential runs never clobber each other or the user's working tree.
//! Worktrees live under the system temp dir on a dedicated branch
//! (`aura-replay/<slug>`); [`ReplayWorktree`] cleans itself up on drop and
//! [`list_orphans`] / [`prune_orphans`] let `aura doctor` recover any that
//! leaked from a crash.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Branch (and label) prefix that marks a worktree as Replay-Lab-owned.
pub const BRANCH_PREFIX: &str = "aura-replay/";

/// Reduce an arbitrary label to a filesystem/branch-safe slug.
fn sanitize(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        "run".to_string()
    } else {
        trimmed.to_string()
    }
}

/// A live replay worktree. Dropping it force-removes the worktree and its
/// branch unless [`ReplayWorktree::set_keep`] was called.
pub struct ReplayWorktree {
    /// Absolute path to the worktree's working directory.
    pub path: PathBuf,
    /// The dedicated branch checked out in the worktree.
    pub branch: String,
    repo_root: PathBuf,
    keep: bool,
}

impl ReplayWorktree {
    /// Create a fresh worktree off the repo's current HEAD. Any stale
    /// leftovers at the same path/branch are force-removed first so a
    /// previous crash can't block a new run.
    pub fn create(repo_root: &Path, label: &str) -> Result<Self, String> {
        let slug = sanitize(label);
        let branch = format!("{BRANCH_PREFIX}{slug}");
        let path = std::env::temp_dir().join(format!("aura-replay-{slug}"));

        // Best-effort pre-clean of stale state at this path/branch.
        force_remove(repo_root, &path, &branch);

        let out = Command::new("git")
            .arg("worktree")
            .arg("add")
            .arg(&path)
            .arg("-b")
            .arg(&branch)
            .current_dir(repo_root)
            .output()
            .map_err(|e| format!("could not spawn `git worktree add`: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "`git worktree add` failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(Self {
            path,
            branch,
            repo_root: repo_root.to_path_buf(),
            keep: false,
        })
    }

    /// Keep the worktree on disk after this handle drops (for `--keep-worktrees`).
    pub fn set_keep(&mut self, keep: bool) {
        self.keep = keep;
    }

    /// Force-remove this worktree and its branch now. Idempotent.
    pub fn cleanup(&self) {
        force_remove(&self.repo_root, &self.path, &self.branch);
    }
}

impl Drop for ReplayWorktree {
    fn drop(&mut self) {
        if !self.keep {
            self.cleanup();
        }
    }
}

/// Force-remove a worktree path + branch + directory. Every step is
/// best-effort: a missing worktree or branch is not an error here.
fn force_remove(repo_root: &Path, path: &Path, branch: &str) {
    let _ = Command::new("git")
        .arg("worktree")
        .arg("remove")
        .arg("--force")
        .arg(path)
        .current_dir(repo_root)
        .output();
    let _ = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repo_root)
        .output();
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// One worktree left behind by a previous replay run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrphanWorktree {
    pub path: String,
    pub branch: String,
}

/// List Replay-Lab worktrees currently registered in the repo. These are
/// "orphans" only in the sense that no live run owns them — under normal
/// operation [`ReplayWorktree`]'s drop removes them, so anything here
/// leaked from a crash or `--keep-worktrees`.
pub fn list_orphans(repo_root: &Path) -> Vec<OrphanWorktree> {
    let out = match Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_root)
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut orphans = Vec::new();
    let mut cur_path: Option<String> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            let branch = b.trim().trim_start_matches("refs/heads/").to_string();
            if branch.starts_with(BRANCH_PREFIX) {
                if let Some(p) = cur_path.clone() {
                    orphans.push(OrphanWorktree { path: p, branch });
                }
            }
        } else if line.is_empty() {
            cur_path = None;
        }
    }
    orphans
}

/// Remove every Replay-Lab orphan worktree. Returns the branches removed.
pub fn prune_orphans(repo_root: &Path) -> Vec<String> {
    let orphans = list_orphans(repo_root);
    let mut removed = Vec::new();
    for o in &orphans {
        force_remove(repo_root, Path::new(&o.path), &o.branch);
        removed.push(o.branch.clone());
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_makes_safe_slugs() {
        assert_eq!(sanitize("latest"), "latest");
        assert_eq!(sanitize("intent 1234/foo"), "intent-1234-foo");
        assert_eq!(sanitize("///"), "run");
        assert_eq!(sanitize("Add OAuth!"), "Add-OAuth");
    }

    #[test]
    fn branch_prefix_is_namespaced() {
        assert!(format!("{BRANCH_PREFIX}x").starts_with("aura-replay/"));
    }
}
