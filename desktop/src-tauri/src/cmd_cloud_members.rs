//! The cloud org roster, manageable from the desktop.
//!
//! Three commands against `/api/v2/orgs/{slug}/members…`: who is in the org
//! you are acting as, change a member's role, remove a member (or leave, when
//! the id is your own). The authority model lives server-side (aura-cloud
//! `orgs.rs`): owner/admin manage the roster, `owner` is owner-only territory
//! in both directions, the last owner can be neither demoted nor removed, and
//! leaving is open to anyone. Refusals arrive as sentences worth showing —
//! every error path here carries the server's own words forward.
//!
//! And who "you" are among them: `cloud_me` asks the cloud for the signed-in
//! account's user id, the id every member row, owner and turn author uses.

use serde::Serialize;
use std::time::Duration;

use crate::cloud_org::OrgScoped;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

/// One roster row, flattened from the wire's `{ user: {…}, role }` so the
/// frontend never has to know the server nests it.
#[derive(Debug, Clone, Serialize)]
pub struct CloudOrgMember {
    pub user_id: String,
    pub github_login: String,
    pub github_avatar: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub role: String,
}

/// The signed-in account, by the id the cloud names it with everywhere: a
/// member row's `user_id`, a workspace's owner, a turn's author.
///
/// The sign-in's saved name (`cloud_user`) can't stand in for it. It is a
/// GitHub login for one sign-in path and an email or a display name for
/// another, so matching it against members' logins lost "you" whenever it was
/// anything but the login.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CloudMe {
    pub user_id: String,
    pub github_login: String,
    pub email: Option<String>,
}

