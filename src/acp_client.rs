//! ACP (Agent Client Protocol) client — S1-P sub-task 4.
//!
//! Zed's open protocol for editor ↔ agent communication over stdio JSON-RPC.
//! Spec: https://github.com/zed-industries/agent-client-protocol
//!
//! Aura acts as the *client* side here: spawn an external agent
//! (claude-code --acp, gemini --acp, or any ACP-compliant CLI) as a
//! subprocess, handshake, open a session, send a prompt, and stream the
//! `session/update` notifications the agent emits back to the caller.
//!
//! This is deliberately a thin shim — we speak ACP at the JSON-RPC layer
//! without pulling in the upstream `agent-client-protocol` crate, because:
//!   * No new Cargo dependency (easier to review, smaller attack surface).
//!   * Keeps the message body as `serde_json::Value` so Aura's semantic
//!     layer (pr-review, impact detection) can inspect arbitrary update
//!     payloads without the client having to model every ContentBlock
//!     variant up front.
//!
//! When the surface stabilizes (post-S1-P), we may swap this for the
//! upstream crate — the public API here is intentionally small so that
//! migration stays local.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

/// Events surfaced to callers. Streams arrive on `poll_update`. Non-ACP
/// stderr output bubbles as `Stderr` so callers can log it without having
/// to tap the subprocess themselves.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    /// A `session/update` notification. `payload` is the ACP update object
    /// (commonly contains `sessionId` + `update.sessionUpdate` +
    /// `update.content.text`). Pass-through as `Value`.
    SessionUpdate { payload: Value },
    /// A generic JSON-RPC response for a request we sent (response to
    /// `initialize`, `session/new`, or `session/prompt`).
    RpcResponse { id: Value, result: Option<Value>, error: Option<Value> },
    /// A line arrived on the subprocess's stderr. Non-fatal.
    Stderr { line: String },
    /// The subprocess's stdout closed. No more events after this.
    Closed,
}

/// Handle to a running ACP subprocess.
pub struct AcpSession {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<AcpEvent>,
    next_id: u64,
    session_id: Option<String>,
}

/// Blocking spawn of an ACP agent. Stdin/stdout are piped so we can
/// exchange newline-delimited JSON-RPC frames; stderr is piped so we can
/// surface diagnostic output to the caller without polluting our own.
pub fn spawn(cmd: &str, args: &[String]) -> Result<AcpSession, String> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {}: {}", cmd, e))?;

    let stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<AcpEvent>();

    // stdout reader thread: split on lines, parse each as JSON-RPC, emit
    // as SessionUpdate (if notification with method=session/update) or
    // RpcResponse (if has id+result/error) or drop.
    let tx_out = tx.clone();
    thread::spawn(move || read_stdout(stdout, tx_out));

    // stderr reader thread: line-by-line relay.
    if let Some(err) = stderr {
        let tx_err = tx.clone();
        thread::spawn(move || read_stderr(err, tx_err));
    }

    Ok(AcpSession {
        child,
        stdin: Some(stdin),
        rx,
        next_id: 1,
        session_id: None,
    })
}

fn read_stdout(stdout: ChildStdout, tx: mpsc::Sender<AcpEvent>) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            // Some agents print non-JSON banners before ACP starts.
            // Surface those as stderr so the caller at least sees them.
            Err(_) => {
                let _ = tx.send(AcpEvent::Stderr { line: format!("(non-json stdout) {}", line) });
                continue;
            }
        };

        // Notification (no id): only care about session/update.
        if value.get("id").is_none() {
            if value.get("method").and_then(|m| m.as_str()) == Some("session/update") {
                let payload = value.get("params").cloned().unwrap_or(Value::Null);
                if tx.send(AcpEvent::SessionUpdate { payload }).is_err() {
                    break;
                }
            }
            continue;
        }

        // Response (has id).
        let id = value.get("id").cloned().unwrap_or(Value::Null);
        let result = value.get("result").cloned();
        let error = value.get("error").cloned();
        if tx.send(AcpEvent::RpcResponse { id, result, error }).is_err() {
            break;
        }
    }
    let _ = tx.send(AcpEvent::Closed);
}

