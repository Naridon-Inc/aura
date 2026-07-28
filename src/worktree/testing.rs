//! Test scaffolding for the worktree planes: a throwaway repository with as
//! many linked checkouts as a test needs, wired the way git wires them.
//!
//! Shared rather than copied per test module because getting the wiring subtly
//! wrong (a missing `commondir`, an unresolved symlink) makes a test pass for
//! the wrong reason.

use std::path::{Path, PathBuf};

/// Restores the process working directory when it drops. Every test that uses
/// this must also hold [`crate::TEST_CWD_LOCK`] — the cwd is process-global.
pub struct CwdGuard(PathBuf);

impl CwdGuard {
    pub fn enter() -> Self {
        CwdGuard(std::env::current_dir().expect("cwd"))
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.0);
    }
}

/// A main checkout plus zero or more linked worktrees.
pub struct FakeRepo {
    /// Kept alive so the tree isn't reaped mid-test.
    _tmp: tempfile::TempDir,
    /// The main checkout — the repository root, and the shared plane's anchor.
    pub main: PathBuf,
    /// Parent of the linked checkouts.
    pub trees: PathBuf,
}

impl FakeRepo {
    /// Path of a linked checkout by name.
    pub fn worktree(&self, name: &str) -> PathBuf {
        self.trees.join(name)
    }

    /// Enter a linked checkout. Pair with a held [`CwdGuard`].
    pub fn enter(&self, name: &str) {
        std::env::set_current_dir(self.worktree(name)).expect("cd worktree");
    }

    /// Enter the main checkout. Pair with a held [`CwdGuard`].
    pub fn enter_main(&self) {
        std::env::set_current_dir(&self.main).expect("cd main");
    }
}

/// Build a repository with a main checkout and one linked worktree per name.
///
/// The temp root is canonicalised up front: on macOS `/var/folders/…` is a
/// symlink to `/private/var/folders/…`, so a path captured before `chdir` would
/// stop matching the one resolved after it, and every assertion would compare
/// two spellings of the same directory.
pub fn fake_repo(names: &[&str]) -> FakeRepo {
    let tmp = tempfile::tempdir().expect("tmp");
    let base = std::fs::canonicalize(tmp.path()).expect("canonicalize tmp");
    let main = base.join("main");
    let trees = base.join("trees");
    std::fs::create_dir_all(main.join(".git")).expect("mkdir main/.git");
    std::fs::create_dir_all(&trees).expect("mkdir trees");

    for name in names {
        add_worktree(&main, &trees.join(name), name);
    }

    FakeRepo {
        _tmp: tmp,
        main,
        trees,
    }
}

/// Wire `path` as a linked worktree of `main`: a `.git` *file* pointing at
/// `<main>/.git/worktrees/<name>`, which carries the `commondir` that points
/// back. This is exactly the layout `git worktree add` produces.
fn add_worktree(main: &Path, path: &Path, name: &str) {
    let meta = main.join(".git").join("worktrees").join(name);
    std::fs::create_dir_all(&meta).expect("mkdir worktree meta");
    std::fs::create_dir_all(path).expect("mkdir worktree");
    std::fs::write(path.join(".git"), format!("gitdir: {}\n", meta.display()))
        .expect("write .git file");
    std::fs::write(meta.join("commondir"), "../..\n").expect("write commondir");
}
