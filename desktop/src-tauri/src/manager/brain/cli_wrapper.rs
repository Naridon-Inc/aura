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
//!
//! ## Where the CLI runs (AURA-1308)
//!
//! A CLI *is* the hands. The native brain keeps the model call here and
//! reaches a bound machine through `Place` one tool at a time; a CLI does
//! its own tool loop, so the only way its hands land on the box is for the
//! whole process to run there. `ChatRequest.machine_id` says when that is,
//! and [`spawn_there`] starts it through `Place::stream` — the same door
//! every other remote verb walks through — while [`spawn_here`] is the
//! local spawn unchanged. One reader ([`read_turn`]) draws the turn off
//! either child, so nothing about parsing can differ between the two.

#![cfg(feature = "brain_cli_wrapper")]

use async_stream::try_stream;
use async_trait::async_trait;
use aura_agents::{InvokeMode, InvokeRequest, canonical_agent_id, registry};
use futures_util::stream::BoxStream;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::cloudbox::script::{agent_line, quote};

use super::{
    Brain,
    place::Place,
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

    /// No `DEFAULT_MODEL`, and no `SUPPORTED_MODELS`.
    ///
    /// Both were tables of model ids maintained by hand here, and a CLI
    /// does not take a model from us — it picks one from its own auth and
    /// config, and never tells us which. So the ids were a guess, and
    /// [`settle_turn_cost`](crate::cmd_brain_chat) records `DEFAULT_MODEL`
    /// on the cost card precisely so the card can name the model it has no
    /// rate for. A guess there is a wrong label on a real turn: the card
    /// read `claude-sonnet-5` for a session actually running Opus, and
    /// `cursor-default` / `opencode-default` were not model ids at all.
    ///
    /// Saying nothing leaves the card blank unless the composer picked a
    /// model, which is the one case we do know. The model *list* is
    /// answered by `model_discovery`, which asks the engine.
    fn capabilities(&self) -> BrainCapabilities {
        BrainCapabilities::new()
            .with(cap_keys::SUPPORTS_STREAMING, true)
            .with(cap_keys::SUPPORTS_TOOL_USE, true)
            .with(
                cap_keys::SUPPORTS_VISION,
                self.suffix.as_str() == "claude_code",
            )
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
        // AURA-1296 — the composer's Concise chip → `claude --output-style`.
        // Nothing is added for other agents or when no style is set.
        invocation.args.extend(super::output_style::claude_output_style_args(
            &agent_id,
            request.output_style.as_deref(),
        ));

        // Where the CLI's hands are — AURA-1308. A session bound to a machine
        // starts the CLI THERE, over the one door every other remote verb
        // uses; anything else starts it on this laptop, exactly as before.
        // Either way what comes back is a child with a piped stdout, and one
        // reader below draws the turn from it — so a fix to the parser is a
        // fix to both, and a box can never get fewer of the CLI's answers
        // than this disk does.
        let spawned = match request
            .machine_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(machine_id) => spawn_there(machine_id, &invocation, &agent_id).await?,
            None => spawn_here(&invocation, &request.cwd, &agent_id)?,
        };

        Ok(read_turn(spawned))
    }
}

/// A CLI that has been started, and what the reader has to know about it.
///
/// The same struct comes out of both spawn arms — that is the point of it. The
/// reader never asks *where* the CLI is except to word one failure sentence,
/// so a remote turn cannot drift into being parsed differently from a local one.
struct Spawned {
    child: tokio::process::Child,
    /// What the engine is called, in a log line or a sentence.
    bin: String,
    /// Whether stdout is stream-json (parsed) or a terminal transcript (read
    /// line by line, minus the engine's own decoration).
    stream_json: bool,
    /// The transcript decoder for a plain-text engine.
    transcript: super::plain_cli_transcript::PlainCliTranscript,
    /// The machine the CLI is running on, when it is not this laptop.
    remote: Option<Remote>,
}

