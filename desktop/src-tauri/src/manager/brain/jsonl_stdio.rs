//! Line-delimited JSON over a child process's stdio — the transport under
//! every agent protocol Aura speaks natively.
//!
//! Both engines we drive this way frame the same: one JSON object per line
//! on stdout, one per line on stdin, LF only. What differs is which lines
//! are *answers to something we asked* and which are the agent talking
//! unprompted:
//!
//! - ACP (`opencode acp`) is JSON-RPC 2.0. A reply carries `id` and no
//!   `method`; a `session/update` notification carries `method` and no
//!   `id`; and — the case a naive client gets wrong — the agent also sends
//!   us *requests* (`fs/read_text_file`, `session/request_permission`)
//!   which carry BOTH `id` and `method` and must be answered, not matched
//!   against our pending table.
//! - pi (`pi --mode rpc`) is its own shape: replies are
//!   `{"type":"response","command":…,"id":…}` and everything else is an
//!   event.
//!
//! So the classifier is injected. Everything else — correlation, cancel
//! safety, reaping the child, keeping the tail of stderr so a spawn
//! failure produces a sentence a human can act on — is shared.
//!
//! The child is killed when the last handle drops. A request whose child
//! dies mid-flight resolves to `Err` carrying that stderr tail rather than
//! hanging until a timeout, because "opencode exited: command not found"
//! is a bug report and a 60-second stall is not.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, broadcast, oneshot};

/// How many stderr lines to keep for diagnostics. Enough to carry a stack
/// trace or a "no API key" paragraph; bounded so a chatty agent can't grow
/// this without limit over a long session.
const STDERR_TAIL_LINES: usize = 40;

/// Ring buffer for the events channel. A turn that streams thousands of
/// deltas while nobody is subscribed simply drops them — `chat()`
/// subscribes *before* it prompts, so the window that matters is covered.
const EVENT_CHANNEL_CAP: usize = 1024;

/// What an inbound line turned out to be.
#[derive(Debug, Clone, PartialEq)]
pub enum Inbound {
    /// A reply to a request we sent, keyed by the id we chose.
    Response { id: String, body: Value },
    /// Anything else: notifications, streamed events, and agent→client
    /// requests. Agent→client requests land here on purpose — answering
    /// them is policy, and policy lives above the transport.
    Event(Value),
}

/// Decides whether a line answers one of our requests. Injected because
/// only the protocol layer knows its own shape.
pub type Classifier = fn(&Value) -> Inbound;

/// ACP: a line is a reply iff it has an `id` and no `method`. Agent→client
/// requests carry both and are events here, for the host layer to serve.
pub fn classify_jsonrpc(v: &Value) -> Inbound {
    let has_method = v.get("method").is_some();
    match (v.get("id"), has_method) {
        (Some(id), false) => Inbound::Response {
            id: id_to_string(id),
            body: v.clone(),
        },
        _ => Inbound::Event(v.clone()),
    }
}

/// pi rpc: `{"type":"response", "id":…}` answers a command; every other
/// `type` is an event. A response with no `id` (the client didn't ask for
/// correlation) is an event — there is nothing to match it to.
pub fn classify_pi_rpc(v: &Value) -> Inbound {
    if v.get("type").and_then(Value::as_str) == Some("response") {
        if let Some(id) = v.get("id") {
            return Inbound::Response {
                id: id_to_string(id),
                body: v.clone(),
            };
        }
    }
    Inbound::Event(v.clone())
}

/// JSON-RPC ids may be strings or numbers; we always send strings but must
/// match a peer that echoes `1` for `"1"`.
fn id_to_string(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Why a request didn't produce an answer.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("spawn {bin}: {source}")]
    Spawn {
        bin: String,
        #[source]
        source: std::io::Error,
    },
    #[error("write to {bin}: {source}")]
    Write {
        bin: String,
        #[source]
        source: std::io::Error,
    },
    /// The child exited (or its stdout closed) while we were waiting. The
    /// stderr tail is attached because it usually contains the reason.
    #[error("{bin} exited before answering{}", fmt_tail(.stderr_tail))]
    Exited { bin: String, stderr_tail: String },
}

