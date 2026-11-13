//! Nested repositories: folders inside a project that are git repositories
//! of their own.
//!
//! - [`detect`] finds them (bounded walk, submodules labelled).
//! - [`worktrees`] gives a workspace copy a matching copy of each one and
//!   cleans up after it.
//! - [`route`] sends a git command about a file to the repository that owns
//!   it, so diffs, blame and staging work for files inside them.
//! - [`aura_dir`] keeps Aura's own `.aura/` folder out of a nested
//!   repository that hasn't been set up with Aura.
//!
//! Everything here reads the local disk. A project open on another machine
//! goes through that machine's own surface and is not walked from here.

mod aura_dir;
mod detect;
mod route;
mod worktrees;

use std::path::Path;

pub use aura_dir::{aura_stays_out, commit_marker_dir, is_nested, unstage_aura_in_nested};
pub use detect::{detect_nested_repos, NestedRepo};
pub use route::{group_by_owner, owning_repo};
pub use worktrees::{
    create_nested_worktrees, nested_dirty, nested_worktree_commons, project_nested_commons,
    prune_nested, NestedCopyState, NestedDirty, NestedWorktreeOutcome,
};

/// Every nested repository and submodule under a project root.
#[tauri::command]
pub async fn nested_repos_list(root: String) -> Vec<NestedRepo> {
    crate::blocking::run(move || detect_nested_repos(Path::new(&root))).await
}

/// Nested repositories under `root` that deleting it would lose work from.
#[tauri::command]
pub async fn nested_repos_dirty(root: String) -> Vec<NestedDirty> {
    crate::blocking::run(move || nested_dirty(Path::new(&root))).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    pub fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed in {}: {}",
            cwd.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A fresh, uniquely named folder under the system temp dir.
    pub fn scratch(tag: &str) -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aura-nested-{tag}-{}-{nanos}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// A repository on `main` with one commit.
    pub fn init_repo(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "t@t.t"]);
        git(dir, &["config", "user.name", "t"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        git(dir, &["config", "core.hooksPath", "/dev/null"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "README.md"]);
        git(dir, &["commit", "-q", "-m", "init"]);
    }
}

#[cfg(test)]
mod commands_tests;

#[cfg(test)]
mod aura_dir_tests;
