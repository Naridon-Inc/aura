//! One chat turn with an ACP agent, over the shared `aura-acp` client.
//!
//! The agent runs its own tools. This client serves no filesystem or
//! terminal; it answers permission and elicitation through Aura's prompt
//! cards, signs in through the agent's advertised methods, and cancels with
//! `session/cancel`. Updates travel to the renderer verbatim as
//! `acp_update` blocks.

use super::chat_acp_prompts::{sign_in_choice, sign_in_input, Gate, SignIn};
use super::{ChildRegistry, ExitInfo, ImageAttachment, StreamEvent};
use aura_acp::registry::Launch;
use aura_acp::schema::v1::{AGENT_METHOD_NAMES as AM, CLIENT_METHOD_NAMES as CM};
use aura_acp::session::prompt_blocks;
use aura_acp::{
    elicit, permission, AcpError, AuthMethod, ClientCaps, ClientInfo, ConnOpts, Connection, Driver, Inbound,
    OpenRequest, RpcError, Session, Update, UpdateKind,
};
use serde_json::{json, Value};
use std::future::Future;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

/// Handshake, session open and each setting change.
const SETUP_LIMIT: Duration = Duration::from_secs(60);
/// A protocol sign-in may open a browser and wait for the person.
const SIGN_IN_LIMIT: Duration = Duration::from_secs(300);
/// How long a cancelled prompt gets to wind down.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

pub(super) struct TurnSpec {
    pub agent_name: String,
    pub launch: Launch,
    /// Agent-specific CLI flags (Gemini takes linked folders this way).
    pub extra_args: Vec<String>,
    /// Linked folders for agents that accept `additionalDirectories`.
    pub additional_dirs: Vec<String>,
    pub cwd: String,
    pub prompt: String,
    pub resume: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub channel: String,
    pub turn: String,
    pub attachments: Vec<ImageAttachment>,
}

struct ProcessTree(u32);
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGTERM);
        }
    }
}

enum Stop {
    Cancelled,
    TimedOut,
    Failed(String),
    Acp(AcpError),
}

struct Ended {
    stop_reason: String,
    usage: Option<Value>,
}

struct Turn<'a> {
    app: AppHandle,
    spec: &'a TurnSpec,
    topic: String,
    conn: Connection,
    rx: aura_acp::conn::InboundRx,
    cancel: watch::Receiver<bool>,
    cancel_open: bool,
    cancelling: bool,
    gate: Gate,
    sid: Option<String>,
    /// The prompt is in flight: updates are this turn's output.
    live: bool,
    /// Updates that arrived before the session id was known.
    early: Vec<Value>,
    seq: u64,
}

pub(super) async fn run(app: AppHandle, spec: TurnSpec, cancel: watch::Receiver<bool>) {
    let started = Instant::now();
    let topic = format!("agent-stream:{}", spec.channel);
    let mut cmd = spec.launch.command();
    cmd.args(&spec.extra_args).current_dir(crate::spawn_dir::safe_spawn_dir(&spec.cwd));
    #[cfg(unix)]
    cmd.process_group(0);
    let ended = match Connection::spawn(cmd, ConnOpts::default()) {
        Err(e) => Err(Stop::Failed(format!("Could not start {}: {e}", spec.agent_name))),
        Ok((conn, rx)) => {
            let _tree = conn.child_id().map(ProcessTree);
            if let Some(pid) = conn.child_id() {
                app.state::<ChildRegistry>().set(&spec.channel, pid);
            }
            let mut turn = Turn {
                app: app.clone(),
                spec: &spec,
                topic: topic.clone(),
                conn: conn.clone(),
                rx,
                cancel,
                cancel_open: true,
                cancelling: false,
                gate: Gate::new(app.clone(), &spec.channel),
                sid: None,
                live: false,
                early: Vec::new(),
                seq: 0,
            };
            let ended = turn.drive().await;
            turn.gate.close();
            conn.close("turn finished");
            ended
        }
    };
    finish(&app, &spec, &topic, started, ended);
}

