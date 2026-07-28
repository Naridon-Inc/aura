//! `cli_wrapper` Brain — wraps a coding-agent CLI from the `aura-agents`
//! registry as a `Brain` impl.
//!
//! W3 of v0.2.30 KK.3. Reuses the same spawn recipe `legacy.rs::run_cli`
//! has shipped for months (build_invocation → tokio::process spawn →
//! line-by-line stream-json parse) but emits `ChatChunk` events instead
//! of the legacy `StreamDelta`. The CLI's own auth handles the model
//! call — there is no API key on our side, only a binary on PATH.
//!
//! Each `Brain::chat` call is a fresh spawn. The Brain trait is
//! stateless w.r.t. conversation, so we do NOT pass `--resume`: the
//! caller hands us the full `messages` slice every turn and we
//! flatten that into a single prompt the CLI sees as user input.
//! When W5 swaps the manager to BrainManager and we have a place to
//! park cross-turn state, the wrapper can start honoring CLI session
//! ids — until then, "stateless" matches the trait contract exactly.
//!
//! Provider ids carried by this brain look like `cli_wrapper:<suffix>`.
//! The suffix is the *friendly* name the picker UI exposes — it maps
//! onto the aura-agents registry id via a small alias table because
//! the friendly names ("claude_code") and the agent ids ("claude") do
//! not match 1:1.

#![cfg(feature = "brain_cli_wrapper")]

use async_stream::try_stream;
use async_trait::async_trait;
use aura_agents::{InvokeMode, InvokeRequest, canonical_agent_id, registry};
use futures_util::stream::BoxStream;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::{
    Brain,
    types::{BrainCapabilities, BrainError, ChatChunk, ChatMessage, ChatRequest, cap_keys},
};

const PROVIDER_PREFIX: &str = "cli_wrapper:";

/// Friendly suffix → aura-agents registry id. Most agents already use
/// the friendly name; `claude_code` (and the short `cc` mention handle)
/// are the odd ones out — the registry id is just `claude`. Delegates to
/// the single alias table in `aura_agents` so the chat mention (`@cc`),
/// the picker suffix, and the registry stay in lockstep.
fn agent_id_for_suffix(suffix: &str) -> &str {
    canonical_agent_id(suffix)
}

/// Default model id the CLI uses internally. The CLI selects its model
/// from its own auth/config; this value is informational — the picker
/// UI surfaces it next to the provider name.
fn default_model_for(suffix: &str) -> &'static str {
    match suffix {
        "claude_code" => "claude-sonnet-4-6",
        "gemini" => "gemini-3-pro-preview",
        "codex" => "gpt-5-codex",
        "cursor" => "cursor-default",
        "kimi" => "kimi-k2",
        "opencode" => "opencode-default",
        _ => "default",
    }
}

/// Models the CLI is known to expose. Same caveat as `default_model_for`
/// — informational only; the CLI picks for real.
fn supported_models_for(suffix: &str) -> Value {
    match suffix {
        "claude_code" => json!([
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5-20251001",
        ]),
        "gemini" => json!([
            "gemini-3-pro-preview",
            "gemini-3-flash-preview",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
        ]),
        "codex" => json!(["gpt-5-codex", "gpt-5.5"]),
        "cursor" => json!(["cursor-default"]),
        "kimi" => json!(["kimi-k2"]),
        "opencode" => json!(["opencode-default"]),
        _ => json!([]),
    }
}

/// One `Brain` impl per installed CLI. Constructed by `registry::build`
/// when the caller picks a `cli_wrapper:<suffix>` provider id.
#[derive(Debug, Clone)]
pub struct CliWrapperBrain {
    /// Full id including the `cli_wrapper:` prefix, e.g. `cli_wrapper:claude_code`.
    provider_id: String,
    /// Suffix only (`claude_code`, `gemini`, …). Routed to `agent_id_for_suffix`
    /// when we hit the aura-agents registry.
    suffix: String,
}

