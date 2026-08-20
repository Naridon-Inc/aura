//! Daemon client commands. Wraps `aura_daemon_client::Client` with a
//! Mutex<Option<Client>> kept in tauri State so React can lazily acquire
//! a connection. The wrapper is fail-soft: every command returns a
//! `DaemonResult` that distinguishes "daemon not running" from real
//! errors so the UI can show a clear empty state instead of a red wall.
//!
//! Connection lifecycle:
//!   1. React asks for `daemon_status` — we try to connect, cache the
//!      Client, and return whether it succeeded.
//!   2. Subsequent commands reuse the cached Client; on a transport
//!      error they invalidate the cache so the next call retries.
//!   3. `daemon_spawn` shells out to `aura daemon start` (best-effort)
//!      so the user doesn't have to remember to start it manually.

use std::sync::Arc;

use aura_daemon_client::paths::DaemonPaths;
use aura_daemon_client::Client;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct DaemonHandle {
    inner: Mutex<Option<Arc<Client>>>,
}

impl DaemonHandle {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire a Client, connecting on demand. Returns Err for IO/handshake
    /// failures so the caller can route to a typed DaemonResult.
    async fn acquire(&self) -> Result<Arc<Client>, String> {
        // Fast path — reuse a live Client.
        {
            let g = self.inner.lock().await;
            if let Some(c) = g.as_ref() {
                return Ok(c.clone());
            }
        }
        // Slow path — connect with the platform-default paths.
        let paths = DaemonPaths::platform_default().map_err(|e| e.to_string())?;
        if !paths.socket().exists() {
            return Err("daemon socket not present".to_string());
        }
        let client = Client::connect(&paths, "aura-shell")
            .await
            .map_err(|e| e.to_string())?;
        let arc = Arc::new(client);
        let mut g = self.inner.lock().await;
        *g = Some(arc.clone());
        Ok(arc)
    }

    /// Drop the cached client — call after a transport error so the next
    /// request reconnects fresh.
    async fn invalidate(&self) {
        let mut g = self.inner.lock().await;
        *g = None;
    }
}

#[derive(Serialize)]
pub struct DaemonStatus {
    pub connected: bool,
    pub socket_path: String,
    pub socket_exists: bool,
    pub keyfile_exists: bool,
    pub protocol_version: u16,
    pub daemon_build: String,
    pub message: String,
}

#[tauri::command]
pub async fn daemon_status(handle: State<'_, DaemonHandle>) -> Result<DaemonStatus, String> {
    let paths = match DaemonPaths::platform_default() {
        Ok(p) => p,
        Err(e) => {
            return Ok(DaemonStatus {
                connected: false,
                socket_path: String::new(),
                socket_exists: false,
                keyfile_exists: false,
                protocol_version: 0,
                daemon_build: String::new(),
                message: format!("path resolution failed: {}", e),
            });
        }
    };
    let socket_path = paths.socket().to_string_lossy().into_owned();
    let socket_exists = paths.socket().exists();
    let keyfile_exists = paths.keyfile().exists();

    if !socket_exists || !keyfile_exists {
        return Ok(DaemonStatus {
            connected: false,
            socket_path,
            socket_exists,
            keyfile_exists,
            protocol_version: 0,
            daemon_build: String::new(),
            message: if !socket_exists {
                "socket missing — daemon not running"
            } else {
                "keyfile missing — daemon never initialized"
            }
            .to_string(),
        });
    }

    match handle.acquire().await {
        Ok(client) => {
            let ack = client.handshake_ack();
            Ok(DaemonStatus {
                connected: true,
                socket_path,
                socket_exists,
                keyfile_exists,
                protocol_version: ack.accepted_version,
                daemon_build: ack.daemon_build.clone(),
                message: format!("connected (protocol v{})", ack.accepted_version),
            })
        }
        Err(e) => Ok(DaemonStatus {
            connected: false,
            socket_path,
            socket_exists,
            keyfile_exists,
            protocol_version: 0,
            daemon_build: String::new(),
            message: format!("connect failed: {}", e),
        }),
    }
}

