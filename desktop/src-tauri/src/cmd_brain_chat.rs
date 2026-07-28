//! Brain-trait chat command surface — v0.2.31 LL.0 (task #349).
//!
//! Sibling of `cmd_manager.rs::manager_chat`. Where the legacy path runs
//! through `brain::run_turn` (and MCP/CLI fan-out), this command routes
//! one chat turn through `BrainManager::current()` → `Brain::chat`,
//! piping the returned `BoxStream<Result<ChatChunk, BrainError>>` into
//! Tauri events on `manager-chat-chunk:<session_id>`.
//!
//! ## Why a new command
//!
//! Native brains (`anthropic_native`, `openai_compat`, `openai_native`,
//! `gemini_native`) stream tokens + tool-use blocks directly from the
//! provider. The legacy path was built around CLI wrappers (PTY +
//! line-buffered stream-json) plus a single hand-rolled Anthropic
//! call — the new command is the place native brains live without
//! re-using legacy assumptions like "we have a `ManagerSession` on disk".
//!
//! CLI wrappers continue to go through the legacy path: their UX is
//! a terminal, not a chat bubble (per the user's standing rule
//! "agent surface defaults to Terminal view for CLI brains").
//! `ManagerChatView` picks the path based on the active provider id.
//!
//! ## Cancellation
//!
//! Per-session `JoinHandle`s are stashed in `BrainStreamRegistry`. A
//! second `brain_chat_turn` for the same session_id aborts the prior
//! handle before starting a new one. `brain_chat_cancel(session_id)`
//! is the explicit knob — the frontend calls it on unmount.
//!
//! Dropping the spawned task tears down the inner `BoxStream`, which
//! the trait contract says must release whatever the impl is holding
//! (HTTP body, child process, etc.). Errors mid-stream are converted
//! to `ChatChunk::Error` events so the UI surfaces them as an error
//! bubble without needing a separate channel.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::task::JoinHandle;

use crate::manager::brain::{
    self,
    manager::BrainManager,
    native_tools, registry,
    types::{BrainError, ChatChunk, ChatMessage, ChatRequest},
    Brain,
};
use crate::manager::{persist, ChatRole};

/// Per-session cancellation registry. One `JoinHandle` per `session_id`;
/// the prior task is aborted on a fresh `brain_chat_turn` or an explicit
/// `brain_chat_cancel`. The handle's drop is enough — it tears down the
/// inner `BoxStream` and the trait contract handles cleanup from there.
pub struct BrainStreamRegistry {
    inner: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl BrainStreamRegistry {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Insert a new handle for `session_id`, aborting any prior one.
    fn replace(&self, session_id: &str, handle: JoinHandle<()>) {
        let mut g = self.inner.lock().unwrap();
        if let Some(prev) = g.insert(session_id.to_string(), handle) {
            prev.abort();
        }
    }

    /// Abort and forget the handle for `session_id`. No-op if absent.
    fn cancel(&self, session_id: &str) {
        if let Some(h) = self.inner.lock().unwrap().remove(session_id) {
            h.abort();
        }
    }

    /// Clear an entry once the stream has run to completion. We don't
    /// abort here — the task has already finished. This just frees the
    /// `JoinHandle` slot so the map doesn't grow without bound.
    fn forget(&self, session_id: &str) {
        self.inner.lock().unwrap().remove(session_id);
    }
}

impl Default for BrainStreamRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Optional per-turn context provided by the frontend. All fields are
/// optional so callers can start simple (just `user_message`) and add
/// tool schemas / multi-turn history when they need them.
///
/// The default flow: caller passes the prior `ChatTurn[]` flattened into
/// `messages` (with the new user turn appended); the new command builds
/// a `ChatRequest` and hands it to the active brain.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct BrainChatContext {
    /// Prior conversation. If empty, the command builds a single-turn
    /// request from `user_message` alone.
    pub messages: Vec<ChatMessage>,
    /// Optional system prompt override. None → brain default.
    pub system: Option<String>,
    /// Tool schemas the brain may invoke. Vendor-specific; the brain
    /// translates as needed. Defaults to no tools.
    pub tools: Vec<Value>,
    /// Soft cap on output tokens. None → brain default.
    pub max_tokens: Option<u32>,
    /// Sampling temperature (0.0–1.0). None → brain default.
    pub temperature: Option<f32>,
    /// Cross-agent reasoning effort for this turn. None → provider default
    /// (request byte-identical to the pre-effort build). The composer's
    /// Effort chip sets this; each brain maps it onto its real mechanism.
    pub effort: Option<aura_agents::ReasoningEffort>,
    /// Latency-first toggle (⚡) from the composer. Collapses effort to the
    /// provider minimum / disables extended thinking.
    pub fast: bool,
    /// Per-turn model override from the composer's model picker. None → the
    /// brain's configured/default model (byte-identical to the pre-picker
    /// build). Maps onto each native brain's request model.
    pub model: Option<String>,
    /// Long-context ("1M") variant chosen in the picker. Anthropic-family
    /// brains add the 1M-context beta header; others ignore it.
    pub long_context: bool,
    /// Cross-agent permission / autonomy mode for this turn (the composer's
    /// Approvals chip). None → the agent's own default gating. CLI brains map
    /// it onto the real per-CLI approval flag; native brains ignore it.
    pub approval: Option<aura_agents::ApprovalPolicy>,
}

/// What the brain currently in use looks like — surfaced to the UI so
/// the path-switch logic in `ManagerChatView` doesn't need a second
/// round-trip to figure out whether this is a CLI wrapper or native
/// brain.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveBrainInfo {
    pub provider_id: String,
    /// True if the active brain is a `cli_wrapper:*` flavor — UI should
    /// route to the legacy PTY surface, not the chat-bubble stream.
    pub is_cli_wrapper: bool,
}

