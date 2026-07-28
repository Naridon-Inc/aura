//! Where Aura's state lives when one repository has many checkouts.
//!
//! A git worktree is a second (third, tenth) checkout of the *same* repo. Aura
//! keeps two very different kinds of state, and they want opposite answers to
//! "is this shared?":
//!
//! * **Private plane** — your session, your transcript, your memory. These
//!   belong to *this* checkout. Two agents working side by side must not
//!   overwrite each other's session file, so this plane is namespaced per
//!   worktree: `<repo>/.aura/worktrees/<name>/…`.
//!
//! * **Shared plane** — sentinel claims, zones, agent-to-agent messages, and
//!   the awareness/radar feed. These exist *precisely* to tell one checkout
//!   what another is doing. Namespacing them per worktree was the bug: every
//!   worktree kept a private list of "who holds what", so the collision
//!   detector could only ever see itself, a message sent from `barcelona` was
//!   undeliverable to `granada`, and a zone claimed in one checkout protected
//!   nothing anywhere else. This plane anchors to the repository root:
//!   `<repo>/.aura/…` — the same place the main checkout already wrote to, so
//!   worktrees join the existing set rather than starting an empty one.
//!
//! Both planes resolve from the **repository root**, found by walking up from
//! the current directory. The old resolver only looked at `./.git`, so running
//! `aura` from a subdirectory silently created a fresh `.aura/` right there
//! (this repo still has the `aura-cli/.aura` and `aura-shell/.aura` litter to
//! prove it). Walking up fixes that for both planes at once.

use std::path::{Component, Path, PathBuf};

/// Directory under `.aura/` that holds the per-checkout private plane.
const PRIVATE_ROOT: &str = "worktrees";

/// Lexically normalise a path: drop `.`, resolve `..` against the preceding
/// component, keep the root.
///
/// Deliberately NOT [`std::fs::canonicalize`]: that requires the path to exist
/// and resolves symlinks, which on macOS rewrites `/var/…` to `/private/var/…`.
/// A root resolved that way would stop matching the cwd the user is standing
/// in, and every "is this file inside the repo?" test would start failing.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                let can_pop = out
                    .components()
                    .next_back()
                    .is_some_and(|c| !matches!(c, Component::RootDir | Component::Prefix(_)));
                if can_pop {
                    out.pop();
                } else if !out.has_root() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve `p` against `base` when it is relative, then normalise.
fn resolve_against(base: &Path, p: &Path) -> PathBuf {
    if p.is_absolute() {
        normalize(p)
    } else {
        normalize(&base.join(p))
    }
}

/// Given a `.git` *file* (the marker of a linked worktree), find the main
/// repository's `.git` directory.
///
/// The file holds `gitdir: <path>` pointing at `<main>/.git/worktrees/<name>`.
/// Inside that directory git writes `commondir`, whose contents (usually
/// `../..`) point back at the real `<main>/.git`. Reading `commondir` is the
/// authoritative route and survives layouts where the worktree metadata is not
/// three levels down; the parent-walk is the fallback for a truncated checkout.
fn common_git_dir_from_file(git_file: &Path) -> Option<PathBuf> {
    let here = git_file.parent()?;
    let body = std::fs::read_to_string(git_file).ok()?;
    let gitdir = body.trim().strip_prefix("gitdir:")?.trim();
    if gitdir.is_empty() {
        return None;
    }
    let wt_gitdir = resolve_against(here, Path::new(gitdir));

    if let Ok(common) = std::fs::read_to_string(wt_gitdir.join("commondir")) {
        let common = common.trim();
        if !common.is_empty() {
            return Some(resolve_against(&wt_gitdir, Path::new(common)));
        }
    }
    // `<main>/.git/worktrees/<name>` → `<main>/.git`
    wt_gitdir.parent()?.parent().map(|p| p.to_path_buf())
}