impl Turn<'_> {
    async fn drive(&mut self) -> Result<Ended, Stop> {
        let caps = ClientCaps { terminal_auth: true, elicitation_form: true, elicitation_url: true, ..Default::default() };
        let info = ClientInfo::aura(env!("CARGO_PKG_VERSION"));
        let driver = self.pump(Driver::initialize(self.conn.clone(), &info, &caps), Some(SETUP_LIMIT)).await?;
        let images: Vec<(String, String)> =
            self.spec.attachments.iter().map(|a| (a.media_type.clone(), a.data.clone())).collect();
        let blocks = prompt_blocks(&driver.agent, &self.spec.prompt, &images).map_err(Stop::Acp)?;
        let req = OpenRequest {
            cwd: self.spec.cwd.clone(),
            resume: self.spec.resume.clone(),
            additional_directories: if self.spec.extra_args.is_empty() { self.spec.additional_dirs.clone() } else { Vec::new() },
            mcp_servers: Vec::new(),
        };
        let mut session = match self.pump(driver.open(&req), Some(SETUP_LIMIT)).await {
            Err(Stop::Acp(AcpError::AuthRequired { methods, detail })) => {
                self.sign_in(&driver, methods, detail).await?;
                self.pump(driver.open(&req), Some(SETUP_LIMIT)).await?
            }
            other => other?,
        };
        self.opened(&session);
        if let Some(model) = self.spec.model.as_deref() {
            if !session.offers_model(model) {
                return Err(Stop::Failed(format!(
                    "Model {model} is not offered by this agent session. Clear the override to use its default."
                )));
            }
            if session.current_model().as_deref() != Some(model) {
                self.pump(driver.select_model(&mut session, model), Some(SETUP_LIMIT)).await?;
            }
        }
        if let Some(mode) = native_mode(&session, self.spec.permission_mode.as_deref()).map_err(Stop::Failed)? {
            self.pump(driver.select_mode(&mut session, &mode), Some(SETUP_LIMIT)).await?;
        }
        self.live = true;
        let outcome = match self.pump(driver.prompt(&session.id, blocks.clone()), None).await {
            Err(Stop::Acp(AcpError::AuthRequired { methods, detail })) => {
                self.live = false;
                self.sign_in(&driver, methods, detail).await?;
                self.live = true;
                self.pump(driver.prompt(&session.id, blocks), None).await?
            }
            other => other?,
        };
        Ok(Ended { stop_reason: outcome.stop_reason, usage: outcome.usage })
    }

    fn opened(&mut self, session: &Session) {
        self.sid = Some(session.id.clone());
        let _ = self.app.emit(
            &self.topic,
            StreamEvent::SystemInit {
                session_id: session.id.clone(),
                model: session.current_model(),
                tools: vec![],
                turn_id: self.spec.turn.clone(),
            },
        );
        self.block(json!({ "type": "acp_session", "session": session }));
        for params in std::mem::take(&mut self.early) {
            self.update(&params);
        }
    }

    /// Sign in once, then let the caller retry what needed it. A method the
    /// person picked before is tried first, without asking again.
    async fn sign_in(&mut self, driver: &Driver, methods: Vec<AuthMethod>, detail: String) -> Result<(), Stop> {
        let name = self.spec.agent_name.clone();
        let methods = if methods.is_empty() { driver.agent.auth_methods.clone() } else { methods };
        if methods.is_empty() {
            return Err(Stop::Failed(format!("{name} needs you to sign in, from its own terminal. Then send your message again.")));
        }
        let rid = self.spec.launch.registry_id.clone();
        let remembered = crate::acp_agents::remembered_sign_in(&rid)
            .filter(|m| methods.iter().any(|x| &x.id == m && !x.is_terminal()));
        if let Some(method) = remembered {
            match self.pump(driver.authenticate(&method), Some(SIGN_IN_LIMIT)).await {
                Ok(()) => return Ok(()),
                Err(Stop::Cancelled) => return Err(Stop::Cancelled),
                Err(_) => crate::acp_agents::remember_sign_in(&rid, None),
            }
        }
        let rx = self.gate.sign_in(sign_in_input(&name, &detail, &self.spec.launch, &methods));
        let answer = self.pump(async move { Ok::<_, AcpError>(rx.await.ok()) }, None).await?;
        match sign_in_choice(&methods, answer) {
            SignIn::Method(id) => {
                self.pump(driver.authenticate(&id), Some(SIGN_IN_LIMIT)).await?;
                crate::acp_agents::remember_sign_in(&rid, Some(&id));
                Ok(())
            }
            SignIn::InTerminal => {
                Err(Stop::Failed(format!("Finish signing in to {name} in the Terminal tab, then send your message again.")))
            }
            SignIn::Declined => Err(Stop::Failed(format!("{name} needs you to sign in before it can answer."))),
        }
    }

    /// Await `fut` while serving the agent: its updates, its requests, the
    /// person's answers, and the Stop button.
    async fn pump<T>(&mut self, fut: impl Future<Output = Result<T, AcpError>>, limit: Option<Duration>) -> Result<T, Stop> {
        tokio::pin!(fut);
        let sleep = tokio::time::sleep(limit.unwrap_or(Duration::from_secs(60 * 60 * 24 * 365)));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                r = &mut fut => {
                    return match r {
                        Ok(v) => Ok(v),
                        Err(_) if self.cancelling => Err(Stop::Cancelled),
                        Err(e) => Err(Stop::Acp(e)),
                    }
                }
                _ = &mut sleep => return Err(if self.cancelling { Stop::Cancelled } else { Stop::TimedOut }),
                changed = self.cancel.changed(), if self.cancel_open && !self.cancelling => {
                    if changed.is_err() {
                        self.cancel_open = false;
                        continue;
                    }
                    if !*self.cancel.borrow() {
                        continue;
                    }
                    self.cancelling = true;
                    for r in self.gate.cancel_all() {
                        let _ = self.conn.respond(&r.remote, r.result).await;
                    }
                    if !self.live {
                        return Err(Stop::Cancelled);
                    }
                    if let Some(sid) = &self.sid {
                        let _ = self.conn.notify(AM.session_cancel, json!({ "sessionId": sid })).await;
                    }
                    sleep.as_mut().reset(tokio::time::Instant::now() + CANCEL_GRACE);
                }
                Some(item) = self.rx.recv() => self.inbound(item).await,
                Some(reply) = self.gate.replies.recv() => {
                    if self.gate.resolve(&reply.remote) {
                        let _ = self.conn.respond(&reply.remote, reply.result).await;
                    }
                }
            }
        }
    }

    async fn inbound(&mut self, item: Inbound) {
        match item {
            Inbound::Notification { method, params, .. } if method == CM.session_update => {
                if self.sid.is_none() {
                    self.early.push(params);
                } else {
                    self.update(&params);
                }
            }
            Inbound::Request { id, method, params, .. } => {
                let reply = if method == CM.session_request_permission {
                    let ours = params.get("sessionId").and_then(Value::as_str) == self.sid.as_deref();
                    if self.cancelling || !ours {
                        Some(Ok(permission::result(permission::cancelled())))
                    } else {
                        self.gate.permission(id.clone(), &params);
                        None
                    }
                } else if method == CM.elicitation_create {
                    if self.cancelling {
                        Some(Ok(elicit::cancel()))
                    } else {
                        self.gate.elicitation(id.clone(), &params).map(|r| r.result)
                    }
                } else {
                    Some(Err(RpcError::method_not_found(&method)))
                };
                if let Some(r) = reply {
                    let _ = self.conn.respond(&id, r).await;
                }
            }
            Inbound::Diagnostic(text) => {
                self.block(json!({ "type": "diagnostic", "text": text }));
            }
            Inbound::Notification { .. } | Inbound::Detached | Inbound::Closed(_) => {}
        }
    }

    /// Pass one `session/update` on. Before the prompt runs, a reopened
    /// session may be replaying its history, which is already in this
    /// chat's log; only state (commands, mode, options, title, usage) passes.
    fn update(&mut self, params: &Value) {
        let Some(u) = Update::parse(params) else { return };
        if Some(u.session_id.as_str()) != self.sid.as_deref() || (!self.live && !is_state(&u.kind)) {
            return;
        }
        self.block(json!({ "type": "acp_update", "update": params["update"] }));
    }

    fn block(&mut self, payload: Value) {
        self.seq += 1;
        let _ = self.app.emit(
            &self.topic,
            StreamEvent::ContentBlock {
                event_id: format!("{}:acp:{}", self.spec.turn, self.seq),
                role: "assistant".into(),
                payload,
                turn_id: self.spec.turn.clone(),
            },
        );
    }
}