/// Snapshot of the currently-active brain. Read on session mount by
/// `ManagerChatView` to pick legacy-vs-new path.
#[tauri::command]
pub async fn brain_active_info() -> Result<ActiveBrainInfo, String> {
    let mgr = BrainManager::from_disk();
    // Building the brain pulls in keychain access; we only need its
    // provider_id for the routing decision, so consult settings + the
    // default-resolver first and only build on a real mismatch.
    let settings = mgr.settings();
    let provider_id = match settings.active_provider_id.clone() {
        Some(id) => id,
        None => mgr
            .active()
            .map(|b| b.provider_id().to_string())
            .map_err(|e| e.to_string())?,
    };
    let is_cli_wrapper = provider_id.starts_with("cli_wrapper:");
    Ok(ActiveBrainInfo {
        provider_id,
        is_cli_wrapper,
    })
}

/// Run one chat turn through the active brain and stream `ChatChunk`s
/// back on `manager-chat-chunk:<session_id>`.
///
/// `user_message` is appended to `context.messages` as a final `user`
/// turn before the request hits the brain — callers can therefore pass
/// just prior turns (without the new one) and avoid having to mutate
/// their local copy first.
#[tauri::command]
pub async fn brain_chat_turn(
    app: AppHandle,
    registry: State<'_, BrainStreamRegistry>,
    session_id: String,
    user_message: String,
    context_json: Option<Value>,
    brain_override: Option<String>,
    repo_root: Option<String>,
) -> Result<(), String> {
    // Parse the per-turn knobs (system/tools/effort/model/…). Treat a
    // missing / unparseable context as "defaults" rather than failing — the
    // frontend may legitimately not have any prior state on first send.
    //
    // NOTE: `ctx.messages` is intentionally NOT used as the conversation
    // source anymore. The frontend flattens `session.chat` to `t.text` only,
    // so CLI / "Claude Code" turns whose substance was tool cards arrive with
    // empty text — switching the composer model to a native brain mid-thread
    // then fed it a near-empty history ("fresh session start, no context").
    // We instead rebuild the full transcript server-side from the
    // authoritative `session.chat` via `chat_to_messages` (below), exactly
    // like the legacy path's `build_request`.
    let ctx: BrainChatContext = match context_json {
        Some(v) => serde_json::from_value(v).map_err(|e| format!("context_json: {e}"))?,
        None => BrainChatContext::default(),
    };
    // Keep a copy of the raw user text for persistence — `user_message`
    // is moved into nothing below, but we clone so the value stays available
    // both for persistence and for the (no-prior-session) fallback message.
    let user_text = user_message.clone();

    // Perceived-latency fix — persist + emit the user turn FIRST, before we
    // touch the Keychain to resolve the brain below. `persist_turn` writes the
    // turn into `session.chat` and emits a `manager:<sid>` snapshot, so the
    // user's own message renders the instant this command reaches Rust instead
    // of waiting on the ~100ms macOS Keychain read that brain resolution
    // incurs. That wait was why the native chat felt slow to "start showing
    // things" next to the Conductor PTY (which echoes locally). Moving the
    // persist above brain-resolution changes nothing downstream: it still lands
    // before `load_session_for_request` (so the request is rebuilt from the
    // authoritative `session.chat`, current message included exactly once) and
    // before `maybe_compact_for_turn`.
    //
    // It also keeps the native path reload-safe (native turns previously never
    // touched `ManagerSession`, so a reload dropped the whole conversation) and
    // now matches the legacy `manager_chat` path in one more way: if brain
    // resolution below fails, the user's message stays on screen alongside the
    // error reply instead of vanishing.
    if !user_text.is_empty() {
        persist_turn(&app, &session_id, ChatRole::User, user_text.clone(), None);
    }

    // Resolve the brain ONCE on the calling thread so keychain /
    // settings errors surface as a Tauri command error (user-actionable)
    // rather than as a stream-side `ChatChunk::Error` (looks the same as
    // a provider failure mid-turn).
    //
    // WW-B1 — a non-empty `brain_override` (the chat-header BrainPicker's
    // per-session choice) resolves that specific brain for this turn
    // only, without touching the global active brain or any other
    // session. Empty / absent falls through to the active brain.
    let mgr = BrainManager::from_disk();
    let explicit_override = brain_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let active = match explicit_override.as_deref() {
        Some(provider_id) => mgr.resolve(provider_id).map_err(|e| e.to_string())?,
        None => mgr.active().map_err(|e| e.to_string())?,
    };

    // Attribute the persisted assistant turn to the brain that actually
    // produced it (WW-B1). Captured now — `active` moves into the stream
    // task below.
    let brain_id = active.provider_id().to_string();

    // Continuity spine — compact the older transcript (if it has grown past
    // budget) BEFORE rebuilding the request from `session.chat`, so the brain
    // ingests a distilled history instead of the whole thing replayed turn
    // after turn. Placed after the user turn is persisted and before
    // `load_session_for_request` so the messages built below are already
    // compacted. The threshold adapts to the brain about to answer:
    // aggressive for CLI engines and brain switches (no provider prompt cache
    // to lose — a cold full-transcript replay is pure waste), lenient for a
    // native brain continuing on itself (keep the prompt cache warm, distill
    // only near the real limit). Reuses the SAME tested distiller as the
    // legacy path — no new summarization plumbing.
    maybe_compact_for_turn(&app, &session_id, &brain_id);

    // Load the session AFTER persisting the user turn. Prefer the live
    // in-memory `ManagerRuntime` state (which `persist_turn` just mutated)
    // so we observe the just-pushed turn even under a concurrent disk write;
    // fall back to disk when there's no live session registered.
    let session = load_session_for_request(&app, &session_id);

    // #256 — resolve the project root so the native brain's built-in board
    // tools (read/pick tasks, read/write Pages) operate on the same repo the
    // user is in, AND so a CLI-wrapper brain spawns its subprocess inside that
    // repo (`ChatRequest.cwd` → `cli_wrapper` → `safe_spawn_dir`).
    //
    // Prefer the root the *frontend* resolved for this turn (`repo_root` arg):
    // it already accounts for the open workspace — crucially a git *worktree*,
    // whose path is NOT in the session's bound `projects` list. Without it the
    // chat fell back to `session.projects.first()`, which for a worktree
    // workspace is stale/empty → the agent landed in HOME ("not a git repo")
    // and tools were disabled. Fall back to the session's project list, then
    // empty — an empty root keeps the pre-#256 behavior (no tools; CLI spawns
    // in HOME).
    let repo_root = repo_root
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            session
                .as_ref()
                .and_then(|s| s.projects.first().map(|p| p.root.clone()))
        })
        .unwrap_or_default();

    // Rebuild the conversation server-side from the authoritative
    // `session.chat` via the shared `chat_to_messages` shaper — the SAME
    // conversion the legacy path's `build_request` uses, so native and CLI
    // brains see an identical transcript. `ctx.messages` (the frontend's
    // `t.text`-only flattening) is deliberately ignored here: it drops the
    // substance of CLI / tool-card turns, which is exactly what made a
    // mid-thread switch to the native "Claude" brain reply "fresh session
    // start, no context".
    //
    // The current user message is already in `session.chat` (persisted just
    // above), so it appears in these messages exactly once — we do NOT append
    // it again. When there's no session on disk yet (a turn that raced ahead
    // of session creation), fall back to a single-turn request built from the
    // raw `user_message` so the very first send still works.
    let messages = match session.as_ref() {
        Some(s) => brain::chat_to_messages(&s.chat, Some(brain_id.as_str())),
        None => {
            if user_text.is_empty() {
                Vec::new()
            } else {
                vec![ChatMessage {
                    role: "user".to_string(),
                    content: Value::String(user_text.clone()),
                }]
            }
        }
    };

    let request = ChatRequest {
        messages,
        system: ctx.system,
        tools: ctx.tools,
        max_tokens: ctx.max_tokens,
        temperature: ctx.temperature,
        effort: ctx.effort,
        fast: ctx.fast,
        model: ctx.model,
        long_context: ctx.long_context,
        approval: ctx.approval,
        // The CLI-wrapper brain spawns its subprocess here (worktree-correct
        // root, resolved just above). Native brains ignore it.
        cwd: repo_root.clone(),
    };

    let channel = format!("manager-chat-chunk:{session_id}");
    let app_for_task = app.clone();
    let sid_for_persist = session_id.clone();
    let registry_handle: tauri::State<'_, BrainStreamRegistry> = registry;
    // We need to forget() from the spawned task once it finishes. The
    // registry itself is shared via `app.state()` so the task can re-
    // fetch it without holding a Tauri State across an await.
    let app_for_forget = app.clone();
    let sid_for_forget = session_id.clone();

    let handle = tokio::spawn(async move {
        let emit_chunk = |chunk: ChatChunk| {
            let _ = app_for_task.emit(&channel, &chunk);
        };

        // Run the resolved brain. `request` is cloned in because an Auto
        // turn that dead-ends on an entitlement error gets replayed through
        // a local fallback brain below.
        let outcome = stream_one_brain(
            active,
            request.clone(),
            &app_for_task,
            &channel,
            &sid_for_persist,
            &brain_id,
            "",
            &repo_root,
        )
        .await;

        match outcome {
            TurnResult::Done => {}
            // Already streamed text/tool-use before failing — we can't
            // cleanly restart mid-bubble, so surface the error as-is.
            TurnResult::LateError(e) => emit_chunk(ChatChunk::from(e)),
            TurnResult::EarlyError(e) => {
                // The "use available things and work" path: a turn died before
                // showing anything, so we may transparently retry it on the
                // best installed local brain instead of dead-ending.
                //
                // The classifier decides WHAT kind of failure this is; policy
                // here decides whether THIS brain earns a fallback:
                //
                //   • Not failover-worthy (ContextOverflow / Canceled / Fatal)
                //     → never retry. A too-big prompt, a user cancel, or a
                //     config bug fails identically on any engine; surface it.
                //   • Aura Pro (the zero-config cloud brain) → always retry
                //     when failover-worthy. It has NO user-fixable key, so a
                //     working local brain always beats a dead end — including
                //     on auth/quota, which the user can't act on.
                //   • Any explicitly-configured native/CLI/compat brain → retry
                //     ONLY on RateLimited or Transient. NOT AuthRequired: a
                //     bad/expired key the user must fix should surface, not be
                //     silently hidden behind another brain.
                //
                // When we do retry, the failed engine is recorded in the
                // cooldown ledger and the exclude set covers every cooling
                // engine, so repeat turns skip dead providers instead of
                // hammering them.
                let limit = brain::limits::classify_limit(&e);
                let fallback = if !limit.failover_worthy {
                    None
                } else {
                    let eligible = if brain_id == brain::aura_pro::PROVIDER_ID {
                        true
                    } else {
                        matches!(
                            limit.class,
                            brain::limits::LimitClass::RateLimited
                                | brain::limits::LimitClass::Transient
                        )
                    };
                    if eligible {
                        // Mark the dead engine so future turns skip it for its
                        // cooldown window (when the classifier supplies one).
                        if let Some(cd) = limit.cooldown {
                            brain::limits::mark_cooldown(&brain_id, cd);
                        }
                        // Exclude the failed brain plus everything currently
                        // cooling down, deduped, so the picker can't hand back
                        // a provider we already know is dead.
                        let mut excludes = brain::limits::cooling_engines();
                        excludes.push(brain_id.clone());
                        excludes.sort();
                        excludes.dedup();
                        let exclude_refs: Vec<&str> =
                            excludes.iter().map(|s| s.as_str()).collect();
                        registry::first_available_fallback_excluding(&exclude_refs)
                            .and_then(|fid| registry::build(&fid).ok().map(|b| (fid, b)))
                    } else {
                        None
                    }
                };
                match fallback {
                    Some((fallback_id, fallback_brain)) => {
                        // Silently retry on the best installed local brain — no
                        // prose notice. The user's standing rule is "just use
                        // what's available and work"; the only record of which
                        // brain answered is the per-turn brain-provenance chip,
                        // which is enough. A visible "_Aura Pro is unavailable_"
                        // line on every fallback reply (and on every reload) is
                        // exactly the spam they asked never to see.
                        let retry = stream_one_brain(
                            fallback_brain,
                            request,
                            &app_for_task,
                            &channel,
                            &sid_for_persist,
                            &fallback_id,
                            "",
                            &repo_root,
                        )
                        .await;
                        // If the fallback itself fails, surface that error —
                        // we've exhausted the Auto chain.
                        match retry {
                            TurnResult::Done => {}
                            TurnResult::LateError(e2) | TurnResult::EarlyError(e2) => {
                                emit_chunk(ChatChunk::from(e2))
                            }
                        }
                    }
                    None => emit_chunk(ChatChunk::from(e)),
                }
            }
        }

        // Self-eviction from the registry — the handle is done so the
        // map slot can be released. We re-fetch state from the app so
        // we don't need to send the State across the await boundary.
        use tauri::Manager as _;
        if let Some(reg) = app_for_forget.try_state::<BrainStreamRegistry>() {
            reg.forget(&sid_for_forget);
        }
    });

    registry_handle.replace(&session_id, handle);
    Ok(())
}

