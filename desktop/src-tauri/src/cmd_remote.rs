//! Mobile remote — LAN web server that lets a phone in the same
//! network drive an active agent / manager session in this shell.
//!
//! Architecture:
//!   • axum HTTP+WS server bound to `0.0.0.0:<port>` (port chosen on
//!     start; OS picks a free one when 0). Lives in a tokio task that
//!     the Tauri runtime owns.
//!   • Auth: short numeric PIN baked into the URL the phone hits
//!     (`http://<lan-ip>:<port>/?pin=NNNNNN`). Anything without a
//!     matching pin gets a 401.
//!   • One route serves a tiny embedded HTML page (no build step,
//!     just include_str!). The page opens a websocket back to
//!     `ws://<host>/ws?pin=...` and renders messages.
//!   • Bridge: incoming WS messages from the phone are matched to
//!     existing Tauri commands (agent_stream_send, manager_chat,
//!     manager_chat_start). Outgoing — agent-stream / manager events
//!     emitted by the shell — are forwarded by an `app.listen` hook
//!     on the channels the WS subscribed to.
//!
//! This is intentionally a MVP: a single PIN, a single password‑less
//! pairing, no TLS. Designed for trusted home networks and dev
//! environments where the user just wants to keep talking to Claude
//! while away from the keyboard. See README in the dialog for caveats.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State as AxumState};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::{mpsc, Mutex, RwLock};

/// Internal Tauri-event topic used to broadcast snapshot updates from
/// `remote_set_snapshot` to every live WS handler. Phones never see
/// this name — handlers translate it to a `Snapshot` ServerMsg.
const SNAPSHOT_TOPIC: &str = "remote:snapshot";

/// Top-level Tauri-managed handle. Holds the running server (if any),
/// the current PIN, and the count of connected websocket clients so
/// the dialog can show "1 phone connected".
pub struct RemoteState {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    running: Option<RunningServer>,
    /// Latest workspace snapshot pushed by the renderer. Cached so that
    /// fresh WS connections get the current state immediately, before
    /// the renderer's debounced push fires again. Wrapped in an Arc so
    /// `RouteState` (one per running server) can share the same handle.
    snapshot: Arc<RwLock<Option<Value>>>,
}

struct RunningServer {
    pin: String,
    #[allow(dead_code)]
    bind_addr: SocketAddr,
    lan_url: String,
    /// Cancel token — drop the sender to ask the server task to exit.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    /// Live websocket count, written by each WS task on connect/disc.
    clients: Arc<Mutex<usize>>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                running: None,
                snapshot: Arc::new(RwLock::new(None)),
            })),
        }
    }
}

impl RemoteState {
    /// Shared snapshot Arc — the cloud relay client clones this so phones
    /// connected via auravcs.com see the same workspace state LAN phones
    /// would see, without requiring the LAN server to be running.
    pub async fn snapshot_arc(&self) -> Arc<RwLock<Option<Value>>> {
        self.inner.lock().await.snapshot.clone()
    }
}

#[derive(Serialize, Clone)]
pub struct RemoteStatus {
    pub running: bool,
    pub url: Option<String>,
    pub pin: Option<String>,
    pub clients: usize,
}

/// Start the LAN server. Idempotent — calling while already running
/// returns the current status without rebinding.
#[tauri::command]
pub async fn remote_start(
    app: AppHandle,
    state: State<'_, RemoteState>,
) -> Result<RemoteStatus, String> {
    let inner = state.inner.clone();
    {
        let guard = inner.lock().await;
        if let Some(running) = guard.running.as_ref() {
            return Ok(RemoteStatus {
                running: true,
                url: Some(running.lan_url.clone()),
                pin: Some(running.pin.clone()),
                clients: *running.clients.lock().await,
            });
        }
    }

    let pin = make_pin();
    let lan_ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());

    let clients = Arc::new(Mutex::new(0_usize));

    // Tauri's RemoteState already shares a Mutex<Inner>; route state
    // bundles the per-server bits the websocket handler needs.
    let snapshot = {
        let g = inner.lock().await;
        g.snapshot.clone()
    };
    let route_state = RouteState {
        app: app.clone(),
        pin: pin.clone(),
        clients: clients.clone(),
        snapshot,
    };

    let app_router = Router::new()
        .route("/", get(serve_index))
        .route("/ws", get(ws_handler))
        .with_state(route_state);

    // Bind to 0.0.0.0:0 so the OS picks a free port we'll read back.
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("bind: {e}"))?;
    let bind_addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;

    let lan_url = format!("http://{}:{}/?pin={}", lan_ip, bind_addr.port(), pin);

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        let _ = axum::serve(listener, app_router)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });

    let mut guard = inner.lock().await;
    guard.running = Some(RunningServer {
        pin: pin.clone(),
        bind_addr,
        lan_url: lan_url.clone(),
        shutdown: Some(tx),
        clients: clients.clone(),
    });

    Ok(RemoteStatus {
        running: true,
        url: Some(lan_url),
        pin: Some(pin),
        clients: 0,
    })
}

