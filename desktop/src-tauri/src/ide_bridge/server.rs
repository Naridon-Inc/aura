//! The loopback WebSocket an agent CLI attaches to, and the MCP dispatcher
//! behind it.
//!
//! Two things about the socket are not negotiable, because the client is
//! already shipped and we are the ones adapting to it:
//!
//!   * it must accept the `mcp` **subprotocol** — the client offers exactly
//!     that one, and a server that echoes nothing back fails the upgrade;
//!   * it must accept the token in `X-Claude-Code-Ide-Authorization`, which
//!     is the value we put in the lock file.
//!
//! Bind is `127.0.0.1:0`: loopback so nothing off-machine can reach it, port
//! 0 so the OS picks a free one — which then becomes the lock filename.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State as AxumState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};
use tauri::AppHandle;

use super::bridge::{ask_ui, IdeBridgeState, HUMAN_WAIT, UI_WAIT};
use super::protocol::{
    self, DiffOutcome, ERR_INTERNAL, ERR_INVALID_PARAMS, ERR_METHOD_NOT_FOUND,
};

/// Header the CLI presents the lock file's `authToken` in.
const AUTH_HEADER: &str = "x-claude-code-ide-authorization";

/// The one subprotocol the client offers. Echoing it is part of the upgrade.
const SUBPROTOCOL: &str = "mcp";

#[derive(Clone)]
struct RouteState {
    app: AppHandle,
    bridge: Arc<IdeBridgeState>,
}

/// Take a loopback port and hold it. Split from [`serve`] so the caller can
/// publish the token *before* anything is accepted on it: the auth check
/// reads state that only exists once the port is known, and a client that
/// arrives in between would be told its perfectly good token is wrong.
pub async fn bind() -> Result<(tokio::net::TcpListener, u16), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind loopback: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?
        .port();
    Ok((listener, port))
}

/// Start accepting on an already-bound listener. Runs until the process
/// exits; anything that connected while we were still setting up is waiting
/// in the accept backlog rather than having been refused.
pub fn serve(listener: tokio::net::TcpListener, app: AppHandle, bridge: Arc<IdeBridgeState>) {
    let router = Router::new()
        .route("/", get(ws_handler))
        .with_state(RouteState { app, bridge });

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::warn!("ide bridge server stopped: {e}");
        }
    });
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    AxumState(state): AxumState<RouteState>,
) -> Response {
    let presented = headers.get(AUTH_HEADER).and_then(|v| v.to_str().ok());
    if !state.bridge.token_matches(presented) {
        return (StatusCode::UNAUTHORIZED, "bad ide token").into_response();
    }
    // Selecting the subprotocol is what completes the handshake; without it
    // the client sees an upgrade that ignored its offer and drops the socket.
    ws.protocols([SUBPROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: RouteState) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };

        let Some(reply) = handle_frame(&state, &text).await else {
            // A notification, or a frame we couldn't even parse an id out
            // of. Either way there is nothing to send back.
            continue;
        };
        let Ok(body) = serde_json::to_string(&reply) else {
            continue;
        };
        if sink.send(Message::Text(body.into())).await.is_err() {
            break;
        }
    }
}

/// One frame in, at most one frame out. `None` = nothing owed.
///
/// Split out from the socket loop so the dispatch logic is reachable from a
/// test without a live WebSocket.
async fn handle_frame(state: &RouteState, text: &str) -> Option<Value> {
    let req: protocol::JsonRpcRequest = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("ide bridge: unparseable frame: {e}");
            return None;
        }
    };
    if req.is_notification() {
        // `notifications/initialized` and the CLI's own `ide_connected` both
        // land here. Answering a notification desyncs the stream.
        return None;
    }
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => {
            let client_version = req.params.get("protocolVersion").and_then(|v| v.as_str());
            Some(protocol::success(
                &id,
                protocol::initialize_result(client_version, env!("CARGO_PKG_VERSION")),
            ))
        }
        "ping" => Some(protocol::success(&id, json!({}))),
        "tools/list" => Some(protocol::success(
            &id,
            json!({ "tools": protocol::tool_catalog() }),
        )),
        "tools/call" => {
            let Some(name) = req.tool_name().map(str::to_string) else {
                return Some(protocol::error(
                    &id,
                    ERR_INVALID_PARAMS,
                    "tools/call needs a tool name",
                ));
            };
            let args = req.tool_arguments();
            match call_tool(state, &name, args).await {
                Ok(result) => Some(protocol::success(&id, result)),
                Err(e) => Some(protocol::error(&id, ERR_INTERNAL, e)),
            }
        }
        other => Some(protocol::error(
            &id,
            ERR_METHOD_NOT_FOUND,
            format!("unknown method {other}"),
        )),
    }
}

