//! Enumerate every checkout of this repository and read its git state.
//!
//! This is the ground truth the control plane is drawn on: which worktrees
//! exist, what branch each is on, how far it has drifted from trunk, and how
//! much uncommitted work is sitting in it. Agent activity is layered on top in
//! [`super::overview`].

use std::path::{Path, PathBuf};
use std::process::Command;

use super::paths;

/// One checkout of the repository.
#[derive(Debug, Clone, serde::Serialize)]
pub struct WorktreeInfo {
    /// `None` for the main checkout, `Some("barcelona")` for a linked worktree.
    pub name: Option<String>,
    pub path: PathBuf,
    /// Short commit id of its HEAD.
    pub head: String,
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    pub is_main: bool,
    /// A worktree directory git still knows about but that is gone from disk.
    pub missing: bool,
    pub locked: bool,
    /// Uncommitted (tracked + untracked) paths, from `git status --porcelain`.
    pub dirty_files: usize,
    /// Commits this checkout has that trunk does not, and vice versa.
    pub ahead: usize,
    pub behind: usize,
    /// Unix seconds of this checkout's HEAD commit — when work here last
    /// landed. `None` for a missing checkout, or a branch with no commits.
    ///
    /// A board that lists forty checkouts is unreadable in git's order; the
    /// only ordering a human recognises is "what did I touch, and when". This
    /// is the honest floor for that: the commit is a fact on disk, whereas an
    /// agent's awareness events only exist where an agent happened to run.
    /// Readers that have something fresher (a live claim, an unsaved edit)
    /// should take the later of the two.
    pub last_commit_at: Option<i64>,
}

impl WorktreeInfo {
    /// What to call it in output — the main checkout has no worktree name.
    pub fn label(&self) -> String {
        match &self.name {
            Some(n) => n.clone(),
            None => "main checkout".to_string(),
        }
    }
}

/// Run git in `dir`, returning trimmed stdout on success.
fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(dir).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The branch every worktree is measured against. `main` when it exists,
/// otherwise `master` — this repo has carried both.
pub fn trunk(root: &Path) -> String {
    for candidate in ["main", "master"] {
        if git(
            root,
            &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{candidate}")],
        )
        .is_some_and(|s| !s.is_empty())
        {
            return candidate.to_string();
        }
    }
    "main".to_string()
}

/// Parse `git worktree list --porcelain`. Records are blank-line separated and
/// always open with `worktree <path>`; `branch`/`detached`, `locked` and
/// `prunable` are optional lines within a record.
fn parse_porcelain(body: &str) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;

    for line in body.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            if let Some(w) = cur.take() {
                out.push(w);
            }
            continue;
        }
        let (key, rest) = match line.split_once(' ') {
            Some((k, r)) => (k, r),
            None => (line, ""),
        };
        match key {
            "worktree" => {
                if let Some(w) = cur.take() {
                    out.push(w);
                }
                let path = PathBuf::from(rest);
                cur = Some(WorktreeInfo {
                    name: path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string()),
                    missing: !path.exists(),
                    path,
                    head: String::new(),
                    branch: None,
                    // Fixed up below: git always lists the main checkout first.
                    is_main: false,
                    locked: false,
                    dirty_files: 0,
                    ahead: 0,
                    behind: 0,
                    last_commit_at: None,
                });
            }
            "HEAD" => {
                if let Some(w) = cur.as_mut() {
                    w.head = rest.chars().take(8).collect();
                }
            }
            "branch" => {
                if let Some(w) = cur.as_mut() {
                    w.branch = Some(rest.trim_start_matches("refs/heads/").to_string());
                }
            }
            "locked" => {
                if let Some(w) = cur.as_mut() {
                    w.locked = true;
                }
            }
            _ => {}
        }
    }
    if let Some(w) = cur.take() {
        out.push(w);
    }
    if let Some(first) = out.first_mut() {
        first.is_main = true;
        first.name = None;
    }
    out
}

/// Every checkout of this repository, without touching each one's working
/// tree. Cheap: a single `git worktree list`.
pub fn list() -> Vec<WorktreeInfo> {
    let Some(root) = paths::repo_root() else {
        return Vec::new();
    };
    let Some(body) = git(&root, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    parse_porcelain(&body)
}

/// Every checkout, plus its dirty-file count, drift from trunk, and when its
/// HEAD last moved.
///
/// Each worktree costs three git invocations, and a repo can carry dozens, so
/// they run concurrently — the wall clock is one worktree's, not the sum.
pub fn list_with_status() -> Vec<WorktreeInfo> {
    let mut trees = list();
    let Some(root) = paths::repo_root() else {
        return trees;
    };
    let trunk = trunk(&root);

    std::thread::scope(|s| {
        for w in trees.iter_mut() {
            let trunk = trunk.as_str();
            s.spawn(move || {
                if w.missing {
                    return;
                }
                if let Some(status) = git(&w.path, &["status", "--porcelain"]) {
                    w.dirty_files = status.lines().filter(|l| !l.trim().is_empty()).count();
                }
                // `--left-right` counts both sides in one pass: left = commits
                // only trunk has (behind), right = commits only we have (ahead).
                if let Some(counts) = git(
                    &w.path,
                    &["rev-list", "--left-right", "--count", &format!("{trunk}...HEAD")],
                ) {
                    let mut it = counts.split_whitespace();
                    w.behind = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                    w.ahead = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                }
                // Committer date, not author date: rebases and cherry-picks
                // keep the original author date, so a checkout you rebased an
                // hour ago would otherwise sort as months old.
                w.last_commit_at = git(&w.path, &["log", "-1", "--format=%ct"])
                    .and_then(|s| s.trim().parse::<i64>().ok());
            });
        }
    });

    trees
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_marks_the_first_record_as_the_main_checkout() {
        let body = "\
worktree /repo/main
HEAD 1234567890abcdef
branch refs/heads/main

worktree /repo/wt/barcelona
HEAD abcdef1234567890
branch refs/heads/feat/thing

worktree /repo/wt/detached
HEAD 0f0f0f0f0f0f0f0f
detached
";
        let trees = parse_porcelain(body);
        assert_eq!(trees.len(), 3);

        assert!(trees[0].is_main);
        assert_eq!(trees[0].name, None, "the main checkout has no worktree name");
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert_eq!(trees[0].head, "12345678", "head is shortened for display");

        assert!(!trees[1].is_main);
        assert_eq!(trees[1].name.as_deref(), Some("barcelona"));
        assert_eq!(trees[1].branch.as_deref(), Some("feat/thing"));
        assert_eq!(trees[1].label(), "barcelona");

        assert_eq!(trees[2].branch, None, "detached HEAD has no branch");
        assert_eq!(trees[0].label(), "main checkout");
    }

    #[test]
    fn porcelain_reads_a_trailing_record_without_a_blank_line() {
        // git omits the final separator when the output is piped.
        let trees = parse_porcelain("worktree /repo/main\nHEAD abc123\nbranch refs/heads/main");
        assert_eq!(trees.len(), 1);
        assert!(trees[0].is_main);
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn porcelain_notes_a_locked_worktree() {
        let trees = parse_porcelain(
            "worktree /repo/main\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo/wt/kyoto\nHEAD def456\nbranch refs/heads/kyoto\nlocked on removable media\n",
        );
        assert!(trees[1].locked);
        assert!(!trees[0].locked);
    }
}