fn read_stderr<R: std::io::Read + Send + 'static>(r: R, tx: mpsc::Sender<AcpEvent>) {
    let reader = BufReader::new(r);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if tx.send(AcpEvent::Stderr { line }).is_err() {
            break;
        }
    }
}

impl AcpSession {
    fn write_frame(&mut self, frame: &Value) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or_else(|| "stdin closed".to_string())?;
        let line = serde_json::to_string(frame).map_err(|e| e.to_string())?;
        writeln!(stdin, "{}", line).map_err(|e| format!("write: {}", e))?;
        stdin.flush().map_err(|e| format!("flush: {}", e))?;
        Ok(())
    }

    fn next_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// `initialize` request — ACP handshake. Returns the agent's response
    /// body (capabilities + agent info).
    pub fn initialize(&mut self, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id();
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {},
                    "terminal": false
                }
            }
        });
        self.write_frame(&frame)?;
        self.await_response(id, timeout)
    }

    /// `session/new` — open a new conversation session on the agent side.
    /// Stores the session id so subsequent prompts can reference it.
    pub fn session_new(&mut self, timeout: Duration) -> Result<String, String> {
        let id = self.next_id();
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "/".to_string());
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/new",
            "params": {
                "cwd": cwd,
                "mcpServers": []
            }
        });
        self.write_frame(&frame)?;
        let result = self.await_response(id, timeout)?;
        let sid = result
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("session/new result missing sessionId: {}", result))?
            .to_string();
        self.session_id = Some(sid.clone());
        Ok(sid)
    }

    /// `session/prompt` — send a user prompt. Returns when the agent's
    /// terminal response arrives OR `timeout` elapses, whichever first.
    /// Each `session/update` notification that streams in before the
    /// final response is forwarded to `on_update`, so callers can
    /// render partial output live.
    pub fn prompt<F>(
        &mut self,
        text: &str,
        timeout: Duration,
        mut on_update: F,
    ) -> Result<Value, String>
    where
        F: FnMut(&Value),
    {
        let sid = self
            .session_id
            .clone()
            .ok_or_else(|| "no session — call session_new first".to_string())?;
        let id = self.next_id();
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": sid,
                "prompt": [
                    {"type": "text", "text": text}
                ]
            }
        });
        self.write_frame(&frame)?;
        self.await_response_streaming(id, timeout, &mut on_update)
    }

    fn await_response(&mut self, id: u64, timeout: Duration) -> Result<Value, String> {
        self.await_response_streaming(id, timeout, &mut |_| {})
    }

    fn await_response_streaming<F: FnMut(&Value)>(
        &mut self,
        id: u64,
        timeout: Duration,
        on_update: &mut F,
    ) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err(format!("timeout waiting for response id={}", id));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(remaining.min(Duration::from_millis(250))) {
                Ok(AcpEvent::RpcResponse { id: rid, result, error }) => {
                    let matches = match &rid {
                        Value::Number(n) => n.as_u64() == Some(id),
                        Value::String(s) => s.parse::<u64>().ok() == Some(id),
                        _ => false,
                    };
                    if !matches {
                        continue;
                    }
                    if let Some(err) = error {
                        return Err(format!("agent error: {}", err));
                    }
                    return Ok(result.unwrap_or(Value::Null));
                }
                Ok(AcpEvent::SessionUpdate { payload }) => {
                    on_update(&payload);
                }
                Ok(AcpEvent::Stderr { line: _ }) => {
                    // Callers can tap stderr separately; here we just drop
                    // so it doesn't interfere with request/response pairing.
                }
                Ok(AcpEvent::Closed) => {
                    return Err("agent stdout closed before response".to_string());
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("event channel disconnected".to_string());
                }
            }
        }
    }

    /// Drain pending events without blocking. Useful after `prompt`
    /// returns to surface any trailing updates the agent emitted.
    pub fn drain_pending(&mut self) -> Vec<AcpEvent> {
        let mut out = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(ev) => out.push(ev),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }
        out
    }

    /// Close stdin and wait for the subprocess to exit, killing it if it
    /// doesn't terminate within `timeout`.
    pub fn shutdown(mut self, timeout: Duration) -> Result<(), String> {
        drop(self.stdin.take());
        let deadline = Instant::now() + timeout;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = self.child.kill();
                        return Err("agent did not exit; killed".to_string());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("wait: {}", e)),
            }
        }
    }
}
