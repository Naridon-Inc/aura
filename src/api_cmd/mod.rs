//! `aura api` — one authenticated call to the cloud this machine is signed in
//! to.
//!
//! # Why a raw passthrough belongs in a CLI that already wraps its API
//!
//! `aura workspace`, `aura cloud`, `aura routine` each wrap the endpoints they
//! were written for, and each of them is a release behind the server. When an
//! endpoint ships, or gains a field, or is only ever going to be called by one
//! script in one repo, the honest answer today is `curl` — and `curl` means
//! the caller re-deriving three things this CLI already knows and gets wrong
//! differently each time:
//!
//! * **which cloud.** `AURA_CLOUD_URL`, else the signed-in `cloud_url`, else
//!   the public host — and an override that the signed-in token must not
//!   follow. Hand-rolled, this is where a staging run posts to production.
//! * **which credential.** `AURA_API_KEY`, else `AURA_CLOUD_TOKEN`, else what
//!   `aura connect` saved. Hand-rolled, this is a token pasted into a shell
//!   history, or into a `-H` in a committed script.
//! * **which repo.** An agent that wants "this project's workspaces" has to
//!   turn a checkout into `owner/repo`, or into Aura's own `rid-…`, by the same
//!   rule the desktop uses. Hand-rolled, it files work under a second name.
//!
//! So this command is not a convenience over `curl`. It is the three rules
//! above, applied to a path the caller names, with the token never printed and
//! never sent to a host it was not issued for.
//!
//! # The shape
//!
//! ```text
//! aura api /workspaces
//! aura api /projects/{repo_slug}/workspaces -q status=open
//! aura api /workspaces -X POST -d '{"repo":"MHASK/aura-sovereign"}'
//! aura api /workspaces -d @body.json --dry-run
//! ```
//!
//! A path is relative to the public API surface; `{owner}`, `{repo}`,
//! `{repo_slug}`, `{branch}`, `{repo_id}`, `{checkout_id}` and `{room_id}` are
//! filled from the checkout you are standing in. `--dry-run` prints the
//! request and sends nothing.
//!
//! # What it will not do
//!
//! * Send your token to a host other than the one it resolved. A full URL is
//!   accepted only when it is on that host.
//! * Print your token, in a plan, an error, or a header echo.
//! * Take `-H Authorization:`. One place decides which credential reaches
//!   which host; a header that beat it would be a second place.
//! * Mint anything. `{repo_id}` and `{room_id}` are read from files the repo
//!   committed; a repo without them is told which command creates them.
//!
//! Exit codes are [`ExitCode`]'s, so a script reads this the same way it reads
//! every other cloud verb: 0 for a 2xx, 1 for a reply that failed, 2 for a
//! request we would not send, 3 for credentials, 4 for a 5xx.

pub mod render;
pub mod request;
pub mod send;
pub mod target;

use crate::cloud_contract::ExitCode;
use crate::workspace_api::client::{self, ApiError};

use request::Request;

/// Everything `aura api` was asked for, as clap parsed it.
pub struct Call<'a> {
    pub path: &'a str,
    pub method: Option<&'a str>,
    pub data: Option<&'a str>,
    pub headers: &'a [String],
    pub query: &'a [String],
    pub raw: bool,
    pub dry_run: bool,
}

/// Make the call. Returns the process exit code.
pub fn cli(call: &Call) -> i32 {
    // Credentials first, because the origin comes with them: the rule that
    // decides which cloud to call is the same rule that decides whether the
    // signed-in token may follow. Resolving the URL separately is how those
    // two answers drift apart.
    let auth = match client::resolve_auth() {
        Ok(a) => a,
        Err(e) => {
            // A dry run still shows the plan — the URL is most of what the
            // caller wanted to see, and it does not depend on a credential.
            // It still exits non-zero, because the call it describes cannot
            // be made, and a `--dry-run` that passed here would be a green
            // check for a command that is about to fail.
            if call.dry_run {
                if let Some(req) = plan_without_auth(call) {
                    println!("{} {}", req.method, req.url);
                }
            }
            eprintln!("{}", e.message());
            return e.exit_code();
        }
    };

    let req = match build(&auth.origin, call) {
        Ok(r) => r,
        // Nothing has been sent, so this is never the server's judgement of
        // the request — but it is not always the caller's either. A misspelled
        // flag or name exits 2 like any other usage error; a fact this machine
        // could not supply exits 1. See [`target::Fault`].
        Err(e) => {
            eprintln!("{}", e.message());
            return e.outcome().code();
        }
    };

    if call.dry_run {
        render::plan(&req, &auth);
        return ExitCode::Success.code();
    }

    let http = match client::http_client() {
        Ok(h) => h,
        Err(e) => {
            eprintln!("{}", e.message());
            return e.exit_code();
        }
    };
    match send::send(&http, &auth, &req) {
        Ok(answer) => {
            render::body(&answer.body, call.raw);
            let outcome = ExitCode::for_status(answer.status);
            if !outcome.is_success() {
                render::trouble(answer.status, &answer.body);
            }
            outcome.code()
        }
        Err(e) => {
            eprintln!("{}", ApiError::Network(e).message());
            ExitCode::Runtime.code()
        }
    }
}

