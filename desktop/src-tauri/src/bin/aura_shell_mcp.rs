//! aura-shell-mcp — minimal MCP stdio server. Bridges claude's
//! `--permission-prompt-tool` callback into aura-shell's React UI by
//! forwarding the request over a UNIX socket and parking until the
//! user picks Allow/Deny/Always.
//!
//! claude spawns this binary itself (configured via --mcp-config) and
//! talks to it over stdio with JSON-RPC 2.0 framed line-by-line. We
//! implement only the three methods the permission flow requires:
//!   * initialize   — handshake; returns server info + capabilities
//!   * tools/list   — advertises the single `permission_prompt` tool
//!   * tools/call   — invokes the tool; bridges to aura-shell over the
//!                    socket at `$AURA_SHELL_SOCK`
//!
//! Anything else gets a generic "method not found" error so claude
//! degrades gracefully.

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct Response {
    jsonrpc: &'static str,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Serialize)]
struct RpcError {
    code: i32,
    message: String,
}

fn ok(id: Value, result: Value) -> Response {
    Response {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
    }
}

fn err(id: Value, code: i32, message: impl Into<String>) -> Response {
    Response {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.into(),
        }),
    }
}

fn main() -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut reader = BufReader::new(stdin.lock());
    let mut buf = String::new();

    loop {
        buf.clear();
        let n = reader.read_line(&mut buf)?;
        if n == 0 {
            return Ok(()); // EOF — claude closed the pipe
        }
        let line = buf.trim();
        if line.is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                let resp = err(Value::Null, -32700, format!("parse error: {e}"));
                writeln!(out, "{}", serde_json::to_string(&resp).unwrap_or_default())?;
                out.flush()?;
                continue;
            }
        };
        if req.jsonrpc != "2.0" {
            let resp = err(req.id.unwrap_or(Value::Null), -32600, "expected jsonrpc 2.0");
            writeln!(out, "{}", serde_json::to_string(&resp).unwrap_or_default())?;
            out.flush()?;
            continue;
        }
        // Notifications (id-less) get no reply.
        let id = match req.id {
            Some(v) => v,
            None => continue,
        };
        let resp = handle(&req.method, &req.params, id);
        writeln!(out, "{}", serde_json::to_string(&resp).unwrap_or_default())?;
        out.flush()?;
    }
}

fn handle(method: &str, params: &Value, id: Value) -> Response {
    match method {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "aura-shell",
                    "version": env!("CARGO_PKG_VERSION"),
                }
            }),
        ),
        "tools/list" => ok(
            id,
            json!({
                "tools": [{
                    "name": "permission_prompt",
                    "description": "Approve or deny a tool call from the aura-shell UI.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "tool_name": { "type": "string" },
                            "input": { "type": "object" }
                        },
                        "required": ["tool_name", "input"]
                    }
                }]
            }),
        ),
        "tools/call" => handle_tools_call(params, id),
        _ => err(id, -32601, format!("method not found: {method}")),
    }
}

fn handle_tools_call(params: &Value, id: Value) -> Response {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if name != "permission_prompt" {
        return err(id, -32601, format!("unknown tool: {name}"));
    }
    let input = params.get("arguments").cloned().unwrap_or(Value::Null);
    let tool_name = input.get("tool_name").and_then(Value::as_str).unwrap_or("").to_string();
    let tool_input = input.get("input").cloned().unwrap_or(Value::Null);

    let sock_path = match env::var("AURA_SHELL_SOCK") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            return mcp_text_response(id, json!({
                "behavior": "deny",
                "message": "aura-shell socket not configured (AURA_SHELL_SOCK unset)"
            }))
        }
    };
    let channel = env::var("AURA_SHELL_CHANNEL").unwrap_or_default();

    match bridge_request(&sock_path, &channel, &tool_name, &tool_input) {
        Ok(resp) => mcp_text_response(id, resp),
        Err(e) => mcp_text_response(
            id,
            json!({
                "behavior": "deny",
                "message": format!("aura-shell bridge failed: {e}")
            }),
        ),
    }
}

/// Connect to the aura-shell UNIX socket, send the prompt envelope,
/// block waiting for the response. The protocol is line-delimited
/// JSON: one request line out, one response line back, connection
/// closes after.
fn bridge_request(
    sock_path: &str,
    channel: &str,
    tool_name: &str,
    tool_input: &Value,
) -> Result<Value, String> {
    let mut stream = UnixStream::connect(sock_path)
        .map_err(|e| format!("connect {sock_path}: {e}"))?;
    // No timeout on the response — the user might take a while to
    // click. Set a write timeout in case the listener wedged.
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("set write timeout: {e}"))?;

    let req = json!({
        "channel": channel,
        "tool_name": tool_name,
        "input": tool_input,
    });
    let mut payload = serde_json::to_vec(&req).map_err(|e| e.to_string())?;
    payload.push(b'\n');
    stream
        .write_all(&payload)
        .map_err(|e| format!("write: {e}"))?;
    stream.flush().map_err(|e| format!("flush: {e}"))?;

    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("read: {e}"))?;
    let resp: Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("parse response: {e}"))?;
    Ok(resp)
}

/// MCP `tools/call` returns content blocks. We pack the JSON envelope
/// into a `text` block — claude reads `behavior` from it.
fn mcp_text_response(id: Value, payload: Value) -> Response {
    ok(
        id,
        json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
            }],
            "isError": false
        }),
    )
}
