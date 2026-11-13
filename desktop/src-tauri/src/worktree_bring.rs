//! Bring a branch that was worked on somewhere else (the org's cloud
//! computer) into a worktree on this laptop, so the work carries on here.
//!
//! The cloud computer pushes the branch after every turn, so GitHub has the
//! work. What this laptop may already hold decides how it arrives:
//!
//! * nothing: a new worktree, on a new local branch made from GitHub's copy
//!   and tracking it;
//! * the branch, checked out nowhere: a new worktree on it, moved forward to
//!   GitHub's copy first when it is only behind;
//! * the branch, already checked out: that worktree, moved forward when it is
//!   only behind and has no uncommitted edits in the way.
//!
//! Two copies that both moved on, or edits that a fast-forward would have to
//! walk over, are refused in plain words. Nothing here ever resets, stashes or
//! overwrites: a refusal leaves the laptop exactly as it was.
//!
//! The decision is [`plan_bring`], a pure function over what git reports, so
//! every case is tested without a repository.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// How the laptop's branch stands against GitHub's copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    Same,
    /// Only GitHub has new commits.
    Behind,
    /// Only this laptop has new commits.
    Ahead,
    Diverged,
}

impl Relation {
    fn from_counts(ahead: u64, behind: u64) -> Self {
        match (ahead, behind) {
            (0, 0) => Relation::Same,
            (0, _) => Relation::Behind,
            (_, 0) => Relation::Ahead,
            _ => Relation::Diverged,
        }
    }
}

/// What git said about the branch, gathered before anything changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BringFacts {
    /// GitHub has the branch.
    pub remote: bool,
    /// A worktree (the project's own folder included) already has it out.
    pub worktree: Option<ExistingWorktree>,
    /// A local branch of that name exists.
    pub local_branch: bool,
    /// The local branch against GitHub's copy. Only read when both exist.
    pub relation: Relation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExistingWorktree {
    pub path: String,
    /// Tracked files with uncommitted changes.
    pub dirty: bool,
}

/// What to do. Each step leaves either a worktree on the branch or nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BringStep {
    /// The branch is already out here; move it forward when it is behind.
    UseWorktree { path: String, fast_forward: bool },
    /// Check the existing local branch out into a new worktree, moving the
    /// branch forward first when it is behind.
    AddExisting { fast_forward: bool },
    /// Make the local branch from GitHub's copy, in a new worktree.
    AddFromRemote,
    Refuse(String),
}

pub fn plan_bring(branch: &str, f: &BringFacts) -> BringStep {
    if !f.remote {
        return BringStep::Refuse(format!(
            "{branch} isn’t on GitHub yet, so there’s nothing to bring over. If the cloud computer is still answering, wait for it to finish and try again."
        ));
    }
    let diverged = || {
        BringStep::Refuse(format!(
            "{branch} on this computer and on GitHub have both moved on since they last matched. Pull it here first, then move the workspace."
        ))
    };
    if let Some(w) = &f.worktree {
        return match f.relation {
            Relation::Same | Relation::Ahead => BringStep::UseWorktree { path: w.path.clone(), fast_forward: false },
            Relation::Behind if w.dirty => BringStep::Refuse(format!(
                "{branch} is open in {} with changes that aren’t committed, and the cloud has newer work on it. Commit or put those changes aside first.",
                w.path
            )),
            Relation::Behind => BringStep::UseWorktree { path: w.path.clone(), fast_forward: true },
            Relation::Diverged => diverged(),
        };
    }
    if f.local_branch {
        return match f.relation {
            Relation::Same | Relation::Ahead => BringStep::AddExisting { fast_forward: false },
            Relation::Behind => BringStep::AddExisting { fast_forward: true },
            Relation::Diverged => diverged(),
        };
    }
    BringStep::AddFromRemote
}