#[tauri::command]
pub async fn remote_stop(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    let mut guard = state.inner.lock().await;
    if let Some(mut running) = guard.running.take() {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
    }
    Ok(RemoteStatus {
        running: false,
        url: None,
        pin: None,
        clients: 0,
    })
}

/// Renderer mirror — pushes a JSON snapshot of {projects, sessions} to
/// the cache so any phone that connects sees the up-to-date list of
/// running agent / manager / terminal tabs without reaching back into
/// renderer state. Also fans out to live WS clients via the internal
/// `remote:snapshot` Tauri event.
#[tauri::command]
pub async fn remote_set_snapshot(
    app: AppHandle,
    state: State<'_, RemoteState>,
    snapshot: Value,
) -> Result<(), String> {
    let arc = {
        let g = state.inner.lock().await;
        g.snapshot.clone()
    };
    {
        let mut w = arc.write().await;
        *w = Some(snapshot.clone());
    }
    // Mirror the same snapshot into aura-cloud so cloud-paired mobiles
    // see Manager + Claude + Gemini + Codex + Cursor sessions, matching
    // what LAN phones already get over the local WS. Idempotent: cloud
    // upserts by (repo_id, external_id) so re-firing on each renderer
    // tab change is cheap.
    mirror_snapshot_to_cloud(&snapshot);
    let _ = app.emit(SNAPSHOT_TOPIC, snapshot);
    Ok(())
}

/// Walk the renderer-pushed snapshot and fire one cloud upsert per
/// session row. Best-effort — individual failures (no token, no GitHub
/// origin) are logged inside `spawn_push` and never bubble up.
fn mirror_snapshot_to_cloud(snapshot: &Value) {
    let Some(sessions) = snapshot.get("sessions").and_then(|v| v.as_array()) else {
        return;
    };
    for sess in sessions {
        let id = sess.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let repo_root = sess
            .get("repoRoot")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if id.is_empty() || repo_root.is_empty() {
            continue;
        }
        let label = sess
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let kind = sess.get("kind").and_then(|v| v.as_str()).unwrap_or("agent");
        let agent_id = sess
            .get("agentId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // session_type drives the dashboard's per-provider colour chip.
        // Manager rows already say "manager"; raw-CLI rows carry the
        // agent id (claude / gemini / codex / cursor) so the cloud row
        // is self-describing without us having to JOIN against a tab
        // table later. Unknown agent ids fall back to a generic "agent"
        // bucket so they still render.
        let session_type: &'static str = match kind {
            "manager" => "manager",
            _ => match agent_id {
                "claude" => "claude",
                "gemini" => "gemini",
                "codex" => "codex",
                "cursor" => "cursor",
                _ => "agent",
            },
        };
        let objective = if label.is_empty() {
            format!("{session_type} session")
        } else {
            label
        };
        crate::cloud_session_sync::spawn_push(
            repo_root.to_string(),
            id.to_string(),
            objective,
            session_type,
        );
    }
}

#[tauri::command]
pub async fn remote_status(state: State<'_, RemoteState>) -> Result<RemoteStatus, String> {
    let guard = state.inner.lock().await;
    if let Some(running) = guard.running.as_ref() {
        Ok(RemoteStatus {
            running: true,
            url: Some(running.lan_url.clone()),
            pin: Some(running.pin.clone()),
            clients: *running.clients.lock().await,
        })
    } else {
        Ok(RemoteStatus {
            running: false,
            url: None,
            pin: None,
            clients: 0,
        })
    }
}