fn fmt_tail(tail: &str) -> String {
    if tail.trim().is_empty() {
        String::new()
    } else {
        format!(": {tail}")
    }
}

/// A live child speaking line-delimited JSON.
pub struct JsonlChild {
    bin: String,
    stdin: Mutex<Option<tokio::process::ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    events: broadcast::Sender<Value>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    next_id: std::sync::atomic::AtomicU64,
    /// Kept so dropping the handle kills the process (`kill_on_drop`).
    _child: Mutex<tokio::process::Child>,
}

impl JsonlChild {
    /// Spawn `cmd` and start pumping its stdio. `cmd` is configured by the
    /// caller (args, cwd, env); stdio is overridden here because the whole
    /// point of this type is owning those three pipes.
    pub fn spawn(
        mut cmd: tokio::process::Command,
        bin: impl Into<String>,
        classify: Classifier,
    ) -> Result<Arc<Self>, TransportError> {
        let bin = bin.into();
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|source| TransportError::Spawn {
            bin: bin.clone(),
            source,
        })?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAP);
        let this = Arc::new(Self {
            bin: bin.clone(),
            stdin: Mutex::new(stdin),
            pending: Arc::new(Mutex::new(HashMap::new())),
            events,
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
            next_id: std::sync::atomic::AtomicU64::new(1),
            _child: Mutex::new(child),
        });

        if let Some(stderr) = stderr {
            let tail = this.stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = tail.lock().await;
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            });
        }

        if let Some(stdout) = stdout {
            let pending = this.pending.clone();
            let events = this.events.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // Agents print human noise on stdout sometimes (a
                    // banner, a warning). A line that isn't JSON is not a
                    // protocol error — it's someone else's println.
                    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                        tracing::debug!(target: "brain::jsonl", line = %truncate(trimmed), "non-JSON stdout line");
                        continue;
                    };
                    match classify(&value) {
                        Inbound::Response { id, body } => {
                            if let Some(tx) = pending.lock().await.remove(&id) {
                                let _ = tx.send(body);
                            } else {
                                // Late answer to a cancelled request.
                                tracing::debug!(target: "brain::jsonl", %id, "unmatched response");
                            }
                        }
                        Inbound::Event(v) => {
                            let _ = events.send(v);
                        }
                    }
                }
                // stdout closed: the child is done talking. Everyone still
                // waiting gets woken by their oneshot sender dropping.
                pending.lock().await.clear();
            });
        }

        Ok(this)
    }

    /// Events, notifications and agent→client requests, in arrival order.
    /// Subscribe *before* sending the request whose output you want.
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.events.subscribe()
    }

    /// The last lines the child wrote to stderr.
    pub async fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .await
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// A fresh correlation id, unique for the life of this child.
    pub fn next_id(&self) -> String {
        let n = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        n.to_string()
    }

    /// Write one JSON object as a line. Used for notifications and for
    /// answering the agent's own requests.
    pub async fn send_line(&self, value: &Value) -> Result<(), TransportError> {
        let mut buf = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
        buf.push(b'\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard.as_mut().ok_or_else(|| TransportError::Write {
            bin: self.bin.clone(),
            source: std::io::Error::new(std::io::ErrorKind::BrokenPipe, "stdin closed"),
        })?;
        stdin
            .write_all(&buf)
            .await
            .map_err(|source| TransportError::Write {
                bin: self.bin.clone(),
                source,
            })?;
        stdin
            .flush()
            .await
            .map_err(|source| TransportError::Write {
                bin: self.bin.clone(),
                source,
            })
    }

    /// Send a line carrying `id` and wait for the matching answer. Returns
    /// the whole envelope — protocol layers read `result`/`error`/`data`
    /// out of it themselves, since those differ per protocol.
    ///
    /// Cancel-safe: dropping the future removes the pending entry, so a
    /// late answer is discarded rather than delivered to the next caller.
    pub async fn request(&self, id: String, line: Value) -> Result<Value, TransportError> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        if let Err(e) = self.send_line(&line).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        let guard = PendingGuard {
            pending: self.pending.clone(),
            id,
        };
        match rx.await {
            Ok(body) => {
                std::mem::forget(guard);
                Ok(body)
            }
            // Sender dropped => the reader loop ended => the child is gone.
            Err(_) => Err(TransportError::Exited {
                bin: self.bin.clone(),
                stderr_tail: self.stderr_tail().await,
            }),
        }
    }
}

