//! Whether the org holds a key of its own — without ever holding one here.
//!
//! `organizations.{gemini,anthropic,openai}_api_key` is the fallback this task
//! demotes, and to demote a thing honestly you have to be able to say whether it
//! is there. `GET /api/v2/orgs/{slug}/ai-keys` is the one read that answers
//! that, and it answers it *masked*: the server hands back `sk-a••••wxyz`,
//! never the key. That is the only reason this read is allowed to exist on a
//! laptop at all, and it is why nothing below ever asks for more.
//!
//! Two consequences, both deliberate:
//!
//! * **Presence, never material.** [`OrgKeyring`] can say "your org holds an
//!   Anthropic key, ending wxyz". It cannot say what it is, and there is no
//!   field on it that could — see [`shown`], which refuses to carry a value the
//!   server didn't mask.
//! * **Best-effort.** The endpoint is owner/admin-only, so a member reading it
//!   gets a `403`, and that is not a failure — it is "you are not allowed to
//!   know, which is fine, and the fallback still works". A place with no network
//!   is the same shape of answer. Every one of those becomes an [`OrgKeyring`]
//!   with `visible: false` and a reason worth printing, never an error a caller
//!   has to decide about, because there is exactly one right decision and it is
//!   made here.
//!
//! The parse is kept apart from the request so the shape — including the
//! `provider` field we ignore and the `null`s a fresh org answers with — is
//! pinned by a test rather than by a live org.

use std::collections::BTreeMap;
use std::time::Duration;

use crate::cloud_org::{active_org, OrgScoped};
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// Somebody is waiting on a session starting, so this read is on a short leash.
/// The same six seconds [`crate::place_roster`] gives the member list, for the
/// same reason: it adds a sentence to an answer that is already correct without
/// it.
const KEYS_TIMEOUT: Duration = Duration::from_secs(6);

/// What the org's settings hold, as far as this laptop is allowed to know.
///
/// `masked` holds the server's mask and nothing else — the four-and-four
/// `sk-a••••wxyz` shape, which is enough for a person to recognise which key
/// they configured and useless to anybody who intercepts it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OrgKeyring {
    /// What to call the org on screen. Empty means there is no org to fall back
    /// to — signed out, or acting as nobody.
    pub org: String,
    /// Did we actually get an answer? `false` with a `reason` is "we don't
    /// know", which a surface must not render as "there is no org key" — the
    /// endpoint is owner/admin-only, so most members legitimately land here.
    pub visible: bool,
    /// Why not, in words worth showing.
    pub reason: String,
    /// Provider field (`anthropic` | `openai` | `gemini`) to the masked key the
    /// org holds for it. Absent means the org holds none.
    pub masked: BTreeMap<String, String>,
}

impl OrgKeyring {
    /// An org we could not read, with the reason a person can act on.
    pub fn unreadable(org: impl Into<String>, reason: impl Into<String>) -> Self {
        OrgKeyring {
            org: org.into(),
            visible: false,
            reason: reason.into(),
            masked: BTreeMap::new(),
        }
    }

    /// An org read cleanly, holding nothing.
    pub fn empty(org: impl Into<String>) -> Self {
        OrgKeyring {
            org: org.into(),
            visible: true,
            reason: String::new(),
            masked: BTreeMap::new(),
        }
    }

    /// The same org, now known to hold a key for one provider.
    ///
    /// The only way anything gets into `masked`, so [`shown`] is applied on the
    /// one path rather than at each caller — a second way in would be the way an
    /// unmasked key eventually got in.
    pub fn holding(mut self, field: impl Into<String>, masked: impl Into<String>) -> Self {
        self.masked.insert(field.into(), shown(&masked.into()));
        self
    }

    /// The mask for one provider, if the org holds a key for it.
    pub fn held(&self, field: &str) -> Option<&str> {
        self.masked.get(field).map(String::as_str)
    }
}

/// What the org's settings hold, read now.
///
/// Signed out is an answer, not a failure: an org with no name is one
/// [`super::OrgKey`] declines with "you aren't acting as an org here", which is
/// true and is the end of it.
pub async fn org_keyring() -> OrgKeyring {
    let creds = read_credentials().unwrap_or_default();
    let active = active_org(&creds);
    let (Some(token), Some(slug)) = (cloud_token(&creds), active.slug.clone()) else {
        return OrgKeyring::default();
    };
    // The name if the file has one, the slug if it doesn't. A row that printed
    // as nothing is a sentence about nobody.
    let org = active.name.clone().unwrap_or_else(|| slug.clone());
    let Ok(client) = reqwest::Client::builder().timeout(KEYS_TIMEOUT).build() else {
        return OrgKeyring::unreadable(org, "this laptop couldn't open a connection");
    };
    let url = format!("{}/api/v2/orgs/{slug}/ai-keys", cloud_origin(&creds));
    match client.get(&url).bearer_auth(token).org_scoped().send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            parse_keys(&org, status, &body)
        }
        Err(_) => OrgKeyring::unreadable(org, "the org's settings couldn't be reached from here"),
    }
}