/// Outcome of streaming one brain through a turn — drives the Auto
/// entitlement-fallback in `brain_chat_turn`.
enum TurnResult {
    /// Streamed to a clean `End` (or the stream simply ended). Any assistant
    /// text produced has already been persisted with brain provenance.
    Done,
    /// Failed before producing ANY text or tool-use — a candidate for an
    /// Auto-mode fallback to a local brain (nothing was shown to the user
    /// yet, so a transparent retry is clean).
    EarlyError(BrainError),
    /// Failed AFTER already emitting text/tool-use — surface as-is; we can't
    /// cleanly restart mid-bubble.
    LateError(BrainError),
}

/// Accumulates a turn's assistant text and persists it **if the turn is
/// dropped before it finishes** — i.e. the user interrupted it via
/// `brain_chat_cancel`, which aborts the spawned task mid-stream.
///
/// Without this, an interrupt threw away everything streamed so far: the
/// live bubble showed prose, then a reload (or even the cancel itself)
/// blanked it because nothing was ever written to the session. Now the
/// partial reply survives as a real, reload-safe turn, and the UI is told
/// the turn ended via interrupt (`stop_reason = "interrupted"`) so it can
/// retire the live blocks and mark the spot rather than wipe them.
///
/// On every NORMAL exit (clean end, round cap, or an error we surface) the
/// guard is disarmed first — `take()` for the persist-and-close paths,
/// `disarm()` for the error paths — so `Drop` fires only on a true abort.
struct PartialTurnGuard {
    app: AppHandle,
    channel: String,
    sid: String,
    brain_id: String,
    text: String,
    armed: bool,
}

