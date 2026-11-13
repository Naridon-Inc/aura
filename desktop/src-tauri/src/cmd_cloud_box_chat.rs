//! A cloud workspace whose chat runs on one of the org's machines.
//!
//! The row stays the shared record; these are the calls that tie it to the
//! machine. [`cloud_box_link`] says where the chat runs (and which of the org's
//! places that is, so the member's sign-in can be lent to it and nowhere else),
//! [`cloud_box_lease`] asks for that one-time lease, [`cloud_box_turn`] keeps a
//! finished turn on the log, and [`post_events`] relays what the agent is doing
//! right now to everyone watching.
//!
//! None of these carry a host, a login or a key: those stay in this laptop's
//! machine book. The lease is ids only; the sign-in itself goes from the cloud
//! to the machine and never through here.

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::cmd_cloud_workspaces::{call_at, path_id, Verb};

const WORKSPACES: &str = "/api/v2/public/workspaces";

/// Where a workspace's chat runs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxLink {
    pub machine: String,
    pub remote_root: String,
    #[serde(default)]
    pub branch: Option<String>,
    pub engine: String,
    #[serde(default)]
    pub agent_session_id: Option<String>,
    #[serde(default)]
    pub place_id: Option<String>,
    /// `"box"`: the computer answers each prompt by itself, on the sign-in of
    /// whoever sent it. Left out: a laptop drives the chat over its own link.
    #[serde(default)]
    pub driver: Option<String>,
}

/// The one driver a link can name.
const DRIVER_BOX: &str = "box";

fn link_body(link: &BoxLink) -> Result<Value, String> {
    let mut body = Map::new();
    body.insert("machine".into(), json!(link.machine.trim()));
    body.insert("remote_root".into(), json!(link.remote_root.trim()));
    body.insert("engine".into(), json!(link.engine.trim()));
    for (k, v) in [("branch", &link.branch), ("agent_session_id", &link.agent_session_id)] {
        if let Some(v) = v.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            body.insert(k.into(), json!(v));
        }
    }
    if let Some(p) = link.place_id.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        let p = uuid::Uuid::parse_str(p).map_err(|_| format!("not a place id: {p:?}"))?;
        body.insert("place_id".into(), json!(p.to_string()));
    }
    match link.driver.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        None => {}
        Some(DRIVER_BOX) if body.contains_key("place_id") => {
            body.insert("driver".into(), json!(DRIVER_BOX));
        }
        Some(DRIVER_BOX) => return Err("a computer answers by itself only when it is one of the team's places".into()),
        Some(d) => return Err(format!("not a driver: {d:?}")),
    }
    Ok(Value::Object(body))
}

/// PUT /public/workspaces/{id}/place
#[tauri::command]
pub async fn cloud_box_link(id: String, link: BoxLink) -> Result<Value, String> {
    let id = path_id(&id)?;
    call_at(Verb::Put, &format!("{WORKSPACES}/{id}/place"), Some(link_body(&link)?)).await
}

/// POST /public/workspaces/{id}/chat-lease — a one-time lease for this
/// member's own sign-in, for the machine the workspace is linked to.
#[tauri::command]
pub async fn cloud_box_lease(id: String, harness: String) -> Result<Value, String> {
    let id = path_id(&id)?;
    call_at(Verb::Post, &format!("{WORKSPACES}/{id}/chat-lease"), Some(json!({ "harness": harness.trim() }))).await
}

/// POST /public/workspaces/{id}/turns — one finished turn onto the shared log.
#[tauri::command]
pub async fn cloud_box_turn(
    id: String,
    role: String,
    text: String,
    message_id: String,
    author_name: Option<String>,
) -> Result<Value, String> {
    let id = path_id(&id)?;
    if text.trim().is_empty() {
        return Err("nothing to keep".into());
    }
    let mut body = json!({ "role": role, "text": text, "message_id": message_id });
    if let Some(n) = author_name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        body["author_name"] = json!(n);
    }
    call_at(Verb::Post, &format!("{WORKSPACES}/{id}/turns"), Some(body)).await
}

/// One agent-protocol message, as viewers are shown it.
pub fn event(seq: u64, acp_session_id: &str, kind: &str, payload: Value) -> Value {
    json!({ "seq": seq, "acp_session_id": acp_session_id, "kind": kind, "payload": payload })
}

/// POST /public/workspaces/{id}/events — what the agent is doing, live.
pub async fn post_events(id: &str, events: Vec<Value>) -> Result<Value, String> {
    let id = path_id(id)?;
    if events.is_empty() {
        return Ok(Value::Null);
    }
    call_at(Verb::Post, &format!("{WORKSPACES}/{id}/events"), Some(Value::Array(events))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> BoxLink {
        BoxLink {
            machine: " aura-runner ".into(),
            remote_root: "~/aura-feat-x".into(),
            branch: Some(" ".into()),
            engine: "claude".into(),
            agent_session_id: None,
            place_id: None,
            driver: None,
        }
    }

    #[test]
    fn a_link_carries_names_and_never_an_address() {
        let v = link_body(&link()).unwrap();
        assert_eq!(v["machine"], "aura-runner");
        assert!(v.get("branch").is_none(), "a blank branch is not given");
        for k in ["host", "user", "key_path", "instance_id"] {
            assert!(v.get(k).is_none(), "{k}");
        }
    }

    #[test]
    fn a_place_id_must_be_one() {
        let mut l = link();
        l.place_id = Some("box; rm".into());
        assert!(link_body(&l).is_err());
        let p = uuid::Uuid::new_v4();
        l.place_id = Some(p.to_string());
        assert_eq!(link_body(&l).unwrap()["place_id"], p.to_string());
    }

    #[test]
    fn only_a_place_is_handed_the_chat_to_answer_by_itself() {
        let mut l = link();
        assert!(link_body(&l).unwrap().get("driver").is_none(), "a laptop link names no driver");
        l.driver = Some("box".into());
        assert!(link_body(&l).is_err(), "a computer that is not a place can't answer by itself");
        l.place_id = Some(uuid::Uuid::new_v4().to_string());
        assert_eq!(link_body(&l).unwrap()["driver"], "box");
        l.driver = Some(" ".into());
        assert!(link_body(&l).unwrap().get("driver").is_none());
        l.driver = Some("laptop".into());
        assert!(link_body(&l).is_err());
    }

    #[test]
    fn an_event_is_the_agreed_envelope() {
        let e = event(1024, "s-1", "session/update", json!({"sessionId": "s-1"}));
        assert_eq!(e["seq"], 1024);
        assert_eq!(e["kind"], "session/update");
        assert_eq!(e["payload"]["sessionId"], "s-1");
    }
}