async fn call_tool(state: &RouteState, name: &str, args: Value) -> Result<Value, String> {
    match name {
        "openDiff" => open_diff(state, args).await,
        "close_tab" => close_tab(state, args).await,
        "closeAllDiffTabs" => close_all_diff_tabs(state).await,
        "openFile" => open_file(state, args).await,
        "getOpenEditors" => ask_view(state, "getOpenEditors").await,
        "getCurrentSelection" => ask_view(state, "getCurrentSelection").await,
        "getWorkspaceFolders" => Ok(workspace_folders()),
        other => Ok(protocol::tool_error(format!(
            "Aura doesn't have a tool called {other}."
        ))),
    }
}

/// Show a proposed change and block until the person decides.
///
/// The old text is read here rather than in the webview so the diff's
/// left-hand side is what is *actually on disk this instant*, not whatever
/// buffer a tab happens to be holding.
async fn open_diff(state: &RouteState, args: Value) -> Result<Value, String> {
    let path = args
        .get("old_file_path")
        .and_then(|v| v.as_str())
        .or_else(|| args.get("new_file_path").and_then(|v| v.as_str()))
        .unwrap_or_default()
        .to_string();
    if path.is_empty() {
        return Ok(protocol::tool_error("openDiff needs a file path."));
    }
    let new_contents = args
        .get("new_file_contents")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let tab_name = args
        .get("tab_name")
        .and_then(|v| v.as_str())
        .unwrap_or(path.as_str())
        .to_string();

    // Missing is legitimate — an agent proposing a brand-new file has no
    // old side. Read errors on an existing file are not: proceeding would
    // show an empty left pane and read as "this change deletes everything".
    let old_contents = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Ok(protocol::tool_error(format!(
                "Aura couldn't read {path}: {e}"
            )))
        }
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    state.bridge.bind_diff_tab(tab_name.clone(), request_id.clone());
    let rx = state.bridge.register(request_id.clone());

    let emitted = {
        use tauri::Emitter;
        state.app.emit(
            super::bridge::REQUEST_EVENT,
            json!({
                "requestId": request_id,
                "method": "openDiff",
                "params": {
                    "path": path,
                    "tabName": tab_name,
                    "oldContents": old_contents,
                    "newContents": new_contents,
                },
            }),
        )
    };
    if let Err(e) = emitted {
        state.bridge.forget(&request_id);
        state.bridge.take_diff_tab(&tab_name);
        return Err(format!("could not reach the Aura window: {e}"));
    }

    let outcome = match tokio::time::timeout(HUMAN_WAIT, rx).await {
        Ok(Ok(reply)) => {
            // The window can refuse outright — the commonest reason being
            // that showing this proposal would overwrite unsaved edits the
            // person has in that file. That is not a verdict on the change,
            // so it must not be dressed up as one: the agent is told what
            // is in the way and falls back to asking in its own terminal.
            if let Some(err) = reply.get("error").and_then(|v| v.as_str()) {
                state.bridge.take_diff_tab(&tab_name);
                return Ok(protocol::tool_error(err.to_string()));
            }
            DiffOutcome::from_reply(&reply)
        }
        // Dropped or timed out: the tab is gone or nobody ever looked. Both
        // are honestly "closed" — never "saved", which would tell the agent
        // its change was accepted when no human ever saw it.
        _ => {
            state.bridge.forget(&request_id);
            DiffOutcome::Closed
        }
    };
    state.bridge.take_diff_tab(&tab_name);
    Ok(protocol::tool_result(outcome.into_content()))
}

/// Close a tab the agent opened by name.
///
/// Also settles any `openDiff` still waiting on that tab: the CLI calls this
/// on abort, and a diff left registered would hold its socket until the
/// four-hour ceiling.
async fn close_tab(state: &RouteState, args: Value) -> Result<Value, String> {
    let tab_name = args
        .get("tab_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if tab_name.is_empty() {
        return Ok(protocol::tool_error("close_tab needs a tab name."));
    }
    if let Some(request_id) = state.bridge.take_diff_tab(&tab_name) {
        state.bridge.resolve(&request_id, json!({ "outcome": "closed" }));
    }
    let _ = ask_ui(
        &state.app,
        &state.bridge,
        "closeTab",
        json!({ "tabName": tab_name }),
        UI_WAIT,
    )
    .await;
    Ok(protocol::tool_result(vec![protocol::text_block("TAB_CLOSED")]))
}

