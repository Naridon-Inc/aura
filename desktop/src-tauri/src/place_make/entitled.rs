//! Who will be able to open the machine once it exists.
//!
//! An admin making a box for a team is answering a question the app has never
//! shown them: cloud is a per-member grant (`org_cloud_members`), not a
//! consequence of being in the org, so an org of thirty on three seats has
//! three people who can open what is about to be made. Making a machine without
//! that on screen is how a team ends up with a box nobody but the admin can get
//! into, discovered one Slack message at a time.
//!
//! The read is `GET /api/v2/orgs/{slug}/cloud-access`, which the server opens to
//! any member — it hands back the grant list and the seat picture and carries no
//! credential, so reading it gives out nothing.
//!
//! ## Best-effort, and it says so
//!
//! This does not gate anything. The gate is server-side at every place-open
//! (`places::entitlements::require_cloud_access`), on both ways in, for both
//! place-modes. So a roster that does not answer must not stop a machine being
//! made — it must say that it does not know, which is a third state and not an
//! empty list. An empty list means "nobody but the admins", which is a real and
//! actionable answer; "we could not ask" is not, and drawing them the same way
//! would tell an admin their team has no access when it may have plenty.

use std::time::Duration;

use serde::Serialize;

use crate::cloud_org::OrgScoped;

/// The read is a second call on a surface somebody is waiting on, and it only
/// adds names to a decision that is already correct without them. Same six
/// seconds the places list gives its own roster read, for the same reason.
const TIMEOUT: Duration = Duration::from_secs(6);

/// Who the org has granted cloud to.
#[derive(Debug, Clone, Serialize)]
pub struct Entitled {
    /// `ok` — we asked and got an answer.
    /// `unknown` — we could not ask, or could not read the answer.
    pub status: String,
    /// The server's own words when it went wrong, empty otherwise.
    pub detail: String,
    /// The logins that hold a grant, in the order the server listed them
    /// (oldest grant first). Empty on an org where only the admins can open a
    /// place, which is a real answer.
    pub members: Vec<String>,
    /// Seats the org has bought. `0` means unmetered — a free or trial org,
    /// which the server treats as uncapped rather than as zero seats.
    pub seats: i64,
}

impl Entitled {
    /// We could not find out. Never an empty member list: "nobody has been
    /// granted cloud" and "we do not know who has" are different sentences and
    /// send an admin to different places.
    pub fn unknown(detail: impl Into<String>) -> Self {
        Self {
            status: "unknown".into(),
            detail: detail.into(),
            members: vec![],
            seats: 0,
        }
    }
}

/// Ask the org who may open a place in it.
pub async fn in_org(origin: &str, token: &str, slug: &str) -> Entitled {
    let Ok(client) = reqwest::Client::builder().timeout(TIMEOUT).build() else {
        return Entitled::unknown("This build couldn't open a connection to Aura.");
    };
    let url = format!("{origin}/api/v2/orgs/{slug}/cloud-access");
    let resp = match client.get(&url).bearer_auth(token).org_scoped().send().await {
        Ok(resp) => resp,
        Err(e) => return Entitled::unknown(format!("Aura didn't answer: {e}")),
    };
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Entitled::unknown(format!("Aura answered {status}."));
    }
    read(&body)
}

