//! AuraWatch inference backends. Each function returns a one-line
//! commit-style intent statement when the backend can be reached, or
//! an error so the caller can fall through to the next candidate. We
//! never install or spawn anything — these are pure HTTP probes
//! against backends the user already has running.
//!
//! Per-provider request/response shapes mirror `aura-cli/src/gsd.rs`
//! so behavior stays consistent with what the user sees from `aura
//! ask`. The async/reqwest body is a port of the blocking version.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

pub(crate) const SYSTEM_PROMPT: &str =
    "You write one-sentence git commit-style intent statements describing WHY \
a change was made. Stay faithful to what the diff actually shows — state the \
real reason for the change, and never guess at intent the diff doesn't \
support. Past tense, action verb first. Max 14 words. No filler, no \"this \
commit\", no quotes. Output ONLY the sentence.";

/// Plain-language "WHAT changed" prompt. Audience is a non-engineer
/// (ADE): describe the change in everyday words so someone who doesn't
/// read code understands it. Never leak symbol names, file paths, or
/// git/AST jargon — that's the whole point of this variant.
pub(crate) const WHAT_PROMPT: &str =
    "You describe WHAT changed in a file in plain, everyday language a \
non-programmer would understand. Read the diff and say what the change does \
in real-world terms. Never name functions, classes, variables, or files, and \
never use code or git jargon. Present tense, max 14 words. No filler, no \
quotes. Output ONLY the sentence.";

/// Plain-language "what it USED TO DO" prompt — powers the "before" column
/// of the split-diff. Describes only the prior behaviour (the removed/replaced
/// `-` side) so a non-engineer can see what the code did before this change.
pub(crate) const BEFORE_PROMPT: &str =
    "You describe what a part of a project USED TO DO before a change, in \
plain, everyday language a non-programmer would understand. Read the diff and \
describe only the old behaviour being replaced or removed (the lines starting \
with '-'). Never name functions, classes, variables, or files, and never use \
code or git jargon. Past tense, max 14 words. No filler, no quotes. Output \
ONLY the sentence.";

/// Plain-language "why + how" prompt — powers the reasoning band. Gives the
/// reason for the change and the gist of the new approach, still without a
/// single symbol name or line of jargon.
pub(crate) const REASON_PROMPT: &str =
    "You explain WHY a change was made and, briefly, HOW it now works, in \
plain, everyday language a non-programmer would understand. Read the diff and \
give the reason for the change and the gist of the new approach. Never name \
functions, classes, variables, or files, and never use code or git jargon. \
One sentence, max 24 words. No filler, no quotes. Output ONLY the sentence.";

/// Plain-language "what THIS ONE piece does" prompt — powers the per-node
/// "New is this" blurbs in the split-diff header. The reader is told WHICH
/// piece to describe (its human title is already shown next to the blurb), so
/// the model's only job is to say what that single piece does now, in real-
/// world terms — not repeat its name, not describe the whole file.
pub(crate) const SYMBOL_PROMPT: &str =
    "You describe what ONE specific part of a project does, in plain, everyday \
language a non-programmer would understand. You are told which piece to focus \
on. Read the diff and say, in one sentence, what that piece does now — its \
real-world job as of this change. Do NOT repeat its code name, do NOT name \
other functions, classes, variables, or files, and never use code or git \
jargon. Present tense, max 16 words. No filler, no quotes. Output ONLY the \
sentence.";

/// Plain-language "what THIS ONE piece USED TO DO" prompt — powers the per-node
/// "Previous was this" blurbs. Same single-piece framing as {@link SYMBOL_PROMPT}
/// but past tense: describe the old job this one piece did before the change.
pub(crate) const SYMBOL_BEFORE_PROMPT: &str =
    "You describe what ONE specific part of a project USED TO DO before a \
change, in plain, everyday language a non-programmer would understand. You are \
told which piece to focus on. Read the diff and say, in one sentence, what that \
piece did before this change — its old real-world job. Do NOT repeat its code \
name, do NOT name other functions, classes, variables, or files, and never use \
code or git jargon. Past tense, max 16 words. No filler, no quotes. Output ONLY \
the sentence.";

