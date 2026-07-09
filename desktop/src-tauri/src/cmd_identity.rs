// Per-repo "this is me" identity aggregator.
//
// When someone installs Aura and opens a repo that has git, the app
// guesses who they are from `git config user.email`. That guess is
// ambiguous whenever the local git email isn't on the team roster, is on
// the roster but unclaimed, or the user runs a different git email in
// different repos / across several repos. In those cases the user must be
// able to say "this is me" — *per repo*, and never via a silent merge.
//
// This module is the read-side aggregator for that surface. It owns NO
// new persistence and re-implements NO resolution logic: it calls the
// existing public commands in `cmd_team` (`team_identity`, which already
// layers per-repo override → roster alias → email-local-part) plus
// `read_team` for the full roster (`TeamMember` carries `commits` /
// `github_login`, which the slimmer `jira_users::load_roster` row does
// not). The write side — claim, override, alias — stays in `cmd_team`;
// the frontend calls those directly. Here we only classify the situation
// and hand the UI the candidate list.
//
// REGISTER (paste into `aura-shell/src-tauri/src/lib.rs`):
//     mod cmd_identity;                       // near the other `mod` lines
//     cmd_identity::identity_status,          // in the invoke_handler! list
//     cmd_identity::identity_status_all,

use crate::cmd_team::{read_team, team_identity};

/// A roster member trimmed to exactly what the "pick someone else"
/// chooser needs — never the full `TeamMember` (which carries presence,
/// channel, and provenance fields the identity surface has no use for).
#[derive(serde::Serialize)]
pub struct RosterLite {
    pub handle: String,
    pub name: String,
    pub email: String,
    pub commits: u32,
    pub github_login: Option<String>,
}

/// The verdict for a single repo: who git thinks the user is, whether
/// that's settled, and — when it isn't — the best guess plus the full
/// candidate list so the UI can offer "this is me" / "pick someone else".
#[derive(serde::Serialize)]
pub struct IdentityStatus {
    pub repo_root: String,
    pub repo_name: String,
    pub email: String,
    pub name: String,
    pub effective_handle: String,
    pub in_team: bool,
    pub claimed: bool,
    /// "clear" — already claimed, nothing to do.
    /// "unclaimed" — on the roster but nobody has confirmed it's them.
    /// "needs_confirm" — on the roster, unclaimed, and we have a strong
    ///     email-matched best guess to surface as a one-click confirm.
    /// "not_on_roster" — the local git email is unknown to the team.
    pub confusion: String,
    /// The roster handle we think this is, when the situation isn't
    /// already settled. `None` once claimed or when there's no match.
    pub best_guess: Option<String>,
    /// Roster members the user could be, most-active first, for the
    /// "pick someone else" chooser. Capped so a huge open-source roster
    /// doesn't bloat the payload.
    pub candidates: Vec<RosterLite>,
}

/// Cap the candidate list so a large open-source roster (hundreds of
/// historical committers) doesn't bloat the payload or the chooser.
const MAX_CANDIDATES: usize = 30;

/// Last path component of a repo root, for the human-facing "this
/// project" label. Falls back to the full root if it has no file name
/// (e.g. "/").
fn repo_name_of(repo_root: &str) -> String {
    std::path::Path::new(repo_root)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| repo_root.to_string())
}

/// Build the candidate list from the team manifest: every roster member,
/// most commits first, trimmed to `RosterLite` and capped.
fn candidates_for(repo_root: &str) -> Vec<RosterLite> {
    let Some(manifest) = read_team(repo_root) else {
        return Vec::new();
    };
    let mut members = manifest.members;
    members.sort_by(|a, b| b.commits.cmp(&a.commits));
    members
        .into_iter()
        .take(MAX_CANDIDATES)
        .map(|m| RosterLite {
            handle: m.handle,
            name: m.name,
            email: m.email,
            commits: m.commits,
            github_login: m.github_login,
        })
        .collect()
}

/// The roster handle whose primary `email` or one of whose `also_emails`
/// equals the local git email (case-insensitive). This is the strong
/// "we think you're @x" signal: a deterministic address match, not a
/// name guess (names collide; a wrong auto-link is worse than none).
fn best_guess_for(repo_root: &str, email: &str) -> Option<String> {
    let e = email.trim().to_lowercase();
    if e.is_empty() {
        return None;
    }
    let manifest = read_team(repo_root)?;
    manifest
        .members
        .into_iter()
        .find(|m| {
            m.email.eq_ignore_ascii_case(&e)
                || m.also_emails.iter().any(|a| a.eq_ignore_ascii_case(&e))
        })
        .filter(|m| !m.handle.is_empty())
        .map(|m| m.handle)
}

/// Classify who the local git user is in this one repo. Pure read: it
/// runs `team_identity` (which itself syncs git history) and reads the
/// manifest, but writes nothing of its own.
#[tauri::command]
pub async fn identity_status(repo_root: String) -> Result<IdentityStatus, String> {
    let ident = team_identity(repo_root.clone()).await?;

    let best_guess = if ident.claimed {
        None
    } else {
        best_guess_for(&repo_root, &ident.email)
    };

    // Settled when claimed. Otherwise: on the roster but unconfirmed is
    // "unclaimed" — promoted to "needs_confirm" when we have a strong
    // email-matched guess to one-click confirm. Unknown email is
    // "not_on_roster".
    let confusion = if ident.claimed {
        "clear"
    } else if ident.in_team {
        if best_guess.is_some() {
            "needs_confirm"
        } else {
            "unclaimed"
        }
    } else {
        "not_on_roster"
    }
    .to_string();

    let repo_name = repo_name_of(&repo_root);
    let candidates = candidates_for(&repo_root);

    Ok(IdentityStatus {
        repo_root,
        repo_name,
        email: ident.email,
        name: if ident.effective_name.is_empty() {
            ident.name
        } else {
            ident.effective_name
        },
        effective_handle: ident.effective_handle,
        in_team: ident.in_team,
        claimed: ident.claimed,
        confusion,
        best_guess,
        candidates,
    })
}

/// Classify every open workspace repo at once. A repo that can't be read
/// (deleted, not a git repo, git not configured) is skipped rather than
/// failing the whole call — the surface shows the repos it *can* speak to.
#[tauri::command]
pub async fn identity_status_all(
    repo_roots: Vec<String>,
) -> Result<Vec<IdentityStatus>, String> {
    let mut out = Vec::with_capacity(repo_roots.len());
    for root in repo_roots {
        if let Ok(status) = identity_status(root).await {
            out.push(status);
        }
    }
    Ok(out)
}
