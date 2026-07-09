//! Brain abstraction — provider-agnostic chat types.
//!
//! W1 of v0.2.30 KK.3. Anchors the trait surface so future brains
//! (`anthropic_native`, `cli_wrapper`, `gemini_native`, `openai_native`)
//! emit identical events to the frontend regardless of how the bytes
//! were produced.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A single message in a chat conversation. Mirrors the OpenAI / Anthropic
/// `messages: [...]` shape; brains map this onto their provider format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// `user`, `assistant`, or `system`.
    pub role: String,
    /// Plain text or JSON-serialized content blocks (tool_use/tool_result).
    pub content: Value,
}

/// What the caller wants the brain to do this turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    /// Conversation so far.
    pub messages: Vec<ChatMessage>,
    /// Optional system prompt override. None → brain default.
    #[serde(default)]
    pub system: Option<String>,
    /// Tool schemas the brain may invoke. Vendor-specific; the brain
    /// translates as needed.
    #[serde(default)]
    pub tools: Vec<Value>,
    /// Soft cap on tokens generated this turn. Brains may clamp lower.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Sampling temperature (0.0–1.0). None → brain default.
    #[serde(default)]
    pub temperature: Option<f32>,
    /// Cross-agent reasoning effort for this turn. `None` → provider default
    /// (request byte-identical to the pre-effort build). Each brain maps it
    /// onto its own real mechanism — Anthropic/Gemini thinking budgets,
    /// OpenAI `reasoning_effort`, or a CLI's own flag/keyword.
    #[serde(default)]
    pub effort: Option<aura_agents::ReasoningEffort>,
    /// Latency-first toggle (⚡). Collapses effort to the provider minimum /
    /// disables extended thinking. Orthogonal to `effort`.
    #[serde(default)]
    pub fast: bool,
    /// Per-turn model override from the composer's model picker. `None` →
    /// the brain's own configured/default model (request byte-identical to
    /// the pre-picker build). Each native brain swaps this in place of its
    /// `self.model`; brains whose model id doesn't apply ignore it.
    #[serde(default)]
    pub model: Option<String>,
    /// Long-context variant (the picker's "1M" model rows). `true` →
    /// Anthropic-family brains add the 1M-context beta header. Other
    /// providers ignore it (their long-context is implicit in the model id).
    #[serde(default)]
    pub long_context: bool,
    /// Cross-agent permission / autonomy mode for this turn (the composer's
    /// Approvals chip). `None` → the agent's own default gating (request
    /// byte-identical to the pre-feature build). CLI brains map it onto the
    /// real per-CLI approval flag; native brains run their own tool loop and
    /// currently ignore it.
    #[serde(default)]
    pub approval: Option<aura_agents::ApprovalPolicy>,
    /// Working directory for this turn — the repo/worktree root the user is
    /// actually in. CLI-wrapper brains spawn their subprocess here (so a
    /// "Claude Code" turn opened in a worktree runs *inside* that worktree,
    /// not the desktop app's launch dir / HOME). Empty → `safe_spawn_dir`
    /// falls back to HOME, preserving the pre-feature behavior. Native brains
    /// ignore it (their built-in tool loop is rooted via its own `repo_root`).
    #[serde(default)]
    pub cwd: String,
}

/// Build the cacheable request prefix: the system prompt and tool list with
/// an Anthropic `cache_control: {type: "ephemeral"}` breakpoint on the
/// stable tail, so the prompt cache can serve the system+tools prefix on
/// repeat requests (the 2nd+ round of a tool loop, later turns of the same
/// session) instead of re-billing the full system+tools every time.
///
/// - `system` becomes a one-element array of a text content block carrying
///   the breakpoint — Anthropic caches everything up to it, i.e. tools +
///   system. `Value::Null` when there is no system prompt.
/// - the LAST tool also gets a breakpoint, so a tools-only request (no
///   system) is still cached.
///
/// The markers sit on a byte-stable tail, so identical inputs always
/// serialize identically — which is what makes the cache actually hit.
/// Below the model's cache minimum the API ignores the markers, so this is
/// always safe to send. Gated to the two Anthropic-shaped brains that use
/// it so it doesn't warn as dead code in builds without them.
#[cfg(any(feature = "brain_anthropic_native", feature = "brain_aura_pro"))]
pub(crate) fn cacheable_prefix(system: Option<&str>, tools: &[Value]) -> (Value, Vec<Value>) {
    use serde_json::json;
    let system_val = match system.filter(|s| !s.is_empty()) {
        Some(s) => json!([{
            "type": "text",
            "text": s,
            "cache_control": { "type": "ephemeral" },
        }]),
        None => Value::Null,
    };
    let mut tools_val = tools.to_vec();
    if let Some(last) = tools_val.last_mut().and_then(|t| t.as_object_mut()) {
        last.insert("cache_control".to_string(), json!({ "type": "ephemeral" }));
    }
    (system_val, tools_val)
}

/// Token accounting for one turn, surfaced to the UI's context-fill meter.
/// `input_tokens` is the prompt the provider billed (history + system +
/// tools), `output_tokens` is what the model generated. Both are best-effort:
/// providers that don't report usage simply never emit a `ChatChunk::Usage`,
/// and the meter stays hidden. Mirrors the TS `BrainTokenUsage`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

