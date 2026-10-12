//! The contract every `aura <noun>` cloud verb keeps: what the process exits
//! with, and how a list is paged.
//!
//! AURA-1437. These two things are not per-noun decisions. A script that drives
//! `aura workspace`, `aura session` and `aura routine` in one shell loop reads
//! `$?` the same way after each of them, and an agent that pages one list
//! expects the next one to page identically. Before this module each noun would
//! have invented both, and the first disagreement would only show up in someone
//! else's CI.
//!
//! Both halves are deliberately matched to Conductor's documented CLI contract,
//! because parity on the agent-facing surface is the point (see the Page
//! "Conductor 0.85 → 0.90.1 — gap read + parity plan"). Where their contract is
//! *weaker* than ours we keep ours and say so — see [`ExitCode`] on usage
//! errors, and the note on credentials at the bottom of this file.

use std::fmt;

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/// What `aura <noun> <verb>` exits with.
///
/// The five values and their meanings are Conductor's, so that a script written
/// against one CLI reads the other correctly:
///
/// | code | meaning |
/// |------|---------|
/// | 0 | the verb did what it said |
/// | 1 | a runtime failure — the request was well-formed and still did not work |
/// | 2 | the caller got the arguments wrong |
/// | 3 | the caller is not authenticated, or not allowed |
/// | 4 | the server failed |
///
/// Two of these are worth stating plainly because they are easy to get subtly
/// wrong:
///
/// **Not-found is `1`, not its own code.** A workspace that does not exist is a
/// runtime failure from the caller's point of view: the command was spelled
/// correctly and the world did not contain what it named. Giving it a dedicated
/// code reads nicely in isolation but means every caller has to learn one more
/// number to answer "did this work", and it is not what Conductor does.
///
/// **`2` is reserved for usage, and clap already produces it.** `clap` exits 2
/// on an unknown flag or a missing argument without being asked to, which is
/// the same number Conductor uses for the same class of mistake. So usage
/// errors are already right before any of our code runs, and nothing here
/// should ever return [`ExitCode::Usage`] for something the server rejected —
/// that is the server's judgement, not the parser's, and it belongs in `1` or
/// `3`.
///
/// # This is a change
///
/// `aura workspace` previously exited `2` for auth and `3` for not-found. Both
/// move here: auth becomes `3`, not-found becomes `1`. A script that tested for
/// the old numbers will read the new ones as the wrong thing, which is why the
/// mapping is written down rather than left to each call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ExitCode {
    /// The verb did what it said it would.
    Success = 0,
    /// Well-formed request, and it still did not work — including "no such
    /// thing", a conflict, an unreachable network and an unreadable reply.
    Runtime = 1,
    /// The caller got the arguments wrong. Normally produced by `clap` before
    /// we are reached; see the type docs.
    Usage = 2,
    /// No credentials, bad credentials, or credentials without the scope this
    /// verb needs.
    Auth = 3,
    /// The server broke — any 5xx.
    Server = 4,
}

impl ExitCode {
    /// The number to hand `std::process::exit`.
    pub fn code(self) -> i32 {
        self as i32
    }

    /// Whether this outcome means the verb succeeded.
    pub fn is_success(self) -> bool {
        self == ExitCode::Success
    }

    /// Classify an HTTP status from the cloud.
    ///
    /// `401` and `403` are the caller's credentials. Every other 4xx is a
    /// runtime failure rather than a usage error, on the reasoning in the type
    /// docs: by the time the server has an opinion, the arguments already
    /// parsed. 5xx is the server's own fault and gets its own code so a caller
    /// can retry on `4` without also retrying on a genuine `409`.
    pub fn for_status(status: u16) -> ExitCode {
        match status {
            200..=299 => ExitCode::Success,
            401 | 403 => ExitCode::Auth,
            500..=599 => ExitCode::Server,
            _ => ExitCode::Runtime,
        }
    }
}

impl fmt::Display for ExitCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ExitCode::Success => "success",
            ExitCode::Runtime => "runtime error",
            ExitCode::Usage => "usage error",
            ExitCode::Auth => "auth error",
            ExitCode::Server => "server error",
        };
        f.write_str(s)
    }
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/// The largest page the API will serve, whatever the caller asks for.
///
/// Conductor's number. A cap has to exist — an agent that passes `--limit
/// 100000` on a busy org should get a page and a `has_more`, not a timeout —
/// and picking theirs means a script tuned against one CLI pages the same way
/// against the other.
pub const MAX_LIMIT: u32 = 100;

/// The page size a list verb uses when the caller does not say.
pub const DEFAULT_LIMIT: u32 = 25;

/// One page of a list, as asked for by the caller.
///
/// Clamping happens on construction rather than at the call site so that a verb
/// cannot forget to do it, and so `limit` is already the number that will
/// actually be sent by the time anyone reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageRequest {
    pub limit: u32,
    pub offset: u32,
}

impl Default for PageRequest {
    fn default() -> Self {
        PageRequest { limit: DEFAULT_LIMIT, offset: 0 }
    }
}

impl PageRequest {
    /// A page request from whatever the caller passed.
    ///
    /// `limit` is clamped into `1..=MAX_LIMIT`: zero is never what anyone meant
    /// (it asks the server for nothing and reads as "no results"), and anything
    /// over the cap is quietly served as the cap by the server anyway, so
    /// clamping here keeps the sent value and the asked-for value the same.
    pub fn new(limit: Option<u32>, offset: Option<u32>) -> Self {
        PageRequest {
            limit: limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT),
            offset: offset.unwrap_or(0),
        }
    }

    /// The query string to append to a list path, leading `?` included.
    ///
    /// Always emits both parameters. A list endpoint that receives only one of
    /// them has to guess the other, and the guess is where two nouns drift
    /// apart.
    pub fn query(self) -> String {
        format!("?limit={}&offset={}", self.limit, self.offset)
    }

    /// The request for the page after this one.
    pub fn next(self) -> Self {
        PageRequest { limit: self.limit, offset: self.offset.saturating_add(self.limit) }
    }
}

