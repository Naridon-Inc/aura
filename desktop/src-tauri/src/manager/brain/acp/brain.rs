//! `Brain` over ACP — an agent that keeps talking between turns.
//!
//! The shape of a turn:
//!
//! 1. Find or start a session for this working directory. Starting one
//!    means spawning the agent, `initialize`, then `session/new` — whose
//!    result hands back the agent's own model list, so nothing here has a
//!    hardcoded table of models to go stale.
//! 2. Work out what of the transcript this session hasn't heard
//!    ([`super::session`]). Usually that's one new user turn. If the
//!    transcript diverged, the session is abandoned and remade.
//! 3. Subscribe to the event feed *before* prompting, so no update can
//!    land in the gap between sending and listening.
//! 4. Stream `session/update` events out as `ChatChunk`s while serving
//!    whatever the agent asks of us — reads, writes, permission — through
//!    [`super::host`], which is where Aura's guards live.
//!
//! Dropping the returned stream cancels the turn (`session/cancel`) rather
//! than leaving the agent talking to a closed pipe.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::host::{AcpHost, HostPolicy};
use crate::manager::brain::session::{self, Delta, SessionState};
use super::wire::{self, AcpEvent, BlockCursor, ConfigChoice, ConfigOption, SessionInfo, method};
use crate::manager::brain::jsonl_stdio::{JsonlChild, classify_jsonrpc, jsonrpc_request};
use crate::manager::brain::types::{
    AgentMode, AgentSurface, BrainCapabilities, BrainError, ChatChunk, ChatMessage, ChatRequest,
    cap_keys,
};
use crate::manager::brain::Brain;

/// Provider ids look like `acp:opencode`.
pub const PROVIDER_PREFIX: &str = "acp:";

/// One agent Aura knows how to bring up over ACP.
///
/// This table is short on purpose. Several tools advertise an ACP mode;
/// an entry here means Aura has actually driven that mode end to end —
/// handshake, session, a streamed turn — not that the flag exists in
/// someone's docs. Listing an agent we haven't run would put a broken
/// row in the picker, which is worse than an absent one.
#[derive(Debug, Clone, Copy)]
pub struct AcpAgent {
    /// Registry id; the provider becomes `acp:<id>`.
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
    /// Arguments that put the binary into ACP mode.
    pub args: &'static [&'static str],
    pub blurb: &'static str,
}

pub const KNOWN_AGENTS: &[AcpAgent] = &[AcpAgent {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    args: &["acp"],
    blurb: "Its own models and login, with every edit through Aura's gate.",
}];

pub fn agent_by_id(id: &str) -> Option<&'static AcpAgent> {
    KNOWN_AGENTS.iter().find(|a| a.id == id)
}

/// Where an agent's binary actually is, or `None` if it isn't installed.
///
/// Not a bare `which`: Aura is normally launched from the Dock, where PATH
/// is launchd's four system directories, so an agent the user installed
/// with Homebrew or npm is invisible to it. That reads all the way through
/// as "not installed" — the agent is dropped from the picker, never probed
/// for its model list, and the composer shows a lone "Default" row. See
/// [`aura_agents::bin_resolve`].
fn resolved_bin(agent: &AcpAgent) -> Option<String> {
    aura_agents::bin_resolve::resolve(&[agent.bin])
}

/// The agents from [`KNOWN_AGENTS`] whose binary can actually be found.
/// The picker shows brains the user can run today; an agent they haven't
/// installed is not one of them.
pub fn descriptors_for_installed_agents() -> Vec<&'static AcpAgent> {
    KNOWN_AGENTS
        .iter()
        .filter(|a| resolved_bin(a).is_some())
        .collect()
}

/// How long to wait for the handshake and session setup. An agent that
/// hasn't answered `initialize` in this long is not going to.
const SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// What we learned about the agent once it was running. Everything here
/// is discovered, never assumed — an empty model list means "we haven't
/// asked yet", which is a truthful thing for the picker to show and a
/// fabricated list is not.
#[derive(Debug, Default, Clone)]
pub struct AgentFacts {
    pub vision: bool,
    pub models: Vec<ConfigChoice>,
    pub default_model: Option<String>,
    pub auth_methods: Vec<String>,
}

