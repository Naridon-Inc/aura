//! Which project is this folder, and which org does it push to?
//!
//! The *naming* rule itself lives in [`aura_repo_identity`] and is re-exported
//! below, because the desktop is not the only client that has to answer it:
//! `aura-cli` answers it too, and when each crate carried its own copy they
//! drifted — the desktop filing a remote-less project as
//! `local/<dirname>-<id>` while the CLI filed the same folder as
//! `local/<dirname>`, so one project became two cloud rows.
//!
//! What stays here is what only the desktop has:
//!
//! * **[`ProjectBinding`] — the org this project pushes to, chosen not
//!   inferred.** A bound project sends its org on every cloud request; the
//!   server validates that claim against the caller's membership rather than
//!   assuming whichever org happened to sort first.
//! * **[`repo_slug`] — the name including that binding.** An explicit
//!   `repo_full_name` override wins over anything derived from disk, which is
//!   the one place the desktop's answer may differ from the rule's.
//! * **[`branch`] — which branch this checkout has out**, read from *this*
//!   worktree's own gitdir rather than the shared one.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Filename under `.aura/` holding the explicit project → org binding.
const BINDING_FILE: &str = "cloud_binding.json";

/// The header carrying a bound project's org choice. Mirrors
/// `aura_cloud::org_selection::ORG_HEADER` — the server resolves the value
/// against the caller's own membership, so a claim it cannot back up is a 403
/// rather than a silent write into someone else's org.
pub const ORG_HEADER: &str = "X-Aura-Org";

// ─── Explicit binding ───────────────────────────────────────────────────────

/// The recorded answer to "where does this project live in the cloud?".
///
/// Written by the user (or the connect wizard) picking an org, never guessed.
/// Both fields are optional on purpose: binding only the org is the common
/// case, while `repo_full_name` exists for the repo whose canonical name
/// cannot be derived — a mirror pushed to two hosts, or a project deliberately
/// filed under a name that isn't its remote.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProjectBinding {
    /// Org id or slug, as understood by the cloud's `X-Aura-Org` header.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org: Option<String>,
    /// Explicit override for the repo's canonical name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_full_name: Option<String>,
    /// RFC3339 stamp of when the choice was made — so a stale binding is
    /// visible as stale rather than looking like a fresh decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_at: Option<String>,
}

impl ProjectBinding {
    pub fn path_in(repo_root: &Path) -> PathBuf {
        repo_root.join(".aura").join(BINDING_FILE)
    }

