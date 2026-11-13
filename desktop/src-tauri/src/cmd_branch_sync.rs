//! Where this branch stands against the branch its work goes into — the pull
//! request's base, or the repository's default branch — and the one git step
//! that brings it level when nothing here can be lost: a fast-forward.
//!
//! `git_ahead_behind` counts against the branch's own upstream ("1 commit
//! behind remote"). This counts against the target ("4 commits behind main"),
//! which is what the Checks tab's Pull row offers to bring in. Both read the
//! remote-tracking refs as they are; fetching is the caller's step.

use std::path::Path;
use std::process::{Command, Output};

use serde::Serialize;

/// The branch's distance from its target, counted on the remote-tracking ref.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TargetSync {
    /// The remote the target was read on (`origin` when there is one).
    pub remote: String,
    /// The target branch's short name, e.g. `main`.
    pub target: String,
    /// The full ref that was counted against, e.g. `refs/remotes/origin/main`.
    pub target_ref: String,
    /// Commits on this branch that the target doesn't have.
    pub ahead: u32,
    /// Commits on the target that this branch doesn't have.
    pub behind: u32,
}

/// A branch name that is safe to hand git as a ref component: never an
/// option, never a range, nothing a shell or a refspec would read twice.
fn branch_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-'))
}

/// The remote work is published to: `origin` when it exists, else the first
/// one git lists.
fn pick_remote(listing: &str) -> Option<String> {
    let names: Vec<&str> = listing.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
    if names.contains(&"origin") {
        return Some("origin".to_string());
    }
    names.first().map(|s| s.to_string())
}

/// `origin/main` → `main`, for the remote the short ref names.
fn strip_remote(remote: &str, short: &str) -> Option<String> {
    let rest = short.trim().strip_prefix(remote)?.strip_prefix('/')?;
    (branch_ok(rest) && rest != "HEAD").then(|| rest.to_string())
}

/// `refs/remotes/<remote>/<branch>`, when both halves are plain names.
fn remote_ref(remote: &str, branch: &str) -> Option<String> {
    (branch_ok(remote) && !remote.contains('/') && branch_ok(branch))
        .then(|| format!("refs/remotes/{remote}/{branch}"))
}

/// Whether `full_ref` is a remote-tracking ref this module would have built.
fn is_remote_ref(full_ref: &str) -> bool {
    match full_ref.strip_prefix("refs/remotes/") {
        Some(rest) => match rest.split_once('/') {
            Some((remote, branch)) => remote_ref(remote, branch).is_some(),
            None => false,
        },
        None => false,
    }
}

fn git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("couldn't run git in {}: {e}", cwd.display()))
}

fn ref_exists(cwd: &Path, full_ref: &str) -> Result<bool, String> {
    let out = git(cwd, &["rev-parse", "--verify", "--quiet", &format!("{full_ref}^{{commit}}")])?;
    Ok(out.status.success())
}

/// The target branch: the one asked for (the pull request's base), else the
/// remote's default branch (`refs/remotes/<remote>/HEAD`), else `main` or
/// `master`. `Ok(None)` when the repository has none of them.
fn resolve_target(cwd: &Path, remote: &str, wanted: Option<&str>) -> Result<Option<String>, String> {
    if let Some(name) = wanted.map(str::trim).filter(|s| !s.is_empty()) {
        let full = remote_ref(remote, name).ok_or_else(|| format!("`{name}` isn't a branch name"))?;
        return if ref_exists(cwd, &full)? {
            Ok(Some(name.to_string()))
        } else {
            Err(format!("Target branch {name} does not exist"))
        };
    }
    let head = git(cwd, &["symbolic-ref", "--quiet", "--short", &format!("refs/remotes/{remote}/HEAD")])?;
    if head.status.success() {
        if let Some(name) = strip_remote(remote, &String::from_utf8_lossy(&head.stdout)) {
            return Ok(Some(name));
        }
    }
    for name in ["main", "master"] {
        if let Some(full) = remote_ref(remote, name) {
            if ref_exists(cwd, &full)? {
                return Ok(Some(name.to_string()));
            }
        }
    }
    Ok(None)
}

fn first_line(out: &Output, fallback: &str) -> String {
    let err = String::from_utf8_lossy(&out.stderr);
    let err = err.trim();
    if err.is_empty() {
        fallback.to_string()
    } else {
        err.to_string()
    }
}

fn target_sync_at(cwd: &Path, target: Option<&str>) -> Result<Option<TargetSync>, String> {
    let remotes = git(cwd, &["remote"])?;
    if !remotes.status.success() {
        return Err(first_line(&remotes, "git couldn't list this repository's remotes"));
    }
    let Some(remote) = pick_remote(&String::from_utf8_lossy(&remotes.stdout)) else {
        return Ok(None);
    };
    let Some(name) = resolve_target(cwd, &remote, target)? else {
        return Ok(None);
    };
    let full = remote_ref(&remote, &name).ok_or_else(|| format!("`{name}` isn't a branch name"))?;
    let counts = git(cwd, &["rev-list", "--left-right", "--count", &format!("{full}...HEAD")])?;
    if !counts.status.success() {
        return Err(first_line(&counts, "git couldn't count this branch against its target"));
    }
    let (behind, ahead) =
        crate::git_parse::stats::parse_left_right_count(&String::from_utf8_lossy(&counts.stdout))?;
    Ok(Some(TargetSync {
        remote,
        target: name,
        target_ref: full,
        ahead,
        behind,
    }))
}

