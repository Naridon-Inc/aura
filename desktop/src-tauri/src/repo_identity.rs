//! What repo is this folder, and which org does it belong to?
//!
//! One rule, one place. Before this module the answer was spread across
//! `cloud_session_sync::resolve_repo_full_name` (GitHub URLs only, everything
//! else fell through) and a pair of regexes in `src/lib/repoSlug.ts` that
//! answered the same question a second, slightly different way. Two
//! implementations of an identity rule is one too many: they drift, and a repo
//! that resolves one way in Rust and another way in TypeScript ends up filed
//! under two names in the cloud.
//!
//! Three things live here:
//!
//! * **[`remote_slug`] — the canonical name of a hosted repo.** GitHub keeps
//!   its historic bare `owner/repo` shape so no existing `repos` row is
//!   renamed. Every other host — gitlab.com, bitbucket, a self-hosted Gitea or
//!   GitLab behind a VPN — is `host/path…`, which is what stops GitLab's
//!   `acme/api` from being filed as GitHub's `acme/api`.
//! * **[`local_project_slug`] — a stable id for a repo with no remote.** The
//!   old answer was `local/<dirname>`, and with `repos UNIQUE(org_id,
//!   github_full_name)` that silently merged `~/work/api` and `~/other/api`
//!   into one row: two projects, one history, no warning. The id is now
//!   distinct per project.
//! * **[`ProjectBinding`] — the org this project pushes to, chosen not
//!   inferred.** A bound project sends its org on every cloud request; the
//!   server validates that claim against the caller's membership rather than
//!   assuming whichever org happened to sort first.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Filename under `.aura/` holding the explicit project → org binding.
const BINDING_FILE: &str = "cloud_binding.json";

/// The header carrying a bound project's org choice. Mirrors
/// `aura_cloud::org_selection::ORG_HEADER` — the server resolves the value
/// against the caller's own membership, so a claim it cannot back up is a 403
/// rather than a silent write into someone else's org.
pub const ORG_HEADER: &str = "X-Aura-Org";

/// How many hex characters of a digest/uuid go into a local slug. 48 bits is
/// far more than enough to keep one developer's project folders apart, and
/// short enough that `local/api-3f2a1b90cd12` is still readable in a dashboard.
const ID_LEN: usize = 12;

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

/// The canonical name derived from the repo's `origin` remote, or `None` when
/// the project has no remote to derive one from.
///
/// Callers that need "does this have a cloud counterpart?" want this; callers
/// that need a name no matter what want [`repo_slug`].
pub fn remote_slug_for_repo(repo_root: &Path) -> Option<String> {
    remote_slug(&origin_url(repo_root)?)
}

/// Read the `origin` remote URL out of `<repo_root>/.git/config`.
///
/// Parsed rather than shelled out to, because this runs on the session-sync
/// hot path and a `git` fork per push is not worth it. A worktree's `.git` is
/// a file pointing at the real gitdir, which is followed here so a worktree
/// resolves to the same repo as its checkout.
pub fn origin_url(repo_root: &Path) -> Option<String> {
    let cfg = std::fs::read_to_string(git_dir(repo_root)?.join("config")).ok()?;
    let mut in_origin = false;
    for line in cfg.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_origin = line == "[remote \"origin\"]";
            continue;
        }
        if !in_origin {
            continue;
        }
        if let Some(url) = line.strip_prefix("url = ").or_else(|| line.strip_prefix("url=")) {
            let url = url.trim();
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }
    None
}

/// Resolve `<repo_root>/.git` to the directory holding `config`.
fn git_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    // Linked worktree / submodule: `.git` is a file `gitdir: <path>`. The
    // config we want is the main repo's, so walk up out of `worktrees/<name>`.
    let pointer = std::fs::read_to_string(&dot_git).ok()?;
    let target = pointer.trim().strip_prefix("gitdir:")?.trim();
    let target = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        repo_root.join(target)
    };
    if target.join("config").is_file() {
        return Some(target);
    }
    // `<main>/.git/worktrees/<name>` → `<main>/.git`
    target
        .parent()
        .and_then(Path::parent)
        .filter(|p| p.join("config").is_file())
        .map(Path::to_path_buf)
}

/// Reduce any git remote URL to the canonical repo name.
///
/// Understands every shape git accepts: `https://`, `http://`, `ssh://`,
/// `git://`, and the scp-like `git@host:path`. Credentials in the URL and a
/// `:port` are dropped so the same repo cloned two ways lands on one name.
///
/// GitHub answers `owner/repo` — the shape already stored in every existing
/// `repos` row, so widening the parser renames nothing. Every other host
/// answers `host/path…`, which keeps two hosts' identically-named projects
/// apart and preserves GitLab's nested subgroups (`gitlab.com/acme/team/api`)
/// instead of flattening them into a collision.
///
/// Returns `None` for a remote that names no host — a `file://` or plain
/// filesystem path is a local clone, not a hosted identity, and those resolve
/// through [`local_project_slug`] instead.
pub fn remote_slug(url: &str) -> Option<String> {
    let (host, path) = split_remote(url.trim())?;
    let mut segments: Vec<&str> = path
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() {
        return None;
    }
    // Trailing `.git` belongs to the URL, not the repo name.
    let last = segments.len() - 1;
    let tail = segments[last].trim_end_matches(".git");
    if tail.is_empty() {
        return None;
    }
    segments[last] = tail;

    if host == "github.com" {
        // Two segments exactly: a GitHub URL may carry extra path (`/tree/main`)
        // and the repo is always the first pair.
        if segments.len() < 2 {
            return None;
        }
        return Some(format!("{}/{}", segments[0], segments[1]));
    }
    Some(format!("{host}/{}", segments.join("/")))
}