/// `GET /api/v2/me`'s `user`, or `None` when the answer names no one.
fn me_of(v: &serde_json::Value) -> Option<CloudMe> {
    let user = v.get("user")?;
    let user_id = user.get("id")?.as_str()?.trim();
    if user_id.is_empty() {
        return None;
    }
    let text = |k: &str| {
        user.get(k)
            .and_then(|s| s.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(CloudMe {
        user_id: user_id.to_string(),
        github_login: text("github_login").unwrap_or_default(),
        email: text("email"),
    })
}

/// Who is signed in to the cloud, as the cloud knows them.
#[tauri::command]
pub async fn cloud_me() -> Result<CloudMe, String> {
    let v = crate::cmd_cloud_workspaces::call_at(
        crate::cmd_cloud_workspaces::Verb::Get,
        "/api/v2/me",
        None,
    )
    .await?;
    me_of(&v).ok_or_else(|| "The cloud didn't say who is signed in.".to_string())
}

pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Token + active org slug + origin, or the sentence explaining which of the
/// three is missing. Every command here needs all three.
pub(crate) fn signed_in_org() -> Result<(String, String, String), String> {
    let creds = read_credentials().unwrap_or_default();
    let token = cloud_token(&creds)
        .ok_or_else(|| "Sign in to Aura Cloud to see your org's roster.".to_string())?;
    let slug = creds
        .get("cloud_org_slug")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Your Aura account isn't part of a cloud org yet.".to_string())?
        .to_string();
    Ok((token, slug, cloud_origin(&creds)))
}

/// The server's own message out of an error body, so a 409 like "this is the
/// organization's only owner" reaches the screen instead of a status code.
pub(crate) fn server_message(status: reqwest::StatusCode, body: &str) -> String {
    let msg = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .or_else(|| v.get("error"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .filter(|m| !m.trim().is_empty());
    match msg {
        Some(m) => m,
        None => format!("The server refused (HTTP {status})."),
    }
}

/// Everyone in the org you are acting as, privileged roles first.
#[tauri::command]
pub async fn cloud_org_members() -> Result<Vec<CloudOrgMember>, String> {
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/members");
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(server_message(status, &body));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("roster parse: {e}"))?;
    let rows = v
        .get("members")
        .and_then(|m| m.as_array())
        .ok_or_else(|| "The roster came back in a shape this app doesn't know.".to_string())?;
    let mut members: Vec<CloudOrgMember> = rows
        .iter()
        .filter_map(|row| {
            let user = row.get("user")?;
            Some(CloudOrgMember {
                user_id: user.get("id")?.as_str()?.to_string(),
                github_login: user
                    .get("github_login")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string(),
                github_avatar: user
                    .get("github_avatar")
                    .and_then(|s| s.as_str())
                    .map(str::to_string),
                email: user.get("email").and_then(|s| s.as_str()).map(str::to_string),
                display_name: user
                    .get("display_name")
                    .and_then(|s| s.as_str())
                    .map(str::to_string),
                role: row
                    .get("role")
                    .and_then(|s| s.as_str())
                    .unwrap_or("member")
                    .to_string(),
            })
        })
        .collect();
    // Owner > admin > member, then alpha — the same reading order the console
    // roster uses, computed here so both surfaces agree without a helper the
    // frontend would have to re-implement.
    let rank = |r: &str| match r {
        "owner" => 0u8,
        "admin" => 1,
        "member" => 2,
        _ => 3,
    };
    members.sort_by(|a, b| {
        rank(&a.role)
            .cmp(&rank(&b.role))
            .then_with(|| a.github_login.cmp(&b.github_login))
    });
    Ok(members)
}

/// Change one member's role. `role` is owner|admin|member; the server refuses
/// anything else, and refuses an admin touching `owner` in either direction.
#[tauri::command]
pub async fn cloud_org_member_set_role(user_id: String, role: String) -> Result<(), String> {
    let user_id = user_id.trim().to_string();
    let role = role.trim().to_lowercase();
    if user_id.is_empty() || role.is_empty() {
        return Err("A member and a role are both required.".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/members/{user_id}");
    let resp = http_client()?
        .patch(&url)
        .bearer_auth(&token)
        .org_scoped()
        .json(&serde_json::json!({ "role": role }))
        .send()
        .await
        .map_err(|e| format!("PATCH {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(server_message(status, &body));
    }
    Ok(())
}

/// Remove a member from the org — or leave it, when the id is your own. The
/// server also drops their cloud entitlement and this org's repo grants in the
/// same transaction, so there is nothing to clean up afterwards.
#[tauri::command]
pub async fn cloud_org_member_remove(user_id: String) -> Result<(), String> {
    let user_id = user_id.trim().to_string();
    if user_id.is_empty() {
        return Err("Which member?".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/members/{user_id}");
    let resp = http_client()?
        .delete(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("DELETE {url}: {e}"))?;
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
    use serde_json::json;

    #[test]
    fn you_are_the_user_the_cloud_names() {
        let me = me_of(&json!({
            "user": { "id": "u-1", "github_login": "ash", "email": "ash@example.dev", "display_name": "Ash" },
            "organizations": [],
        }))
        .unwrap();
        assert_eq!(
            me,
            CloudMe { user_id: "u-1".into(), github_login: "ash".into(), email: Some("ash@example.dev".into()) }
        );
    }

    #[test]
    fn an_answer_with_no_user_names_no_one() {
        assert_eq!(me_of(&json!({ "user": null })), None);
        assert_eq!(me_of(&json!({ "user": { "id": "  " } })), None);
        assert_eq!(me_of(&json!({ "error": "Database not configured" })), None);
        let bare = me_of(&json!({ "user": { "id": "u-2", "email": "" } })).unwrap();
        assert_eq!((bare.github_login.as_str(), bare.email), ("", None));
    }
}

/// Add one org member to a project (repository), so a workspace on it can be
/// shared with them. `POST /api/v2/repos/{repo_id}/members` — the server lets
/// only the org's owners and admins do it and answers anyone else in a
/// sentence, which is carried forward as is. Granting someone already on the
/// project is harmless: the server keeps one row per person.
#[tauri::command]
pub async fn cloud_repo_member_add(repo_id: String, user_id: String) -> Result<(), String> {
    let repo_id = repo_id.trim().to_string();
    let user_id = user_id.trim().to_string();
    if repo_id.is_empty() || user_id.is_empty() {
        return Err("A project and a member are both required.".to_string());
    }
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !ok(&repo_id) || !ok(&user_id) {
        return Err("That project or member id isn't one the cloud gave out.".to_string());
    }
    let (token, _slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/repos/{repo_id}/members");
    let resp = http_client()?
        .post(&url)
        .bearer_auth(&token)
        .org_scoped()
        .json(&serde_json::json!({ "user_id": user_id, "role": "member" }))
        .send()
        .await
        .map_err(|e| format!("POST {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(server_message(status, &body));
    }
    Ok(())
}
