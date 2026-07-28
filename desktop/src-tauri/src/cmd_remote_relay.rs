//! Cloud relay client — outbound WebSocket from this desktop to
//! `auravcs.com` so phones on the public internet can drive the
//! locally-running Aura agent / manager / terminal sessions.
//!
//! Architecture mirrors `cmd_remote` but inverted:
//!   • LAN path: axum SERVES a WS the phone dials over LAN.
//!   • Relay path: the desktop DIALS an outbound WS to the cloud,
//!     which assigns a 6-char shortcode + public URL. Phones load
//!     `https://auravcs.com/remote/m/<code>` and the cloud copies
//!     frames between phone WS and our outbound WS.
//!
//! Both paths feed into the same `cmd_remote::run_protocol_session`
//! so the JSON wire format, snapshot replay, agent-stream listeners,
//! and session join logic are byte-identical. The only difference is
//! the transport.
//!
//! Auth uses the existing `cloud_api_token` (JWT) the user already
//! configured to use Aura's cloud sync — see `cmd_settings` for where
//! the token is stored. No new credential surface.
//!
//! Lifecycle:
//!   • `remote_relay_start` — read settings, dial WS, parse the
//!     `{type:"registered", code, public_url}` frame, spawn the
//!     bridge task, return status.
//!   • `remote_relay_stop` — drop the connection (cancels the bridge).
//!   • `remote_relay_status` — current code + public URL + connection
//!     state for the dialog.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::protocol::Message as TMessage;
use url::Url;

use crate::cmd_remote::{run_protocol_session, RemoteState};

/// Tauri-managed singleton. One outbound relay per desktop.
pub struct RemoteRelayState {
    inner: Arc<Mutex<RelayInner>>,
}

struct RelayInner {
    running: Option<RunningRelay>,
}

struct RunningRelay {
    code: String,
    public_url: String,
    /// Drop sender to ask the bridge task to exit.
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Default for RemoteRelayState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RelayInner { running: None })),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct RemoteRelayStatus {
    pub running: bool,
    pub code: Option<String>,
    pub public_url: Option<String>,
}

/// `{ "type": "registered", "code": "abcdef", "public_url": "https://..." }`
#[derive(Deserialize)]
struct RegisteredFrame {
    code: String,
    public_url: String,
}

fn aura_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no HOME / USERPROFILE".to_string())?;
    Ok(PathBuf::from(home).join(".aura"))
}

pub(crate) fn read_credentials() -> Result<serde_json::Map<String, Value>, String> {
    let path = aura_dir()?.join("credentials.json");
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let s = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if s.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    let v: Value = serde_json::from_str(&s).map_err(|e| format!("parse credentials: {e}"))?;
    match v {
        Value::Object(m) => Ok(m),
        _ => Err("credentials.json is not an object".into()),
    }
}