/// A CLI running on a machine rather than here.
struct Remote {
    /// What to call the machine in a sentence a person reads.
    label: String,
    /// The command the box was asked for — the bare name, since a path this
    /// laptop resolved means nothing over there.
    bin: String,
}

/// Start the CLI on this laptop, in the turn's own repo.
fn spawn_here(
    invocation: &aura_agents::Invocation,
    cwd: &str,
    agent_id: &str,
) -> Result<Spawned, BrainError> {
    let mut cmd = tokio::process::Command::new(&invocation.bin);
    cmd.args(&invocation.args)
        // Pin the working directory to the turn's repo/worktree root
        // (`request.cwd`), so a "Claude Code" chat opened inside a worktree
        // runs *in that worktree* — `git` resolves, the agent sees the repo,
        // and tools operate on the right tree. `safe_spawn_dir` guards the
        // value: an empty/invalid root (no project bound) falls back to the
        // user's HOME so an unguarded spawn never inherits the desktop app's
        // own launch dir (in a dev build, Aura's `src-tauri` tree).
        .current_dir(crate::spawn_dir::safe_spawn_dir(cwd))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &invocation.env {
        cmd.env(k, v);
    }

    // Its own process group, so stopping this turn can reach whatever the
    // CLI itself started — a tool call's shell, a language server. Without
    // it we can only signal the CLI, and its children outlive us as
    // orphans that keep running and keep costing money.
    crate::child_reaper::own_process_group(&mut cmd);

    let child = cmd.spawn().map_err(|e| BrainError::Process {
        message: format!("spawn {}: {e}", invocation.bin),
    })?;
    Ok(Spawned {
        child,
        bin: invocation.bin.clone(),
        stream_json: invocation.stdout_is_stream_json,
        transcript: super::plain_cli_transcript::PlainCliTranscript::for_engine(agent_id),
        remote: None,
    })
}

/// Start the CLI on the machine the session is bound to.
///
/// The machine is insisted upon rather than resolved, for the reason
/// `agent_pty_open` gives: `Place::resolve` degrades a machine it can no longer
/// find to this laptop, which is the right bargain for a conversation's tools
/// and the wrong one for a whole CLI — the user asked for an agent over there,
/// and quietly starting one here would set it loose on this disk while the tab
/// still says the machine's name. That is the exact hole this closes.
///
/// The CLI's working directory is the machine's own checkout of the project
/// (the place's root), and the binary is named rather than pathed: whatever
/// `bin_resolve` found on this laptop is a path on this laptop.
async fn spawn_there(
    machine_id: &str,
    invocation: &aura_agents::Invocation,
    agent_id: &str,
) -> Result<Spawned, BrainError> {
    let process = |message: String| BrainError::Process { message };
    let place = Place::at_machine(machine_id).map_err(process)?;
    if swaps_home(invocation) {
        // An isolated session is a HOME swap on this disk. Over there it would
        // silently do nothing and the agent would run as whoever the box logs
        // in as — a wrong account is not something to find out from a commit.
        return Err(process(format!(
            "An isolated session swaps the login on this laptop, so it can't be applied to {}. \
             That machine signs in as itself — chat with it without a profile, or chat with this laptop instead.",
            place.label()
        )));
    }
    let bin = remote_bin(&invocation.bin).to_string();
    let mut child = place
        .stream(&remote_invocation(invocation))
        .await
        .map_err(process)?;
    // The prompt travelled as an argument; there is nothing to type. Closing
    // stdin now is end-of-file on the far side, exactly what `Stdio::null`
    // gives the local arm.
    drop(child.stdin.take());
    Ok(Spawned {
        child,
        bin: bin.clone(),
        stream_json: invocation.stdout_is_stream_json,
        transcript: super::plain_cli_transcript::PlainCliTranscript::for_engine(agent_id),
        remote: Some(Remote {
            label: place.label().to_string(),
            bin,
        }),
    })
}

