//! The GitHub accounts and organizations connected to the signed-in org, run
//! from Settings → Organization.
//!
//! Repositories inside a connected account can run on the org's cloud. Every
//! member can read the list; connecting and removing are an owner's or an
//! admin's, and the server refuses anyone else in its own words.
//!
//! Connecting is a round trip through GitHub: start a ticket, install the
//! app on the account (GitHub's own page picks the repositories), sign in to
//! GitHub so the server can see which accounts the admin may connect, then
//! connect one of those. The links come from the server and are checked here
//! before the renderer is handed them to open.

use reqwest::Method;
use serde_json::{json, Value};

use crate::cmd_cloud_admin::send;
use crate::cmd_cloud_members::signed_in_org;

/// What is connected, and whether the signed-in member may change it.
#[tauri::command]
pub async fn cloud_github_installations() -> Result<Value, String> {
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/github/installations");
    send(Method::GET, url, &token, None).await
}

/// Start connecting an account: a ticket, the app's install page and the
/// GitHub sign-in that finishes it.
#[tauri::command]
pub async fn cloud_github_connect_start() -> Result<Value, String> {
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/github/connect");
    let value = send(Method::POST, url, &token, Some(json!({}))).await?;
    started(&value)
}

/// What GitHub answered for a ticket: waiting, answered with the accounts the
/// admin may connect, refused, or expired.
#[tauri::command]
pub async fn cloud_github_connect_ticket(ticket: String) -> Result<Value, String> {
    let ticket = ticket_ok(&ticket)?;
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/github/connect/{ticket}");
    send(Method::GET, url, &token, None).await
}

/// Connect one of the accounts GitHub listed on the ticket.
#[tauri::command]
pub async fn cloud_github_connect(ticket: String, installation_id: i64) -> Result<Value, String> {
    let ticket = ticket_ok(&ticket)?;
    if installation_id <= 0 {
        return Err("Which GitHub account?".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/github/installations");
    send(Method::POST, url, &token, Some(json!({ "ticket": ticket, "installation_id": installation_id }))).await
}

/// Stop using a connected account. Its projects stay; nothing new is copied
/// through it. The app stays installed on GitHub until it is removed there.
#[tauri::command]
pub async fn cloud_github_remove(installation_id: i64) -> Result<(), String> {
    if installation_id <= 0 {
        return Err("Which GitHub account?".to_string());
    }
    let (token, slug, origin) = signed_in_org()?;
    let url = format!("{origin}/api/v2/orgs/{slug}/github/installations/{installation_id}");
    send(Method::DELETE, url, &token, None).await.map(|_| ())
}

/// A ticket is a UUID; nothing else goes into the path.
pub(crate) fn ticket_ok(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let shaped = (32..=36).contains(&t.len()) && t.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if shaped {
        Ok(t.to_ascii_lowercase())
    } else {
        Err("Start connecting again.".to_string())
    }
}

/// The start answer with only links that are safe to open: the install page
/// on github.com, and a sign-in on a web address.
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
    let install = value
        .get("install_url")
        .and_then(Value::as_str)
        .filter(|u| u.starts_with("https://github.com/apps/"));
    Ok(json!({
        "ticket": ticket,
        "install_url": install,
        "authorize_url": authorize,
        "expires_in_minutes": value.get("expires_in_minutes").cloned().unwrap_or(Value::Null),
    }))
}

pub(crate) fn web_link(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.0.0.1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_is_a_uuid_and_nothing_else() {
        assert_eq!(
            ticket_ok(" 0F8FAD5B-D9CB-469F-A165-70867728950E ").unwrap(),
            "0f8fad5b-d9cb-469f-a165-70867728950e"
        );
        assert!(ticket_ok("0f8fad5bd9cb469fa16570867728950e").is_ok());
        assert!(ticket_ok("../../orgs/other").is_err());
        assert!(ticket_ok("").is_err());
    }

    #[test]
    fn only_safe_links_are_handed_on() {
        let v = json!({
            "ticket": "0f8fad5b-d9cb-469f-a165-70867728950e",
            "install_url": "https://github.com/apps/aura/installations/new?state=ghlink-0f8f",
            "authorize_url": "https://auravcs.com/github/authorize?state=ghlink-0f8f",
            "expires_in_minutes": 30,
        });
        let s = started(&v).unwrap();
        assert_eq!(s["install_url"], "https://github.com/apps/aura/installations/new?state=ghlink-0f8f");
        assert_eq!(s["expires_in_minutes"], 30);

        let elsewhere = json!({
            "ticket": "0f8fad5b-d9cb-469f-a165-70867728950e",
            "install_url": "https://evil.example/apps/aura",
            "authorize_url": "https://auravcs.com/github/authorize?state=x",
        });
        assert_eq!(started(&elsewhere).unwrap()["install_url"], Value::Null);

        let script = json!({ "ticket": "0f8fad5b-d9cb-469f-a165-70867728950e", "authorize_url": "javascript:alert(1)" });
        assert!(started(&script).is_err());
        assert!(started(&json!({ "authorize_url": "https://auravcs.com" })).is_err());
    }
}
