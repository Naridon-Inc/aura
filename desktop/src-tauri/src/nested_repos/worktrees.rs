//! Workspace copies of nested repositories.
//!
//! A workspace is a linked worktree of the project. Git only copies the
//! project's own files into it, so a nested repository's folder would be
//! missing (it is ignored) or empty (a submodule nobody initialised). Each
//! nested repository gets its own linked worktree at the same relative path
//! inside the new copy, on a branch with the workspace's name, so the copy
//! looks like the project and every repository in it can be committed,
//! pushed and reviewed on its own branch.
//!
//! Deleting the workspace deletes those folders with it; their branches stay
//! in the nested repository, the same as the project's own branch does.
//! [`nested_dirty`] lists what would be lost first so the caller can say so.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::detect::{common_dir, detect_nested_repos, git_line, git_marker_is_file, NestedRepo};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NestedCopyState {
    /// A new branch was made from the nested repository's current commit.
    Created,
    /// The branch already existed in the nested repository and was checked out.
    Attached,
    /// Left alone on purpose; `detail` says why.
    Skipped,
    /// Git refused; `detail` carries its message.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NestedWorktreeOutcome {
    pub rel_path: String,
    pub state: NestedCopyState,
    pub branch: Option<String>,
    pub detail: Option<String>,
}