/// One streaming event from `Brain::chat`. Frontend reassembles into bubbles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatChunk {
    /// Incremental text — append to the active assistant bubble at `block_idx`.
    Text { block_idx: usize, text: String },
    /// Incremental extended-thinking / reasoning text — append to the
    /// collapsible reasoning block at `block_idx`. Emitted only by brains that
    /// expose a chain-of-thought stream (Anthropic extended thinking, Gemini
    /// `thought` parts) when the caller opted into an effort level. Rendered
    /// as a muted, collapsed "Thinking…" disclosure ABOVE the answer prose so
    /// it never competes with the response. Brains that don't think emit none
    /// and the block never appears.
    Reasoning { block_idx: usize, text: String },
    /// Per-turn token accounting. Emitted once, right before `End`, by brains
    /// that report usage (Anthropic `message_delta.usage`, OpenAI/Gemini
    /// `usage`/`usageMetadata`). The native tool loop forwards the final
    /// round's usage so the UI's context-fill meter has real numbers. A turn
    /// from a provider that doesn't report usage simply omits this chunk.
    Usage {
        input_tokens: u32,
        output_tokens: u32,
    },
    /// Complete tool-use block. `tool_use_id` matches the eventual `ToolResult`
    /// the caller sends back in the next `ChatRequest`.
    ToolUse {
        block_idx: usize,
        tool_use_id: String,
        name: String,
        input: Value,
    },
    /// Result of a server-side tool execution, keyed back to the originating
    /// `ToolUse` by `tool_use_id` so the frontend can attach it to that
    /// tool card. Emitted by the native brain's built-in tool loop
    /// (`cmd_brain_chat`) after it runs a board/page tool; ordinary brains
    /// never yield this themselves. Not block-indexed — the card is found by
    /// `tool_use_id`, not position.
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
    /// Turn finished cleanly. `stop_reason` is the provider's stop reason
    /// (`end_turn`, `tool_use`, `max_tokens`, etc.) where available.
    End {
        #[serde(default)]
        stop_reason: Option<String>,
    },
    /// Stream terminated by an error. Surfaced on the wire as a final
    /// chunk so the frontend can render an error bubble without needing
    /// a separate channel. `Brain` impls themselves still return
    /// `Err(BrainError)` from `chat()` / inside the stream — the
    /// command-layer adapter (`cmd_brain_chat`) translates those into
    /// `ChatChunk::Error` events for emission. Down-stream `From`
    /// keeps the conversion ergonomic.
    Error { message: String },
}

impl From<BrainError> for ChatChunk {
    fn from(e: BrainError) -> Self {
        ChatChunk::Error {
            message: e.to_string(),
        }
    }
}

/// Unified error surface across all brains.
#[derive(Debug, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrainError {
    /// Networking failed (timeout, DNS, TLS).
    #[error("network: {message}")]
    Network { message: String },
    /// Provider returned a non-2xx HTTP response. `status` is the HTTP code,
    /// `message` is the body or a parsed error string.
    #[error("api {status}: {message}")]
    Api { status: u16, message: String },
    /// Spawning or talking to a child process failed (CLI brains).
    #[error("process: {message}")]
    Process { message: String },
    /// Could not parse a stream chunk into a `ChatChunk`.
    #[error("parse: {message}")]
    Parse { message: String },
    /// Keychain read/write failed, or the requested key is missing.
    #[error("keychain: {message}")]
    Keychain { message: String },
    /// Caller asked to cancel and the brain honored it.
    #[error("canceled")]
    Canceled,
    /// Brain identified by `provider_id` is not registered in this build.
    #[error("unknown provider: {provider_id}")]
    UnknownProvider { provider_id: String },
    /// Caller is not signed in (or the stored auth token was rejected).
    /// Surfaced primarily by the `aura_pro` brain when the user has
    /// signed out / their session expired; the picker UI uses this to
    /// re-launch the existing onboarding flow rather than ask for an
    /// API key the user doesn't have.
    #[error("auth_required: {message}")]
    AuthRequired { message: String },
    /// Subscription / quota check failed — the proxy returned HTTP 402.
    /// `tokens_used` and `monthly_token_limit` are passed through when
    /// the server includes them so the desktop can render an exact
    /// "X / Y tokens used" banner without a follow-up RTT.
    #[error("quota_exceeded: {message}")]
    QuotaExceeded {
        message: String,
        #[serde(default)]
        tokens_used: Option<i64>,
        #[serde(default)]
        monthly_token_limit: Option<i64>,
    },
    /// Provider returned an error we couldn't classify into the variants
    /// above (vendor-specific 5xx, malformed gateway response, etc.).
    /// Kept distinct from `Api` so callers can decide to retry once
    /// versus surfacing a hard failure to the user. `status` is the HTTP
    /// code when available — `None` for non-HTTP transports (CLI, etc.).
    #[error("provider: {message}")]
    Provider {
        #[serde(default)]
        status: Option<u16>,
        message: String,
    },
    /// Catch-all for impl bugs or third-party crates we don't have a finer
    /// classification for.
    #[error("other: {message}")]
    Other { message: String },
}

/// Capabilities a brain reports so the UI can adapt (enable/disable
/// tool calling, surface model picker, etc). HashMap-backed so impls
/// can add provider-specific keys without touching the trait surface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BrainCapabilities {
    pub entries: HashMap<String, Value>,
}

impl BrainCapabilities {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.entries.insert(key.into(), value.into());
        self
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.get(key)
    }

    pub fn bool(&self, key: &str) -> Option<bool> {
        self.entries.get(key).and_then(|v| v.as_bool())
    }
}

/// Well-known capability keys. Stringly-typed by design so brains can
/// add their own without breaking other impls.
pub mod cap_keys {
    pub const SUPPORTS_STREAMING: &str = "supports_streaming";
    pub const SUPPORTS_TOOL_USE: &str = "supports_tool_use";
    pub const SUPPORTS_VISION: &str = "supports_vision";
    pub const MAX_INPUT_TOKENS: &str = "max_input_tokens";
    pub const MAX_OUTPUT_TOKENS: &str = "max_output_tokens";
    pub const SUPPORTED_MODELS: &str = "supported_models";
    pub const DEFAULT_MODEL: &str = "default_model";
}