fn is_state(kind: &UpdateKind) -> bool {
    matches!(
        kind,
        UpdateKind::AvailableCommands | UpdateKind::CurrentMode | UpdateKind::ConfigOptions | UpdateKind::SessionInfo | UpdateKind::Usage
    )
}

/// Select only modes the session offers. Returning from Plan never picks a
/// permission-bypassing mode such as yolo or dontAsk.
fn native_mode(session: &Session, permission_mode: Option<&str>) -> Result<Option<String>, String> {
    let readonly = ["plan", "read-only", "readonly"];
    let normal = ["default", "code", "build", "agent"];
    let current = session.current_mode();
    let want_plan = permission_mode == Some("plan");
    let candidates = if want_plan {
        &readonly[..]
    } else if current.as_deref().is_some_and(|c| readonly.contains(&c)) {
        &normal[..]
    } else {
        return Ok(None);
    };
    match candidates.iter().find(|id| session.offers_mode(id)) {
        Some(id) if current.as_deref() == Some(*id) => Ok(None),
        Some(id) => Ok(Some((*id).to_string())),
        None if want_plan => Ok(None),
        None => Err("This session is still in Plan mode and offers no standard Agent mode. Change its mode in Terminal before continuing.".into()),
    }
}

/// Turn tokens from `PromptResponse.usage`: the sum over the turn's model
/// calls, cache reads and writes included.
fn turn_tokens(usage: &Value) -> Option<u64> {
    let n = |k: &str| usage.get(k).and_then(Value::as_u64);
    n("totalTokens").or_else(|| {
        let parts = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens"];
        let found: Vec<u64> = parts.iter().filter_map(|k| n(k)).collect();
        (!found.is_empty()).then(|| found.iter().sum())
    })
}