/// Read `{"anthropic":"sk-a••••wxyz","openai":null,…}` into presence.
///
/// Kept pure, and given the status, because the two interesting answers are
/// statuses rather than bodies: `403` is the ordinary case for a member and
/// `404` is an org this account is not in.
fn parse_keys(org: &str, status: u16, body: &str) -> OrgKeyring {
    match status {
        200 => {}
        403 => {
            return OrgKeyring::unreadable(
                org,
                "only an owner or an admin can see which keys the org holds",
            )
        }
        401 => {
            return OrgKeyring::unreadable(org, "this laptop is signed out of the org")
        }
        404 => {
            return OrgKeyring::unreadable(org, "this account isn't a member of that org")
        }
        code => return OrgKeyring::unreadable(org, format!("the org's settings answered {code}")),
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return OrgKeyring::unreadable(org, "the org's settings answered something unreadable");
    };
    let mut ring = OrgKeyring::empty(org);
    for field in ["anthropic", "openai", "gemini"] {
        let held = parsed
            .get(field)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(value) = held {
            ring = ring.holding(field, value);
        }
    }
    ring
}

/// What we are willing to keep of a value the server sent.
///
/// The server masks, and every mask it produces contains `••••`. A value
/// arriving without one is either a server that changed its mind or a build
/// pointed somewhere unexpected — and in both cases the honest move is to keep
/// the *fact* and drop the string, rather than to trust that today's endpoint is
/// tomorrow's. Presence is all any surface here needs; carrying more would make
/// this the second place an org key lives.
fn shown(value: &str) -> String {
    let v = value.trim();
    if v.contains('•') || v.contains('*') {
        v.to_string()
    } else {
        "••••".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "Naridon";

    #[test]
    fn an_org_with_keys_reports_which_ones_masked() {
        let ring = parse_keys(
            ORG,
            200,
            r#"{"gemini":null,"anthropic":"sk-a••••wxyz","openai":"sk-p••••4321","provider":"auto"}"#,
        );
        assert!(ring.visible);
        assert_eq!(ring.org, ORG);
        assert_eq!(ring.held("anthropic"), Some("sk-a••••wxyz"));
        assert_eq!(ring.held("openai"), Some("sk-p••••4321"));
        assert_eq!(ring.held("gemini"), None, "a null read as held");
    }

    #[test]
    fn a_fresh_org_holds_nothing_and_says_so_cleanly() {
        let ring = parse_keys(ORG, 200, r#"{"gemini":null,"anthropic":null,"openai":null}"#);
        assert!(ring.visible, "an org with no keys is not an org we failed to read");
        assert!(ring.masked.is_empty());
        assert!(ring.reason.is_empty());
    }

    /// The ordinary case, not an error: a member who is not an admin cannot read
    /// this endpoint, and their runs still spend the key. "We don't know" has to
    /// stay distinguishable from "there is none".
    #[test]
    fn a_member_who_may_not_look_is_told_why_rather_than_told_no() {
        let ring = parse_keys(ORG, 403, "");
        assert!(!ring.visible);
        assert!(ring.masked.is_empty());
        assert!(ring.reason.contains("owner or an admin"), "{}", ring.reason);
    }

    #[test]
    fn every_other_answer_is_a_reason_rather_than_a_silence() {
        for (status, body) in [(500, ""), (200, "<html>gateway</html>"), (401, ""), (404, "")] {
            let ring = parse_keys(ORG, status, body);
            assert!(!ring.visible, "{status} read as an answer");
            assert!(!ring.reason.trim().is_empty(), "{status} said nothing");
            assert_eq!(ring.org, ORG, "{status} lost the org's name");
        }
    }

    /// The one rule this module cannot bend. If a future server, a proxy, or a
    /// build pointed somewhere odd hands back a real key, it stops here.
    #[test]
    fn an_unmasked_key_is_never_carried_even_when_it_is_offered() {
        let ring = parse_keys(ORG, 200, r#"{"anthropic":"sk-ant-api03-REALKEYMATERIAL"}"#);
        assert_eq!(
            ring.held("anthropic"),
            Some("••••"),
            "an unmasked key was kept"
        );
        assert!(!format!("{ring:?}").contains("REALKEYMATERIAL"));
        // And presence survives, because presence is the thing the chain needs.
        assert!(ring.held("anthropic").is_some());
    }

    #[test]
    fn a_short_key_the_server_masked_whole_is_still_a_key() {
        let ring = parse_keys(ORG, 200, r#"{"gemini":"••••"}"#);
        assert_eq!(ring.held("gemini"), Some("••••"));
    }

    #[test]
    fn signed_out_is_an_org_of_no_name_rather_than_a_failure() {
        let ring = OrgKeyring::default();
        assert!(ring.org.is_empty());
        assert!(!ring.visible);
        assert!(ring.masked.is_empty());
    }
}