/// Split a remote URL into `(lowercased host, path)`.
fn split_remote(url: &str) -> Option<(String, &str)> {
    // scheme://[user[:pass]@]host[:port]/path
    if let Some((_scheme, rest)) = url.split_once("://") {
        let (authority, path) = match rest.split_once('/') {
            Some((a, p)) => (a, p),
            None => (rest, ""),
        };
        let host = normalise_host(strip_userinfo(authority))?;
        return Some((host, path));
    }
    // Plain filesystem path — a local clone, no hosted identity.
    if url.starts_with('/') || url.starts_with('.') || url.starts_with('~') {
        return None;
    }
    // scp-like: [user@]host:path
    let (authority, path) = url.split_once(':')?;
    // A Windows drive letter (`C:\repos\api`) is a path, not a host.
    if authority.len() == 1 {
        return None;
    }
    let host = normalise_host(strip_userinfo(authority))?;
    Some((host, path))
}

fn strip_userinfo(authority: &str) -> &str {
    match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    }
}

/// Lowercase the host and drop any `:port`.
///
/// An SSH host alias whose name contains "github" (the `git@github-work:me/x`
/// pattern for juggling deploy keys) is treated as github.com — the same rule
/// `cmd_device::normalise_origin_url` uses to derive room ids, so a repo's
/// name and its room agree on which host it is.
fn normalise_host(authority: &str) -> Option<String> {
    let host = authority.split(':').next()?.trim().to_lowercase();
    if host.is_empty() {
        return None;
    }
    let is_bare_github_alias = host.contains("github") && !host.contains('.');
    if host == "github.com" || is_bare_github_alias {
        return Some("github.com".to_string());
    }
    Some(host)
}

// ─── Local (remote-less) identity ───────────────────────────────────────────

/// A stable `local/<name>-<id>` for a project with no remote.
///
/// The `<id>` is what makes this safe to store under `UNIQUE(org_id,
/// github_full_name)`: `~/work/api` and `~/other/api` are two projects and
/// must be two rows. It is drawn from, in order:
///
/// 1. **The repo's committed Aura identity** (`.aura/repo.json`, minted by
///    `aura repo-id init`) — durable across moves *and* clones, and already
///    the identity primitive this codebase uses for rooms.
/// 2. **A digest of the absolute path** — deterministic, so a project that has
///    never run `repo-id init` still resolves to the same id on every launch
///    without needing anything written to disk first.
///
/// The name half stays human-readable so the dashboard shows `local/api-3f2a…`
/// rather than an opaque hash.
pub fn local_project_slug(repo_root: &Path) -> String {
    let name = project_name(repo_root);
    format!("local/{name}-{}", project_id(repo_root))
}

/// The legacy `local/<dirname>` this project would have been filed under
/// before ids existed. The cloud uses it to adopt the old row rather than
/// stranding its history under a name nothing reports any more.
pub fn legacy_local_slug(repo_root: &Path) -> String {
    format!("local/{}", project_name(repo_root))
}

