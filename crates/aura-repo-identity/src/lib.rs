//! What project is this folder, and what name does the cloud file it under?
//!
//! `repos` is keyed `UNIQUE(org_id, github_full_name)`, so the string a client
//! reports *is* the project's identity. Every client therefore has to derive
//! the same string from the same checkout — and until this crate existed, two
//! of them did not.
//!
//! `aura-shell` answered `local/<dirname>-<id>` for a remote-less project;
//! `aura-cli` answered `local/<dirname>`. One project, opened in the desktop
//! and worked on from the terminal, became two rows. Production carries both
//! spellings of the same folders — `local/auckland` beside
//! `local/antigua-d4ad6fe94f52` — and a workspace picker built from that table
//! offered 47 entries for roughly half as many projects.
//!
//! The lesson is the one `aura-shell`'s own module doc already stated about
//! Rust and TypeScript: two implementations of an identity rule is one too
//! many, because they drift. So the rule lives here once, and the desktop, the
//! CLI and anything else that has to name a checkout call it rather than
//! restating it.
//!
//! `aura-cloud`'s `repo_identity` is deliberately *not* folded in. It is the
//! other side of the contract: it reads a name a client already derived and
//! normalises whatever spelling arrived, without a filesystem to look at.
//!
//! # The rule
//!
//! * **A hosted repo is named after its remote.** GitHub is spelled bare
//!   (`owner/repo`) because that is what every row written before other hosts
//!   were parsed looks like. Everything else keeps its host
//!   (`gitlab.com/owner/repo`), so two `acme/api` on different hosts stay two
//!   projects — and nested GitLab subgroups keep every segment.
//! * **A remote-less project is `local/<name>-<id>`.** The id is what makes it
//!   safe under a unique key: `~/work/api` and `~/other/api` are two projects
//!   and must be two rows.
//! * **A checkout also says what it *used* to be called**, so history filed
//!   under a name no build reports any more can follow the project home.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Prefix marking a project with no hosted remote.
pub const LOCAL_PREFIX: &str = "local/";

/// How many hex characters of a digest/uuid go into a local slug. 48 bits is
/// far more than enough to keep one developer's project folders apart, and
/// short enough that `local/api-3f2a1b90cd12` is still readable in a dashboard.
pub const ID_LEN: usize = 12;

// ─── Hosted identity ────────────────────────────────────────────────────────

/// The canonical name for whatever spelling of a remote we were handed.
///
/// A string that is not a URL comes back unchanged apart from a trailing
/// `.git` and slashes, which leaves `local/<name>-<id>` and every
/// already-correct name alone.
pub fn canonical(reported: &str) -> String {
    let trimmed = reported.trim().trim_end_matches('/');
    match remote_slug(trimmed) {
        Some(slug) => slug,
        // Not a URL — but a bare `owner/repo.git` is still the same project as
        // `owner/repo`, and letting those split is the same bug in miniature.
        None => trimmed
            .strip_suffix(".git")
            .unwrap_or(trimmed)
            .trim_end_matches('/')
            .to_string(),
    }
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
/// the desktop uses to derive room ids, so a repo's name and its room agree on
/// which host it is.
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
    format!("{LOCAL_PREFIX}{name}-{}", project_id(repo_root))
}

/// The legacy `local/<dirname>` this project would have been filed under
/// before ids existed. The cloud uses it to adopt the old row rather than
/// stranding its history under a name nothing reports any more.
pub fn legacy_local_slug(repo_root: &Path) -> String {
    format!("{LOCAL_PREFIX}{}", project_name(repo_root))
}

/// The human half of a local slug: the folder's own name, reduced to
/// characters that survive a URL and a dashboard.
pub fn project_name(repo_root: &Path) -> String {
    let raw = repo_root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
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
/// let a tampered manifest point one project's history at another's row.
fn committed_repo_uuid(repo_root: &Path) -> Option<String> {
    let manifest = aura_attestation::RepoIdentityManifest::read(repo_root).ok()??;
    if manifest.is_signed() && manifest.verify().is_err() {
        return None;
    }
    let uuid = manifest.repo_uuid.trim().replace('-', "");
    (uuid.len() >= ID_LEN).then(|| uuid[..ID_LEN].to_string())
}

// ─── Which view of the project is this? ─────────────────────────────────────

/// The linked worktree this path is, by name — `None` for the main checkout.
///
/// A linked worktree's `.git` is a file reading `gitdir:
/// <main>/.git/worktrees/<name>`, and that last component is the name `git
/// worktree list` shows. Read from the pointer rather than the directory
/// basename, because the two are free to differ: a worktree added at
/// `~/scratch/fix` with `--name` set, or a folder renamed after the fact,
/// keeps git's name and not the folder's.
pub fn worktree_name(repo_root: &Path) -> Option<String> {
    let pointer = std::fs::read_to_string(repo_root.join(".git")).ok()?;
    let target = pointer.trim().strip_prefix("gitdir:")?.trim();
    let target = Path::new(target);
    // `.../worktrees/<name>` — anything else with a `.git` *file* is a
    // submodule, which is a different repo rather than a view of this one.
    let name = target.file_name()?.to_str()?;
    let parent = target.parent()?.file_name()?.to_str()?;
    (parent == "worktrees" && !name.is_empty()).then(|| name.to_string())
}

/// Resolve `<repo_root>/.git` to the directory holding `config`.
pub fn git_dir(repo_root: &Path) -> Option<PathBuf> {
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

/// Read the `origin` remote URL out of the config `<repo_root>/.git` points at.
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
        if let Some(url) = line
            .strip_prefix("url = ")
            .or_else(|| line.strip_prefix("url="))
        {
            let url = url.trim();
            if !url.is_empty() {
                return Some(url.to_string());
            }
        }
    }
    None
}

