//! Loopback HTTP listener for the OSC 777 fallback channel — and the
//! synchronous agent-safety control plane.
//!
//! The primary path for cli-agent events is OSC 777 sequences emitted
//! to the PTY by the aura-claude / aura-gemini plugin scripts; the
//! shell's vte parser scrapes them out of the byte stream. That works
//! when the PTY is owned by Aura Shell. It does NOT work when:
//!
//!   * the user runs `claude` / `gemini` in their own Apple Terminal /
//!     iTerm window — Aura never sees those bytes.
//!   * the OSC parser misses a sequence under bursty output (rare but
//!     possible when the agent emits big tool blobs interleaved with
//!     OSC notifications).
//!
//! This module binds a tiny HTTP server on 127.0.0.1 (random port).
//! `aura-notify.sh` / `aura-notify-rpc.sh` POST the same JSON envelope
//! here when the `AURA_HOOK_NOTIFY_URL` env var is set. We re-emit
//! through the same `agent-event:<sid>` Tauri event channel that the
//! OSC path uses, so the renderer code path is identical and
//! de-duplication happens at the store level.
//!
//! Beyond observability, the loopback round-trip is a *synchronous
//! control plane*. Claude Code's lifecycle hooks honor the reply body:
//!   * we autonomously capture intent + snapshots on every event (so a
//!     coding agent that skips self-reporting still gets covered);
//!   * on `pre_tool_use` we run `aura validate-tool` and return a
//!     tiered allow / deny / ask verdict. An `ask` blocks the HTTP
//!     connection while a human confirms in the UI (up to 600s),
//!     failing CLOSED on timeout.
//!
//! Path shape: POST /agent-event/<session_id>
//! Body:       JSON matching `cmd_agent_pty::CliAgentEvent`
//!
//! The listener is intentionally hand-rolled (no axum/hyper) — payloads
//! are tiny and well-shaped, and we don't want a 50KB framework on a
//! socket that handles maybe a dozen events per agent turn.

use crate::cmd_agent_pty::{CliAgentEvent, CliAgentEventEnvelope};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

/// Tauri-managed state holding the listener's bound URL so
/// `cmd_agent_pty::agent_pty_open` can inject it into spawned PTY
/// children as `AURA_HOOK_NOTIFY_URL`. None until the listener has
/// successfully bound.
#[derive(Default)]
pub struct AgentEventListenerState {
    pub base_url: std::sync::RwLock<Option<String>>,
}

impl AgentEventListenerState {
    pub fn url_for_session(&self, session_id: &str) -> Option<String> {
        let base = self.base_url.read().ok()?.clone()?;
        Some(format!("{base}/agent-event/{session_id}"))
    }
}

/// What a resolved gate carries back to the awaiting connection: the
/// human's allow/deny decision plus an optional note shown as the deny
/// reason (or just recorded on allow).
pub type GateOutcome = (bool, Option<String>);

/// Tauri-managed registry of in-flight human gates. When `pre_tool_use`
/// classification returns `ask`, the listener parks the HTTP connection
/// on a oneshot receiver keyed by a freshly-minted `gate_id`, and emits
/// an `agent-gate-request` event the UI catches. The `agent_gate_resolve`
/// command pops the sender and answers, unblocking the connection.
#[derive(Default)]
pub struct GateRegistry {
    pending: Mutex<HashMap<String, oneshot::Sender<GateOutcome>>>,
}

impl GateRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a pending gate, returning the receiver the connection
    /// awaits. The sender is held under `gate_id` until resolved or
    /// dropped.
    fn register(&self, gate_id: String) -> oneshot::Receiver<GateOutcome> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(gate_id, tx);
        }
        rx
    }

    /// Remove a pending gate without answering it (cleanup on timeout /
    /// connection teardown). Dropping the sender wakes any waiter with a
    /// `RecvError`, which the await side treats as fail-closed.
    fn remove(&self, gate_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(gate_id);
        }
    }

    /// Answer a pending gate. Returns `Ok(())` if a waiter was found and
    /// the outcome delivered; `Err` if the gate id is unknown (already
    /// resolved, timed out, or never existed).
    pub fn resolve(&self, gate_id: &str, outcome: GateOutcome) -> Result<(), String> {
        let tx = {
            let mut map = self
                .pending
                .lock()
                .map_err(|_| "gate registry poisoned".to_string())?;
            map.remove(gate_id)
        };
        match tx {
            Some(tx) => tx
                .send(outcome)
                .map_err(|_| "gate waiter already gone".to_string()),
            None => Err(format!("no pending gate `{gate_id}`")),
        }
    }
}