/// Removes a pending entry if the awaiting future is dropped before its
/// answer lands. Deliberately `mem::forget`-ed on the success path, where
/// the reader loop has already removed the entry.
struct PendingGuard {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let pending = self.pending.clone();
        let id = std::mem::take(&mut self.id);
        tokio::spawn(async move {
            pending.lock().await.remove(&id);
        });
    }
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= 200 {
        s.to_string()
    } else {
        s.chars().take(200).collect::<String>() + "…"
    }
}

/// Build a JSON-RPC 2.0 request envelope.
pub fn jsonrpc_request(id: &str, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// Build a JSON-RPC 2.0 success reply to an agent→client request.
pub fn jsonrpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Build a JSON-RPC 2.0 error reply. `code` follows the spec's ranges:
/// -32601 method not found, -32602 invalid params, -32603 internal.
pub fn jsonrpc_error(id: &Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonrpc_reply_is_a_response() {
        // Captured verbatim from `opencode acp` answering `initialize`.
        let v: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"OpenCode","version":"1.18.11"}}}"#,
        )
        .unwrap();
        assert_eq!(
            classify_jsonrpc(&v),
            Inbound::Response {
                id: "1".into(),
                body: v.clone()
            }
        );
    }

    #[test]
    fn jsonrpc_error_reply_is_a_response() {
        // Captured verbatim: prompting a session id that doesn't exist.
        let v: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Invalid params: session not found: REPLACE","data":{"sessionId":"REPLACE"}}}"#,
        )
        .unwrap();
        match classify_jsonrpc(&v) {
            Inbound::Response { id, .. } => assert_eq!(id, "3"),
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn session_update_notification_is_an_event() {
        let v: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_1","update":{"sessionUpdate":"agent_message_chunk"}}}"#,
        )
        .unwrap();
        assert!(matches!(classify_jsonrpc(&v), Inbound::Event(_)));
    }

    #[test]
    fn agent_to_client_request_is_an_event_not_a_response() {
        // The case that breaks a naive `has id => it's my answer` client:
        // the agent asking US to read a file. If this matched the pending
        // table it would resolve someone else's request with a request.
        let v: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":7,"method":"fs/read_text_file","params":{"sessionId":"ses_1","path":"/tmp/a.rs"}}"#,
        )
        .unwrap();
        assert!(matches!(classify_jsonrpc(&v), Inbound::Event(_)));
    }

    #[test]
    fn pi_response_matches_by_id() {
        // Captured verbatim from `pi --mode rpc`.
        let v: Value = serde_json::from_str(
            r#"{"id":"m","type":"response","command":"get_available_models","success":true,"data":{"models":[]}}"#,
        )
        .unwrap();
        match classify_pi_rpc(&v) {
            Inbound::Response { id, .. } => assert_eq!(id, "m"),
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn pi_events_are_events() {
        for line in [
            r#"{"type":"message_update","messageId":"m1","delta":{"type":"text","text":"hi"}}"#,
            r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash"}"#,
            r#"{"type":"agent_end"}"#,
            // A response with no id has nothing to correlate to.
            r#"{"type":"response","command":"abort","success":true}"#,
        ] {
            let v: Value = serde_json::from_str(line).unwrap();
            assert!(
                matches!(classify_pi_rpc(&v), Inbound::Event(_)),
                "should be an event: {line}"
            );
        }
    }

    #[test]
    fn numeric_and_string_ids_agree() {
        assert_eq!(id_to_string(&json!(12)), "12");
        assert_eq!(id_to_string(&json!("12")), "12");
    }

    #[test]
    fn envelopes_are_wellformed() {
        let req = jsonrpc_request("4", "session/prompt", json!({"sessionId": "s"}));
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["id"], "4");
        assert_eq!(req["method"], "session/prompt");

        let ok = jsonrpc_result(&json!(7), json!({"content": "x"}));
        assert_eq!(ok["id"], 7);
        assert!(ok.get("error").is_none());

        let err = jsonrpc_error(&json!(7), -32601, "no such method");
        assert_eq!(err["error"]["code"], -32601);
    }
}
