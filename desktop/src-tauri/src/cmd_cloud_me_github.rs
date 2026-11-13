//! Your own GitHub, run from Settings → Git → Your GitHub.
//!
//! Pushes, commits and pull requests made in a cloud workspace go out as the
//! member who made them, with the GitHub account they connect here, so the
//! server keeps one GitHub sign-in per member (sealed, and refreshed before it
//! runs out). Connecting is a GitHub sign-in in the browser: start a ticket,
//! open the sign-in it names, and read the ticket until GitHub has answered.
//!
//! The renderer never sees the GitHub token; it sees who is connected and the
//! repositories that account can open inside the org's connected GitHub.

use reqwest::Method;
use serde_json::{json, Value};

use crate::cmd_cloud_admin::{send, signed_in};
use crate::cmd_cloud_github::{ticket_ok, web_link};
use crate::cmd_cloud_members::signed_in_org;

/// Whether the signed-in member has a GitHub connected, and as whom.
#[tauri::command]
pub async fn cloud_my_github() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    send(Method::GET, format!("{origin}/api/v2/me/github"), &token, None).await
}

/// Start connecting: a ticket and the GitHub sign-in that answers it.
#[tauri::command]
pub async fn cloud_my_github_connect_start() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    let value = send(Method::POST, format!("{origin}/api/v2/me/github/connect"), &token, Some(json!({}))).await?;
    started(&value)
}

/// What GitHub answered for a ticket: waiting, connected, refused or expired.
#[tauri::command]
pub async fn cloud_my_github_connect_ticket(ticket: String) -> Result<Value, String> {
    let ticket = ticket_ok(&ticket)?;
    let (token, origin) = signed_in()?;
    send(Method::GET, format!("{origin}/api/v2/me/github/connect/{ticket}"), &token, None).await
}

/// Stop using the connected GitHub: the server forgets the sign-in and asks
/// GitHub to revoke it. Pushes from cloud workspaces stop until reconnected.
#[tauri::command]
pub async fn cloud_my_github_disconnect() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    send(Method::DELETE, format!("{origin}/api/v2/me/github"), &token, None).await
}

/// The repositories the member's own GitHub can open inside the signed-in
/// org's connected GitHub accounts, and whether they may push to each.
#[tauri::command]
pub async fn cloud_my_github_repos() -> Result<Value, String> {
    let (token, slug, origin) = signed_in_org()?;
    send(Method::GET, format!("{origin}/api/v2/orgs/{slug}/github/mine"), &token, None).await
}

/// The start answer with only a sign-in link that is safe to open.
fn started(value: &Value) -> Result<Value, String> {
    let ticket = value
        .get("ticket")
        .and_then(Value::as_str)
        .ok_or_else(|| "The server didn't start connecting.".to_string())
        .and_then(ticket_ok)?;
    let authorize = value
        .get("authorize_url")
        .and_then(Value::as_str)
        .filter(|u| web_link(u))
        .ok_or_else(|| "The server didn't say where to sign in to GitHub.".to_string())?;
    Ok(json!({
        "ticket": ticket,
        "authorize_url": authorize,
        "expires_in_minutes": value.get("expires_in_minutes").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_hands_on_a_checked_ticket_and_sign_in() {
        let v = json!({
            "ticket": "0F8FAD5B-D9CB-469F-A165-70867728950E",
            "authorize_url": "https://auravcs.com/github/authorize?state=ghme-0f8f",
            "expires_in_minutes": 15,
            "extra": "dropped",
        });
        let s = started(&v).unwrap();
        assert_eq!(s["ticket"], "0f8fad5b-d9cb-469f-a165-70867728950e");
        assert_eq!(s["authorize_url"], "https://auravcs.com/github/authorize?state=ghme-0f8f");
        assert_eq!(s["expires_in_minutes"], 15);
        assert!(s.get("extra").is_none());
    }

    #[test]
    fn a_start_with_an_unsafe_link_or_ticket_is_refused() {
        let script = json!({ "ticket": "0f8fad5b-d9cb-469f-a165-70867728950e", "authorize_url": "javascript:alert(1)" });
        assert!(started(&script).is_err());
        let file = json!({ "ticket": "0f8fad5b-d9cb-469f-a165-70867728950e", "authorize_url": "file:///etc/passwd" });
        assert!(started(&file).is_err());
        let path = json!({ "ticket": "../../orgs/x", "authorize_url": "https://auravcs.com/github/authorize" });
        assert!(started(&path).is_err());
        assert!(started(&json!({})).is_err());
    }
}
