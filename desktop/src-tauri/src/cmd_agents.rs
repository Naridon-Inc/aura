//! Agent CLI integration. Discovery + spawn + streaming.
//!
//! Backed by the `aura-agents` provider registry — a single source of
//! truth shared with `aura-cli`'s orchestrator and the shell's stream +
//! pty dispatch sites. Adding a new agent is one new file in
//! `aura-agents/src/`, not three patches across this crate. Power users
//! drop a `[[agent]]` entry into `~/.aura/agents.toml` and call
//! `agents_reload` to pick it up without recompiling.
//!
//! `agent_discover` is the legacy compact shape the React composer
//! consumes (id/label/monogram/bin/version/available/continuable).
//! `agents_list` returns the richer `AgentDescriptor` shape used by the
//! Manager surface's reassign menu and the future provider settings
//! panel.

use std::process::Stdio;

use aura_agents::{AgentDescriptor, InvokeMode, InvokeRequest, registry, reload};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentInfo {
    /// Stable id used by send/streaming calls and surfaced in the UI.
    pub id: String,
    /// Human label shown in pickers (e.g. "Claude Code").
    pub label: String,
    /// Absolute path to the binary on disk. None if the bin isn't in PATH.
    pub bin: Option<String>,
    /// Trimmed first line of `<bin> --version`. Empty if discovery failed.
    pub version: String,
    /// Single-letter monogram for compact chips.
    pub monogram: String,
    /// Whether the agent is callable right now. Useful so the UI can
    /// render greyed-out rows for known-but-not-installed agents.
    pub available: bool,
    /// True if this agent supports continuing the previous session
    /// (we'll pass `--resume <sid>` etc. for second+ messages).
    pub continuable: bool,
}

#[tauri::command]
pub async fn agent_discover() -> Vec<AgentInfo> {
    let reg = registry();
    reg.iter()
        .map(|p| {
            let bin_path = which(p.bin_name());
            let available = bin_path.is_some() && p.is_available();
            AgentInfo {
                id: p.id().to_string(),
                label: p.label().to_string(),
                bin: bin_path,
                version: p.version().unwrap_or_default(),
                monogram: monogram_for(p.id()),
                available,
                continuable: p.capabilities().resume,
            }
        })
        .collect()
}

/// Richer descriptor list — used by the Manager UI's reassign menu and
/// the provider settings panel. Mirrors `aura_agents::AgentDescriptor`
/// 1:1 so React can deserialise without a custom shape.
#[tauri::command]
pub async fn agents_list() -> Vec<AgentDescriptor> {
    registry().descriptors()
}

/// Re-read `~/.aura/agents.toml` and rebuild the registry from
/// defaults. Use after the user edits their TOML to pick up new
/// providers without restarting the shell.
#[tauri::command]
pub async fn agents_reload() -> Vec<AgentDescriptor> {
    reload().descriptors()
}

/// One-shot send. Returns the full captured stdout (and stderr appended
/// on non-zero exit). Use `agent_send_streaming` instead if you want
/// to render output live.
#[tauri::command]
pub async fn agent_send(
    agent_id: String,
    prompt: String,
    repo_root: String,
    continue_session: bool,
) -> Result<String, String> {
    let inv = build_one_shot_invocation(&agent_id, &prompt, continue_session)?;
    let mut cmd = Command::new(&inv.bin);
    cmd.args(&inv.args).current_dir(&repo_root);
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{stdout}\n{stderr}").trim().to_string());
    }
    Ok(stdout)
}

/// Streaming send. Spawns the agent and emits each stdout line as a
/// `agent-stream:<channel>` event. When the child exits, emits
/// `agent-done:<channel>` with the exit code. The frontend listens on
/// the channel name it picked.
#[tauri::command]
pub async fn agent_send_streaming(
    app: AppHandle,
    agent_id: String,
    prompt: String,
    repo_root: String,
    continue_session: bool,
    channel: String,
) -> Result<(), String> {
    let inv = build_one_shot_invocation(&agent_id, &prompt, continue_session)?;

    let mut cmd = Command::new(&inv.bin);
    cmd.args(&inv.args)
        .current_dir(&repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr = child.stderr.take().ok_or("no stderr pipe")?;
    let stream_event = format!("agent-stream:{channel}");
    let done_event = format!("agent-done:{channel}");

    let app_for_stdout = app.clone();
    let evt_for_stdout = stream_event.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_for_stdout.emit(&evt_for_stdout, line);
        }
    });
    let app_for_stderr = app.clone();
    let evt_for_stderr = stream_event.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Prefix stderr so the UI can style it differently if it wants.
            let _ = app_for_stderr.emit(&evt_for_stderr, format!("[stderr] {line}"));
        }
    });

    tauri::async_runtime::spawn(async move {
        let status = child.wait().await;
        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = app.emit(&done_event, code);
    });
    Ok(())
}

// ── helpers ─────────────────────────────────────────────────────────────

/// Builds a OneShot invocation through the provider registry, with a
/// resume-session passthrough when the agent supports it (today, that's
/// only claude). The legacy "continue last session" flag from this
/// command's pre-registry shape doesn't carry a session id, so for
/// providers that need an explicit id (claude's `--resume <sid>`) we
/// can't satisfy it here — callers wanting resume should drive
/// `cmd_agent_stream::agent_stream_send` instead, which carries the
/// session id explicitly.
fn build_one_shot_invocation(
    agent_id: &str,
    prompt: &str,
    _continue_session: bool,
) -> Result<aura_agents::Invocation, String> {
    let reg = registry();
    let provider = reg
        .get(agent_id)
        .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
    provider
        .build_invocation(&InvokeRequest {
            prompt,
            mode: InvokeMode::OneShot,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        })
        .map_err(|e| format!("build invocation for {agent_id}: {e}"))
}

fn which(bin: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if is_executable(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Single-letter monogram for compact UI chips. Falls back to the first
/// letter of the id, uppercased.
fn monogram_for(id: &str) -> String {
    match id {
        "claude" => "C".into(),
        "gemini" => "G".into(),
        "codex" => "X".into(),
        "cursor" => "U".into(),
        "kimi" => "K".into(),
        "pi" => "π".into(),
        other => other
            .chars()
            .next()
            .map(|c| c.to_ascii_uppercase().to_string())
            .unwrap_or_else(|| "?".into()),
    }
}