/// Structured reply the hook reads off the loopback. Serialized with
/// camelCase keys so it matches Claude Code's PreToolUse output shape
/// (`additionalContext`, `permissionDecision`, `permissionDecisionReason`).
/// All fields are optional — an empty `{}` body means "no opinion → allow".
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct HookReply {
    #[serde(skip_serializing_if = "Option::is_none")]
    additional_context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_decision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_decision_reason: Option<String>,
}

/// Steering injected into every wrapped coding-agent session at SessionStart
/// (handed back as the hook's `additionalContext`). Tells the agent to reach
/// for Aura's Crew when work wants to fan out, instead of spawning its own
/// one-off subagents — so parallel work is durable, team-visible,
/// collision-aware, and proof-backed, and outlives the session that started
/// it. Injected for every repo the agent is launched in, not just this one.
const CREW_SESSION_GUIDANCE: &str = "\
Aura Crew is available here as your orchestration layer (the aura_crew_* MCP \
tools). When work wants to FAN OUT — several independent tasks, a migration \
across many files, a multi-agent push — drive it through Crew rather than \
spawning your own one-off subagents:\n\
  - aura_crew_plan to lay the tasks out as a dependency graph,\n\
  - aura_crew_ready then aura_crew_claim to pick up the next unblocked task,\n\
  - do the work, then aura_crew_complete (with the commit) or aura_crew_fail.\n\
Prefer Crew because its tasks are durable and team-visible (they show up on the \
Aura board and survive this session), collision-aware (Sentinel and zone claims \
keep parallel agents off each other's symbols), heterogeneous (Claude, Gemini \
and others can share one run), and proof-backed (each completion is tied to the \
goal it delivered). Reach for your own subagents only for a quick throwaway \
look that needs none of that.";

/// Payload broadcast to the UI when a tool call needs human confirmation.
/// FROZEN CONTRACT — the frontend (Lane D) depends on these exact field
/// names. camelCase via serde rename.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentGateRequest {
    gate_id: String,
    session_id: String,
    tool_name: String,
    /// `info` | `warn` | `danger`
    severity: String,
    title: String,
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diff: Option<String>,
    /// Structured delete-impact verdict from `aura validate-tool`
    /// (`details.impact`): which user-facing features the deletion breaks, the
    /// caller blast-radius, confidence, and the static-analysis hedge. Passed
    /// through verbatim so the gate card's impact panel can render it. `None`
    /// for non-deletion gates (commands, plain overwrites).
    #[serde(skip_serializing_if = "Option::is_none")]
    impact: Option<serde_json::Value>,
    created_at: u64,
}

/// The verdict line `aura validate-tool` writes to stdout.
#[derive(serde::Deserialize)]
struct ToolVerdict {
    decision: String,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    details: serde_json::Value,
}

/// Bind on 127.0.0.1:0 (kernel picks port) and spawn the accept loop.
/// Returns once bound — further work runs in tokio tasks. Bind
/// failures log to stderr and leave `base_url` as None; PTY spawn
/// then just doesn't set the env var, OSC stays the only channel,
/// nothing breaks.
pub async fn spawn(
    app: AppHandle,
    state: Arc<AgentEventListenerState>,
    gates: Arc<GateRegistry>,
) {
    let listener = match TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[agent-event] bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            eprintln!("[agent-event] local_addr failed: {e}");
            return;
        }
    };
    if let Ok(mut g) = state.base_url.write() {
        *g = Some(format!("http://127.0.0.1:{port}"));
    }
    eprintln!("[agent-event] listening on 127.0.0.1:{port}");

    tokio::spawn(async move {
        loop {
            let (mut sock, _peer) = match listener.accept().await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[agent-event] accept: {e}");
                    continue;
                }
            };
            let app = app.clone();
            let gates = gates.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_conn(&mut sock, &app, &gates).await {
                    eprintln!("[agent-event] conn: {e}");
                }
                let _ = sock.shutdown().await;
            });
        }
    });
}

/// Tauri command the UI calls to answer a pending human gate. Pops the
/// `gate_id` from the registry and delivers the human's decision + note
/// to the parked HTTP connection. Errors if the gate is unknown (already
/// resolved, timed out, or never existed) — the UI treats that as a stale
/// card to dismiss.
#[tauri::command]
pub async fn agent_gate_resolve(
    gate_id: String,
    allow: bool,
    note: Option<String>,
    gates: tauri::State<'_, Arc<GateRegistry>>,
) -> Result<(), String> {
    gates.resolve(&gate_id, (allow, note))
}