/// Which one-line summary the caller wants from the model. `Why` is the
/// original commit-intent statement (the reason); `What` is the
/// plain-language description of the change for a non-engineer; `Before`
/// describes the prior behaviour (the split-diff's "before" column); `Reason`
/// is the plain-language "why this change, and how it works now" band.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InferTask {
    #[default]
    Why,
    What,
    Before,
    Reason,
    /// Describe a single named piece (one changed function/class/…) in plain
    /// words — the per-node "New is this" blurb. The piece to focus on is named
    /// at the head of the diff excerpt.
    Symbol,
    /// Describe what a single named piece USED TO DO before the change — the
    /// per-node "Previous was this" blurb. Past-tense counterpart to `Symbol`.
    SymbolBefore,
}

#[derive(Debug, Clone)]
pub struct InferContext {
    /// Files Claude touched in this coalesce window. Used to build the
    /// `Files edited:` block of the prompt.
    pub files: Vec<String>,
    /// Best-effort `git diff --unified=2` excerpt over those files,
    /// already truncated to the head of the diff so we don't blow the
    /// context window.
    pub diff_excerpt: String,
    /// Tail of the assistant's last message — gives the model a
    /// natural-language hint about *why* the change happened.
    pub assistant_tail: String,
    /// Which summary to produce: the commit-intent WHY (default) or the
    /// plain-language WHAT. Selects both the system prompt and the
    /// trailing instruction line.
    pub task: InferTask,
}

impl InferContext {
    /// Public read of the assembled user prompt. The agent-CLI backend
    /// folds this into a single `-p`/exec string (the headless CLIs take
    /// one prompt, not a system+user split like the HTTP APIs).
    pub(crate) fn user_prompt(&self) -> String {
        self.into_user_prompt()
    }

    /// System prompt matched to this context's task.
    pub(crate) fn system_prompt(&self) -> &'static str {
        match self.task {
            InferTask::Why => SYSTEM_PROMPT,
            InferTask::What => WHAT_PROMPT,
            InferTask::Before => BEFORE_PROMPT,
            InferTask::Reason => REASON_PROMPT,
            InferTask::Symbol => SYMBOL_PROMPT,
            InferTask::SymbolBefore => SYMBOL_BEFORE_PROMPT,
        }
    }

    /// Trailing instruction line, matched to this context's task.
    fn trailer(&self) -> &'static str {
        match self.task {
            InferTask::Why => "Write the intent.",
            InferTask::What => "Describe in plain words what this change does.",
            InferTask::Before => "Describe in plain words what this used to do before the change.",
            InferTask::Reason => "Explain in plain words why this change was made and how it now works.",
            InferTask::Symbol => "In one plain sentence, say what the piece named above does now.",
            InferTask::SymbolBefore => {
                "In one plain sentence, say what the piece named above used to do before this change."
            }
        }
    }

    fn into_user_prompt(&self) -> String {
        let files = if self.files.is_empty() {
            "(unknown)".to_string()
        } else {
            let mut joined = self.files.join("\n");
            if joined.len() > 200 {
                joined.truncate(200);
            }
            joined
        };
        let mut diff = self.diff_excerpt.clone();
        if diff.len() > 1500 {
            diff.truncate(1500);
        }
        let mut tail = self.assistant_tail.clone();
        if tail.len() > 200 {
            // Tail-truncate so we keep the most recent characters.
            tail = tail
                .chars()
                .rev()
                .take(200)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
        }
        format!(
            "Files edited:\n{}\n\nDiff summary (first ~40 lines):\n{}\n\nRecent assistant message context (last 200 chars):\n{}\n\n{}",
            files, diff, tail, self.trailer()
        )
    }
}

#[derive(Debug)]
pub enum InferError {
    BadResponse(String),
    Http(String),
}

impl std::fmt::Display for InferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InferError::BadResponse(s) => write!(f, "bad response: {s}"),
            InferError::Http(s) => write!(f, "http error: {s}"),
        }
    }
}

impl std::error::Error for InferError {}

/// Identifies which backend the user has reachable. Frontend renders
/// the active selection in the AuraWatch settings dialog.
#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InferenceBackendKind {
    Ollama,
    /// An installed, already-authenticated coding-agent CLI (Claude
    /// Code / Gemini CLI / Codex). Zero key/ollama setup needed.
    AgentCli,
    Anthropic,
    Openai,
    Gemini,
    Mercury,
    Generic,
}

