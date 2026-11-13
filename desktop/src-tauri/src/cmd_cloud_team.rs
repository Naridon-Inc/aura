//! Who else is in a cloud workspace: sharing, following, mentions, presence.
//!
//! The same `/api/v2/public/...` proxy as `cmd_cloud_workspaces` — the
//! renderer never holds the token — for the routes that make a workspace a
//! place several people are in. Each body is built and checked here, by a
//! pure function, so a malformed id or level never reaches the server and the
//! shapes are tested without a network.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::cmd_cloud_workspaces::{call_at, path_id, Verb};

const PUBLIC: &str = "/api/v2/public";

async fn call(verb: Verb, path: &str, body: Option<Value>) -> Result<Value, String> {
    call_at(verb, &format!("{PUBLIC}{path}"), body).await
}

/// One person invited to a workspace, as the share popover sends it.
#[derive(Debug, Deserialize)]
pub struct Grant {
    pub user_id: String,
    pub level: String,
}

/// The access body: who may open it, and the people invited.
fn access_body(general: &str, grants: &[Grant]) -> Result<Value, String> {
    let general = general.trim();
    if general != "organization" && general != "restricted" {
        return Err(format!("not an access setting: {general:?}"));
    }
    let mut out = Vec::with_capacity(grants.len());
    for g in grants {
        let level = g.level.trim().to_ascii_lowercase();
        if level != "read" && level != "write" {
            return Err(format!("not an access level: {:?}", g.level));
        }
        out.push(json!({ "user_id": path_id(g.user_id.trim())?, "level": level }));
    }
    Ok(json!({ "general": general, "grants": out }))
}

/// The presence beacon. The workspace is only named when there is one;
/// typing without a workspace means nothing and is dropped.
fn beacon_body(viewing: Option<&str>, typing: bool, idle_ms: u64) -> Result<Value, String> {
    let viewing = match viewing.map(str::trim).filter(|v| !v.is_empty()) {
        Some(id) => Some(path_id(id)?.to_string()),
        None => None,
    };
    Ok(json!({
        "viewing_workspace_id": viewing,
        "typing": typing && viewing.is_some(),
        "idle_ms": idle_ms,
    }))
}

fn mentions_path(unread: bool, limit: Option<u32>) -> String {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    format!("/mentions?unread={unread}&limit={limit}")
}

/// PUT /public/presence — "I'm here, looking at this, typing or not".
#[tauri::command]
pub async fn cloud_presence_beacon(
    viewing: Option<String>,
    typing: bool,
    idle_ms: u64,
) -> Result<Value, String> {
    let body = beacon_body(viewing.as_deref(), typing, idle_ms)?;
    call(Verb::Put, "/presence", Some(body)).await
}

/// GET /public/presence — everyone online in the org.
#[tauri::command]
pub async fn cloud_presence_list() -> Result<Value, String> {
    call(Verb::Get, "/presence", None).await
}

/// GET /public/workspaces/{id}/access.
#[tauri::command]
pub async fn cloud_workspace_access(id: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    call(Verb::Get, &format!("/workspaces/{id}/access"), None).await
}

/// PUT /public/workspaces/{id}/access.
#[tauri::command]
pub async fn cloud_workspace_access_set(
    id: String,
    general: String,
    grants: Vec<Grant>,
) -> Result<Value, String> {
    let id = path_id(&id)?;
    let body = access_body(&general, &grants)?;
    call(Verb::Put, &format!("/workspaces/{id}/access"), Some(body)).await
}

/// POST or DELETE /public/workspaces/{id}/follow.
#[tauri::command]
pub async fn cloud_workspace_follow(id: String, follow: bool) -> Result<Value, String> {
    let id = path_id(&id)?;
    let verb = if follow { Verb::Post } else { Verb::Delete };
    call(verb, &format!("/workspaces/{id}/follow"), None).await
}

/// GET /public/following — ids of the workspaces I follow.
#[tauri::command]
pub async fn cloud_following() -> Result<Value, String> {
    call(Verb::Get, "/following", None).await
}

/// GET /public/mentions.
#[tauri::command]
pub async fn cloud_mentions(unread: bool, limit: Option<u32>) -> Result<Value, String> {
    call(Verb::Get, &mentions_path(unread, limit), None).await
}

/// POST /public/mentions/read — the ids given, or every one of mine when empty.
#[tauri::command]
pub async fn cloud_mentions_read(ids: Vec<String>) -> Result<Value, String> {
    let ids = ids
        .iter()
        .map(|i| path_id(i.trim()).map(str::to_string))
        .collect::<Result<Vec<_>, _>>()?;
    call(Verb::Post, "/mentions/read", Some(json!({ "ids": ids }))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grant(user_id: &str, level: &str) -> Grant {
        Grant { user_id: user_id.into(), level: level.into() }
    }

    #[test]
    fn access_body_carries_the_setting_and_lowercased_levels() {
        let id = "6a1f0e9c-1b2d-4c3e-8f40-5a6b7c8d9e0f";
        let body = access_body("restricted", &[grant(id, "Write")]).unwrap();
        assert_eq!(
            body,
            json!({ "general": "restricted", "grants": [{ "user_id": id, "level": "write" }] })
        );
    }

    #[test]
    fn access_body_refuses_what_the_server_would() {
        assert!(access_body("public", &[]).is_err());
        assert!(access_body("restricted", &[grant("u1", "admin")]).is_err());
        assert!(access_body("restricted", &[grant("../x", "read")]).is_err());
    }

    #[test]
    fn a_beacon_only_types_inside_a_workspace() {
        let b = beacon_body(None, true, 5).unwrap();
        assert_eq!(b, json!({ "viewing_workspace_id": null, "typing": false, "idle_ms": 5 }));
        let b = beacon_body(Some(" ws_1 "), true, 0).unwrap();
        assert_eq!(b["viewing_workspace_id"], "ws_1");
        assert_eq!(b["typing"], true);
        assert!(beacon_body(Some("a/b"), false, 0).is_err());
    }

    #[test]
    fn mentions_path_bounds_the_page() {
        assert_eq!(mentions_path(true, None), "/mentions?unread=true&limit=50");
        assert_eq!(mentions_path(false, Some(0)), "/mentions?unread=false&limit=1");
        assert_eq!(mentions_path(false, Some(999)), "/mentions?unread=false&limit=200");
    }
}