/// Bound conservatively — any cli-agent payload over 64KB is malformed
/// or hostile. Drop the connection rather than allocate.
const MAX_BODY: usize = 64 * 1024;

async fn handle_conn(
    sock: &mut tokio::net::TcpStream,
    app: &AppHandle,
    gates: &Arc<GateRegistry>,
) -> Result<(), String> {
    // Read until we have headers; cap at 8KB for the request line +
    // headers. Bodies follow Content-Length.
    let mut buf = Vec::with_capacity(2048);
    let mut tmp = [0u8; 1024];
    let header_end = loop {
        if buf.len() > 8192 {
            return Err("headers too big".into());
        }
        let n = sock.read(&mut tmp).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("eof during headers".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = find_header_end(&buf) {
            break p;
        }
    };

    let head = std::str::from_utf8(&buf[..header_end]).map_err(|_| "non-utf8 head")?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let mut content_length = 0usize;
    for line in lines {
        if let Some(rest) = line
            .strip_prefix("Content-Length:")
            .or_else(|| line.strip_prefix("content-length:"))
        {
            content_length = rest.trim().parse::<usize>().unwrap_or(0);
        }
    }
    if content_length > MAX_BODY {
        write_response(sock, 413, "payload too large").await?;
        return Ok(());
    }

    if method != "POST" {
        write_response(sock, 405, "method not allowed").await?;
        return Ok(());
    }
    let Some(session_id) = path.strip_prefix("/agent-event/") else {
        write_response(sock, 404, "not found").await?;
        return Ok(());
    };
    if session_id.is_empty() || session_id.contains('/') {
        write_response(sock, 400, "bad session id").await?;
        return Ok(());
    }
    let session_id = session_id.to_string();

    // Drain body — what we already read after header_end + 4 ("\r\n\r\n"),
    // then read remaining up to content_length.
    let body_start = header_end + 4;
    let mut body = if body_start < buf.len() {
        buf[body_start..].to_vec()
    } else {
        Vec::new()
    };
    while body.len() < content_length {
        let want = (content_length - body.len()).min(tmp.len());
        let n = sock
            .read(&mut tmp[..want])
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }

    let event: CliAgentEvent = match serde_json::from_slice(&body) {
        Ok(e) => e,
        Err(e) => {
            write_response(sock, 400, &format!("bad json: {e}")).await?;
            return Ok(());
        }
    };

    // Re-emit on the same channel the OSC path uses — the live UI depends
    // on this. Clone the event so we keep our own copy for the control
    // plane below.
    let envelope = CliAgentEventEnvelope {
        session_id: session_id.clone(),
        event: event.clone(),
    };
    let _ = app.emit(&format!("agent-event:{session_id}"), envelope);

    // ── Control plane ──────────────────────────────────────────────
    // `cwd` resolves the right repo for every shelled `aura` invocation.
    let cwd = event.cwd.clone();
    let kind = event.event.as_str();

    // Autonomous capture (fire-and-forget) — fixes the 40-60% skip where
    // the agent never self-reports intent. Every "real work" event lands
    // a row in .aura/intent_log.jsonl.
    if matches!(
        kind,
        "pre_tool_use" | "post_tool_use" | "user_prompt_submit" | "stop"
    ) {
        capture_intent(&event, &session_id, cwd.as_deref());
    }

    // Auto-snapshot on post_tool_use writes so `aura rewind` can recover.
    if kind == "post_tool_use" {
        if let Some(file) = wrote_file(&event) {
            snapshot_file(&file, cwd.as_deref());
        }
    }

    // The gate — only pre_tool_use blocks; everything else is "no opinion",
    // except SessionStart, where we hand the agent its Crew steering so it
    // reaches for Aura Crew on fan-out work instead of its own subagents.
    let reply = if kind == "pre_tool_use" {
        evaluate_gate(app, gates, &event, &session_id, &body, cwd.as_deref()).await
    } else if kind == "session_start" {
        HookReply {
            additional_context: Some(CREW_SESSION_GUIDANCE.to_string()),
            ..HookReply::default()
        }
    } else {
        HookReply::default()
    };

    write_json_response(sock, &reply).await
}

/// Build a concise human-readable summary and append an intent-log row by
/// shelling out to the `aura` CLI. Spawned detached — the reply never
/// waits on capture completing.
fn capture_intent(event: &CliAgentEvent, session_id: &str, cwd: Option<&str>) {
    let summary = summarize_event(event);
    if summary.is_empty() {
        return;
    }
    let bin = resolve_aura_bin();
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("log-intent")
        .arg(&summary)
        .arg("--source")
        .arg("hook_auto");
    if let Some(tool) = event.tool_name.as_deref().filter(|t| !t.is_empty()) {
        cmd.arg("--tool").arg(tool);
    }
    if let Some(file) = wrote_file(event) {
        cmd.arg("--file").arg(file);
    }
    if !session_id.is_empty() {
        cmd.arg("--session").arg(session_id);
    }
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // Fire-and-forget: spawn, don't wait. A reaper thread joins so we
    // don't leak zombies if the process is short-lived.
    if let Ok(mut child) = cmd.spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// `aura snapshot <file>` with `current_dir=cwd`, fire-and-forget, so a
/// post-write tool always has a durable pre-edit backup to rewind to.
fn snapshot_file(file: &str, cwd: Option<&str>) {
    let bin = resolve_aura_bin();
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg("snapshot").arg(file);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Ok(mut child) = cmd.spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// Run `aura validate-tool` against the full received body and turn its
/// verdict into a hook reply, escalating `ask` to a blocking human gate.
/// Fails OPEN (allow) on any validator/parse error so a validator bug can
/// never brick the agent — except the explicit human-`ask` timeout, which
/// fails CLOSED (deny).
async fn evaluate_gate(
    app: &AppHandle,
    gates: &Arc<GateRegistry>,
    event: &CliAgentEvent,
    session_id: &str,
    body: &[u8],
    cwd: Option<&str>,
) -> HookReply {
    let verdict = match run_validate_tool(body, cwd).await {
        Some(v) => v,
        // No verdict (spawn failed, malformed output, …) → fail open.
        None => return HookReply::default(),
    };

    match verdict.decision.as_str() {
        "deny" => HookReply {
            permission_decision: Some("deny".to_string()),
            permission_decision_reason: Some(verdict.reason.clone()),
            additional_context: None,
        },
        "ask" => human_gate(app, gates, event, session_id, &verdict).await,
        // "allow" and anything unexpected → allow. A short capture note
        // rides along so the agent's transcript shows Aura vetted it.
        _ => HookReply {
            permission_decision: Some("allow".to_string()),
            permission_decision_reason: Some(verdict.reason.clone()),
            additional_context: None,
        },
    }
}

/// Spawn `aura validate-tool`, pipe the full body to its stdin, and parse
/// the single verdict line from stdout. Bounded by a short timeout so a
/// wedged validator never holds the connection (the allow path must be
/// fast). Returns None on any failure → caller fails open.
async fn run_validate_tool(body: &[u8], cwd: Option<&str>) -> Option<ToolVerdict> {
    use tokio::io::AsyncWriteExt as _;
    use tokio::process::Command;

    let bin = resolve_aura_bin();
    let mut cmd = Command::new(&bin);
    cmd.arg("validate-tool")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().ok()?;
    if let Some(mut stdin) = child.stdin.take() {
        // Write may block if the child never drains; the outer timeout
        // bounds the whole interaction.
        let _ = stdin.write_all(body).await;
        let _ = stdin.shutdown().await;
        drop(stdin);
    }

    // validate-tool always exits 0 and prints one JSON line quickly. Cap
    // at 5s so a misbehaving validator can't stall the agent.
    let out = match tokio::time::timeout(Duration::from_secs(5), child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        _ => return None,
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty())?;
    serde_json::from_str::<ToolVerdict>(line.trim()).ok()
}

/// The blocking human-confirmation path. Registers a oneshot, broadcasts
/// an `agent-gate-request` the UI catches, then awaits the human's answer
/// for up to 600s. Resolved-true → allow; resolved-false → deny (with the
/// human's note if any); timeout / channel-drop → FAIL CLOSED (deny).
async fn human_gate(
    app: &AppHandle,
    gates: &Arc<GateRegistry>,
    event: &CliAgentEvent,
    session_id: &str,
    verdict: &ToolVerdict,
) -> HookReply {
    let gate_id = new_gate_id(session_id);
    let (file, command, diff) = extract_gate_fields(event, verdict);

    let payload = AgentGateRequest {
        gate_id: gate_id.clone(),
        session_id: session_id.to_string(),
        tool_name: event.tool_name.clone().unwrap_or_default(),
        severity: if verdict.severity.is_empty() {
            "warn".to_string()
        } else {
            verdict.severity.clone()
        },
        title: if verdict.title.is_empty() {
            "Confirm tool call".to_string()
        } else {
            verdict.title.clone()
        },
        reason: verdict.reason.clone(),
        file,
        command,
        diff,
        // Pass the validator's structured delete-impact through verbatim (null
        // when absent / non-deletion gate) so the card's impact panel renders.
        impact: verdict
            .details
            .get("impact")
            .filter(|v| !v.is_null())
            .cloned(),
        created_at: now_secs(),
    };

    let rx = gates.register(gate_id.clone());

    // Session-scoped (routes to the originating agent tab) AND bare (a
    // global host can catch any gate regardless of which tab is focused).
    let _ = app.emit(&format!("agent-gate-request:{session_id}"), payload.clone());
    let _ = app.emit("agent-gate-request", payload);

    // 600s MUST stay aligned with the PreToolUse hook `timeout` (hooks.json)
    // and the curl `--max-time` in on-pre-tool-use.sh, so no layer un-parks the
    // agent early and answers a socket the human's decision can never reach
    // (the "answered but never resumes" half of the modal-deadlock bug).
    let outcome = tokio::time::timeout(Duration::from_secs(600), rx).await;
    // Whatever happened, the entry must not linger. resolve() already
    // removed it on the happy path; this is the cleanup for timeout /
    // sender-dropped paths.
    gates.remove(&gate_id);

    // Tell the UI this gate is settled no matter HOW it ended — approved,
    // denied, timed out, or the parked connection dropped. Without this the
    // card had no way to learn the server gave up, so a late click hit a gate
    // that no longer existed and the modal wedged (only an app restart cleared
    // it). The frontend drops the matching card on this event.
    let closed_reason = match &outcome {
        Ok(Ok((true, _))) => "allowed",
        Ok(Ok((false, _))) => "denied",
        Ok(Err(_)) | Err(_) => "timeout",
    };
    let closed = serde_json::json!({ "gateId": gate_id, "reason": closed_reason });
    let _ = app.emit(&format!("agent-gate-closed:{session_id}"), closed.clone());
    let _ = app.emit("agent-gate-closed", closed);

    match outcome {
        Ok(Ok((true, _note))) => HookReply {
            permission_decision: Some("allow".to_string()),
            permission_decision_reason: Some("Approved by you.".to_string()),
            additional_context: None,
        },
        Ok(Ok((false, note))) => HookReply {
            permission_decision: Some("deny".to_string()),
            permission_decision_reason: Some(
                note.filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| "Denied by you.".to_string()),
            ),
            additional_context: None,
        },
        // Channel dropped (resolver vanished) → fail closed, same as timeout.
        Ok(Err(_)) | Err(_) => HookReply {
            permission_decision: Some("deny".to_string()),
            permission_decision_reason: Some(
                "Timed out waiting for confirmation — denied for safety. Re-run if intended."
                    .to_string(),
            ),
            additional_context: None,
        },
    }
}

/// Pull `file` / `command` / `diff` out of the event's `tool_input` (and,
/// secondarily, the verdict `details`) so the gate card can show the
/// concrete thing being gated.
fn extract_gate_fields(
    event: &CliAgentEvent,
    verdict: &ToolVerdict,
) -> (Option<String>, Option<String>, Option<String>) {
    let input = event.tool_input.as_ref();
    let details = &verdict.details;

    let str_field = |obj: Option<&serde_json::Value>, keys: &[&str]| -> Option<String> {
        let obj = obj?;
        for k in keys {
            if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    };

    let file = str_field(input, &["file_path", "path", "filePath", "notebook_path"])
        .or_else(|| str_field(Some(details), &["file", "path", "file_path"]));
    let command = str_field(input, &["command", "cmd"])
        .or_else(|| str_field(Some(details), &["command", "policy_command"]));

    // A "diff" preview: prefer an explicit diff field; else synthesize a
    // tiny before/after for Edit so the human sees what changes.
    let diff = str_field(input, &["diff", "patch"]).or_else(|| {
        let obj = input?;
        let old = obj.get("old_string").and_then(|v| v.as_str());
        let new = obj.get("new_string").and_then(|v| v.as_str());
        match (old, new) {
            (Some(o), Some(n)) => Some(format!("- {}\n+ {}", truncate(o, 800), truncate(n, 800))),
            _ => None,
        }
    });

    (file, command, diff)
}

/// Concise summary for the intent log, derived from the event shape.
fn summarize_event(event: &CliAgentEvent) -> String {
    match event.event.as_str() {
        "pre_tool_use" | "post_tool_use" => {
            let tool = event.tool_name.as_deref().unwrap_or("tool");
            let target = gate_target(event);
            let verb = if event.event == "pre_tool_use" {
                "running"
            } else {
                "ran"
            };
            match target {
                Some(t) => format!("{verb} {tool} on {t}"),
                None => format!("{verb} {tool}"),
            }
        }
        "user_prompt_submit" => {
            let q = event
                .query
                .as_deref()
                .or(event.summary.as_deref())
                .unwrap_or("");
            if q.is_empty() {
                "user prompt submitted".to_string()
            } else {
                format!("user prompt: {}", truncate(q, 160))
            }
        }
        "stop" => {
            let r = event
                .summary
                .as_deref()
                .or(event.response.as_deref())
                .unwrap_or("");
            if r.is_empty() {
                "agent turn complete".to_string()
            } else {
                format!("agent turn complete: {}", truncate(r, 160))
            }
        }
        other => format!("agent event: {other}"),
    }
}

/// Best target label for a tool event — the file it touched, or the
/// command it ran, or nothing.
fn gate_target(event: &CliAgentEvent) -> Option<String> {
    let input = event.tool_input.as_ref()?;
    for k in ["file_path", "path", "filePath", "notebook_path"] {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(file_label(s));
            }
        }
    }
    for k in ["command", "cmd"] {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(truncate(s, 120));
            }
        }
    }
    None
}