#[derive(Debug, Clone)]
pub enum InferenceBackend {
    Ollama { url: String, model: String },
    /// Shell out to an installed coding-agent CLI in one-shot, no-tools
    /// mode. `bin` is the resolved executable path, `kind` the registry
    /// id ("claude"/"gemini"/"codex"), `model` an optional small model.
    AgentCli {
        bin: String,
        model: Option<String>,
        kind: String,
    },
    Anthropic { key: String, model: String },
    Openai { key: String, model: String },
    Gemini { key: String, model: String },
    Mercury { key: String },
    /// No usable backend was reachable. Caller should fall back to
    /// generic-copy nudges instead of trying to infer.
    Generic,
}

impl InferenceBackend {
    pub fn kind(&self) -> InferenceBackendKind {
        match self {
            InferenceBackend::Ollama { .. } => InferenceBackendKind::Ollama,
            InferenceBackend::AgentCli { .. } => InferenceBackendKind::AgentCli,
            InferenceBackend::Anthropic { .. } => InferenceBackendKind::Anthropic,
            InferenceBackend::Openai { .. } => InferenceBackendKind::Openai,
            InferenceBackend::Gemini { .. } => InferenceBackendKind::Gemini,
            InferenceBackend::Mercury { .. } => InferenceBackendKind::Mercury,
            InferenceBackend::Generic => InferenceBackendKind::Generic,
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct BackendDetection {
    pub ollama: Option<String>,
    /// The Ollama model we'll actually call — a small tier that's genuinely
    /// pulled on this machine. `None` (with `ollama` also `None`) when Ollama is
    /// down OR has no models: an up-but-empty Ollama must NOT win selection, or
    /// it shadows a working agent CLI and every inference 404s on a missing model.
    pub ollama_model: Option<String>,
    /// Installed coding-agent CLIs we can use with zero key/ollama setup
    /// (Claude Code / Gemini CLI / Codex). Empty when none are on PATH.
    pub agent_clis: Vec<crate::aurawatch_agentcli::AgentCliInfo>,
    /// The registry id of the agent CLI that's the *active* default,
    /// when `active == AgentCli`. Lets the UI mark the right row.
    pub active_agent_kind: Option<String>,
    pub anthropic: bool,
    pub openai: bool,
    pub gemini: bool,
    pub mercury: bool,
    pub active: InferenceBackendKind,
}

impl Default for InferenceBackendKind {
    fn default() -> Self {
        InferenceBackendKind::Generic
    }
}

/// Probe what's available on the user's machine — does NOT install
/// anything, does NOT spawn ollama, does NOT start an agent. Just a TCP
/// probe (ollama), a PATH probe for installed coding-agent CLIs (reused
/// from the shell's agent registry), and a key-presence check against
/// `~/.aura/credentials.json`. Selection precedence:
/// ollama (if running) → installed coding-agent CLI → anthropic →
/// openai → gemini → mercury → generic.
pub async fn detect_backends() -> BackendDetection {
    let mut det = BackendDetection::default();

    // Ollama probe: ask /api/tags for the models it ACTUALLY has pulled and
    // pick a small one to call. Only then does Ollama count as available — an
    // up-but-empty Ollama returns None here and falls through to the agent CLIs,
    // instead of winning selection and then failing every inference on a model
    // it never had. Default URL only; user can override via settings (future).
    let ollama_url = "http://localhost:11434".to_string();
    if let Some(model) = probe_ollama_model(&ollama_url).await {
        det.ollama = Some(ollama_url);
        det.ollama_model = Some(model);
    }

    // Installed coding-agent CLIs — reuses `agent_discover()` (registry
    // + PATH probe), so anything the user already runs in the composer
    // is reused for free. These need no API key and no ollama: the CLI
    // is already signed in. We never start them here, just detect.
    det.agent_clis = crate::aurawatch_agentcli::detect_agent_clis().await;

    // Cloud-key check. Read `~/.aura/credentials.json` and surface
    // which keys are populated. Same single source of truth aura-cli
    // already uses, so anything the user already configured for
    // `aura ask` is reused for free.
    let creds = read_credentials().await.unwrap_or_default();
    det.anthropic = !creds.anthropic_api_key.is_empty();
    det.openai = !creds.openai_api_key.is_empty();
    det.gemini = !creds.gemini_api_key.is_empty();
    det.mercury = !creds.mercury_api_key.is_empty();

    det.active = if det.ollama.is_some() {
        InferenceBackendKind::Ollama
    } else if let Some(first) = det.agent_clis.first() {
        // First installed coding-agent CLI is the active default —
        // ranked ABOVE the API keys so "we have claude in the system"
        // works with zero key setup.
        det.active_agent_kind = Some(first.kind.clone());
        InferenceBackendKind::AgentCli
    } else if det.anthropic {
        InferenceBackendKind::Anthropic
    } else if det.openai {
        InferenceBackendKind::Openai
    } else if det.gemini {
        InferenceBackendKind::Gemini
    } else if det.mercury {
        InferenceBackendKind::Mercury
    } else {
        InferenceBackendKind::Generic
    };

    det
}

/// Resolve the active backend handle from a fresh detection — used at
/// watch-session start. Honors an explicit user choice when one is
/// given AND still reachable. `preferred` is a small selector string
/// persisted by the settings UI:
///   - `"agent:<kind>"`  → a specific installed coding-agent CLI
///   - `"ollama"` / `"anthropic"` / `"openai"` / `"gemini"` / `"mercury"`
///   - `None` / unknown  → fall back to auto-detected precedence.
/// If the chosen source isn't reachable we silently fall back to the
/// auto default rather than failing — the user never gets a dead pick.
pub async fn select_backend_preferred(preferred: Option<&str>) -> InferenceBackend {
    let det = detect_backends().await;
    let creds = read_credentials().await.unwrap_or_default();

    // Honor an explicit, still-reachable preference first.
    if let Some(pref) = preferred {
        if let Some(b) = resolve_preferred(pref, &det, &creds) {
            return b;
        }
    }

    backend_for_kind(det.active, &det, &creds)
}

/// Map a kind (the auto-detected `active`) to a concrete backend handle.
fn backend_for_kind(
    kind: InferenceBackendKind,
    det: &BackendDetection,
    creds: &CredentialsRaw,
) -> InferenceBackend {
    match kind {
        InferenceBackendKind::Ollama => InferenceBackend::Ollama {
            url: det
                .ollama
                .clone()
                .unwrap_or_else(|| "http://localhost:11434".into()),
            // The small tier we confirmed is actually pulled (see
            // `probe_ollama_model`). The literal is only a last-ditch default
            // for the (unreachable here) case where the kind is Ollama yet no
            // model was recorded.
            model: det
                .ollama_model
                .clone()
                .unwrap_or_else(|| "llama3.2:1b".to_string()),
        },
        InferenceBackendKind::AgentCli => {
            // The active agent kind is whichever the UI marked, else the
            // first discovered one. Unreachable here means none installed.
            let chosen = det
                .active_agent_kind
                .as_deref()
                .and_then(|k| det.agent_clis.iter().find(|a| a.kind == k))
                .or_else(|| det.agent_clis.first());
            match chosen {
                Some(a) => InferenceBackend::AgentCli {
                    bin: a.bin.clone(),
                    model: crate::aurawatch_agentcli::default_small_model(&a.kind),
                    kind: a.kind.clone(),
                },
                None => InferenceBackend::Generic,
            }
        }
        InferenceBackendKind::Anthropic => InferenceBackend::Anthropic {
            key: creds.anthropic_api_key.clone(),
            model: "claude-haiku-4-5-20251001".to_string(),
        },
        InferenceBackendKind::Openai => InferenceBackend::Openai {
            key: creds.openai_api_key.clone(),
            model: "gpt-4o-mini".to_string(),
        },
        InferenceBackendKind::Gemini => InferenceBackend::Gemini {
            key: creds.gemini_api_key.clone(),
            model: "gemini-1.5-flash".to_string(),
        },
        InferenceBackendKind::Mercury => InferenceBackend::Mercury {
            key: creds.mercury_api_key.clone(),
        },
        InferenceBackendKind::Generic => InferenceBackend::Generic,
    }
}

/// Resolve an explicit preference selector to a concrete, *reachable*
/// backend. Returns `None` when the pick isn't available right now so
/// the caller falls back to the auto default.
fn resolve_preferred(
    pref: &str,
    det: &BackendDetection,
    creds: &CredentialsRaw,
) -> Option<InferenceBackend> {
    if let Some(kind) = pref.strip_prefix("agent:") {
        let a = det.agent_clis.iter().find(|a| a.kind == kind)?;
        return Some(InferenceBackend::AgentCli {
            bin: a.bin.clone(),
            model: crate::aurawatch_agentcli::default_small_model(&a.kind),
            kind: a.kind.clone(),
        });
    }
    match pref {
        "ollama" if det.ollama.is_some() => {
            Some(backend_for_kind(InferenceBackendKind::Ollama, det, creds))
        }
        "anthropic" if det.anthropic => {
            Some(backend_for_kind(InferenceBackendKind::Anthropic, det, creds))
        }
        "openai" if det.openai => {
            Some(backend_for_kind(InferenceBackendKind::Openai, det, creds))
        }
        "gemini" if det.gemini => {
            Some(backend_for_kind(InferenceBackendKind::Gemini, det, creds))
        }
        "mercury" if det.mercury => {
            Some(backend_for_kind(InferenceBackendKind::Mercury, det, creds))
        }
        _ => None,
    }
}

pub async fn infer(
    backend: &InferenceBackend,
    ctx: &InferContext,
) -> Result<String, InferError> {
    match backend {
        InferenceBackend::Ollama { url, model } => infer_ollama(url, model, ctx).await,
        InferenceBackend::AgentCli { bin, model, kind } => {
            crate::aurawatch_agentcli::infer_agent_cli(
                bin,
                model.as_deref(),
                kind,
                ctx,
            )
            .await
        }
        InferenceBackend::Anthropic { key, model } => {
            infer_anthropic(key, model, ctx).await
        }
        InferenceBackend::Openai { key, model } => infer_openai(key, model, ctx).await,
        InferenceBackend::Gemini { key, model } => infer_gemini(key, model, ctx).await,
        InferenceBackend::Mercury { key } => infer_mercury(key, ctx).await,
        InferenceBackend::Generic => Ok(generic_copy(ctx)),
    }
}

/// Canned copy when no backend is reachable. Still better than
/// silence — the user gets a poke that intent is missing, even if we
/// can't synthesize the *content* for them.
pub fn generic_copy(ctx: &InferContext) -> String {
    let n = ctx.files.len().max(1);
    if let Some(first) = ctx.files.first() {
        let base = Path::new(first)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(first.as_str());
        if n == 1 {
            format!("{n} edit to {base} since last intent — run /log?")
        } else {
            format!("{n} edits ({base} +{}) since last intent — run /log?", n - 1)
        }
    } else {
        format!("{n} edits since last intent — run /log?")
    }
}

async fn infer_ollama(
    url: &str,
    model: &str,
    ctx: &InferContext,
) -> Result<String, InferError> {
    let client = http_client();
    let body = json!({
        "model": model,
        "system": ctx.system_prompt(),
        "prompt": ctx.into_user_prompt(),
        "stream": false,
        "options": { "num_predict": 60, "temperature": 0.2 },
    });
    let res = client
        .post(format!("{}/api/generate", url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| InferError::Http(e.to_string()))?;
    let v: Value = res
        .json()
        .await
        .map_err(|e| InferError::BadResponse(e.to_string()))?;
    v.get("response")
        .and_then(|r| r.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InferError::BadResponse("missing response field".into()))
}

async fn infer_anthropic(
    key: &str,
    model: &str,
    ctx: &InferContext,
) -> Result<String, InferError> {
    let client = http_client();
    let body = json!({
        "model": model,
        "max_tokens": 60,
        "temperature": 0.2,
        "system": ctx.system_prompt(),
        "messages": [{ "role": "user", "content": ctx.into_user_prompt() }],
    });
    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| InferError::Http(e.to_string()))?;
    let v: Value = res
        .json()
        .await
        .map_err(|e| InferError::BadResponse(e.to_string()))?;
    v["content"][0]["text"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InferError::BadResponse("missing content[0].text".into()))
}

async fn infer_openai(
    key: &str,
    model: &str,
    ctx: &InferContext,
) -> Result<String, InferError> {
    let client = http_client();
    let body = json!({
        "model": model,
        "temperature": 0.2,
        "max_tokens": 60,
        "messages": [
            { "role": "system", "content": ctx.system_prompt() },
            { "role": "user", "content": ctx.into_user_prompt() },
        ],
    });
    let res = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| InferError::Http(e.to_string()))?;
    let v: Value = res
        .json()
        .await
        .map_err(|e| InferError::BadResponse(e.to_string()))?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InferError::BadResponse("missing choices[0].message.content".into()))
}

async fn infer_gemini(
    key: &str,
    model: &str,
    ctx: &InferContext,
) -> Result<String, InferError> {
    let client = http_client();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, key
    );
    let combined = format!("{}\n\n{}", ctx.system_prompt(), ctx.into_user_prompt());
    let body = json!({
        "contents": [{ "parts": [{ "text": combined }] }],
        "generationConfig": { "temperature": 0.2, "maxOutputTokens": 60 },
    });
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| InferError::Http(e.to_string()))?;
    let v: Value = res
        .json()
        .await
        .map_err(|e| InferError::BadResponse(e.to_string()))?;
    v["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InferError::BadResponse("missing candidates[0].text".into()))
}