struct LiveSession {
    child: Arc<JsonlChild>,
    state: SessionState,
    host: Arc<AcpHost>,
    /// What the agent has published about this session — commands, modes,
    /// plan. Shared with the turn's stream, which is where the updates
    /// arrive, and read from outside by
    /// [`session_surface`](Brain::session_surface).
    surface: Arc<StdMutex<AgentSurface>>,
}

/// One ACP-speaking agent, wired in as a chat brain.
pub struct AcpBrain {
    provider_id: String,
    /// aura-agents registry id (`opencode`).
    agent_id: String,
    /// Executable + the arguments that put it into ACP mode.
    bin: String,
    args: Vec<String>,
    policy: Arc<dyn HostPolicy>,
    /// One session per working directory: two chats in the same worktree
    /// share an agent process, chats in different worktrees do not.
    sessions: Mutex<HashMap<String, LiveSession>>,
    facts: Arc<StdMutex<AgentFacts>>,
}

impl AcpBrain {
    pub fn new(
        agent_id: impl Into<String>,
        bin: impl Into<String>,
        args: Vec<String>,
        policy: Arc<dyn HostPolicy>,
    ) -> Self {
        let agent_id = agent_id.into();
        Self {
            provider_id: format!("{PROVIDER_PREFIX}{agent_id}"),
            agent_id,
            bin: bin.into(),
            args,
            policy,
            sessions: Mutex::new(HashMap::new()),
            facts: Arc::new(StdMutex::new(AgentFacts::default())),
        }
    }

    /// Build from a [`KNOWN_AGENTS`] entry.
    ///
    /// The binary is resolved here, not at spawn: when it was found outside
    /// PATH the resolver hands back an absolute path, and passing the bare
    /// name on would re-run the PATH search that already failed.
    pub fn from_agent(agent: &AcpAgent, policy: Arc<dyn HostPolicy>) -> Self {
        let bin = resolved_bin(agent).unwrap_or_else(|| agent.bin.to_string());
        Self::new(
            agent.id,
            &bin,
            agent.args.iter().map(|s| s.to_string()).collect(),
            policy,
        )
    }

    /// The OpenCode wiring: `opencode acp`.
    pub fn opencode(policy: Arc<dyn HostPolicy>) -> Self {
        Self::new("opencode", "opencode", vec!["acp".to_string()], policy)
    }

    pub fn facts(&self) -> AgentFacts {
        self.facts.lock().map(|f| f.clone()).unwrap_or_default()
    }