impl PartialTurnGuard {
    fn new(app: &AppHandle, channel: &str, sid: &str, brain_id: &str, seed: &str) -> Self {
        Self {
            app: app.clone(),
            channel: channel.to_string(),
            sid: sid.to_string(),
            brain_id: brain_id.to_string(),
            text: seed.to_string(),
            armed: true,
        }
    }

    fn push(&mut self, s: &str) {
        self.text.push_str(s);
    }

    fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Drain the accumulated text for a normal persist-and-close, disarming
    /// the interrupt guard so `Drop` can't double-persist.
    fn take(&mut self) -> String {
        self.armed = false;
        std::mem::take(&mut self.text)
    }

    /// Disarm without draining — for the error-return paths, which surface
    /// the error and intentionally don't persist a turn (matching the
    /// pre-guard behaviour).
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PartialTurnGuard {
    fn drop(&mut self) {
        if !self.armed || self.text.trim().is_empty() {
            return;
        }
        // Interrupted mid-stream — persist what we have so it survives a
        // reload, then tell the UI the live bubble is now a saved turn that
        // was interrupted (it clears its streaming blocks and marks the seam).
        persist_turn(
            &self.app,
            &self.sid,
            ChatRole::Manager,
            std::mem::take(&mut self.text),
            Some(self.brain_id.clone()),
        );
        let _ = self.app.emit(
            &self.channel,
            &ChatChunk::End {
                stop_reason: Some("interrupted".to_string()),
            },
        );
    }
}

/// Record a completed turn's token usage into the repo-local usage ledger,
/// fire-and-forget. Shells the bundled `aura usage-record`, which upserts a
/// `.aura/sessions/<session>.json` and lets the next `aura usage` read roll it
/// into the git-shared, project-scoped per-developer aggregate. Spawned on a
/// detached thread so it never blocks (or delays) the chat turn, and reaped
/// there so it leaves no zombie. A no-op when there's nothing to record or no
/// repo to record into.
pub(crate) fn record_turn_usage_async(
    repo_root: &str,
    session_id: &str,
    agent_id: &str,
    model: Option<&str>,
    input: u64,
    output: u64,
) {
    if repo_root.is_empty() || (input == 0 && output == 0) {
        return;
    }
    let repo_root = repo_root.to_string();
    let session_id = session_id.to_string();
    let agent_id = agent_id.to_string();
    let model = model.map(|m| m.to_string());
    std::thread::spawn(move || {
        let mut cmd = std::process::Command::new("aura");
        cmd.arg("usage-record")
            .arg("--session")
            .arg(&session_id)
            .arg("--agent")
            .arg(&agent_id)
            .arg("--input")
            .arg(input.to_string())
            .arg("--output")
            .arg(output.to_string())
            .current_dir(&repo_root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Some(m) = &model {
            cmd.arg("--model").arg(m);
        }
        // Run to completion on this detached thread so the child is reaped.
        let _ = cmd.status();
    });
}

/// Stream one `Brain` through `request`, driving a server-side tool loop.
///
/// Each round streams the brain and emits its `ChatChunk`s on `channel`. If
/// the model emitted any of our built-in `tool_use` blocks, we execute
/// them, emit a `ToolResult` for each (so the card completes), append the
/// assistant turn + a `tool_result` user message, and re-stream — until the
/// model stops calling tools or a round cap is hit. All assistant text
/// across rounds is accumulated and persisted (attributed to `brain_id`)
/// when the turn finishes. `seed_text` pre-fills that accumulator so a
/// fallback notice already emitted by the caller lands in the persisted,
/// reload-safe turn.
///
/// Tools are injected only for Anthropic-shaped brains (`aura_pro` /
/// `anthropic_native`) when `repo_root` is non-empty and the caller left
/// `request.tools` empty. Every other provider keeps its prior, tool-free
/// behaviour and the request stays byte-identical — which is why injection
/// is decided per-brain here rather than once at the call site (an Auto
/// fallback to a non-Anthropic local brain must not inherit Anthropic-shaped
/// tool schemas).
///
/// Returns a [`TurnResult`] so the caller can decide whether an early
/// failure is worth retrying on a different brain.
async fn stream_one_brain(
    brain: Arc<dyn Brain>,
    mut request: ChatRequest,
    app: &AppHandle,
    channel: &str,
    sid: &str,
    brain_id: &str,
    seed_text: &str,
    repo_root: &str,
) -> TurnResult {
    // Hard cap on tool rounds in one turn — a runaway-loop backstop. A real
    // task settles in 1–3 rounds; past this we stop and persist whatever the
    // model produced rather than spin.
    const MAX_TOOL_ROUNDS: usize = 8;

    let emit = |chunk: ChatChunk| {
        let _ = app.emit(channel, &chunk);
    };

    let tools_enabled = !repo_root.is_empty()
        && request.tools.is_empty()
        && native_tools::supports(brain_id);
    if tools_enabled {
        request.tools = native_tools::all_tool_schemas();
        request.system =
            Some(native_tools::augment_system(request.system.as_deref(), repo_root));
    }

    // Accumulates every assistant text fragment across all rounds — this is
    // what gets persisted as the final turn. Seeded with any caller notice.
    // Wrapped in a guard so an interrupt (task abort mid-stream) still
    // persists what streamed so far instead of dropping it on the floor.
    let mut full_text = PartialTurnGuard::new(app, channel, sid, brain_id, seed_text);
    // Whether the user has seen anything yet this turn. Once true, a later
    // error can't be recovered by a transparent restart on another brain.
    let mut produced = false;
    // Keeps live block indices monotonic across rounds: each provider round
    // restarts its own indices at 0, but the frontend keys text blocks by
    // index, so without an offset round 2's text would merge into round 1's
    // bubble and render ahead of the tool card.
    let mut block_offset = 0usize;
    // Latest per-turn token accounting reported by the brain. We forward the
    // FINAL round's usage so the meter reflects the full context the turn
    // accumulated (each tool round re-bills the growing prompt). `None` for
    // providers that don't report usage — the chunk is then never emitted and
    // the meter stays hidden.
    let mut last_usage: Option<(u32, u32)> = None;
    // Cost ledger accounting (distinct from the live meter above). Every tool
    // round is its own billed API call, so we SUM each round's reported usage
    // here for the real spend, whereas the live meter forwards only the final
    // round's (context-size) figure. Recorded once when the turn completes.
    let mut turn_billed_input: u64 = 0;
    let mut turn_billed_output: u64 = 0;
    // The model actually requested this turn (composer override; `None` → the
    // brain's own default, which the ledger prices at its sane fallback).
    let turn_model = request.model.clone();
    // Every tool the brain called this turn, in emission order, paired with
    // its result once the board tool executes. Persisted onto the final
    // ChatTurn so reloading the session re-renders the tool cards instead of
    // dropping them when the live stream ends. Non-board tools (the model
    // asked for something we don't run) keep `result: None`.
    let mut turn_tools: Vec<crate::manager::PersistedToolCall> = Vec::new();
    // Estimated tokens this turn saved by reaching for Aura's code-graph
    // tools (atlas / ask) instead of reading whole files — summed across the
    // turn's tool calls and persisted onto the final ChatTurn so the chip can
    // render "Saved ~N tokens". Stays 0 when no such tool was used.
    let mut turn_saved_tokens: u32 = 0;

    for _round in 0..MAX_TOOL_ROUNDS {
        let mut stream = match brain.chat(request.clone()).await {
            Ok(s) => s,
            Err(e) => {
                // Surface the error as-is; don't let the guard persist a turn.
                full_text.disarm();
                return if produced {
                    TurnResult::LateError(e)
                } else {
                    TurnResult::EarlyError(e)
                };
            }
        };

        // Round-local accumulators.
        let mut round_text = String::new();
        let mut tool_calls: Vec<(String, String, Value)> = Vec::new();
        let mut round_max_idx = 0usize;

        loop {
            let item = match stream.next().await {
                Some(it) => it,
                None => break, // stream ended (possibly without an explicit End)
            };
            let chunk = match item {
                Ok(c) => c,
                Err(e) => {
                    full_text.disarm();
                    return if produced {
                        TurnResult::LateError(e)
                    } else {
                        TurnResult::EarlyError(e)
                    };
                }
            };
            match chunk {
                ChatChunk::Text { block_idx, text } => {
                    round_max_idx = round_max_idx.max(block_idx);
                    round_text.push_str(&text);
                    full_text.push(&text);
                    if !text.is_empty() {
                        produced = true;
                    }
                    emit(ChatChunk::Text {
                        block_idx: block_idx + block_offset,
                        text,
                    });
                }
                ChatChunk::Reasoning { block_idx, text } => {
                    // Extended-thinking deltas. Keep the index monotonic
                    // across rounds (same offset bookkeeping as Text) so the
                    // reasoning disclosure stays a distinct block, and DON'T
                    // fold the text into `full_text` — chain-of-thought is a
                    // live cosmetic, never persisted into the turn.
                    round_max_idx = round_max_idx.max(block_idx);
                    emit(ChatChunk::Reasoning {
                        block_idx: block_idx + block_offset,
                        text,
                    });
                }
                ChatChunk::Usage {
                    input_tokens,
                    output_tokens,
                } => {
                    // Carry the latest round's usage; emitted once before the
                    // terminal End so the meter reflects the whole turn.
                    last_usage = Some((input_tokens, output_tokens));
                    // …and sum it into the billed total for the cost ledger.
                    turn_billed_input += input_tokens as u64;
                    turn_billed_output += output_tokens as u64;
                }
                ChatChunk::ToolUse {
                    block_idx,
                    tool_use_id,
                    name,
                    input,
                } => {
                    round_max_idx = round_max_idx.max(block_idx);
                    produced = true;
                    // Interactive tools (ask_user / propose_plan) drive a
                    // QuestionCard / PlanCard rendered off Manager session
                    // state — suppress the raw tool_use chunk and its
                    // persistence so the card is the sole surface, not a
                    // duplicate JSON tool card. Board tools surface as usual;
                    // only board tools' raw cards are persisted/back-filled.
                    if !native_tools::is_interactive_tool(&name) {
                        emit(ChatChunk::ToolUse {
                            block_idx: block_idx + block_offset,
                            tool_use_id: tool_use_id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        // Record the call for persistence; its result is back-
                        // filled after execution below (or stays None if it's a
                        // tool we surface but don't run).
                        turn_tools.push(crate::manager::PersistedToolCall {
                            tool_use_id: tool_use_id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                            result: None,
                        });
                    }
                    tool_calls.push((tool_use_id, name, input));
                }
                ChatChunk::End { .. } => break, // round done — handled below
                ChatChunk::ToolResult { .. } => {
                    // Brains don't emit this; it's ours to send. Ignore one if
                    // it ever appears so the loop stays well-defined.
                }
                ChatChunk::Error { message } => {
                    emit(ChatChunk::Error { message });
                }
            }
        }

        // Continue only when this round asked for at least one of OUR tools
        // and we have a root to run them against; anything else ends the turn.
        let runnable: Vec<(String, String, Value)> = if tools_enabled {
            tool_calls
                .into_iter()
                .filter(|(_, name, _)| {
                    native_tools::is_board_tool(name) || native_tools::is_interactive_tool(name)
                })
                .collect()
        } else {
            Vec::new()
        };

        if runnable.is_empty() {
            // Terminal: persist the full assistant text + the turn's tool
            // calls and close the turn.
            if !full_text.is_empty() {
                persist_turn_with_tools(
                    app,
                    sid,
                    ChatRole::Manager,
                    full_text.take(),
                    Some(brain_id.to_string()),
                    std::mem::take(&mut turn_tools),
                    turn_saved_tokens,
                    last_usage,
                );
            } else {
                full_text.disarm();
            }
            if let Some((input_tokens, output_tokens)) = last_usage {
                emit(ChatChunk::Usage {
                    input_tokens,
                    output_tokens,
                });
            }
            record_turn_usage_async(
                repo_root,
                sid,
                brain_id,
                turn_model.as_deref(),
                turn_billed_input,
                turn_billed_output,
            );
            emit(ChatChunk::End { stop_reason: None });
            return TurnResult::Done;
        }

        // Append the assistant turn (round text + tool_use blocks) so the
        // follow-up tool_result blocks reference valid tool_use ids.
        let mut assistant_content: Vec<Value> = Vec::new();
        if !round_text.is_empty() {
            assistant_content.push(json!({ "type": "text", "text": round_text }));
        }
        for (id, name, input) in &runnable {
            assistant_content.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input,
            }));
        }
        request.messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: Value::Array(assistant_content),
        });

