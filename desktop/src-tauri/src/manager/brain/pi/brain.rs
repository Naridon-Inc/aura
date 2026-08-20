//! `Brain` over pi's RPC mode.
//!
//! Same destination as the ACP brain, opposite starting point. ACP hands
//! the client the file operations, so Aura's guards sit in the path by
//! construction. pi keeps its tools and runs them itself, so there is
//! nothing to intercept — only something to *permit*. The whole design
//! follows from that:
//!
//! - A one-file extension ([`GATE_SOURCE`]) is written to disk at spawn and
//!   loaded with `-e`. It hooks `tool_call`, which fires before the tool
//!   runs and can block, and forwards the question here.
//! - [`decide`] answers it, applying the two rules the ACP host applies:
//!   a path outside the session root is refused, and a write is snapshotted
//!   before it happens. What the extension gets back is either `allow` or
//!   the sentence explaining the refusal, which pi then shows the model.
//! - Everything else is the same machinery ACP uses — [`JsonlChild`] for the
//!   transport, [`SessionState`] for matching a stateless `ChatRequest`
//!   onto a process that remembers, [`gate::HostPolicy`] for the human.
//!
//! A turn ends on `agent_settled`, not `agent_end`: `agent_end` fires
//! before an automatic retry or a queued follow-up, and stopping there
//! would cut the answer off mid-thought.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use async_stream::try_stream;
use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use super::wire::{
    self, BlockCursor, GATE_ALLOW, GateAsk, PiEvent, PiModel, ToolEffect, command,
};
use crate::manager::brain::Brain;
use crate::manager::brain::gate::{self, GateDecision, HostPolicy};
use crate::manager::brain::jsonl_stdio::{JsonlChild, classify_pi_rpc};
use crate::manager::brain::session::{self, Delta, SessionState};
use crate::manager::brain::types::{
    BrainCapabilities, BrainError, ChatChunk, ChatRequest, cap_keys,
};

/// The provider id in the picker. pi is one agent, not a family, so it
/// needs no prefix.
pub const PROVIDER_ID: &str = "pi";
pub const BIN: &str = "pi";
pub const LABEL: &str = "pi";
pub const BLURB: &str = "Its own models and login, with every tool call through Aura's gate.";

/// The extension that carries pi's tool calls to Aura's gate. Compiled in
/// so it can never drift from the code that answers it.
const GATE_SOURCE: &str = include_str!("aura-gate.ts");

/// Long enough for a cold `pi --mode rpc` to come up and answer; short
/// enough that a wedged binary doesn't hold a chat turn open.
const SETUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// True if pi is on PATH. The picker only lists brains the user can run.
pub fn is_installed() -> bool {
    std::process::Command::new("which")
        .arg(BIN)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Where the gate extension is written. Stable rather than temporary so a
/// user can read the file that is gating their agent, and so a crashed
/// session doesn't leave litter behind under a fresh name each time.
pub fn gate_extension_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".aura")
        .join("pi")
        .join("aura-gate.ts")
}

/// Write the gate extension, returning where it landed.
///
/// Rewritten on every spawn: the file on disk must be the one this build
/// knows how to answer, and an older Aura's copy would leave pi asking
/// questions in a shape we no longer parse.
async fn install_gate_extension() -> Result<PathBuf, BrainError> {
    let path = gate_extension_path();
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| BrainError::Process {
                message: format!("could not create {}: {e}", dir.display()),
            })?;
    }
    tokio::fs::write(&path, GATE_SOURCE)
        .await
        .map_err(|e| BrainError::Process {
            message: format!("could not write Aura's pi gate to {}: {e}", path.display()),
        })?;
    Ok(path)
}

struct LiveSession {
    child: Arc<JsonlChild>,
    state: SessionState,
    root: PathBuf,
}

/// pi, wired in as a chat brain.
pub struct PiBrain {
    policy: Arc<dyn HostPolicy>,
    /// One process per working directory, as with ACP: two chats in the
    /// same worktree share an agent, chats in different ones do not.
    sessions: Mutex<HashMap<String, LiveSession>>,
    models: Arc<StdMutex<Vec<PiModel>>>,
}

