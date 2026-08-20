//! The credential a push on this box spends — fetched per remote, held in
//! memory, and never written down.
//!
//! A runner box is a computer several members share. Git there reads one
//! credential store per OS user, so whatever is in `~/.git-credentials` is what
//! *everybody's* push spends: one operator's long-lived personal token, doing
//! the whole team's work under the whole team's name. And because
//! [`crate::runner`] pinned `user.name`/`user.email` to "Aura Runner", the
//! commits did not even claim to be anybody's.
//!
//! This is the box half of `places::push_credentials` in aura-cloud. It plugs
//! into git the one way git offers — as a **credential helper** — and that
//! shape is what makes the guarantee real rather than aspirational:
//!
//!   * **Nothing is persisted.** A helper is a process. It answers on stdout
//!     and exits, so the token exists in a pipe and in this process's memory
//!     and nowhere else. There is no code path here that opens a file for
//!     writing, which is a property you can check by reading the module rather
//!     than by trusting a comment.
//!   * **`store` is refused, out loud.** Git's contract lets a helper persist
//!     what it was given, and the stock `store` helper is exactly how a token
//!     ends up in `~/.git-credentials` in the first place. [`run`] consumes the
//!     verb, writes nothing, and says on stderr that it did not — a silent drop
//!     would look identical to a helper that quietly kept it.
//!   * **Refreshed before it expires, not after.** The cloud answers with a
//!     `refresh_after` ten minutes ahead of the real deadline, and
//!     [`for_remote`] treats anything past that as absent. A long-running
//!     `aura runner serve` therefore re-mints mid-session instead of
//!     discovering the expiry in the middle of pushing a branch.
//!   * **The identity travels with the credential.** The same answer carries
//!     the member's GitHub no-reply address, and [`attach_to_checkout`] writes
//!     it into the checkout's own `user.email`. That is what makes the commit
//!     land under the member rather than under the box — the token authenticates
//!     the connection and can never say who pushed.
//!
//! Whose push is it? The box names a member, exactly as it already does when it
//! announces a session: [`ACTING_MEMBER_ENV`] carries a UUID or a GitHub login,
//! and the cloud resolves it against `org_members` before it will mint
//! anything. A box that cannot name anybody gets no credential — see
//! [`attach_to_checkout`], which then leaves the checkout entirely alone rather
//! than half-configuring it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Utc};

/// Names the member this box is acting for. A user UUID or a GitHub login —
/// the cloud accepts either and resolves it against the org.
pub const ACTING_MEMBER_ENV: &str = "AURA_ACTING_MEMBER";

/// The place (runner) id, when the caller already knows it. Absent, we ask
/// `GET /api/v2/runners/self` with the runner token.
pub const PLACE_ID_ENV: &str = "AURA_PLACE_ID";

/// The runner token env var, matching [`crate::runner`].
const RUNNER_TOKEN_ENV: &str = "AURA_RUNNER_TOKEN";

/// The header the cloud reads to learn who the box is acting for.
const ACTING_MEMBER_HEADER: &str = "X-Aura-Acting-Member";

/// A credential for one remote, good until [`Self::refresh_after`].
#[derive(Debug, Clone)]
pub struct PushCredential {
    pub username: String,
    pub token: String,
    pub expires_at: DateTime<Utc>,
    /// Come back for another at this point — always comfortably before
    /// `expires_at`, so a push started now finishes on a live token.
    pub refresh_after: DateTime<Utc>,
    /// `owner/name`.
    pub repo: String,
    /// What to write into `user.name`.
    pub author_name: String,
    /// What to write into `user.email`. GitHub resolves this back to the
    /// member's account, which is what puts their name on the commit.
    pub author_email: String,
    /// Which source under the cloud's seam answered.
    pub source: String,
}

/// Credentials fetched during the life of THIS process.
///
/// In memory and only in memory. A credential helper is normally a short-lived
/// process, so this mostly earns its keep inside `aura runner serve`, which
/// holds one process across many cycles and would otherwise re-mint on every
/// git call it makes directly.
fn cache() -> &'static Mutex<HashMap<String, PushCredential>> {
    static CACHE: OnceLock<Mutex<HashMap<String, PushCredential>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The member this box is acting for, if it has been told.
