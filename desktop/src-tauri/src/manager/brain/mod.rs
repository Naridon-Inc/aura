//! Brain abstraction layer — v0.2.30 KK.3.
//!
//! The `Brain` trait is the contract every chat backend implements.
//! Today (W1) the only live impl is the **legacy** path — the existing
//! 1750-line `brain.rs` that calls Anthropic directly when an API key
//! is set and falls back to PTY-wrapping a Claude Code / Gemini CLI /
//! Codex / Cursor binary otherwise. That code is preserved verbatim
//! in `legacy.rs` so `cmd_manager.rs` keeps working while we build
//! the new abstraction next to it.
//!
//! Waves 2–6 add real impls:
//!
//!   - `anthropic_native.rs`  — extracted from `legacy.rs`, Brain trait
//!   - `cli_wrapper.rs`       — Brain-trait wrap of PTY-spawn path
//!   - `gemini_native.rs`     — stub (real in v0.2.31)
//!   - `openai_native.rs`     — stub (real in v0.2.31)
//!
//! All impls map errors → `BrainError` and emit `ChatChunk` so the
//! frontend doesn't care which one ran.
//!
//! ## Re-exports
//!
//! For backward compatibility, the symbols `legacy.rs` exposed
//! (`run_turn`, `StreamDelta`, `BrainBackend`, etc.) are re-exported
//! from this module's root so callers like `cmd_manager.rs` and
//! `manager/mod.rs` continue to use `brain::Foo` paths unchanged.

