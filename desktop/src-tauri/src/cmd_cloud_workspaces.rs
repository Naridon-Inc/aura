//! The cloud's own workspaces and routines, read and written for the desktop.
//!
//! These are the `/api/v2/public/...` routes the CLI and agents already use:
//! a cloud workspace is a session row the server keeps, a routine is a saved
//! prompt plus the schedule or webhook that starts it. The desktop proxies the
//! calls rather than handing the renderer the token, the same way billing does.
//!
//! What these commands do *not* do is run anything. Creating a workspace
//! queues its first prompt; a connected runner (or a desktop's cloud inbox)
//! picks it up. The UI says so instead of implying the server works on it.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;

use crate::cloud_org::OrgScoped;
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

const PUBLIC: &str = "/api/v2/public";

#[derive(Clone, Copy)]
pub(crate) enum Verb {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Verb {
    fn word(self) -> &'static str {
        match self {
            Verb::Get => "GET",
            Verb::Post => "POST",
            Verb::Put => "PUT",
            Verb::Patch => "PATCH",
            Verb::Delete => "DELETE",
        }
    }
}

/// One signed-in call to the public API, answered as JSON.
///
/// A non-2xx comes back as `HTTP <status>: <body>` so the renderer can tell a
/// plan refusal (403 `upgrade_required`) from a missing route (404 on an older
/// server) and say which it was.
async fn call(verb: Verb, path: &str, body: Option<Value>) -> Result<Value, String> {
    call_at(verb, &format!("{PUBLIC}{path}"), body).await
}

/// The same signed call, to any `/api/...` path on the cloud — for the reads
/// the public routes don't carry yet.
pub(crate) async fn call_at(verb: Verb, api_path: &str, body: Option<Value>) -> Result<Value, String> {
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds).ok_or_else(|| "no cloud_api_token".to_string())?;
    let origin = cloud_origin(&creds);
    let url = format!("{origin}{api_path}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client build: {e}"))?;

    let req = match verb {
        Verb::Get => client.get(&url),
        Verb::Post => client.post(&url),
        Verb::Put => client.put(&url),
        Verb::Patch => client.patch(&url),
        Verb::Delete => client.delete(&url),
    };
    let req = req.bearer_auth(&token).org_scoped();
    let req = match body {
        Some(b) => req.json(&b),
        None => req,
    };
    let resp = req
        .send()
        .await
        .map_err(|e| format!("{} {url}: {e}", verb.word()))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(&text).map_err(|e| format!("parse: {e}"))
}

/// Ids go into the path, so only the characters an id is made of get in.
pub(crate) fn path_id(id: &str) -> Result<&str, String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id)
    } else {
        Err(format!("not an id: {id:?}"))
    }
}

/// A trimmed string, or nothing — an empty field is "not given", not "".
fn put(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(v) = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        map.insert(key.to_string(), Value::String(v));
    }
}

/// GET /public/workspaces — the caller's cloud workspaces, newest activity first.
#[tauri::command]
pub async fn cloud_workspaces_list(status: Option<String>) -> Result<Value, String> {
    call(Verb::Get, &workspaces_list_path(status.as_deref())?, None).await
}

