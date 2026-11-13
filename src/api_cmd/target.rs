//! Where a call lands: the path the caller typed, the names in it, and the one
//! host a bearer is allowed to reach.
//!
//! Two jobs, both pure enough to test without a repo or a server:
//!
//! 1. **Fill the names.** A path may carry `{owner}`, `{repo}`, `{branch}` and
//!    the rest, and they are resolved from the checkout the caller is standing
//!    in. The resolver is passed in, so the substitution rules are tested
//!    against a fake repo and the git work lives in one function at the bottom.
//! 2. **Decide the URL.** Relative to the public API surface by default,
//!    absolute when the caller already spelled `/api/…`, and — for a full URL
//!    — only ever on the origin this process resolved. A bearer does not
//!    follow a URL it was not issued for, and that rule is enforced here
//!    rather than trusted to whoever writes the path.

use std::path::PathBuf;

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::{url_encode, API_PREFIX};

/// Why a call could not be assembled — and which of those is the caller's
/// fault.
///
/// The two are not the same number. A misspelled `{project}` is a usage error:
/// the command is wrong and editing it fixes it. A `{room_id}` in a repo that
/// has never been given one is a *runtime* failure by the rule
/// [`ExitCode`] already states — the command was spelled correctly and the
/// world did not contain what it named — and a script that reads 2 as "my
/// arguments are wrong" would go looking in the wrong place for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fault {
    /// The command is wrong.
    Usage(String),
    /// The command is right and this machine cannot answer it.
    Unavailable(String),
}

impl Fault {
    pub fn message(&self) -> &str {
        match self {
            Fault::Usage(m) | Fault::Unavailable(m) => m,
        }
    }

    pub fn outcome(&self) -> ExitCode {
        match self {
            Fault::Usage(_) => ExitCode::Usage,
            Fault::Unavailable(_) => ExitCode::Runtime,
        }
    }
}

/// The names a path may carry, in the order `aura api --help` lists them.
pub const NAMES: &[&str] = &[
    "owner",
    "repo",
    "repo_slug",
    "branch",
    "repo_id",
    "checkout_id",
    "room_id",
];