pub(crate) mod http;
/// Line-delimited JSON over a child process's stdio — the transport shared
/// by every agent protocol Aura speaks natively (ACP, pi's rpc mode).
pub(crate) mod jsonl_stdio;
pub(crate) mod legacy;
/// Strips the terminal decoration a plain-text CLI (Kimi) draws around each
/// message, so a chat bubble shows what the model wrote and nothing else.
pub(crate) mod plain_cli_transcript;
pub mod keychain;
pub(crate) mod limits;
pub mod manager;
/// What an agent run may do, decided from the project's own committed rules
/// before anyone is prompted. `gate` asks the human; this decides whether the
/// question is even on the table, so a refused capability cannot be clicked
/// past and an allowed one costs no card.
pub mod authority;
pub mod control_plane;
/// Moving work that already exists onto an always-on machine — the cloud as a
/// *placement*, not a destination surface.
pub mod cloud_plane;
/// The other half of that idea: starting work on THIS machine, and bringing
/// cloud work home. Without it "these in the cloud, the rest here" has no
/// second clause.
pub mod local_plane;
/// What travels with the work when a conversation moves to another machine —
/// the transcript digest, and an honest account of what the remote checkout
/// will be missing.
pub mod handoff;
/// The return leg of a handover — watching the board for work that has
/// finished on a machine, and telling the conversation that placed it.
pub mod handback;
pub mod native_tools;
/// Where a conversation's hands are — this laptop, or a machine you connected.
/// The one seam that makes a cloud chat the same chat as a local one, and the
/// one runtime contract every surface that reaches a machine goes through.
pub mod place;
/// What a place can be asked, as plain data — the contract's nouns.
pub mod place_contract;
/// Who a member is on a place they share: their own Unix account, their own
/// home, their own key — so a shared box stops being one login everybody types.
pub mod place_account;
/// Bringing a place to the environment its project declares — toolchains,
/// packages and services, from one signed spec, over the same seam.
pub mod place_env;
/// What a place has, set against what the project asks it for — the capability
/// probe and the declared spec joined into one diff, so "works here, not there"
/// is something you can read rather than something you go and find out.
pub mod place_drift;
/// What a remote is — its host, whether it goes in the clear, and which service
/// answers there, which is what decides the username a token is spent under.
pub mod place_forge;
/// Whose credential a place pushes with — the seam between "this member, this
/// remote" and a token, with the shared box credential demoted to a labelled
/// last resort rather than the silent default.
pub mod place_git;
/// Which credential an agent run spends, and whose it is: the member's own
/// sign-in or key first, with the box's key and the org's key kept as labelled
/// fallbacks rather than the silent default every member's tokens came out of.
pub mod place_agent_key;
/// Lending a place the ssh agent on this laptop, so a push can be signed by the
/// member's own key without the key ever landing on a machine they share — off
/// until they say so, per place, and taken back when the work there ends.
pub mod place_forward;
/// Stopping a place nobody is using, so an idle machine Aura made costs
/// nothing — and making sure a stopped one reads as asleep everywhere rather
/// than as a box that broke.
pub mod place_sleep;
/// Starting a place that Aura stopped, in front of whatever call reached it —
/// so a machine being cheap never has to be told apart from a machine being
/// broken by the person who just wanted to open a file.
pub mod place_wake;
/// Letting Aura stop and start a machine you own, in a cloud account you own —
/// the ask, the proof that it works, and the way to take it back. What turns
/// "Aura holds no account that could stop this" from a permanent fact about a
/// box you brought into a thing you can change.
pub mod place_grant;
/// Whose NAME ends up on the commit, as opposed to whose token carries it: the
/// signed-in account's identity, written repo-local on the machine the work
/// actually runs on rather than on the laptop that opened the app.
pub mod place_author;
/// Where a member's global installs land, so `npm install -g` on a shared box
/// stops being everybody's.
pub mod place_toolchain;
/// Somewhere for the box to swap to, so a member reaching their memory ceiling
/// gets a slow build rather than a killed one.
pub mod place_swap;
/// Installing a tool for one member only: the escape hatch that makes the
/// declared spec tolerable, into the home `place_toolchain` already scoped.
pub mod place_toolbox;
/// The team's environment, built once in an account that belongs to nobody, and
/// each member's private home started from a copy of it. The bill `place_account`
/// and `place_toolchain` handed the second member, paid back.
pub mod place_base;
/// The parity proof: every place run through the whole workflow matrix, with
/// the handful of honest asymmetries declared up front rather than discovered.
/// A mode is not shipped until its column is green.
#[cfg(test)]
mod place_conformance;
/// Getting a terminal into a place: one command body, two transports, and the
/// one line the frontend is allowed to type into a pty it did not spawn.
pub mod place_open;
/// Getting a member's secrets into a place's environment at boot, and nowhere
/// near a model — a value goes from the vault to a process and stops.
pub mod place_secrets;
/// Where a member's secrets for one project are held: on this laptop, `0600`,
/// and never in a type that can be serialized to a surface.
pub mod secret_vault;
/// The work running at a place — sessions, projects, what it can run.
mod place_sessions;
/// Which of the projects a place holds belong to the org you opened it as. The
/// discovery is `place_sessions`'; this narrows what came back.
pub mod place_projects;
/// The agent phase's allowlist at a place: what it may reach once the setup
/// phase has finished installing, and what it was refused.
pub mod place_egress;
/// What a turn cost in dollars — rate lookup for the spend meter.
pub mod pricing;
/// Reading the web — `web_fetch` / `web_search` for the native tool loop.
pub mod web_tools;
pub mod registry;
/// Reconciling a stateless `ChatRequest` against an agent process that
/// remembers the conversation.
pub mod session;
pub mod settings;
pub mod types;

/// The gate every hosted agent passes through, whatever protocol it speaks:
/// who to ask before a tool runs, and what happens before a file is
/// overwritten.
pub mod gate;

/// The Agent Client Protocol — coding agents as real chat brains, with
/// their file writes and tool calls routed through Aura's own guards.
#[cfg(feature = "brain_acp")]
pub mod acp;

/// pi over its own RPC mode — the same deal as [`acp`], for an engine that
/// runs its own tools and offers a pre-execution hook instead.
#[cfg(feature = "brain_pi")]
pub mod pi;

