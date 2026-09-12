//! Project-wide safety snapshots that do not cost you your open work.
//!
//! `aura snapshot` and `aura restore` are the blunt end of recovery: one
//! marks "here is a good state", the other goes back to it. Both lived
//! inline in `main.rs` and both were careless with the thing the user is
//! actually holding — the uncommitted edits in their working tree.
//!
//! `aura snapshot` ran `git stash create`, printed the resulting hash and
//! did nothing else with it. A commit no ref points at is unreachable:
//! it survives only until git decides to collect it, and its only record
//! was a hex string in terminal scrollback. The line above it said
//! "Uncommitted work preserved", which it was not.
//!
//! `aura restore` ran `git reset --hard` and printed "(Note: Uncommitted
//! work has been nuked)". Recovery that destroys the work in progress is
//! not recovery — it is the failure mode people are afraid of, performed
//! by the tool they reached for to avoid it.
//!
//! Both now anchor the working tree in a real ref before anything moves,
//! and `restore` refuses to run at all if it cannot. What it saved, and
//! the one command that brings it back, is named in the output rather
//! than left to be reconstructed.
//!
//! Everything talks to git through [`Git`], so the decisions — what is
//! saved, what aborts, what is said afterwards — are testable without a
//! repository, and the one implementation that shells out stays a dozen
//! lines with no logic in it.

use std::path::Path;
use std::process::Command;

/// Somewhere for the decisions below to send git commands.
pub trait Git {
    /// Run `git <args>` in the repository, returning trimmed stdout.
    fn run(&mut self, args: &[&str]) -> Result<String, String>;
}

/// The real one: `git -C <repo_root> …`.
pub struct RealGit {
    pub repo_root: String,
}

impl RealGit {
    pub fn at(repo_root: &Path) -> Self {
        Self {
            repo_root: repo_root.to_string_lossy().into_owned(),
        }
    }

    /// Whatever repository the caller is standing in. Git walks up from
    /// here, so a subdirectory is fine.
    pub fn here() -> Self {
        Self::at(Path::new("."))
    }
}

impl Git for RealGit {
    fn run(&mut self, args: &[&str]) -> Result<String, String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.repo_root)
            .args(args)
            .output()
            .map_err(|e| format!("spawn git: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            } else {
                err
            });
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// The branch a snapshot's committed state lives on.
pub fn snapshot_branch(id: &str) -> String {
    format!("aura/snapshot/{id}")
}

/// The ref holding the uncommitted work as it stood when the snapshot was
/// taken. A ref, not a loose hash: an unreferenced commit is a hash you
/// have to have kept, and a candidate for collection either way.
pub fn worktree_ref(id: &str) -> String {
    format!("refs/aura/snapshots/{id}/worktree")
}

/// The ref holding what the working tree looked like immediately before a
/// restore overwrote it.
pub fn before_restore_ref(id: &str) -> String {
    format!("refs/aura/before-restore/{id}")
}

/// What a snapshot captured.
#[derive(Debug, Clone, PartialEq)]
pub struct Taken {
    pub id: String,
    pub branch: String,
    /// Set when there was uncommitted work to keep, and it was anchored.
    pub saved_worktree: Option<String>,
    /// Files git has never been told about. `git stash create` builds its
    /// commit from the index and the tracked tree, so these are not in the
    /// snapshot — and a snapshot that says "your uncommitted edits are
    /// saved" while quietly meaning "some of them" is the overclaim this
    /// whole module exists to stop making.
    pub untracked: Vec<String>,
}

/// `id`, or the first `id-2`, `id-3`… whose snapshot branch is free.
fn free_id(git: &mut impl Git, id: &str) -> String {
    let taken = |git: &mut dyn Git, candidate: &str| {
        git.run(&["rev-parse", "--verify", &format!("{}^{{commit}}", snapshot_branch(candidate))])
            .is_ok()
    };
    if !taken(git, id) {
        return id.to_string();
    }
    for n in 2..100 {
        let candidate = format!("{id}-{n}");
        if !taken(git, &candidate) {
            return candidate;
        }
    }
    format!("{id}-{}", std::process::id())
}

