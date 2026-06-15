//! Provider abstraction over coding-agent CLIs.
//!
//! The point of this crate is to keep adding a new agent CLI (Codex,
//! Cursor agent mode, Kimi-Coder, anything that ships next quarter) to a
//! single new file plus a registry entry — and to let power users declare
//! a new provider via `~/.aura/agents.toml` without recompiling.
//!
//! `AgentProvider` describes capabilities (stream-json? PTY? resume?) and
//! arg shape (`build_invocation`). It does NOT spawn — the caller does
//! that with whatever runtime it owns (sync `std::process::Command` for
//! the CLI orchestrator, async tokio Command + xterm pty for the desktop
//! shell). Keeping spawn out of the trait lets this crate stay
//! dependency-light and lets each consumer wire its own pipe + parser.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Command;
use std::sync::Arc;

pub mod claude_code;
pub mod codex;
pub mod cursor;
pub mod gemini_cli;
pub mod generic_cli;
pub mod kimi_coder;
pub mod opencode;
pub mod pi;
pub mod toml_loader;

/// What the caller wants the provider to produce. Providers may emit
/// different argv shapes per mode (e.g. claude one-shot vs. stream-json
/// vs. interactive REPL).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvokeMode {
    /// Run the prompt as a one-shot, capture stdout. The caller waits.
    OneShot,
    /// Emit Anthropic-style stream-json on stdout, line-delimited.
    StreamJson,
    /// Spawn an interactive REPL the caller will drive over a PTY.
    PtyRepl,
}

/// Cross-agent reasoning effort for a single invocation. Each provider maps
/// this onto its own real mechanism — a native API thinking budget, Codex's
/// `model_reasoning_effort`, or (for CLIs with no flag) a short prompt-level
/// steering line. `None` on a request means "leave the provider at its own
/// default" — the invocation is then byte-identical to the pre-effort build.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    /// Ceiling tier — Claude's `ultrathink`, the largest thinking budget.
    /// Distinct from `High` so the picker can offer the full low→max ladder
    /// the underlying CLIs expose (e.g. Claude's think/think hard/think
    /// harder/ultrathink keywords).
    Max,
}

impl ReasoningEffort {
    /// Codex `model_reasoning_effort` value. `fast` collapses to "minimal".
    /// Codex caps at "high", so `Max` maps there too (no higher CLI tier).
    pub fn codex_value(self, fast: bool) -> &'static str {
        if fast {
            return "minimal";
        }
        match self {
            ReasoningEffort::Low => "low",
            ReasoningEffort::Medium => "medium",
            ReasoningEffort::High => "high",
            ReasoningEffort::Max => "high",
        }
    }

    /// Anthropic / Gemini extended-thinking budget in tokens.
    pub fn budget_tokens(self) -> u32 {
        match self {
            ReasoningEffort::Low => 4_000,
            ReasoningEffort::Medium => 10_000,
            ReasoningEffort::High => 24_000,
            ReasoningEffort::Max => 48_000,
        }
    }

    /// OpenAI `reasoning_effort` value (GPT-5 / o-series). Caps at "high".
    pub fn openai_value(self) -> &'static str {
        match self {
            ReasoningEffort::Low => "low",
            ReasoningEffort::Medium => "medium",
            ReasoningEffort::High => "high",
            ReasoningEffort::Max => "high",
        }
    }

    /// A short steering line for CLIs / brains with no effort knob —
    /// prepended to the prompt. Safe (it's only text) and provider-agnostic.
    pub fn prompt_steer(self) -> &'static str {
        match self {
            ReasoningEffort::Low => "Think briefly, then act.",
            ReasoningEffort::Medium => "Think step by step before acting.",
            ReasoningEffort::High => {
                "Think hard and reason carefully through edge cases before acting."
            }
            ReasoningEffort::Max => {
                "Think as deeply as you can: exhaustively reason through every \
                 edge case, alternative, and failure mode before acting."
            }
        }
    }

    /// Claude Code's documented thinking trigger keyword. The four levels map
    /// onto Claude's escalating ladder: think < think hard < think harder <
    /// ultrathink.
    pub fn claude_keyword(self) -> &'static str {
        match self {
            ReasoningEffort::Low => "think",
            ReasoningEffort::Medium => "think hard",
            ReasoningEffort::High => "think harder",
            ReasoningEffort::Max => "ultrathink",
        }
    }
}