/// Best-effort daemon start. Shells out to `aura daemon start --background`
/// (the canonical entry point); returns the process status. Tauri's invoke
/// budget caps us at one shell per call, so we don't tail logs here.
#[tauri::command]
pub async fn daemon_spawn() -> Result<String, String> {
    crate::blocking::run(move || {
        let out = std::process::Command::new(crate::agent_event_listener::resolve_aura_bin())
            .args(["daemon", "start"])
            .output()
            .map_err(|e| format!("failed to spawn aura daemon: {}", e))?;
        if !out.status.success() {
            return Err(format!(
                "daemon start exited {}: {}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    })
    .await
}

#[derive(Serialize)]
pub struct SessionInfo {
    pub id: String,
}

#[tauri::command]
pub async fn daemon_list_sessions(
    handle: State<'_, DaemonHandle>,
) -> Result<Vec<SessionInfo>, String> {
    // acquire() never invalidates the cache itself — only transport errors
    // on the wrapped calls below do.
    let client = handle.acquire().await?;
    match client.list_sessions().await {
        Ok(sessions) => Ok(sessions
            .into_iter()
            .map(|s| SessionInfo { id: s.0.to_string() })
            .collect()),
        Err(e) => {
            handle.invalidate().await;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn daemon_open_session(
    handle: State<'_, DaemonHandle>,
    workspace: String,
    agent: Option<String>,
) -> Result<String, String> {
    let client = handle.acquire().await?;
    match client.open_session(workspace, agent).await {
        Ok(id) => Ok(id.0.to_string()),
        Err(e) => {
            handle.invalidate().await;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn daemon_close_session(
    handle: State<'_, DaemonHandle>,
    id: String,
) -> Result<(), String> {
    let client = handle.acquire().await?;
    let uuid = uuid::Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    let session_id = aura_daemon_client::SessionId(uuid);
    match client.close_session(session_id).await {
        Ok(()) => Ok(()),
        Err(e) => {
            handle.invalidate().await;
            Err(e.to_string())
        }
    }
}

/// Daemon-side handover XML. Heavier than a CLI handover but contains
/// live-session state the CLI can't see (running blocks, peer presence).
#[tauri::command]
pub async fn daemon_handover(
    handle: State<'_, DaemonHandle>,
    agent: String,
) -> Result<String, String> {
    let client = handle.acquire().await?;
    match client.handover(agent).await {
        Ok(xml) => Ok(xml),
        Err(e) => {
            handle.invalidate().await;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn daemon_claim_zone(
    handle: State<'_, DaemonHandle>,
    path: String,
) -> Result<String, String> {
    let client = handle.acquire().await?;
    match client.claim_zone(path).await {
        Ok(p) => Ok(p),
        Err(e) => {
            handle.invalidate().await;
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub async fn daemon_send_message(
    handle: State<'_, DaemonHandle>,
    target: String,
    body: String,
) -> Result<String, String> {
    let client = handle.acquire().await?;
    match client.send_message(target, body).await {
        Ok(id) => Ok(id),
        Err(e) => {
            handle.invalidate().await;
            Err(e.to_string())
        }
    }
}

#[derive(Serialize)]
pub struct DaemonBlock {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub summary: String,
}

/// List blocks via the daemon (vs aura_recent_blocks which reads the
/// store directly). The daemon view includes in-flight reductions the
/// store on disk hasn't yet flushed.
#[tauri::command]
pub async fn daemon_list_blocks(
    handle: State<'_, DaemonHandle>,
    limit: usize,
) -> Result<Vec<DaemonBlock>, String> {
    use aura_daemon_client::protocol::BlockFilter;
    let client = handle.acquire().await?;
    let raw = match client.list_blocks_raw(BlockFilter::default()).await {
        Ok(r) => r,
        Err(e) => {
            handle.invalidate().await;
            return Err(e.to_string());
        }
    };
    // Parse the loose JSON the daemon ships — we only pluck a handful of
    // fields per block to keep IPC payload + UI simple. Future waves can
    // add a structured Block type when we stabilize the wire shape.
    let value: serde_json::Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let arr = value.as_array().ok_or_else(|| "expected JSON array".to_string())?;
    let mut out = Vec::with_capacity(arr.len().min(limit));
    for v in arr.iter().rev().take(limit) {
        let id = v.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let kind = v.get("kind").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let state = v.get("state").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let summary = v
            .get("intent")
            .and_then(|i| i.get("summary"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        out.push(DaemonBlock { id, kind, state, summary });
    }
    Ok(out)
}
