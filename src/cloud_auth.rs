//! `aura auth …` — the credential verbs, under the name an agent reaches for.
//!
//! Aura has had all three of these for a long time, spelled `aura connect`,
//! `aura disconnect` and `aura whoami`. The gap this closes is a naming one,
//! not a missing capability: every comparable agent CLI groups them under
//! `auth`, so an agent (or a script written against one of those) tries
//! `aura auth status` first, gets clap's usage error, and concludes Aura has no
//! way to check a credential.
//!
//! So this noun delegates rather than reimplements. `login` and `logout` are
//! [`crate::cloud_connect`]'s device-code flow and its inverse, unchanged — a
//! second credential path would be a way for the two to disagree about which
//! token this machine holds, which is the one thing a credential store must
//! never do. The older spellings keep working; nothing is deprecated here.
//!
//! `status` is the one verb with something to add. `aura whoami` prints the
//! server's answer, which presumes there is a credential to ask with. Signed
//! out, or pointed at a cloud this machine has no token for, the useful answer
//! is local — and it is the difference between "the key is wrong" and "you are
//! asking the wrong server". So `status` resolves credentials first, reports
//! that itself when there is nothing to send, and only then asks the server.
//!
//! Exits on [`crate::cloud_contract::ExitCode`] like every other cloud noun:
//! being signed out is `3`, an unreachable server is `4`.

use clap::Subcommand;
use serde_json::{json, Value};

use crate::cloud_connect;
use crate::cloud_contract::ExitCode;
use crate::cloud_endpoint;
use crate::config::ConfigManager;
use crate::workspace_api::client::{resolve_auth, Client};
use crate::workspace_api::output;

/// Credentials for Aura Cloud: sign in, sign out, and ask who this machine is.
#[derive(Subcommand, Debug, Clone)]
pub enum AuthCmd {
    /// Sign this machine in to Aura Cloud. Opens a browser to confirm a code;
    /// the token is written to `~/.aura/credentials.json` (0600).
    Login {
        /// A different cloud to sign in to (staging, or a self-hosted server).
        url: Option<String>,
        /// Print the verification URL instead of opening a browser — for a
        /// headless box, or an SSH session with no display.
        #[arg(long)]
        no_browser: bool,
    },
    /// Forget the token signed in on this machine.
    Logout,
    /// Who this machine is to the cloud, and which credential says so.
    Status {
        #[arg(long)]
        json: bool,
    },
}

/// Run a verb; returns the process exit code.
pub fn run(cmd: &AuthCmd) -> i32 {
    match cmd {
        AuthCmd::Login { url, no_browser } => match cloud_connect::connect(url.clone(), *no_browser)
        {
            Ok(()) => ExitCode::Success.code(),
            Err(e) => {
                eprintln!("  ✗ {e}");
                // The device-code flow fails for two unlike reasons — the user
                // never confirmed the code, or the cloud could not be reached —
                // and `connect` reports both as one boxed error. Runtime is the
                // honest code for the pair: calling it `3` would claim we know
                // a credential was refused, when nothing was ever issued.
                ExitCode::Runtime.code()
            }
        },
        AuthCmd::Logout => match cloud_connect::disconnect() {
            Ok(()) => {
                warn_if_env_still_authenticates();
                ExitCode::Success.code()
            }
            Err(e) => {
                eprintln!("  ✗ {e}");
                ExitCode::Runtime.code()
            }
        },
        AuthCmd::Status { json } => status(*json),
    }
}

