//! Which build is answering on the other end of the wire.
//!
//! The version contract stops at the edge of this machine. `RELEASE.toml`
//! stamps every component in the tree, a test now keeps them agreeing, and
//! the desktop app picks the CLI its build was tested against. None of that
//! says anything about the binary actually running in the cloud.
//!
//! It went wrong exactly there. The production Agent Card advertised 0.19.29
//! while the tree, the CDN and every local binary were on 0.19.44 — the
//! deployed server had simply never been swapped, and because a deploy is a
//! manual binary swap there was nothing that would ever notice. The number
//! was published the whole time: the card is built from
//! `env!("CARGO_PKG_VERSION")`, so it always states the version of the binary
//! that is running, and A2A requires the card to be unauthenticated. Nobody
//! was reading it.
//!
//! So this is a reader. `aura ping` already dials the server and reports what
//! it finds; it now reports this too. Drift stops being something you
//! discover by auditing and becomes something the command you already run
//! tells you.

/// Where an A2A agent publishes its card. Unauthenticated by spec, which is
/// why a plain `ping` can read it without a token.
pub const CARD_PATH: &str = "/.well-known/agent-card.json";

/// How the server's build compares to this one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Same build. Nothing to say.
    Same,
    /// The server is running something older than this CLI — the shape of
    /// the production drift: a deploy that never happened.
    ServerBehind,
    /// The server is ahead. Normal while a release is rolling out, and worth
    /// knowing when a local command starts failing against it.
    ServerAhead,
    /// One of the two versions did not parse. Say nothing rather than guess:
    /// a fork, a patched build or a proxy that rewrites the card are all
    /// legitimate, and none of them is drift.
    Unreadable,
}

/// Parse a semver-ish string down to `(major, minor, patch)`, tolerating a
/// `-rc1` suffix and a missing patch.
fn triple(v: &str) -> Option<(u32, u32, u32)> {
    let head = v.split('-').next().unwrap_or(v);
    let mut it = head.split('.');
    let maj: u32 = it.next()?.trim().parse().ok()?;
    let min: u32 = it.next()?.parse().ok()?;
    let patch: u32 = match it.next() {
        Some(p) => p.parse().ok()?,
        None => 0,
    };
    Some((maj, min, patch))
}

/// Compare the running server's version against this CLI's.
///
/// The patch counts. Every behavioural change in `0.19.x` ships as a patch
/// bump, so a comparison that ignored it would have called 0.19.29 and
/// 0.19.44 the same build — which is precisely the drift that went unseen.
pub fn compare(local: &str, server: &str) -> Verdict {
    match (triple(local), triple(server)) {
        (Some(l), Some(s)) if s == l => Verdict::Same,
        (Some(l), Some(s)) if s < l => Verdict::ServerBehind,
        (Some(_), Some(_)) => Verdict::ServerAhead,
        _ => Verdict::Unreadable,
    }
}

/// Pull the version out of an Agent Card body.
///
/// Only `version` is read. The card carries a `protocolVersion` too and the
/// two mean different things — the protocol can hold still across many
/// releases, which is what makes it useless for spotting a stale deploy.
pub fn card_version(body: &serde_json::Value) -> Option<String> {
    let v = body.get("version")?.as_str()?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// The sentence `aura ping` prints, or `None` when there is nothing worth
/// saying.
///
/// Silent on a match, because a line that appears every single time is a line
/// people stop reading, and this one has to be noticeable on the day it
/// changes. Silent on an unreadable pair for the same reason it is a separate
/// verdict: no evidence is not evidence.
pub fn drift_note(local: &str, server: &str) -> Option<String> {
    match compare(local, server) {
        Verdict::ServerBehind => Some(format!(
            "server is running {server}, this CLI is {local} — the deployed build is older than this one"
        )),
        Verdict::ServerAhead => Some(format!(
            "server is running {server}, this CLI is {local} — this CLI is the older of the two"
        )),
        Verdict::Same | Verdict::Unreadable => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_drift_is_the_case_this_exists_for() {
        // 0.19.29 answering while everything local was 0.19.44. Same major,
        // same minor — anything comparing on those two would have called it
        // healthy, which is how it survived a full release cycle unnoticed.
        assert_eq!(compare("0.19.44", "0.19.29"), Verdict::ServerBehind);
        let note = drift_note("0.19.44", "0.19.29").expect("drift must be said out loud");
        assert!(note.contains("0.19.29"), "the note must name the deployed build");
        assert!(note.contains("0.19.44"), "and the one it is being compared to");
    }

    #[test]
    fn a_matching_server_says_nothing() {
        assert_eq!(compare("0.19.44", "0.19.44"), Verdict::Same);
        assert_eq!(drift_note("0.19.44", "0.19.44"), None);
    }

    #[test]
    fn a_server_ahead_is_the_users_problem_not_the_servers() {
        assert_eq!(compare("0.19.44", "0.20.0"), Verdict::ServerAhead);
        let note = drift_note("0.19.44", "0.20.0").expect("worth saying");
        assert!(
            note.contains("this CLI is the older"),
            "say which of the two is behind; the reader cannot act on a number alone"
        );
    }

    #[test]
    fn a_prerelease_is_compared_as_the_release_it_leads_to() {
        assert_eq!(compare("0.19.44", "0.19.44-rc1"), Verdict::Same);
    }

    #[test]
    fn nothing_is_claimed_about_a_version_that_did_not_parse() {
        assert_eq!(compare("0.19.44", "nightly"), Verdict::Unreadable);
        assert_eq!(compare("", "0.19.44"), Verdict::Unreadable);
        assert_eq!(drift_note("0.19.44", "nightly"), None);
    }

    #[test]
    fn the_card_is_read_for_its_build_version_and_not_its_protocol() {
        let card = serde_json::json!({
            "name": "aura-semantic-vcs",
            "version": "0.19.29",
            "protocolVersion": "1.2",
        });
        assert_eq!(card_version(&card).as_deref(), Some("0.19.29"));
    }

    #[test]
    fn a_card_without_a_usable_version_yields_none() {
        assert_eq!(card_version(&serde_json::json!({ "version": "" })), None);
        assert_eq!(card_version(&serde_json::json!({ "version": 44 })), None);
        assert_eq!(card_version(&serde_json::json!({})), None);
    }
}