/// Substitute every `{name}` in `path`.
///
/// A value is percent-encoded, because what it fills is one path segment: a
/// branch called `feat/api` or a GitLab project called `acme/platform/api`
/// would otherwise split the path and reach a different endpoint than the one
/// the caller named.
///
/// An unknown name is the caller's mistake and says what the known ones are. A
/// known name that this machine cannot answer for is a different failure — the
/// resolver's message explains which fact was missing — and the two are kept
/// apart because only the first is fixed by editing the command.
pub fn fill(
    path: &str,
    resolve: &dyn Fn(&str) -> Result<String, String>,
) -> Result<String, Fault> {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}').ok_or_else(|| {
            Fault::Usage(format!(
                "unclosed `{{` in `{path}` — a name looks like `{{owner}}`"
            ))
        })?;
        let name = &after[..close];
        if !NAMES.contains(&name) {
            return Err(Fault::Usage(format!(
                "`{{{name}}}` is not a name Aura fills — try one of {}",
                NAMES
                    .iter()
                    .map(|n| format!("{{{n}}}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            )));
        }
        let value = resolve(name).map_err(Fault::Unavailable)?;
        out.push_str(&url_encode(&value));
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// The full URL to call.
///
/// * A path beginning `/api/` is taken as written, so an endpoint outside the
///   public surface stays reachable without a second flag for it.
/// * Any other path is relative to [`API_PREFIX`], because that is the surface
///   this command exists to reach and typing the prefix every time is how a
///   typo in it becomes a 404 nobody can read.
/// * A full URL is honoured only when it is on `origin`. This is the host the
///   bearer was issued for; sending it anywhere else is not a convenience, it
///   is a leak, and the error says how to move the origin instead.
pub fn url_for(origin: &str, path: &str) -> Result<String, String> {
    let origin = origin.trim_end_matches('/');
    if path.starts_with("http://") || path.starts_with("https://") {
        let on_origin = path == origin
            || path
                .strip_prefix(origin)
                .map(|rest| rest.starts_with('/') || rest.starts_with('?'))
                .unwrap_or(false);
        if !on_origin {
            return Err(format!(
                "`{path}` is not on {origin} — Aura will not send your token to another host. \
                 Set AURA_CLOUD_URL to that host (with its own AURA_CLOUD_TOKEN) to call it."
            ));
        }
        return Ok(path.to_string());
    }
    if !path.starts_with('/') {
        return Err(format!(
            "`{path}` must start with `/` — a path is relative to {origin}{API_PREFIX}"
        ));
    }
    if path.starts_with("/api/") {
        return Ok(format!("{origin}{path}"));
    }
    Ok(format!("{origin}{API_PREFIX}{path}"))
}

/// Append `k=v` parameters to a URL that may already carry a query.
///
/// The separator is decided here for the same reason
/// [`crate::workspace_api::client::query`] exists: a caller that works out its
/// own `?` against a path it did not write gets it wrong exactly once, on the
/// second parameter.
pub fn with_query(url: &str, parts: &[String]) -> Result<String, String> {
    if parts.is_empty() {
        return Ok(url.to_string());
    }
    let mut encoded = Vec::with_capacity(parts.len());
    for part in parts {
        let (k, v) = part.split_once('=').ok_or_else(|| {
            format!("`{part}` is not a query parameter — write it as `name=value`")
        })?;
        if k.trim().is_empty() {
            return Err(format!("`{part}` has no name — write it as `name=value`"));
        }
        encoded.push(format!("{}={}", url_encode(k.trim()), url_encode(v)));
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    Ok(format!("{url}{sep}{}", encoded.join("&")))
}

/// Resolve a name against the checkout the process is standing in.
///
/// Every answer is read, never minted: `{repo_id}` and `{room_id}` come from
/// files the repo already committed, and a repo that has not been given one
/// says so instead of being handed a fresh identity by a command whose job is
/// to make an HTTP call. `aura repo-id init` is the command that mints.
pub fn resolve_from_repo(name: &str) -> Result<String, String> {
    match name {
        "owner" | "repo" | "repo_slug" => {
            let slug = crate::repo_slug::of_cwd();
            match name {
                "repo_slug" => Ok(slug),
                "owner" => slug
                    .split_once('/')
                    .map(|(o, _)| o.to_string())
                    .ok_or_else(|| missing_slug(&slug, "owner")),
                _ => slug
                    .split_once('/')
                    .map(|(_, r)| r.to_string())
                    .ok_or_else(|| missing_slug(&slug, "repo")),
            }
        }
        "branch" => {
            let branch = crate::live_events::current_branch();
            if branch == "unknown" {
                Err("`{branch}` needs a git checkout with a branch — none was found here".into())
            } else {
                Ok(branch)
            }
        }
        "repo_id" => {
            let root = repo_root()?;
            crate::scope::repo_identity(&root)
                .map(|id| id.repo_id)
                .map_err(|e| format!("`{{repo_id}}` could not be read: {e}"))
        }
        "checkout_id" => Ok(crate::scope::checkout_id(&repo_root()?)),
        "room_id" => {
            let root = repo_root()?;
            match aura_attestation::RepoIdentityManifest::read(&root) {
                Ok(Some(m)) if !m.room_id.is_empty() => Ok(m.room_id),
                Ok(Some(m)) if !m.repo_uuid.is_empty() => {
                    Ok(crate::repo_identity::room_id_for_uuid(&m.repo_uuid))
                }
                Ok(_) => Err(
                    "`{room_id}` needs this repo's Aura identity — run `aura repo-id init` first"
                        .into(),
                ),
                Err(e) => Err(format!("`{{room_id}}` could not be read: {e}")),
            }
        }
        other => Err(format!("`{{{other}}}` is not a name Aura fills")),
    }
}

/// Why a project name could not be split. Worth its own sentence: the slug is
/// always *something*, so the failure is not "nothing found" but "found a name
/// with no owner in it", which is what `local/…` means for a checkout with no
/// remote.
fn missing_slug(slug: &str, part: &str) -> String {
    format!("`{{{part}}}` could not be read from the project name `{slug}` — this checkout has no `owner/repo`")
}

fn repo_root() -> Result<PathBuf, String> {
    git2::Repository::discover(".")
        .ok()
        .and_then(|r| r.workdir().map(|w| w.to_path_buf()))
        .ok_or_else(|| "this name is read from a git work tree, and there is none here".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(name: &str) -> Result<String, String> {
        match name {
            "owner" => Ok("MHASK".into()),
            "repo" => Ok("aura-sovereign".into()),
            "branch" => Ok("feat/api".into()),
            "repo_id" => Ok("rid-0123456789abcdef".into()),
            _ => Err(format!("no {name} here")),
        }
    }

    #[test]
    fn names_are_substituted_in_place() {
        let got = fill("/projects/{owner}/{repo}/runs", &fake).unwrap();
        assert_eq!(got, "/projects/MHASK/aura-sovereign/runs");
    }

    #[test]
    fn a_value_with_a_slash_stays_one_path_segment() {
        // A branch called `feat/api` must not reach `/branches/feat/api`, which
        // is a different endpoint — or, more often, a 404 with no explanation.
        let got = fill("/branches/{branch}", &fake).unwrap();
        assert_eq!(got, "/branches/feat%2Fapi");
    }

    #[test]
    fn an_unknown_name_lists_the_known_ones() {
        let err = fill("/x/{project}", &fake).unwrap_err();
        assert!(
            err.message().contains("`{project}` is not a name Aura fills"),
            "{err:?}"
        );
        assert!(err.message().contains("{owner}"), "{err:?}");
        // A spelling mistake: editing the command fixes it.
        assert_eq!(err.outcome(), ExitCode::Usage);
    }

    #[test]
    fn a_name_this_machine_cannot_answer_for_says_which_and_is_not_a_usage_error() {
        let err = fill("/x/{room_id}", &fake).unwrap_err();
        assert_eq!(err.message(), "no room_id here");
        // The command was spelled correctly and the world did not contain what
        // it named — runtime, the same as a workspace that does not exist.
        assert_eq!(err.outcome(), ExitCode::Runtime);
    }

    #[test]
    fn an_unclosed_brace_is_not_read_as_a_literal() {
        let err = fill("/x/{owner", &fake).unwrap_err();
        assert!(err.message().contains("unclosed"), "{err:?}");
    }

    #[test]
    fn a_path_without_names_is_returned_whole() {
        assert_eq!(fill("/models", &fake).unwrap(), "/models");
    }

    #[test]
    fn a_plain_path_is_relative_to_the_public_surface() {
        assert_eq!(
            url_for("https://api.auravcs.com/", "/workspaces").unwrap(),
            "https://api.auravcs.com/api/v2/public/workspaces"
        );
    }

    #[test]
    fn an_api_path_is_taken_as_written() {
        assert_eq!(
            url_for("https://api.auravcs.com", "/api/v2/rooms/x").unwrap(),
            "https://api.auravcs.com/api/v2/rooms/x"
        );
    }

    #[test]
    fn a_full_url_on_the_resolved_origin_is_honoured() {
        assert_eq!(
            url_for("http://localhost:3011", "http://localhost:3011/health").unwrap(),
            "http://localhost:3011/health"
        );
    }

    #[test]
    fn a_full_url_on_another_host_is_refused_before_anything_is_sent() {
        let err = url_for("https://api.auravcs.com", "https://evil.example/collect").unwrap_err();
        assert!(err.contains("not on https://api.auravcs.com"), "{err}");
        assert!(err.contains("will not send your token"), "{err}");
    }

    #[test]
    fn a_host_that_merely_starts_with_the_origin_is_another_host() {
        // `https://api.auravcs.com.evil.example` has the origin as a prefix and
        // is not the origin. The boundary is the character after it.
        let err = url_for(
            "https://api.auravcs.com",
            "https://api.auravcs.com.evil.example/collect",
        )
        .unwrap_err();
        assert!(err.contains("not on"), "{err}");
    }

    #[test]
    fn a_relative_path_must_start_with_a_slash() {
        let err = url_for("https://api.auravcs.com", "workspaces").unwrap_err();
        assert!(err.contains("must start with `/`"), "{err}");
    }

    #[test]
    fn query_parameters_are_encoded_and_joined() {
        let got = with_query(
            "https://h/api/v2/public/workspaces",
            &["status=open".into(), "q=two words".into()],
        )
        .unwrap();
        assert_eq!(
            got,
            "https://h/api/v2/public/workspaces?status=open&q=two%20words"
        );
    }

    #[test]
    fn a_path_that_already_has_a_query_keeps_it() {
        let got = with_query("https://h/x?a=1", &["b=2".into()]).unwrap();
        assert_eq!(got, "https://h/x?a=1&b=2");
    }

    #[test]
    fn a_query_parameter_without_a_name_is_a_usage_error() {
        assert!(with_query("https://h/x", &["open".into()]).is_err());
        assert!(with_query("https://h/x", &["=1".into()]).is_err());
    }

    #[test]
    fn no_parameters_leaves_the_url_alone() {
        assert_eq!(with_query("https://h/x", &[]).unwrap(), "https://h/x");
    }
}