impl CliWrapperBrain {
    /// Build a wrapper for the CLI identified by `suffix`. Returns
    /// `UnknownProvider` if no compiled-in aura-agents provider claims
    /// the (aliased) id — the picker should have hidden it, but we
    /// guard defensively.
    pub fn new(suffix: &str) -> Result<Self, BrainError> {
        let agent_id = agent_id_for_suffix(suffix);
        if registry().get(agent_id).is_none() {
            return Err(BrainError::UnknownProvider {
                provider_id: format!("{PROVIDER_PREFIX}{suffix}"),
            });
        }
        Ok(Self {
            provider_id: format!("{PROVIDER_PREFIX}{suffix}"),
            suffix: suffix.to_string(),
        })
    }

    /// Flatten a `ChatRequest` into a single prompt string the CLI sees
    /// as one user turn. We can't push individual messages into the
    /// CLI's history without `--resume`, so we render the conversation
    /// as a transcript header + the latest user message.
    fn build_prompt(request: &ChatRequest) -> String {
        flatten_messages_to_prompt(request.system.as_deref(), &request.messages)
    }
}

/// Render a `ChatMessage` list into the single transcript prompt a
/// one-shot CLI consumes: optional system header, every prior turn as a
/// `[Role]\n<text>` block, then the latest user message tailed verbatim
/// so the CLI treats it as the actual prompt.
///
/// This is the SINGLE shaper both entry points share — the `Brain` impl
/// (`build_prompt`) AND the legacy manager-chat CLI path
/// (`legacy.rs::run_cli`), which must replay the full transcript whenever
/// a CLI session is fresh (first turn OR right after a brain swap dropped
/// the prior CLI's `--resume` id). Without that replay the swapped-in
/// brain sees only the latest message and answers "fresh session",
/// silently losing the thread.
pub(crate) fn flatten_messages_to_prompt(
    system: Option<&str>,
    messages: &[ChatMessage],
) -> String {
    let mut out = String::new();
    if let Some(sys) = system {
        if !sys.trim().is_empty() {
            out.push_str(sys.trim());
            out.push_str("\n\n");
        }
    }

    // Render prior turns as a transcript so the CLI has context.
    // Skip the last user message — we append it verbatim at the
    // bottom so the CLI treats it as the actual prompt.
    let last_user_idx = messages.iter().rposition(|m| m.role == "user");
    for (i, msg) in messages.iter().enumerate() {
        if Some(i) == last_user_idx {
            continue;
        }
        let role = match msg.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            "system" => "System",
            other => other,
        };
        let text = message_text(msg);
        if text.trim().is_empty() {
            continue;
        }
        out.push_str(&format!("[{role}]\n{text}\n\n"));
    }

    // Tail with the latest user prompt.
    if let Some(idx) = last_user_idx {
        let text = message_text(&messages[idx]);
        out.push_str(text.trim());
        // Spill any images attached to THIS message to disk and tell the CLI
        // agent where to read them. A one-shot CLI can't accept inline base64,
        // so the only way a user-attached image reaches the agent is as a
        // readable file path it can open with its own Read tool. Only the
        // latest user turn's images are referenced — re-reading megabytes of
        // history every turn would be wasteful, and an older image was already
        // referenced back when it was the live prompt.
        let images = materialize_message_images(&messages[idx]);
        if !images.is_empty() {
            out.push_str("\n\n");
            if images.len() == 1 {
                out.push_str(&format!(
                    "[The user attached an image to this message. Read this file to view it: {}]",
                    images[0].display()
                ));
            } else {
                out.push_str(
                    "[The user attached images to this message. Read these files to view them:",
                );
                for p in &images {
                    out.push_str(&format!("\n- {}", p.display()));
                }
                out.push(']');
            }
        }
    }
    out
}