/// Take a project-wide snapshot: the committed state as a branch, and any
/// uncommitted tracked changes as an anchored commit beside it.
///
/// `git stash create` builds the commit without touching the working tree
/// or the shared stash stack — nothing the user is looking at moves, and
/// no entry lands on a stack other worktrees and sessions are using.
pub fn take(git: &mut impl Git, id: &str) -> Result<Taken, String> {
    // Ids are timestamps, and two snapshots can land in the same second.
    // Settle on a free one before writing anything, so neither snapshot
    // half-exists.
    let id = &free_id(git, id);
    let branch = snapshot_branch(id);
    let stash = git.run(&["stash", "create"]).unwrap_or_default();
    let saved_worktree = if stash.is_empty() {
        None
    } else {
        let r = worktree_ref(id);
        // Anchoring is what makes the promise true. If it fails, say so
        // rather than print a hash and call the work preserved.
        git.run(&["update-ref", &r, &stash])
            .map_err(|e| format!("could not keep your uncommitted work ({e})"))?;
        Some(r)
    };
    git.run(&["branch", &branch])
        .map_err(|e| format!("could not create {branch}: {e}"))?;
    Ok(Taken {
        id: id.to_string(),
        branch,
        saved_worktree,
        untracked: untracked_files(git),
    })
}

