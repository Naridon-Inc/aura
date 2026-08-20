//! Tauri surface for [`crate::repo_identity`] — the frontend's only way to ask
//! "what repo is this, and which org is it bound to?".
//!
//! It exists so `src/lib/repoSlug.ts` can stop carrying its own pair of
//! GitHub regexes. Two implementations of one identity rule drift, and when
//! they do the same folder gets filed in the cloud under two names.

use std::path::Path;

use serde::Serialize;

use crate::repo_identity::{self, ProjectBinding};

/// Everything the UI needs to know about a project's cloud identity in one
/// round-trip, so a panel never has to make three `invoke` calls to render a
/// single row.
#[derive(Debug, Serialize)]
pub struct RepoIdentityView {
    /// The canonical name this project is filed under — always present.
    pub slug: String,
    /// The name derived from its remote, or `null` for a remote-less project.
    /// This is the "does it have a cloud counterpart?" answer.
    pub remote_slug: Option<String>,
    /// The raw `origin` URL, for showing the user what was parsed.
    pub origin_url: Option<String>,
    /// The org this project was explicitly bound to, or `null` if the choice
    /// has never been made and the cloud is picking the caller's default.
    pub org: Option<String>,
    /// True when the name came from an explicit override rather than the
    /// remote — the UI shows that differently, since it is a human decision.
    pub name_is_explicit: bool,
}

#[tauri::command]
pub async fn repo_identity_get(repo_root: String) -> RepoIdentityView {
    let root = Path::new(&repo_root);
    let binding = ProjectBinding::read(root).unwrap_or_default();
    let explicit_name = binding
        .repo_full_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    RepoIdentityView {
        slug: repo_identity::repo_slug(root),
        remote_slug: repo_identity::remote_slug_for_repo(root),
        origin_url: repo_identity::origin_url(root),
        org: repo_identity::bound_org(root),
        name_is_explicit: explicit_name.is_some(),
    }
}

/// Bind this project to an org — the explicit choice that replaces inferring
/// one. Passing `null` clears the binding and returns the project to the
/// cloud's default-org behaviour.
#[tauri::command]
pub async fn repo_identity_bind(
    repo_root: String,
    org: Option<String>,
) -> Result<RepoIdentityView, String> {
    let root = Path::new(&repo_root);
    repo_identity::bind_org(root, org.as_deref())?;
    Ok(repo_identity_get(repo_root).await)
}