fn project_name(repo_root: &Path) -> String {
    let raw = repo_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn project_id(repo_root: &Path) -> String {
    if let Some(uuid) = committed_repo_uuid(repo_root) {
        return uuid;
    }
    // `canonicalize` resolves symlinks and `..`, so two spellings of one
    // folder are one project. It fails only if the path is gone, in which case
    // the literal path is still a stable key for that spelling.
    let canonical = std::fs::canonicalize(repo_root).unwrap_or_else(|_| repo_root.to_path_buf());
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    hex::encode(digest)[..ID_LEN].to_string()
}

/// The `repo_uuid` from a committed `.aura/repo.json`, if it has one.
///
/// A signed manifest must verify: an unverified signature means someone edited
/// the file after it was minted, and silently trusting the claimed uuid would
/// let a tampered manifest point one project's history at another's row. Same
/// stance as `cmd_device::read_repo_override` takes for room ids.
fn committed_repo_uuid(repo_root: &Path) -> Option<String> {
    let manifest = aura_attestation::RepoIdentityManifest::read(repo_root).ok()??;
    if manifest.is_signed() && manifest.verify().is_err() {
        return None;
    }
    let uuid = manifest.repo_uuid.trim().replace('-', "");
    (uuid.len() >= ID_LEN).then(|| uuid[..ID_LEN].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_keeps_its_historic_bare_shape() {
        // Every existing `repos` row is named this way — widening the parser
        // must not rename a single one of them.
        for url in [
            "https://github.com/MHASK/aura-sovereign.git",
            "https://github.com/MHASK/aura-sovereign",
            "http://github.com/MHASK/aura-sovereign",
            "git@github.com:MHASK/aura-sovereign.git",
            "ssh://git@github.com/MHASK/aura-sovereign.git",
            "git://github.com/MHASK/aura-sovereign.git",
            "https://GitHub.com/MHASK/aura-sovereign/",
        ] {
            assert_eq!(
                remote_slug(url).as_deref(),
                Some("MHASK/aura-sovereign"),
                "{url}"
            );
        }
    }

    #[test]
    fn gitlab_is_not_filed_as_github() {
        // The collision this fixes: both hosts have an `acme/api`.
        assert_eq!(
            remote_slug("https://gitlab.com/acme/api.git").as_deref(),
            Some("gitlab.com/acme/api")
        );
        assert_eq!(
            remote_slug("https://github.com/acme/api.git").as_deref(),
            Some("acme/api")
        );
        assert_ne!(
            remote_slug("https://gitlab.com/acme/api.git"),
            remote_slug("https://github.com/acme/api.git")
        );
    }

    #[test]
    fn gitlab_subgroups_survive_instead_of_colliding() {
        // Flattening to the last two segments would file both of these as
        // `gitlab.com/team/api`.
        assert_eq!(
            remote_slug("git@gitlab.com:acme/team/api.git").as_deref(),
            Some("gitlab.com/acme/team/api")
        );
        assert_eq!(
            remote_slug("git@gitlab.com:other/team/api.git").as_deref(),
            Some("gitlab.com/other/team/api")
        );
    }

    #[test]
    fn self_hosted_resolves_by_host() {
        assert_eq!(
            remote_slug("git@git.acme.internal:platform/api.git").as_deref(),
            Some("git.acme.internal/platform/api")
        );
        assert_eq!(
            remote_slug("ssh://git@git.acme.internal:2222/platform/api.git").as_deref(),
            Some("git.acme.internal/platform/api")
        );
        assert_eq!(
            remote_slug("https://git.acme.internal/platform/api").as_deref(),
            Some("git.acme.internal/platform/api")
        );
    }

    #[test]
    fn one_repo_cloned_two_ways_is_one_name() {
        let ssh = remote_slug("git@gitlab.com:acme/api.git");
        let https = remote_slug("https://gitlab.com/acme/api.git");
        let tokenised = remote_slug("https://oauth2:s3cr3t@gitlab.com/acme/api.git");
        let ported = remote_slug("ssh://git@gitlab.com:22/acme/api.git");
        assert_eq!(ssh, https);
        assert_eq!(ssh, tokenised);
        assert_eq!(ssh, ported);
    }

    #[test]
    fn ssh_alias_for_github_still_reads_as_github() {
        assert_eq!(
            remote_slug("git@github-work:MHASK/aura-sovereign.git").as_deref(),
            Some("MHASK/aura-sovereign")
        );
        // A real host that merely contains "github" is left alone — only a
        // bare alias (no dots) is treated as github.com.
        assert_eq!(
            remote_slug("git@github.acme.com:MHASK/api.git").as_deref(),
            Some("github.acme.com/MHASK/api")
        );
    }

    #[test]
    fn a_pathless_or_hostless_remote_has_no_hosted_name() {
        for url in [
            "",
            "https://github.com/",
            "https://github.com/owner",
            "/Users/me/repos/api",
            "../sibling-repo",
            "~/repos/api",
            "file:///Users/me/repos/api",
            "C:\\repos\\api",
        ] {
            assert_eq!(remote_slug(url), None, "{url}");
        }
    }

    #[test]
    fn two_folders_sharing_a_basename_are_two_projects() {
        // The bug: `repos UNIQUE(org_id, github_full_name)` merged these into
        // one row because both answered `local/api`.
        let tmp = std::env::temp_dir().join(format!(
            "aura-identity-{}",
            std::process::id()
        ));
        let work = tmp.join("work").join("api");
        let other = tmp.join("other").join("api");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&other).unwrap();

        let a = local_project_slug(&work);
        let b = local_project_slug(&other);

        assert_ne!(a, b, "two different folders must not share a repo name");
        assert!(a.starts_with("local/api-"), "{a}");
        assert!(b.starts_with("local/api-"), "{b}");
        // Both used to collapse onto the one legacy name — that is exactly
        // what the cloud needs in order to adopt the old row.
        assert_eq!(legacy_local_slug(&work), "local/api");
        assert_eq!(legacy_local_slug(&other), "local/api");

        // Stable: asking twice is the same answer, not a fresh id.
        assert_eq!(local_project_slug(&work), a);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn a_local_slug_is_readable_and_bounded() {
        let slug = local_project_slug(Path::new("/tmp/My Project!"));
        assert!(slug.starts_with("local/My-Project-"), "{slug}");
        let id = slug.rsplit('-').next().unwrap();
        assert_eq!(id.len(), ID_LEN);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn a_nameless_root_still_gets_an_id() {
        let slug = local_project_slug(Path::new("/"));
        assert!(slug.starts_with("local/unknown-"), "{slug}");
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