/// Whether a list response says more rows are waiting.
///
/// The server's field is `hasMore`. It is read defensively — a missing or
/// non-boolean field means "no more", because the failure that matters is an
/// agent looping forever on a server that never said to stop, not one that
/// stops a page early and can be asked again.
pub fn has_more(body: &serde_json::Value) -> bool {
    body.get("hasMore").and_then(|v| v.as_bool()).unwrap_or(false)
}

// ---------------------------------------------------------------------------
// A note on credentials, which is where we deliberately do NOT match
// ---------------------------------------------------------------------------
//
// Conductor splits credentials two ways: a user API key and a workspace token,
// with a handful of verbs (routines among them) refusing the workspace token.
//
// Aura does not copy that, because Aura's model already subsumes it. We mint
// three kinds of bearer — a human token (`aura_…`), an org API key
// (`aura_ak_…`) and a runner token (`aura_runner_…`) — and an org API key
// carries an explicit scope set out of a seven-scope vocabulary that
// `aura-cloud`'s `access::scope_for_request` enforces on every single request.
// "This verb refuses that credential" is therefore already expressible, per
// verb, at a finer grain than a two-way split, and it is enforced server-side
// rather than by the client choosing to be honest about which token it holds.
//
// Matching the two-token split literally would mean adding a coarser mechanism
// next to a finer one that already works. So the parity item is recorded as met
// by scopes, and new nouns state which scope they need rather than which of two
// tokens they want.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_five_exit_codes_are_the_documented_numbers() {
        assert_eq!(ExitCode::Success.code(), 0);
        assert_eq!(ExitCode::Runtime.code(), 1);
        assert_eq!(ExitCode::Usage.code(), 2);
        assert_eq!(ExitCode::Auth.code(), 3);
        assert_eq!(ExitCode::Server.code(), 4);
    }

    #[test]
    fn only_success_counts_as_success() {
        assert!(ExitCode::Success.is_success());
        for e in [ExitCode::Runtime, ExitCode::Usage, ExitCode::Auth, ExitCode::Server] {
            assert!(!e.is_success(), "{e} should not be success");
        }
    }

    #[test]
    fn refused_credentials_are_auth_and_a_broken_server_is_its_own_code() {
        assert_eq!(ExitCode::for_status(401), ExitCode::Auth);
        assert_eq!(ExitCode::for_status(403), ExitCode::Auth);
        assert_eq!(ExitCode::for_status(500), ExitCode::Server);
        assert_eq!(ExitCode::for_status(503), ExitCode::Server);
    }

    #[test]
    fn a_missing_thing_is_a_runtime_failure_not_its_own_code() {
        // The change from the old `aura workspace` contract, pinned so it
        // cannot drift back: 404 is 1, and auth is 3 rather than 2.
        assert_eq!(ExitCode::for_status(404), ExitCode::Runtime);
        assert_eq!(ExitCode::for_status(409), ExitCode::Runtime);
        assert_eq!(ExitCode::for_status(400), ExitCode::Runtime);
    }

    #[test]
    fn every_2xx_is_success() {
        for s in [200u16, 201, 202, 204, 299] {
            assert_eq!(ExitCode::for_status(s), ExitCode::Success, "status {s}");
        }
    }

    #[test]
    fn a_limit_is_clamped_to_something_the_server_will_serve() {
        assert_eq!(PageRequest::new(Some(0), None).limit, 1);
        assert_eq!(PageRequest::new(Some(50), None).limit, 50);
        assert_eq!(PageRequest::new(Some(MAX_LIMIT), None).limit, MAX_LIMIT);
        assert_eq!(PageRequest::new(Some(100_000), None).limit, MAX_LIMIT);
    }

    #[test]
    fn an_unasked_for_page_is_the_first_one_at_the_default_size() {
        let p = PageRequest::new(None, None);
        assert_eq!(p.limit, DEFAULT_LIMIT);
        assert_eq!(p.offset, 0);
        assert_eq!(p, PageRequest::default());
    }

    #[test]
    fn a_page_query_always_carries_both_parameters() {
        assert_eq!(PageRequest::new(Some(10), Some(20)).query(), "?limit=10&offset=20");
        assert_eq!(
            PageRequest::new(None, None).query(),
            format!("?limit={DEFAULT_LIMIT}&offset=0")
        );
    }

    #[test]
    fn the_next_page_steps_by_one_page_and_never_wraps() {
        let p = PageRequest::new(Some(10), Some(20));
        assert_eq!(p.next(), PageRequest { limit: 10, offset: 30 });

        // An offset near the ceiling saturates rather than wrapping to 0 and
        // re-serving page one forever.
        let edge = PageRequest { limit: 10, offset: u32::MAX - 1 };
        assert_eq!(edge.next().offset, u32::MAX);
    }

    #[test]
    fn a_server_that_does_not_say_is_read_as_having_no_more() {
        assert!(has_more(&json!({ "hasMore": true })));
        assert!(!has_more(&json!({ "hasMore": false })));
        assert!(!has_more(&json!({})));
        assert!(!has_more(&json!({ "hasMore": "yes" })));
        assert!(!has_more(&json!(null)));
    }
}