#[derive(Clone)]
struct RouteState {
    app: AppHandle,
    pin: String,
    clients: Arc<Mutex<usize>>,
    snapshot: Arc<RwLock<Option<Value>>>,
}

#[derive(Deserialize)]
struct AuthQuery {
    pin: Option<String>,
}

async fn serve_index(
    Query(q): Query<AuthQuery>,
    AxumState(state): AxumState<RouteState>,
) -> Response {
    if q.pin.as_deref() != Some(state.pin.as_str()) {
        return (StatusCode::UNAUTHORIZED, "bad pin").into_response();
    }
    Html(MOBILE_HTML.replace("__PIN__", &state.pin)).into_response()
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<AuthQuery>,
    AxumState(state): AxumState<RouteState>,
) -> Response {
    if q.pin.as_deref() != Some(state.pin.as_str()) {
        return (StatusCode::UNAUTHORIZED, "bad pin").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Per-WS task. Speaks a tiny JSON protocol — see comments on
/// ClientMsg / ServerMsg below for the message shapes.
async fn handle_socket(socket: WebSocket, state: RouteState) {
    {
        let mut c = state.clients.lock().await;
        *c += 1;
        let _ = state.app.emit("remote:clients-changed", *c);
    }

    // Adapt the axum WebSocket into the generic text-frame channels
    // `run_protocol_session` consumes.
    let (mut sink, mut stream) = futures_util::StreamExt::split(socket);
    let (peer_tx_in, peer_rx_in) = mpsc::unbounded_channel::<String>();
    let (peer_tx_out, mut peer_rx_out) = mpsc::unbounded_channel::<String>();

    let read_pump = tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => {
                    if peer_tx_in.send(text.to_string()).is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });
    let write_pump = tokio::spawn(async move {
        use futures_util::SinkExt;
        while let Some(text) = peer_rx_out.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    run_protocol_session(state.app.clone(), state.snapshot.clone(), peer_rx_in, peer_tx_out)
        .await;

    let _ = read_pump.abort();
    let _ = write_pump.abort();

    {
        let mut c = state.clients.lock().await;
        *c = c.saturating_sub(1);
        let _ = state.app.emit("remote:clients-changed", *c);
    }
}

/// Generic protocol bridge. Reads JSON-text frames from `peer_rx`,
/// dispatches via `handle_client_msg`, and writes outgoing
/// `ServerMsg` frames as JSON text to `peer_tx`. Used by both the
/// LAN WebSocket (LAN phones in the same network) and the cloud
/// relay client (phones over the public internet via auravcs.com).
pub async fn run_protocol_session(
    app: AppHandle,
    snapshot: Arc<RwLock<Option<Value>>>,
    mut peer_rx: mpsc::UnboundedReceiver<String>,
    peer_tx: mpsc::UnboundedSender<String>,
) {
    // Bus that fan-ins outgoing messages from any spawned listener
    // back into this socket's writer.
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();

    let _ = tx.send(ServerMsg::Hello {
        version: env!("CARGO_PKG_VERSION").to_string(),
    });

    {
        let r = snapshot.read().await;
        if let Some(snap) = r.as_ref() {
            let _ = tx.send(ServerMsg::Snapshot {
                payload: snap.clone(),
            });
        }
    }

    let mut listeners: HashMap<String, tauri::EventId> = HashMap::new();

    {
        let tx_snap = tx.clone();
        let id = app.listen(SNAPSHOT_TOPIC, move |event| {
            let raw = event.payload();
            let payload: Value =
                serde_json::from_str(raw).unwrap_or(Value::String(raw.to_string()));
            let _ = tx_snap.send(ServerMsg::Snapshot { payload });
        });
        listeners.insert(SNAPSHOT_TOPIC.to_string(), id);
    }

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                let json = match serde_json::to_string(&msg) {
                    Ok(j) => j,
                    Err(_) => continue,
                };
                if peer_tx.send(json).is_err() {
                    break;
                }
            }
            Some(text) = peer_rx.recv() => {
                if let Err(e) = handle_client_msg(&app, &text, &tx, &mut listeners, &snapshot).await {
                    let _ = tx.send(ServerMsg::Error { message: e });
                }
            }
            else => break,
        }
    }

    for (_, id) in listeners.drain() {
        app.unlisten(id);
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ClientMsg {
    /// Subscribe to a Tauri event topic. Used for `agent-stream:*`,
    /// `agent-pty:*`, `manager:*` — phone receives every payload
    /// fired on that channel until it sends Unsubscribe.
    Subscribe { channel: String },
    Unsubscribe { channel: String },
    /// Spawn a fresh agent turn (or resume an existing stream one).
    /// Mirrors the desktop's Composer → runAgentPrompt path.
    /// `mode` is `"stream"` or `"pty"` (default pty if absent) — the
    /// renderer's runAgentPrompt branches on this.
    SendPrompt {
        agent_id: String,
        repo_root: String,
        prompt: String,
        #[serde(default)]
        mode: Option<String>,
        #[serde(default)]
        resume_session: Option<String>,
    },
    /// Send a chat message to an existing manager session.
    ManagerChat {
        session_id: String,
        message: String,
    },
    /// Start a fresh manager session and immediately send the first
    /// chat turn. Mirrors `runAgentPrompt` for `agentId === aura-manager`.
    ManagerStart {
        repo_root: String,
        prompt: String,
    },
    /// Send raw input bytes (or a UTF-8 string) to an existing PTY agent
    /// session. The renderer routes this through agent_pty_write so the
    /// child process sees the keystrokes as if typed locally.
    PtyWrite {
        session_id: String,
        data: String,
    },
    /// Resize an existing PTY agent session to match the phone's xterm
    /// dimensions. Without this, desktop-spawned PTYs assume desktop cols
    /// and wrap mid-line on smaller phone viewports.
    PtyResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    /// Phone joining mid-session — fetch the desktop's recent PTY
    /// scrollback (or future kinds) and reply with a History frame so
    /// the phone's xterm renders the same screen as the desktop.
    RequestHistory {
        kind: String,
        session_id: String,
    },
    /// Request a fresh snapshot replay (the renderer pushes on every
    /// state change, but a phone that just woke up may want to ask).
    RequestSnapshot {},
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMsg {
    Hello { version: String },
    /// A Tauri event payload forwarded to the phone. `payload` is the
    /// raw JSON the listener received — phone-side code interprets it
    /// based on the channel prefix.
    Event { channel: String, payload: Value },
    /// Acknowledge a SendPrompt / ManagerChat / ManagerStart so the
    /// phone can move past its "sending…" state.
    Ack {
        request: String,
        result: Value,
    },
    /// Fresh workspace + sessions snapshot. Sent on connect (if cached)
    /// and whenever the renderer pushes via `remote_set_snapshot`.
    Snapshot { payload: Value },
    /// Mid-session backlog — for `kind: "pty"` the bytes are the recent
    /// scrollback from `agent_pty_history`; phone writes them straight
    /// into xterm so the joined session shows the same screen.
    History {
        kind: String,
        session_id: String,
        payload: Value,
    },
    Error { message: String },
}

pub async fn handle_client_msg(
    app: &AppHandle,
    text: &str,
    tx: &mpsc::UnboundedSender<ServerMsg>,
    listeners: &mut HashMap<String, tauri::EventId>,
    snapshot: &Arc<RwLock<Option<Value>>>,
) -> Result<(), String> {
    let msg: ClientMsg =
        serde_json::from_str(text).map_err(|e| format!("bad message: {e}"))?;
    match msg {
        ClientMsg::Subscribe { channel } => {
            if listeners.contains_key(&channel) {
                return Ok(());
            }
            let chan_clone = channel.clone();
            let tx_clone = tx.clone();
            let id = app.listen(channel.clone(), move |event| {
                let raw = event.payload();
                let payload: Value =
                    serde_json::from_str(raw).unwrap_or(Value::String(raw.to_string()));
                let _ = tx_clone.send(ServerMsg::Event {
                    channel: chan_clone.clone(),
                    payload,
                });
            });
            listeners.insert(channel, id);
            Ok(())
        }
        ClientMsg::Unsubscribe { channel } => {
            if let Some(id) = listeners.remove(&channel) {
                app.unlisten(id);
            }
            Ok(())
        }
        ClientMsg::SendPrompt {
            agent_id,
            repo_root,
            prompt,
            mode,
            resume_session,
        } => {
            emit_remote_request(
                app,
                "send-prompt",
                serde_json::json!({
                    "agentId": agent_id,
                    "repoRoot": repo_root,
                    "prompt": prompt,
                    "mode": mode,
                    "resumeSession": resume_session,
                }),
            )?;
            let _ = tx.send(ServerMsg::Ack {
                request: "send-prompt".into(),
                result: Value::Null,
            });
            Ok(())
        }
        ClientMsg::ManagerChat {
            session_id,
            message,
        } => {
            emit_remote_request(
                app,
                "manager-chat",
                serde_json::json!({
                    "sessionId": session_id,
                    "message": message,
                }),
            )?;
            let _ = tx.send(ServerMsg::Ack {
                request: "manager-chat".into(),
                result: Value::Null,
            });
            Ok(())
        }
        ClientMsg::ManagerStart { repo_root, prompt } => {
            emit_remote_request(
                app,
                "manager-start",
                serde_json::json!({
                    "repoRoot": repo_root,
                    "prompt": prompt,
                }),
            )?;
            let _ = tx.send(ServerMsg::Ack {
                request: "manager-start".into(),
                result: Value::Null,
            });
            Ok(())
        }
        ClientMsg::PtyWrite { session_id, data } => {
            emit_remote_request(
                app,
                "pty-write",
                serde_json::json!({
                    "sessionId": session_id,
                    "data": data,
                }),
            )?;
            let _ = tx.send(ServerMsg::Ack {
                request: "pty-write".into(),
                result: Value::Null,
            });
            Ok(())
        }
        ClientMsg::PtyResize { session_id, cols, rows } => {
            emit_remote_request(
                app,
                "pty-resize",
                serde_json::json!({
                    "sessionId": session_id,
                    "cols": cols,
                    "rows": rows,
                }),
            )?;
            let _ = tx.send(ServerMsg::Ack {
                request: "pty-resize".into(),
                result: Value::Null,
            });
            Ok(())
        }
        ClientMsg::RequestHistory { kind, session_id } => {
            // PTY scrollback today. Future kinds: "stream", "manager".
            if kind == "pty" {
                let registry = app.state::<crate::cmd_agent_pty::AgentPtyRegistry>();
                let bytes: Vec<u8> = registry
                    .history
                    .lock()
                    .unwrap()
                    .get(&session_id)
                    .map(|q| q.iter().copied().collect())
                    .unwrap_or_default();
                let arr = Value::Array(
                    bytes
                        .into_iter()
                        .map(|b| Value::Number(serde_json::Number::from(b)))
                        .collect(),
                );
                let _ = tx.send(ServerMsg::History {
                    kind: "pty".into(),
                    session_id,
                    payload: arr,
                });
            } else {
                let _ = tx.send(ServerMsg::History {
                    kind,
                    session_id,
                    payload: Value::Null,
                });
            }
            Ok(())
        }
        ClientMsg::RequestSnapshot {} => {
            let r = snapshot.read().await;
            if let Some(snap) = r.as_ref() {
                let _ = tx.send(ServerMsg::Snapshot {
                    payload: snap.clone(),
                });
            }
            Ok(())
        }
    }
}

/// Bridge incoming WS commands to the renderer. The renderer registers
/// a listener on `remote:request` (see `installRemoteRequestHandler`
/// in App.tsx) and dispatches by `kind` field. We don't await a
/// response here — the resulting agent-stream / manager events flow
/// back through the existing Subscribe channel, so the phone sees the
/// effect without us having to plumb a separate ack.
fn emit_remote_request(app: &AppHandle, kind: &str, body: Value) -> Result<(), String> {
    app.emit(
        "remote:request",
        serde_json::json!({
            "kind": kind,
            "body": body,
        }),
    )
    .map_err(|e| format!("emit remote:request: {e}"))
}

fn make_pin() -> String {
    // Six digits derived from the low bits of UUID v4 random bytes.
    // Not cryptographically secure but adequate for "anyone in your
    // home wifi who already has the URL".
    let id = uuid::Uuid::new_v4();
    let bytes = id.as_bytes();
    let mut acc: u32 = 0;
    for b in bytes.iter().take(4) {
        acc = (acc << 8) | (*b as u32);
    }
    format!("{:06}", acc % 1_000_000)
}

const MOBILE_HTML: &str = include_str!("remote_mobile.html");