/// Decode any base64 `image` content blocks carried on `msg` to files under
/// the OS temp dir and return their paths, in block order. A one-shot CLI
/// agent can't take an inline image, so the wrapper spills each attachment to
/// disk and hands the agent a path it can `Read`. Idempotent: the filename is
/// a hash of the image's base64, so the same image re-sent on a later turn
/// maps to the same path and is written exactly once. Blocks that aren't
/// base64 images, or that fail to decode/write, are silently skipped — a
/// broken attachment must never take down the turn.
fn materialize_message_images(msg: &ChatMessage) -> Vec<std::path::PathBuf> {
    use base64::Engine as _;
    use std::hash::{Hash as _, Hasher as _};

    let Value::Array(blocks) = &msg.content else {
        return Vec::new();
    };
    let dir = std::env::temp_dir().join("aura-chat-images");
    let mut out = Vec::new();
    for b in blocks {
        if b.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let Some(source) = b.get("source") else {
            continue;
        };
        let data = match source.get("data").and_then(Value::as_str) {
            Some(d) if !d.is_empty() => d,
            _ => continue,
        };
        let media = source
            .get("media_type")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
            continue;
        };
        let mut h = std::collections::hash_map::DefaultHasher::new();
        data.hash(&mut h);
        let path = dir.join(format!("{:016x}.{}", h.finish(), ext_for_media(media)));
        if !path.exists()
            && (std::fs::create_dir_all(&dir).is_err() || std::fs::write(&path, &bytes).is_err())
        {
            continue;
        }
        out.push(path);
    }
    out
}

/// Map an image MIME type to the file extension a CLI agent's Read tool will
/// recognize. Defaults to `png` for anything unexpected.
fn ext_for_media(media: &str) -> &'static str {
    match media {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    }
}

/// Best-effort text extraction from `ChatMessage::content`. Plain
/// strings pass through; structured content (Anthropic-style content
/// blocks) is mined for `text` fields and joined.
fn message_text(msg: &ChatMessage) -> String {
    match &msg.content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => {
            let mut out = String::new();
            for b in blocks {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                        if !out.is_empty() {
                            out.push('\n');
                        }
                        out.push_str(t);
                    }
                }
            }
            out
        }
        other => other.to_string(),
    }
}

#[async_trait]
impl Brain for CliWrapperBrain {
    fn provider_id(&self) -> &str {
        &self.provider_id
    }

    fn capabilities(&self) -> BrainCapabilities {
        let suffix = self.suffix.as_str();
        BrainCapabilities::new()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(cap_keys::SUPPORTS_VISION, suffix == "claude_code")
            .with(cap_keys::DEFAULT_MODEL, json!(default_model_for(suffix)))
            .with(cap_keys::SUPPORTED_MODELS, supported_models_for(suffix))
    }

    async fn chat(
        &self,
        request: ChatRequest,
    ) -> Result<BoxStream<'static, Result<ChatChunk, BrainError>>, BrainError> {
        let agent_id = agent_id_for_suffix(&self.suffix).to_string();
        let provider = registry()
            .get(&agent_id)
            .ok_or_else(|| BrainError::UnknownProvider {
                provider_id: self.provider_id.clone(),
            })?;

        let prompt = Self::build_prompt(&request);

        let mut invocation = provider
            .build_invocation(&InvokeRequest {
                prompt: &prompt,
                mode: InvokeMode::StreamJson,
                resume_session_id: None,
                attachments_via_stdin: false,
                effort: request.effort,
                fast: request.fast,
                // Per-turn model from the composer picker rides through to
                // the CLI's real selector (`claude --model`, `gemini -m`,
                // `codex -c model=`). `None` keeps the CLI on its default.
                model: request.model.as_deref(),
                // Cross-agent permission mode rides through to the CLI's real
                // approval flag (`--permission-mode` / `--approval-mode` /
                // sandbox). `None` keeps the CLI on its own default gating.
                approval: request.approval,
            })
            .map_err(|e| BrainError::Process {
                message: format!("build_invocation({agent_id}): {e}"),
            })?;
        // Enforce the fleet agent-CLI config policy (e.g. codex service_tier
        // repair) on this manager-brain turn's invocation.
        crate::agent_policy::apply_to_invocation(&agent_id, &mut invocation);

