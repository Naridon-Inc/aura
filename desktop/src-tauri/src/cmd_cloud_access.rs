//! Who in the org may use its machines, and the admin's switch for it.
//!
//! Cloud is a per-member grant (`org_cloud_members`), not a consequence of
//! being in the org: an org of thirty on three seats has three people who can
//! open a place, plus its owners and admins, who always can. The server has
//! answered and enforced this for a while (`places::entitlements_api`); what was
//! missing was any way for an admin to hand a seat out without a curl line.
//!
//! Three commands against `/api/v2/orgs/{slug}/cloud-access…`, for the org you
//! are acting as:
//!
//!   * `cloud_access_list`   — who holds a grant, and the seat picture
//!   * `cloud_access_grant`  — turn it on for a member, by login
//!   * `cloud_access_revoke` — turn it off, by user id
//!
//! The authority model is entirely the server's. Reads are open to any member
//! (a member refused a place has to be able to see that cloud is a grant and
//! who to ask); writes are owner/admin, checked against the org in the path.
//! The plan gate and the seat cap answer here as sentences — "All 3 cloud seats
//! are in use…" — and every error path carries those words forward unchanged.

use serde::Serialize;

use crate::cloud_org::OrgScoped;
use crate::cmd_cloud_members::{http_client, server_message, signed_in_org};

/// One member who holds a grant.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloudAccessGrant {
    pub user_id: String,
    pub github_login: String,
    /// `backfill` | `owner` | `manual` — why they have it.
    pub source: String,
}

/// The org's cloud grants and its seats.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloudAccess {
    pub org_slug: String,
    pub grants: Vec<CloudAccessGrant>,
    /// Grants held. Owners and admins without a row are not counted — the
    /// server does not count them against the cap either.
    pub granted: i64,
    /// Seats bought. `0` is unmetered (a free or trial org), never "full".
    pub seat_count: i64,
    pub plan: String,
}

/// Read the list endpoint's answer.
///
/// Apart from the request so its shape — including the 200 that carries
/// `{"error": …}` on a database fault — is pinned by a test, not a live org.
fn read_access(org_slug: &str, body: &str) -> Result<CloudAccess, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "Aura's answer about cloud access didn't make sense.".to_string())?;
    if let Some(error) = v.get("error").and_then(|e| e.as_str()) {
        return Err(error.to_string());
    }
    let rows = v
        .get("members")
        .and_then(|m| m.as_array())
        .ok_or_else(|| "Aura's answer about cloud access didn't make sense.".to_string())?;
    let text = |row: &serde_json::Value, key: &str| {
        row.get(key)
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let grants: Vec<CloudAccessGrant> = rows
        .iter()
        .filter_map(|row| {
            Some(CloudAccessGrant {
                user_id: text(row, "user_id")?,
                github_login: text(row, "github_login").unwrap_or_default(),
                source: text(row, "source").unwrap_or_else(|| "manual".into()),
            })
        })
        .collect();
    Ok(CloudAccess {
        org_slug: org_slug.to_string(),
        granted: v
            .get("granted")
            .and_then(|n| n.as_i64())
            .unwrap_or(grants.len() as i64),
        grants,
        // The server treats anything at or below zero as unmetered; so does this.
        seat_count: v
            .get("seat_count")
            .and_then(|n| n.as_i64())
            .filter(|n| *n > 0)
            .unwrap_or(0),
        plan: v
            .get("plan")
            .and_then(|p| p.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

/// Who in the org you are acting as may use its machines.
#[tauri::command]
pub async fn cloud_access_list() -> Result<CloudAccess, String> {
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/cloud-access");
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("Aura didn't answer: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(server_message(status, &body));
    }
    read_access(&slug, &body)
}

/// Let `login` use the org's machines. Owner/admin only — the server refuses
/// anyone else, and refuses past the seat cap or on a plan without shared
/// machines, each in a sentence that reaches the screen as written.
#[tauri::command]
pub async fn cloud_access_grant(login: String) -> Result<(), String> {
    let login = login.trim().trim_start_matches('@').to_string();
    if login.is_empty() {
        return Err("Which member?".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/cloud-access");
    let resp = http_client()?
        .post(&url)
        .bearer_auth(&token)
        .org_scoped()
        .json(&serde_json::json!({ "github_login": login }))
        .send()
        .await
        .map_err(|e| format!("Aura didn't answer: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(server_message(status, &body));
    }
    Ok(())
}

/// Stop `user_id` using the org's machines. Their sessions already running are
/// the server's business; the next place-open is refused.
#[tauri::command]
pub async fn cloud_access_revoke(user_id: String) -> Result<(), String> {
    let user_id = user_id.trim().to_string();
    if user_id.is_empty() {
        return Err("Which member?".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/cloud-access/{user_id}");
    let resp = http_client()?
        .delete(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("Aura didn't answer: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(server_message(status, &body));
    }
    Ok(())
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
    fn the_list_names_who_holds_a_seat_and_how_many_there_are() {
        let access = read_access("naridon", BODY).unwrap();
        assert_eq!(access.org_slug, "naridon");
        assert_eq!(
            access.grants.iter().map(|g| g.github_login.as_str()).collect::<Vec<_>>(),
            ["ana", "mo"]
        );
        assert_eq!(access.grants[1].source, "manual");
        assert_eq!((access.granted, access.seat_count), (2, 5));
        assert_eq!(access.plan, "team");
    }

    /// A free or trial org has bought no seats, and zero must not read as a cap
    /// of zero — the server treats it as unmetered.
    #[test]
    fn no_seats_bought_is_unmetered_not_full() {
        let access = read_access("me", r#"{"members":[],"granted":0,"seat_count":0,"plan":"free"}"#).unwrap();
        assert_eq!(access.seat_count, 0);
        assert!(access.grants.is_empty());
        assert_eq!(read_access("me", r#"{"members":[],"seat_count":-1}"#).unwrap().seat_count, 0);
    }

    /// A database fault answers 200 with `{"error": …}`. Read as rows that is
    /// an org that has granted nobody, which would show every switch off.
    #[test]
    fn an_error_envelope_is_an_error_and_not_an_empty_team() {
        assert_eq!(
            read_access("x", r#"{"error":"Database not configured"}"#).unwrap_err(),
            "Database not configured"
        );
        assert!(read_access("x", "<html>502</html>").is_err());
    }

    /// A row with no user id cannot be revoked, so it is not a row.
    #[test]
    fn a_grant_with_no_user_id_is_skipped() {
        let access = read_access("x", r#"{"members":[{"github_login":"ghost"}],"granted":1}"#).unwrap();
        assert!(access.grants.is_empty());
        assert_eq!(access.granted, 1);
    }
}