#[cfg(feature = "brain_anthropic_native")]
pub mod anthropic_native;

#[cfg(feature = "brain_cli_wrapper")]
pub mod cli_wrapper;
/// Plain-language mapping for failed engine-CLI subprocesses (never leaks the
/// system prompt embedded in a CLI's stderr).
pub mod engine_errors;

#[cfg(feature = "brain_gemini_native")]
pub mod gemini_native;

#[cfg(feature = "brain_openai_native")]
pub mod openai_native;

#[cfg(feature = "brain_openai_compat")]
pub mod openai_compat;

#[cfg(feature = "brain_aura_pro")]
pub mod aura_pro;

/// Shared Anthropic Messages SSE decoder — used by both the direct
/// `anthropic_native` brain and Vertex (Anthropic-on-Vertex emits the same
/// event stream).
#[cfg(any(feature = "brain_anthropic_native", feature = "brain_vertex"))]
pub mod anthropic_sse;

// AWS Bedrock (Claude) — SigV4-signed `/invoke`. The signing primitive itself
// lives at `crate::aws_sigv4`: it stopped being a Bedrock detail the day the
// managed-place driver had to sign EC2 with it, and a feature-gated copy of it
// in here would have meant the provisioner compiled or not depending on which
// brains were enabled.
#[cfg(feature = "brain_bedrock")]
pub mod bedrock;

// Google Vertex AI (Claude) — GCP OAuth2 Bearer + Anthropic-native SSE.
// `gcp_oauth` mints the token from a service-account JSON; `vertex` is the
// Brain impl.
#[cfg(feature = "brain_vertex")]
pub mod gcp_oauth;
#[cfg(feature = "brain_vertex")]
pub mod vertex;

pub use legacy::*;
pub use types::{
    AgentSurface, BrainCapabilities, BrainError, ChatChunk, ChatMessage, ChatRequest, cap_keys,
};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};

use super::{ChatRole, ChatTurn};

/// Canonical engine family for a brain/provider id, normalised across the
/// two id formats that reach us: the native `provider_id`
/// (`cli_wrapper:gemini`, `anthropic_native`, `aura_pro`) and the legacy
/// `BrainBackend::id()` (`cli:gemini`, `anthropic`). Both collapse to the
/// same family token so "is this the engine answering now?" is a stable
/// comparison regardless of which path persisted the turn.
pub(crate) fn engine_family(provider_id: &str) -> &'static str {
    let core = provider_id
        .strip_prefix("cli_wrapper:")
        .or_else(|| provider_id.strip_prefix("cli:"))
        .unwrap_or(provider_id);
    match core {
        "anthropic" | "anthropic_native" | "aura_pro" | "claude" | "claude_code" | "bedrock"
        | "vertex" => "claude",
        "gemini" | "gemini_native" => "gemini",
        "codex" | "openai" | "openai_native" => "codex",
        "cursor" => "cursor",
        "kimi" => "kimi",
        "opencode" => "opencode",
        other if other.starts_with("openai_compat:") => "openai_compat",
        _ => "other",
    }
}

/// Human display name for a brain/provider id — what the user sees on the
/// turn chip, reused here to attribute a peer engine's earlier turn.
pub(crate) fn engine_label(provider_id: &str) -> String {
    let core = provider_id
        .strip_prefix("cli_wrapper:")
        .or_else(|| provider_id.strip_prefix("cli:"))
        .unwrap_or(provider_id);
    match core {
        "anthropic" | "anthropic_native" => "Claude".to_string(),
        "aura_pro" => "Aura Pro".to_string(),
        "bedrock" => "Claude (Bedrock)".to_string(),
        "vertex" => "Claude (Vertex)".to_string(),
        "claude" | "claude_code" => "Claude Code".to_string(),
        "gemini" | "gemini_native" => "Gemini".to_string(),
        "codex" => "Codex".to_string(),
        "openai" | "openai_native" => "OpenAI".to_string(),
        "cursor" => "Cursor".to_string(),
        "kimi" => "Kimi".to_string(),
        "opencode" => "OpenCode".to_string(),
        other => other
            .strip_prefix("openai_compat:")
            .unwrap_or(other)
            .to_string(),
    }
}

