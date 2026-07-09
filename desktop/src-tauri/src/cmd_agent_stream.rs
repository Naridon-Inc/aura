//! Streaming agent invocation. Spawns the agent CLI in non-interactive
//! one-shot mode (`claude -p <prompt> --output-format stream-json
//! --verbose`) and parses each JSONL line into typed `StreamEvent`
//! values the React side can render as chat bubbles + tool-call cards.
//!
//! Why this exists alongside `cmd_agent_pty`:
//!   - PTY mode hosts the *real* TUI in xterm.js. Faithful but not
//!     user-friendly — Claude Code redraws frames + animates spinners.
//!   - Stream mode trades the interactive REPL for a clean structured
//!     conversation surface (the same pattern Cline / Continue / opencode
//!     use). Default for "Send" in the Composer.
//!
//! Channel naming is per `(agent_id, repo_root)` so the React store can
//! subscribe once per tab and have *all* turns of a session land on the
//! same topic. `--resume <session_id>` carries multi-turn state — the
//! `system_init` event from claude carries the new session id back so
//! the next send can continue the thread.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use crate::cmd_aurawatch::WatchRegistry;

/// Tracks the live child process per channel so the React side can
/// kill a turn mid-flight when the user clicks Stop. We hold the OS
/// pid (not the tokio Child handle directly) because the tokio Child
/// is owned by the spawned reader task; sending a SIGTERM by pid is
/// the lightest cross-thread mechanism.
#[derive(Default)]
pub struct ChildRegistry {
    pub by_channel: Mutex<HashMap<String, u32>>,
}

impl ChildRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn set(&self, channel: &str, pid: u32) {
        if let Ok(mut g) = self.by_channel.lock() {
            g.insert(channel.to_string(), pid);
        }
    }

    fn clear(&self, channel: &str) {
        if let Ok(mut g) = self.by_channel.lock() {
            g.remove(channel);
        }
    }

    fn get(&self, channel: &str) -> Option<u32> {
        self.by_channel.lock().ok().and_then(|g| g.get(channel).copied())
    }
}

