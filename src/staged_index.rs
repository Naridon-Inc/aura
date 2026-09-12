//! Which index a commit-time check should read.
//!
//! `git commit -a` does not write the working-tree changes into `.git/index`.
//! It assembles them into a temporary index and tells everything it runs where
//! that index lives through the `GIT_INDEX_FILE` environment variable — the
//! same contract every hook inherits. libgit2 does not read that variable, so
//! `Repository::index()` hands back the untouched on-disk index instead: the
//! deletion guard, the scope check and the intent gate all ask "what is
//! staged", are told "nothing", and wave through a commit that is about to
//! delete an exported function. Staging the identical change by hand and
//! committing it blocks, as it should. The whole difference is one `-a`.
//!
//! So every repository opened on the commit path comes through here, and this
//! is the one place that knows the difference.

use git2::{Index, Repository};
use std::path::Path;

/// Point `repo` at the index git meant this process to read.
///
/// A no-op outside a hook, where `GIT_INDEX_FILE` is unset and the on-disk
/// index is already the right answer.
pub fn adopt(repo: &mut Repository) {
    let Ok(path) = std::env::var("GIT_INDEX_FILE") else {
        return;
    };
    adopt_path(repo, &path);
}

/// The half of [`adopt`] that does not read the environment.
///
/// Failure is deliberately silent: an unreadable path leaves the repository on
/// its default index rather than taking the hook down, because a gate that
/// cannot run must not become the reason a commit cannot happen.
fn adopt_path(repo: &mut Repository, path: &str) {
    if path.trim().is_empty() {
        return;
    }
    if let Ok(mut index) = Index::open(Path::new(path)) {
        let _ = repo.set_index(&mut index);
    }
}

/// Open a repository for a check that runs while a commit is being made.
pub fn open(path: &str) -> Result<Repository, git2::Error> {
    let mut repo = Repository::open(path)?;
    adopt(&mut repo);
    Ok(repo)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_repo(dir: &Path) -> Repository {
        let repo = Repository::init(dir).expect("a scratch repository");
        let mut config = repo.config().expect("its config");
        config.set_str("user.name", "Aura Test").ok();
        config.set_str("user.email", "test@aura.test").ok();
        repo
    }

    /// Outside a hook there is nothing to adopt, and the repository keeps
    /// reading the index it opened with.
    #[test]
    fn an_ordinary_shell_leaves_the_repository_on_its_own_index() {
        let dir = tempfile::tempdir().expect("a scratch directory");
        let mut repo = scratch_repo(dir.path());
        let before = repo.index().expect("the default index").path().map(|p| p.to_path_buf());

        adopt_path(&mut repo, "");

        let after = repo.index().expect("the default index").path().map(|p| p.to_path_buf());
        assert_eq!(before, after, "an empty GIT_INDEX_FILE must change nothing");
    }

    /// The shape of `git commit -a`: the on-disk index is empty, the real
    /// staged content lives in a second index file, and only a process that
    /// adopts it can see the file that is about to be committed.
    #[test]
    fn the_index_git_points_at_is_the_one_that_gets_read() {
        let dir = tempfile::tempdir().expect("a scratch directory");
        let mut repo = scratch_repo(dir.path());
        std::fs::write(dir.path().join("billing.rs"), "pub fn charge() {}\n").expect("a source file");

        // Let git stage it into a second index file, which is exactly what it
        // does for `commit -a`, leaving `.git/index` untouched.
        let alternate = dir.path().join(".git").join("index-for-this-commit");
        let staged = std::process::Command::new("git")
            .args(["add", "billing.rs"])
            .env("GIT_INDEX_FILE", &alternate)
            .current_dir(dir.path())
            .output()
            .expect("git add");
        assert!(staged.status.success(), "git should have written the alternate index");

        assert_eq!(
            repo.index().expect("the default index").len(),
            0,
            "the on-disk index is what makes the bug invisible: it stays empty"
        );

        adopt_path(&mut repo, alternate.to_str().expect("a utf-8 path"));

        let seen = repo.index().expect("the adopted index");
        assert_eq!(seen.len(), 1, "after adopting, the staged file is visible");
        assert!(seen.get_path(Path::new("billing.rs"), 0).is_some());
    }
}