/// The listing's path. Always `origin=cloud`: the same table holds every
/// agent session a laptop heartbeats, and those belong to the laptop's own
/// place, not the cloud's. The server narrows before its 200-row cap, which
/// is why this is asked for rather than filtered here — a server that
/// predates the parameter ignores it, and the place filters what comes back
/// by the rows' own `origin`/`source` (`cloudRows.isCloudWork`).
fn workspaces_list_path(status: Option<&str>) -> Result<String, String> {
    match status.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.chars().all(|c| c.is_ascii_lowercase()) => {
            Ok(format!("/workspaces?status={s}&origin=cloud"))
        }
        Some(s) => Err(format!("not a status: {s:?}")),
        None => Ok("/workspaces?origin=cloud".to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct NewWorkspace {
    pub objective: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub intent: Option<String>,
    /// `organization` or `restricted`; left out, the server's default
    /// (`organization`).
    #[serde(default)]
    pub access: Option<String>,
}

/// POST /public/workspaces — open a cloud workspace and queue its first prompt.
#[tauri::command]
pub async fn cloud_workspace_create(draft: NewWorkspace) -> Result<Value, String> {
    call(Verb::Post, "/workspaces", Some(Value::Object(create_body(draft)))).await
}

fn create_body(draft: NewWorkspace) -> Map<String, Value> {
    let mut body = Map::new();
    put(&mut body, "objective", draft.objective);
    put(&mut body, "repo", draft.repo);
    put(&mut body, "branch", draft.branch);
    put(&mut body, "prompt", draft.prompt);
    put(&mut body, "model", draft.model);
    put(&mut body, "intent", draft.intent);
    put(&mut body, "access", draft.access);
    body.insert("agent".into(), Value::String("aura@desktop".into()));
    body
}

/// GET /api/v2/repos/pulls — a project's open pull requests, for starting a
/// workspace from one. Each row says whether its branch lives in the project
/// or in someone else's copy of it.
#[tauri::command]
pub async fn cloud_repo_open_pulls(repo: String) -> Result<Value, String> {
    call_at(Verb::Get, &repo_pulls_path(&repo)?, None).await
}

/// `owner/name` only: the name goes into the query string as it is.
fn repo_pulls_path(repo: &str) -> Result<String, String> {
    let repo = repo.trim();
    let mut parts = repo.split('/');
    let ok = matches!((parts.next(), parts.next(), parts.next()), (Some(o), Some(n), None)
        if [o, n].iter().all(|p| !p.is_empty() && *p != "." && *p != ".."
            && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))));
    if ok {
        Ok(format!("/api/v2/repos/pulls?repo={repo}"))
    } else {
        Err(format!("not a GitHub repository: {repo:?}"))
    }
}

/// POST /public/workspaces/{id}/{sleep|archive} — park or close a workspace.
#[tauri::command]
pub async fn cloud_workspace_set_state(id: String, state: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    let action = match state.as_str() {
        "sleep" | "archive" => state.as_str(),
        other => return Err(format!("not a workspace action: {other:?}")),
    };
    call(Verb::Post, &format!("/workspaces/{id}/{action}"), None).await
}

/// POST /public/workspaces/{id}/rename.
#[tauri::command]
pub async fn cloud_workspace_rename(id: String, name: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("a workspace needs a name".into());
    }
    call(
        Verb::Post,
        &format!("/workspaces/{id}/rename"),
        Some(json!({ "name": name })),
    )
    .await
}

/// GET /public/workspaces/{id}/messages — the conversation, oldest first.
#[tauri::command]
pub async fn cloud_workspace_messages(id: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    call(Verb::Get, &format!("/workspaces/{id}/messages"), None).await
}

/// GET /sessions/{id}/changes — every file the workspace's own commits
/// touched, with each one's churn. A cloud workspace is a session (its id is
/// the session's), so this is the list the console's Changes pane shows. A
/// workspace with no commits yet, or no GitHub lane to read them through,
/// answers an empty list and a named `reason` rather than an error.
#[tauri::command]
pub async fn cloud_workspace_changes(id: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    call_at(Verb::Get, &format!("/api/v2/sessions/{id}/changes"), None).await
}

/// POST /public/workspaces/{id}/prompt — send the next turn.
#[tauri::command]
pub async fn cloud_workspace_prompt(
    id: String,
    text: String,
    model: Option<String>,
) -> Result<Value, String> {
    let id = path_id(&id)?;
    if text.trim().is_empty() {
        return Err("nothing to send".into());
    }
    let mut body = Map::new();
    body.insert("text".into(), Value::String(text));
    put(&mut body, "model", model);
    call(
        Verb::Post,
        &format!("/workspaces/{id}/prompt"),
        Some(Value::Object(body)),
    )
    .await
}

/// GET /public/models — the models a workspace's agent can run, and whether
/// the caller is signed in to that agent here.
#[tauri::command]
pub async fn cloud_public_models() -> Result<Value, String> {
    call(Verb::Get, "/models", None).await
}

/// GET /public/routines — the caller's own routines in this org.
#[tauri::command]
pub async fn cloud_routines_list() -> Result<Value, String> {
    call(Verb::Get, "/routines", None).await
}