fn stop_message(reason: &str) -> Option<String> {
    match reason {
        "end_turn" | "cancelled" => None,
        "max_tokens" => Some("The agent hit its output limit before finishing.".into()),
        "max_turn_requests" => Some("The agent hit its limit of steps for one message.".into()),
        "refusal" => Some("The agent declined to continue.".into()),
        other => Some(format!("Agent stopped: {other}")),
    }
}

fn describe(spec: &TurnSpec, e: AcpError) -> String {
    let name = &spec.agent_name;
    match e {
        AcpError::Rpc(r) if r.code == -32002 && spec.resume.is_some() => {
            format!("{name} no longer has that conversation. Start a new chat to continue.")
        }
        AcpError::Rpc(r) if r.is_disconnected() => format!("{name} stopped before finishing. {}", r.detail()),
        AcpError::AuthRequired { .. } => format!("{name} needs you to sign in before it can answer."),
        AcpError::Unsupported(s) => s,
        other => format!("{name}: {other}"),
    }
}

fn finish(app: &AppHandle, spec: &TurnSpec, topic: &str, started: Instant, ended: Result<Ended, Stop>) {
    let turn = spec.turn.clone();
    // The turn's generated tokens feed the response footer; its context comes
    // from the agent's own `usage_update`, which knows the live window.
    if let Some(output) = ended.as_ref().ok().and_then(|e| e.usage.as_ref()).and_then(|u| u["outputTokens"].as_u64()) {
        let _ = app.emit(
            topic,
            StreamEvent::Usage {
                context_tokens: 0,
                output_tokens: output,
                message_id: format!("{turn}:acp-turn"),
                turn_id: turn.clone(),
            },
        );
    }
    let (success, message, cancelled, tokens) = match ended {
        Ok(e) => (true, stop_message(&e.stop_reason), e.stop_reason == "cancelled", e.usage.as_ref().and_then(turn_tokens)),
        Err(Stop::Cancelled) => (true, None, true, None),
        Err(Stop::TimedOut) => (
            false,
            Some(format!("{} did not answer in time. Check its sign-in and settings in Terminal, then retry.", spec.agent_name)),
            false,
            None,
        ),
        Err(Stop::Failed(m)) => (false, Some(m), false, None),
        Err(Stop::Acp(e)) => (false, Some(describe(spec, e)), false, None),
    };
    if cancelled {
        let _ = app.emit(
            topic,
            StreamEvent::ContentBlock {
                event_id: format!("{turn}:cancelled"),
                role: "assistant".into(),
                payload: json!({ "type": "turn_cancelled" }),
                turn_id: turn.clone(),
            },
        );
    } else {
        let _ = app.emit(
            topic,
            StreamEvent::Result {
                success,
                duration_ms: started.elapsed().as_millis() as u64,
                cost_usd: None,
                total_tokens: tokens,
                message,
                turn_id: turn.clone(),
            },
        );
    }
    let _ = app.emit(
        &format!("agent-stream-done:{}", spec.channel),
        ExitInfo { turn_id: turn, exit_code: if success { 0 } else { 1 } },
    );
}

