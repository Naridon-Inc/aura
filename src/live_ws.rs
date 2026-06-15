//! WebSocket client for the cloud live plane (plan W2.1b).
//!
//! Runs a dedicated OS thread that holds one blocking `tungstenite`
//! connection. The first outbound frame is `{type:"hello", token:"..."}`;
//! the server replies `{type:"ready", ...}` and then streams frames.
//!
//! Received frames are dispatched to file-backed markers under
//! `.aura/live/` so the rest of the CLI can pick them up without
//! cross-thread channels (mirrors the existing heartbeat marker scheme
//! in `live_sync.rs`). A hard failure falls back to HTTP polling —
//! `live_sync.rs`'s existing loop keeps running regardless, so the WS
//! layer is a pure *accelerator*.

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use tungstenite::{client::IntoClientRequest, Message};
use tungstenite::stream::MaybeTlsStream;

/// Spawn the WS worker. `running` lets the main process signal shutdown.
/// Returns immediately — the worker reconnects internally on failure.
pub fn spawn(cloud_url: String, token: String, running: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name("aura-live-ws".into())
        .spawn(move || worker(cloud_url, token, running))
        .expect("spawn live-ws thread")
}

fn worker(cloud_url: String, token: String, running: Arc<AtomicBool>) {
    let mut backoff = Duration::from_secs(1);
    while running.load(Ordering::Relaxed) {
        match connect_once(&cloud_url, &token, &running) {
            Ok(_) => {
                // Graceful close; reset backoff.
                backoff = Duration::from_secs(1);
            }
            Err(_) => {
                // Cap backoff at 30s so transient blips don't hammer the cloud.
                thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

fn connect_once(cloud_url: &str, token: &str, running: &AtomicBool) -> Result<(), String> {
    let ws_url = http_to_ws(cloud_url);
    let url = format!("{}/api/v2/live/ws", ws_url.trim_end_matches('/'));
    let request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad url: {}", e))?;

    let (mut socket, _) =
        tungstenite::connect(request).map_err(|e| format!("connect: {}", e))?;

    // Hello frame — auth.
    let hello = serde_json::json!({ "type": "hello", "token": token });
    socket
        .send(Message::Text(hello.to_string().into()))
        .map_err(|e| format!("hello: {}", e))?;

    // Shorten read timeout so we notice shutdown promptly without busy-looping.
    if let Some(stream) = underlying_tcp(socket.get_ref()) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    }

    while running.load(Ordering::Relaxed) {
        match socket.read() {
            Ok(Message::Text(t)) => handle_frame(&t),
            Ok(Message::Binary(_)) => {} // reserved for W4 CRDT payloads
            Ok(Message::Ping(p)) => {
                let _ = socket.send(Message::Pong(p));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                // Timeout — loop around and recheck the running flag.
                continue;
            }
            Err(e) => return Err(format!("read: {}", e)),
        }
    }

    let _ = socket.close(None);
    Ok(())
}

fn underlying_tcp(s: &MaybeTlsStream<TcpStream>) -> Option<&TcpStream> {
    match s {
        MaybeTlsStream::Plain(t) => Some(t),
        MaybeTlsStream::Rustls(t) => Some(t.get_ref()),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Frame {
    Ready { user_id: String, org_id: String },
    Error { message: String },
    Presence { user_id: String, branch: String },
    SyncDelta { branch: String, functions: serde_json::Value },
    Message { from_user_id: String, body: String },
    Impact { alert_id: String, function_name: String },
    Zone { zone_path: String, status: String },
    Conflict { conflict_id: String, file_path: String },
    BuildStatus { user_id: String, status: String },
    CrdtOp { doc_id: String, op_id: i64 },
    Heartbeat { server_time_ms: i64 },
    Pong,
}

fn handle_frame(raw: &str) {
    let frame: Frame = match serde_json::from_str(raw) {
        Ok(f) => f,
        Err(_) => return,
    };
    let dir = marker_dir();
    let _ = std::fs::create_dir_all(&dir);
    match frame {
        Frame::SyncDelta { .. } => {
            let _ = std::fs::write(dir.join("sync_pending"), "ws");
        }
        Frame::Impact { .. } => {
            let _ = std::fs::write(dir.join("impacts_pending"), "ws");
        }
        Frame::Message { .. } => {
            let _ = std::fs::write(dir.join("unread_messages"), "ws");
        }
        Frame::Zone { zone_path, status } => {
            let _ = std::fs::write(dir.join("zone_last"), format!("{} {}", status, zone_path));
        }
        Frame::Conflict { .. } => {
            let _ = std::fs::write(dir.join("conflicts_pending"), "ws");
        }
        Frame::BuildStatus { user_id, status } => {
            let _ = std::fs::write(
                dir.join("peer_build"),
                serde_json::json!({ "user_id": user_id, "status": status }).to_string(),
            );
        }
        Frame::CrdtOp { .. } => {
            let _ = std::fs::write(dir.join("crdt_pending"), "ws");
        }
        _ => {}
    }
}

fn marker_dir() -> PathBuf {
    PathBuf::from(".aura/live")
}

fn http_to_ws(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else {
        url.to_string()
    }
}

/// Outcome of a `listen` session: frames received minus heartbeats, plus whether
/// the `ready` handshake completed. Used by `aura ws listen` and E2E probes.
pub struct ListenReport {
    pub ready: bool,
    pub frames: Vec<String>,
}

/// Connect → hello → read frames until `max_secs` elapses or `stop_after`
/// non-heartbeat frames arrive. Blocking; callers run from a CLI context.
/// Returns collected raw JSON frames (including `ready`), so callers can
/// inspect types without re-parsing.
///
/// `format` switches the server-side output stream. Currently supported:
///   * `None` — native `ServerFrame` JSON (default)
///   * `Some("ag-ui")` — CopilotKit AG-UI event shapes
pub fn listen_blocking(
    cloud_url: &str,
    token: &str,
    max_secs: u64,
    stop_after: usize,
    format: Option<&str>,
) -> Result<ListenReport, String> {
    let ws_url = http_to_ws(cloud_url);
    let base = format!("{}/api/v2/live/ws", ws_url.trim_end_matches('/'));
    let url = match format {
        Some(f) if !f.is_empty() => format!("{}?format={}", base, f),
        _ => base,
    };
    let request = url
        .as_str()
        .into_client_request()
        .map_err(|e| format!("bad url: {}", e))?;

    let (mut socket, _) =
        tungstenite::connect(request).map_err(|e| format!("connect: {}", e))?;

    let hello = serde_json::json!({ "type": "hello", "token": token });
    socket
        .send(Message::Text(hello.to_string().into()))
        .map_err(|e| format!("hello: {}", e))?;

    if let Some(stream) = underlying_tcp(socket.get_ref()) {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(max_secs);
    let mut report = ListenReport { ready: false, frames: Vec::new() };
    let mut payload_frames: usize = 0;

    while std::time::Instant::now() < deadline {
        match socket.read() {
            Ok(Message::Text(t)) => {
                let s = t.to_string();
                // AG-UI mode emits `RUN_STARTED` as its handshake instead of
                // the native `ready`; count either as "handshake complete".
                if s.contains("\"type\":\"ready\"")
                    || s.contains("\"type\":\"RUN_STARTED\"")
                {
                    report.ready = true;
                } else if !s.contains("\"type\":\"heartbeat\"")
                    && !s.contains("\"type\":\"pong\"")
                    && !s.contains("\"type\":\"RAW\"")
                {
                    payload_frames += 1;
                }
                report.frames.push(s);
                if stop_after > 0 && payload_frames >= stop_after {
                    break;
                }
            }
            Ok(Message::Ping(p)) => {
                let _ = socket.send(Message::Pong(p));
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(format!("read: {}", e)),
        }
    }

    let _ = socket.close(None);
    Ok(report)
}
