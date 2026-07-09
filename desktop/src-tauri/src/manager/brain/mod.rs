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

pub(crate) mod legacy;
pub mod keychain;
pub(crate) mod limits;
pub mod manager;
pub mod native_tools;
pub mod registry;
pub mod settings;
pub mod types;

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

pub use legacy::*;
pub use types::{
    BrainCapabilities, BrainError, ChatChunk, ChatMessage, ChatRequest, cap_keys,
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
        "anthropic" | "anthropic_native" | "aura_pro" | "claude" | "claude_code" => "claude",
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