pub(crate) fn cloud_origin(map: &serde_json::Map<String, Value>) -> String {
    map.get("cloud_url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("https://auravcs.com")
        .trim_end_matches('/')
        .to_string()
}

pub(crate) fn cloud_token(map: &serde_json::Map<String, Value>) -> Option<String> {
    map.get("cloud_api_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

/// Convert an `https://` (or `http://`) origin to the matching
/// `wss://` (or `ws://`) form for WebSocket upgrade.
fn ws_origin(origin: &str) -> String {
    if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        origin.to_string()
    }
}

impl RemoteRelayState {
    /// Current relay status without dialing. Used by the status command and
    /// by the presence heartbeat to report the live code/URL.
    pub(crate) async fn current(&self) -> RemoteRelayStatus {
        let g = self.inner.lock().await;
        match g.running.as_ref() {
            Some(r) => RemoteRelayStatus {
                running: true,
                code: Some(r.code.clone()),
                public_url: Some(r.public_url.clone()),
            },
            None => RemoteRelayStatus {
                running: false,
                code: None,
                public_url: None,
            },
        }
    }

    /// Idempotently bring the relay up: returns the running relay if one
    /// exists, else dials a fresh outbound WS to the cloud and registers.
    ///
    /// Shared by the `remote_relay_start` command (user tapped "Use Aura on
    /// your phone") and the presence heartbeat's wake path (phone tapped a
    /// laptop in "Your laptops"). The dial attaches this desktop's stable
    /// device identity so the cloud binds the live code to the right row in
    /// the phone's list.
    pub(crate) async fn ensure_started(
        &self,
        app: &AppHandle,
    ) -> Result<RemoteRelayStatus, String> {
        {
            let g = self.inner.lock().await;
            if let Some(running) = g.running.as_ref() {
                return Ok(RemoteRelayStatus {
                    running: true,
                    code: Some(running.code.clone()),
                    public_url: Some(running.public_url.clone()),
                });
            }
        }

        let creds = read_credentials()?;
        let token = cloud_token(&creds)
            .ok_or_else(|| "no cloud_api_token set — sign in via Aura cloud first".to_string())?;
        let origin = cloud_origin(&creds);
        let ws_base = ws_origin(&origin);
        let mut url = Url::parse(&format!("{ws_base}/api/v2/remote/desktop/ws"))
            .map_err(|e| format!("bad cloud_url: {e}"))?;
        {
            let ident = crate::cmd_remote_devices::device_identity();
            let mut q = url.query_pairs_mut();
            q.append_pair("token", &token);
            // Durable presence identity — see `remote_devices` on the cloud.
            q.append_pair("device_id", &ident.device_id);
            q.append_pair("name", &ident.name);
            q.append_pair("platform", ident.platform);
        }

        let (ws, _resp) = tokio_tungstenite::connect_async(url.as_str())
            .await
            .map_err(|e| format!("relay dial: {e}"))?;

        use futures_util::{SinkExt, StreamExt};
        let (mut ws_sink, mut ws_stream) = ws.split();

        // First frame must be the assigned code + public URL.
        let registered: RegisteredFrame = loop {
            match ws_stream.next().await {
                Some(Ok(TMessage::Text(t))) => {
                    let v: Value = match serde_json::from_str(&t) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v.get("type").and_then(|x| x.as_str()) == Some("registered") {
                        break serde_json::from_value::<RegisteredFrame>(v)
                            .map_err(|e| format!("bad register frame: {e}"))?;
                    }
                }
                Some(Ok(TMessage::Close(_))) | None => {
                    return Err("relay closed before registration".to_string());
                }
                Some(Err(e)) => return Err(format!("relay register read: {e}")),
                _ => {}
            }
        };

        // Channels into / out of the generic protocol session.
        let (peer_tx_in, peer_rx_in) = mpsc::unbounded_channel::<String>();
        let (peer_tx_out, mut peer_rx_out) = mpsc::unbounded_channel::<String>();

        // Snapshot Arc — shared with the LAN remote so a single
        // `remote_set_snapshot` push from the renderer feeds both paths.
        let remote_state = app.state::<RemoteState>();
        let snapshot = remote_state.snapshot_arc().await;

        // Bridge: ws_stream -> peer_tx_in (raw text frames into protocol session).
        let read_pump = tokio::spawn(async move {
            while let Some(frame) = ws_stream.next().await {
                match frame {
                    Ok(TMessage::Text(t)) => {
                        if peer_tx_in.send(t.to_string()).is_err() {
                            break;
                        }
                    }
                    Ok(TMessage::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        });

        // Bridge: peer_rx_out -> ws_sink (protocol responses out to cloud).
        let write_pump = tokio::spawn(async move {
            while let Some(text) = peer_rx_out.recv().await {
                if ws_sink.send(TMessage::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });

        // Cancel signal — drop the sender to ask the session task to exit.
        let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

        let app_for_session = app.clone();
        let _session_task = tokio::spawn(async move {
            tokio::select! {
                _ = run_protocol_session(app_for_session, snapshot, peer_rx_in, peer_tx_out) => {}
                _ = cancel_rx => {}
            }
            let _ = read_pump.abort();
            let _ = write_pump.abort();
        });

        let code = registered.code.clone();
        let public_url = registered.public_url.clone();

        {
            let mut g = self.inner.lock().await;
            g.running = Some(RunningRelay {
                code: code.clone(),
                public_url: public_url.clone(),
                shutdown: Some(cancel_tx),
            });
        }

        let _ = app.emit(
            "remote-relay:status",
            RemoteRelayStatus {
                running: true,
                code: Some(code.clone()),
                public_url: Some(public_url.clone()),
            },
        );

        Ok(RemoteRelayStatus {
            running: true,
            code: Some(code),
            public_url: Some(public_url),
        })
    }
}

#[tauri::command]
pub async fn remote_relay_start(
    app: AppHandle,
    state: State<'_, RemoteRelayState>,
) -> Result<RemoteRelayStatus, String> {
    state.ensure_started(&app).await
}

#[tauri::command]
pub async fn remote_relay_stop(
    app: AppHandle,
    state: State<'_, RemoteRelayState>,
) -> Result<RemoteRelayStatus, String> {
    let mut g = state.inner.lock().await;
    if let Some(mut running) = g.running.take() {
        if let Some(tx) = running.shutdown.take() {
            let _ = tx.send(());
        }
    }
    let status = RemoteRelayStatus {
        running: false,
        code: None,
        public_url: None,
    };
    let _ = app.emit("remote-relay:status", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn remote_relay_status(
    state: State<'_, RemoteRelayState>,
) -> Result<RemoteRelayStatus, String> {
    Ok(state.current().await)
}