pub fn acting_member() -> Option<String> {
    std::env::var(ACTING_MEMBER_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn runner_token() -> Option<String> {
    std::env::var(RUNNER_TOKEN_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// The credential this box speaks to the cloud with, and whether it is a
/// machine credential.
///
/// The runner token first: on a shared box that is the credential that belongs
/// to the *machine*, and pairing it with a named member is the whole point —
/// it lets the box act for somebody without holding anything of theirs. A
/// human cloud login is the fallback, for a member running this from their own
/// laptop against a place.
fn cloud_credentials() -> Result<(String, String), String> {
    if let Some(token) = runner_token() {
        let base = crate::recall_cloud_creds()
            .map(|(url, _)| url)
            .or_else(|_| std::env::var("AURA_CLOUD_URL"))
            .unwrap_or_else(|_| "https://api.auravcs.com".to_string());
        return Ok((base.trim_end_matches('/').to_string(), token));
    }
    crate::recall_cloud_creds().map(|(url, token)| (url.trim_end_matches('/').to_string(), token))
}

/// The place this box is. `AURA_PLACE_ID` when it has been told, otherwise the
/// registry's own answer for the token we hold.
fn place_id(client: &reqwest::blocking::Client, base: &str, token: &str) -> Result<String, String> {
    if let Ok(id) = std::env::var(PLACE_ID_ENV) {
        let id = id.trim();
        if !id.is_empty() {
            return Ok(id.to_string());
        }
    }
    let body = crate::recall_get(client, &format!("{base}/api/v2/runners/self"), token)?;
    body.get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "this box is not registered as a place, so there is no per-member credential to \
                 mint — run `aura runner register`, or set {PLACE_ID_ENV}"
            )
        })
}

/// Ask the cloud for a credential for `remote`, on behalf of the member this
/// box is acting for.
///
/// Every refusal the cloud can give is named (`no_cloud_grant`,
/// `unknown_project`, `no_github_app`, …) and the name is carried into the
/// error text verbatim. On a shared box the difference between "an admin has
/// not turned cloud on for you" and "the network blipped" is the difference
/// between a fix and a shrug, and a shrug here means somebody goes and installs
/// a personal token to make the problem go away.
pub fn fetch(remote: &str) -> Result<PushCredential, String> {
    let member = acting_member().ok_or_else(|| {
        format!(
            "this box has not been told which member it is acting for — set {ACTING_MEMBER_ENV} \
             to a GitHub login or user id"
        )
    })?;

    let (base, token) = cloud_credentials()?;
    let client = crate::cloud_http_client();
    let place = place_id(&client, &base, &token)?;

    let resp = client
        .post(format!("{base}/api/v2/places/{place}/git-credential"))
        .header("Authorization", format!("Bearer {token}"))
        .header(ACTING_MEMBER_HEADER, &member)
        .json(&serde_json::json!({ "remote": remote }))
        .send()
        .map_err(|e| format!("asking the cloud for a push credential: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .map_err(|e| format!("push credential response (HTTP {status}) did not parse: {e}"))?;

    if !status.is_success() {
        let reason = body
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("refused");
        let detail = body
            .get("detail")
            .and_then(|v| v.as_str())
            .unwrap_or("no detail given");
        return Err(format!("no credential for {remote}: {reason} — {detail}"));
    }

    parse(&body)
}

/// Read the cloud's answer. Split out from [`fetch`] so the shape of the
/// contract is testable without a server.
pub fn parse(body: &serde_json::Value) -> Result<PushCredential, String> {
    let string = |key: &str| -> Result<String, String> {
        body.get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("push credential answer had no `{key}`"))
    };
    let time = |key: &str| -> Result<DateTime<Utc>, String> {
        let raw = body
            .get(key)
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("push credential answer had no `{key}`"))?;
        DateTime::parse_from_rfc3339(raw)
            .map(|t| t.with_timezone(&Utc))
            .map_err(|e| format!("push credential `{key}` is not a timestamp: {e}"))
    };
    let author = |key: &str| -> Result<String, String> {
        body.get("author")
            .and_then(|a| a.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("push credential answer named no author {key}"))
    };

    Ok(PushCredential {
        username: string("username")?,
        token: string("token")?,
        expires_at: time("expires_at")?,
        refresh_after: time("refresh_after")?,
        repo: string("repo")?,
        author_name: author("name")?,
        author_email: author("email")?,
        source: string("source").unwrap_or_else(|_| "cloud".to_string()),
    })
}

/// A credential for `remote`, from this process's memory when one is still
/// comfortably live, otherwise freshly minted.
///
/// The freshness test is the cloud's own `refresh_after`, not the expiry. A
/// token inside its refresh window is treated as absent even though it would
/// still work, because the alternative is handing it to a push that takes
/// longer than the time it has left.
pub fn for_remote(remote: &str) -> Result<PushCredential, String> {
    if let Some(held) = held(remote, Utc::now()) {
        return Ok(held);
    }
    let fresh = fetch(remote)?;
    if let Ok(mut cache) = cache().lock() {
        cache.insert(remote.to_string(), fresh.clone());
    }
    Ok(fresh)
}

/// The cached credential for `remote`, if it is still worth using at `now`.
fn held(remote: &str, now: DateTime<Utc>) -> Option<PushCredential> {
    let cache = cache().lock().ok()?;
    cache
        .get(remote)
        .filter(|c| now < c.refresh_after)
        .cloned()
}

/// Forget everything this process is holding.
///
/// Called when a session ends. The memory would go anyway when the process
/// exits, but a runner process outlives many sessions, and a credential minted
/// for one member has no business still being in the map when the next member's
/// work starts.
pub fn forget_all() {
    if let Ok(mut cache) = cache().lock() {
        cache.clear();
    }
}

// ─── The git credential helper ──────────────────────────────────────────────

/// The `credential.helper` value that points git at this binary.
///
/// The `!` prefix tells git to run it as a shell command rather than looking
/// for `git-credential-<name>` on PATH, and the path is quoted because a box's
/// install directory may contain spaces.
pub fn helper_command(exe: &Path) -> String {
    format!("!'{}' git-credential", exe.display())
}

/// The `-c` arguments that make one git invocation use this helper and only
/// this helper.
///
/// Two things, both load-bearing:
///
///   * The **empty** `credential.helper` first. Git reads the setting as a
///     list, so an appended helper leaves the box's own `~/.git-credentials`
///     answering first — which is precisely the shared credential being
///     replaced. An empty value resets the list.
///   * `credential.useHttpPath=true`. Without it git tells a helper only the
///     protocol and host, so every GitHub repo on earth looks like one
///     credential request and there is no project to scope a token to.
pub fn git_config_args(exe: &Path) -> Vec<String> {
    vec![
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        format!("credential.helper={}", helper_command(exe)),
        "-c".to_string(),
        "credential.useHttpPath=true".to_string(),
    ]
}

/// Rebuild the remote URL from what git handed the helper on stdin.
///
/// Git speaks key=value lines terminated by a blank line. `path` only arrives
/// because [`git_config_args`] turns on `useHttpPath`; without it there is no
/// project here and the caller has nothing to scope a token to, which is a
/// misconfiguration rather than a bad remote.
pub fn remote_from_helper_input(input: &str) -> Option<String> {
    let mut protocol = None;
    let mut host = None;
    let mut path = None;
    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() {
            break;
        }
        match line.split_once('=') {
            Some(("protocol", v)) => protocol = Some(v.to_string()),
            Some(("host", v)) => host = Some(v.to_string()),
            Some(("path", v)) => path = Some(v.to_string()),
            _ => {}
        }
    }
    let host = host.filter(|h| !h.is_empty())?;
    let path = path.filter(|p| !p.is_empty())?;
    let protocol = protocol.unwrap_or_else(|| "https".to_string());
    Some(format!("{protocol}://{host}/{path}"))
}