/// The canonical name derived from the repo's `origin` remote, or `None` when
/// the project has no remote to derive one from.
pub fn remote_slug_for_repo(repo_root: &Path) -> Option<String> {
    remote_slug(&origin_url(repo_root)?)
}

// ─── Names this checkout used to be filed under ─────────────────────────────

/// The names an older build filed this checkout under, worst spelling first.
///
/// Two generations of the same bug are in production, and a checkout can have
/// left a row behind under either:
///
/// * **`local/<dirname>`**, from builds predating per-project ids.
/// * **`local/<dirname>-<id>`**, from every build up to 0.19.41, which read the
///   remote out of `repo_root/.git/config` *as a directory*. In a linked
///   worktree `.git` is a file, so the read failed and the project was filed
///   under a local name — one phantom repo per worktree, holding real
///   sessions, intents and checkpoints for a project that does not exist.
///
/// The cloud can heal that once it is told: `repo_aliases` plus
/// `aura_merge_repo_alias` move every row from one repo onto another and keep
/// the surviving id. What it cannot do is *guess* that `local/granada` means
/// `MHASK/aura-sovereign` — only the machine holding the worktree knows. So the
/// client says so, and the history follows the project home.
///
/// Both claims are safe for a different reason, and the difference is why the
/// narrower one stays narrow:
///
/// * The **id-bearing** name contains a digest of this exact absolute path (or
///   this repo's committed uuid), so it cannot name any other project on the
///   machine. It is claimed by any checkout that now resolves to something
///   else.
/// * The **bare** name is only the folder's basename, which two unrelated
///   folders can share. It is claimed only by a linked worktree, where the
///   phantom is known to have been minted by the `.git`-is-a-file bug rather
///   than being somebody's real remote-less project.
///
/// A name equal to what this checkout reports now is never returned, so a
/// project that genuinely is `local/<dirname>` is never asked to merge with
/// itself.
pub fn superseded_slugs(repo_root: &Path, current: &str) -> Vec<String> {
    let mut names = Vec::new();
    if worktree_name(repo_root).is_some() {
        names.push(legacy_local_slug(repo_root));
    }
    names.push(local_project_slug(repo_root));
    names.retain(|phantom| phantom != current);
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A main checkout with `origin` set, plus one linked worktree of it —
    /// `.git` as a file, exactly as git writes it.
    fn worktree_fixture(origin: &str, wt: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let git = main.join(".git");
        fs::create_dir_all(git.join("worktrees").join(wt)).unwrap();
        fs::write(
            git.join("config"),
            format!("[remote \"origin\"]\n\turl = {origin}\n"),
        )
        .unwrap();
        let tree = tmp.path().join(wt);
        fs::create_dir_all(&tree).unwrap();
        fs::write(
            tree.join(".git"),
            format!("gitdir: {}\n", git.join("worktrees").join(wt).display()),
        )
        .unwrap();
        (tmp, main, tree)
    }

    #[test]
    fn every_spelling_of_one_remote_is_one_name() {
        for url in [
            "https://github.com/MHASK/aura-sovereign.git",
            "https://github.com/MHASK/aura-sovereign",
            "http://github.com/MHASK/aura-sovereign.git",
            "git@github.com:MHASK/aura-sovereign.git",
            "git@github.com:MHASK/aura-sovereign",
            "ssh://git@github.com/MHASK/aura-sovereign.git",
            "https://github.com/MHASK/aura-sovereign.git/",
            "MHASK/aura-sovereign.git",
            "  MHASK/aura-sovereign  ",
        ] {
            assert_eq!(canonical(url), "MHASK/aura-sovereign", "{url}");
        }
    }

    #[test]
    fn a_non_github_host_stays_in_the_name() {
        assert_eq!(
            canonical("https://gitlab.com/ashiqwayanad007/mixrank-web.git"),
            "gitlab.com/ashiqwayanad007/mixrank-web"
        );
        assert_eq!(
            canonical("ssh://git@git.acme.internal:2222/platform/api.git"),
            "git.acme.internal/platform/api"
        );
        assert_ne!(canonical("https://gitlab.com/acme/api"), canonical("acme/api"));
    }

    #[test]
    fn a_nested_group_keeps_every_segment() {
        // The CLI's own parser took the first two segments and stopped, so
        // `acme/platform/payments/api` and `acme/platform/billing/api` were one
        // name. GitLab subgroups are common enough that this merged real repos.
        assert_eq!(
            canonical("https://gitlab.com/acme/platform/payments/api.git"),
            "gitlab.com/acme/platform/payments/api"
        );
        assert_ne!(
            canonical("https://gitlab.com/acme/platform/payments/api"),
            canonical("https://gitlab.com/acme/platform/billing/api"),
        );
    }

    #[test]
    fn a_credential_in_the_url_never_reaches_the_name() {
        // Repo names are readable by every member of an org.
        assert_eq!(
            canonical("https://ghp_secret@github.com/MHASK/aura-sovereign.git"),
            "MHASK/aura-sovereign"
        );
        let s = canonical("https://user:hunter2@gitlab.com/acme/api.git");
        assert_eq!(s, "gitlab.com/acme/api");
        assert!(!s.contains("hunter2"));
    }

    #[test]
    fn names_that_are_already_right_are_untouched() {
        // Rewriting one of these would strand its history under a name nothing
        // reports any more — the exact failure this exists to prevent.
        for name in [
            "MHASK/aura-sovereign",
            "local/api",
            "local/api-3f2a1b90cd12",
            "gitlab.com/acme/api",
            "local",
            "",
        ] {
            assert_eq!(canonical(name), name, "{name}");
        }
    }

    #[test]
    fn a_url_with_no_repo_half_is_left_verbatim() {
        assert_eq!(canonical("https://github.com/MHASK"), "https://github.com/MHASK");
    }

    #[test]
    fn a_local_slug_is_the_same_answer_every_time() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("api");
        fs::create_dir_all(&root).unwrap();
        assert_eq!(local_project_slug(&root), local_project_slug(&root));
        // A second spelling of the same folder is the same project.
        let dotted = tmp.path().join("api").join(".").join("..").join("api");
        assert_eq!(local_project_slug(&root), local_project_slug(&dotted));
    }

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
    fn a_worktree_resolves_to_the_repo_it_is_a_view_of() {
        // The bug, pinned: this used to fall through to a local name because
        // `.git` is a file in a linked worktree.
        let (_tmp, _main, wt) = worktree_fixture("git@github.com:MHASK/aura-sovereign.git", "granada");
        assert_eq!(
            remote_slug_for_repo(&wt).as_deref(),
            Some("MHASK/aura-sovereign")
        );
        assert_eq!(worktree_name(&wt).as_deref(), Some("granada"));
    }

    #[test]
    fn a_worktree_claims_both_spellings_of_its_phantom() {
        // Production carries both: `local/auckland` from builds before ids, and
        // `local/antigua-d4ad6fe94f52` from every build up to 0.19.41. A
        // checkout that only claimed the first left the second stranded.
        let (_tmp, _main, wt) = worktree_fixture("git@github.com:MHASK/aura-sovereign.git", "granada");
        let claimed = superseded_slugs(&wt, "MHASK/aura-sovereign");
        assert_eq!(claimed.len(), 2, "{claimed:?}");
        assert_eq!(claimed[0], "local/granada");
        assert!(claimed[1].starts_with("local/granada-"), "{claimed:?}");
    }

    #[test]
    fn a_main_checkout_claims_only_the_name_that_is_provably_its_own() {
        // The id-bearing name is a digest of this exact path, so no other
        // project on the machine can be wearing it — a main checkout that
        // gained a remote may safely reclaim its own local history. The bare
        // name is just a basename, which an unrelated folder can share, so a
        // main checkout never asks for it.
        let (_tmp, main, _wt) = worktree_fixture("git@github.com:MHASK/aura-sovereign.git", "granada");
        let claimed = superseded_slugs(&main, "MHASK/aura-sovereign");
        assert_eq!(claimed.len(), 1, "{claimed:?}");
        assert!(claimed[0].starts_with("local/main-"), "{claimed:?}");
    }

    #[test]
    fn a_project_that_really_is_local_never_asks_to_merge_with_itself() {
        // No remote, so the project's own name *is* the id-bearing local slug.
        // Claiming it would ask the server to fold a row into itself.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("api");
        fs::create_dir_all(root.join(".git")).unwrap();
        let current = local_project_slug(&root);
        assert!(!superseded_slugs(&root, &current).contains(&current));
    }

    #[test]
    fn nothing_hosted_is_ever_claimed_as_a_former_name() {
        // The server fences this too, but the client must never even ask: a
        // merge repoints every checkpoint, session and intent a repo owns.
        let (_tmp, main, wt) = worktree_fixture("git@github.com:MHASK/aura-sovereign.git", "granada");
        for root in [main, wt] {
            for name in superseded_slugs(&root, "MHASK/aura-sovereign") {
                assert!(name.starts_with(LOCAL_PREFIX), "{name}");
            }
        }
    }
}