        // Execute each tool, emit a ToolResult so the card completes, and
        // collect the result blocks for the follow-up user message.
        let mut result_blocks: Vec<Value> = Vec::new();
        for (id, name, input) in &runnable {
            let interactive = native_tools::is_interactive_tool(name);
            let (content, is_error) = if interactive {
                // ask_user / propose_plan: project the QuestionCard / PlanCard
                // and block until the user resolves it. Reuses the same
                // blocking helpers the CLI socket bridge uses, so a native
                // plan's Build mints the same dependency-ordered a2a tasks the
                // Crew runs. The card owns its own surface — no raw ToolResult
                // chunk, and nothing to back-fill (the call wasn't persisted).
                run_interactive_tool(app, sid, name, input).await
            } else {
                let (content, is_error, saved) = native_tools::execute_board_tool(
                    repo_root,
                    name,
                    input,
                    native_tools::CHAT_AUTHOR,
                )
                .await;
                turn_saved_tokens = turn_saved_tokens.saturating_add(saved);
                emit(ChatChunk::ToolResult {
                    tool_use_id: id.clone(),
                    content: content.clone(),
                    is_error,
                });
                // Back-fill the persisted call's result by tool_use_id so the
                // reloaded card shows the same ✓/✗ + output the live stream did.
                if let Some(tc) = turn_tools.iter_mut().find(|t| &t.tool_use_id == id) {
                    tc.result = Some(crate::manager::PersistedToolResult {
                        is_error,
                        content: content.clone(),
                    });
                }
                (content, is_error)
            };
            result_blocks.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": content,
                "is_error": is_error,
            }));
        }
        request.messages.push(ChatMessage {
            role: "user".to_string(),
            content: Value::Array(result_blocks),
        });

        block_offset += round_max_idx + 1;
        // …re-stream with the tool results now in context.
    }

    // Hit the round cap with the model still wanting tools. Persist whatever
    // it produced (text + tool calls) and close gracefully rather than
    // spinning.
    if !full_text.is_empty() {
        persist_turn_with_tools(
            app,
            sid,
            ChatRole::Manager,
            full_text.take(),
            Some(brain_id.to_string()),
            std::mem::take(&mut turn_tools),
            turn_saved_tokens,
            last_usage,
        );
    } else {
        full_text.disarm();
    }
    if let Some((input_tokens, output_tokens)) = last_usage {
        emit(ChatChunk::Usage {
            input_tokens,
            output_tokens,
        });
    }
    record_turn_usage_async(
        repo_root,
        sid,
        brain_id,
        turn_model.as_deref(),
        turn_billed_input,
        turn_billed_output,
    );
    emit(ChatChunk::End { stop_reason: None });
    TurnResult::Done
}