    /// Read the binding, or `None` when the project has never been bound.
    /// A corrupt file reads as unbound rather than failing the caller — an
    /// unreadable binding must not take the whole sync path down with it.
    pub fn read(repo_root: &Path) -> Option<Self> {
        let raw = std::fs::read_to_string(Self::path_in(repo_root)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Persist the choice. Creates `.aura/` if the project has never been
    /// touched by Aura.
    pub fn write(&self, repo_root: &Path) -> Result<(), String> {
        let path = Self::path_in(repo_root);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|e| format!("encode: {e}"))?;
        std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
    }
}

/// The org this project acts as, when one was explicitly chosen.
///
/// `None` means "unbound" — the cloud then falls back to the caller's default
/// org exactly as it did before, so nothing breaks for a project nobody has
/// bound yet.
pub fn bound_org(repo_root: &Path) -> Option<String> {
    ProjectBinding::read(repo_root)?
        .org
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Record the org a project pushes to, preserving any name override already
/// stored alongside it.
pub fn bind_org(repo_root: &Path, org: Option<&str>) -> Result<ProjectBinding, String> {
    let mut binding = ProjectBinding::read(repo_root).unwrap_or_default();
    binding.org = org
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    binding.bound_at = Some(chrono::Utc::now().to_rfc3339());
    binding.write(repo_root)?;
    Ok(binding)
}

// ─── Canonical repo name ────────────────────────────────────────────────────

/// The canonical name of the repo at `repo_root`, always. An explicit binding
/// wins, then the origin remote, then the project's own local id.
///
/// This is the value that goes into `repos.github_full_name`, so it is the one
/// function the whole app should agree on.
pub fn repo_slug(repo_root: &Path) -> String {
    if let Some(name) = ProjectBinding::read(repo_root)
        .and_then(|b| b.repo_full_name)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return name;
    }
    remote_slug_for_repo(repo_root).unwrap_or_else(|| local_project_slug(repo_root))
}

// ─── The naming rule ────────────────────────────────────────────────────────
//
// Re-exported rather than restated. Every one of these was defined here and in
// `aura-cli` separately, and the two answers disagreed for exactly the projects
// that have no remote — which is most of the rows in a production picker.

pub use aura_repo_identity::{
    local_project_slug, origin_url, remote_slug_for_repo, worktree_name,
};

/// The names an older build filed this checkout under, so the cloud can move
/// their history onto the project it actually belongs to.
///
/// Thin wrapper over [`aura_repo_identity::superseded_slugs`] that passes the
/// desktop's own answer for "what is this project called now" — which honours
/// an explicit [`ProjectBinding`] and so can differ from the derived name.
pub fn superseded_slugs(repo_root: &Path) -> Vec<String> {
    aura_repo_identity::superseded_slugs(repo_root, &repo_slug(repo_root))
}

/// The branch checked out at `repo_root`, or `None` on a detached HEAD.
///
/// Reads `HEAD` out of *this* checkout's gitdir — the linked worktree's own,
/// not the main repo's, which is the whole point: two worktrees of one project
/// are on two branches, and reporting the main checkout's branch for both
/// would make the label a lie.
pub fn branch(repo_root: &Path) -> Option<String> {
    let head = std::fs::read_to_string(head_dir(repo_root)?.join("HEAD")).ok()?;
    let name = head.trim().strip_prefix("ref:")?.trim();
    let name = name.strip_prefix("refs/heads/").unwrap_or(name);
    (!name.is_empty()).then(|| name.to_string())
}

/// The directory holding *this* checkout's `HEAD` and `index`.
///
/// Unlike [`git_dir`], this does not walk up out of `worktrees/<name>`:
/// per-worktree state lives there and only the shared config lives above it.
fn head_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    let target = pointer.trim().strip_prefix("gitdir:")?.trim();
    Some(if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        repo_root.join(target)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Worktrees are one project ─────────────────────────────────────────
    //
    // Found live: 26 of the 28 desktop sessions on MHASK/aura-sovereign were
    // run in linked worktrees, and the shipped shell read
    // `<root>/.git/config` as a directory — which a worktree's `.git` is not,
    // it is a file — so every one of them was filed under a made-up project
    // named after the worktree folder (`local/granada`). The console's repo
    // picker then showed them as a different project, and the roster for the
    // real one looked empty.

    /// Lay down the exact on-disk shape `git worktree add` produces: a main
    /// checkout with `.git/`, and a linked worktree whose `.git` is a file
    /// pointing at `<main>/.git/worktrees/<name>` — a directory that holds
    /// per-worktree `HEAD` but deliberately *no* `config`.
    fn worktree_fixture(origin: &str, branch: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("project");
        let git = main.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(
            git.join("config"),
            format!("[remote \"origin\"]\n\turl = {origin}\n"),
        )
        .unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let linked_git = git.join("worktrees").join("granada");
        std::fs::create_dir_all(&linked_git).unwrap();
        std::fs::write(linked_git.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();

        let wt = tmp.path().join("elsewhere").join("granada");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", linked_git.display()),
        )
        .unwrap();
        (tmp, main, wt)
    }

    #[test]
    fn a_worktree_is_filed_under_the_project_it_is_a_worktree_of() {
        let (_tmp, main, wt) = worktree_fixture("https://github.com/MHASK/aura-sovereign.git", "feat/x");
        assert_eq!(repo_slug(&main), "MHASK/aura-sovereign");
        // The bug, pinned: this used to fall through to `local/granada`
        // because `<wt>/.git/config` cannot be read — `.git` is a file.
        assert_eq!(repo_slug(&wt), "MHASK/aura-sovereign");
    }

    #[test]
    fn a_worktree_still_says_which_worktree_and_branch_it_is() {
        let (_tmp, main, wt) = worktree_fixture("https://github.com/MHASK/aura-sovereign.git", "feat/x");
        // Rolling worktrees up under one project must not lose the split —
        // it becomes a label rather than a separate project.
        assert_eq!(worktree_name(&wt).as_deref(), Some("granada"));
        assert_eq!(branch(&wt).as_deref(), Some("feat/x"));
        // The main checkout is not a worktree of anything, and reads its own
        // HEAD rather than the linked one's.
        assert_eq!(worktree_name(&main), None);
        assert_eq!(branch(&main).as_deref(), Some("main"));
    }

    #[test]
    fn a_detached_head_has_no_branch_rather_than_a_wrong_one() {
        let (_tmp, main, _wt) = worktree_fixture("https://github.com/MHASK/aura-sovereign.git", "feat/x");
        std::fs::write(
            main.join(".git").join("HEAD"),
            "9fceb02d0ae598e95dc970b74767f19372d61af8\n",
        )
        .unwrap();
        assert_eq!(branch(&main), None);
    }

    #[test]
    fn a_folder_that_is_not_a_repo_claims_no_worktree_or_branch() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(worktree_name(tmp.path()), None);
        assert_eq!(branch(tmp.path()), None);
    }