/// The one line a box is asked to run for a turn: the invocation's
/// environment, then the CLI and its flags, every word quoted for the shell
/// over there.
///
/// Built from the same `Invocation` the local arm spawns, so a flag the
/// composer set — model, effort, approvals, output style — reaches the box's
/// CLI exactly as it reaches this laptop's. The prompt is among the args, and
/// a prompt is the one thing here that can hold anything at all, which is why
/// nothing is spliced in unquoted.
fn remote_invocation(invocation: &aura_agents::Invocation) -> String {
    let mut line = String::new();
    for (k, v) in &invocation.env {
        // An environment name that isn't one would be read as a command.
        if is_env_name(k) {
            line.push_str(k);
            line.push('=');
            line.push_str(&quote(v));
            line.push(' ');
        }
    }
    line.push_str(&agent_line(remote_bin(&invocation.bin), &invocation.args, None));
    line
}

/// The command as the box should look it up: by name, on its own PATH — the
/// same lookup the capability probe used to say the agent is there at all.
fn remote_bin(bin: &str) -> &str {
    crate::cloudbox::script::basename(bin)
}

/// Does this invocation carry an isolated profile — a `HOME` of its own?
fn swaps_home(invocation: &aura_agents::Invocation) -> bool {
    invocation.env.iter().any(|(k, _)| k == "HOME")
}

/// `[A-Za-z_][A-Za-z0-9_]*` — what a POSIX shell takes as a variable name.
fn is_env_name(k: &str) -> bool {
    let mut chars = k.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Draw one turn off a running CLI, wherever it runs.
///
/// The single reader both arms share. It parses stream-json or decodes a
/// terminal transcript, drains stderr after stdout closes so a non-zero exit
/// can be worded, and reaps the child whether the stream is consumed to the
/// end or dropped halfway.
fn read_turn(spawned: Spawned) -> BoxStream<'static, Result<ChatChunk, BrainError>> {
    let Spawned {
        mut child,
        bin,
        stream_json,
        mut transcript,
        remote,
    } = spawned;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let stream = try_stream! {
        let stdout = stdout.ok_or_else(|| BrainError::Process {
            message: "child stdout missing".into(),
        })?;
        // RAII guard ensures the child is reaped whether the stream
        // is consumed to completion or dropped early (cancel-safe).
        // `kill_on_drop` alone only signals the CLI process; the guard
        // takes its whole group, and is declared after `child` so it runs
        // first on unwind — group signal, then tokio's own kill.
        let mut child = child;
        let mut tree = crate::child_reaper::TreeGuard::new(child.id());
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
                        signature: None,
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
                // Non-stream-json CLIs (cursor, kimi) → raw stdout, one
                // big text block, minus the engine's own decoration.
                let line = transcript.line(&line);
                // A blank line before any text is the CLI settling; once
                // text has started it is the model's paragraph break, and
                // dropping it glues its paragraphs and lists together.
                if any_text || !line.trim().is_empty() {
                    any_text = any_text || !line.trim().is_empty();
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
        // Reaped — the pid is free for the kernel to reuse, so the guard
        // must not fire on it any more.
        tree.disarm();

        if !status.success() {
            let exit = status.code().unwrap_or(-1);
            // Developer-facing log so an exit-N is diagnosable without ever
            // leaking the raw stderr (embeds the Manager preamble) to chat.
            tracing::warn!(
                engine = %super::engine_errors::engine_label(&bin),
                machine = remote.as_ref().map(|r| r.label.as_str()).unwrap_or("this laptop"),
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
                    message: failure_sentence(&bin, exit, &stderr_buf, remote.as_ref()),
                })?;
                unreachable!();
            }
        }

        yield ChatChunk::End { stop_reason: None };
    };

    Box::pin(stream)
}

