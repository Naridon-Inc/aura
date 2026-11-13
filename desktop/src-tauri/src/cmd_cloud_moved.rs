//! Tell the cloud a workspace moved to this computer.
//!
//! Bringing a cloud workspace home copies its branch and its conversation onto
//! this laptop. The cloud's machine must then stop answering prompts on it, or
//! two agents would push the same branch. [`cloud_workspace_moved`] is the call
//! that says so: the server unlinks the machine, retires waiting leases and
//! records where the work went (`aura-cloud`'s `public_workspace_moved`).
//!
//! It carries a display name for this computer and the branch, nothing that
//! says how to reach either.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::cmd_cloud_workspaces::{call_at, path_id, Verb};

const WORKSPACES: &str = "/api/v2/public/workspaces";

/// Where the workspace went.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovedHere {
    /// How this computer is shown to the team ("Mo's MacBook").
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

fn moved_body(m: &MovedHere) -> Value {
    let mut body = Map::new();
    body.insert("to".into(), json!("local"));
    for (k, v) in [("name", &m.name), ("branch", &m.branch)] {
        if let Some(v) = v.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            body.insert(k.into(), json!(v));
        }
    }
    Value::Object(body)
}

/// POST /public/workspaces/{id}/moved
#[tauri::command]
pub async fn cloud_workspace_moved(id: String, moved: MovedHere) -> Result<Value, String> {
    let id = path_id(&id)?;
    call_at(Verb::Post, &format!("{WORKSPACES}/{id}/moved"), Some(moved_body(&moved))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_says_local_and_leaves_blanks_out() {
        let full = moved_body(&MovedHere { name: Some(" Mo's MacBook ".into()), branch: Some("feat/x".into()) });
        assert_eq!(full, json!({ "to": "local", "name": "Mo's MacBook", "branch": "feat/x" }));
        let bare = moved_body(&MovedHere { name: Some("  ".into()), branch: None });
        assert_eq!(bare, json!({ "to": "local" }));
    }
}