/// Run an interactive (card-driving) tool the native loop surfaced — the
/// in-process twin of a CLI brain shelling out to `aura ask-user` /
/// `aura propose-plan`. It projects the QuestionCard / PlanCard onto the
/// Manager session and blocks until the user resolves it, then returns the
/// outcome as the `(content, is_error)` the loop feeds back to the model as
/// a `tool_result`.
///
/// Both branches reuse the exact blocking helpers the CLI socket bridge
/// uses (`ask_user_blocking` / `propose_plan_blocking`), so the SAME flow
/// fires whichever brain proposed: a plan runs Aura's Scout pre-review when
/// it's substantial, renders the existing PlanCard, and on Build mints the
/// dependency-ordered a2a tasks the Crew runs. `is_error` is always `false`
/// — a cancel or a timeout is a valid outcome the model must respect, not a
/// tool failure to retry.
async fn run_interactive_tool(
    app: &AppHandle,
    sid: &str,
    name: &str,
    input: &Value,
) -> (String, bool) {
    if native_tools::is_plan_tool(name) {
        let payload = native_tools::parse_propose_plan(input, sid);
        match crate::cmd_permission_socket::propose_plan_blocking(app, payload).await {
            crate::cli_bridge::PlanDecision::Build { .. } => {
                // Crew is the runner. On Build the shell mirrors every todo onto
                // the local board, syncs it into the loop graph, and auto-starts
                // the Crew runner — so by the time we get here the tasks are
                // already on the board AND real coding agents are working them in
                // the Build rail (dependency order, with proof). This is true
                // regardless of cloud a2a minting, so we don't gate the message
                // on the (cloud-only) `a2a_task_ids`. The model's job now is to
                // hand off cleanly: confirm and stop, never re-create the tasks
                // or fan out its own agents.
                (
                    "User approved the plan. Its tasks are now on the board and the Aura Crew has started working them in the Build rail — real coding agents, in dependency order, with proof. Do NOT create these tasks again with aura_task_create and do NOT spawn your own agents; the Crew owns execution. Briefly confirm to the user that the Crew is building the plan and that they can watch live progress (and retry anything that fails) in Build → Crew.".to_string(),
                    false,
                )
            }
            crate::cli_bridge::PlanDecision::Revise { feedback } => (
                format!(
                    "The user requested changes to the plan:\n\n{feedback}\n\nRevise the plan to address this feedback, then call the plan proposal tool again. Do not start implementation yet."
                ),
                false,
            ),
            crate::cli_bridge::PlanDecision::Cancel => (
                "User cancelled the plan. Do NOT create tasks, fan out agents, or start any of this work. Ask the user what they'd like to change, or simply wait for their next message."
                    .to_string(),
                false,
            ),
        }
    } else {
        // The brain may have batched 1–4 related questions in one `ask_user`
        // call — surface the whole clubbed set as one card and block until the
        // user answers them all. The QuestionCard joins the per-question
        // answers into the single string that returns here as the tool_result.
        let items = native_tools::parse_ask_user_set(input);
        let answer =
            crate::cmd_permission_socket::ask_user_items_blocking(app, sid, items).await;
        (answer, false)
    }
}