impl PiBrain {
    pub fn new(policy: Arc<dyn HostPolicy>) -> Self {
        Self {
            policy,
            sessions: Mutex::new(HashMap::new()),
            models: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    /// The models pi told us it can run. Empty until a session has been
    /// opened — and legitimately empty after that if pi has no provider
    /// configured, which the picker renders as its single default row.
    pub fn models(&self) -> Vec<PiModel> {
        self.models.lock().map(|m| m.clone()).unwrap_or_default()
    }

    /// Spawn `pi --mode rpc` with Aura's gate attached.
    pub(super) async fn spawn(&self, cwd: &str) -> Result<Arc<JsonlChild>, BrainError> {
        let extension = install_gate_extension().await?;
        let mut cmd = tokio::process::Command::new(BIN);
        cmd.args(wire::RPC_ARGS)
            .arg("-e")
            .arg(&extension)
            .current_dir(crate::spawn_dir::safe_spawn_dir(cwd));

        JsonlChild::spawn(cmd, BIN, classify_pi_rpc).map_err(|e| BrainError::Process {
            message: e.to_string(),
        })
    }

    /// One command round trip, with pi's in-band failure mapped onto a
    /// `BrainError` a human can read.
    pub(super) async fn call(
        &self,
        child: &Arc<JsonlChild>,
        command: &str,
        extra: Value,
    ) -> Result<Value, BrainError> {
        let id = child.next_id();
        let line = wire::rpc_command(&id, command, extra);
        let body = tokio::time::timeout(SETUP_TIMEOUT, child.request(id, line))
            .await
            .map_err(|_| BrainError::Process {
                message: format!("pi timed out on {command}"),
            })?
            .map_err(|e| BrainError::Process {
                message: e.to_string(),
            })?;

        wire::response_result(&body).map_err(|message| {
            if looks_like_auth(&message) {
                BrainError::AuthRequired { message }
            } else {
                BrainError::Api { status: 0, message }
            }
        })
    }

    /// Ask pi what it can run and remember the answer.
    pub(super) async fn refresh_models(&self, child: &Arc<JsonlChild>) {
        let Ok(data) = self.call(child, command::GET_AVAILABLE_MODELS, json!({})).await else {
            return;
        };
        if let Ok(mut slot) = self.models.lock() {
            *slot = wire::parse_models(&data);
        }
    }

    /// Point pi at a specific model. The picker carries one string, so the
    /// `provider/id` pair is split back out here.
    async fn select_model(&self, child: &Arc<JsonlChild>, model: &str) -> Result<(), BrainError> {
        let (provider, model_id) = wire::split_model_id(model).ok_or_else(|| BrainError::Api {
            status: 0,
            message: format!(
                "{model} isn't a model pi can select — it expects a provider and a model id."
            ),
        })?;
        self.call(
            child,
            command::SET_MODEL,
            json!({ "provider": provider, "modelId": model_id }),
        )
        .await
        .map(|_| ())
    }
}

/// Does this message mean "you aren't signed in"? pi has no dedicated
/// error code for it, so the wording is what we have.
fn looks_like_auth(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("no models available")
        || m.contains("/login")
        || m.contains("api key")
        || m.contains("not logged in")
        || m.contains("unauthorized")
}

/// Answer one gate question.
///
/// The two rules are the ones [`crate::manager::brain::acp::host`] applies
/// to an ACP agent, restated for an engine that acts on its own:
///
/// 1. **A path outside the session root is refused.** pi reads and writes
///    without asking us to, so this is the only moment the root can be
///    enforced at all.
/// 2. **A write is snapshotted first**, and a snapshot that fails blocks
///    the write. An overwrite `aura rewind` cannot undo is worse than a
///    refused edit.
///
/// Reads inside the root run without a card. They change nothing, and a
/// prompt per file listing would train the user to click through the ones
/// that matter.
pub(super) async fn decide(
    policy: &Arc<dyn HostPolicy>,
    session_id: &str,
    root: &Path,
    ask: &GateAsk,
) -> Result<(), String> {
    let effect = wire::tool_effect(&ask.tool);

    if let Some(named) = wire::target_path(&ask.input) {
        let path = resolve_within(root, named)?;
        if effect == ToolEffect::Write {
            // `None`, not a guess: pi edits in place and tells us the path
            // it is about to touch, never the text it is about to write.
            // The capabilities that need the new content are skipped here
            // rather than answered from imagination — they are caught at
            // commit time by the deletion guard, which has the real symbol
            // index this shallow reader does not.
            gate::guard_write(policy, session_id, &path, None).await?;
        }
    }

    if effect == ToolEffect::Read {
        return Ok(());
    }

    match policy.ask_permission(&ask.tool, &ask.input).await {
        GateDecision::Allow | GateDecision::AllowAlways => Ok(()),
        GateDecision::Deny => Err(format!(
            "You do not have permission to run {} here. Aura asked and the answer was no.",
            ask.tool
        )),
    }
}

/// Resolve a path the agent named and refuse anything that escapes the
/// session root. `..` is resolved lexically because the file a write names
/// usually does not exist yet, so it cannot be canonicalised.
fn resolve_within(root: &Path, named: &str) -> Result<PathBuf, String> {
    let joined = if Path::new(named).is_absolute() {
        PathBuf::from(named)
    } else {
        root.join(named)
    };

    let mut normalised = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                normalised.pop();
            }
            std::path::Component::CurDir => {}
            other => normalised.push(other.as_os_str()),
        }
    }

    // Both sides have to be resolved the same way or the comparison is
    // meaningless: on macOS the root canonicalises to `/private/var/…`
    // while a file that does not exist yet stays `/var/…`, and every write
    // in the session looks like an escape.
    let root = gate::resolve_symlinks(root);
    let candidate = gate::resolve_symlinks(&normalised);

    if candidate.starts_with(&root) {
        return Ok(candidate);
    }
    Err(format!(
        "{} is outside {}, the folder this conversation is working in. Aura does not let an \
         agent reach past it.",
        candidate.display(),
        root.display()
    ))
}

