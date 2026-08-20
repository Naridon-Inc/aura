//! Who is in the org, so a place can say who added it.
//!
//! The runner registry records an author as a user id, which is the only handle
//! it has — the registry does not join to `users`. An id on a row helps nobody:
//! "added by 8f3c…" is a fact nobody can act on, and it is the same amount of
//! screen as a name. `GET /api/v2/orgs/{slug}/members` is the one read that
//! turns those ids into logins, and it hands back your own role on the way past.
//!
//! Best-effort by construction. Every call site treats a failure here as "we
//! know less", never as "the list is broken": the org's places are still listed,
//! they just say *someone in Naridon* instead of *@ana*. That is why this
//! returns a [`Directory`] rather than a `Result` the caller has to decide about
//! — there is exactly one right decision and it is made here.

use std::collections::HashMap;
use std::time::Duration;

use crate::cloud_org::OrgScoped;

use super::roster::Directory;

/// A page load somebody is waiting on, and the second of two. Shorter than the
/// runner read's ten seconds on purpose: this one only adds names to a list
/// that is already correct without it.
const MEMBERS_TIMEOUT: Duration = Duration::from_secs(6);

/// The org's roster, as ids to logins plus who you are in it.
///
/// `me` is the login this laptop signed in as, which the credentials file has
/// held since the device flow landed — so "did I add this?" is answered without
/// a third round trip to ask the server who we are.
pub(crate) async fn directory(
    origin: &str,
    token: &str,
    slug: &str,
    me: Option<String>,
) -> Directory {
    let Ok(client) = reqwest::Client::builder().timeout(MEMBERS_TIMEOUT).build() else {
        return Directory {
            me,
            ..Directory::default()
        };
    };
    let url = format!("{origin}/api/v2/orgs/{slug}/members");
    let body = match client.get(&url).bearer_auth(token).org_scoped().send().await {
        Ok(resp) => resp.text().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    let (by_id, roles) = parse_members(&body);
    let my_role = me.as_deref().and_then(|me| {
        roles
            .iter()
            .find(|(login, _)| login.eq_ignore_ascii_case(me.trim()))
            .map(|(_, role)| role.clone())
    });
    Directory { by_id, me, my_role }
}

/// Read `{"members":[{"user":{…},"role":"…"}]}` into the two things we need.
///
/// Kept apart from the request so the shape — including the 200-carrying-an-
/// error this server answers a database fault with — is pinned by a test rather
/// than by a live org. Anything unreadable is an empty roster, which is exactly
/// what a caller does with a failure anyway.
fn parse_members(body: &str) -> (HashMap<String, String>, Vec<(String, String)>) {
    let mut by_id = HashMap::new();
    let mut roles = Vec::new();
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return (by_id, roles);
    };
    let rows = parsed
        .get("members")
        .and_then(|v| v.as_array())
        .or_else(|| parsed.as_array());
    let Some(rows) = rows else {
        return (by_id, roles);
    };
    for row in rows {
        let user = row.get("user").unwrap_or(row);
        let text = |v: &serde_json::Value, k: &str| {
            v.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let Some(login) = text(user, "github_login") else {
            continue;
        };
        if let Some(id) = text(user, "id") {
            by_id.insert(id, login.clone());
        }
        // A member row with no role is still a member — the column is
        // `NOT NULL` server-side, but this build must not drop a name because a
        // future server renamed a field.
        roles.push((login, text(row, "role").unwrap_or_else(|| "member".into())));
    }
    (by_id, roles)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoint's real envelope: the org's row plus the user it joins to.
    const BODY: &str = r#"{"members":[
      {"user":{"id":"u-ana","github_id":1,"github_login":"ana",
               "github_avatar":null,"email":null,"display_name":"Ana",
               "created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"},
       "role":"owner"},
      {"user":{"id":"u-mo","github_id":2,"github_login":"mo",
               "github_avatar":null,"email":null,"display_name":null,
               "created_at":"2026-02-01T00:00:00Z","updated_at":"2026-02-01T00:00:00Z"},
       "role":"member"}
    ]}"#;

    #[test]
    fn ids_become_logins() {
        let (by_id, roles) = parse_members(BODY);
        assert_eq!(by_id.get("u-ana").map(String::as_str), Some("ana"));
        assert_eq!(by_id.get("u-mo").map(String::as_str), Some("mo"));
        assert_eq!(roles.len(), 2);
        assert_eq!(roles[0], ("ana".into(), "owner".into()));
    }

    /// A database fault answers 200 with `{"error": …}` on these routes. Read
    /// as rows that is an org with no members, which is impossible — every org
    /// has at least the person asking — and it would put "someone in Naridon"
    /// on every row of a list that could have said the names.
    #[test]
    fn an_error_envelope_is_an_empty_roster_rather_than_a_panic() {
        let (by_id, roles) = parse_members(r#"{"error":"Database not configured"}"#);
        assert!(by_id.is_empty() && roles.is_empty());
    }

    #[test]
    fn a_body_that_isnt_json_is_an_empty_roster() {
        let (by_id, _) = parse_members("<html>502 Bad Gateway</html>");
        assert!(by_id.is_empty());
    }

    /// A member the server sent with no login can't be named, and a blank name
    /// beside "added by" is worse than the phrase we fall back to.
    #[test]
    fn a_member_with_no_login_is_skipped_rather_than_blank() {
        let (by_id, roles) = parse_members(r#"{"members":[{"user":{"id":"u-x"},"role":"member"}]}"#);
        assert!(by_id.is_empty() && roles.is_empty());
    }

    /// A row with no role still names its member — the point of this read is
    /// the names, and dropping one over a missing field would lose it.
    #[test]
    fn a_row_with_no_role_still_names_its_member() {
        let (by_id, roles) =
            parse_members(r#"{"members":[{"user":{"id":"u-x","github_login":"x"}}]}"#);
        assert_eq!(by_id.get("u-x").map(String::as_str), Some("x"));
        assert_eq!(roles[0].1, "member");
    }
}
