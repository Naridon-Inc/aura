//! The computer Aura runs for a team: what the plan includes, starting it,
//! changing its size, and waking it. It comes with Pro and Teams; there is
//! nothing to buy on its own.
//!
//! Requests to `/api/v2/computers` on the signed-in token, org-scoped by
//! header. The server owns every decision — whether the plan includes one,
//! who may change its size, whether the machine can be woken — and every
//! sentence a person reads about the computer (`headline`, `problem`, the
//! offer's `reason`), so these commands only carry the answer across.

use reqwest::Method;
use serde_json::{json, Value};

use crate::cloud_org::OrgScoped;
use crate::cmd_cloud_admin::{send, signed_in};
use crate::cmd_cloud_members::{http_client, server_message};

fn computers(origin: &str, action: &str) -> String {
    let base = format!("{}/api/v2/computers", origin.trim_end_matches('/'));
    if action.is_empty() {
        base
    } else {
        format!("{base}/{action}")
    }
}

/// What the screen is drawn from. A server from before computers existed has
/// no such route and answers a bare 404; that is "nothing on offer here", not
/// a failure, so it comes back as an answer with no offer in it.
fn status_answer(status: reqwest::StatusCode, body: &str) -> Result<Value, String> {
    if status == reqwest::StatusCode::NOT_FOUND && body.trim().is_empty() {
        return Ok(json!({ "offer": null, "computer": null, "ended": null }));
    }
    if !status.is_success() {
        return Err(server_message(status, body));
    }
    let value: Value = serde_json::from_str(body).map_err(|e| format!("parse: {e}"))?;
    if !value.get("offer").is_some_and(Value::is_object) {
        return Err("Aura Cloud answered, but not about computers.".to_string());
    }
    Ok(value)
}

/// The offer, the team's computer if it has one, and the last one that ended.
#[tauri::command]
pub async fn aura_computer_status() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    let url = computers(&origin, "");
    let resp = http_client()?
        .get(&url)
        .bearer_auth(&token)
        .org_scoped()
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    status_answer(status, &body)
}

/// Start the computer the plan includes, for an org that paid before plans
/// came with one. Owners and admins only; the server says so otherwise.
#[tauri::command]
pub async fn aura_computer_start() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    send(Method::POST, computers(&origin, "start"), &token, None).await
}

/// The size a computer can be asked for: an instance type from the server's
/// own list, which the server checks again.
fn size_ok(size: &str) -> Result<&str, String> {
    let s = size.trim();
    if s.is_empty() || s.len() > 32 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.') {
        return Err("Which size?".to_string());
    }
    Ok(s)
}

/// Change its size. The bill changes now; the machine at its next wake.
#[tauri::command]
pub async fn aura_computer_resize(size: String) -> Result<Value, String> {
    let size = size_ok(&size)?.to_string();
    let (token, origin) = signed_in()?;
    send(Method::POST, computers(&origin, "size"), &token, Some(json!({ "size": size }))).await
}

/// Wake it. Sending it a chat does the same; this is the button for when
/// somebody wants it up before they have anything to say.
#[tauri::command]
pub async fn aura_computer_wake() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    send(Method::POST, computers(&origin, "wake"), &token, None).await
}

/// Try again after it failed to come up.
#[tauri::command]
pub async fn aura_computer_retry() -> Result<Value, String> {
    let (token, origin) = signed_in()?;
    send(Method::POST, computers(&origin, "retry"), &token, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::StatusCode;

    #[test]
    fn every_route_hangs_off_one_base() {
        assert_eq!(computers("https://auravcs.com/", ""), "https://auravcs.com/api/v2/computers");
        assert_eq!(computers("https://auravcs.com", "wake"), "https://auravcs.com/api/v2/computers/wake");
    }

    #[test]
    fn a_server_without_computers_offers_nothing_rather_than_failing() {
        let v = status_answer(StatusCode::NOT_FOUND, "").unwrap();
        assert!(v["offer"].is_null());
        assert!(v["computer"].is_null());
    }

    #[test]
    fn a_refusal_is_the_servers_sentence() {
        let err = status_answer(StatusCode::FORBIDDEN, r#"{"error":"You're not in this team."}"#).unwrap_err();
        assert_eq!(err, "You're not in this team.");
        // A 404 that says something is a real answer, not a missing route.
        let err = status_answer(StatusCode::NOT_FOUND, r#"{"error":"No such team."}"#).unwrap_err();
        assert_eq!(err, "No such team.");
    }

    #[test]
    fn the_answer_must_be_about_computers() {
        let ok = status_answer(StatusCode::OK, r#"{"offer":{"available":true},"computer":null,"ended":null}"#).unwrap();
        assert_eq!(ok["offer"]["available"], true);
        assert!(status_answer(StatusCode::OK, r#"{"plan":"pro"}"#).is_err());
        assert!(status_answer(StatusCode::OK, "<html>").is_err());
    }

    #[test]
    fn a_size_is_an_instance_type_and_nothing_else() {
        assert_eq!(size_ok(" m7g.2xlarge ").unwrap(), "m7g.2xlarge");
        assert!(size_ok("").is_err());
        assert!(size_ok("m7g.2xlarge&size=x").is_err());
        assert!(size_ok("../../wake").is_err());
    }
}