/// Load the `ManagerSession` to rebuild this turn's request from. Prefer the
/// live in-memory `ManagerRuntime` snapshot when one exists, falling back to
/// disk otherwise — the same precedence `persist_turn_with_tools` uses for
/// its write base. Reading the live state matters here because the user turn
/// is persisted into that live session immediately before this call: a
/// disk-only read could race a concurrent save and miss the just-pushed turn,
/// which would silently drop the current message from the model's context.
/// `None` when no session is registered live AND none exists on disk yet (a
/// turn that raced ahead of session creation) — the caller then builds a
/// single-turn request from the raw user message.
fn load_session_for_request(
    app: &AppHandle,
    session_id: &str,
) -> Option<crate::manager::ManagerSession> {
    use tauri::Manager as _;
    let live = app
        .try_state::<crate::cmd_manager::ManagerRuntime>()
        .and_then(|rt| {
            rt.sessions
                .lock()
                .unwrap()
                .get(session_id)
                .map(|l| l.state.lock().unwrap().clone())
        });
    match live {
        Some(s) => Some(s),
        None => persist::load(session_id).ok(),
    }
}

/// Continuity spine — distill the session's older chat in place when it has
/// grown past budget, choosing the threshold for the brain about to answer.
///
/// CLI engines (`cli_wrapper:` / `cli:`) ingest the whole transcript flattened
/// into one prompt with NO provider-side prompt cache, and a brain SWITCH
/// (this turn's brain differs from the one that produced the last Manager
/// turn) always lands cold on the new engine. For either, a full-transcript
/// replay is pure waste, so we compact early (`AGGRESSIVE_*`). A native brain
/// continuing on itself keeps the lenient `CHAT_BUDGET_TOKENS` budget so the
/// provider's prompt cache stays warm and we only distill near the real limit.
///
/// Mutates and persists via the SAME tested distiller the legacy path uses —
/// preferring the live in-memory session (so we observe the user turn just
/// pushed and write the compaction straight back into the running state) and
/// falling back to a disk round-trip when no session is registered live.
fn maybe_compact_for_turn(app: &AppHandle, session_id: &str, brain_id: &str) {
    use crate::manager::brain::legacy;
    use tauri::Manager as _;

    let is_cli = brain_id.starts_with("cli_wrapper:") || brain_id.starts_with("cli:");
    let pick = |chat: &[crate::manager::ChatTurn]| -> (u32, usize) {
        let switched = last_manager_brain(chat)
            .map(|prev| prev != brain_id)
            .unwrap_or(false);
        if is_cli || switched {
            (
                legacy::AGGRESSIVE_BUDGET_TOKENS,
                legacy::AGGRESSIVE_HOT_WINDOW,
            )
        } else {
            (legacy::CHAT_BUDGET_TOKENS, legacy::HOT_WINDOW)
        }
    };

    let live = app
        .try_state::<crate::cmd_manager::ManagerRuntime>()
        .and_then(|rt| {
            rt.sessions
                .lock()
                .unwrap()
                .get(session_id)
                .map(|l| l.state.clone())
        });

    match live {
        Some(state) => {
            let mut guard = state.lock().unwrap();
            let (budget, hot) = pick(&guard.chat);
            legacy::maybe_compact_session_inner(&mut guard, budget, hot);
            if let Err(e) = persist::save(&guard) {
                eprintln!(
                    "[brain-chat] failed to persist compaction for session {session_id}: {e}"
                );
            }
        }
        None => {
            if let Ok(mut s) = persist::load(session_id) {
                let (budget, hot) = pick(&s.chat);
                legacy::maybe_compact_session_inner(&mut s, budget, hot);
                let _ = persist::save(&s);
            }
        }
    }
}