/// Where the branch ended up.
#[derive(Debug, Clone, Serialize)]
pub struct BroughtWorktree {
    pub path: String,
    pub branch: String,
    /// A new worktree was made (false: one that was already here).
    pub created: bool,
    /// The branch was moved forward to GitHub's copy.
    pub fast_forwarded: bool,
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("couldn’t run git: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { format!("git {} failed", args.first().unwrap_or(&"")) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ref_exists(cwd: &Path, name: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "--quiet", name]).is_ok()
}

/// The worktree that has `refs/heads/<branch>` out, from
/// `git worktree list --porcelain`.
pub(crate) fn worktree_with_branch(porcelain: &str, branch: &str) -> Option<String> {
    let want = format!("branch refs/heads/{branch}");
    let mut path: Option<&str> = None;
    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p);
        } else if line.trim() == want {
            return path.map(str::to_string);
        } else if line.is_empty() {
            path = None;
        }
    }
    None
}

/// `ahead behind` from `git rev-list --left-right --count a...b`.
pub(crate) fn parse_counts(raw: &str) -> Option<(u64, u64)> {
    let mut it = raw.split_whitespace();
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
}

/// A fetch that failed only because GitHub has no such branch.
pub(crate) fn missing_remote_ref(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("couldn't find remote ref") || s.contains("couldn’t find remote ref")
}

fn valid_branch(repo: &Path, branch: &str) -> Result<(), String> {
    if branch.is_empty() || branch.starts_with('-') || git(repo, &["check-ref-format", "--branch", branch]).is_err() {
        return Err(format!("“{branch}” isn’t a branch name git accepts."));
    }
    Ok(())
}

fn gather(repo: &Path, branch: &str) -> Result<BringFacts, String> {
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let spec = format!("+refs/heads/{branch}:{remote_ref}");
    let remote = match git(repo, &["fetch", "--quiet", "origin", &spec]) {
        Ok(_) => true,
        Err(e) if missing_remote_ref(&e) => false,
        Err(e) => return Err(format!("Couldn’t get {branch} from GitHub: {e}")),
    };
    let porcelain = git(repo, &["worktree", "list", "--porcelain"])?;
    let worktree = match worktree_with_branch(&porcelain, branch) {
        Some(path) => {
            let status = git(Path::new(&path), &["status", "--porcelain", "--untracked-files=no"])?;
            Some(ExistingWorktree { path, dirty: !status.is_empty() })
        }
        None => None,
    };
    let local_branch = ref_exists(repo, &format!("refs/heads/{branch}"));
    let relation = if remote && local_branch {
        let raw = git(repo, &["rev-list", "--left-right", "--count", &format!("refs/heads/{branch}...{remote_ref}")])?;
        let (ahead, behind) = parse_counts(&raw).ok_or_else(|| format!("git gave an unreadable count: {raw}"))?;
        Relation::from_counts(ahead, behind)
    } else {
        Relation::Same
    };
    Ok(BringFacts { remote, worktree, local_branch, relation })
}

/// Track GitHub's copy and push back to it with a plain push.
fn track(worktree: &Path, branch: &str) {
    let _ = git(worktree, &["branch", &format!("--set-upstream-to=origin/{branch}"), branch]);
    let _ = git(worktree, &["config", "push.autoSetupRemote", "true"]);
    // The diff panel compares against the branch's base; GitHub's default
    // branch is the one a pull request from it would go to.
    if let Ok(head) = git(worktree, &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]) {
        if let Some(base) = head.strip_prefix("refs/remotes/") {
            let _ = git(worktree, &["config", &format!("branch.{branch}.base"), base]);
        }
    }
}

