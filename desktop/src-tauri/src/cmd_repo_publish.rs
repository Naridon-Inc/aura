//! Turning a plain folder into a tracked project — `git init`, a private repo
//! on the host you're signed in to, `origin`, and the first push.
//!
//! Aura's whole record — intent, proof, the cross-worktree plane — is anchored
//! to a repository. A folder with no `.git` can be opened, but nothing durable
//! can be said about it, and a second checkout is impossible. So the app
//! offers to set that up rather than letting the user wander into a surface
//! that will quietly do nothing.
//!
//! Unlike the tools that only speak GitHub, this asks both hosts and offers
//! whichever ones actually answer. Provider support is a shell-out to the
//! host's own CLI (`gh`, `glab`) on purpose:
//!   * the user's existing login is reused — Aura never handles a host token,
//!     never stores one, and never asks for a password;
//!   * enterprise/self-managed instances already configured in those CLIs work
//!     with no extra plumbing here.
//! A host whose CLI is missing or signed out is reported as such, with the
//! exact command to fix it, instead of being hidden.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// One code host we can publish to, and how ready it actually is.
#[derive(Serialize, Clone, Debug)]
pub struct HostProvider {
    /// `github` | `gitlab`.
    pub id: String,
    pub label: String,
    /// Its CLI is on PATH.
    pub installed: bool,
    /// That CLI reports a live login.
    pub signed_in: bool,
    /// Account the login belongs to, when signed in.
    pub account: Option<String>,
    /// Namespaces this account may create a repo under — itself first, then
    /// every org/group it can push to.
    pub owners: Vec<HostOwner>,
    /// Why it is unusable, phrased as the thing to do about it.
    pub hint: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct HostOwner {
    pub login: String,
    /// `user` | `org` (GitHub) | `group` (GitLab).
    pub kind: String,
}

/// Where a folder stands: is it a repo, does it have commits, does it have a
/// remote. The page asks before deciding whether to show the gate at all.
#[derive(Serialize, Clone, Debug)]
pub struct RepoState {
    pub is_repo: bool,
    pub has_commits: bool,
    pub has_origin: bool,
    pub origin_url: Option<String>,
    /// Current branch, or the name `git init` would give the first one.
    pub branch: String,
    /// Folder basename — the default repository name we suggest.
    pub suggested_name: String,
}

/// Run a command in `dir` and hand back (ok, stdout, stderr) — never an error,
/// because "the tool isn't installed" is an answer this module reports rather
/// than a failure it propagates.
fn run(dir: &Path, bin: &str, args: &[&str]) -> (bool, String, String) {
    match Command::new(bin).args(args).current_dir(dir).output() {
        Ok(out) => (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    }
}

fn git(dir: &Path, args: &[&str]) -> (bool, String, String) {
    run(dir, "git", args)
}

/// Is `bin` on PATH? `which` rather than a probe run: some CLIs are slow to
/// start and this is called on every dialog open.
fn installed(bin: &str) -> bool {
    Command::new("which")
        .arg(bin)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// A repository name a host will accept: letters, digits, `.`, `_`, `-`.
/// Anything else becomes `-`, and runs collapse, so "New Git" → "New-Git".
fn slugify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') || out.ends_with('.') {
        out.pop();
    }
    out
}

#[tauri::command]
pub async fn repo_state(dir: String) -> Result<RepoState, String> {
    let path = PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("folder does not exist: {dir}"));
    }

    tokio::task::spawn_blocking(move || {
        let suggested_name = path
            .file_name()
            .map(|n| slugify(&n.to_string_lossy()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "project".to_string());

        // `--is-inside-work-tree` and not `.git` existence: a linked worktree
        // has a `.git` *file*, and a subdirectory of a repo has neither, yet
        // both are already tracked and must not be offered the gate.
        let (is_repo, _, _) = git(&path, &["rev-parse", "--is-inside-work-tree"]);
        if !is_repo {
            return RepoState {
                is_repo: false,
                has_commits: false,
                has_origin: false,
                origin_url: None,
                branch: "main".to_string(),
                suggested_name,
            };
        }

        let (has_commits, _, _) = git(&path, &["rev-parse", "--verify", "HEAD"]);
        let (has_origin, origin_url, _) = git(&path, &["remote", "get-url", "origin"]);
        // On a fresh `git init` HEAD points at a branch with no commits;
        // `--abbrev-ref HEAD` fails there, so fall back to the symbolic ref.
        let branch = {
            let (ok, name, _) = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]);
            if ok && !name.is_empty() && name != "HEAD" {
                name
            } else {
                let (_, sym, _) = git(&path, &["symbolic-ref", "--short", "HEAD"]);
                if sym.is_empty() { "main".to_string() } else { sym }
            }
        };

        RepoState {
            is_repo: true,
            has_commits,
            has_origin,
            origin_url: if has_origin { Some(origin_url) } else { None },
            branch,
            suggested_name,
        }
    })
    .await
    .map_err(|e| format!("repo state task join: {e}"))
}