/// If this event wrote a file (Edit/Write/Create/MultiEdit/NotebookEdit),
/// return that path so we can snapshot / log it. None for read-only or
/// command tools.
fn wrote_file(event: &CliAgentEvent) -> Option<String> {
    let tool = event.tool_name.as_deref().unwrap_or("").to_lowercase();
    let writes = matches!(
        tool.as_str(),
        "write" | "edit" | "create" | "multiedit" | "notebookedit"
    );
    if !writes {
        return None;
    }
    let input = event.tool_input.as_ref()?;
    for k in ["file_path", "path", "filePath", "notebook_path"] {
        if let Some(s) = input.get(k).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// The `aura` binary every spawn in the shell goes through. Never a bare
/// `"aura"` handed to exec, and never a hardcoded dev path.
///
/// This used to take the first `aura` on PATH and stop there. That is the
/// wrong rule on a machine with more than one: an early-install
/// `/usr/local/bin/aura` at 0.4.6-alpha shadows a current `~/.cargo/bin/aura`,
/// and every passthrough in the app quietly runs the old one. The version
/// comparison now lives in `cmd_doctor_cli::resolve_runnable_aura`, next to
/// the constant it compares against.
///
/// `pub(crate)` and kept at this name because it is what thirty-odd call
/// sites already ask for — one resolver, one set of rules.
pub(crate) fn resolve_aura_bin() -> String {
    crate::cmd_doctor_cli::resolve_runnable_aura()
}

/// Mint a unique gate id. Uses uuid v4 (in-tree); the session id is
/// folded in so logs correlate the gate to its agent tab.
fn new_gate_id(session_id: &str) -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    let sid = session_id
        .chars()
        .take(8)
        .filter(|c| c.is_alphanumeric())
        .collect::<String>();
    if sid.is_empty() {
        uuid
    } else {
        format!("{sid}-{uuid}")
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Last path component, for compact verdict/summary text.
fn file_label(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Write a JSON 200 response carrying the structured hook reply. Empty /
/// `{}` body is the no-op "allow" signal the hook honors.
async fn write_json_response(
    sock: &mut tokio::net::TcpStream,
    reply: &HookReply,
) -> Result<(), String> {
    let body = serde_json::to_string(reply).unwrap_or_else(|_| "{}".to_string());
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

async fn write_response(
    sock: &mut tokio::net::TcpStream,
    code: u16,
    body: &str,
) -> Result<(), String> {
    let status = match code {
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "OK",
    };
    let resp = format!(
        "HTTP/1.1 {code} {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    sock.write_all(resp.as_bytes())
        .await
        .map_err(|e| e.to_string())
}