pub fn bring_branch(repo_root: &str, branch: &str) -> Result<BroughtWorktree, String> {
    let branch = branch.trim();
    let repo = PathBuf::from(repo_root);
    if !crate::worktree::is_git_work_tree(repo_root) {
        return Err("That project folder isn’t a git repository, so the branch has nowhere to go.".into());
    }
    valid_branch(&repo, branch)?;
    let facts = gather(&repo, branch)?;
    let remote_ref = format!("origin/{branch}");
    let made = |path: String, fast_forwarded: bool, created: bool| BroughtWorktree {
        path,
        branch: branch.to_string(),
        created,
        fast_forwarded,
    };
    match plan_bring(branch, &facts) {
        BringStep::Refuse(why) => Err(why),
        BringStep::UseWorktree { path, fast_forward } => {
            if fast_forward {
                git(Path::new(&path), &["merge", "--ff-only", "--quiet", &remote_ref])
                    .map_err(|e| format!("Couldn’t move {branch} forward in {path}: {e}"))?;
            }
            Ok(made(path, fast_forward, false))
        }
        BringStep::AddExisting { fast_forward } => {
            let target = new_target(repo_root, branch)?;
            if fast_forward {
                // Checked out nowhere (the plan saw no worktree), so the ref
                // can move without touching anyone's files.
                git(&repo, &["branch", "--force", branch, &remote_ref])?;
            }
            git(&repo, &["worktree", "add", "--quiet", &target, branch])?;
            track(Path::new(&target), branch);
            let _ = crate::nested_repos::create_nested_worktrees(&repo, Path::new(&target), Some(branch));
            Ok(made(target, fast_forward, true))
        }
        BringStep::AddFromRemote => {
            let target = new_target(repo_root, branch)?;
            git(&repo, &["worktree", "add", "--quiet", "--no-track", "-b", branch, &target, &remote_ref])?;
            track(Path::new(&target), branch);
            let _ = crate::nested_repos::create_nested_worktrees(&repo, Path::new(&target), Some(branch));
            Ok(made(target, false, true))
        }
    }
}