/// Shape the authoritative persisted chat (`ManagerSession.chat`) into the
/// `ChatMessage` list a brain consumes. This is the SINGLE source of truth
/// for turn → model-message conversion: both the legacy hand-rolled
/// Anthropic path (`legacy.rs::build_request`) and the native brain path
/// (`cmd_brain_chat::brain_chat_turn`) call it so the two never drift.
///
/// `current_brain` is the provider id of the engine that will answer THIS
/// turn. Manager turns authored by a *different* engine are attributed
/// inline (`[aura] (earlier turn, answered by Gemini) …`) instead of being
/// fed as the current model's own assistant output. Without this, a brain
/// switch replays a peer's words as the new model's own history — so asked
/// "which model are you / who spoke before you", the new engine sees the
/// peer's "I am Gemini" as something IT said, can't reconcile it with its
/// real identity, and confabulates that it lied or roleplayed. Attribution
/// is the deterministic fix: each engine only ever owns its own turns.
///
/// Why server-side reconstruction matters: the frontend flattens
/// `session.chat` to `t.text` only, so a CLI / "Claude Code" turn whose
/// substance was tool cards arrives with empty text. Rebuilding from the
/// persisted store here — which DOES carry every turn's role + visible text
/// — means ANY brain (native or CLI) receives the full visible transcript,
/// so swapping the composer model mid-conversation preserves the thread
/// instead of the new brain seeing a near-empty history and replying
/// "fresh session start".
///
/// Per-role shaping mirrors `build_request` exactly:
///   - `User`   → `user` turn; one `image` block per attachment (images
///                first so the model lands on them before the prompt) then
///                a `text` block. Attachment-only turns get an
///                `[image attached]` hint (Anthropic rejects an empty-only
///                text block).
///   - `Manager`→ `assistant` turn carrying the visible text (skipped when
///                empty).
///   - `System` → relayed as an `assistant` turn prefixed `[aura]` (the API
///                has no inline system role; the preamble teaches the model
///                that `[aura]` lines are system-authored), skipped when
///                empty.
pub(crate) fn chat_to_messages(chat: &[ChatTurn], current_brain: Option<&str>) -> Vec<ChatMessage> {
    let current_family = current_brain.map(engine_family);
    let mut messages: Vec<ChatMessage> = Vec::with_capacity(chat.len());
    for turn in chat {
        match turn.role {
            ChatRole::User => {
                if turn.attachments.is_empty() {
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: json!([{ "type": "text", "text": turn.text }]),
                    });
                } else {
                    // Multi-block: one image per attachment + a text block.
                    // Anthropic's image content block expects base64 data
                    // with the original media type. Images come first so the
                    // model lands on them before reading the prompt — matches
                    // how humans look at a screenshot before reading a
                    // question about it.
                    let mut content: Vec<Value> =
                        Vec::with_capacity(turn.attachments.len() + 1);
                    for att in &turn.attachments {
                        content.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": att.media_type,
                                "data": att.data_base64,
                            },
                        }));
                    }
                    let text = if turn.text.trim().is_empty() {
                        // Anthropic rejects user turns whose only text block
                        // is empty — supply a minimal hint so the model knows
                        // to look at the image.
                        "[image attached]".to_string()
                    } else {
                        turn.text.clone()
                    };
                    content.push(json!({ "type": "text", "text": text }));
                    messages.push(ChatMessage {
                        role: "user".to_string(),
                        content: Value::Array(content),
                    });
                }
            }
            ChatRole::Manager => {
                // Manager turns are stored as plain text; on the wire they
                // become assistant messages. A turn authored by a DIFFERENT
                // engine than the one answering now is attributed inline so
                // the current model never mistakes a peer's words — or a
                // peer's stated identity — for its own.
                if !turn.text.is_empty() {
                    let foreign = match (turn.brain.as_deref(), current_family) {
                        (Some(b), Some(cur)) => engine_family(b) != cur,
                        _ => false,
                    };
                    let text = if foreign {
                        let label = engine_label(turn.brain.as_deref().unwrap_or_default());
                        format!("[aura] (earlier turn, answered by {label}) {}", turn.text)
                    } else {
                        turn.text.clone()
                    };
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: json!([{ "type": "text", "text": text }]),
                    });
                }
            }
            ChatRole::System => {
                // Bucket M3 — episode digests + inline event lines.
                // Anthropic's API doesn't accept a "system" role inline
                // (system is a top-level field), so we relay these as
                // assistant turns prefixed with `[aura]` to keep them
                // distinguishable in transcripts. The brain's preamble
                // already teaches it that `[aura]` lines are system-
                // authored, not its own past output.
                if !turn.text.is_empty() {
                    messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: json!([{
                            "type": "text",
                            "text": format!("[aura] {}", turn.text),
                        }]),
                    });
                }
            }
        }
    }
    messages
}