fn run(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn outcome(n: &NestedRepo, state: NestedCopyState, branch: Option<&str>, detail: Option<String>) -> NestedWorktreeOutcome {
    NestedWorktreeOutcome {
        rel_path: n.rel_path.clone(),
        state,
        branch: branch.map(str::to_string),
        detail,
    }
}

fn dir_has_entries(p: &Path) -> bool {
    std::fs::read_dir(p).map(|mut r| r.next().is_some()).unwrap_or(false)
}

/// Give every nested repository under `repo_root` a linked worktree at the
/// same place inside `worktree`, on `branch` (or detached at its current
/// commit when the project's copy is detached). Never fails as a whole: each
/// repository reports its own outcome so one refusal can't undo the copy.
pub fn create_nested_worktrees(repo_root: &Path, worktree: &Path, branch: Option<&str>) -> Vec<NestedWorktreeOutcome> {
    detect_nested_repos(repo_root)
        .iter()
        .map(|n| create_one(n, worktree, branch))
        .collect()
}

fn create_one(n: &NestedRepo, worktree: &Path, branch: Option<&str>) -> NestedWorktreeOutcome {
    use NestedCopyState::*;
    let src = Path::new(&n.root);
    let target = worktree.join(&n.rel_path);

    if git_line(src, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_none() {
        return outcome(n, Skipped, None, Some("it has no commits yet, so there is nothing to branch from".into()));
    }
    if target.exists() && (!target.is_dir() || dir_has_entries(&target)) {
        return outcome(n, Skipped, None, Some("the new copy already has files in this folder".into()));
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return outcome(n, Failed, None, Some(format!("create {}: {e}", parent.display())));
        }
    }

    // Start from what the nested repository has checked out right now: its
    // branch when it is on one, else its commit.
    let start = git_line(src, &["symbolic-ref", "--quiet", "HEAD"])
        .or_else(|| git_line(src, &["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "HEAD".into());
    let target_str = target.to_string_lossy().into_owned();
    let made = match branch {
        None => run(src, &["worktree", "add", "--detach", &target_str, &start]).map(|_| Created),
        Some(b) if git_line(src, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{b}")]).is_some() => {
            run(src, &["worktree", "add", &target_str, b]).map(|_| Attached)
        }
        Some(b) => run(src, &["worktree", "add", "--no-track", "-b", b, &target_str, &start]).map(|_| Created),
    };
    match made {
        Ok(state) => {
            // Same settings the project's own copy gets: the first push makes
            // the remote branch, and the base is remembered for "since start".
            let _ = run(&target, &["config", "push.autoSetupRemote", "true"]);
            if let (Created, Some(b)) = (state, branch) {
                let _ = run(&target, &["config", &format!("branch.{b}.base"), &start]);
            }
            outcome(n, state, branch, None)
        }
        Err(e) => outcome(n, Failed, None, Some(e)),
    }
}

/// The shared git directories of the nested linked worktrees inside
/// `worktree`. Read before the copy is deleted, because afterwards there is
/// nothing left on disk to ask.
pub fn nested_worktree_commons(worktree: &Path) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    detect_nested_repos(worktree)
        .iter()
        .map(|n| PathBuf::from(&n.root))
        .filter(|root| git_marker_is_file(root))
        .filter_map(|root| common_dir(&root))
        .filter(|c| seen.insert(c.clone()))
        .collect()
}

/// The shared git folders of the project's own nested repositories. A copy
/// whose folder is already gone can't say whose copies it held; pruning
/// these clears their records of it all the same.
pub fn project_nested_commons(project: &Path) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    detect_nested_repos(project)
        .iter()
        .filter_map(|n| common_dir(Path::new(&n.root)))
        .filter(|c| seen.insert(c.clone()))
        .collect()
}

/// Drop the bookkeeping of nested worktrees whose folders are gone. Each
/// nested repository keeps its branch.
pub fn prune_nested(commons: &[PathBuf]) {
    for c in commons {
        let git_dir = format!("--git-dir={}", c.display());
        let _ = Command::new("git").args([git_dir.as_str(), "worktree", "prune"]).output();
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NestedDirty {
    pub rel_path: String,
    /// Files with uncommitted changes.
    pub changed: usize,
    /// The folder is a whole repository of its own (its `.git` is a folder,
    /// not a link back to a checkout elsewhere), so deleting it deletes its
    /// history too, not just uncommitted edits.
    pub standalone: bool,
}

/// Nested repositories under `root` that deleting `root` would lose work
/// from: uncommitted changes, or the whole repository when it lives only
/// here. Used before a workspace copy is deleted.
pub fn nested_dirty(root: &Path) -> Vec<NestedDirty> {
    detect_nested_repos(root)
        .iter()
        .filter_map(|n| {
            let dir = Path::new(&n.root);
            let changed = run(dir, &["status", "--porcelain"])
                .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
                .unwrap_or(0);
            let standalone = !git_marker_is_file(dir);
            (changed > 0 || standalone).then(|| NestedDirty {
                rel_path: n.rel_path.clone(),
                changed,
                standalone,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nested_repos::test_support::{git, init_repo, scratch};

    fn project_with_nested(tag: &str) -> (PathBuf, PathBuf) {
        let base = scratch(tag);
        let outer = base.join("outer");
        init_repo(&outer);
        std::fs::write(outer.join(".gitignore"), "cloud/\n").unwrap();
        git(&outer, &["add", "."]);
        git(&outer, &["commit", "-q", "-m", "ignore cloud"]);
        init_repo(&outer.join("cloud"));
        (base, outer)
    }

    fn add_outer_worktree(outer: &Path, wt: &Path, branch: &str) {
        git(outer, &["worktree", "add", "-q", "-b", branch, wt.to_str().unwrap()]);
    }

    #[test]
    fn the_copy_gets_the_nested_repository_on_the_same_branch() {
        let (base, outer) = project_with_nested("wt-create");
        let wt = base.join("copy");
        add_outer_worktree(&outer, &wt, "feature/x");
        assert!(!wt.join("cloud").exists(), "git leaves the ignored folder out");

        let made = create_nested_worktrees(&outer, &wt, Some("feature/x"));
        assert_eq!(made.len(), 1, "{made:?}");
        assert_eq!(made[0].state, NestedCopyState::Created, "{made:?}");
        assert!(wt.join("cloud/README.md").is_file(), "the nested files are there");
        let branch = git_line(&wt.join("cloud"), &["symbolic-ref", "--short", "HEAD"]);
        assert_eq!(branch.as_deref(), Some("feature/x"));
        let base_cfg = git_line(&wt.join("cloud"), &["config", "branch.feature/x.base"]);
        assert_eq!(base_cfg.as_deref(), Some("refs/heads/main"));
        let seen = detect_nested_repos(&wt);
        assert_eq!(seen[0].base.as_deref(), Some("main"), "a pull request from the copy goes into main");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_existing_branch_is_checked_out_rather_than_remade() {
        let (base, outer) = project_with_nested("wt-attach");
        git(&outer.join("cloud"), &["branch", "feature/y"]);
        let wt = base.join("copy");
        add_outer_worktree(&outer, &wt, "feature/y");
        let made = create_nested_worktrees(&outer, &wt, Some("feature/y"));
        assert_eq!(made[0].state, NestedCopyState::Attached, "{made:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_repository_with_no_commits_is_skipped_with_a_reason() {
        let base = scratch("wt-unborn");
        let outer = base.join("outer");
        init_repo(&outer);
        let empty = outer.join("fresh");
        std::fs::create_dir_all(&empty).unwrap();
        git(&empty, &["init", "-q"]);
        let wt = base.join("copy");
        add_outer_worktree(&outer, &wt, "feature/z");
        let made = create_nested_worktrees(&outer, &wt, Some("feature/z"));
        assert_eq!(made[0].state, NestedCopyState::Skipped);
        assert!(made[0].detail.as_deref().unwrap().contains("no commits"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_branch_already_checked_out_elsewhere_fails_without_stopping_the_rest() {
        let (base, outer) = project_with_nested("wt-busy");
        init_repo(&outer.join("other"));
        // `main` is checked out in both nested repositories already.
        let wt = base.join("copy");
        add_outer_worktree(&outer, &wt, "w");
        let made = create_nested_worktrees(&outer, &wt, Some("main"));
        assert_eq!(made.len(), 2);
        assert!(made.iter().all(|m| m.state == NestedCopyState::Failed), "{made:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn deleting_the_copy_prunes_the_nested_worktree_and_keeps_its_branch() {
        let (base, outer) = project_with_nested("wt-remove");
        let wt = base.join("copy");
        add_outer_worktree(&outer, &wt, "feature/r");
        create_nested_worktrees(&outer, &wt, Some("feature/r"));
        let commons = nested_worktree_commons(&wt);
        assert_eq!(commons.len(), 1, "{commons:?}");

        std::fs::remove_dir_all(&wt).unwrap();
        prune_nested(&commons);
        let listing = run(&outer.join("cloud"), &["worktree", "list", "--porcelain"]).unwrap();
        assert_eq!(listing.lines().filter(|l| l.starts_with("worktree ")).count(), 1, "{listing}");
        assert!(git_line(&outer.join("cloud"), &["rev-parse", "--verify", "refs/heads/feature/r"]).is_some());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn dirty_lists_uncommitted_work_and_standalone_repositories() {
        let (base, outer) = project_with_nested("wt-dirty");
        let wt = base.join("copy");
        add_outer_worktree(&outer, &wt, "feature/d");
        create_nested_worktrees(&outer, &wt, Some("feature/d"));
        assert!(nested_dirty(&wt).is_empty(), "a clean linked copy loses nothing");

        std::fs::write(wt.join("cloud/new.txt"), "x").unwrap();
        init_repo(&wt.join("scratch-clone"));
        let dirty = nested_dirty(&wt);
        assert_eq!(
            dirty,
            vec![
                NestedDirty { rel_path: "cloud".into(), changed: 1, standalone: false },
                NestedDirty { rel_path: "scratch-clone".into(), changed: 0, standalone: true },
            ]
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
