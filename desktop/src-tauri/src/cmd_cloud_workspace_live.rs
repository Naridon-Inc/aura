//! Following a cloud workspace live: one socket per workspace to the cloud's
//! hub for it (`GET /api/v2/sessions/{id}/ws`), its frames handed to the
//! window as they arrive.
//!
//! A teammate watching a chat that runs on one of the org's machines sees
//! what the agent is doing as the driver's laptop relays it (`acp_event`), and
//! each turn the moment it is kept (`message`), instead of asking for the
//! whole conversation every few seconds. The socket says nothing it didn't
//! say to everyone else on it; the window keeps the conversation it read and
//! adds to it.
//!
//! The first connection's failure is the command's error, so a workspace this member
//! can't open says so. After that the socket reconnects on its own, backing off,
//! and each drop is a `down` frame: the window reads the conversation again
//! when the next `ready` arrives, since frames sent while the socket was down
//! are gone.
//!
//! Several views of one workspace share its socket; the last to let go
//! closes it.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::cloud_org::{active_org_slug, ORG_HEADER};
use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};
use crate::cmd_cloud_workspaces::path_id;

/// The one event every workspace's frames go out on, each carrying its
/// workspace's id.
pub const EVENT: &str = "cloud-workspace-live";

/// The frames the window is given. Typing and compose previews are left on
/// the socket: nothing here draws them. `feedback` carries a turn's reactions
/// and each comment as it now stands.
const FORWARDED: &[&str] = &["ready", "message", "acp_event", "presence", "feedback"];

/// A keep-alive through proxies that close a quiet socket.
const PING_EVERY: Duration = Duration::from_secs(25);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Watch {
    views: usize,
    task: tokio::task::JoinHandle<()>,
}

fn watches() -> &'static Mutex<HashMap<String, Watch>> {
    static W: OnceLock<Mutex<HashMap<String, Watch>>> = OnceLock::new();
    W.get_or_init(Default::default)
}

/// `https://host` → `wss://host/api/v2/sessions/{id}/ws`, the id set through
/// the path API so it cannot reshape the request.
pub(crate) fn ws_url(origin: &str, id: &str) -> Result<String, String> {
    let base = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(format!("not a cloud address: {origin}"));
    };
    let mut url = url::Url::parse(&base).map_err(|e| format!("bad cloud address {origin}: {e}"))?;
    url.set_path(&format!("/api/v2/sessions/{id}/ws"));
    url.set_query(None);
    Ok(url.to_string())
}

/// A frame from the socket as the window gets it, or nothing for one it
/// doesn't draw or can't read.
pub(crate) fn for_window(raw: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let kind = v.get("kind")?.as_str()?;
    FORWARDED.contains(&kind).then_some(v)
}

async fn open_socket(id: &str) -> Result<Socket, String> {
    let creds = read_credentials().map_err(|e| e.to_string())?;
    let token = cloud_token(&creds).ok_or_else(|| "Sign in to Aura Cloud to follow this workspace.".to_string())?;
    let url = ws_url(&cloud_origin(&creds), id)?;
    let mut req = url.as_str().into_client_request().map_err(|e| format!("live socket: {e}"))?;
    let bearer = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| "the cloud token isn't readable".to_string())?;
    req.headers_mut().insert("Authorization", bearer);
    if let Some(slug) = active_org_slug().and_then(|s| HeaderValue::from_str(&s).ok()) {
        req.headers_mut().insert(ORG_HEADER, slug);
    }
    let (ws, _resp) = tokio_tungstenite::connect_async(req).await.map_err(|e| match e {
        tokio_tungstenite::tungstenite::Error::Http(r) => match r.status().as_u16() {
            403 => "You don't have access to this workspace's repository.".to_string(),
            404 => "The cloud doesn't know this workspace.".to_string(),
            401 => "Sign in to Aura Cloud again to follow this workspace.".to_string(),
            s => format!("the cloud refused the live socket ({s})"),
        },
        other => format!("live socket: {other}"),
    })?;
    Ok(ws)
}

fn emit(app: &AppHandle, id: &str, frame: Value) {
    let _ = app.emit(EVENT, json!({ "workspace_id": id, "frame": frame }));
}