/// `auth status`, in two halves: what this machine holds, then what the server
/// says about it. The first half is answerable offline and is the whole answer
/// when there is no credential to send.
fn status(json: bool) -> i32 {
    let auth = match resolve_auth() {
        Ok(a) => a,
        Err(e) => {
            let (state, headline, reason) = unauthenticated();
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        // Not `signed_in`: that word answers a question about
                        // the machine, and on the branch below it the machine
                        // IS signed in — just not to this cloud. `state` says
                        // which situation it is; this boolean only says whether
                        // a call would authenticate, which is what a script
                        // guards on.
                        "authenticated": false,
                        "state": state,
                        "origin": configured_origin(),
                        "reason": reason,
                    }))
                    .unwrap_or_else(|_| "null".into())
                );
            } else {
                println!("  {:<10} {headline}", "status");
                println!("  {:<10} {}", "cloud", configured_origin());
                println!("  {:<10} {reason}", "reason");
            }
            // Deliberately the same code a refused key exits with. From a
            // script's point of view "I have no credential" and "my credential
            // was rejected" are one branch: re-authenticate. Keeping `e`'s own
            // mapping rather than hardcoding 3, so this follows the contract if
            // the taxonomy ever moves.
            return e.outcome().code();
        }
    };

    let client = match Client::new(auth) {
        Ok(c) => c,
        Err(e) => {
            output::print_error(&e);
            return e.exit_code();
        }
    };

    match client.whoami_described() {
        Ok(mut v) => {
            // The same two keys the offline branch above answers with, so a
            // caller reads one field on either path instead of inferring
            // success from the absence of `reason`.
            if let Value::Object(m) = &mut v {
                m.insert("authenticated".into(), Value::Bool(true));
                m.insert("state".into(), Value::String("signed_in".into()));
            }
            output::emit(json, &v, render_status);
            ExitCode::Success.code()
        }
        Err(e) => {
            output::print_error(&e);
            // A credential that exists and is refused still points the user at
            // the same remedy, and `ApiError` already maps 401/403 to auth and
            // 5xx to server — so an unreachable cloud is not reported as a bad
            // key.
            e.exit_code()
        }
    }
}

/// The server's answer with the local half kept on top, so the first line says
/// whether this machine is signed in at all rather than making the reader infer
/// it from a populated user row.
fn render_status(v: &Value) -> String {
    let mut out = String::from("  status     signed in\n");
    out.push_str(&output::render_whoami(v));
    out
}

/// Which cloud this machine would talk to — reported even when there is no
/// token, because "not signed in" is a different problem depending on whether
/// the URL is the one the user expected.
fn configured_origin() -> String {
    let cfg = ConfigManager::load();
    cloud_endpoint::origin_or_public(cfg.cloud_url.as_deref())
}

/// Why there is no usable credential: a machine-readable state, a headline and
/// the reason behind it.
///
/// Two unlike situations, and calling both "not signed in" is wrong in the
/// second. `AURA_CLOUD_URL` naming another cloud means the signed-in token is
/// deliberately withheld rather than sent somewhere it was not issued for —
/// that machine *is* signed in, so a bare "not signed in" contradicts the
/// reason printed directly under it and sends the user off to re-run a login
/// that would change nothing. The headline therefore names the cloud as the
/// thing without a credential, not the machine.
///
/// `state` goes into `--json` as well, so an agent branches on a value rather
/// than on prose.
fn unauthenticated() -> (&'static str, &'static str, String) {
    let signed_in = ConfigManager::load().cloud_api_token.is_some();
    if signed_in && cloud_endpoint::is_overridden() {
        (
            "no_credential_for_this_cloud",
            "signed in, but not to this cloud",
            format!(
                "{} names another cloud, so the signed-in token is not sent to it — \
                 set {} for that cloud, or unset {}",
                cloud_endpoint::URL_ENV,
                cloud_endpoint::TOKEN_ENV,
                cloud_endpoint::URL_ENV
            ),
        )
    } else {
        (
            "not_signed_in",
            "not signed in",
            "run `aura auth login`, or set AURA_API_KEY to an Aura API key".to_string(),
        )
    }
}