/// Read the answer into the two things that matter.
///
/// Apart from the request so the shape — including the 200-carrying-an-error
/// these routes answer a database fault with — is pinned by a test rather than
/// by a live org.
fn read(body: &str) -> Entitled {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return Entitled::unknown("Aura's answer didn't make sense.");
    };
    if let Some(error) = parsed.get("error").and_then(|v| v.as_str()) {
        return Entitled::unknown(error.to_string());
    }
    let Some(rows) = parsed.get("members").and_then(|v| v.as_array()) else {
        return Entitled::unknown("Aura's answer didn't make sense.");
    };
    let members = rows
        .iter()
        .filter_map(|row| {
            row.get("github_login")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .collect();
    Entitled {
        status: "ok".into(),
        detail: String::new(),
        members,
        // A negative seat count is not a cap anybody bought; the server treats
        // anything at or below zero as unmetered and so does this.
        seats: parsed
            .get("seat_count")
            .and_then(|v| v.as_i64())
            .filter(|n| *n > 0)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoint's real envelope, trimmed to what this reads.
    const BODY: &str = r#"{
      "members":[
        {"user_id":"u-ana","github_login":"ana","role":"admin","source":"owner",
         "granted_by":null,"created_at":"2026-01-01T00:00:00Z"},
        {"user_id":"u-mo","github_login":"mo","role":"member","source":"manual",
         "granted_by":"u-ana","created_at":"2026-02-01T00:00:00Z"}
      ],
      "granted":2,"seat_count":5,"plan":"team"
    }"#;

    #[test]
    fn the_answer_names_the_people_who_will_be_able_to_open_it() {
        let entitled = read(BODY);
        assert_eq!(entitled.status, "ok");
        assert_eq!(entitled.members, ["ana", "mo"]);
        assert_eq!(entitled.seats, 5);
    }

    /// An org that has granted nobody is a real answer, and the admin needs to
    /// see it — it means the box they are about to make is theirs alone until
    /// they hand seats out.
    #[test]
    fn nobody_granted_is_an_answer_and_not_an_unknown() {
        let entitled = read(r#"{"members":[],"granted":0,"seat_count":0,"plan":"free"}"#);
        assert_eq!(entitled.status, "ok");
        assert!(entitled.members.is_empty());
    }

    /// A free or trial org has bought no seats, and zero must not be drawn as a
    /// cap of zero — the server treats it as unmetered, so nothing here may
    /// tell an admin they are full.
    #[test]
    fn an_org_that_has_bought_nothing_is_unmetered_rather_than_full() {
        assert_eq!(read(r#"{"members":[],"seat_count":0}"#).seats, 0);
        assert_eq!(read(r#"{"members":[],"seat_count":-3}"#).seats, 0);
    }

    /// A database fault answers 200 with `{"error": …}` on these routes. Read
    /// as rows that is an org that has granted nobody, which would tell an admin
    /// their team has no access when it may have plenty.
    #[test]
    fn an_error_envelope_is_unknown_rather_than_an_empty_team() {
        let entitled = read(r#"{"error":"Database not configured"}"#);
        assert_eq!(entitled.status, "unknown");
        // Verbatim: the server's sentence says what to do and ours would not.
        assert_eq!(entitled.detail, "Database not configured");
        assert!(entitled.members.is_empty());
    }

    #[test]
    fn a_body_that_isnt_json_is_unknown() {
        assert_eq!(read("<html>502 Bad Gateway</html>").status, "unknown");
        assert_eq!(read("").status, "unknown");
    }

    /// A member the server sent with no login cannot be named, and a blank in a
    /// list of people is worse than a shorter list.
    #[test]
    fn a_member_with_no_login_is_skipped_rather_than_blank() {
        let entitled = read(r#"{"members":[{"user_id":"u-x"},{"github_login":"  "}]}"#);
        assert_eq!(entitled.status, "ok");
        assert!(entitled.members.is_empty());
    }

    /// Nothing that could authenticate anybody comes out of this read. The
    /// projection is the server's business, and this is the line that notices
    /// if it ever stops being.
    #[test]
    fn nothing_here_carries_a_credential() {
        // Deliberately not shaped like a real token: a fixture that looked like
        // one would be a string in the repo that every secret scanner has to be
        // told to ignore, and one day would not be told.
        let leaky = r#"{"members":[{"github_login":"ana","token":"NOT-A-CREDENTIAL"}]}"#;
        let entitled = read(leaky);
        assert_eq!(entitled.members, ["ana"]);
        let said = format!("{entitled:?}");
        assert!(!said.contains("NOT-A-CREDENTIAL"), "{said}");
    }
}
