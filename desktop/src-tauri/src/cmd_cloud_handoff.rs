//! Handing a cloud workspace on: to a teammate, and to review as a pull
//! request.
//!
//! The same `/api/v2/public/...` proxy as `cmd_cloud_workspaces` — the
//! renderer never holds the token, and GitHub is asked by the server with the
//! org's App installation, so nothing here holds a GitHub credential either.
//! Bodies and paths are built by pure functions, so a malformed id or branch
//! never reaches the server and the shapes are tested without a network.

use serde_json::{json, Value};

use crate::cmd_cloud_workspaces::{call_at, path_id, Verb};

const PUBLIC: &str = "/api/v2/public";

async fn call(verb: Verb, path: &str, body: Option<Value>) -> Result<Value, String> {
    call_at(verb, &format!("{PUBLIC}{path}"), body).await
}

/// A branch the server is asked about, or none. The server checks it again;
/// this keeps an obviously wrong one from becoming a request at all.
fn branch_of(branch: Option<&str>) -> Option<String> {
    branch
        .map(str::trim)
        .filter(|b| !b.is_empty() && b.len() <= 255 && !b.chars().any(char::is_whitespace))
        .map(str::to_string)
}

fn pull_request_path(id: &str, branch: Option<&str>) -> Result<String, String> {
    let id = path_id(id)?;
    let mut url = url::Url::parse("http://x/").map_err(|e| e.to_string())?;
    url.set_path(&format!("/workspaces/{id}/pull-request"));
    if let Some(b) = branch_of(branch) {
        url.query_pairs_mut().append_pair("branch", &b);
    }
    Ok(match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_string(),
    })
}

fn create_body(title: Option<&str>, draft: bool, branch: Option<&str>) -> Value {
    json!({
        "title": title.map(str::trim).filter(|t| !t.is_empty()),
        "draft": draft,
        "branch": branch_of(branch),
    })
}

/// POST /public/workspaces/{id}/owner — hand the workspace to a teammate.
#[tauri::command]
pub async fn cloud_workspace_reassign(id: String, user_id: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    let user = path_id(user_id.trim())?;
    call(Verb::Post, &format!("/workspaces/{id}/owner"), Some(json!({ "user_id": user }))).await
}

/// GET /public/workspaces/{id}/pull-request.
#[tauri::command]
pub async fn cloud_workspace_pull_request(
    id: String,
    branch: Option<String>,
) -> Result<Value, String> {
    call(Verb::Get, &pull_request_path(&id, branch.as_deref())?, None).await
}

/// POST /public/workspaces/{id}/pull-request — open one.
#[tauri::command]
pub async fn cloud_workspace_pull_request_create(
    id: String,
    title: Option<String>,
    draft: bool,
    branch: Option<String>,
) -> Result<Value, String> {
    let id = path_id(&id)?;
    let body = create_body(title.as_deref(), draft, branch.as_deref());
    call(Verb::Post, &format!("/workspaces/{id}/pull-request"), Some(body)).await
}

/// POST /public/workspaces/{id}/pull-request/ready — out of draft.
#[tauri::command]
pub async fn cloud_workspace_pull_request_ready(
    id: String,
    branch: Option<String>,
) -> Result<Value, String> {
    let id = path_id(&id)?;
    let body = json!({ "branch": branch_of(branch.as_deref()) });
    call(Verb::Post, &format!("/workspaces/{id}/pull-request/ready"), Some(body)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_branch_rides_as_an_encoded_query() {
        assert_eq!(
            pull_request_path("ws_1", Some("feat/a#b")).unwrap(),
            "/workspaces/ws_1/pull-request?branch=feat%2Fa%23b"
        );
        assert_eq!(pull_request_path("ws_1", None).unwrap(), "/workspaces/ws_1/pull-request");
        assert_eq!(
            pull_request_path("ws_1", Some("  ")).unwrap(),
            "/workspaces/ws_1/pull-request"
        );
        assert!(pull_request_path("../x", None).is_err());
    }

    #[test]
    fn a_create_body_drops_what_was_not_given() {
        assert_eq!(
            create_body(Some("  "), true, Some("bad branch")),
            json!({ "title": null, "draft": true, "branch": null })
        );
        assert_eq!(
            create_body(Some("Fix it"), false, Some("feat/x")),
            json!({ "title": "Fix it", "draft": false, "branch": "feat/x" })
        );
    }
}