/// Aborts pi's turn if the consumer walks away mid-stream.
struct TurnGuard {
    child: Arc<JsonlChild>,
    finished: bool,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let child = self.child.clone();
        tokio::spawn(async move {
            let _ = child
                .send_line(&json!({ "type": command::ABORT }))
                .await;
        });
    }
}

#[async_trait]
impl Brain for PiBrain {
    fn provider_id(&self) -> &str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> BrainCapabilities {
        let models = self.models();
        BrainCapabilities::default()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            // pi's `prompt` takes images; whether the selected model reads
            // them is the model's business, and it says so in its own row.
            .with(cap_keys::SUPPORTS_VISION, true)
            .with(
                cap_keys::DEFAULT_MODEL,
                json!(models.first().map(|m| m.id.clone()).unwrap_or_default()),
            )
            .with(
                cap_keys::SUPPORTED_MODELS,
                json!(models.iter().map(|m| m.id.clone()).collect::<Vec<_>>()),
            )
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let root = crate::spawn_dir::safe_spawn_dir(&request.cwd);
        let cwd_key = root.to_string_lossy().into_owned();

        let mut sessions = self.sessions.lock().await;

        // This brain outlives the turn now, so its agents would otherwise
        // outlive the conversations too. Anything abandoned goes here — a
        // turn arriving is the only clock this needs.
        for closed in session::sweep_idle(&mut sessions, &cwd_key, |live| &live.state) {
            tracing::debug!(target: "brain::pi", cwd = %closed, "closed an idle agent");
        }

        let reuse = match sessions.get(&cwd_key) {
            Some(live) => !matches!(live.state.delta(&request.messages), Delta::Restart),
            None => false,
        };
        if !reuse {
            // Dropping the entry kills the child. A session whose history
            // the user has thrown away has nothing left to say.
            sessions.remove(&cwd_key);
        }

        if !sessions.contains_key(&cwd_key) {
            let child = self.spawn(&cwd_key).await?;
            self.refresh_models(&child).await;
            sessions.insert(
                cwd_key.clone(),
                LiveSession {
                    child,
                    state: SessionState::new(&cwd_key),
                    root: root.clone(),
                },
            );
        }

        let live = sessions
            .get_mut(&cwd_key)
            .expect("just inserted or already present");
        let child = live.child.clone();
        let root = live.root.clone();

        if let Some(model) = request.model.as_deref() {
            if live.state.model.as_deref() != Some(model) {
                self.select_model(&child, model).await?;
                live.state.model = Some(model.to_string());
            }
        }

        let to_send = match live.state.delta(&request.messages) {
            Delta::Append(msgs) => msgs,
            Delta::Restart => request.messages.clone(),
        };
        live.state.mark_delivered(&request.messages);
        drop(sessions);

        let (text, images) = wire::prompt_payload(&to_send);
        if text.is_empty() && images.is_empty() {
            return Ok(Box::pin(futures_util::stream::once(async {
                Ok(ChatChunk::End {
                    stop_reason: Some("end_turn".into()),
                })
            })));
        }

        // Subscribe BEFORE prompting: pi starts streaming as soon as it
        // accepts, which can be before the acceptance reaches us.
        let mut events = child.subscribe();

        let mut params = json!({ "message": text });
        if !images.is_empty() {
            params["images"] = json!(images);
        }
        // `prompt` answers on acceptance, not on completion — the turn ends
        // at `agent_settled`. A rejection here is still worth failing on.
        self.call(&child, command::PROMPT, params).await?;

        let policy = self.policy.clone();
        // Who this run is, for sentinel zones. pi keys a session on its
        // working directory — two chats in one worktree share an agent
        // process — so that is honestly the finest grain there is here.
        // It can never collide with a zone the desktop or a CLI claimed,
        // which is the property that matters: a zone somebody else holds
        // must hold against this agent.
        let session_id = cwd_key.clone();
        let stream = try_stream! {
            let mut guard = TurnGuard { child: child.clone(), finished: false };
            let mut cursor = BlockCursor::default();

            loop {
                match events.recv().await {
                    Ok(value) => {
                        match wire::map_event(&value, &mut cursor) {
                            PiEvent::Chunk(c) => yield c,
                            PiEvent::Settled => {
                                guard.finished = true;
                                break;
                            }
                            PiEvent::Gate(ask) => {
                                // Answered off the pumping loop: a card the
                                // user leaves on screen must not stall the
                                // rest of the stream.
                                let policy = policy.clone();
                                let child = child.clone();
                                let root = root.clone();
                                let session_id = session_id.clone();
                                tokio::spawn(async move {
                                    let verdict = match decide(&policy, &session_id, &root, &ask).await {
                                        Ok(()) => GATE_ALLOW.to_string(),
                                        Err(reason) => reason,
                                    };
                                    let _ = child
                                        .send_line(&wire::gate_answer(&ask.id, &verdict))
                                        .await;
                                });
                            }
                            PiEvent::ForeignDialog { id } => {
                                // Someone else's extension is asking a
                                // human a question Aura has no window for.
                                // Dismissing beats answering it blind.
                                tracing::debug!(target: "brain::pi", %id, "dismissed a dialog Aura did not raise");
                                let _ = child.send_line(&wire::dismiss_dialog(&id)).await;
                            }
                            PiEvent::Ignored => {}
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(target: "brain::pi", dropped = n, "event backlog overflowed");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        // pi's stdout closed before the run settled: it
                        // died mid-turn, and its stderr is the real story.
                        Err(BrainError::Process {
                            message: format!("pi ended mid-turn: {}", child.stderr_tail().await),
                        })?;
                    }
                }
            }

            yield ChatChunk::End { stop_reason: Some("end_turn".into()) };
        };

        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Records what the gate asked of it, in order.
    struct Recorder {
        decision: GateDecision,
        snapshot_fails: bool,
        calls: StdMutex<Vec<String>>,
    }

    impl Recorder {
        fn new(decision: GateDecision) -> Arc<Self> {
            Arc::new(Self {
                decision,
                snapshot_fails: false,
                calls: StdMutex::new(Vec::new()),
            })
        }
        fn failing_snapshot() -> Arc<Self> {
            Arc::new(Self {
                decision: GateDecision::Allow,
                snapshot_fails: true,
                calls: StdMutex::new(Vec::new()),
            })
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl HostPolicy for Recorder {
        async fn ask_permission(&self, tool: &str, _input: &Value) -> GateDecision {
            self.calls.lock().unwrap().push(format!("ask:{tool}"));
            self.decision
        }
        async fn before_write(&self, path: &Path, _proposed: Option<&str>) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("snapshot:{}", path.display()));
            if self.snapshot_fails {
                return Err("snapshot failed".into());
            }
            Ok(())
        }
    }

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura-pi-gate-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn ask(tool: &str, input: Value) -> GateAsk {
        GateAsk {
            id: "1".into(),
            tool: tool.into(),
            input,
        }
    }

    #[tokio::test]
    async fn a_write_is_snapshotted_before_it_is_permitted() {
        // Order is the whole point: a snapshot taken after the write
        // protects nothing.
        let root = tmp_root("order");
        let rec = Recorder::new(GateDecision::Allow);
        let policy: Arc<dyn HostPolicy> = rec.clone();
        let path = root.join("a.rs");

        decide(&policy, "test-session", &root, &ask("write", json!({"path": path})))
            .await
            .unwrap();

        assert_eq!(
            rec.calls(),
            vec![format!("snapshot:{}", path.display()), "ask:write".to_string()],
        );
    }

    #[tokio::test]
    async fn a_failed_snapshot_blocks_the_write_and_never_asks() {
        let root = tmp_root("nosnap");
        let rec = Recorder::failing_snapshot();
        let policy: Arc<dyn HostPolicy> = rec.clone();

        let err = decide(&policy, "test-session", &root, &ask("edit", json!({"path": root.join("a.rs")})))
            .await
            .unwrap_err();

        assert!(err.contains("snapshot"), "the model is shown this: {err}");
        assert!(
            !rec.calls().iter().any(|c| c.starts_with("ask:")),
            "an edit we cannot rewind must not even be offered for approval"
        );
    }

    #[tokio::test]
    async fn a_path_outside_the_root_is_refused() {
        // pi reads and writes on its own, so this moment is the only place
        // the session root can be enforced at all.
        let root = tmp_root("escape");
        let rec = Recorder::new(GateDecision::Allow);
        let policy: Arc<dyn HostPolicy> = rec.clone();

        let err = decide(
            &policy,
            "test-session",
            &root,
            &ask("read", json!({"path": "../../.aura/credentials.json"})),
        )
        .await
        .unwrap_err();

        assert!(err.contains("outside"), "{err}");
        assert!(rec.calls().is_empty(), "nothing should have been asked");
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn a_root_reached_through_a_symlink_is_still_inside_itself() {
        // The regression the end-to-end test caught. Every other test here
        // canonicalises the root before handing it over; a real session
        // hands over the cwd it was opened with. On macOS that is routinely
        // a symlinked path — `/tmp` and `/var/folders` both are — and the
        // file being written does not exist yet, so it cannot canonicalise
        // to match. Resolve one side only and the root swallows the whole
        // session: every write refused, the gate never even asked.
        let real = tmp_root("symlink-real");
        let link = std::env::temp_dir().join("aura-pi-gate-symlink-link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let rec = Recorder::new(GateDecision::Allow);
        let policy: Arc<dyn HostPolicy> = rec.clone();

        decide(&policy, "test-session", &link, &ask("write", json!({"path": "a.rs"})))
            .await
            .expect("a file directly under the root is not an escape from it");

        assert_eq!(
            rec.calls(),
            vec![
                format!("snapshot:{}", real.join("a.rs").display()),
                "ask:write".to_string()
            ],
            "and the snapshot must name the resolved path, not the link"
        );

        let _ = std::fs::remove_file(&link);
    }

    #[tokio::test]
    async fn a_read_inside_the_root_needs_no_card() {
        // A prompt per file listing trains people to click through the
        // ones that matter.
        let root = tmp_root("read");
        let rec = Recorder::new(GateDecision::Deny);
        let policy: Arc<dyn HostPolicy> = rec.clone();

        decide(&policy, "test-session", &root, &ask("read", json!({"path": root.join("a.rs")})))
            .await
            .unwrap();

        assert!(rec.calls().is_empty());
    }

    #[tokio::test]
    async fn a_command_always_asks_even_with_no_path() {
        let root = tmp_root("bash");
        let rec = Recorder::new(GateDecision::Deny);
        let policy: Arc<dyn HostPolicy> = rec.clone();

        let err = decide(&policy, "test-session", &root, &ask("bash", json!({"command": "rm -rf /"})))
            .await
            .unwrap_err();

        assert_eq!(rec.calls(), vec!["ask:bash".to_string()]);
        assert!(err.contains("bash"), "the refusal names the tool: {err}");
    }

    #[tokio::test]
    async fn an_unknown_tool_asks_rather_than_assuming_it_is_harmless() {
        let root = tmp_root("unknown");
        let rec = Recorder::new(GateDecision::AllowAlways);
        let policy: Arc<dyn HostPolicy> = rec.clone();

        decide(&policy, "test-session", &root, &ask("some_extension_tool", json!({})))
            .await
            .unwrap();

        assert_eq!(rec.calls(), vec!["ask:some_extension_tool".to_string()]);
    }

    #[test]
    fn the_gate_extension_asks_the_question_this_module_answers() {
        // The two halves are a protocol. If the extension's title or its
        // allow token drifts from the wire constants, every tool call
        // silently becomes a foreign dialog and pi hangs.
        assert!(
            GATE_SOURCE.contains(&format!("\"{}\"", wire::GATE_TITLE)),
            "the extension must stamp the title the parser looks for"
        );
        assert!(
            GATE_SOURCE.contains(&format!("\"{GATE_ALLOW}\"")),
            "the extension must recognise the token this module sends back"
        );
        assert!(
            GATE_SOURCE.contains("ctx.ui.input("),
            "the gate rides on `input`, because a refusal has to carry a reason"
        );
    }

    #[tokio::test]
    async fn the_gate_extension_lands_where_a_user_can_read_it() {
        let path = install_gate_extension().await.unwrap();
        let on_disk = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(on_disk, GATE_SOURCE);
        assert!(path.ends_with("aura-gate.ts"));
    }
}