/// Cross-agent permission / autonomy mode — Aura's portable mirror of the
/// per-CLI approval flags (Claude's `--permission-mode`, Gemini's
/// `--approval-mode`, Codex's sandbox + `--ask-for-approval`). One picker
/// chip drives the right flag on whichever agent runs the turn, so "auto /
/// bypass / plan" works the same everywhere instead of being Claude-only.
/// `Default` emits no flag → byte-identical to the pre-feature invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// Leave the agent on its own default gating (no flag added).
    Default,
    /// Auto-approve file edits; still gate risky shell / network actions.
    AcceptEdits,
    /// Read-only — propose a plan, make no changes on disk.
    Plan,
    /// Full autonomy — skip all approval + sandbox gating (YOLO).
    Bypass,
}

impl ApprovalPolicy {
    /// Claude Code `--permission-mode <…>` args. `Default` → none.
    pub fn claude_args(self) -> Vec<String> {
        let mode = match self {
            ApprovalPolicy::Default => return Vec::new(),
            ApprovalPolicy::AcceptEdits => "acceptEdits",
            ApprovalPolicy::Plan => "plan",
            ApprovalPolicy::Bypass => "bypassPermissions",
        };
        vec!["--permission-mode".into(), mode.into()]
    }

    /// Gemini CLI `--approval-mode <…>` args. `Default` → `None`, so the
    /// caller keeps gemini's existing non-interactive `--yolo` default
    /// unchanged; a set policy replaces it with the explicit mode.
    pub fn gemini_args(self) -> Option<Vec<String>> {
        let mode = match self {
            ApprovalPolicy::Default => return None,
            ApprovalPolicy::AcceptEdits => "auto_edit",
            ApprovalPolicy::Plan => "plan",
            ApprovalPolicy::Bypass => "yolo",
        };
        Some(vec!["--approval-mode".into(), mode.into()])
    }

    /// Codex sandbox args. `Default` → none. `AcceptEdits` allows
    /// in-workspace writes; `Plan` is a read-only sandbox; `Bypass` drops the
    /// sandbox entirely. Sandbox-only (no `--ask-for-approval`): the brain
    /// runs codex via the non-interactive `exec` path, which can't prompt
    /// mid-run, so the sandbox policy is what actually gates the agent — and
    /// `-s` is valid for both `exec` and the interactive REPL.
    pub fn codex_args(self) -> Vec<String> {
        match self {
            ApprovalPolicy::Default => Vec::new(),
            ApprovalPolicy::AcceptEdits => vec!["--sandbox".into(), "workspace-write".into()],
            ApprovalPolicy::Plan => vec!["--sandbox".into(), "read-only".into()],
            ApprovalPolicy::Bypass => vec!["--dangerously-bypass-approvals-and-sandbox".into()],
        }
    }

    /// A short read-only steering line for CLIs with no approval flag
    /// (cursor / kimi / opencode). Only `Plan` is faithfully expressible as
    /// prompt text; the looser modes can't be safely emulated, so they
    /// return `None` and leave the agent on its own default.
    pub fn prompt_steer(self) -> Option<&'static str> {
        match self {
            ApprovalPolicy::Plan => Some(
                "Operate in read-only PLAN mode: investigate and propose a concrete \
                 plan, but do NOT modify, create, or delete any files.",
            ),
            _ => None,
        }
    }
}

/// Inputs the provider needs to build its invocation. Borrowed so the
/// caller doesn't have to clone the prompt.
pub struct InvokeRequest<'a> {
    pub prompt: &'a str,
    pub mode: InvokeMode,
    pub resume_session_id: Option<&'a str>,
    /// True when the caller will pipe the prompt + image content blocks
    /// in via stdin as stream-json (claude-style image attachments).
    /// Providers can drop the prompt arg in that case.
    pub attachments_via_stdin: bool,
    /// Cross-agent reasoning effort. `None` → provider default (no change).
    pub effort: Option<ReasoningEffort>,
    /// Latency-first: collapse effort to the provider's minimum / disable
    /// extended thinking. Orthogonal to `effort` so a ⚡ toggle can be set
    /// independently of the effort chip.
    pub fast: bool,
    /// Per-turn model override from the composer model picker. `None` →
    /// the CLI stays on whatever model it's configured for (the provider
    /// adds no model flag). `Some(id)` maps to each CLI's real selector
    /// (`claude --model`, `gemini -m`, `codex -c model=`).
    pub model: Option<&'a str>,
    /// Cross-agent permission / autonomy mode. `None` → leave the agent on
    /// its own default gating (byte-identical to the pre-feature build);
    /// `Some(policy)` maps to each CLI's real approval flag.
    pub approval: Option<ApprovalPolicy>,
}