    #[test]
    fn a_submodule_is_a_repo_of_its_own_not_a_worktree_view() {
        // A submodule's `.git` is also a file, and pointing it at
        // `<parent>/.git/modules/<name>` must not read as a worktree — it is a
        // different repo, so its sessions belong to it and not to the parent.
        let tmp = tempfile::tempdir().unwrap();
        let sub = tmp.path().join("vendor").join("lib");
        std::fs::create_dir_all(&sub).unwrap();
        let modules = tmp.path().join(".git").join("modules").join("lib");
        std::fs::create_dir_all(&modules).unwrap();
        std::fs::write(sub.join(".git"), format!("gitdir: {}\n", modules.display())).unwrap();
        assert_eq!(worktree_name(&sub), None);
    }

    #[test]
    fn a_worktree_names_the_phantom_repos_its_history_is_stranded_under() {
        // The exact production shape: sessions filed under `local/granada`,
        // which is not a project — it is a worktree of MHASK/aura-sovereign.
        // Saying so is what lets the server merge them back, and only this
        // machine is in a position to say it. Production carries two
        // generations of that phantom, so both spellings are claimed.
        let (_tmp, _main, wt) = worktree_fixture("git@github.com:MHASK/aura-sovereign.git", "feat/x");
        let claimed = superseded_slugs(&wt);
        assert_eq!(claimed[0], "local/granada");
        assert!(claimed[1].starts_with("local/granada-"), "{claimed:?}");
        assert_eq!(claimed.len(), 2, "{claimed:?}");
    }

    #[test]
    fn a_binding_decides_what_counts_as_a_former_name() {
        // `repo_slug` is the desktop's answer, and an explicit binding
        // overrides the derived one. A project bound to a name of its own must
        // still be able to reclaim the local rows it left behind — and must
        // never claim the name it is bound to.
        let (_tmp, main, _wt) = worktree_fixture("git@github.com:MHASK/aura-sovereign.git", "main");
        ProjectBinding {
            repo_full_name: Some("MHASK/renamed".to_string()),
            ..Default::default()
        }
        .write(&main)
        .unwrap();
        assert_eq!(repo_slug(&main), "MHASK/renamed");
        let claimed = superseded_slugs(&main);
        assert!(claimed.iter().all(|n| n.starts_with("local/")), "{claimed:?}");
        assert!(!claimed.contains(&"MHASK/renamed".to_string()), "{claimed:?}");
    }

    #[test]
    fn a_worktree_that_really_is_local_does_not_ask_to_merge_with_itself() {
        // No remote, so `repo_slug` answers a `local/` name of its own. If that
        // happened to equal the phantom spelling, declaring it would be asking
        // the server to merge a row into itself.
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        std::fs::create_dir_all(main.join(".git").join("worktrees").join("granada")).unwrap();
        std::fs::write(main.join(".git").join("config"), "[core]\n").unwrap();
        std::fs::write(
            main.join(".git").join("worktrees").join("granada").join("HEAD"),
            "ref: refs/heads/feat/x\n",
        )
        .unwrap();
        let linked = tmp.path().join("granada");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(
            linked.join(".git"),
            format!("gitdir: {}\n", main.join(".git").join("worktrees").join("granada").display()),
        )
        .unwrap();
        // Whatever local name it derives, it must never be the phantom one.
        for claimed in superseded_slugs(&linked) {
            assert_ne!(claimed, repo_slug(&linked));
        }
    }

    #[test]
    fn a_folder_that_is_not_a_repo_claims_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(superseded_slugs(tmp.path()).is_empty());
    }

    #[test]
    fn binding_round_trips_and_is_absent_until_chosen() {
        let root = std::env::temp_dir().join(format!("aura-bind-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::remove_file(ProjectBinding::path_in(&root)).ok();

        assert_eq!(bound_org(&root), None, "unbound project infers nothing");

        bind_org(&root, Some("  acme  ")).unwrap();
        assert_eq!(bound_org(&root).as_deref(), Some("acme"));

        // Rebinding keeps an explicit name override alongside the org.
        let mut b = ProjectBinding::read(&root).unwrap();
        b.repo_full_name = Some("gitlab.com/acme/api".into());
        b.write(&root).unwrap();
        bind_org(&root, Some("zenith")).unwrap();
        let after = ProjectBinding::read(&root).unwrap();
        assert_eq!(after.org.as_deref(), Some("zenith"));
        assert_eq!(after.repo_full_name.as_deref(), Some("gitlab.com/acme/api"));
        assert!(after.bound_at.is_some());

        // An explicit name wins over anything inferred from the folder.
        assert_eq!(repo_slug(&root), "gitlab.com/acme/api");

        bind_org(&root, None).unwrap();
        assert_eq!(bound_org(&root), None, "clearing a binding un-binds it");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_corrupt_binding_reads_as_unbound() {
        let root = std::env::temp_dir().join(format!("aura-bind-bad-{}", std::process::id()));
        std::fs::create_dir_all(root.join(".aura")).unwrap();
        std::fs::write(ProjectBinding::path_in(&root), "{ not json").unwrap();
        assert_eq!(bound_org(&root), None);
        assert!(repo_slug(&root).starts_with("local/"));
        std::fs::remove_dir_all(&root).ok();
    }
}