/// Read one socket until it drops, keeping it alive. Returns why it dropped.
async fn pump(app: &AppHandle, id: &str, socket: Socket) -> String {
    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    loop {
        tokio::select! {
            next = stream.next() => match next {
                Some(Ok(Message::Text(t))) => {
                    if let Some(frame) = for_window(t.as_str()) {
                        emit(app, id, frame);
                    }
                }
                Some(Ok(Message::Close(_))) | None => return "the cloud closed the socket".into(),
                Some(Ok(_)) => {}
                Some(Err(e)) => return e.to_string(),
            },
            _ = ping.tick() => {
                if sink.send(Message::Text(r#"{"kind":"ping"}"#.into())).await.is_err() {
                    return "the socket stopped answering".into();
                }
            }
        }
    }
}

async fn follow(app: AppHandle, id: String, first: Socket) {
    let mut socket = Some(first);
    let mut backoff = BACKOFF_MIN;
    loop {
        let live = match socket.take() {
            Some(s) => s,
            None => match open_socket(&id).await {
                Ok(s) => {
                    backoff = BACKOFF_MIN;
                    s
                }
                Err(e) => {
                    emit(&app, &id, json!({ "kind": "down", "reason": e }));
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                    continue;
                }
            },
        };
        let why = pump(&app, &id, live).await;
        emit(&app, &id, json!({ "kind": "down", "reason": why }));
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// One more view of the workspace, if it already has a socket.
fn join(id: &str) -> bool {
    match watches().lock().unwrap().get_mut(id) {
        Some(w) => {
            w.views += 1;
            true
        }
        None => false,
    }
}

/// One view fewer; the last one closes the socket. False when the workspace
/// wasn't being followed.
fn leave(id: &str) -> bool {
    let mut map = watches().lock().unwrap();
    let Some(w) = map.get_mut(id) else { return false };
    w.views = w.views.saturating_sub(1);
    if w.views == 0 {
        if let Some(w) = map.remove(id) {
            w.task.abort();
        }
    }
    true
}

/// Follow a cloud workspace live. Its frames arrive on [`EVENT`].
#[tauri::command]
pub async fn cloud_workspace_watch(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let id = path_id(&workspace_id)?.to_string();
    if join(&id) {
        return Ok(());
    }
    let socket = open_socket(&id).await?;
    let mut map = watches().lock().unwrap();
    // Another view may have connected while this one connected: share its
    // socket and let this one go.
    if let Some(w) = map.get_mut(&id) {
        w.views += 1;
        return Ok(());
    }
    let task = tokio::spawn(follow(app, id.clone(), socket));
    map.insert(id, Watch { views: 1, task });
    Ok(())
}

/// Stop following a workspace from one view.
#[tauri::command]
pub fn cloud_workspace_unwatch(workspace_id: String) -> bool {
    path_id(&workspace_id).map(leave).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_the_workspaces_own_hub_on_the_cloud() {
        assert_eq!(
            ws_url("https://auravcs.com", "8f1c-2d3e").unwrap(),
            "wss://auravcs.com/api/v2/sessions/8f1c-2d3e/ws"
        );
        assert_eq!(
            ws_url("http://127.0.0.1:3001/", "w1").unwrap(),
            "ws://127.0.0.1:3001/api/v2/sessions/w1/ws"
        );
        assert!(ws_url("auravcs.com", "w1").is_err());
    }

    #[test]
    fn only_what_the_window_draws_is_handed_to_it() {
        for kind in ["ready", "message", "acp_event", "presence", "feedback"] {
            assert!(for_window(&format!(r#"{{"kind":"{kind}"}}"#)).is_some(), "{kind}");
        }
        assert!(for_window(r#"{"kind":"typing","who":"sam"}"#).is_none());
        assert!(for_window(r#"{"kind":"prompt_preview","text":"half a thought"}"#).is_none());
        assert!(for_window("not json").is_none());
        assert!(for_window(r#"{"no":"kind"}"#).is_none());
    }

    #[tokio::test]
    async fn the_last_view_to_let_go_closes_the_socket() {
        let id = "live-test-views";
        let task = tokio::spawn(std::future::pending::<()>());
        watches().lock().unwrap().insert(id.into(), Watch { views: 1, task });
        assert!(join(id));
        assert!(leave(id));
        assert!(watches().lock().unwrap().contains_key(id), "one view still follows it");
        assert!(leave(id));
        assert!(!watches().lock().unwrap().contains_key(id));
        assert!(!leave(id), "nothing left to let go of");
    }
}