impl InvokeRequest<'_> {
    /// The prompt with an optional effort-steering prefix for CLIs that have
    /// no reasoning flag. Returns the prompt unchanged when no effort is set
    /// or when `fast` is on (fast = minimal reasoning, no nudge). `claude`
    /// passes `claude: true` to use the keyword form instead of a sentence.
    pub fn steered_prompt(&self, claude: bool) -> String {
        match self.effort {
            Some(e) if !self.fast => {
                let lead = if claude { e.claude_keyword() } else { e.prompt_steer() };
                format!("{lead}\n\n{}", self.prompt)
            }
            _ => self.prompt.to_string(),
        }
    }

    /// The prompt with a read-only PLAN steer prepended when the approval
    /// policy is `Plan` — for the thin CLIs (cursor / kimi / opencode /
    /// generic / pi) that have no native approval flag to carry it. Returns
    /// the prompt unchanged for every other policy and when unset, so the
    /// invocation stays byte-identical to the pre-feature build.
    pub fn plan_steered_prompt(&self) -> String {
        match self.approval.and_then(|a| a.prompt_steer()) {
            Some(lead) => format!("{lead}\n\n{}", self.prompt),
            None => self.prompt.to_string(),
        }
    }
}

/// What the caller spawns. Pure data — no Command, no tokio.
#[derive(Debug, Clone)]
pub struct Invocation {
    pub bin: String,
    pub args: Vec<String>,
    /// Extra env vars to set on the child. Usually empty; gemini-cli
    /// uses this to forward `GEMINI_API_KEY` from the Aura config.
    pub env: Vec<(String, String)>,
    /// True when stdout will be Anthropic stream-json. The shell uses
    /// this to pick `parse_claude_line` vs raw text.
    pub stdout_is_stream_json: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
pub struct Capabilities {
    pub stream: bool,
    pub pty: bool,
    pub resume: bool,
}

/// Pricing per 1K tokens. Optional because community providers often
/// don't know the real cost; consumers fall back to a 0.0 estimate.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CostPer1k {
    pub input_usd: f64,
    pub output_usd: f64,
}

/// Provider trait. Producers write one of these per CLI.
pub trait AgentProvider: Send + Sync {
    /// Stable id used in saved orchestration state and as the registry
    /// key. Examples: `"claude"`, `"gemini"`, `"codex"`, `"cursor"`,
    /// `"kimi"`.
    fn id(&self) -> &str;
    fn label(&self) -> &str;

    /// Whether the binary is on PATH. Default: shell out to `which`.
    /// Providers can override (e.g. to honor an env var).
    fn is_available(&self) -> bool {
        Command::new("which")
            .arg(self.bin_name())
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// `<bin> --version` first line, best-effort. Default reads stdout
    /// with a stderr fallback because some agents print version to
    /// stderr.
    fn version(&self) -> Option<String> {
        let output = Command::new(self.bin_name()).arg("--version").output().ok()?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let pick = if stdout.is_empty() {
            String::from_utf8_lossy(&output.stderr).trim().to_string()
        } else {
            stdout
        };
        if pick.is_empty() {
            None
        } else {
            Some(pick.lines().next().unwrap_or("unknown").to_string())
        }
    }

    fn capabilities(&self) -> Capabilities;

    fn cost_per_1k(&self) -> Option<CostPer1k> {
        None
    }

    /// Keyword/score pairs the Smart classifier consults. Higher score
    /// = stronger preference for this provider. Empty = no preference,
    /// classifier falls back to availability + cost.
    fn classifier_prefs(&self) -> &[(&str, i32)] {
        &[]
    }

    /// The actual binary on PATH. Used by `is_available` / `version`
    /// defaults; providers can also reach for it directly when building
    /// an invocation.
    fn bin_name(&self) -> &str;

    fn build_invocation(&self, req: &InvokeRequest) -> Result<Invocation, String>;
}

/// Public, JSON-serializable summary of a provider — what the desktop
/// shell exposes to the React UI via the `agents_list` Tauri command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDescriptor {
    pub id: String,
    pub label: String,
    pub bin: String,
    pub available: bool,
    pub version: Option<String>,
    pub capabilities: Capabilities,
    pub cost_per_1k: Option<CostPer1k>,
}