/// GitHub, via `gh`. Owners = the account plus every org it belongs to.
fn github_provider(dir: &Path) -> HostProvider {
    let mut p = HostProvider {
        id: "github".into(),
        label: "GitHub".into(),
        installed: installed("gh"),
        signed_in: false,
        account: None,
        owners: Vec::new(),
        hint: None,
    };
    if !p.installed {
        p.hint = Some("Install the GitHub CLI (`brew install gh`) to publish here.".into());
        return p;
    }
    let (ok, login, _) = run(dir, "gh", &["api", "user", "--jq", ".login"]);
    if !ok || login.is_empty() {
        p.hint = Some("Sign in with `gh auth login` to publish here.".into());
        return p;
    }
    p.signed_in = true;
    p.account = Some(login.clone());
    p.owners.push(HostOwner { login, kind: "user".into() });

    let (ok, orgs, _) = run(dir, "gh", &["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    if ok {
        for line in orgs.lines().map(str::trim).filter(|l| !l.is_empty()) {
            p.owners.push(HostOwner { login: line.to_string(), kind: "org".into() });
        }
    }
    p
}

/// GitLab, via `glab`. Owners = the account plus every group it can create a
/// project in — `min_access_level=30` is Developer, the floor for that.
fn gitlab_provider(dir: &Path) -> HostProvider {
    let mut p = HostProvider {
        id: "gitlab".into(),
        label: "GitLab".into(),
        installed: installed("glab"),
        signed_in: false,
        account: None,
        owners: Vec::new(),
        hint: None,
    };
    if !p.installed {
        p.hint = Some("Install the GitLab CLI (`brew install glab`) to publish here.".into());
        return p;
    }
    let (ok, body, _) = run(dir, "glab", &["api", "user"]);
    if !ok || body.is_empty() {
        p.hint = Some("Sign in with `glab auth login` to publish here.".into());
        return p;
    }
    let login = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("username").and_then(|u| u.as_str()).map(str::to_string));
    let Some(login) = login.filter(|s| !s.is_empty()) else {
        p.hint = Some("Sign in with `glab auth login` to publish here.".into());
        return p;
    };
    p.signed_in = true;
    p.account = Some(login.clone());
    p.owners.push(HostOwner { login, kind: "user".into() });

    let (ok, body, _) = run(dir, "glab", &["api", "groups?min_access_level=30&per_page=100"]);
    if ok {
        if let Ok(serde_json::Value::Array(rows)) = serde_json::from_str::<serde_json::Value>(&body) {
            for row in rows {
                // `full_path`, not `path`: a subgroup must be addressed by its
                // whole path or the project lands in the wrong namespace.
                if let Some(path) = row.get("full_path").and_then(|v| v.as_str()) {
                    p.owners.push(HostOwner { login: path.to_string(), kind: "group".into() });
                }
            }
        }
    }
    p
}

/// Both hosts, always both returned — a host you are signed out of is a row
/// with a fix, not an absence the user has to guess at.
#[tauri::command]
pub async fn repo_hosts(dir: String) -> Result<Vec<HostProvider>, String> {
    let path = PathBuf::from(&dir);
    let probe_dir = if path.is_dir() {
        path
    } else {
        std::env::temp_dir()
    };
    tokio::task::spawn_blocking(move || {
        vec![github_provider(&probe_dir), gitlab_provider(&probe_dir)]
    })
    .await
    .map_err(|e| format!("host probe task join: {e}"))
}

/// Is `owner/name` free on `provider`?
///
/// Asks the host rather than guessing: a name can be taken by a repo you
/// cannot see, and finding that out at push time — after `git init` and a
/// commit — is the worst moment for it.
#[tauri::command]
pub async fn repo_name_free(
    provider: String,
    owner: String,
    name: String,
) -> Result<bool, String> {
    let name = slugify(&name);
    if name.is_empty() {
        return Err("Repository name can't be empty.".into());
    }
    let owner = owner.trim().to_string();
    if owner.is_empty() {
        return Err("Pick an owner first.".into());
    }

    tokio::task::spawn_blocking(move || {
        let dir = std::env::temp_dir();
        match provider.as_str() {
            "github" => {
                let path = format!("repos/{owner}/{name}");
                let (found, _, _) = run(&dir, "gh", &["api", &path, "--silent"]);
                Ok(!found)
            }
            "gitlab" => {
                // The project id is the URL-encoded full path.
                let path = format!("projects/{owner}%2F{name}");
                let (found, _, _) = run(&dir, "glab", &["api", &path]);
                Ok(!found)
            }
            other => Err(format!("unknown host: {other}")),
        }
    })
    .await
    .map_err(|e| format!("name check task join: {e}"))?
}

