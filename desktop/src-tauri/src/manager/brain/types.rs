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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// `user`, `assistant`, or `system`.
    pub role: String,
    /// Plain text or JSON-serialized content blocks (tool_use/tool_result).
    pub content: Value,
}

/// What the caller wants the brain to do this turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

/// Rewrite Anthropic-shaped message content into the multi-part shape the
/// OpenAI Chat Completions API accepts.
///
/// Aura authors every user turn in Anthropic's block shape, and for text-only
/// turns the two APIs agree closely enough that the content used to be passed
/// through untouched. Images don't agree: Anthropic carries base64 in
/// `{"type":"image","source":{...}}` and OpenAI wants a data URL in
/// `{"type":"image_url","image_url":{"url":...}}`. Passing the block through
/// meant OpenAI rejected the request outright — attaching a screenshot to an
/// OpenAI-backed chat failed 100% of the time.
///
/// A plain string is returned unchanged (the common case, and the cheapest
/// wire form). Blocks that aren't text or image pass through as-is: this path
/// carries no tool traffic, and inventing a translation for a block we don't
/// produce would be guesswork.
pub fn content_to_openai(content: &Value) -> Value {
    let Some(blocks) = content.as_array() else {
        return content.clone();
    };
    let mapped: Vec<Value> = blocks
        .iter()
        .map(|block| match block.get("type").and_then(|v| v.as_str()) {
            Some("image") => {
                let src = block.get("source").cloned().unwrap_or_default();
                let media_type = src
                    .get("media_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("image/png");
                if let Some(data) = src.get("data").and_then(|v| v.as_str()) {
                    serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{media_type};base64,{data}") },
                    })
                } else if let Some(url) = src.get("url").and_then(|v| v.as_str()) {
                    serde_json::json!({ "type": "image_url", "image_url": { "url": url } })
                } else {
                    block.clone()
                }
            }
            _ => block.clone(),
        })
        .collect();
    Value::Array(mapped)
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

/// A slash command a hosted agent publishes for the session it is in.
///
/// Aura's own palette is a static list compiled into the app. This is the
/// other kind: whatever the agent itself decided it can do here, which for
/// OpenCode means its built-in commands plus every skill the user has
/// installed into it. Neither Aura nor the user can enumerate that in
/// advance — only the agent knows, and only once it is running.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentCommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// One way of working the agent offers. OpenCode ships `build` and `plan`;
/// plan mode refuses every edit tool, which is a real safety control and
/// the reason this is worth surfacing rather than leaving buried.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentMode {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

/// One step of the agent's own plan for the work in front of it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentPlanEntry {
    pub content: String,
    /// `pending`, `in_progress`, `completed` — the agent's word, passed
    /// through rather than mapped, so a new one shows up instead of being
    /// silently bucketed as something it isn't.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
}

/// What a live agent session is offering right now, beyond its replies.
///
/// This is session state, and deliberately neither of the two places it
/// could have gone:
///
///   - not [`BrainCapabilities`], which is static and cached by callers —
///     "OpenCode is in plan mode" is not a property of the build;
///   - not a [`ChatChunk`], which is transcript: persisted to disk,
///     replayed on reload, synced, exported. A command list is not
///     something that was *said*.
///
/// So it is read from the live brain on demand instead. All three arrive
/// unprompted over ACP while a turn runs, and every one of them used to be
/// parsed and then dropped on the floor.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentSurface {
    /// Slash commands the agent publishes for this session.
    pub commands: Vec<AgentCommand>,
    /// The modes it can work in.
    pub modes: Vec<AgentMode>,
    /// Which of `modes` it is in now.
    pub current_mode: Option<String>,
    /// Its plan, while it is working to one.
    pub plan: Vec<AgentPlanEntry>,
}

/// One streaming event from `Brain::chat`. Frontend reassembles into bubbles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// What this turn cost, and what the key behind it has cost in total.
    ///
    /// Emitted once per turn, right before `End`, and only in API mode — a
    /// brain driven by a CLI subscription or the Aura cloud isn't billed per
    /// token here, so no figure is invented for it. `cost_usd` prices every
    /// round of the tool loop (each round is its own billed request), while
    /// `spend_usd` is the running total for the API key since it was added,
    /// summed across every project it has been used in — the number people
    /// actually want when they wonder what an app is doing to their bill.
    ///
    /// `estimated` marks a turn priced off the tier fallback rather than a
    /// published rate; the UI shows it as `~$…`. A model nobody can price
    /// emits no chunk at all rather than a confident wrong number.
    Cost {
        cost_usd: f64,
        spend_usd: f64,
        /// Unix seconds the key was added — the "since" the total counts from.
        spend_since: u64,
        estimated: bool,
    },
    /// Complete tool-use block. `tool_use_id` matches the eventual `ToolResult`
    /// the caller sends back in the next `ChatRequest`.
    ///
    /// `signature` is an opaque provider token that must travel back with this
    /// call on the next request. Gemini 3 stamps a `thoughtSignature` on every
    /// `functionCall` part — it's the encrypted continuation of the reasoning
    /// that produced the call — and REJECTS the follow-up request outright
    /// ("Function call is missing a thought_signature in functionCall parts",
    /// 400 INVALID_ARGUMENT) if it comes back without one. So a tool loop that
    /// rebuilds the assistant turn from `(id, name, input)` alone works for
    /// exactly one round and then dies. Providers with no such token leave it
    /// `None` and nothing changes for them; the field is `#[serde(default)]`
    /// so already-persisted transcripts still deserialize.
    ToolUse {
        block_idx: usize,
        tool_use_id: String,
        name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
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