impl AgentDescriptor {
    pub fn from_provider(p: &dyn AgentProvider) -> Self {
        Self {
            id: p.id().to_string(),
            label: p.label().to_string(),
            bin: p.bin_name().to_string(),
            available: p.is_available(),
            version: p.version(),
            capabilities: p.capabilities(),
            cost_per_1k: p.cost_per_1k(),
        }
    }
}

/// Registry of providers. Built once at process init from compiled
/// defaults plus any overrides in `~/.aura/agents.toml`. Lookups are by
/// stable id — unknown ids round-trip through saved sessions and surface
/// as `Err("unknown agent: …")` at dispatch time, which is exactly the
/// behavior we want.
pub struct Registry {
    by_id: HashMap<String, Arc<dyn AgentProvider>>,
    order: Vec<Arc<dyn AgentProvider>>,
}

impl Registry {
    pub fn new() -> Self {
        Self {
            by_id: HashMap::new(),
            order: Vec::new(),
        }
    }

    pub fn push(&mut self, p: Arc<dyn AgentProvider>) {
        let id = p.id().to_string();
        // Replace if a previous entry with the same id existed (TOML
        // override case). Drop the stale entry from `order` so we don't
        // double-list it in UIs.
        if self.by_id.insert(id.clone(), p.clone()).is_some() {
            self.order.retain(|x| x.id() != id);
        }
        self.order.push(p);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentProvider>> {
        self.by_id.get(id).cloned()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn AgentProvider>> {
        self.order.iter()
    }

    pub fn descriptors(&self) -> Vec<AgentDescriptor> {
        self.order
            .iter()
            .map(|p| AgentDescriptor::from_provider(p.as_ref()))
            .collect()
    }

    /// Build a registry preloaded with the compiled-in defaults plus
    /// any `~/.aura/agents.toml` overrides / additions.
    pub fn with_defaults() -> Self {
        let mut r = Self::new();
        r.push(Arc::new(claude_code::ClaudeCode));
        r.push(Arc::new(gemini_cli::GeminiCli));
        r.push(Arc::new(codex::Codex));
        r.push(Arc::new(cursor::Cursor));
        r.push(Arc::new(kimi_coder::KimiCoder));
        r.push(Arc::new(opencode::OpenCode));
        r.push(Arc::new(pi::Pi));
        // Best-effort. Bad TOML logs to stderr but doesn't fatal — a
        // typo in agents.toml shouldn't brick the shell.
        if let Err(e) = toml_loader::merge_user_toml(&mut r) {
            eprintln!("[aura-agents] agents.toml: {e}");
        }
        r
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

/// Process-wide registry, lazily built on first access.
static REGISTRY: once_cell::sync::OnceCell<parking_lot::RwLock<Arc<Registry>>> =
    once_cell::sync::OnceCell::new();

fn registry_cell() -> &'static parking_lot::RwLock<Arc<Registry>> {
    REGISTRY.get_or_init(|| parking_lot::RwLock::new(Arc::new(Registry::with_defaults())))
}

/// Snapshot of the global registry. Cheap clone — `Arc<Registry>`.
pub fn registry() -> Arc<Registry> {
    registry_cell().read().clone()
}

/// Re-read `~/.aura/agents.toml` and rebuild from defaults. Surfaced to
/// the UI as `agents_reload`.
pub fn reload() -> Arc<Registry> {
    let new = Arc::new(Registry::with_defaults());
    *registry_cell().write() = new.clone();
    new
}

/// Pick the best available provider for `task_text` using `classifier_prefs`.
/// Falls back to `default_id` if no provider scores higher than zero.
pub fn smart_pick<'a>(
    reg: &'a Registry,
    task_text: &str,
    default_id: &str,
) -> Option<Arc<dyn AgentProvider>> {
    let lower = task_text.to_lowercase();
    let mut best: Option<(i32, Arc<dyn AgentProvider>)> = None;
    for p in reg.iter() {
        if !p.is_available() {
            continue;
        }
        let score: i32 = p
            .classifier_prefs()
            .iter()
            .filter(|(kw, _)| lower.contains(kw))
            .map(|(_, s)| *s)
            .sum();
        match &best {
            None => best = Some((score, p.clone())),
            Some((b, _)) if score > *b => best = Some((score, p.clone())),
            _ => {}
        }
    }
    match best {
        Some((s, p)) if s > 0 => Some(p),
        _ => reg.get(default_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubProvider {
        id: &'static str,
        prefs: &'static [(&'static str, i32)],
        available: bool,
    }
    impl AgentProvider for StubProvider {
        fn id(&self) -> &str {
            self.id
        }
        fn label(&self) -> &str {
            self.id
        }
        fn is_available(&self) -> bool {
            self.available
        }
        fn version(&self) -> Option<String> {
            None
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        fn classifier_prefs(&self) -> &[(&str, i32)] {
            self.prefs
        }
        fn bin_name(&self) -> &str {
            self.id
        }
        fn build_invocation(&self, _req: &InvokeRequest) -> Result<Invocation, String> {
            Ok(Invocation {
                bin: self.id.into(),
                args: vec![],
                env: vec![],
                stdout_is_stream_json: false,
            })
        }
    }

    #[test]
    fn smart_pick_uses_prefs() {
        let mut reg = Registry::new();
        reg.push(Arc::new(StubProvider {
            id: "alpha",
            prefs: &[("refactor", 3)],
            available: true,
        }));
        reg.push(Arc::new(StubProvider {
            id: "beta",
            prefs: &[("test", 3), ("review", 2)],
            available: true,
        }));
        let pick = smart_pick(&reg, "refactor the auth module", "beta").unwrap();
        assert_eq!(pick.id(), "alpha");
        let pick = smart_pick(&reg, "write tests for it", "alpha").unwrap();
        assert_eq!(pick.id(), "beta");
    }

    #[test]
    fn smart_pick_falls_back_when_no_match() {
        let mut reg = Registry::new();
        reg.push(Arc::new(StubProvider {
            id: "alpha",
            prefs: &[("refactor", 3)],
            available: true,
        }));
        reg.push(Arc::new(StubProvider {
            id: "beta",
            prefs: &[],
            available: true,
        }));
        let pick = smart_pick(&reg, "totally unrelated text", "beta").unwrap();
        assert_eq!(pick.id(), "beta");
    }

    #[test]
    fn smart_pick_skips_unavailable() {
        let mut reg = Registry::new();
        reg.push(Arc::new(StubProvider {
            id: "alpha",
            prefs: &[("refactor", 5)],
            available: false,
        }));
        reg.push(Arc::new(StubProvider {
            id: "beta",
            prefs: &[("refactor", 1)],
            available: true,
        }));
        let pick = smart_pick(&reg, "refactor it", "beta").unwrap();
        assert_eq!(pick.id(), "beta");
    }

    #[test]
    fn push_overrides_existing_id() {
        struct V1;
        impl AgentProvider for V1 {
            fn id(&self) -> &str {
                "x"
            }
            fn label(&self) -> &str {
                "v1"
            }
            fn capabilities(&self) -> Capabilities {
                Capabilities::default()
            }
            fn bin_name(&self) -> &str {
                "x"
            }
            fn build_invocation(&self, _: &InvokeRequest) -> Result<Invocation, String> {
                Err("v1".into())
            }
        }
        struct V2;
        impl AgentProvider for V2 {
            fn id(&self) -> &str {
                "x"
            }
            fn label(&self) -> &str {
                "v2"
            }
            fn capabilities(&self) -> Capabilities {
                Capabilities::default()
            }
            fn bin_name(&self) -> &str {
                "x"
            }
            fn build_invocation(&self, _: &InvokeRequest) -> Result<Invocation, String> {
                Err("v2".into())
            }
        }
        let mut reg = Registry::new();
        reg.push(Arc::new(V1));
        reg.push(Arc::new(V2));
        assert_eq!(reg.iter().count(), 1);
        assert_eq!(reg.get("x").unwrap().label(), "v2");
    }
}