/// One sentence for a turn that produced nothing and exited non-zero.
///
/// Two exits mean something different when the CLI ran on a machine, and
/// both would be misread by the engine mapping: 127 is the box's shell
/// saying it has no such command — not a broken install here — and 255 is
/// ssh's own exit, the wire rather than the engine. Everything else is the
/// engine's failure and is worded the same way wherever it ran.
fn failure_sentence(bin: &str, exit: i32, stderr: &str, remote: Option<&Remote>) -> String {
    if let Some(r) = remote {
        if exit == NOT_FOUND {
            return format!(
                "{} doesn't have the `{}` command, so it can't answer this. Install {} on it, or chat with this laptop instead.",
                r.label,
                r.bin,
                super::engine_errors::engine_label(bin)
            );
        }
        if exit == UNREACHED {
            return format!(
                "{} didn't answer, or the connection to it dropped partway through. Check the machine is up, then try again.",
                r.label
            );
        }
    }
    super::engine_errors::humanize_cli_failure(bin, exit, stderr)
}

/// A shell's way of saying it never found the program.
const NOT_FOUND: i32 = 127;
/// What `ssh` itself exits with when it could not connect or lost the wire.
const UNREACHED: i32 = 255;

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
    use serde_json::json;

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
            output_style: None, // AURA-1296
            machine_id: None,
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

    // --- AURA-1308: the line a machine is asked to run ---------------------

    fn invocation(bin: &str, args: &[&str], env: &[(&str, &str)]) -> aura_agents::Invocation {
        aura_agents::Invocation {
            bin: bin.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            stdout_is_stream_json: true,
        }
    }

    #[test]
    fn the_box_is_asked_for_the_command_by_name_not_by_this_laptops_path() {
        // `bin_resolve` may have found `/opt/homebrew/bin/claude` here; that
        // path is nowhere on the box. The name is what its PATH — the same
        // PATH the capability probe used — can find.
        let inv = invocation("/opt/homebrew/bin/claude", &["-p", "hi"], &[]);
        assert_eq!(remote_invocation(&inv), "'claude' '-p' 'hi'");
        assert_eq!(remote_bin("codex"), "codex");
    }

    #[test]
    fn every_flag_and_the_prompt_reach_the_box_quoted_whole() {
        // The prompt is the one argument that can hold anything at all.
        let inv = invocation(
            "claude",
            &["--output-format", "stream-json", "-p", "it's `rm -rf`; echo $HOME"],
            &[],
        );
        let line = remote_invocation(&inv);
        assert!(line.ends_with(&quote("it's `rm -rf`; echo $HOME")), "{line}");
        assert!(line.contains("'--output-format' 'stream-json'"), "{line}");
    }

    #[test]
    fn the_invocations_environment_travels_ahead_of_the_command() {
        let inv = invocation(
            "gemini",
            &["-p", "x"],
            &[("GEMINI_API_KEY", "k'1"), ("not a name", "dropped")],
        );
        let line = remote_invocation(&inv);
        assert!(line.starts_with("GEMINI_API_KEY='k'\\''1' 'gemini'"), "{line}");
        // A name a shell would not take is not spliced in as a command.
        assert!(!line.contains("dropped"), "{line}");
    }

    #[test]
    fn an_isolated_profile_is_a_home_swap_and_is_noticed() {
        assert!(swaps_home(&invocation("claude", &[], &[("HOME", "/tmp/p")])));
        assert!(!swaps_home(&invocation("claude", &[], &[("ANTHROPIC_MODEL", "x")])));
        assert!(is_env_name("_A1"));
        assert!(!is_env_name("1A"));
        assert!(!is_env_name(""));
    }

    #[test]
    fn a_missing_command_on_the_box_is_said_in_the_machines_name() {
        let there = Remote {
            label: "build-box".into(),
            bin: "claude".into(),
        };
        let said = failure_sentence("/usr/local/bin/claude", NOT_FOUND, "", Some(&there));
        assert!(said.starts_with("build-box doesn't have the `claude` command"), "{said}");
        let said = failure_sentence("claude", UNREACHED, "", Some(&there));
        assert!(said.starts_with("build-box didn't answer"), "{said}");
        // Locally, 127 is still the engine mapping's business.
        let here = failure_sentence("claude", NOT_FOUND, "", None);
        assert!(!here.contains("build-box"), "{here}");
    }
}