#[derive(Debug, Deserialize)]
pub struct RoutineTrigger {
    pub kind: String,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Deserialize)]
pub struct NewRoutine {
    pub name: String,
    pub prompt: String,
    pub repo: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub enabled: Option<bool>,
    #[serde(default)]
    pub triggers: Vec<RoutineTrigger>,
}

/// POST /public/routines — save a new routine. The reply carries the webhook
/// secret once, when the routine has a webhook trigger.
#[tauri::command]
pub async fn cloud_routine_create(routine: NewRoutine) -> Result<Value, String> {
    let mut body = Map::new();
    let name = routine.name.trim();
    let prompt = routine.prompt.trim();
    if name.is_empty() || prompt.is_empty() {
        return Err("a routine needs a name and a prompt".into());
    }
    body.insert("name".into(), Value::String(name.into()));
    body.insert("prompt".into(), Value::String(prompt.into()));
    put(&mut body, "repo", routine.repo);
    put(&mut body, "model", routine.model);
    put(&mut body, "effort", routine.effort);
    if let Some(enabled) = routine.enabled {
        body.insert("enabled".into(), Value::Bool(enabled));
    }
    let triggers: Vec<Value> = routine
        .triggers
        .into_iter()
        .filter(|t| t.kind == "schedule" || t.kind == "webhook")
        .map(|t| json!({ "kind": t.kind, "config": t.config }))
        .collect();
    body.insert("triggers".into(), Value::Array(triggers));
    call(Verb::Post, "/routines", Some(Value::Object(body))).await
}

/// DELETE /public/routines/{id}.
#[tauri::command]
pub async fn cloud_routine_delete(id: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    call(Verb::Delete, &format!("/routines/{id}"), None).await
}

/// POST /public/routines/{id}/run — start one run now.
#[tauri::command]
pub async fn cloud_routine_run(id: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    call(Verb::Post, &format!("/routines/{id}/run"), None).await
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_cloud_place_lists_only_cloud_work() {
        use super::workspaces_list_path;
        assert_eq!(workspaces_list_path(None).unwrap(), "/workspaces?origin=cloud");
        assert_eq!(workspaces_list_path(Some(" ")).unwrap(), "/workspaces?origin=cloud");
        assert_eq!(
            workspaces_list_path(Some("archived")).unwrap(),
            "/workspaces?status=archived&origin=cloud"
        );
        assert!(workspaces_list_path(Some("running&origin=all")).is_err());
    }

    use super::*;

    #[test]
    fn only_an_owner_and_a_name_reach_the_pull_request_listing() {
        assert_eq!(repo_pulls_path(" acme/app ").unwrap(), "/api/v2/repos/pulls?repo=acme/app");
        for bad in ["acme", "acme/app/x", "../x", "acme/a&b=c", "acme/", "acme/.."] {
            assert!(repo_pulls_path(bad).is_err(), "{bad} got through");
        }
    }

    #[test]
    fn ids_are_only_id_characters() {
        assert!(path_id("3f1c-9a_b").is_ok());
        assert!(path_id("").is_err());
        assert!(path_id("../billing").is_err());
        assert!(path_id("a?b=c").is_err());
        assert!(path_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn blank_fields_are_left_out() {
        let mut m = Map::new();
        put(&mut m, "repo", Some("  ".into()));
        put(&mut m, "branch", None);
        put(&mut m, "model", Some(" sonnet ".into()));
        assert_eq!(Value::Object(m), json!({ "model": "sonnet" }));
    }

    #[test]
    fn a_private_choice_reaches_the_server_and_no_choice_is_left_out() {
        let draft: NewWorkspace = serde_json::from_value(json!({
            "objective": "Onboarding", "prompt": "Sketch it", "access": "restricted",
        }))
        .unwrap();
        assert_eq!(create_body(draft).get("access"), Some(&json!("restricted")));
        let draft: NewWorkspace =
            serde_json::from_value(json!({ "objective": "Onboarding", "prompt": "Sketch it" }))
                .unwrap();
        assert!(!create_body(draft).contains_key("access"));
    }
}