async fn infer_mercury(key: &str, ctx: &InferContext) -> Result<String, InferError> {
    let client = http_client();
    let combined = format!("{}\n\n{}", ctx.system_prompt(), ctx.into_user_prompt());
    let body = json!({
        "model": "mercury-2",
        "prompt": combined,
        "max_tokens": 60,
        "stream": false,
    });
    let res = client
        .post("https://api.mercury-ai.com/v1/generate")
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| InferError::Http(e.to_string()))?;
    let v: Value = res
        .json()
        .await
        .map_err(|e| InferError::BadResponse(e.to_string()))?;
    v["output"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| InferError::BadResponse("missing output".into()))
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Probe Ollama and, only if it's up AND has at least one model pulled, return
/// the model we'll call. Prefers a small, fast tier (a `llama3.2` if present)
/// but accepts whatever is actually installed, so a machine with only a bigger
/// model still gets real output. Returns `None` when Ollama is unreachable OR
/// has an empty model list — the caller then falls through to the next backend
/// rather than locking onto an Ollama that will 404 every request.
async fn probe_ollama_model(url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(700))
        .build()
        .ok()?;
    let endpoint = format!("{}/api/tags", url.trim_end_matches('/'));
    let resp = client.get(&endpoint).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let tags: OllamaTags = resp.json().await.ok()?;
    let names: Vec<String> = tags
        .models
        .into_iter()
        .map(|m| m.name)
        .filter(|n| !n.is_empty())
        .collect();
    if names.is_empty() {
        return None;
    }
    // Prefer a small llama3.2 tier; else the first pulled model.
    names
        .iter()
        .find(|n| n.starts_with("llama3.2"))
        .or_else(|| names.iter().find(|n| n.contains("llama3.2")))
        .or_else(|| names.first())
        .cloned()
}

/// Minimal shape of Ollama's `/api/tags` response — only the model names.
#[derive(Debug, Default, Deserialize)]
struct OllamaTags {
    #[serde(default)]
    models: Vec<OllamaTagModel>,
}

#[derive(Debug, Default, Deserialize)]
struct OllamaTagModel {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Default, Deserialize)]
struct CredentialsRaw {
    #[serde(default)]
    anthropic_api_key: String,
    #[serde(default)]
    openai_api_key: String,
    #[serde(default)]
    gemini_api_key: String,
    #[serde(default)]
    mercury_api_key: String,
}

async fn read_credentials() -> Option<CredentialsRaw> {
    let path = credentials_path()?;
    let bytes = tokio::fs::read(&path).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn credentials_path() -> Option<PathBuf> {
    let mut p = dirs::home_dir()?;
    p.push(".aura");
    p.push("credentials.json");
    Some(p)
}