/// Assemble the request. Split out so the whole of it is testable: every
/// failure here is a sentence the caller can act on without a server.
pub fn build(origin: &str, call: &Call) -> Result<Request, target::Fault> {
    build_with(origin, call, &target::resolve_from_repo, &|p| {
        std::fs::read_to_string(p)
    })
}

/// [`build`] with the two things that touch the machine passed in — the repo
/// facts and the file read.
pub fn build_with(
    origin: &str,
    call: &Call,
    resolve: &dyn Fn(&str) -> Result<String, String>,
    read_file: &dyn Fn(&str) -> std::io::Result<String>,
) -> Result<Request, target::Fault> {
    // Everything below the name-filling is the caller's own text — a method, a
    // header, a body, a query parameter — so it can only ever be wrong in the
    // usage sense.
    let usage = target::Fault::Usage;
    let filled = target::fill(call.path, resolve)?;
    let url = target::with_query(
        &target::url_for(origin, &filled).map_err(usage)?,
        call.query,
    )
    .map_err(usage)?;
    let body = request::body_from(call.data, read_file, &request::stdin_text).map_err(usage)?;
    Ok(Request {
        method: request::method_for(call.method, body.is_some()).map_err(usage)?,
        url,
        headers: request::headers_from(call.headers).map_err(usage)?,
        body,
    })
}

/// The URL a dry run can still show when no credential resolved. Built against
/// the cloud this machine would call; `None` when the path itself is the
/// problem, in which case the error that follows says so.
fn plan_without_auth(call: &Call) -> Option<Request> {
    let cfg = crate::config::ConfigManager::load();
    let origin = crate::cloud_endpoint::origin_or_public(cfg.cloud_url.as_deref());
    build(&origin, call).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call<'a>(path: &'a str) -> Call<'a> {
        Call {
            path,
            method: None,
            data: None,
            headers: &[],
            query: &[],
            raw: false,
            dry_run: false,
        }
    }

    fn facts(name: &str) -> Result<String, String> {
        match name {
            "repo_slug" => Ok("MHASK/aura-sovereign".into()),
            "owner" => Ok("MHASK".into()),
            _ => Err(format!("no {name} here")),
        }
    }

    fn no_file(p: &str) -> std::io::Result<String> {
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            p.to_string(),
        ))
    }

    #[test]
    fn a_read_is_a_get_on_the_public_surface() {
        let req = build_with("https://api.auravcs.com", &call("/workspaces"), &facts, &no_file).unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.url, "https://api.auravcs.com/api/v2/public/workspaces");
        assert_eq!(req.body, None);
    }

    #[test]
    fn the_project_name_is_filled_and_stays_one_segment() {
        let q = vec!["status=open".to_string()];
        let mut c = call("/projects/{repo_slug}/workspaces");
        c.query = &q;
        let req = build_with("https://h", &c, &facts, &no_file).unwrap();
        assert_eq!(
            req.url,
            "https://h/api/v2/public/projects/MHASK%2Faura-sovereign/workspaces?status=open"
        );
    }

    #[test]
    fn a_body_makes_it_a_post_and_is_checked_as_json() {
        let mut c = call("/workspaces");
        c.data = Some("{\"repo\":\"MHASK/aura-sovereign\"}");
        let req = build_with("https://h", &c, &facts, &no_file).unwrap();
        assert_eq!(req.method, "POST");
        assert!(req.body.is_some());

        let mut bad = call("/workspaces");
        bad.data = Some("repo=x");
        let err = build_with("https://h", &bad, &facts, &no_file).unwrap_err();
        assert!(err.message().contains("not JSON"), "{err:?}");
        assert_eq!(err.outcome(), ExitCode::Usage);
    }

    #[test]
    fn a_fact_this_checkout_cannot_answer_for_is_reported_not_guessed() {
        let err = build_with("https://h", &call("/rooms/{room_id}"), &facts, &no_file).unwrap_err();
        assert_eq!(err.message(), "no room_id here");
        assert_eq!(err.outcome(), ExitCode::Runtime);
    }

    #[test]
    fn a_url_on_another_host_is_refused_while_building() {
        // The important part is *when*: before any client exists, so there is
        // no code path on which the token has been attached yet.
        let err = build_with(
            "https://api.auravcs.com",
            &call("https://evil.example/collect"),
            &facts,
            &no_file,
        )
        .unwrap_err();
        assert!(
            err.message().contains("will not send your token"),
            "{err:?}"
        );
    }

    #[test]
    fn an_authorization_header_is_refused_while_building() {
        let header = vec!["Authorization: Bearer stolen".to_string()];
        let mut c = call("/workspaces");
        c.headers = &header;
        let err = build_with("https://h", &c, &facts, &no_file).unwrap_err();
        assert!(err.message().contains("AURA_API_KEY"), "{err:?}");
    }
}