/// Base64-encoded image attachment going to the agent. `media_type` is
/// the MIME label ("image/png", "image/jpeg", "image/gif", "image/webp")
/// the Anthropic Messages API accepts. We never persist these — they
/// live only inside the user message we write to stdin.
#[derive(Deserialize, Clone, Debug)]
pub struct ImageAttachment {
    pub data: String,
    pub media_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StreamEvent {
    /// Synthesised by us, not by the agent — surfaces the prompt as a
    /// bubble before the agent has had a chance to respond.
    UserPrompt {
        text: String,
        turn_id: String,
        ts: i64,
    },
    SystemInit {
        session_id: String,
        model: Option<String>,
        tools: Vec<String>,
        turn_id: String,
    },
    AssistantText {
        text: String,
        turn_id: String,
    },
    /// Per-assistant-message token accounting, lifted from the model's
    /// `message.usage`. `context_tokens` is everything fed INTO this call
    /// (fresh input + both cache planes); `output_tokens` is what the model
    /// generated. Keyed by `message_id` so a re-emit on reconnect/history-
    /// overlap merges instead of double-counting. The chat folds these per
    /// response into a faint "≈45k context · 1.2k tokens" footer.
    Usage {
        context_tokens: u64,
        output_tokens: u64,
        message_id: String,
        turn_id: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        turn_id: String,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
        turn_id: String,
    },
    /// Emitted once at the end of a turn. `success` mirrors claude's
    /// `subtype: "success" | "error"`.
    Result {
        success: bool,
        duration_ms: u64,
        cost_usd: Option<f64>,
        total_tokens: Option<u64>,
        message: Option<String>,
        turn_id: String,
    },
    /// Inline image content block — either echoed by the agent in an
    /// assistant message, or pushed locally by the React side after the
    /// user attaches an image (so the bubble feed has something to show
    /// before stdin even reaches claude). `data` is base64; `media_type`
    /// is the MIME label.
    Image {
        role: String, // "user" | "assistant"
        media_type: String,
        data: String,
        turn_id: String,
    },
    /// Anything we can't parse. Keeps the surface honest — we don't
    /// silently drop output the user might need.
    RawError {
        message: String,
        turn_id: String,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct TurnHandle {
    pub turn_id: String,
    pub topic: String,
    pub done_topic: String,
}

#[tauri::command]
pub async fn agent_stream_send(
    app: AppHandle,
    _watch: State<'_, WatchRegistry>,
    agent_id: String,
    repo_root: String,
    prompt: String,
    resume_session: Option<String>,
    attachments: Option<Vec<ImageAttachment>>,
    permission_mode: Option<String>,
    effort: Option<String>,
    fast: Option<bool>,
) -> Result<TurnHandle, String> {
    let attachments = attachments.unwrap_or_default();
    // Cross-agent reasoning effort for this launch — `None` keeps the agent
    // at its own default. Mapped onto each provider's real mechanism inside
    // build_invocation (Codex `-c` flag, Claude keyword, prompt-steer for
    // flagless CLIs).
    let effort = effort.as_deref().and_then(|s| match s {
        "low" => Some(aura_agents::ReasoningEffort::Low),
        "medium" => Some(aura_agents::ReasoningEffort::Medium),
        "high" => Some(aura_agents::ReasoningEffort::High),
        "max" => Some(aura_agents::ReasoningEffort::Max),
        _ => None,
    });
    let fast = fast.unwrap_or(false);
    // Empty prompt is fine when the user is sending images alone — claude
    // accepts a content array of just image blocks. Only block when both
    // are empty.
    if prompt.trim().is_empty() && attachments.is_empty() {
        return Err("empty prompt".to_string());
    }
    // Tauri's event-name validator rejects anything outside
    // [A-Za-z0-9/_:-] — paths with spaces silently no-op the emit and
    // the UI sits there with no bubbles. Sanitize before forming the
    // topic; the React side runs the same scrub so both halves agree.
    let sanitized = sanitize_channel(&format!("{agent_id}@{repo_root}"));
    let topic = format!("agent-stream:{sanitized}");
    let done_topic = format!("agent-stream-done:{sanitized}");
    let turn_id = format!("turn-{}", Uuid::new_v4());

    // The frontend pushes the UserPrompt bubble synchronously into its
    // store *before* awaiting this invoke — so we never emit one here.
    // Emitting from the backend races the listener attach (the React
    // useEffect that calls listen() runs after this command returns)
    // and gets dropped on the floor. Anything past this point is real
    // agent output and arrives after a tick — by then the listener is
    // live, so it lands cleanly.

    // Build the command via the agent registry. Adding a new agent
    // CLI lands as one new file in `aura-agents` — the dispatch site
    // doesn't change. Only Claude currently speaks the Anthropic
    // stream-json format; other providers report `stdout_is_stream_json
    // = false` and the parser surfaces their stdout as a single
    // AssistantText block.
    let reg = aura_agents::registry();
    let provider = reg
        .get(&agent_id)
        .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    let use_stdin_json = agent_id == "claude" && !attachments.is_empty();
    let inv = provider
        .build_invocation(&aura_agents::InvokeRequest {
            prompt: &prompt,
            mode: aura_agents::InvokeMode::StreamJson,
            resume_session_id: resume_session.as_deref(),
            attachments_via_stdin: use_stdin_json,
            effort,
            fast,
            model: None,
            approval: None,
        })
        .map_err(|e| format!("build invocation for {agent_id}: {e}"))?;
    let bin = inv.bin.clone();

    let mut cmd = Command::new(&bin);
    cmd.current_dir(crate::spawn_dir::safe_spawn_dir(&repo_root));
    for arg in &inv.args {
        cmd.arg(arg);
    }
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }

    // Claude-only post-build extensions: permission-prompt MCP bridge
    // and the optional --permission-mode toggle. These live shell-side
    // because the MCP shim path is only meaningful inside the desktop
    // app's install layout — not something a generic provider should
    // model.
    if agent_id == "claude" {
        if let Some(cfg_path) = write_mcp_config(&sanitized) {
            cmd.arg("--mcp-config")
                .arg(&cfg_path)
                .arg("--permission-prompt-tool")
                .arg("mcp__aura_shell__permission_prompt");
        }
        if let Some(mode) = permission_mode.as_deref() {
            // Whitelist what we forward — claude rejects unknown values
            // and we don't want to let the React side accidentally pass
            // a stale flag name.
            if matches!(
                mode,
                "default" | "plan" | "acceptEdits" | "bypassPermissions"
            ) && mode != "default"
            {
                cmd.arg("--permission-mode").arg(mode);
            }
        }
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if use_stdin_json {
        cmd.stdin(Stdio::piped());
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {bin}: {e}"))?;
    if let Some(pid) = child.id() {
        let registry: tauri::State<'_, ChildRegistry> = app.state();
        registry.set(&sanitized, pid);
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout pipe".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr pipe".to_string())?;

    // Write the user message (text + image blocks) to stdin in
    // stream-json shape, then close stdin so claude proceeds to a single
    // turn. Anthropic Messages API content-block format — same shape the
    // SDK uses, so future block types (file references, etc.) only need
    // a parser extension on the way back.
    if use_stdin_json {
        if let Some(mut stdin) = child.stdin.take() {
            let mut content = Vec::with_capacity(attachments.len() + 1);
            if !prompt.trim().is_empty() {
                content.push(json!({ "type": "text", "text": prompt }));
            }
            for att in &attachments {
                content.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": att.media_type,
                        "data": att.data,
                    }
                }));
            }
            let line = json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": content,
                }
            });
            let mut buf = serde_json::to_vec(&line)
                .map_err(|e| format!("encode user message: {e}"))?;
            buf.push(b'\n');
            stdin
                .write_all(&buf)
                .await
                .map_err(|e| format!("write stdin: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("close stdin: {e}"))?;
        }
    }

    let app_for_task = app.clone();
    let topic_for_task = topic.clone();
    let done_topic_for_task = done_topic.clone();
    let turn_for_task = turn_id.clone();
    let repo_for_task = repo_root.clone();
    let channel_for_task = sanitized.clone();
    // Provider-declared signal — only providers that emit Anthropic
    // stream-json get the structured parser. Today that's just claude;
    // tomorrow it could be any provider that adopts the same shape.
    let parse_stream_json = inv.stdout_is_stream_json;

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut accumulated_text = String::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if parse_stream_json {
                for ev in parse_claude_line(&line, &turn_for_task) {
                    // AuraWatch tap. Cheap O(1) lookup; drops the
                    // event on the floor when this repo isn't being
                    // watched. Done before the emit so a saturated
                    // watcher can never stall the main bubble feed.
                    if let StreamEvent::ToolUse { name, input, .. } = &ev {
                        let file = input
                            .get("file_path")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let watch: tauri::State<'_, WatchRegistry> =
                            app_for_task.state();
                        watch
                            .observe(
                                &app_for_task,
                                &repo_for_task,
                                &channel_for_task,
                                name,
                                file.as_deref(),
                            )
                            .await;
                    }
                    let _ = app_for_task.emit(&topic_for_task, ev);
                }
            } else {
                // Non-claude agents: accumulate stdout, emit one bubble
                // at the end so partial lines don't fragment the bubble.
                accumulated_text.push_str(&line);
                accumulated_text.push('\n');
            }
        }
        if !accumulated_text.is_empty() {
            let _ = app_for_task.emit(
                &topic_for_task,
                StreamEvent::AssistantText {
                    text: accumulated_text.trim_end().to_string(),
                    turn_id: turn_for_task.clone(),
                },
            );
        }

        // Drain stderr — non-fatal warnings still ride here.
        let mut err_reader = BufReader::new(stderr).lines();
        let mut err_buf = String::new();
        while let Ok(Some(line)) = err_reader.next_line().await {
            err_buf.push_str(&line);
            err_buf.push('\n');
        }
        let trimmed_err = err_buf.trim();
        if !trimmed_err.is_empty() {
            let _ = app_for_task.emit(
                &topic_for_task,
                StreamEvent::RawError {
                    message: trimmed_err.to_string(),
                    turn_id: turn_for_task.clone(),
                },
            );
        }

        let exit = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        let registry: tauri::State<'_, ChildRegistry> = app_for_task.state();
        registry.clear(&channel_for_task);
        let _ = app_for_task.emit(
            &done_topic_for_task,
            ExitInfo {
                turn_id: turn_for_task,
                exit_code: exit,
            },
        );
    });

    Ok(TurnHandle {
        turn_id,
        topic,
        done_topic,
    })
}

