//! Aura's own folder stays out of a nested repository that hasn't asked for it.
//!
//! The project keeps Aura's records in its `.aura/` folder. A repository
//! nested inside it has a history of its own, often a private one with its
//! own remote, and committing from Aura must not leave a `.aura/` folder in
//! it or in its commits. A nested repository that already has a `.aura/`
//! folder keeps getting Aura's commit marker there, so a hook that looks for
//! it still finds it. `.aura/` goes into its commits only when its history
//! already carries the folder.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::detect::{common_dir, git_line};

/// `repo_root`'s folder sits inside another repository's working tree, and
/// that repository isn't another checkout of the same one (a workspace kept
/// inside the project's own folder is the project).
///
/// A home folder kept in git (dotfiles) holds projects rather than being one,
/// so a repository inside it doesn't count as nested.
pub fn is_nested(repo_root: &Path) -> bool {
    let Some(top) = git_line(repo_root, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    let top = PathBuf::from(top);
    let Some(parent) = top.parent() else {
        return false;
    };
    let Some(outer) = git_line(parent, &["rev-parse", "--show-toplevel"]) else {
        return false;
    };
    let outer = PathBuf::from(outer);
    if is_home(&outer) {
        return false;
    }
    common_dir(&top) != common_dir(&outer)
}

fn is_home(dir: &Path) -> bool {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    dirs::home_dir().is_some_and(|home| canon(&home) == canon(dir))
}

/// Aura has no folder in `repo_root` and must not make one, because it is a
/// nested repository that hasn't been set up with Aura.
pub fn aura_stays_out(repo_root: &Path) -> bool {
    !repo_root.join(".aura").is_dir() && is_nested(repo_root)
}

/// Where a commit from Aura writes its marker and intent line: the
/// repository's `.aura/` folder, made if need be. A nested repository gets
/// them only when it already has the folder.
pub fn commit_marker_dir(repo_root: &Path) -> Option<PathBuf> {
    if aura_stays_out(repo_root) {
        return None;
    }
    let dir = repo_root.join(".aura");
    std::fs::create_dir_all(&dir).ok().map(|_| dir)
}

/// Before a commit in a nested repository whose history doesn't carry
/// `.aura/`, take anything under `.aura/` back out of what is staged. The
/// files stay on disk; they just don't go into that repository's history.
pub fn unstage_aura_in_nested(repo_root: &Path) {
    let staged = git_line(repo_root, &["ls-files", "--cached", "--", ".aura"]).is_some();
    if !staged || !is_nested(repo_root) || history_carries_aura(repo_root) {
        return;
    }
    let _ = Command::new("git")
        .args(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".aura"])
        .current_dir(repo_root)
        .output();
}

/// The repository's last commit already has a `.aura/` folder in it.
fn history_carries_aura(repo_root: &Path) -> bool {
    git_line(repo_root, &["ls-tree", "--name-only", "HEAD", "--", ".aura"]).is_some()
}
