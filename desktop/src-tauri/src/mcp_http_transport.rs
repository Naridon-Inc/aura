//! Streamable HTTP transport for MCP servers (spec rev 2025-03-26).
//!
//! Pairs with `cmd_mcp_servers.rs`' stdio JSON-RPC client. When a
//! `McpServerConfig` has `server_url` set, we skip spawning the stdio
//! proxy and instead POST JSON-RPC frames directly to the remote
//! endpoint, mirroring the same `initialize` → `notifications/initialized`
//! → real-request handshake.
//!
//! The MCP "Streamable HTTP" transport spec lets a server answer a POST
//! in one of two ways:
//!   * `application/json` — a single JSON-RPC response object.
//!   * `text/event-stream` — a chain of SSE frames, terminating with
//!     the JSON-RPC response (and possibly server-initiated requests /
//!     notifications interleaved). We read frames until we see one
//!     whose JSON payload carries the matching JSON-RPC `id`.
//!
//! Every request carries the same `Accept` set so the server is free
//! to pick whichever transport it prefers. When `access_token` is
//! `Some` we attach `Authorization: Bearer …`; for unauthenticated
//! servers (rare in the wild but legal) the header is omitted.
//!
//! Pure Rust, no Tauri deps — keeps this importable from tests later.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

/// Matches `cmd_mcp_servers::SPAWN_TIMEOUT` so a slow remote server
/// fails the same way a slow stdio one does.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Run a full single-shot MCP session over HTTP.
///
/// Performs the three-step handshake (`initialize`, `notifications/
/// initialized`, then the real request) and returns the full JSON-RPC
/// envelope for the real request. The caller pulls `.result` /
/// `.error` from it just like the stdio path does.
///
/// `build_req` receives the JSON-RPC id we're going to use (always `2`,
/// since `initialize` consumes id `1`) so the closure can stamp it
/// onto the request body verbatim — same contract as the stdio
/// `rpc_session_inner`.
pub async fn http_rpc_session(
    server_url: &str,
    access_token: Option<&str>,
    build_req: impl FnOnce(u64) -> Value,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("reqwest build: {e}"))?;

    // 1. initialize — required handshake. Same body shape as the stdio
    // path so a server can't tell the two transports apart at the
    // protocol layer.
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "aura-shell",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    let _ = post_and_read(&client, server_url, access_token, &init_req, Some(1)).await?;

    // 2. notifications/initialized — fire-and-forget notification (no
    // `id` field, no response expected). We still POST it so servers
    // that gate further calls on this beacon proceed.
    let init_done = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let _ = post_notification(&client, server_url, access_token, &init_done).await;

    // 3. the real request.
    let req = build_req(2);
    post_and_read(&client, server_url, access_token, &req, Some(2)).await
}

/// POST a notification (no id, no response). Errors are swallowed by
/// the caller because notifications are fire-and-forget per the
/// JSON-RPC 2.0 spec.
async fn post_notification(
    client: &reqwest::Client,
    url: &str,
    access_token: Option<&str>,
    body: &Value,
) -> Result<(), String> {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(body);
    if let Some(tok) = access_token {
        req = req.bearer_auth(tok);
    }
    let _ = req
        .send()
        .await
        .map_err(|e| format!("http notify: {e}"))?;
    Ok(())
}

/// POST a request and read back the JSON-RPC response that matches
/// `expect_id`. Handles both single-JSON and SSE-streamed replies.
async fn post_and_read(
    client: &reqwest::Client,
    url: &str,
    access_token: Option<&str>,
    body: &Value,
    expect_id: Option<u64>,
) -> Result<Value, String> {
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .json(body);
    if let Some(tok) = access_token {
        req = req.bearer_auth(tok);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("http request: {e}"))?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("http {status}: {txt}"));
    }

    if content_type.contains("text/event-stream") {
        read_sse_until_id(resp, expect_id).await
    } else {
        // Default to JSON (some servers omit Content-Type on success).
        let v: Value = resp
            .json()
            .await
            .map_err(|e| format!("decode JSON-RPC response: {e}"))?;
        Ok(v)
    }
}

/// Consume an SSE response body until we see a `data:` frame whose
/// JSON payload carries the matching JSON-RPC `id`. Server-sent
/// notifications and unrelated responses interleave freely and are
/// skipped — same tolerance the stdio reader has.
///
/// Stream framing follows the HTML5 EventSource grammar minimally:
/// blank line terminates an event, lines starting with `data:` are
/// concatenated for the payload, everything else (id:, event:,
/// retry:, comments) is ignored. We don't reconnect on disconnect —
/// the per-request timeout owns liveness.
async fn read_sse_until_id(
    resp: reqwest::Response,
    expect_id: Option<u64>,
) -> Result<Value, String> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut data_lines: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("sse read: {e}"))?;
        buf.extend_from_slice(&bytes);

        // Process complete lines (newline-terminated). Keep the
        // trailing partial line in `buf` for the next chunk.
        loop {
            let nl = match buf.iter().position(|b| *b == b'\n') {
                Some(p) => p,
                None => break,
            };
            let mut line = buf.drain(..=nl).collect::<Vec<u8>>();
            // Drop the trailing '\n' (and a preceding '\r' if present).
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line_str = String::from_utf8_lossy(&line).into_owned();

            if line_str.is_empty() {
                // End-of-event: assemble the data payload and try to
                // parse it as JSON-RPC.
                if !data_lines.is_empty() {
                    let payload = data_lines.join("\n");
                    data_lines.clear();
                    if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                        let matches_id = match expect_id {
                            Some(want) => v
                                .get("id")
                                .and_then(|i| i.as_u64())
                                .map(|i| i == want)
                                .unwrap_or(false),
                            None => true,
                        };
                        if matches_id {
                            return Ok(v);
                        }
                    }
                    // unparseable or wrong id — drop and keep reading.
                }
                continue;
            }

            // SSE comment lines (": …") are heartbeats; skip.
            if line_str.starts_with(':') {
                continue;
            }

            if let Some(rest) = line_str.strip_prefix("data:") {
                // Spec: optional single leading space after `data:`.
                let payload = rest.strip_prefix(' ').unwrap_or(rest);
                data_lines.push(payload.to_string());
            }
            // Other field names (event:, id:, retry:) are valid SSE
            // but irrelevant to MCP — ignore.
        }
    }

    // Stream ended without a matching event. If we have a trailing
    // unterminated event sitting in `data_lines`, try it once.
    if !data_lines.is_empty() {
        let payload = data_lines.join("\n");
        if let Ok(v) = serde_json::from_str::<Value>(&payload) {
            return Ok(v);
        }
    }
    Err("sse stream ended before JSON-RPC response arrived".into())
}