#[derive(Serialize, Clone, Debug)]
struct ExitInfo {
    turn_id: String,
    exit_code: i32,
}

/// Kill the live child for `channel`. Returns true if a process was
/// signaled, false if nothing was running. We send SIGTERM (Unix) /
/// TerminateProcess (Windows) — claude handles the signal cleanly,
/// flushing partial stdout before exit so the bubble feed doesn't
/// truncate mid-message.
#[tauri::command]
pub fn agent_stream_interrupt(
    registry: State<'_, ChildRegistry>,
    channel: String,
) -> Result<bool, String> {
    let Some(pid) = registry.get(&channel) else {
        return Ok(false);
    };
    #[cfg(unix)]
    {
        // SAFETY: kill(2) is signal-safe and pid comes from our own spawn.
        // Failure here is fine — the child may have just exited.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        // Best-effort on Windows: spawn taskkill /F /PID. Not perfect,
        // but avoids pulling winapi just for this single call.
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    registry.clear(&channel);
    Ok(true)
}

/// Replace every char Tauri's event-name parser rejects with `_`.
/// Allowed set per Tauri 2: ASCII alphanumerics, `/`, `_`, `:`, `-`.
/// We exclude `/` and `:` from the allowed-passthrough here too because
/// they collide with our own topic prefix syntax (`agent-stream:` and
/// path separators would re-split the channel on the React side).
fn sanitize_channel(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// Parse one JSONL line from `claude -p --output-format stream-json
// --verbose`. Returns 0..N normalized events (an assistant message can
// carry multiple content blocks, each becoming its own event).
fn parse_claude_line(line: &str, turn_id: &str) -> Vec<StreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => {
            return vec![StreamEvent::RawError {
                message: trimmed.to_string(),
                turn_id: turn_id.to_string(),
            }];
        }
    };
    let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "system" => {
            if v.get("subtype").and_then(Value::as_str) == Some("init") {
                let session_id = v
                    .get("session_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let model = v.get("model").and_then(Value::as_str).map(str::to_string);
                let tools = v
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|t| t.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                vec![StreamEvent::SystemInit {
                    session_id,
                    model,
                    tools,
                    turn_id: turn_id.to_string(),
                }]
            } else {
                vec![]
            }
        }
        "assistant" => {
            let blocks = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            let mut out = Vec::new();
            if let Some(arr) = blocks {
                for b in arr {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    match bt {
                        "text" => {
                            let text = b
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            if !text.is_empty() {
                                out.push(StreamEvent::AssistantText {
                                    text,
                                    turn_id: turn_id.to_string(),
                                });
                            }
                        }
                        "tool_use" => {
                            let id = b
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let name = b
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let input = b.get("input").cloned().unwrap_or(Value::Null);
                            out.push(StreamEvent::ToolUse {
                                id,
                                name,
                                input,
                                turn_id: turn_id.to_string(),
                            });
                        }
                        "image" => {
                            if let Some(img) = parse_image_block(b) {
                                out.push(StreamEvent::Image {
                                    role: "assistant".to_string(),
                                    media_type: img.0,
                                    data: img.1,
                                    turn_id: turn_id.to_string(),
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            // Token accounting rides on the assistant message itself. Context
            // fed in = fresh input + both cache planes (cache_read is the bulk
            // of a long conversation); output = what the model just generated.
            // Emitted last so it folds in after this message's prose/tools, and
            // keyed by `message.id` so a re-emitted line merges, never sums twice.
            if let Some(usage) = v.get("message").and_then(|m| m.get("usage")) {
                let field = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
                let context_tokens = field("input_tokens")
                    + field("cache_read_input_tokens")
                    + field("cache_creation_input_tokens");
                let output_tokens = field("output_tokens");
                if context_tokens > 0 || output_tokens > 0 {
                    let message_id = v
                        .get("message")
                        .and_then(|m| m.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    out.push(StreamEvent::Usage {
                        context_tokens,
                        output_tokens,
                        message_id,
                        turn_id: turn_id.to_string(),
                    });
                }
            }
            out
        }
        "user" => {
            // Tool results come back wrapped in "user" messages.
            let blocks = v
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            let mut out = Vec::new();
            if let Some(arr) = blocks {
                for b in arr {
                    let bt = b.get("type").and_then(Value::as_str).unwrap_or("");
                    if bt == "image" {
                        // Images can appear in user-wrapped messages too,
                        // either when an MCP tool returned one or when a
                        // resumed session replays prior user attachments.
                        if let Some(img) = parse_image_block(b) {
                            out.push(StreamEvent::Image {
                                role: "user".to_string(),
                                media_type: img.0,
                                data: img.1,
                                turn_id: turn_id.to_string(),
                            });
                        }
                        continue;
                    }
                    if bt == "tool_result" {
                        let tool_use_id = b
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        // `content` may be a string OR an array of
                        // {type:"text",text:"…"} blocks. Coalesce.
                        let content = match b.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(items)) => items
                                .iter()
                                .filter_map(|i| {
                                    i.get("text").and_then(Value::as_str).map(str::to_string)
                                })
                                .collect::<Vec<_>>()
                                .join("\n"),
                            Some(other) => other.to_string(),
                            None => String::new(),
                        };
                        let is_error = b
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        out.push(StreamEvent::ToolResult {
                            tool_use_id,
                            content,
                            is_error,
                            turn_id: turn_id.to_string(),
                        });
                    }
                }
            }
            out
        }
        "result" => {
            let success = v.get("subtype").and_then(Value::as_str) == Some("success");
            let duration_ms = v
                .get("duration_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let cost_usd = v
                .get("total_cost_usd")
                .or_else(|| v.get("cost_usd"))
                .and_then(Value::as_f64);
            let total_tokens = v
                .get("usage")
                .and_then(|u| u.get("total_tokens").or_else(|| u.get("input_tokens")))
                .and_then(Value::as_u64);
            let message = v
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string);
            vec![StreamEvent::Result {
                success,
                duration_ms,
                cost_usd,
                total_tokens,
                message,
                turn_id: turn_id.to_string(),
            }]
        }
        _ => vec![],
    }
}

// Resolve the path to the `aura-shell-mcp` companion binary. Cargo
// drops it next to the main aura-shell binary in `target/{profile}/`
// for dev and inside the `Contents/MacOS/` bundle dir for release. We
// never search PATH — using the same dir guarantees the shim version
// matches the running shell version.
fn mcp_bin_path() -> Option<PathBuf> {
    let mut p = std::env::current_exe().ok()?;
    p.pop();
    let name = if cfg!(windows) {
        "aura-shell-mcp.exe"
    } else {
        "aura-shell-mcp"
    };
    p.push(name);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

// Write a per-channel claude MCP config JSON. We use a file (not the
// inline-string form of `--mcp-config`) so the channel + socket env
// vars don't have to survive shell quoting on Windows. Returns None if
// the shim binary is missing — callers then skip the wiring.
fn write_mcp_config(channel: &str) -> Option<PathBuf> {
    // A missing shim is an *expected* fallback (e.g. `tauri dev`, where the
    // sidecar isn't co-located) — skip the permission-bridge wiring quietly
    // via the `?`. Every failure *below* this point means the shim IS
    // present but we couldn't write its config, so claude would launch with
    // no `--permission-prompt-tool` and the user's in-app permission gate
    // would silently not fire on tool calls. Warn loudly on those paths
    // instead of swallowing them, so a broken gate is diagnosable rather
    // than invisible.
    let bin = mcp_bin_path()?;
    let sock = crate::cmd_permission_socket::socket_path();
    let Some(mut dir) = dirs::home_dir() else {
        eprintln!(
            "[mcp-config] no home dir — claude will launch WITHOUT the permission gate"
        );
        return None;
    };
    dir.push(".aura");
    dir.push("run");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "[mcp-config] mkdir {}: {e} — claude will launch WITHOUT the permission gate",
            dir.display()
        );
        return None;
    }
    let mut path = dir;
    path.push(format!("mcp-{channel}.json"));
    let cfg = json!({
        "mcpServers": {
            "aura_shell": {
                "command": bin.to_string_lossy(),
                "env": {
                    "AURA_SHELL_SOCK": sock.to_string_lossy(),
                    "AURA_SHELL_CHANNEL": channel,
                }
            }
        }
    });
    let body = match serde_json::to_string_pretty(&cfg) {
        Ok(b) => b,
        Err(e) => {
            eprintln!(
                "[mcp-config] serialize: {e} — claude will launch WITHOUT the permission gate"
            );
            return None;
        }
    };
    if let Err(e) = std::fs::write(&path, &body) {
        eprintln!(
            "[mcp-config] write {}: {e} — claude will launch WITHOUT the permission gate",
            path.display()
        );
        return None;
    }
    // This file names the permission socket + channel that gate every tool
    // call; keep it owner-only so another local account can't read the
    // channel id out of it (best-effort, unix only).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(path)
}

// Pull (media_type, base64_data) out of an Anthropic-shaped image block.
// Two source variants matter to us: `{type:"base64", media_type, data}`
// and `{type:"url", url}`. The latter we surface by stuffing the URL
// into the data field with media_type "url" — the React side renders
// it directly via <img src={url}>.
fn parse_image_block(b: &Value) -> Option<(String, String)> {
    let src = b.get("source")?;
    let stype = src.get("type").and_then(Value::as_str).unwrap_or("");
    match stype {
        "base64" => {
            let mt = src
                .get("media_type")
                .and_then(Value::as_str)
                .unwrap_or("image/png")
                .to_string();
            let data = src.get("data").and_then(Value::as_str)?.to_string();
            Some((mt, data))
        }
        "url" => {
            let url = src.get("url").and_then(Value::as_str)?.to_string();
            Some(("url".to_string(), url))
        }
        _ => None,
    }
}
