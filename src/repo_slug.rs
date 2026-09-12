//! One name for a project, whatever spelling git gave us.
//!
//! The cloud keys `repos` on `UNIQUE(org_id, github_full_name)`, so the string
//! a client reports *is* the project's identity. The rule itself lives in
//! [`aura_repo_identity`], shared with the desktop; this module is the CLI's
//! use of it — "what is the project I am standing in?" — and nothing more.
//!
//! # Why it is shared rather than restated
//!
//! It was restated, and the two copies drifted in two ways that both reached
//! production:
//!
//! * **Remote-less projects split in half.** The desktop reported
//!   `local/<dirname>-<id>`, the CLI `local/<dirname>`. One folder opened in
//!   the app and worked on from the terminal became two rows —
//!   `local/auckland` sitting beside `local/antigua-d4ad6fe94f52` in a picker
//!   that offered 47 entries for roughly half as many projects.
//! * **GitLab subgroups collided.** This module's parser kept the first two
//!   path segments, so `acme/platform/payments/api` and
//!   `acme/platform/billing/api` were one name.
//!
//! Both are the same bug: an identity rule with two implementations.

use std::path::{Path, PathBuf};

pub use aura_repo_identity::{canonical, local_project_slug, superseded_slugs};

/// The canonical name of the project the current directory sits in.
///
/// A checkout with an `origin` is named after it; one without gets the same
/// `local/<name>-<id>` the desktop derives, so a folder opened in both places
/// is one project rather than two.
pub fn of_cwd() -> String {
    let Some(root) = project_root() else {
        // Not inside a repo at all. The current directory is still a stable,
        // distinct thing to name — the old answer was the bare string `local`,
        // which the cloud files as `local/local`: one bucket that every such
        // invocation on every machine pushed into.
        return std::env::current_dir()
            .map(|cwd| local_project_slug(&cwd))
            .unwrap_or_else(|_| "local/unknown".to_string());
    };
    // The shared rule first, so the CLI and the desktop answer the same string
    // for the same checkout. `git2` is only a backstop for the case where that
    // rule found no remote at all: it resolves `include` directives and
    // conditional includes the shared parser reads past, and a remote found
    // there is still better than filing the project as local. It cannot
    // disagree about the *name* — both hand the URL to the same parser.
    let derived = of_root(&root);
    if derived.starts_with(aura_repo_identity::LOCAL_PREFIX) {
        if let Some(url) = git2_origin(&root) {
            return canonical(&url);
        }
    }
    derived
}

/// The canonical name of the project rooted at `repo_root`, by the shared rule
/// alone. This is the answer [`superseded_slugs`] has to be measured against.
pub fn of_root(repo_root: &Path) -> String {
    aura_repo_identity::remote_slug_for_repo(repo_root)
        .unwrap_or_else(|| local_project_slug(repo_root))
}

/// The names an older build filed the current directory's project under.
///
/// Sent alongside a push so the cloud can move history off a phantom repo and
/// onto the project it belongs to. Empty for any checkout that never had one.
///
/// `reported` is the name this very push is filing the work under, not the
/// derived one: a caller that names the project some other way must not be
/// made to ask the server to merge that name into itself.
pub fn former_names(reported: &str) -> Vec<String> {
    match project_root() {
        Some(root) => superseded_slugs(&root, reported),
        None => Vec::new(),
    }
}

/// The working tree the current directory is in, if any.
///
/// `git2` is asked rather than `.git` parsed by hand, because the CLI is often
/// several directories deep inside a project and the desktop never is.
fn project_root() -> Option<PathBuf> {
    let repo = git2::Repository::discover(".").ok()?;
    repo.workdir().map(Path::to_path_buf)
}

fn git2_origin(repo_root: &Path) -> Option<String> {
    let repo = git2::Repository::open(repo_root).ok()?;
    let url = repo.find_remote("origin").ok()?.url()?.trim().to_string();
    (!url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_and_the_desktop_agree_on_a_remote_less_project() {
        // The split, pinned: `local/api` from here and `local/api-<id>` from
        // the desktop were two rows for one folder. Both now come from the
        // same function, so the only way they can disagree again is if one of
        // them stops calling it.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("api");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("config"), "[core]\n").unwrap();

        assert_eq!(of_root(&root), local_project_slug(&root));
        assert!(of_root(&root).starts_with("local/api-"), "{}", of_root(&root));
    }

    #[test]
    fn a_checkout_with_an_origin_is_named_after_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("aura");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(
            root.join(".git").join("config"),
            "[remote \"origin\"]\n\turl = git@github.com:MHASK/aura-sovereign.git\n",
        )
        .unwrap();
        assert_eq!(of_root(&root), "MHASK/aura-sovereign");
    }

    #[test]
    fn a_gitlab_subgroup_is_not_flattened_onto_its_neighbour() {
        // This module's own parser stopped after two segments, which filed
        // every `<group>/<sub>/api` under one name.
        assert_ne!(
            canonical("https://gitlab.com/acme/platform/payments/api.git"),
            canonical("https://gitlab.com/acme/platform/billing/api.git"),
        );
        assert_eq!(
            canonical("https://gitlab.com/acme/platform/payments/api.git"),
            "gitlab.com/acme/platform/payments/api",
        );
    }
}