fn fast_forward_at(cwd: &Path, target_ref: &str) -> Result<(), String> {
    if !is_remote_ref(target_ref) {
        return Err(format!("`{target_ref}` isn't a remote branch"));
    }
    let out = git(cwd, &["merge", "--ff-only", target_ref])?;
    if !out.status.success() {
        return Err(first_line(&out, "Failed to pull latest"));
    }
    Ok(())
}

/// How far this branch is from its target. `target` is the pull request's
/// base when there is one; without it the remote's default branch is used.
/// `Ok(None)` when there is no remote or no target to count against.
#[tauri::command]
pub async fn git_target_sync(repo_root: String, target: Option<String>) -> Result<Option<TargetSync>, String> {
    crate::blocking::run(move || {
        let cwd = Path::new(&repo_root);
        if !cwd.is_dir() {
            return Err(format!("repo root does not exist: {repo_root}"));
        }
        target_sync_at(cwd, target.as_deref())
    })
    .await
}

/// Bring the branch up to its target when it has nothing the target lacks:
/// `git merge --ff-only <target_ref>`. Anything else — local commits, a dirty
/// tree in the way — is git's refusal, returned as the error.
#[tauri::command]
pub async fn git_fast_forward(repo_root: String, target_ref: String) -> Result<(), String> {
    crate::blocking::run(move || {
        let cwd = Path::new(&repo_root);
        if !cwd.is_dir() {
            return Err(format!("repo root does not exist: {repo_root}"));
        }
        fast_forward_at(cwd, &target_ref)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names_that_could_be_read_as_options_or_ranges_are_refused() {
        for ok in ["main", "release/1.2", "feat/chat-redesign", "v2.x"] {
            assert!(branch_ok(ok), "{ok}");
        }
        for bad in ["", "-x", "--upload-pack=x", "a..b", "a/", "/a", "a//b", "x.lock", "a b", "a;b", "a$(b)"] {
            assert!(!branch_ok(bad), "{bad}");
        }
    }

    #[test]
    fn origin_wins_over_other_remotes_and_the_first_is_used_without_it() {
        assert_eq!(pick_remote("upstream\norigin\n").as_deref(), Some("origin"));
        assert_eq!(pick_remote("upstream\nfork\n").as_deref(), Some("upstream"));
        assert_eq!(pick_remote("\n"), None);
    }

    #[test]
    fn the_default_branch_is_read_off_the_remote_head() {
        assert_eq!(strip_remote("origin", "origin/main\n").as_deref(), Some("main"));
        assert_eq!(strip_remote("origin", "origin/release/2").as_deref(), Some("release/2"));
        assert_eq!(strip_remote("origin", "upstream/main"), None);
        assert_eq!(strip_remote("origin", "origin/HEAD"), None);
    }

    #[test]
    fn only_remote_tracking_refs_can_be_fast_forwarded_to() {
        assert!(is_remote_ref("refs/remotes/origin/main"));
        assert!(is_remote_ref("refs/remotes/origin/release/2"));
        assert!(!is_remote_ref("refs/heads/main"));
        assert!(!is_remote_ref("origin/main"));
        assert!(!is_remote_ref("refs/remotes/origin/--help"));
        assert!(!is_remote_ref("refs/remotes/origin"));
    }

    fn run(cwd: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn commit(cwd: &Path, file: &str) {
        std::fs::write(cwd.join(file), file).unwrap();
        run(cwd, &["add", file]);
        // No signing and no hooks: whatever this machine's global config asks
        // of a real commit has no business in a scratch one.
        run(
            cwd,
            &[
                "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false",
                "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", file,
            ],
        );
    }

    /// A scratch remote and a clone of it, both in a temp dir — never the
    /// repository the tests run from.
    fn scratch() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let up = dir.path().join("up");
        std::fs::create_dir(&up).unwrap();
        run(&up, &["init", "-q", "-b", "main"]);
        commit(&up, "a");
        let here = dir.path().join("here");
        run(dir.path(), &["clone", "-q", up.to_str().unwrap(), here.to_str().unwrap()]);
        (dir, up, here)
    }

    #[test]
    fn a_branch_behind_its_target_is_counted_and_fast_forwarded() {
        let (_dir, up, here) = scratch();
        commit(&up, "b");
        commit(&up, "c");
        run(&here, &["fetch", "-q", "origin"]);
        let sync = target_sync_at(&here, None).unwrap().unwrap();
        assert_eq!(sync.target, "main");
        assert_eq!(sync.target_ref, "refs/remotes/origin/main");
        assert_eq!((sync.ahead, sync.behind), (0, 2));
        fast_forward_at(&here, &sync.target_ref).unwrap();
        let after = target_sync_at(&here, Some("main")).unwrap().unwrap();
        assert_eq!((after.ahead, after.behind), (0, 0));
    }

    #[test]
    fn a_diverged_branch_is_refused_a_fast_forward_and_a_missing_target_is_named() {
        let (_dir, up, here) = scratch();
        commit(&up, "b");
        commit(&here, "mine");
        run(&here, &["fetch", "-q", "origin"]);
        let sync = target_sync_at(&here, Some("main")).unwrap().unwrap();
        assert_eq!((sync.ahead, sync.behind), (1, 1));
        assert!(fast_forward_at(&here, &sync.target_ref).is_err());
        assert_eq!(
            target_sync_at(&here, Some("develop")).unwrap_err(),
            "Target branch develop does not exist"
        );
    }
}