/// Said after a successful logout, when the shell would still authenticate.
///
/// Logging out clears the saved token and cannot clear an environment variable
/// in the parent shell. Without this line the next command succeeds and the
/// user reasonably concludes the logout silently failed — or worse, believes a
/// shared machine has been signed out when it has not.
fn warn_if_env_still_authenticates() {
    let leftover = [
        crate::workspace_api::client::API_KEY_ENV,
        cloud_endpoint::TOKEN_ENV,
    ]
    .into_iter()
    .find(|name| {
        std::env::var(name)
            .ok()
            .is_some_and(|v| !v.trim().is_empty())
    });
    if let Some(name) = leftover {
        eprintln!("  ! {name} is still set — this shell is still authenticated by it");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_api::client::ApiError;

    // `unauthenticated` and `configured_origin` read the process environment
    // and the user's real config file, so the precedence they delegate to is
    // not re-asserted here — `cloud_endpoint`'s own suite covers that, with
    // the env locking it needs. What is pinned here is the contract this noun
    // adds on top: which codes it exits with, that the rendering leads with
    // the local answer, and that the two no-credential states stay distinct
    // whichever one this machine happens to be in.

    #[test]
    fn being_signed_out_exits_as_an_auth_problem_not_a_runtime_one() {
        // The whole reason `status` exists separately from `whoami`: a script
        // can branch on 3 and re-authenticate, instead of parsing a message.
        assert_eq!(ApiError::NoAuth.outcome(), ExitCode::Auth);
        assert_eq!(ApiError::NoAuth.exit_code(), 3);
    }

    #[test]
    fn a_cloud_that_is_down_is_not_reported_as_a_bad_credential() {
        // `auth status` is the command someone runs to find out WHY a call
        // failed, so it is the last place that should blame the key for the
        // server's outage.
        let server = ApiError::Http {
            status: 503,
            body: String::new(),
        };
        assert_eq!(server.outcome(), ExitCode::Server);
        let refused = ApiError::Unauthorized {
            status: 401,
            body: String::new(),
        };
        assert_eq!(refused.outcome(), ExitCode::Auth);
    }

    #[test]
    fn a_failed_login_is_runtime_because_no_credential_was_ever_judged() {
        // Guards the comment in `run`: an abandoned device-code flow must not
        // claim auth (3), which means "your credential was rejected".
        assert_eq!(ExitCode::Runtime.code(), 1);
        assert_ne!(ExitCode::Runtime, ExitCode::Auth);
    }

    #[test]
    fn status_leads_with_whether_this_machine_is_signed_in() {
        let v = json!({
            "user": { "id": "u1", "login": "ashiq" },
            "org": { "id": "o1", "slug": "naridon", "name": "Naridon" },
            "key": { "kind": "api_token", "scopes": [], "unrestricted": true },
            "token_source": "signed-in token (aura connect)",
            "origin": "https://api.auravcs.com"
        });
        let out = render_status(&v);
        let first = out.lines().next().unwrap_or("");
        assert!(first.contains("status") && first.contains("signed in"), "{out}");
        // and still carries everything `whoami` would have shown
        assert!(out.contains("ashiq (u1)"));
        assert!(out.contains("naridon (Naridon)"));
        assert!(out.contains("signed-in token"));
        assert!(out.contains("https://api.auravcs.com"));
    }

    #[test]
    fn the_two_ways_of_having_no_credential_are_told_apart() {
        // Reads the real environment and config, so this asserts the shape of
        // the answer rather than which branch this machine is on: whichever it
        // is, the state must be one of the two known values and the headline
        // must not claim "not signed in" while the state says otherwise. The
        // precedence itself is `cloud_endpoint`'s, tested there with env locks.
        let (state, headline, reason) = unauthenticated();
        assert!(
            state == "not_signed_in" || state == "no_credential_for_this_cloud",
            "unknown state {state}"
        );
        assert!(!reason.is_empty(), "a reason is the whole point of this path");
        if state == "no_credential_for_this_cloud" {
            assert!(
                headline.contains("signed in, but"),
                "a machine that IS signed in must not be told it is not: {headline}"
            );
            assert!(reason.contains(cloud_endpoint::URL_ENV));
        } else {
            assert_eq!(headline, "not signed in");
            assert!(reason.contains("aura auth login"));
        }
    }

    #[test]
    fn the_signed_out_json_shape_is_answerable_without_a_server() {
        // An agent reading `--json` needs one key to branch on whether or not
        // a credential was found; these are the keys `status` prints on the
        // offline path.
        let (state, _, reason) = unauthenticated();
        let body = json!({
            "authenticated": false,
            "state": state,
            "origin": configured_origin(),
            "reason": reason,
        });
        assert_eq!(body["authenticated"], false);
        assert!(body["state"].is_string());
        assert!(body.get("origin").is_some());
        assert!(body.get("reason").is_some());
        // The key that used to live here said the opposite of the headline
        // above it on a machine signed in to a different cloud.
        assert!(body.get("signed_in").is_none());
    }
}