        let mut cmd = tokio::process::Command::new(&invocation.bin);
        cmd.args(&invocation.args)
            // Pin the working directory to the turn's repo/worktree root
            // (`request.cwd`), so a "Claude Code" chat opened inside a worktree
            // runs *in that worktree* — `git` resolves, the agent sees the repo,
            // and tools operate on the right tree. `safe_spawn_dir` guards the
            // value: an empty/invalid root (no project bound) falls back to the
            // user's HOME so an unguarded spawn never inherits the desktop app's
            // own launch dir (in a dev build, Aura's `src-tauri` tree).
            .current_dir(crate::spawn_dir::safe_spawn_dir(&request.cwd))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in &invocation.env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| BrainError::Process {
            message: format!("spawn {}: {e}", invocation.bin),
        })?;

        let stdout = child.stdout.take().ok_or_else(|| BrainError::Process {
            message: "child stdout missing".into(),
        })?;
        let stderr = child.stderr.take();
        let stream_json = invocation.stdout_is_stream_json;

        let stream = try_stream! {
            // RAII guard ensures the child is reaped whether the stream
            // is consumed to completion or dropped early (cancel-safe).
            let mut child = child;
            let mut reader = BufReader::new(stdout).lines();
            let mut block_idx: usize = 0;
            let mut any_text = false;

            while let Some(line) = reader
                .next_line()
                .await
                .map_err(|e| BrainError::Process {
                    message: format!("read stdout: {e}"),
                })?
            {
                if stream_json {
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };

                    if let Some(text) = parse_cli_text(&v) {
                        any_text = true;
                        yield ChatChunk::Text {
                            block_idx,
                            text,
                        };
                    }
                    if let Some((tool_use_id, name, input)) = parse_cli_tool_use(&v) {
                        block_idx += 1;
                        yield ChatChunk::ToolUse {
                            block_idx,
                            tool_use_id,
                            name,
                            input,
                        };
                        block_idx += 1;
                    }
                    if let Some(final_text) = parse_cli_final_result(&v) {
                        // Some CLIs deliver one consolidated `result`
                        // line instead of per-token text deltas — surface
                        // it so the caller still gets content.
                        if !any_text && !final_text.is_empty() {
                            yield ChatChunk::Text {
                                block_idx,
                                text: final_text,
                            };
                            any_text = true;
                        }
                    }
                    if let Some(stop_reason) = parse_cli_stop_reason(&v) {
                        yield ChatChunk::End { stop_reason: Some(stop_reason) };
                        // `result` is the terminal message in stream-json;
                        // letting the loop continue would just hang on
                        // EOF. Break and let the drop guard reap.
                        break;
                    }
                } else {
                    // Non-stream-json CLIs (cursor) → raw stdout, one
                    // big text block.
                    if !line.is_empty() {
                        any_text = true;
                        yield ChatChunk::Text {
                            block_idx,
                            text: format!("{line}\n"),
                        };
                    }
                }
            }

            // Drain stderr after stdout closes so a non-zero exit code
            // surfaces with useful context instead of "process: …".
            let mut stderr_buf = String::new();
            if let Some(err) = stderr {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    stderr_buf.push_str(&line);
                    stderr_buf.push('\n');
                }
            }

            let status = child.wait().await.map_err(|e| BrainError::Process {
                message: format!("wait: {e}"),
            })?;

            if !status.success() {
                let exit = status.code().unwrap_or(-1);
                // Developer-facing log so an exit-N is diagnosable without ever
                // leaking the raw stderr (embeds the Manager preamble) to chat.
                tracing::warn!(
                    engine = %super::engine_errors::engine_label(&invocation.bin),
                    exit,
                    stderr = %stderr_buf.chars().take(2000).collect::<String>(),
                    "engine CLI turn failed"
                );
                // Don't clobber a clean End that the CLI already emitted
                // — only surface the error path when we got nothing.
                if !any_text {
                    // Plain-language mapping — never surface raw CLI stderr
                    // (it embeds the Manager system prompt via `spawnargs`).
                    Err(BrainError::Process {
                        message: super::engine_errors::humanize_cli_failure(
                            &invocation.bin,
                            exit,
                            &stderr_buf,
                        ),
                    })?;
                    unreachable!();
                }
            }

            yield ChatChunk::End { stop_reason: None };
        };

        Ok(Box::pin(stream))
    }
}