/// Files git has never been told about. Nothing here destroys them — a
/// hard reset leaves untracked files alone — but they are not in the
/// snapshot either, and only one of those two facts is obvious.
fn untracked_files(git: &mut impl Git) -> Vec<String> {
    git.run(&["ls-files", "--others", "--exclude-standard"])
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// What a restore did, in the order it did it.
#[derive(Debug, Clone, PartialEq)]
pub struct Restored {
    pub branch: String,
    /// Where the working tree that was replaced now lives. `None` only
    /// when there was nothing uncommitted to replace.
    pub previous_work: Option<String>,
    /// True when the snapshot's own uncommitted edits were put back, so
    /// the tree matches the moment the snapshot was taken rather than
    /// just its last commit.
    pub restored_worktree: bool,
    /// Set when those edits could not be replayed cleanly. The reset has
    /// happened; the edits are still in their ref, named here.
    pub worktree_conflict: Option<String>,
}

/// Move the working tree to `target` without destroying what is in it now.
///
/// Order matters and is the whole point: the current work is anchored
/// **before** anything is overwritten, and a failure to anchor it aborts
/// the move. `--hard` only runs once the thing it would destroy is
/// somewhere a human can get it back from. Returns the ref holding what
/// was replaced, or `None` when the tree was clean.
///
/// Every hard reset in Aura that runs against a checkout a person might
/// be working in should come through here.
pub fn reset_keeping_work(
    git: &mut impl Git,
    target: &str,
    now_id: &str,
) -> Result<Option<String>, String> {
    let current = git.run(&["stash", "create"]).unwrap_or_default();
    let saved = if current.is_empty() {
        None
    } else {
        let r = before_restore_ref(now_id);
        git.run(&["update-ref", &r, &current]).map_err(|e| {
            format!("refusing to reset: your uncommitted work could not be saved first ({e})")
        })?;
        Some(r)
    };

    git.run(&["reset", "--hard", target])
        .map_err(|e| format!("reset failed, nothing was lost: {e}"))?;

    Ok(saved)
}

/// What to say after [`reset_keeping_work`], for callers that are not
/// `restore` and have no `Restored` to describe.
pub fn kept_work_line(saved: &Option<String>) -> String {
    match saved {
        Some(r) => format!("What you had uncommitted is not gone: `git stash apply {r}`."),
        None => "You had nothing uncommitted, so nothing of yours was replaced.".to_string(),
    }
}

/// Go back to a snapshot without destroying what is in the tree now.
pub fn restore(git: &mut impl Git, id: &str, now_id: &str) -> Result<Restored, String> {
    let branch = snapshot_branch(id);
    git.run(&["rev-parse", "--verify", &format!("{branch}^{{commit}}")])
        .map_err(|_| format!("no snapshot {id} — `git branch --list 'aura/snapshot/*'` lists them"))?;

    // 1 & 2. Keep what is here now, then move the tree.
    let previous_work = reset_keeping_work(git, &branch, now_id)
        .map_err(|e| e.replace("refusing to reset", "refusing to restore"))?;

    // 3. Put the snapshot's own uncommitted edits back, so "restore" means
    //    the state that was snapshotted and not merely its last commit.
    let snap_work = worktree_ref(id);
    let mut restored_worktree = false;
    let mut worktree_conflict = None;
    if git.run(&["rev-parse", "--verify", &snap_work]).is_ok() {
        match git.run(&["stash", "apply", &snap_work]) {
            Ok(_) => restored_worktree = true,
            Err(_) => worktree_conflict = Some(snap_work),
        }
    }

    Ok(Restored {
        branch,
        previous_work,
        restored_worktree,
        worktree_conflict,
    })
}

/// What to tell someone after a snapshot, in the words they would use.
pub fn taken_lines(t: &Taken) -> Vec<String> {
    let mut out = vec![format!("Saved as {}.", t.branch)];
    match &t.saved_worktree {
        Some(r) => out.push(format!(
            "Your uncommitted edits to files git knows about are saved too, in {r} — `git stash apply {r}` brings them back on their own."
        )),
        None => out.push(
            "Nothing was uncommitted in the files git knows about, so there was nothing else to keep."
                .to_string(),
        ),
    }
    if !t.untracked.is_empty() {
        out.push(format!(
            "{} file(s) git has never been told about are not in the snapshot — they stay where they are, and coming back here will not remove them: {}",
            t.untracked.len(),
            preview(&t.untracked)
        ));
    }
    out.push(format!("To come back here: aura restore {}", t.id));
    out
}

/// A few names and a count, rather than a wall of paths.
fn preview(paths: &[String]) -> String {
    let shown: Vec<&str> = paths.iter().take(3).map(|s| s.as_str()).collect();
    if paths.len() > shown.len() {
        format!("{} and {} more", shown.join(", "), paths.len() - shown.len())
    } else {
        shown.join(", ")
    }
}

/// What to tell someone after a restore.
pub fn restored_lines(r: &Restored) -> Vec<String> {
    let mut out = vec![format!("Back to {}.", r.branch)];
    if r.restored_worktree {
        out.push("The edits that were uncommitted at snapshot time are back in the tree.".to_string());
    }
    if let Some(conflict) = &r.worktree_conflict {
        out.push(format!(
            "The snapshot's uncommitted edits did not reapply cleanly and were left alone — they are in {conflict}."
        ));
    }
    match &r.previous_work {
        Some(saved) => out.push(format!(
            "What you had uncommitted a moment ago is not gone: `git stash apply {saved}`."
        )),
        None => out.push("You had nothing uncommitted, so nothing of yours was replaced.".to_string()),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A git that answers from a script and records what it was asked.
    struct FakeGit {
        /// (first arg, reply) — Ok replies by command, in order of match.
        replies: Vec<(&'static str, Result<String, String>)>,
        pub seen: Vec<String>,
    }

    impl FakeGit {
        fn new(replies: Vec<(&'static str, Result<String, String>)>) -> Self {
            Self {
                replies,
                seen: Vec::new(),
            }
        }
        fn ran(&self, needle: &str) -> bool {
            self.seen.iter().any(|c| c.contains(needle))
        }
    }

    impl Git for FakeGit {
        fn run(&mut self, args: &[&str]) -> Result<String, String> {
            let line = args.join(" ");
            self.seen.push(line.clone());
            for (i, (prefix, _)) in self.replies.iter().enumerate() {
                if line.starts_with(prefix) {
                    return self.replies.remove(i).1;
                }
            }
            // Unscripted: a lookup finds nothing, anything else succeeds
            // quietly. Keeps each test's script down to what it is about.
            if line.starts_with("rev-parse") {
                return Err("unknown revision".to_string());
            }
            Ok(String::new())
        }
    }

    #[test]
    fn a_snapshot_anchors_the_uncommitted_work_it_claims_to_keep() {
        // `git stash create` makes a commit nothing points at. Printing
        // its hash and stopping there is not keeping it.
        let mut git = FakeGit::new(vec![("stash create", Ok("abc123".into()))]);
        let taken = take(&mut git, "1789").expect("snapshot");

        assert_eq!(taken.saved_worktree.as_deref(), Some("refs/aura/snapshots/1789/worktree"));
        assert!(git.ran("update-ref refs/aura/snapshots/1789/worktree abc123"));
        assert!(git.ran("branch aura/snapshot/1789"));
    }

    #[test]
    fn a_file_git_has_never_seen_is_not_claimed_as_saved() {
        // `git stash create` builds from the index and the tracked tree.
        // A brand-new file is in neither, and saying "your uncommitted
        // edits are saved" over the top of that is the exact overclaim
        // this module was written to stop.
        let mut git = FakeGit::new(vec![
            ("stash create", Ok("abc123".into())),
            ("ls-files --others", Ok("notes.txt\nscratch/idea.md".into())),
        ]);
        let taken = take(&mut git, "1789").expect("snapshot");

        assert_eq!(taken.untracked, vec!["notes.txt", "scratch/idea.md"]);
        let said = taken_lines(&taken).join(" ");
        assert!(said.contains("files git knows about"), "the claim is scoped");
        assert!(said.contains("not in the snapshot"));
        assert!(said.contains("will not remove them"), "and says they are safe");
    }

    #[test]
    fn two_snapshots_in_the_same_second_do_not_collide() {
        // Ids are unix seconds. The second one used to fail outright and
        // leave a worktree ref behind with no branch to go with it.
        let mut git = FakeGit::new(vec![
            ("rev-parse --verify aura/snapshot/1789^", Ok("deadbee".into())),
            ("rev-parse --verify aura/snapshot/1789-2^", Err("unknown".into())),
            ("stash create", Ok("abc123".into())),
        ]);
        let taken = take(&mut git, "1789").expect("snapshot");

        assert_eq!(taken.id, "1789-2");
        assert_eq!(taken.branch, "aura/snapshot/1789-2");
        assert!(git.ran("update-ref refs/aura/snapshots/1789-2/worktree"));
        assert!(!git.ran("refs/aura/snapshots/1789/worktree"), "no orphan ref under the taken id");
        assert!(taken_lines(&taken).join(" ").contains("aura restore 1789-2"));
    }

    #[test]
    fn a_snapshot_of_a_clean_tree_invents_nothing_to_keep() {
        let mut git = FakeGit::new(vec![("stash create", Ok(String::new()))]);
        let taken = take(&mut git, "1789").expect("snapshot");

        assert_eq!(taken.saved_worktree, None);
        assert!(!git.ran("update-ref"));
        assert!(taken_lines(&taken).join(" ").contains("nothing else to keep"));
    }

    #[test]
    fn a_snapshot_that_cannot_keep_the_work_says_so_instead_of_claiming_it_did() {
        let mut git = FakeGit::new(vec![
            ("stash create", Ok("abc123".into())),
            ("update-ref", Err("permission denied".into())),
        ]);
        let err = take(&mut git, "1789").expect_err("must not report success");

        assert!(err.contains("could not keep your uncommitted work"));
        assert!(!git.ran("branch"), "no snapshot branch after a failed save");
    }

    #[test]
    fn a_restore_saves_the_current_tree_before_overwriting_it() {
        let mut git = FakeGit::new(vec![
            ("rev-parse --verify aura/snapshot/1789", Ok("deadbee".into())),
            ("stash create", Ok("cur999".into())),
            ("rev-parse --verify refs/aura/snapshots", Err("missing".into())),
        ]);
        let done = restore(&mut git, "1789", "now42").expect("restore");

        assert_eq!(done.previous_work.as_deref(), Some("refs/aura/before-restore/now42"));
        // The order is the guarantee: anchored, then reset.
        let anchor = git.seen.iter().position(|c| c.starts_with("update-ref")).expect("anchored");
        let reset = git.seen.iter().position(|c| c.starts_with("reset --hard")).expect("reset");
        assert!(anchor < reset, "the tree was overwritten before it was saved");
        assert!(restored_lines(&done).join(" ").contains("is not gone"));
    }

    #[test]
    fn a_restore_that_cannot_save_the_current_tree_does_not_run() {
        // The old code said "(Note: Uncommitted work has been nuked)".
        // Nothing is nuked now: if it cannot be kept, the reset does not
        // happen.
        let mut git = FakeGit::new(vec![
            ("rev-parse --verify aura/snapshot/1789", Ok("deadbee".into())),
            ("stash create", Ok("cur999".into())),
            ("update-ref", Err("disk full".into())),
        ]);
        let err = restore(&mut git, "1789", "now42").expect_err("must refuse");

        assert!(err.contains("refusing to restore"));
        assert!(!git.ran("reset --hard"), "reset ran after failing to save the tree");
    }

    #[test]
    fn restoring_brings_back_the_edits_that_were_open_at_snapshot_time() {
        // A snapshot is a moment, not a commit. Coming back to it means
        // the half-finished edits too.
        let mut git = FakeGit::new(vec![
            ("rev-parse --verify aura/snapshot/1789", Ok("deadbee".into())),
            ("stash create", Ok(String::new())),
            ("rev-parse --verify refs/aura/snapshots/1789/worktree", Ok("abc123".into())),
            ("stash apply", Ok(String::new())),
        ]);
        let done = restore(&mut git, "1789", "now42").expect("restore");

        assert!(done.restored_worktree);
        assert_eq!(done.worktree_conflict, None);
        assert_eq!(done.previous_work, None);
    }

    #[test]
    fn edits_that_will_not_reapply_are_reported_not_forced() {
        let mut git = FakeGit::new(vec![
            ("rev-parse --verify aura/snapshot/1789", Ok("deadbee".into())),
            ("stash create", Ok(String::new())),
            ("rev-parse --verify refs/aura/snapshots/1789/worktree", Ok("abc123".into())),
            ("stash apply", Err("conflict in src/main.rs".into())),
        ]);
        let done = restore(&mut git, "1789", "now42").expect("restore");

        assert!(!done.restored_worktree);
        assert_eq!(
            done.worktree_conflict.as_deref(),
            Some("refs/aura/snapshots/1789/worktree")
        );
        assert!(restored_lines(&done).join(" ").contains("left alone"));
    }

    #[test]
    fn a_retry_that_rewinds_the_checkout_keeps_what_was_open_in_it() {
        // `aura orchestrate` rewinds the *user's* checkout when a wave
        // fails — up to three times. Their uncommitted work has to
        // survive that.
        let mut git = FakeGit::new(vec![("stash create", Ok("cur999".into()))]);
        let saved = reset_keeping_work(&mut git, "abc123", "now42").expect("reset");

        assert_eq!(saved.as_deref(), Some("refs/aura/before-restore/now42"));
        let anchor = git.seen.iter().position(|c| c.starts_with("update-ref")).expect("anchored");
        let reset = git.seen.iter().position(|c| c.starts_with("reset --hard")).expect("reset");
        assert!(anchor < reset);
        assert!(kept_work_line(&saved).contains("is not gone"));
    }

    #[test]
    fn a_rewind_that_cannot_keep_the_work_leaves_the_checkout_alone() {
        let mut git = FakeGit::new(vec![
            ("stash create", Ok("cur999".into())),
            ("update-ref", Err("disk full".into())),
        ]);
        let err = reset_keeping_work(&mut git, "abc123", "now42").expect_err("must refuse");

        assert!(err.contains("refusing to reset"));
        assert!(!git.ran("reset --hard"));
    }

    #[test]
    fn restoring_a_snapshot_that_does_not_exist_touches_nothing() {
        let mut git = FakeGit::new(vec![(
            "rev-parse --verify aura/snapshot/nope",
            Err("unknown revision".into()),
        )]);
        let err = restore(&mut git, "nope", "now42").expect_err("must refuse");

        assert!(err.contains("no snapshot nope"));
        assert!(!git.ran("reset"));
        assert!(!git.ran("stash create"));
    }
}