/// What `repo_publish` did, step by step, so the UI can report the truth
/// rather than a generic success.
#[derive(Serialize, Clone, Debug)]
pub struct PublishResult {
    pub initialized: bool,
    pub committed: bool,
    pub remote_url: String,
    pub pushed: bool,
    pub branch: String,
}

/// `git init` (if needed) → first commit (if needed) → create the repo on the
/// host → `origin` → push.
///
/// Private by default and only public when explicitly asked: this runs against
/// a folder whose contents nobody has reviewed for secrets, and the reversible
/// mistake is publishing too little.
#[tauri::command]
pub async fn repo_publish(
    dir: String,
    provider: String,
    owner: String,
    name: String,
    private: bool,
) -> Result<PublishResult, String> {
    let path = PathBuf::from(&dir);
    if !path.is_dir() {
        return Err(format!("folder does not exist: {dir}"));
    }
    let name = slugify(&name);
    if name.is_empty() {
        return Err("Repository name can't be empty.".into());
    }
    let owner = owner.trim().to_string();
    if owner.is_empty() {
        return Err("Pick an owner first.".into());
    }

    tokio::task::spawn_blocking(move || {
        let mut initialized = false;
        let mut committed = false;

        let (is_repo, _, _) = git(&path, &["rev-parse", "--is-inside-work-tree"]);
        if !is_repo {
            // `-b main` so the first branch matches what both hosts default
            // to; without it a machine with an old git config starts on
            // `master` and the remote's default branch disagrees on push.
            let (ok, _, err) = git(&path, &["init", "-b", "main"]);
            if !ok {
                return Err(format!("git init failed: {err}"));
            }
            initialized = true;
        }

        let (has_commits, _, _) = git(&path, &["rev-parse", "--verify", "HEAD"]);
        if !has_commits {
            let (ok, _, err) = git(&path, &["add", "-A"]);
            if !ok {
                return Err(format!("git add failed: {err}"));
            }
            // Hooks off for this one: a repo being created for the first time
            // has no reviewed hook set, and a template hook that exits non-zero
            // would strand the folder half-initialised.
            let (ok, _, err) = git(
                &path,
                &["-c", "core.hooksPath=/dev/null", "commit", "-m", "Initial commit", "--allow-empty"],
            );
            if !ok {
                return Err(format!("first commit failed: {err}"));
            }
            committed = true;
        }

        let branch = {
            let (ok, b, _) = git(&path, &["rev-parse", "--abbrev-ref", "HEAD"]);
            if ok && !b.is_empty() && b != "HEAD" { b } else { "main".to_string() }
        };

        let visibility = if private { "private" } else { "public" };
        let full = format!("{owner}/{name}");

        let remote_url = match provider.as_str() {
            "github" => {
                let (ok, out, err) = run(
                    &path,
                    "gh",
                    &["repo", "create", &full, &format!("--{visibility}"), "--source=.", "--remote=origin", "--push"],
                );
                if !ok {
                    return Err(format!("couldn't create {full} on GitHub: {}", if err.is_empty() { out } else { err }));
                }
                let (_, url, _) = git(&path, &["remote", "get-url", "origin"]);
                url
            }
            "gitlab" => {
                let (ok, out, err) = run(
                    &path,
                    "glab",
                    &["repo", "create", &full, &format!("--{visibility}"), "--remoteName", "origin"],
                );
                if !ok {
                    return Err(format!("couldn't create {full} on GitLab: {}", if err.is_empty() { out } else { err }));
                }
                let (_, url, _) = git(&path, &["remote", "get-url", "origin"]);
                url
            }
            other => return Err(format!("unknown host: {other}")),
        };

        // `gh repo create --push` already pushed; `glab` did not, and a second
        // push of an up-to-date branch is a no-op, so both paths end here with
        // the branch actually on the remote.
        let (pushed, _, err) = git(&path, &["push", "-u", "origin", &branch]);
        if !pushed && !err.contains("Everything up-to-date") {
            return Ok(PublishResult { initialized, committed, remote_url, pushed: false, branch });
        }

        Ok(PublishResult { initialized, committed, remote_url, pushed: true, branch })
    })
    .await
    .map_err(|e| format!("publish task join: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::slugify;

    #[test]
    fn slugify_makes_a_folder_name_into_a_repo_name() {
        assert_eq!(slugify("New Git"), "New-Git");
        assert_eq!(slugify("my  app"), "my-app", "runs collapse to one dash");
        assert_eq!(slugify("aura-cli"), "aura-cli", "already valid, untouched");
        assert_eq!(slugify("v1.0_beta"), "v1.0_beta", "dot and underscore are legal");
    }

    #[test]
    fn slugify_never_leaves_a_leading_or_trailing_separator() {
        // A host rejects both, and the leading case is how a dotfile folder
        // ("/path/.config") would otherwise produce an unusable name.
        assert_eq!(slugify("  spaced  "), "spaced");
        assert_eq!(slugify("trailing."), "trailing");
        assert_eq!(slugify("!!!"), "", "nothing usable is empty, not a dash");
    }
}