/// A streaming chat backend. One impl per provider (Anthropic, OpenAI,
/// Gemini) plus one for spawning external CLIs.
///
/// Brains are stateless w.r.t. conversation; the caller passes the full
/// `ChatRequest` each turn. They may hold connection pools, child
/// processes, or HTTP clients internally — those are reused across
/// calls but never carry conversation state.
#[async_trait]
pub trait Brain: Send + Sync {
    /// Stable identifier shipped in `BrainSettings.active_provider_id`
    /// (`anthropic_native`, `cli_wrapper:claude_code`, etc.). Used to
    /// route the active brain after a settings change and to label
    /// transcript turns in episodic memory.
    fn provider_id(&self) -> &str;

    /// Static capability advertisement consulted by the UI to enable
    /// or disable features (tool-use chips, vision drop-zone, model
    /// picker). May be cached by callers — impls should not encode
    /// per-session state here.
    fn capabilities(&self) -> BrainCapabilities;

    /// Run one chat turn. The returned stream yields `ChatChunk`s as
    /// tokens / tool-use blocks arrive, terminating with a single
    /// `ChatChunk::End`. Errors land as `Err(BrainError)` either at
    /// stream construction or mid-stream.
    ///
    /// The stream is cancel-safe: dropping it MUST tear down whatever
    /// the impl is holding (HTTP body, child process, etc.).
    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError>;

    /// What this brain's live session in `cwd` is offering right now — the
    /// slash commands the agent publishes, the modes it can work in, the
    /// plan it is working to. See [`AgentSurface`] for why none of it is a
    /// capability or a transcript chunk.
    ///
    /// `None` unless there is a live session to ask about, which is also
    /// the honest answer for every brain that isn't a hosted agent: an
    /// HTTP model publishes no commands and has no modes.
    async fn session_surface(&self, _cwd: &str) -> Option<AgentSurface> {
        None
    }

    /// Put the live session in `cwd` into `mode`, one of the ids its
    /// [`session_surface`](Brain::session_surface) offered.
    ///
    /// The default refuses instead of succeeding quietly. A control that
    /// reports success and changes nothing is worse than one that isn't
    /// there — in plan mode's case, it would claim the agent had been
    /// stopped from editing when it had not.
    async fn set_session_mode(&self, _cwd: &str, mode: &str) -> Result<(), BrainError> {
        Err(BrainError::Other {
            message: format!(
                "{} has no modes to switch between, so it cannot be put into `{mode}`.",
                self.provider_id()
            ),
        })
    }

