//! AuraWatch — coding-agent-CLI inference backend.
//!
//! The user's machine usually already has an *authenticated* coding
//! agent installed (Claude Code, Gemini CLI, Codex). That's the most
//! natural zero-setup source for filling in a change reason — no API
//! key to paste, no ollama to start. This module:
//!
//!   1. Reuses the shell's existing agent discovery (`cmd_agents::
//!      agent_discover`) — the SAME registry + PATH probe the composer
//!      uses — to learn which coding-agent CLIs are installed and
//!      runnable, and where their binary lives.
//!   2. Shells out to one of them in tight, one-shot, NO-TOOLS mode to
//!      get a single short change-reason sentence.
//!
//! We never install or start anything: we only run a CLI that's already
//! on PATH and already signed in. The invocation is deliberately *not*
//! routed through `aura_agents::build_invocation` — that path injects
//! `--allowedTools` / `--yolo` / sandbox flags meant for autonomous
//! coding turns. For a change-reason completion we want the opposite:
//! no tools, no file writes, just text out.

use std::time::Duration;

use crate::aurawatch_inference::{InferContext, InferError};
use crate::cmd_agents::agent_discover;

/// One installed, runnable coding-agent CLI we can use to fill in a
/// change reason. `kind` is the stable registry id ("claude" /
/// "gemini" / "codex"); `label` is the human name ("Claude Code");
/// `bin` is the absolute path to the executable on disk.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentCliInfo {
    pub kind: String,
    pub label: String,
    pub bin: String,
}

/// The coding-agent kinds we know how to drive in one-shot, no-tools
/// mode for a change-reason completion. Other agents in the registry
/// (cursor, kimi, opencode, pi…) don't expose a verified non-tool
/// print mode here, so we don't claim them — never fake availability.
const SUPPORTED_KINDS: &[&str] = &["claude", "gemini", "codex"];

/// Discover installed coding-agent CLIs we can use as a fill-in source.
/// Pure reuse of `agent_discover()` (registry + PATH probe), filtered
/// to the kinds we can drive non-interactively and that are actually
/// runnable right now. Never installs or starts anything.
pub async fn detect_agent_clis() -> Vec<AgentCliInfo> {
    agent_discover()
        .await
        .into_iter()
        .filter(|a| a.available)
        .filter(|a| SUPPORTED_KINDS.contains(&a.id.as_str()))
        .filter_map(|a| {
            a.bin.map(|bin| AgentCliInfo {
                kind: a.id,
                label: a.label,
                bin,
            })
        })
        .collect()
}

/// A small/fast model id for each agent so the completion is cheap and
/// snappy. `None` means "let the agent use its own default" — still
/// correct, just not pinned to a small model.
pub fn default_small_model(kind: &str) -> Option<String> {
    match kind {
        // Haiku — fast, cheap, plenty for one sentence.
        "claude" => Some("claude-haiku-4-5-20251001".to_string()),
        // Flash — Gemini's small tier.
        "gemini" => Some("gemini-2.5-flash".to_string()),
        // Codex has no small-model flag worth pinning here; default.
        _ => None,
    }
}

/// Run the agent CLI once, no tools, to get a single change-reason
/// sentence. Returns `InferError` on any failure so the caller falls
/// through to the next candidate (or generic copy) exactly like the
/// HTTP backends do.
pub async fn infer_agent_cli(
    bin: &str,
    model: Option<&str>,
    kind: &str,
    ctx: &InferContext,
) -> Result<String, InferError> {
    let prompt = build_prompt(ctx);
    let (args, env): (Vec<String>, Vec<(String, String)>) =
        build_args(kind, model, &prompt)
            .ok_or_else(|| InferError::BadResponse(format!("unsupported agent kind: {kind}")))?;

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(&args);
    for (k, v) in &env {
        cmd.env(k, v);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // 20s ceiling — a one-sentence completion on a small model is well
    // under this even cold; the timeout just stops a hung CLI from
    // wedging the coalesce window forever.
    let run = cmd.output();
    let output = match tokio::time::timeout(Duration::from_secs(20), run).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(InferError::Http(e.to_string())),
        Err(_) => return Err(InferError::Http("agent CLI timed out".into())),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let head = stderr.lines().next().unwrap_or("non-zero exit").trim();
        return Err(InferError::BadResponse(format!(
            "agent CLI failed: {head}"
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let cleaned = clean_reason(&stdout);
    if cleaned.is_empty() {
        return Err(InferError::BadResponse("empty agent output".into()));
    }
    Ok(cleaned)
}

/// Build the tight one-shot prompt. We fold the system prompt into the
/// user prompt because the headless agent CLIs take a single `-p`/exec
/// string, not a system+user split like the HTTP APIs.
fn build_prompt(ctx: &InferContext) -> String {
    // The task-aware system prompt + trailer already live on the
    // context (WHY vs plain-language WHAT), so we just fold them in.
    format!("{}\n\n{}", ctx.system_prompt(), ctx.user_prompt())
}

/// Per-agent non-interactive argv + env. Mirrors the exact one-shot
/// shapes the `aura-agents` providers use, but stripped of the
/// autonomous-coding flags (`--allowedTools`, `--yolo`, sandbox) so the
/// agent can't run tools — it's a pure text completion.
///
///   * claude: `claude [--model <m>] -p <prompt>`
///   * gemini: `gemini [-m <m>] -p <prompt>`   (reads its own auth/env)
///   * codex:  `codex [-c model=<m>] exec <prompt>`
fn build_args(
    kind: &str,
    model: Option<&str>,
    prompt: &str,
) -> Option<(Vec<String>, Vec<(String, String)>)> {
    match kind {
        "claude" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(m) = model {
                args.push("--model".into());
                args.push(m.into());
            }
            args.push("-p".into());
            args.push(prompt.into());
            Some((args, Vec::new()))
        }
        "gemini" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(m) = model {
                args.push("-m".into());
                args.push(m.into());
            }
            args.push("-p".into());
            args.push(prompt.into());
            // No `--yolo`: we don't want it editing files. Plain `-p` is
            // a non-interactive prompt; gemini reads its own stored auth.
            Some((args, Vec::new()))
        }
        "codex" => {
            let mut args: Vec<String> = Vec::new();
            if let Some(m) = model {
                args.push("-c".into());
                args.push(format!("model={m}"));
            }
            args.push("exec".into());
            args.push(prompt.into());
            Some((args, Vec::new()))
        }
        _ => None,
    }
}

/// Squeeze the agent's stdout down to a single short reason line. The
/// print/exec modes emit just the assistant text (no stream-json), but
/// a model may still wrap it in quotes or add a stray blank line, so we
/// keep the first non-empty line and trim decoration.
fn clean_reason(raw: &str) -> String {
    let line = raw
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let line = line.trim_matches(|c| c == '"' || c == '`' || c == '\'');
    let mut s = line.trim().to_string();
    if s.len() > 240 {
        s.truncate(240);
    }
    s
}