async fn close_all_diff_tabs(state: &RouteState) -> Result<Value, String> {
    let open = state.bridge.take_all_diff_tabs();
    for (_, request_id) in &open {
        state.bridge.resolve(request_id, json!({ "outcome": "closed" }));
    }
    let names: Vec<String> = open.into_iter().map(|(name, _)| name).collect();
    let closed = names.len();
    let _ = ask_ui(
        &state.app,
        &state.bridge,
        "closeTabs",
        json!({ "tabNames": names }),
        UI_WAIT,
    )
    .await;
    Ok(protocol::tool_result(vec![protocol::text_block(format!(
        "CLOSED_{closed}_DIFF_TABS"
    ))]))
}

async fn open_file(state: &RouteState, args: Value) -> Result<Value, String> {
    let path = args
        .get("filePath")
        .or_else(|| args.get("file_path"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if path.is_empty() {
        return Ok(protocol::tool_error("openFile needs a file path."));
    }
    let params = json!({
        "path": path,
        "startLine": args.get("startLine").cloned().unwrap_or(Value::Null),
        "endLine": args.get("endLine").cloned().unwrap_or(Value::Null),
        "startText": args.get("startText").cloned().unwrap_or(Value::Null),
        "endText": args.get("endText").cloned().unwrap_or(Value::Null),
        "makeFrontmost": args
            .get("makeFrontmost")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
    });
    match ask_ui(&state.app, &state.bridge, "openFile", params, UI_WAIT).await {
        Ok(reply) => {
            if let Some(err) = reply.get("error").and_then(|v| v.as_str()) {
                return Ok(protocol::tool_error(err.to_string()));
            }
            Ok(protocol::tool_result(vec![protocol::text_block(format!(
                "Opened {path} in Aura."
            ))]))
        }
        Err(e) => Ok(protocol::tool_error(e)),
    }
}

/// Read-only questions React answers from live tab state.
async fn ask_view(state: &RouteState, method: &str) -> Result<Value, String> {
    match ask_ui(&state.app, &state.bridge, method, json!({}), UI_WAIT).await {
        // Hand the model JSON text rather than a bare object: MCP content
        // blocks are text, and the CLI passes them through verbatim.
        Ok(reply) => Ok(protocol::tool_result(vec![protocol::text_block(
            serde_json::to_string_pretty(&reply).unwrap_or_else(|_| "{}".into()),
        )])),
        Err(e) => Ok(protocol::tool_error(e)),
    }
}

fn workspace_folders() -> Value {
    let roots = crate::cmd_projects::registered_roots();
    protocol::tool_result(vec![protocol::text_block(
        serde_json::to_string_pretty(&json!({ "folders": roots })).unwrap_or_else(|_| "{}".into()),
    )])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_header_name_is_lowercase_for_headermap_lookup() {
        // `HeaderMap::get` is case-insensitive but only when the needle is
        // already lowercase; a capitalised literal silently never matches.
        assert_eq!(AUTH_HEADER, AUTH_HEADER.to_lowercase());
        assert_eq!(AUTH_HEADER, "x-claude-code-ide-authorization");
    }

    #[test]
    fn subprotocol_is_the_one_the_client_offers() {
        assert_eq!(SUBPROTOCOL, "mcp");
    }

    #[test]
    fn every_catalogued_tool_has_a_dispatch_arm() {
        // Catalog and dispatcher drifting apart is the failure that looks
        // like "the tool exists but always errors", so pin them together.
        let dispatched = [
            "openDiff",
            "close_tab",
            "closeAllDiffTabs",
            "openFile",
            "getOpenEditors",
            "getCurrentSelection",
            "getWorkspaceFolders",
        ];
        for name in protocol::tool_names() {
            assert!(
                dispatched.contains(&name.as_str()),
                "{name} is advertised but has no dispatch arm"
            );
        }
        assert_eq!(dispatched.len(), protocol::tool_names().len());
    }
}