// --- stream-json line parsers ----------------------------------------
// These mirror the helpers in `legacy.rs` so the two paths agree on what
// counts as text vs tool_use vs final result. Kept private + duplicated
// for now: legacy.rs is the live path and we don't touch it in W3.

fn parse_cli_text(v: &Value) -> Option<String> {
    let kind = v.get("type").and_then(|s| s.as_str())?;
    if kind != "assistant" {
        return None;
    }
    let content = v.pointer("/message/content")?.as_array()?;
    let mut out = String::new();
    for block in content {
        if block.get("type").and_then(|s| s.as_str()) == Some("text") {
            if let Some(t) = block.get("text").and_then(|s| s.as_str()) {
                out.push_str(t);
            }
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn parse_cli_tool_use(v: &Value) -> Option<(String, String, Value)> {
    let kind = v.get("type").and_then(|s| s.as_str())?;
    if kind != "assistant" {
        return None;
    }
    let content = v.pointer("/message/content")?.as_array()?;
    for block in content {
        if block.get("type").and_then(|s| s.as_str()) == Some("tool_use") {
            let id = block.get("id").and_then(|s| s.as_str())?.to_string();
            let name = block.get("name").and_then(|s| s.as_str())?.to_string();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            return Some((id, name, input));
        }
    }
    None
}

fn parse_cli_final_result(v: &Value) -> Option<String> {
    if v.get("type").and_then(|s| s.as_str()) != Some("result") {
        return None;
    }
    v.get("result")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
}

fn parse_cli_stop_reason(v: &Value) -> Option<String> {
    if v.get("type").and_then(|s| s.as_str()) != Some("result") {
        return None;
    }
    // Some CLIs use `subtype`, others `stop_reason`. Pick whichever's set.
    v.get("stop_reason")
        .and_then(|s| s.as_str())
        .or_else(|| v.get("subtype").and_then(|s| s.as_str()))
        .map(|s| s.to_string())
        .or(Some("end_turn".to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix_alias_maps_claude_code() {
        assert_eq!(agent_id_for_suffix("claude_code"), "claude");
        assert_eq!(agent_id_for_suffix("gemini"), "gemini");
        assert_eq!(agent_id_for_suffix("opencode"), "opencode");
    }

    #[test]
    fn build_prompt_renders_transcript() {
        let req = ChatRequest {
            messages: vec![
                ChatMessage {
                    role: "user".into(),
                    content: Value::String("first ask".into()),
                },
                ChatMessage {
                    role: "assistant".into(),
                    content: Value::String("first reply".into()),
                },
                ChatMessage {
                    role: "user".into(),
                    content: Value::String("follow up".into()),
                },
            ],
            cwd: String::new(),
            system: Some("You are a coordinator.".into()),
            tools: vec![],
            max_tokens: None,
            temperature: None,
            effort: None,
            fast: false,
            model: None,
            long_context: false,
            approval: None,
        };
        let prompt = CliWrapperBrain::build_prompt(&req);
        assert!(prompt.starts_with("You are a coordinator."));
        assert!(prompt.contains("[User]\nfirst ask"));
        assert!(prompt.contains("[Assistant]\nfirst reply"));
        assert!(prompt.trim_end().ends_with("follow up"));
    }

    #[test]
    fn message_text_handles_content_blocks() {
        let msg = ChatMessage {
            role: "user".into(),
            content: json!([
                {"type": "text", "text": "hello"},
                {"type": "image", "source": {}},
                {"type": "text", "text": "world"},
            ]),
        };
        assert_eq!(message_text(&msg), "hello\nworld");
    }

    #[test]
    fn parse_cli_text_extracts_assistant_text() {
        let v = json!({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "hi"}]}
        });
        assert_eq!(parse_cli_text(&v), Some("hi".into()));
    }

    #[test]
    fn parse_cli_stop_reason_defaults_to_end_turn() {
        let v = json!({"type": "result"});
        assert_eq!(parse_cli_stop_reason(&v), Some("end_turn".into()));
    }
}