/// The answer git expects back for a `get`.
pub fn helper_answer(cred: &PushCredential) -> String {
    format!("username={}\npassword={}\n", cred.username, cred.token)
}

/// `aura git-credential <get|store|erase>` — git's credential helper protocol.
///
/// `store` and `erase` are answered by doing nothing at all, deliberately.
/// Persisting is the whole failure mode: git offers a helper the chance to keep
/// what it was given, and taking that offer is how a token reaches
/// `~/.git-credentials` and becomes the box's credential rather than the
/// member's. Dropping the verb silently would be indistinguishable from a
/// helper that quietly kept it, so it says so.
pub fn run(action: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;

    match action {
        "get" => {
            let remote = remote_from_helper_input(&input).ok_or_else(|| {
                "git did not say which repository it wants a credential for — the checkout \
                 needs `credential.useHttpPath=true` (see `aura runner serve`)"
                    .to_string()
            })?;
            let cred = for_remote(&remote)?;
            let mut out = std::io::stdout().lock();
            out.write_all(helper_answer(&cred).as_bytes())?;
            out.flush()?;
            eprintln!(
                "[aura] push credential for {} as {} ({}), expires {}",
                cred.repo,
                cred.author_email,
                cred.source,
                cred.expires_at.to_rfc3339()
            );
        }
        "store" => {
            eprintln!(
                "[aura] not storing this credential — it is short-lived and per-member, and a \
                 copy on disk would be the box-wide credential again"
            );
        }
        "erase" => {}
        other => return Err(format!("unknown git credential action '{other}'").into()),
    }
    Ok(())
}