#[cfg(test)]
mod chat_coverage_tests {
    use super::*;

    fn session(result: Value) -> Session {
        Session::from_result("s1".into(), aura_acp::Opened::New, &result)
    }

    #[test]
    fn plan_mode_can_return_to_agent_without_bypassing_permissions() {
        let mut r = json!({"modes":{"currentModeId":"default","availableModes":[{"id":"plan"},{"id":"default"},{"id":"yolo"}]}});
        assert_eq!(native_mode(&session(r.clone()), Some("plan")).unwrap().as_deref(), Some("plan"));
        assert_eq!(native_mode(&session(r.clone()), None).unwrap(), None);
        r["modes"]["currentModeId"] = json!("plan");
        assert_eq!(native_mode(&session(r.clone()), None).unwrap().as_deref(), Some("default"));
        assert_eq!(native_mode(&session(r.clone()), Some("plan")).unwrap(), None, "already in plan");
        r["modes"]["availableModes"] = json!([{"id":"plan"},{"id":"yolo"}]);
        assert!(native_mode(&session(r), None).is_err(), "never falls back to yolo");
        assert_eq!(native_mode(&session(json!({})), Some("plan")).unwrap(), None);
    }

    #[test]
    fn mode_config_option_counts_as_offered() {
        let r = json!({"configOptions":[{"id":"mode","category":"mode","type":"select","currentValue":"plan",
            "options":[{"value":"plan","name":"Plan"},{"value":"agent","name":"Agent"}]}]});
        assert_eq!(native_mode(&session(r), None).unwrap().as_deref(), Some("agent"));
    }

    #[test]
    fn turn_tokens_prefer_the_reported_total() {
        assert_eq!(turn_tokens(&json!({"totalTokens": 900, "inputTokens": 1})), Some(900));
        assert_eq!(turn_tokens(&json!({"inputTokens": 100, "outputTokens": 20, "cachedReadTokens": 5})), Some(125));
        assert_eq!(turn_tokens(&json!({})), None);
    }

    #[test]
    fn stop_reasons_read_plainly() {
        assert_eq!(stop_message("end_turn"), None);
        assert_eq!(stop_message("cancelled"), None);
        assert!(stop_message("max_tokens").unwrap().contains("output limit"));
        assert_eq!(stop_message("weird").as_deref(), Some("Agent stopped: weird"));
    }

    #[test]
    fn history_replay_is_held_back_but_state_passes() {
        assert!(is_state(&UpdateKind::AvailableCommands));
        assert!(is_state(&UpdateKind::Usage));
        assert!(!is_state(&UpdateKind::AgentMessageChunk));
        assert!(!is_state(&UpdateKind::ToolCall));
    }
}