    /// Spawn the agent and complete the handshake.
    ///
    /// `pub(super)` so [`super::probe`] can bring an agent up just far
    /// enough to read its model list without taking a turn.
    pub(super) async fn spawn(&self, cwd: &str) -> Result<Arc<JsonlChild>, BrainError> {
        let mut cmd = tokio::process::Command::new(&self.bin);
        cmd.args(&self.args)
            .current_dir(crate::spawn_dir::safe_spawn_dir(cwd));

        let child = JsonlChild::spawn(cmd, self.bin.clone(), classify_jsonrpc).map_err(|e| {
            BrainError::Process {
                message: e.to_string(),
            }
        })?;

        let init = self
            .call(
                &child,
                method::INITIALIZE,
                json!({
                    "protocolVersion": wire::PROTOCOL_VERSION,
                    // `terminal: true` moves every command the agent runs
                    // out of its process and into ours, which is the only
                    // place Aura can gate it, hold it to the project root,
                    // and end it when the conversation does. Served by
                    // [`super::terminal`].
                    "clientCapabilities": wire::client_capabilities(),
                }),
            )
            .await?;

        if let Ok(mut facts) = self.facts.lock() {
            facts.vision = init
                .get("agentCapabilities")
                .and_then(|c| c.get("promptCapabilities"))
                .and_then(|p| p.get("image"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            facts.auth_methods = init
                .get("authMethods")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|m| m.get("id").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
        }

        Ok(child)
    }

    /// One request/response round trip, with the JSON-RPC error mapped
    /// onto a `BrainError` a human can read.
    async fn call(
        &self,
        child: &Arc<JsonlChild>,
        method_name: &str,
        params: Value,
    ) -> Result<Value, BrainError> {
        let id = child.next_id();
        let line = jsonrpc_request(&id, method_name, params);
        let body = tokio::time::timeout(SETUP_TIMEOUT, child.request(id, line))
            .await
            .map_err(|_| BrainError::Process {
                message: format!("{} timed out on {method_name}", self.bin),
            })?
            .map_err(|e| BrainError::Process {
                message: e.to_string(),
            })?;

        if let Some(err) = body.get("error") {
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string();
            // An agent that isn't logged in says so here. Surfacing it as
            // `AuthRequired` lets the picker offer the sign-in it already
            // knows how to run, instead of an API-key box the user has no
            // key for.
            if looks_like_auth(&message) {
                return Err(BrainError::AuthRequired { message });
            }
            return Err(BrainError::Api {
                status: err
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1)
                    .unsigned_abs() as u16,
                message,
            });
        }
        Ok(body.get("result").cloned().unwrap_or_else(|| json!({})))
    }

    /// Start a session and record what the agent advertised about it.
    pub(super) async fn open_session(
        &self,
        child: &Arc<JsonlChild>,
        cwd: &str,
    ) -> Result<SessionInfo, BrainError> {
        let result = self
            .call(
                child,
                method::SESSION_NEW,
                json!({ "cwd": crate::spawn_dir::safe_spawn_dir(cwd), "mcpServers": [] }),
            )
            .await?;

        let info = SessionInfo::parse(&result).ok_or_else(|| BrainError::Parse {
            message: "session/new returned no sessionId".into(),
        })?;

        if let (Ok(mut facts), Some(model)) = (self.facts.lock(), info.model_option()) {
            facts.models = model.options.clone();
            facts.default_model = model
                .current_value
                .as_ref()
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        Ok(info)
    }

    /// Point the session at a specific model, if the caller asked for one
    /// and it isn't already selected.
    /// Make sure a live session exists for `cwd_key`, spawning the agent
    /// and opening one if not. No-op when there already is one.
    ///
    /// Separate from [`chat`](Brain::chat) because a turn is not the only
    /// thing that needs a session: choosing plan mode before typing a word
    /// is a reasonable thing to do, and it is only meaningful if there is
    /// an agent there to be put into it. The caller holds the sessions
    /// lock, which is what keeps two of those racing to spawn.
    async fn ensure_session(
        &self,
        sessions: &mut HashMap<String, LiveSession>,
        cwd_key: &str,
    ) -> Result<(), BrainError> {
        if sessions.contains_key(cwd_key) {
            return Ok(());
        }
        let child = self.spawn(cwd_key).await?;
        let info = self.open_session(&child, cwd_key).await?;
        let host = Arc::new(AcpHost::new(
            cwd_key,
            info.session_id.clone(),
            self.policy.clone(),
        ));
        // The modes arrive with the session, in the same reply that carries
        // the model list. Commands and the plan come later, over the update
        // stream, if the agent has any.
        let surface = AgentSurface {
            modes: modes_from(info.mode_option()),
            current_mode: info
                .mode_option()
                .and_then(|o| o.current_value.as_ref())
                .and_then(Value::as_str)
                .map(str::to_string),
            ..AgentSurface::default()
        };
        sessions.insert(
            cwd_key.to_string(),
            LiveSession {
                child,
                state: SessionState::new(info.session_id),
                host,
                surface: Arc::new(StdMutex::new(surface)),
            },
        );
        Ok(())
    }

    async fn select_model(
        &self,
        child: &Arc<JsonlChild>,
        session_id: &str,
        model: &str,
    ) -> Result<(), BrainError> {
        self.call(
            child,
            method::SESSION_SET_CONFIG_OPTION,
            json!({ "sessionId": session_id, "optionId": "model", "value": model }),
        )
        .await
        .map(|_| ())
    }
}

/// Does this error message mean "you aren't signed in"? Matched on the
/// agent's own words because ACP has no dedicated auth error code.
fn looks_like_auth(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("auth")
        || m.contains("not logged in")
        || m.contains("no api key")
        || m.contains("api key found")
        || m.contains("login")
        || m.contains("sign in")
}

/// Flatten one Aura message into ACP prompt content blocks.
fn prompt_blocks(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in messages {
        match &m.content {
            Value::String(s) if !s.is_empty() => out.push(json!({"type": "text", "text": s})),
            Value::Array(blocks) => {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    out.push(json!({"type": "text", "text": t}));
                                }
                            }
                        }
                        // Images travel natively when the agent said it
                        // takes them; the caller has already checked the
                        // capability before attaching one.
                        Some("image") => {
                            let data = b
                                .get("source")
                                .and_then(|s| s.get("data"))
                                .or_else(|| b.get("data"))
                                .cloned();
                            let mime = b
                                .get("source")
                                .and_then(|s| s.get("media_type"))
                                .or_else(|| b.get("mimeType"))
                                .cloned();
                            if let (Some(data), Some(mime)) = (data, mime) {
                                out.push(json!({
                                    "type": "image", "data": data, "mimeType": mime
                                }));
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Cancels the agent's turn if the consumer walks away mid-stream.
struct TurnGuard {
    child: Arc<JsonlChild>,
    session_id: String,
    finished: bool,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let child = self.child.clone();
        let session_id = std::mem::take(&mut self.session_id);
        tokio::spawn(async move {
            let line = json!({
                "jsonrpc": "2.0",
                "method": method::SESSION_CANCEL,
                "params": { "sessionId": session_id },
            });
            let _ = child.send_line(&line).await;
        });
    }
}

#[async_trait]
impl Brain for AcpBrain {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    async fn session_surface(&self, cwd: &str) -> Option<AgentSurface> {
        let key = crate::spawn_dir::safe_spawn_dir(cwd)
            .to_string_lossy()
            .into_owned();
        let sessions = self.sessions.lock().await;
        let surface = sessions.get(&key)?.surface.lock().unwrap().clone();
        Some(surface)
    }

    async fn set_session_mode(&self, cwd: &str, mode: &str) -> Result<(), BrainError> {
        let key = crate::spawn_dir::safe_spawn_dir(cwd)
            .to_string_lossy()
            .into_owned();
        let (child, session_id, surface) = {
            let mut sessions = self.sessions.lock().await;
            // Starting the agent to answer this is the point. Picking plan
            // mode before the first message is exactly when it matters most
            // — that is the user saying "read, don't write" about the turn
            // they are *about* to send, and deferring it until they send it
            // would mean the first turn ran under the mode they rejected.
            self.ensure_session(&mut sessions, &key).await?;
            let live = sessions.get(&key).expect("just ensured");
            (
                live.child.clone(),
                live.state.session_id.clone(),
                live.surface.clone(),
            )
        };

        {
            let held = surface.lock().unwrap();
            if !held.modes.iter().any(|m| m.id == mode) {
                let offered = if held.modes.is_empty() {
                    "it has none".to_string()
                } else {
                    format!(
                        "it offers {}",
                        held.modes
                            .iter()
                            .map(|m| format!("`{}`", m.id))
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                return Err(BrainError::Other {
                    message: format!(
                        "{} has no mode called `{mode}` — {offered}.",
                        self.agent_id
                    ),
                });
            }
        }

        // The same call the model picker makes. `session/set_mode` is in
        // the protocol and in our method table, but the mode arrives as a
        // config option like any other, and this is the path the agent
        // has actually been observed to answer.
        self.call(
            &child,
            method::SESSION_SET_CONFIG_OPTION,
            json!({ "sessionId": session_id, "optionId": "mode", "value": mode }),
        )
        .await?;

        // Recorded only once the agent accepted it. The agent also
        // announces the change over the update stream, but not always
        // before the composer next reads the surface.
        surface.lock().unwrap().current_mode = Some(mode.to_string());
        Ok(())
    }

    fn capabilities(&self) -> BrainCapabilities {
        let facts = self.facts();
        let models: Vec<Value> = facts
            .models
            .iter()
            .map(|c| c.value.clone())
            .collect();
        BrainCapabilities::default()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            // Not a claim any more: tool calls arrive as real events and
            // render as real cards.
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(cap_keys::SUPPORTS_VISION, facts.vision)
            .with(
                cap_keys::DEFAULT_MODEL,
                json!(facts.default_model.unwrap_or_default()),
            )
            .with(cap_keys::SUPPORTED_MODELS, json!(models))
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let cwd_key = crate::spawn_dir::safe_spawn_dir(&request.cwd)
            .to_string_lossy()
            .into_owned();

        let mut sessions = self.sessions.lock().await;

        // This brain outlives the turn now, so its agents would otherwise
        // outlive the conversations too. Anything abandoned goes here — a
        // turn arriving is the only clock this needs.
        for closed in session::sweep_idle(&mut sessions, &cwd_key, |live| &live.state) {
            tracing::debug!(target: "brain::acp", agent = %self.agent_id, cwd = %closed, "closed an idle agent");
        }

        // Does the live session (if any) still match the transcript?
        let reuse = match sessions.get(&cwd_key) {
            Some(live) => !matches!(live.state.delta(&request.messages), Delta::Restart),
            None => false,
        };
        if !reuse {
            // Dropping the entry kills the child: a session whose history
            // no longer exists has nothing left to say.
            sessions.remove(&cwd_key);
        }

        self.ensure_session(&mut sessions, &cwd_key).await?;

        let live = sessions
            .get_mut(&cwd_key)
            .expect("just inserted or already present");
        let session_id = live.state.session_id.clone();
        let child = live.child.clone();
        let host = live.host.clone();
        let surface = live.surface.clone();

        // Per-turn model override rides through to the agent's own
        // selector, which is the same control its UI uses.
        if let Some(model) = request.model.as_deref() {
            if live.state.model.as_deref() != Some(model) {
                self.select_model(&child, &session_id, model).await?;
                live.state.model = Some(model.to_string());
            }
        }

        let to_send = match live.state.delta(&request.messages) {
            Delta::Append(msgs) => msgs,
            // Handled above by dropping the session; a fresh one has heard
            // nothing, so this arm is the whole transcript.
            Delta::Restart => request.messages.clone(),
        };
        live.state.mark_delivered(&request.messages);
        drop(sessions);

        let blocks = prompt_blocks(&to_send);
        if blocks.is_empty() {
            // Nothing new to say. Ending cleanly beats prompting an agent
            // with an empty message and rendering whatever it invents.
            return Ok(Box::pin(futures_util::stream::once(async {
                Ok(ChatChunk::End {
                    stop_reason: Some("end_turn".into()),
                })
            })));
        }

        // Subscribe BEFORE prompting: an agent that answers quickly can
        // emit its first chunk before `request()` has even returned.
        let mut events = child.subscribe();

        let req_id = child.next_id();
        let line = jsonrpc_request(
            &req_id,
            method::SESSION_PROMPT,
            json!({ "sessionId": session_id, "prompt": blocks }),
        );
        let prompt_child = child.clone();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = done_tx.send(prompt_child.request(req_id, line).await);
        });

        let stream_session_id = session_id.clone();
        let bin_label = self.bin.clone();
        let stream = try_stream! {
            let mut guard = TurnGuard {
                child: child.clone(),
                session_id: stream_session_id.clone(),
                finished: false,
            };
            let mut cursor = BlockCursor::default();
            let mut done_rx = done_rx;
            // Carried out of the `select!` because `?` can't be used inside
            // one of its arms — the arm body isn't the enclosing try block.
            let mut outcome: Option<Result<Value, String>> = None;

            loop {
                tokio::select! {
                    biased;

                    incoming = events.recv() => {
                        match incoming {
                            Ok(value) => {
                                for chunk in handle_inbound(
                                    &value,
                                    &stream_session_id,
                                    &host,
                                    &child,
                                    &mut cursor,
                                    &surface,
                                ) {
                                    yield chunk;
                                }
                            }
                            // Lagged: the agent out-ran our buffer. Say so
                            // rather than silently dropping its output.
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!(target: "brain::acp", dropped = n, "event backlog overflowed");
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }

                    finished = &mut done_rx => {
                        // The turn's reply landed. Anything already queued
                        // ahead of it is still ours to deliver.
                        while let Ok(value) = events.try_recv() {
                            for chunk in handle_inbound(
                                &value,
                                &stream_session_id,
                                &host,
                                &child,
                                &mut cursor,
                                &surface,
                            ) {
                                yield chunk;
                            }
                        }
                        guard.finished = true;
                        outcome = Some(match finished {
                            Ok(Ok(body)) => Ok(body),
                            Ok(Err(e)) => Err(e.to_string()),
                            Err(_) => Err("prompt task dropped".to_string()),
                        });
                        break;
                    }
                }
            }

            match outcome {
                Some(Ok(body)) => {
                    if let Some(err) = body.get("error") {
                        let message = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("prompt failed")
                            .to_string();
                        Err(if looks_like_auth(&message) {
                            BrainError::AuthRequired { message }
                        } else {
                            BrainError::Api { status: 0, message }
                        })?;
                    }
                    let result = body.get("result").cloned().unwrap_or_else(|| json!({}));
                    yield ChatChunk::End { stop_reason: wire::stop_reason(&result) };
                }
                Some(Err(message)) => Err(BrainError::Process { message })?,
                // The event feed closed before the agent answered — the
                // process died mid-turn. Its stderr is the real story.
                None => Err(BrainError::Process {
                    message: format!("{} ended mid-turn: {}", bin_label, child.stderr_tail().await),
                })?,
            }
        };

        Ok(Box::pin(stream))
    }
}

/// Turn one inbound line into chunks, serving it first if the agent was
/// asking us for something. Returns the chunks to yield (usually zero or
/// one) so the caller's `try_stream!` stays readable.
fn handle_inbound(
    value: &Value,
    session_id: &str,
    host: &Arc<AcpHost>,
    child: &Arc<JsonlChild>,
    cursor: &mut BlockCursor,
    surface: &Arc<StdMutex<AgentSurface>>,
) -> Vec<ChatChunk> {
    // The agent asking us to read, write, or ask the human. Served off
    // the pumping loop so a permission prompt the user leaves on screen
    // for a minute doesn't stall the rest of the stream.
    if AcpHost::is_agent_request(value) {
        let host = host.clone();
        let child = child.clone();
        let req = value.clone();
        tokio::spawn(async move {
            host.serve(&child, &req).await;
        });
        return Vec::new();
    }

    if value.get("method").and_then(Value::as_str) != Some(method::SESSION_UPDATE) {
        return Vec::new();
    }
    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));
    // A child could host more than one session; only ours belongs in this
    // transcript.
    if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
        if sid != session_id {
            return Vec::new();
        }
    }
    let Some(update) = params.get("update") else {
        return Vec::new();
    };

    match wire::map_session_update_with(update, cursor, host.as_ref()) {
        AcpEvent::Chunk(c) => vec![c],
        // Palette, mode and plan updates are session metadata, not
        // transcript. Carrying them as chat text would put the agent's
        // command list in the conversation, so they go to the session
        // surface instead, where the composer reads them.
        AcpEvent::Commands(commands) => {
            surface.lock().unwrap().commands = commands;
            Vec::new()
        }
        AcpEvent::ModeChanged(mode) => {
            surface.lock().unwrap().current_mode = Some(mode);
            Vec::new()
        }
        AcpEvent::Plan(entries) => {
            // Restated in full on every change, so this replaces rather
            // than appends — the agent's current plan, not its history of
            // plans.
            surface.lock().unwrap().plan = entries;
            Vec::new()
        }
        AcpEvent::Ignored => Vec::new(),
    }
}

/// The modes an agent offers, read off the `mode` config option it
/// returned when the session opened. Absent for an agent that has none,
/// which is most of them.
fn modes_from(option: Option<&ConfigOption>) -> Vec<AgentMode> {
    option
        .map(|o| {
            o.options
                .iter()
                .filter_map(|choice| {
                    Some(AgentMode {
                        id: choice.value.as_str()?.to_string(),
                        name: choice.name.clone(),
                        description: choice.description.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Allows everything and snapshots nothing — for the live test below,
    /// which never lets the agent get as far as touching a file.
    struct AllowAll;

    #[async_trait]
    impl HostPolicy for AllowAll {
        async fn ask_permission(&self, _: &str, _: &Value) -> super::super::host::GateDecision {
            super::super::host::GateDecision::Allow
        }
        async fn before_write(&self, _: &std::path::Path, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
    }

    /// The whole path against a real agent: spawn, handshake, open a
    /// session, read the model list it publishes, and take a turn.
    ///
    /// Ignored by default because it needs `opencode` on PATH. Run with
    /// `cargo test -- --ignored a_real_opencode_agent`.
    ///
    /// It deliberately does NOT assert that a turn succeeds — that needs
    /// the user's own OpenCode login, and spending someone's credit is
    /// not a test's business. What it asserts is that an unauthenticated
    /// turn fails *legibly*: as `AuthRequired`, so the picker offers a
    /// sign-in rather than an API-key box.
    #[tokio::test]
    #[ignore = "spawns the real `opencode acp` binary"]
    async fn a_real_opencode_agent_publishes_its_models_and_takes_a_turn() {
        let dir = std::env::temp_dir().join("aura-acp-live");
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();

        let brain = AcpBrain::opencode(Arc::new(AllowAll));

        // 1. Handshake.
        let child = brain.spawn(&cwd).await.expect("opencode acp starts");
        let facts = brain.facts();
        assert!(
            !facts.auth_methods.is_empty(),
            "the agent should advertise how to sign in"
        );

        // 2. A session, and with it the agent's own model list — the
        //    thing `cli_wrapper` had to hardcode.
        let info = brain
            .open_session(&child, &cwd)
            .await
            .expect("session/new succeeds");
        assert!(!info.session_id.is_empty());
        let model = info
            .model_option()
            .expect("the agent publishes a model option");
        assert!(
            !model.options.is_empty(),
            "the model picker should be populated by the agent, not by us"
        );
        assert!(brain.facts().default_model.is_some());
        drop(child);

        // 3. A full turn through `Brain::chat`.
        use futures_util::StreamExt;
        let request = ChatRequest {
            messages: vec![ChatMessage {
                role: "user".into(),
                content: json!([{"type": "text", "text": "say hi"}]),
            }],
            cwd: cwd.clone(),
            ..Default::default()
        };
        match brain.chat(request).await {
            Ok(stream) => {
                let chunks: Vec<_> = stream.collect().await;
                assert!(!chunks.is_empty(), "a turn must yield something");
                // Unauthenticated here: the last chunk should be an error
                // that names the auth problem, or a clean end if the
                // machine running this IS logged in.
                let last = chunks.last().unwrap();
                match last {
                    Ok(ChatChunk::End { .. }) => {}
                    Err(BrainError::AuthRequired { .. }) => {}
                    Err(BrainError::Api { message, .. }) => {
                        assert!(
                            looks_like_auth(message),
                            "an unauthenticated turn should fail as an auth problem, got: {message}"
                        );
                    }
                    other => panic!("unexpected end of turn: {other:?}"),
                }
            }
            Err(BrainError::AuthRequired { .. }) => {}
            Err(e) => panic!("chat failed for a non-auth reason: {e}"),
        }
    }

    /// The modes the composer's chip drives, read from the real agent.
    ///
    /// Everything else about the mode control is unit-tested against a
    /// list we wrote down, which proves the narrowing and proves nothing
    /// about whether OpenCode publishes modes at all, under that name, in
    /// that reply. This is the part only the agent can answer.
    ///
    /// Ignored by default because it needs `opencode` on PATH. Costs
    /// nothing to run: `session/new` carries the mode list the same way it
    /// carries the model list, so no prompt is sent and no credit spent.
    #[tokio::test]
    #[ignore = "spawns the real `opencode acp` binary"]
    async fn a_real_opencode_agent_publishes_the_modes_the_chip_switches() {
        let dir = std::env::temp_dir().join("aura-acp-live-modes");
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();

        let brain = AcpBrain::opencode(Arc::new(AllowAll));
        let child = brain.spawn(&cwd).await.expect("opencode acp starts");
        let info = brain
            .open_session(&child, &cwd)
            .await
            .expect("session/new succeeds");

        let option = info
            .mode_option()
            .expect("the agent publishes a mode option alongside the model one");
        let modes = modes_from(Some(option));
        assert!(
            modes.iter().any(|m| m.id == "plan"),
            "the read-only mode the chip promises must exist; got {:?}",
            modes.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(
            modes.len() > 1,
            "a mode picker with one entry is not a picker; got {:?}",
            modes.iter().map(|m| &m.id).collect::<Vec<_>>()
        );
        assert!(
            option
                .current_value
                .as_ref()
                .and_then(Value::as_str)
                .is_some(),
            "the agent should say which mode it starts in, so the chip \
             opens showing the truth rather than a guess"
        );
    }

    #[test]
    fn auth_failures_are_recognised_from_what_agents_actually_say() {
        // pi's real refusal, captured from `pi --mode rpc`.
        assert!(looks_like_auth(
            "No API key found for the selected model.\n\nUse /login to log into a provider"
        ));
        // OpenCode's advertised method.
        assert!(looks_like_auth("Run `opencode auth login` in the terminal"));
        assert!(looks_like_auth("Authentication required"));
        // And a plain protocol error is not an auth problem.
        assert!(!looks_like_auth("session not found: REPLACE"));
        assert!(!looks_like_auth("Invalid params"));
    }

    #[test]
    fn prompt_blocks_carry_text_from_both_content_shapes() {
        let msgs = vec![
            ChatMessage {
                role: "user".into(),
                content: json!("plain string"),
            },
            ChatMessage {
                role: "user".into(),
                content: json!([{"type": "text", "text": "block form"}]),
            },
        ];
        let blocks = prompt_blocks(&msgs);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "plain string");
        assert_eq!(blocks[1]["text"], "block form");
    }

    #[test]
    fn empty_text_never_becomes_an_empty_block() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: json!([{"type": "text", "text": ""}]),
        }];
        assert!(prompt_blocks(&msgs).is_empty());
    }

    #[test]
    fn anthropic_shaped_images_are_translated_for_acp() {
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: json!([{
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}
            }]),
        }];
        let blocks = prompt_blocks(&msgs);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["mimeType"], "image/png");
        assert_eq!(blocks[0]["data"], "AAAA");
    }

    #[test]
    fn tool_results_are_not_replayed_as_prompt_text() {
        // A tool_result block belongs to the agent's own loop; sending it
        // back as prompt text would read as the user quoting output.
        let msgs = vec![ChatMessage {
            role: "user".into(),
            content: json!([{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
        }];
        assert!(prompt_blocks(&msgs).is_empty());
    }

    #[test]
    fn capabilities_start_honest_and_stay_honest() {
        struct NoPolicy;
        #[async_trait]
        impl HostPolicy for NoPolicy {
            async fn ask_permission(&self, _: &str, _: &Value) -> super::super::host::GateDecision {
                super::super::host::GateDecision::Deny
            }
            async fn before_write(&self, _: &std::path::Path, _: Option<&str>) -> Result<(), String> {
                Ok(())
            }
        }

        let brain = AcpBrain::opencode(Arc::new(NoPolicy));
        assert_eq!(brain.provider_id(), "acp:opencode");

        let caps = brain.capabilities();
        // Tool use is real here, unlike the CLI wrapper's advertisement.
        assert_eq!(caps.bool(cap_keys::SUPPORTS_TOOL_USE), Some(true));
        assert_eq!(caps.bool(cap_keys::SUPPORTS_STREAMING), Some(true));
        // Nothing is claimed about models before the agent has been asked.
        assert_eq!(caps.get(cap_keys::SUPPORTED_MODELS), Some(&json!([])));
        assert_eq!(caps.bool(cap_keys::SUPPORTS_VISION), Some(false));

        // Once a session has reported its options, the picker shows the
        // agent's own list.
        {
            let mut facts = brain.facts.lock().unwrap();
            facts.models = vec![ConfigChoice {
                value: json!("opencode/big-pickle"),
                name: "OpenCode Zen/Big Pickle".into(),
                description: None,
            }];
            facts.default_model = Some("opencode/big-pickle".into());
            facts.vision = true;
        }
        let caps = brain.capabilities();
        assert_eq!(
            caps.get(cap_keys::SUPPORTED_MODELS),
            Some(&json!(["opencode/big-pickle"]))
        );
        assert_eq!(
            caps.get(cap_keys::DEFAULT_MODEL),
            Some(&json!("opencode/big-pickle"))
        );
        assert_eq!(caps.bool(cap_keys::SUPPORTS_VISION), Some(true));
    }
}