// ─── Wiring a checkout up ───────────────────────────────────────────────────

/// What [`attach_to_checkout`] did, so a caller can log it honestly.
#[derive(Debug, PartialEq, Eq)]
pub enum Attached {
    /// The checkout now mints per-member credentials, and its commits will
    /// carry this identity.
    Member { login: String, email: String },
    /// This box does not know which member it is acting for, so the checkout
    /// was left exactly as it was.
    NoMember,
    /// We know the member but could not mint for them. The checkout is left
    /// alone rather than half-configured — a `credential.helper` reset with no
    /// working helper behind it would break pushes that work today.
    Refused(String),
}

/// Point one checkout at the per-member credential, and set the commit identity
/// to match.
///
/// Repo-local (`git config --local`), never `--global`: the whole bug being
/// fixed is a credential that belongs to the machine, and writing this one
/// machine-wide would repeat the shape while changing the contents.
///
/// Nothing here writes a secret. What lands in `.git/config` is the name of a
/// command to run and the member's public GitHub identity; the token is
/// fetched, used and dropped every time git asks.
pub fn attach_to_checkout(dir: &Path, exe: &Path, remote: &str) -> Attached {
    if acting_member().is_none() {
        return Attached::NoMember;
    }

    let cred = match for_remote(remote) {
        Ok(c) => c,
        Err(e) => return Attached::Refused(e),
    };

    let set = |args: &[&str]| {
        let _ = Command::new("git")
            .arg("config")
            .arg("--local")
            .args(args)
            .current_dir(dir)
            .status();
    };

    // Reset the list before adding ours. Git reads `credential.helper` as a
    // list and consults them in order, so without the empty entry the box's own
    // `~/.git-credentials` would still answer first and this would change
    // nothing at all.
    let _ = Command::new("git")
        .args(["config", "--local", "--unset-all", "credential.helper"])
        .current_dir(dir)
        .status();
    set(&["--add", "credential.helper", ""]);
    set(&["--add", "credential.helper", &helper_command(exe)]);
    // Without this git asks for "a credential for github.com" and the helper
    // has no project to scope a token to.
    set(&["credential.useHttpPath", "true"]);

    set(&["user.name", &cred.author_name]);
    set(&["user.email", &cred.author_email]);

    Attached::Member {
        login: cred.author_name.clone(),
        email: cred.author_email,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(expires: DateTime<Utc>, refresh: DateTime<Utc>) -> serde_json::Value {
        serde_json::json!({
            "username": "x-access-token",
            "token": "ghs_secret",
            "expires_at": expires.to_rfc3339(),
            "refresh_after": refresh.to_rfc3339(),
            "remote": "https://github.com/Naridon-Inc/aura.git",
            "repo": "Naridon-Inc/aura",
            "author": { "login": "mhask", "name": "Mo", "email": "42+mhask@users.noreply.github.com" },
            "source": "github_app_installation",
            "ephemeral": true,
        })
    }

    #[test]
    fn the_cloud_answer_carries_both_the_token_and_the_identity() {
        let expires = Utc::now() + chrono::Duration::hours(1);
        let cred = parse(&answer(expires, expires - chrono::Duration::minutes(10))).unwrap();
        assert_eq!(cred.username, "x-access-token");
        assert_eq!(cred.token, "ghs_secret");
        assert_eq!(cred.repo, "Naridon-Inc/aura");
        assert_eq!(cred.author_email, "42+mhask@users.noreply.github.com");
        assert!(cred.refresh_after < cred.expires_at);
    }

    /// An answer missing the author is refused rather than defaulted. A default
    /// here would be a box identity, which is the bug.
    #[test]
    fn an_answer_without_an_author_is_not_usable() {
        let expires = Utc::now() + chrono::Duration::hours(1);
        let mut body = answer(expires, expires);
        body["author"] = serde_json::json!({ "login": "mhask" });
        assert!(parse(&body).is_err());
    }

    #[test]
    fn git_is_told_the_repository_and_the_helper_answers_both_halves() {
        let input = "protocol=https\nhost=github.com\npath=Naridon-Inc/aura.git\n\n";
        assert_eq!(
            remote_from_helper_input(input).as_deref(),
            Some("https://github.com/Naridon-Inc/aura.git")
        );
    }

    /// Without `useHttpPath` git sends no path, and a credential request for
    /// "github.com" names no project to scope a token to. That is a
    /// misconfiguration and must read as one rather than as a bad remote.
    #[test]
    fn a_request_with_no_path_names_no_project() {
        assert_eq!(
            remote_from_helper_input("protocol=https\nhost=github.com\n\n"),
            None
        );
        assert_eq!(remote_from_helper_input(""), None);
    }

    /// Git terminates the request with a blank line and may write more after
    /// it; everything past the blank line belongs to a different exchange.
    #[test]
    fn the_request_ends_at_the_blank_line() {
        let input = "protocol=https\nhost=github.com\npath=a/b.git\n\nhost=evil.com\npath=c/d\n";
        assert_eq!(
            remote_from_helper_input(input).as_deref(),
            Some("https://github.com/a/b.git")
        );
    }

    #[test]
    fn the_helper_answers_in_gits_own_protocol() {
        let expires = Utc::now() + chrono::Duration::hours(1);
        let cred = parse(&answer(expires, expires)).unwrap();
        assert_eq!(
            helper_answer(&cred),
            "username=x-access-token\npassword=ghs_secret\n"
        );
    }

    /// The empty helper has to come FIRST. Appending ours to the box's list
    /// leaves `~/.git-credentials` answering first, and the push spends the
    /// operator's token exactly as it always did.
    #[test]
    fn the_box_wide_helper_is_reset_before_ours_is_named() {
        let args = git_config_args(Path::new("/usr/local/bin/aura"));
        let empty = args.iter().position(|a| a == "credential.helper=").unwrap();
        let ours = args
            .iter()
            .position(|a| a.starts_with("credential.helper=!"))
            .unwrap();
        assert!(empty < ours, "the box's own helper would answer first");
        assert!(args.iter().any(|a| a == "credential.useHttpPath=true"));
    }

    #[test]
    fn the_helper_command_survives_a_path_with_spaces() {
        let cmd = helper_command(Path::new("/Applications/Aura.app/aura"));
        assert!(cmd.starts_with("!'"));
        assert!(cmd.ends_with("' git-credential"));
    }

    /// The freshness test is the refresh deadline, not the expiry — a token
    /// with four minutes left is treated as absent so a slow push never runs
    /// out mid-transfer.
    #[test]
    fn a_held_credential_stops_being_offered_at_its_refresh_deadline() {
        let now = Utc::now();
        let cred = PushCredential {
            username: "x-access-token".into(),
            token: "ghs_secret".into(),
            expires_at: now + chrono::Duration::hours(1),
            refresh_after: now + chrono::Duration::minutes(50),
            repo: "Naridon-Inc/aura".into(),
            author_name: "Mo".into(),
            author_email: "42+mhask@users.noreply.github.com".into(),
            source: "github_app_installation".into(),
        };
        let remote = "https://github.com/Naridon-Inc/held.git";
        cache().lock().unwrap().insert(remote.to_string(), cred);

        assert!(held(remote, now).is_some());
        assert!(
            held(remote, now + chrono::Duration::minutes(51)).is_none(),
            "a credential inside its refresh window was still being handed out"
        );
        forget_all();
        assert!(held(remote, now).is_none());
    }

    /// The one property this whole module exists for, asserted against its own
    /// source: nothing here writes a credential to disk. `attach_to_checkout`
    /// writes `git config` entries — a command name and a public email — and
    /// that is the only thing that touches a file at all.
    #[test]
    fn nothing_here_writes_a_credential_to_a_file() {
        let source = include_str!("push_credential.rs");
        // Code only. Every one of these names appears in the prose above
        // explaining why it is not here, and a scan that could not tell the
        // difference would make the explanation unwritable.
        let production: String = source
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for writer in [
            "File::create",
            "fs::write",
            "OpenOptions",
            ".git-credentials",
            "credential.helper=store",
        ] {
            assert!(
                !production.contains(writer),
                "this module reached for {writer} — the credential must stay in memory"
            );
        }
    }
}
