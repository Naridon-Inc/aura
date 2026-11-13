//! A separate copy on a pull request's own branch, for starting work from it.
//!
//! A new workspace normally gets a branch of its own
//! ([`crate::worktree::create_managed_worktree`] runs `worktree add -b`). For
//! a pull request opened from a branch in this repository that is the wrong
//! thing: the work is meant to go on the pull request, and a fresh branch
//! off its head would push somewhere else and need a second pull request.
//!
//! So continuing fetches the branch from `origin` and checks *it* out,
//! tracking GitHub's copy, so a plain push adds commits to the same pull
//! request. What this laptop already has on the branch is respected: behind
//! GitHub, it is moved forward; ahead, it is kept; both moved, nothing is
//! touched and the answer says so. A branch already open in another copy
//! can't be open twice, and the answer says where it is.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::worktree::{safe_resolve_managed_path, ManagedWorktree};

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git could not be started: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn holds(cwd: &Path, reference: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "--quiet", reference]).is_ok()
}

fn is_ancestor(cwd: &Path, older: &str, newer: &str) -> bool {
    git(cwd, &["merge-base", "--is-ancestor", older, newer]).is_ok()
}

/// The copy `branch` is checked out in, from `git worktree list`.
fn open_in(repo: &Path, branch: &str) -> Option<PathBuf> {
    let listing = git(repo, &["worktree", "list", "--porcelain"]).ok()?;
    let wanted = format!("branch refs/heads/{branch}");
    let mut at: Option<&str> = None;
    for line in listing.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            at = Some(path.trim());
        } else if line.trim() == wanted {
            return at.map(PathBuf::from);
        }
    }
    None
}

/// Fetch `branch` from GitHub and bring this laptop's branch of that name level
/// with it where nothing is lost. `Ok(true)` when a local branch exists after,
/// `Ok(false)` when only GitHub's copy does. `here` is the folder the branch
/// may already be checked out in (the in-folder start); open anywhere else is
/// a refusal that says where.
fn prepare(repo: &Path, branch: &str, here: Option<&Path>) -> Result<bool, String> {
    if branch.is_empty() || git(repo, &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("{branch} isn't a branch name git can check out."));
    }
    let local = format!("refs/heads/{branch}");
    let remote = format!("refs/remotes/origin/{branch}");
    git(repo, &["fetch", "--quiet", "origin", &format!("+{local}:{remote}")]).map_err(|e| {
        if e.contains("couldn't find remote ref") {
            format!("GitHub has no branch {branch} any more, so there is nothing to continue. The pull request's branch may have been deleted.")
        } else {
            format!("Couldn't fetch {branch} from GitHub: {e}")
        }
    })?;
    let open_here = match open_in(repo, branch) {
        Some(at) if here.is_some_and(|h| same_dir(h, &at)) => true,
        Some(at) => {
            return Err(format!(
                "{branch} is already open in {}. Keep working on it there, or close that copy first.",
                at.display()
            ))
        }
        None => false,
    };
    if !holds(repo, &local) {
        return Ok(false);
    }
    if is_ancestor(repo, &local, &remote) {
        // Behind GitHub (or level with it): move forward, nothing is lost.
        if open_here {
            git(repo, &["merge", "--quiet", "--ff-only", &remote])?;
        } else {
            git(repo, &["branch", "--quiet", "-f", branch, &remote])?;
        }
    } else if !is_ancestor(repo, &remote, &local) {
        return Err(format!(
            "{branch} here and on GitHub have both moved on. Bring them together in the copy you have, then start again."
        ));
    }
    // Ahead of GitHub: this laptop's commits stay, and push from here.
    Ok(true)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn track(dir: &Path, branch: &str) -> Result<(), String> {
    git(dir, &["branch", "--quiet", &format!("--set-upstream-to=origin/{branch}"), branch]).map(|_| ())
}

/// Leave `target` a copy of `repo` on `branch` as GitHub has it, tracking it
/// there. Nothing is made when the answer is a refusal.
pub(crate) fn continue_worktree_at(repo: &Path, target: &Path, branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    let target_str = target.to_string_lossy().into_owned();
    if prepare(repo, branch, None)? {
        git(repo, &["worktree", "add", "--quiet", &target_str, branch])?;
    } else {
        let remote = format!("refs/remotes/origin/{branch}");
        git(repo, &["worktree", "add", "--quiet", "--track", "-b", branch, &target_str, &remote])?;
    }
    track(target, branch)
}