    /// v0.2.31 LL.1 — Compress a lane transcript down to a dense parent-
    /// facing summary. The Orchestrator uses this when a specialist lane
    /// finishes so the parent manager receives summary-only context (not
    /// the full transcript), preserving the parent's context budget.
    ///
    /// Default impl is a deterministic non-LLM trim: trailing 500 chars
    /// of the transcript (whitespace-collapsed). Native brains can
    /// override to call their own provider for a real summarisation
    /// pass — they get the full transcript and return a single block of
    /// text. Errors propagate; the dispatcher catches and falls back to
    /// the default trim so a flaky summariser never blocks merge.
    async fn summarize(&self, transcript: &str) -> Result<String, BrainError> {
        const MAX_CHARS: usize = 500;
        let collapsed: String = transcript
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let trimmed = if collapsed.chars().count() <= MAX_CHARS {
            collapsed
        } else {
            let start = collapsed
                .char_indices()
                .nth_back(MAX_CHARS - 1)
                .map(|(i, _)| i)
                .unwrap_or(0);
            format!("…{}", &collapsed[start..])
        };
        Ok(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::ChatRole;

    fn manager_turn(text: &str, brain: Option<&str>) -> ChatTurn {
        ChatTurn {
            role: ChatRole::Manager,
            text: text.to_string(),
            at: 0,
            answered_question: None,
            anchor: None,
            attachments: Vec::new(),
            brain: brain.map(|b| b.to_string()),
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
            input_tokens: None,
            output_tokens: None,
            model: None,
            cost_usd: None,
            cost_estimated: None,
        }
    }

    #[test]
    fn engine_family_normalises_across_id_formats() {
        // Native provider_id and legacy BrainBackend::id() collapse to one token.
        assert_eq!(engine_family("anthropic"), "claude");
        assert_eq!(engine_family("anthropic_native"), "claude");
        assert_eq!(engine_family("aura_pro"), "claude");
        assert_eq!(engine_family("cli_wrapper:claude_code"), "claude");
        assert_eq!(engine_family("cli:gemini"), "gemini");
        assert_eq!(engine_family("cli_wrapper:gemini"), "gemini");
        assert_eq!(engine_family("cli:codex"), "codex");
        assert_eq!(engine_family("openai_native"), "codex");
        assert_eq!(engine_family("openai_compat:moonshot"), "openai_compat");
        assert_eq!(engine_family("something_unknown"), "other");
    }

    #[test]
    fn foreign_engine_turn_is_attributed_same_family_is_plain() {
        // Gemini answered earlier; Claude is answering now. Gemini's turn must
        // be attributed so Claude never reads it as its own past output (the
        // identity-fabrication bug). Claude's own earlier turn stays plain.
        let chat = vec![
            manager_turn("I am Gemini and I helped you.", Some("cli_wrapper:gemini")),
            manager_turn("Continuing the work.", Some("anthropic_native")),
        ];
        let msgs = chat_to_messages(&chat, Some("anthropic_native"));
        assert_eq!(msgs.len(), 2);

        let first = msgs[0].content[0]["text"].as_str().unwrap();
        assert!(
            first.starts_with("[aura] (earlier turn, answered by Gemini)"),
            "foreign turn must carry attribution, got: {first}"
        );
        assert!(first.contains("I am Gemini and I helped you."));

        let second = msgs[1].content[0]["text"].as_str().unwrap();
        assert_eq!(
            second, "Continuing the work.",
            "same-family turn must stay verbatim (no attribution prefix)"
        );
    }

    #[test]
    fn no_current_brain_leaves_all_turns_plain() {
        // Backwards-compatible: callers that don't know the answering engine
        // (legacy sessions, no brain_backend) get the old verbatim behaviour.
        let chat = vec![manager_turn("hello", Some("cli_wrapper:gemini"))];
        let msgs = chat_to_messages(&chat, None);
        assert_eq!(msgs[0].content[0]["text"].as_str().unwrap(), "hello");
    }
}