/// The checkout you are standing in — the directory holding the `.git` entry,
/// whether that is a real directory (main checkout) or a file (linked
/// worktree). Walks up, so a subdirectory resolves to its checkout.
pub fn checkout_root_from(start: &Path) -> Option<PathBuf> {
    let mut dir = resolve_against(&std::env::current_dir().ok()?, start);
    loop {
        let git = dir.join(".git");
        if git.is_dir() || git.is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// The checkout you are standing in, from the current directory.
pub fn checkout_root() -> Option<PathBuf> {
    checkout_root_from(Path::new("."))
}

/// The **repository** root: the main checkout, even when you are standing in a
/// linked worktree. This is the anchor for the shared plane.
pub fn repo_root_from(start: &Path) -> Option<PathBuf> {
    let mut dir = resolve_against(&std::env::current_dir().ok()?, start);
    loop {
        let git = dir.join(".git");
        if git.is_dir() {
            return Some(dir);
        }
        if git.is_file() {
            if let Some(common) = common_git_dir_from_file(&git) {
                // `<main>/.git` → `<main>`. A bare repo has no parent checkout;
                // fall back to the directory the worktree metadata sits in.
                return common.parent().map(|p| p.to_path_buf()).or(Some(common));
            }
            // A `.git` file we can't parse still marks a checkout boundary;
            // treat it as the root rather than escaping into the parent tree.
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// The repository root, from the current directory.
pub fn repo_root() -> Option<PathBuf> {
    repo_root_from(Path::new("."))
}

/// Name of the checkout you are standing in: `None` in the main checkout,
/// `Some("barcelona")` in a linked worktree.
///
/// The directory basename (not git's internal worktree id) is the name on
/// purpose: it is what the human sees in their shell prompt and their editor
/// title, and it is the key the private plane has always been stored under, so
/// existing session state stays reachable.
pub fn current_worktree_from(start: &Path) -> Option<String> {
    let checkout = checkout_root_from(start)?;
    let repo = repo_root_from(start)?;
    if checkout == repo {
        return None;
    }
    checkout
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
}

/// Name of the checkout you are standing in, from the current directory.
pub fn current_worktree() -> Option<String> {
    current_worktree_from(Path::new("."))
}

/// Path for **shared** state — visible to every checkout of this repository.
/// Sentinel claims, zones, messages and the awareness feed live here.
///
/// Outside a git repository this falls back to a plain relative `.aura/<sub>`,
/// which is what every caller did before worktrees existed.
pub fn shared_aura_path(subdir: &str) -> String {
    match repo_root() {
        Some(root) => join_sub(root.join(".aura"), subdir),
        None => relative_fallback(subdir),
    }
}

/// `Path::join("")` leaves a trailing separator, so an empty `subdir` — the
/// "just give me the plane's directory" case the CLI prints — would come back
/// as `…/.aura/`. Only join when there is something to join.
fn join_sub(base: PathBuf, subdir: &str) -> String {
    if subdir.is_empty() {
        base.to_string_lossy().to_string()
    } else {
        base.join(subdir).to_string_lossy().to_string()
    }
}

fn relative_fallback(subdir: &str) -> String {
    if subdir.is_empty() {
        ".aura".to_string()
    } else {
        format!(".aura/{subdir}")
    }
}

/// Path for **private** state — this checkout's own sessions, transcripts and
/// memory, which must not collide with a sibling worktree's.
pub fn private_aura_path(subdir: &str) -> String {
    let Some(root) = repo_root() else {
        return relative_fallback(subdir);
    };
    let base = root.join(".aura");
    match current_worktree() {
        Some(name) => join_sub(base.join(PRIVATE_ROOT).join(name), subdir),
        None => join_sub(base, subdir),
    }
}

/// Rewrite a path so it names the same source file from *any* checkout.
///
/// Claims and awareness events are matched across worktrees by `(file,
/// symbol)`. An absolute path carries the checkout it was recorded in, so
/// `…/barcelona/src/auth.rs` and `…/granada/src/auth.rs` are the same file to a
/// human and two different files to a string compare — collisions between
/// worktrees would never be detected. Anchoring to the checkout root makes the
/// key portable. Paths already relative, or outside any checkout, are returned
/// unchanged.
pub fn repo_relative(file_path: &str) -> String {
    let p = Path::new(file_path);
    if !p.is_absolute() {
        return file_path.to_string();
    }
    let normalized = normalize(p);
    // Try the checkout first (the common case), then the repository root, so a
    // path recorded from the main checkout also strips correctly.
    for root in [checkout_root(), repo_root()].into_iter().flatten() {
        if let Ok(rel) = normalized.strip_prefix(&root) {
            let rel = rel.to_string_lossy().to_string();
            if !rel.is_empty() {
                return rel;
            }
        }
    }
    file_path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::testing::{fake_repo, CwdGuard};
    use crate::TEST_CWD_LOCK as SERIAL;

    #[test]
    fn normalize_resolves_dot_segments_without_touching_disk() {
        assert_eq!(normalize(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(normalize(Path::new("a/b/../../c")), PathBuf::from("c"));
        // Never climbs above the root.
        assert_eq!(normalize(Path::new("/../..")), PathBuf::from("/"));
    }

    #[test]
    fn main_checkout_keeps_both_planes_in_one_place() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona"]);
        repo.enter_main();

        assert_eq!(repo_root().as_deref(), Some(repo.main.as_path()));
        assert_eq!(current_worktree(), None, "main checkout is not a worktree");
        assert_eq!(
            shared_aura_path("sentinel/claims"),
            repo.main.join(".aura/sentinel/claims").to_string_lossy()
        );
        assert_eq!(
            private_aura_path("sessions"),
            repo.main.join(".aura/sessions").to_string_lossy()
        );
    }

    /// The heart of it: a linked worktree must land its shared state in the
    /// *main* repo's `.aura`, and its private state in its own namespace.
    #[test]
    fn worktree_shares_the_repo_plane_and_keeps_a_private_one() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona"]);
        repo.enter("barcelona");

        assert_eq!(repo_root().as_deref(), Some(repo.main.as_path()));
        assert_eq!(
            checkout_root().as_deref(),
            Some(repo.worktree("barcelona").as_path())
        );
        assert_eq!(current_worktree().as_deref(), Some("barcelona"));

        // Shared: the SAME directory the main checkout writes to. This is what
        // makes one worktree's claims visible to another.
        assert_eq!(
            shared_aura_path("sentinel/claims"),
            repo.main.join(".aura/sentinel/claims").to_string_lossy()
        );
        // Private: namespaced, so two agents never trample one session file.
        assert_eq!(
            private_aura_path("sessions"),
            repo.main
                .join(".aura/worktrees/barcelona/sessions")
                .to_string_lossy()
        );
    }

    #[test]
    fn two_worktrees_share_one_plane_and_split_the_other() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona", "granada"]);

        repo.enter("barcelona");
        let (shared_a, private_a) = (shared_aura_path("sentinel"), private_aura_path("sessions"));
        repo.enter("granada");
        let (shared_b, private_b) = (shared_aura_path("sentinel"), private_aura_path("sessions"));

        assert_eq!(shared_a, shared_b, "sentinel must be one shared set");
        assert_ne!(private_a, private_b, "sessions must stay per-checkout");
    }

    /// The stray-`.aura` bug: the old resolver only looked at `./.git`, so any
    /// command run from a subdirectory created state there instead.
    #[test]
    fn a_subdirectory_still_resolves_to_its_checkout() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona"]);
        let deep = repo.worktree("barcelona").join("aura-cli").join("src");
        std::fs::create_dir_all(&deep).expect("mkdir deep");
        std::env::set_current_dir(&deep).expect("cd");

        assert_eq!(current_worktree().as_deref(), Some("barcelona"));
        assert_eq!(
            shared_aura_path("sentinel"),
            repo.main.join(".aura/sentinel").to_string_lossy(),
            "must not mint aura-cli/.aura"
        );
        assert_eq!(
            private_aura_path("sessions"),
            repo.main
                .join(".aura/worktrees/barcelona/sessions")
                .to_string_lossy()
        );
    }

    #[test]
    fn outside_a_repo_both_planes_fall_back_to_a_relative_path() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let tmp = tempfile::tempdir().expect("tmp");
        std::env::set_current_dir(tmp.path()).expect("cd");

        assert_eq!(repo_root(), None);
        assert_eq!(shared_aura_path("sentinel"), ".aura/sentinel");
        assert_eq!(private_aura_path("sessions"), ".aura/sessions");
    }

    #[test]
    fn repo_relative_makes_a_claim_key_portable_across_checkouts() {
        let _lk = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _g = CwdGuard::enter();
        let repo = fake_repo(&["barcelona"]);
        let wt = repo.worktree("barcelona");
        std::fs::create_dir_all(wt.join("src")).expect("mkdir");
        repo.enter("barcelona");

        let abs = wt.join("src").join("auth.rs").to_string_lossy().to_string();
        assert_eq!(repo_relative(&abs), "src/auth.rs");
        // Already relative, or outside any checkout — left alone.
        assert_eq!(repo_relative("src/auth.rs"), "src/auth.rs");
        assert_eq!(repo_relative("/elsewhere/x.rs"), "/elsewhere/x.rs");
    }
}