/// The managed folder for the branch's new worktree. One that is already
/// there and isn't this branch's worktree is never written into.
fn new_target(repo_root: &str, branch: &str) -> Result<String, String> {
    let (path, _) = crate::worktree::safe_resolve_managed_path(repo_root, branch)?;
    if path.exists() {
        return Err(format!(
            "{} is already there and isn’t {branch}’s worktree. Move it aside and try again.",
            path.display()
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("couldn’t make {}: {e}", parent.display()))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn worktree_bring(repo_root: String, branch: String) -> Result<BroughtWorktree, String> {
    crate::blocking::run(move || bring_branch(&repo_root, &branch)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(remote: bool, worktree: Option<(&str, bool)>, local_branch: bool, relation: Relation) -> BringFacts {
        BringFacts {
            remote,
            worktree: worktree.map(|(p, dirty)| ExistingWorktree { path: p.into(), dirty }),
            local_branch,
            relation,
        }
    }

    #[test]
    fn nothing_here_makes_a_worktree_from_githubs_copy() {
        assert_eq!(plan_bring("feat/x", &facts(true, None, false, Relation::Same)), BringStep::AddFromRemote);
    }

    #[test]
    fn a_branch_github_never_saw_is_refused() {
        let s = plan_bring("feat/x", &facts(false, None, false, Relation::Same));
        assert!(matches!(s, BringStep::Refuse(w) if w.contains("isn’t on GitHub")));
    }

    #[test]
    fn a_local_branch_checked_out_nowhere_is_reused_and_moved_forward_when_behind() {
        assert_eq!(
            plan_bring("b", &facts(true, None, true, Relation::Same)),
            BringStep::AddExisting { fast_forward: false }
        );
        assert_eq!(
            plan_bring("b", &facts(true, None, true, Relation::Ahead)),
            BringStep::AddExisting { fast_forward: false }
        );
        assert_eq!(
            plan_bring("b", &facts(true, None, true, Relation::Behind)),
            BringStep::AddExisting { fast_forward: true }
        );
    }

    #[test]
    fn an_open_worktree_is_used_and_moved_forward_only_when_clean() {
        assert_eq!(
            plan_bring("b", &facts(true, Some(("/w", false)), true, Relation::Behind)),
            BringStep::UseWorktree { path: "/w".into(), fast_forward: true }
        );
        assert_eq!(
            plan_bring("b", &facts(true, Some(("/w", true)), true, Relation::Same)),
            BringStep::UseWorktree { path: "/w".into(), fast_forward: false }
        );
        let s = plan_bring("b", &facts(true, Some(("/w", true)), true, Relation::Behind));
        assert!(matches!(s, BringStep::Refuse(w) if w.contains("aren’t committed")));
    }

    #[test]
    fn two_copies_that_both_moved_on_are_refused_wherever_they_are() {
        for wt in [None, Some(("/w", false))] {
            let s = plan_bring("b", &facts(true, wt, true, Relation::Diverged));
            assert!(matches!(s, BringStep::Refuse(w) if w.contains("both moved on")));
        }
    }

    #[test]
    fn the_worktree_holding_the_branch_is_found_in_porcelain() {
        let raw = "worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /w/feat\nHEAD def\nbranch refs/heads/feat/x\n\nworktree /w/det\nHEAD 123\ndetached\n";
        assert_eq!(worktree_with_branch(raw, "feat/x").as_deref(), Some("/w/feat"));
        assert_eq!(worktree_with_branch(raw, "main").as_deref(), Some("/repo"));
        assert_eq!(worktree_with_branch(raw, "feat"), None);
        assert_eq!(worktree_with_branch(raw, "nope"), None);
    }

    #[test]
    fn counts_and_missing_refs_are_read() {
        assert_eq!(parse_counts("2\t5"), Some((2, 5)));
        assert_eq!(parse_counts("0 0"), Some((0, 0)));
        assert_eq!(parse_counts("x"), None);
        assert_eq!(Relation::from_counts(0, 3), Relation::Behind);
        assert_eq!(Relation::from_counts(1, 3), Relation::Diverged);
        assert!(missing_remote_ref("fatal: couldn't find remote ref refs/heads/feat/x"));
        assert!(!missing_remote_ref("fatal: unable to access 'https://github.com/': Could not resolve host"));
    }

    /// The real thing, against throwaway repositories: a branch only GitHub
    /// (a bare "origin") has arrives as a tracking worktree, and a second
    /// bring after the cloud pushed again moves that worktree forward.
    #[test]
    fn a_cloud_branch_arrives_and_follows_later_pushes() {
        let tmp = std::env::temp_dir().join(format!("aura-bring-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let run = |cwd: &Path, args: &[&str]| git(cwd, args).unwrap();
        let origin = tmp.join("origin.git");
        let cloud = tmp.join("cloud");
        let laptop = tmp.join("laptop");
        run(&tmp, &["init", "--quiet", "--bare", "-b", "main", origin.to_str().unwrap()]);
        run(&tmp, &["clone", "--quiet", origin.to_str().unwrap(), cloud.to_str().unwrap()]);
        for (k, v) in [("user.email", "t@example.com"), ("user.name", "T")] {
            run(&cloud, &["config", k, v]);
        }
        run(&cloud, &["checkout", "--quiet", "-b", "main"]);
        run(&cloud, &["commit", "--quiet", "--allow-empty", "-m", "root"]);
        run(&cloud, &["push", "--quiet", "origin", "main"]);
        run(&tmp, &["clone", "--quiet", origin.to_str().unwrap(), laptop.to_str().unwrap()]);
        run(&cloud, &["checkout", "--quiet", "-b", "feat/cloud"]);
        run(&cloud, &["commit", "--quiet", "--allow-empty", "-m", "turn 1"]);
        run(&cloud, &["push", "--quiet", "origin", "feat/cloud"]);

        let facts = gather(&laptop, "feat/cloud").unwrap();
        assert_eq!(plan_bring("feat/cloud", &facts), BringStep::AddFromRemote);
        assert!(!gather(&laptop, "feat/never").unwrap().remote);

        // Add it beside the laptop clone rather than under the managed root,
        // the way `bring_branch` does after the plan.
        let wt = tmp.join("wt");
        run(&laptop, &["worktree", "add", "--quiet", "--no-track", "-b", "feat/cloud", wt.to_str().unwrap(), "origin/feat/cloud"]);
        track(&wt, "feat/cloud");
        assert_eq!(run(&wt, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feat/cloud");

        run(&cloud, &["commit", "--quiet", "--allow-empty", "-m", "turn 2"]);
        run(&cloud, &["push", "--quiet", "origin", "feat/cloud"]);
        let again = gather(&laptop, "feat/cloud").unwrap();
        assert_eq!(again.relation, Relation::Behind);
        let step = plan_bring("feat/cloud", &again);
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap();
        match step {
            BringStep::UseWorktree { path, fast_forward: true } => assert_eq!(canon(Path::new(&path)), canon(&wt)),
            other => panic!("expected a fast-forward of the open worktree, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