/// Switch `repo` itself onto `branch` as GitHub has it. The caller has
/// already refused a folder with uncommitted changes.
pub(crate) fn continue_here(repo: &Path, branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if prepare(repo, branch, Some(repo))? {
        git(repo, &["switch", "--quiet", branch])?;
    } else {
        let remote = format!("refs/remotes/origin/{branch}");
        git(repo, &["switch", "--quiet", "--track", "-c", branch, &remote])?;
    }
    track(repo, branch)
}

/// The in-folder start from a pull request: this folder, on its branch.
#[tauri::command]
pub async fn git_continue_branch_here(repo_root: String, branch: String) -> Result<(), String> {
    crate::blocking::run(move || continue_here(Path::new(&repo_root), &branch)).await
}

/// A managed copy on the pull request's own branch. `base` is the branch the
/// pull request merges into: "changes since the branch started" are read
/// against it, so the pull request's own changes show, not only new ones.
pub fn continue_managed_worktree(
    repo_root: &str,
    branch: &str,
    base: Option<&str>,
) -> Result<ManagedWorktree, String> {
    let branch = branch.trim();
    let (target, project_id) = safe_resolve_managed_path(repo_root, branch)?;
    if target.exists() {
        return Err(format!("worktree path already exists: {}", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let repo = PathBuf::from(repo_root);
    continue_worktree_at(&repo, &target, branch)?;

    let start_point = format!("refs/remotes/origin/{branch}");
    let base_ref = base
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| format!("refs/remotes/origin/{b}"))
        .filter(|r| holds(&repo, r));
    let configure = || -> Result<(), String> {
        git(&target, &["config", "push.autoSetupRemote", "true"])?;
        if let Some(base_ref) = &base_ref {
            git(&target, &["config", &format!("branch.{branch}.base"), base_ref])?;
        }
        Ok(())
    };
    if let Err(e) = configure() {
        let _ = git(&repo, &["worktree", "remove", "--force", &target.to_string_lossy()]);
        return Err(format!("post-create config failed: {e}"));
    }
    let nested = crate::nested_repos::create_nested_worktrees(&repo, &target, Some(branch));
    Ok(ManagedWorktree {
        project_id,
        branch: branch.to_string(),
        path: target.to_string_lossy().into_owned(),
        start_point,
        nested,
    })
}

#[cfg(test)]
mod tests {
    //! Real repositories: a bare one standing in for GitHub, a clone for this
    //! laptop's project.
    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn commit(dir: &Path, file: &str) -> String {
        std::fs::write(dir.join(file), file).unwrap();
        run(dir, &["add", file]);
        run(dir, &["commit", "-q", "-m", file]);
        run(dir, &["rev-parse", "HEAD"])
    }

    /// GitHub holding `main` and `fix/login` (pushed by a teammate), and
    /// this laptop's clone, made before the branch existed.
    struct World {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        teammate: PathBuf,
        laptop: PathBuf,
        tip: String,
    }

    fn world() -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let hub = root.join("hub.git");
        let teammate = root.join("teammate");
        let laptop = root.join("laptop");
        run(&root, &["init", "-q", "--bare", "-b", "main", hub.to_str().unwrap()]);
        run(&root, &["clone", "-q", hub.to_str().unwrap(), teammate.to_str().unwrap()]);
        run(&teammate, &["switch", "-q", "-c", "main"]);
        commit(&teammate, "a");
        run(&teammate, &["push", "-q", "origin", "main"]);
        run(&root, &["clone", "-q", hub.to_str().unwrap(), laptop.to_str().unwrap()]);
        run(&teammate, &["switch", "-q", "-c", "fix/login"]);
        let tip = commit(&teammate, "b");
        run(&teammate, &["push", "-q", "-u", "origin", "fix/login"]);
        World { _tmp: tmp, root, teammate, laptop, tip }
    }

    #[test]
    fn a_branch_only_github_has_is_checked_out_tracking_it() {
        let w = world();
        let copy = w.root.join("copy");
        continue_worktree_at(&w.laptop, &copy, "fix/login").unwrap();
        assert_eq!(run(&copy, &["rev-parse", "--abbrev-ref", "HEAD"]), "fix/login");
        assert_eq!(run(&copy, &["rev-parse", "HEAD"]), w.tip);
        assert_eq!(run(&copy, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/fix/login");
    }

    #[test]
    fn a_branch_behind_github_is_moved_forward() {
        let w = world();
        run(&w.laptop, &["fetch", "-q", "origin"]);
        run(&w.laptop, &["branch", "-q", "fix/login", "origin/fix/login"]);
        let newer = commit(&w.teammate, "c");
        run(&w.teammate, &["push", "-q"]);
        let copy = w.root.join("copy");
        continue_worktree_at(&w.laptop, &copy, "fix/login").unwrap();
        assert_eq!(run(&copy, &["rev-parse", "HEAD"]), newer);
    }

    #[test]
    fn commits_only_this_laptop_has_are_kept() {
        let w = world();
        run(&w.laptop, &["fetch", "-q", "origin"]);
        run(&w.laptop, &["switch", "-q", "-c", "fix/login", "origin/fix/login"]);
        let mine = commit(&w.laptop, "mine");
        run(&w.laptop, &["switch", "-q", "main"]);
        let copy = w.root.join("copy");
        continue_worktree_at(&w.laptop, &copy, "fix/login").unwrap();
        assert_eq!(run(&copy, &["rev-parse", "HEAD"]), mine);
    }

    #[test]
    fn a_branch_that_moved_both_ways_is_left_alone() {
        let w = world();
        run(&w.laptop, &["fetch", "-q", "origin"]);
        run(&w.laptop, &["switch", "-q", "-c", "fix/login", "origin/fix/login"]);
        let mine = commit(&w.laptop, "mine");
        run(&w.laptop, &["switch", "-q", "main"]);
        commit(&w.teammate, "theirs");
        run(&w.teammate, &["push", "-q"]);
        let copy = w.root.join("copy");
        let why = continue_worktree_at(&w.laptop, &copy, "fix/login").unwrap_err();
        assert!(why.contains("both moved on"), "{why}");
        assert!(!copy.exists());
        assert_eq!(run(&w.laptop, &["rev-parse", "fix/login"]), mine);
    }

    #[test]
    fn a_branch_open_in_another_copy_says_where() {
        let w = world();
        run(&w.laptop, &["fetch", "-q", "origin"]);
        run(&w.laptop, &["switch", "-q", "-c", "fix/login", "origin/fix/login"]);
        let copy = w.root.join("copy");
        let why = continue_worktree_at(&w.laptop, &copy, "fix/login").unwrap_err();
        assert!(why.contains("already open in"), "{why}");
        assert!(why.contains("laptop"), "{why}");
    }

    #[test]
    fn a_deleted_branch_is_said_plainly() {
        let w = world();
        let copy = w.root.join("copy");
        let why = continue_worktree_at(&w.laptop, &copy, "gone/branch").unwrap_err();
        assert!(why.contains("GitHub has no branch gone/branch"), "{why}");
        assert!(!copy.exists());
    }

    #[test]
    fn a_name_git_refuses_never_reaches_a_fetch() {
        let w = world();
        let why = continue_worktree_at(&w.laptop, &w.root.join("copy"), "bad..name").unwrap_err();
        assert!(why.contains("isn't a branch name"), "{why}");
    }

    #[test]
    fn this_folder_switches_onto_the_branch_github_has() {
        let w = world();
        continue_here(&w.laptop, "fix/login").unwrap();
        assert_eq!(run(&w.laptop, &["rev-parse", "--abbrev-ref", "HEAD"]), "fix/login");
        assert_eq!(run(&w.laptop, &["rev-parse", "HEAD"]), w.tip);
        assert_eq!(run(&w.laptop, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/fix/login");
    }

    #[test]
    fn this_folder_already_on_the_branch_is_brought_forward() {
        let w = world();
        run(&w.laptop, &["fetch", "-q", "origin"]);
        run(&w.laptop, &["switch", "-q", "-c", "fix/login", "origin/fix/login"]);
        let newer = commit(&w.teammate, "c");
        run(&w.teammate, &["push", "-q"]);
        continue_here(&w.laptop, "fix/login").unwrap();
        assert_eq!(run(&w.laptop, &["rev-parse", "HEAD"]), newer);
    }

    #[test]
    fn this_folder_refuses_a_branch_open_in_another_copy() {
        let w = world();
        run(&w.laptop, &["fetch", "-q", "origin"]);
        let other = w.root.join("other");
        run(&w.laptop, &["worktree", "add", "-q", "-b", "fix/login", other.to_str().unwrap(), "origin/fix/login"]);
        let why = continue_here(&w.laptop, "fix/login").unwrap_err();
        assert!(why.contains("already open in"), "{why}");
        assert_eq!(run(&w.laptop, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
    }
}