/// The `brain` provider id that produced the most recent Manager (assistant)
/// turn, if any — used to detect a cross-engine switch. A session with no
/// prior Manager turn (the very first answer) returns `None` → not a switch.
fn last_manager_brain(chat: &[crate::manager::ChatTurn]) -> Option<&str> {
    chat.iter()
        .rev()
        .find(|t| matches!(t.role, ChatRole::Manager))
        .and_then(|t| t.brain.as_deref())
}

/// Persist one chat turn to the session on disk and emit a `manager:<sid>`
/// snapshot — the native-path equivalent of legacy.rs's `append_assistant`
/// + `persist_now` + `emit_session`.
///
/// Crucially it does **not** kick the legacy brain loop (no
/// `save_and_kick`): a native turn is already complete when we persist it,
/// so a kick would re-run it on the legacy path (double-execution — the
/// exact reason native turns weren't being persisted before). A missing
/// session file (turn raced ahead of session creation) is a silent no-op
/// rather than a turn failure.
fn persist_turn(
    app: &AppHandle,
    session_id: &str,
    role: ChatRole,
    text: String,
    brain: Option<String>,
) {
    persist_turn_with_tools(app, session_id, role, text, brain, Vec::new(), 0, None);
}

/// Like [`persist_turn`], but also records the tool calls the brain made on
/// this turn (in emission order, each paired with its result) so the settled
/// timeline re-renders the tool cards on reload instead of dropping them when
/// the live stream ends.
fn persist_turn_with_tools(
    app: &AppHandle,
    session_id: &str,
    role: ChatRole,
    text: String,
    brain: Option<String>,
    tool_calls: Vec<crate::manager::PersistedToolCall>,
    saved_tokens: u32,
    // Provider-reported (input, output) token usage for this turn (the final
    // round's figures). `None` when the brain didn't report usage — the
    // per-message token readout then simply doesn't render for this turn.
    usage: Option<(u32, u32)>,
) {
    use tauri::Manager as _;
    // `manager_status` returns the in-memory `ManagerRuntime` snapshot when
    // one exists, falling back to disk only otherwise. Every chat session is
    // registered in that map at creation (`start_session`), but a native turn
    // is pushed ONLY here — so persisting to disk alone leaves the live state
    // stale, and a status poll (the managerStore watchdog) resurrects the
    // chat-less snapshot and blanks the transcript. Prefer the live state as
    // our base so we never clobber orchestration progress that lives only in
    // memory, push the turn, then write it back to BOTH disk and the live
    // state so every reader agrees with the `manager:<sid>` emit below.
    let live_state = app
        .try_state::<crate::cmd_manager::ManagerRuntime>()
        .and_then(|rt| {
            rt.sessions
                .lock()
                .unwrap()
                .get(session_id)
                .map(|l| l.state.clone())
        });

    // Hold the live session's own lock across mutate + persist so a turn
    // pushed concurrently (another stream, an orchestration step) can't be
    // clobbered by writing back a stale clone. The previous clone-out → save
    // → blind-overwrite left a window where any push landing mid-save was
    // silently lost — including the user's own just-typed message.
    let session = match &live_state {
        Some(st) => {
            let mut guard = st.lock().unwrap();
            guard.push_chat_with_brain(role, text, brain);
            if let Some(last) = guard.chat.last_mut() {
                if !tool_calls.is_empty() {
                    last.tool_calls = tool_calls;
                }
                if saved_tokens > 0 {
                    last.saved_tokens = Some(saved_tokens);
                }
                if let Some((input, output)) = usage {
                    last.input_tokens = Some(input);
                    last.output_tokens = Some(output);
                }
            }
            // Surface the failure loudly instead of swallowing it with
            // `let _ =`. The turn stays in the live in-memory session, so it
            // re-saves on the next turn and is not lost from the running UI;
            // a persistent disk fault (full disk / perms) is now diagnosable.
            if let Err(e) = persist::save(&guard) {
                eprintln!(
                    "[brain-chat] failed to persist turn for session {session_id}: {e} \
                     — turn kept in memory, will re-save on the next turn"
                );
                emit_persist_error(app, session_id, &e);
            }
            guard.clone()
        }
        None => {
            let mut session = match persist::load(session_id) {
                Ok(s) => s,
                Err(_) => return,
            };
            session.push_chat_with_brain(role, text, brain);
            if let Some(last) = session.chat.last_mut() {
                if !tool_calls.is_empty() {
                    last.tool_calls = tool_calls;
                }
                if saved_tokens > 0 {
                    last.saved_tokens = Some(saved_tokens);
                }
                if let Some((input, output)) = usage {
                    last.input_tokens = Some(input);
                    last.output_tokens = Some(output);
                }
            }
            if let Err(e) = persist::save(&session) {
                eprintln!(
                    "[brain-chat] failed to persist turn for session {session_id}: {e}"
                );
                emit_persist_error(app, session_id, &e);
            }
            session
        }
    };
    let _ = app.emit(&format!("manager:{session_id}"), &session);
}

/// Tell the UI, in plain language, that a chat turn could not be written to
/// disk. The turn is still held in the live in-memory session — so nothing is
/// lost while the app keeps running and it re-saves on the next turn — but if
/// the app were closed before that, the message would be gone. The user has a
/// right to know that happened, so we surface it in the app (an event the
/// chat store turns into a notification) instead of only logging to a console
/// they never see. Best-effort: a failed emit is itself swallowed — we're
/// already on the unhappy path with nothing further to recover.
fn emit_persist_error(app: &AppHandle, session_id: &str, err: &impl std::fmt::Display) {
    let _ = app.emit(
        &format!("manager-persist-error:{session_id}"),
        format!(
            "Your last message couldn't be saved to this device ({err}). \
             It's still here for now and will try to save again on your next message."
        ),
    );
}

/// Cancel an in-flight `brain_chat_turn` for `session_id`. Aborts the
/// spawned task (which drops its `BoxStream`, releasing any HTTP / child
/// resources the brain held). No-op if no stream is in flight.
#[tauri::command]
pub async fn brain_chat_cancel(
    registry: State<'_, BrainStreamRegistry>,
    session_id: String,
) -> Result<(), String> {
    registry.cancel(&session_id);
    Ok(())
}

// Re-export so `cmd_manager` / other modules can reach the shared
// types without depending on the full module path.
#[allow(unused_imports)]
pub(crate) use brain::types as brain_types;
