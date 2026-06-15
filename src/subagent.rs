//! `aura subagent` — fan-out helper used by the Aura Manager when it
//! runs as a CLI brain (Claude Code / Gemini CLI / Codex / Cursor).
//!
//! The Manager's system preamble teaches it to invoke this command via
//! its native Bash tool when it wants to dispatch work to another coding
//! agent. Synchronous: spawns the target CLI, waits for it to finish,
//! prints its captured output. No daemon, no inbox, no Tauri IPC.
//!
//! Example: the Manager (running as `claude`) wants Gemini to ship a UI
//! tweak. It runs:
//!
//!   aura subagent spawn gemini "Add a dark-mode toggle to Settings"
//!
//! and the Bash tool returns Gemini's full output to the Manager's
//! context, which it then summarises for the user.
//!
//! When `AURA_MANAGER_SESSION_ID` is set in env (the shell sets this on
//! every CLI brain spawn), this command also appends a real `ManagerTask`
//! + `TaskDispatched`/`TaskCompleted` ribbon events to the session JSON
//! at `~/.aura/manager-sessions/<sid>.json`. That makes the Manager DAG
//! reflect real fan-out instead of letting the brain narrate as if it
//! delegated when it didn't.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use aura_agents::{InvokeMode, InvokeRequest, registry};
use serde_json::{Value, json};

/// Spawn a subagent synchronously. Streams its stdout to our stdout in
/// real time so the parent CLI's tool-result includes everything the
/// subagent said. Exit code propagates so the parent can reason about
/// success/failure. `zones` + `depends_on` are recorded on the
/// ManagerTask for DAG rendering and (eventually) zone-claim collision
/// checks; both are no-ops when not invoked from inside a Manager
/// session.
pub fn spawn(
    provider_id: &str,
    prompt: &str,
    zones: &[String],
    depends_on: &[usize],
    a2a_task_id: Option<&str>,
) -> i32 {
    let provider = match resolve_provider(provider_id) {
        Ok(p) => p,
        Err(code) => return code,
    };

    let session_id = std::env::var("AURA_MANAGER_SESSION_ID").ok();
    let task_id = session_id
        .as_deref()
        .and_then(|sid| record_dispatch(sid, provider_id, prompt, zones, depends_on, a2a_task_id));
    announce(&provider, provider_id, task_id);

    run_subagent_sync(&provider, provider_id, prompt, session_id.as_deref(), task_id)
}

/// Background variant of `spawn`. Records dispatch immediately, then
/// double-forks (via `setsid`) so the actual subagent runs detached.
/// Prints `task_id=<n>` to stdout and returns instantly so the brain's
/// bash tool unblocks. Pair with `wait <task_id>` to harvest output.
pub fn spawn_bg(
    provider_id: &str,
    prompt: &str,
    zones: &[String],
    depends_on: &[usize],
    a2a_task_id: Option<&str>,
) -> i32 {
    if resolve_provider(provider_id).is_err() {
        return 2;
    }
    let Some(session_id) = std::env::var("AURA_MANAGER_SESSION_ID").ok() else {
        eprintln!(
            "aura subagent spawn-bg: AURA_MANAGER_SESSION_ID not set. Background spawn requires a Manager session for state tracking; use `aura subagent spawn` outside a session."
        );
        return 6;
    };
    let Some(task_id) = record_dispatch(&session_id, provider_id, prompt, zones, depends_on, a2a_task_id) else {
        eprintln!("aura subagent spawn-bg: failed to record task in session JSON");
        return 7;
    };

    // Re-exec ourselves in detached mode. setsid + redirected fds so the
    // child outlives the brain's bash tool returning. Stdout of the
    // detached child is dropped (output is captured in the task JSON
    // when it completes via record_completion).
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("aura subagent spawn-bg: current_exe: {e}");
            record_completion(&session_id, task_id, 8, &format!("exec resolution failed: {e}"));
            return 8;
        }
    };
    let log_path = detached_log_path(&session_id, task_id);
    let log_file = std::fs::File::create(&log_path)
        .map(|f| (f.try_clone().ok(), f))
        .ok();
    let (stdout_for_child, stderr_for_child) = match log_file {
        Some((Some(out), err)) => (Stdio::from(out), Stdio::from(err)),
        Some((None, _)) => (Stdio::null(), Stdio::null()),
        None => (Stdio::null(), Stdio::null()),
    };

    // Detach via libc::setsid() in a pre_exec hook on the child. We used
    // to shell out to the external `setsid(1)` binary, but that's not
    // shipped on macOS by default — the spawn failed with `os error 2`
    // and every background subagent died with exit code 9. Calling
    // setsid(2) directly works on both macOS + Linux and removes the
    // coreutils dependency.
    use std::os::unix::process::CommandExt;
    let task_id_str = task_id.to_string();
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("subagent")
        .arg("run-detached")
        .arg(&task_id_str)
        .arg(provider_id)
        .arg(prompt)
        .env("AURA_MANAGER_SESSION_ID", &session_id)
        .stdin(Stdio::null())
        .stdout(stdout_for_child)
        .stderr(stderr_for_child);
    unsafe {
        cmd.pre_exec(|| {
            // Detach: become process-group leader so the child survives
            // when the parent (`aura subagent spawn-bg`) exits. setsid(2)
            // returns the new session id on success or -1 on error; we
            // can't really recover here so just propagate.
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    match cmd.spawn() {
        Ok(_) => {
            // Print machine-readable + human-readable lines so the brain's
            // bash regex grabs `task_id=N` and the user-visible log gets
            // a tidy line.
            println!("task_id={task_id}");
            eprintln!(
                "↪ aura subagent (bg) → {} [task #{task_id}] log: {}",
                provider_id,
                log_path.display()
            );
            0
        }
        Err(e) => {
            eprintln!("aura subagent spawn-bg: detached spawn failed: {e}");
            record_completion(
                &session_id,
                task_id,
                9,
                &format!("background spawn failed: {e}"),
            );
            9
        }
    }
}

/// Internal entry — re-enters from `spawn-bg` after detaching. Reuses
/// the existing task record (no double-allocation of task ids).
pub fn run_detached(task_id: usize, provider_id: &str, prompt: &str) -> i32 {
    let provider = match resolve_provider(provider_id) {
        Ok(p) => p,
        Err(code) => {
            if let Ok(sid) = std::env::var("AURA_MANAGER_SESSION_ID") {
                record_completion(
                    &sid,
                    task_id,
                    code,
                    &format!("provider {provider_id} unavailable"),
                );
            }
            return code;
        }
    };
    let session_id = std::env::var("AURA_MANAGER_SESSION_ID").ok();
    run_subagent_sync(&provider, provider_id, prompt, session_id.as_deref(), Some(task_id))
}

/// Block until task <task_id> reaches a terminal status. Prints captured
/// output + summary line + final status. Exits non-zero on failure /
/// timeout.
pub fn wait(task_id: usize, timeout_secs: u64) -> i32 {
    let Some(session_id) = std::env::var("AURA_MANAGER_SESSION_ID").ok() else {
        eprintln!(
            "aura subagent wait: AURA_MANAGER_SESSION_ID not set. `wait` only makes sense inside a Manager session."
        );
        return 6;
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        let Some((_, value)) = read_session(&session_id) else {
            eprintln!("aura subagent wait: session {session_id} disappeared");
            return 10;
        };
        let task = value
            .get("tasks")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|t| t.get("id").and_then(|n| n.as_u64()) == Some(task_id as u64))
            });
        let Some(task) = task else {
            eprintln!("aura subagent wait: task #{task_id} not found");
            return 11;
        };
        let status = task
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("unknown");
        match status {
            "done" => {
                let summary = task
                    .get("summary")
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                let output = task
                    .get("output")
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if !output.is_empty() {
                    print!("{output}");
                    if !output.ends_with('\n') {
                        println!();
                    }
                }
                eprintln!("✓ task #{task_id} done — {summary}");
                return 0;
            }
            "failed" => {
                let output = task
                    .get("output")
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                if !output.is_empty() {
                    print!("{output}");
                    if !output.ends_with('\n') {
                        println!();
                    }
                }
                eprintln!("✗ task #{task_id} failed");
                return 1;
            }
            "skipped" => {
                eprintln!("— task #{task_id} skipped");
                return 0;
            }
            _ => {
                if std::time::Instant::now() > deadline {
                    eprintln!(
                        "aura subagent wait: task #{task_id} still {status} after {timeout_secs}s"
                    );
                    return 12;
                }
                std::thread::sleep(std::time::Duration::from_millis(750));
            }
        }
    }
}

fn resolve_provider(provider_id: &str) -> Result<std::sync::Arc<dyn aura_agents::AgentProvider>, i32> {
    let reg = registry();
    let provider = match reg.get(provider_id) {
        Some(p) => p,
        None => {
            eprintln!(
                "aura subagent: unknown provider '{provider_id}'. Available: claude, gemini, codex, cursor"
            );
            return Err(2);
        }
    };
    if !provider.is_available() {
        eprintln!(
            "aura subagent: '{provider_id}' binary not found in PATH. Install it or pick another provider."
        );
        return Err(3);
    }
    Ok(provider)
}

fn announce(
    provider: &std::sync::Arc<dyn aura_agents::AgentProvider>,
    provider_id: &str,
    task_id: Option<usize>,
) {
    if let Some(tid) = task_id {
        eprintln!(
            "↪ aura subagent → {} ({}) [task #{tid}]",
            provider.label(),
            provider_id
        );
    } else {
        eprintln!("↪ aura subagent → {} ({})", provider.label(), provider_id);
    }
}

fn run_subagent_sync(
    provider: &std::sync::Arc<dyn aura_agents::AgentProvider>,
    provider_id: &str,
    prompt: &str,
    session_id: Option<&str>,
    task_id: Option<usize>,
) -> i32 {
    let invocation = match provider.build_invocation(&InvokeRequest {
        prompt,
        mode: InvokeMode::OneShot,
        resume_session_id: None,
        attachments_via_stdin: false,
        effort: None,
        fast: false,
        model: None,
        approval: None,
    }) {
        Ok(i) => i,
        Err(e) => {
            eprintln!("aura subagent: build invocation failed: {e}");
            if let (Some(sid), Some(tid)) = (session_id, task_id) {
                record_completion(sid, tid, 4, &format!("build invocation failed: {e}"));
            }
            return 4;
        }
    };

    let mut cmd = std::process::Command::new(&invocation.bin);
    cmd.args(&invocation.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &invocation.env {
        cmd.env(k, v);
    }
    // Don't let the spawned subagent re-record into the same session as
    // its own task — it's the brain's child, not a peer dispatch.
    cmd.env_remove("AURA_MANAGER_SESSION_ID");
    let _ = provider_id; // keep the linter quiet without changing the signature

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("aura subagent: spawn {} failed: {e}", invocation.bin);
            if let (Some(sid), Some(tid)) = (session_id, task_id) {
                record_completion(sid, tid, 5, &format!("spawn failed: {e}"));
            }
            return 5;
        }
    };

    // Tee subagent stdout to our stdout (so parent's bash tool sees it
    // streaming) and into a buffer (so we can stash on the task record).
    let mut captured = String::new();
    if let Some(out) = child.stdout.take() {
        let mut reader = BufReader::new(out);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let _ = std::io::stdout().write_all(line.as_bytes());
                    let _ = std::io::stdout().flush();
                    captured.push_str(&line);
                }
                Err(_) => break,
            }
        }
    }
    let mut stderr_buf = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr_buf);
        if !stderr_buf.is_empty() {
            let _ = std::io::stderr().write_all(stderr_buf.as_bytes());
        }
    }

    let exit = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);

    if let (Some(sid), Some(tid)) = (session_id, task_id) {
        let body = if exit == 0 {
            captured
        } else if !stderr_buf.is_empty() {
            format!("{captured}\n\n--- stderr ---\n{stderr_buf}")
        } else {
            captured
        };
        record_completion(sid, tid, exit, &body);
    }

    exit
}

fn detached_log_path(session_id: &str, task_id: usize) -> PathBuf {
    let mut p = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => PathBuf::from("/tmp"),
    };
    p.push(".aura");
    p.push("manager-sessions");
    p.push("logs");
    let _ = std::fs::create_dir_all(&p);
    p.push(format!("{session_id}-t{task_id}.log"));
    p
}

/// Bucket O — Tail the most recent stdout/stderr lines from a live or
/// completed Manager subagent. The shell writes `~/.aura/manager-
/// sessions/<sid>-<tid>.tail` as the subagent streams; this command
/// reads the last `tail` lines (default 200). Designed for the Manager
/// brain to call via Bash when it wants to know whether a long-running
/// fan-out is progressing or stuck. Exit codes: 0 = printed, 2 = no
/// tail file found (task hasn't started or session/task id wrong).
pub fn monitor(session_id: &str, task_id: usize, tail: usize) -> i32 {
    let Some(home) = std::env::var_os("HOME") else {
        eprintln!("HOME not set");
        return 1;
    };
    let mut path = std::path::PathBuf::from(home);
    path.push(".aura");
    path.push("manager-sessions");
    path.push(format!("{session_id}-{task_id}.tail"));
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "no tail for session {session_id} task {task_id} (looked at {})",
                path.display()
            );
            return 2;
        }
    };
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(tail.max(1));
    for line in &lines[start..] {
        println!("{line}");
    }
    0
}

/// List available subagent providers + their availability — useful for
/// the Manager to discover what it can fan out to in this environment.
pub fn list() -> i32 {
    let reg = registry();
    println!("Available subagent providers:");
    for p in reg.iter() {
        let mark = if p.is_available() { "✓" } else { "✗" };
        let version = p.version().unwrap_or_else(|| "?".into());
        println!("  {mark} {} ({}) — {}", p.id(), p.label(), version);
    }
    0
}

// ── Manager session bridge ────────────────────────────────────────────
//
// We touch the session JSON via raw `serde_json::Value` because the
// strongly-typed `ManagerSession` schema lives in `aura-shell/src-tauri`
// (a separate crate that depends on Tauri). Editing as Value keeps
// aura-cli decoupled from the shell while still producing records the
// shell deserialises cleanly via `#[serde(default)]` on every field.
//
// Atomicity: we don't hold a file lock — the brain loop in the shell
// races us on the same JSON. To stay correct under concurrent writes we
// always read-modify-write through a tempfile + rename, and re-read
// inside `record_completion` (so we don't clobber a chat turn the brain
// appended between our dispatch and our completion).

fn session_path(session_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("manager-sessions");
    p.push(format!("{session_id}.json"));
    Some(p)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_session(session_id: &str) -> Option<(PathBuf, Value)> {
    let path = session_path(session_id)?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    Some((path, v))
}

/// Lazy-create a Manager session JSON when one doesn't exist for the
/// supplied id. Triggered when a direct PTY agent (claude / gemini /
/// codex / cursor opened straight from the agent picker, no Manager UI
/// in front of it) calls `aura subagent spawn` for the first time. The
/// shell pre-threads `AURA_MANAGER_SESSION_ID` + `AURA_REPO_ROOT` env
/// vars on every PTY spawn so this path always has the metadata it
/// needs to materialise a valid record. Result: those direct dispatches
/// still surface in the History sidebar / Manager session picker, so
/// the same Aura visibility benefits reach the user even when they
/// skipped the Manager UI entirely.
fn ensure_session(session_id: &str) -> Option<(PathBuf, Value)> {
    if let Some(existing) = read_session(session_id) {
        return Some(existing);
    }
    let path = session_path(session_id)?;
    let now = now_secs();
    let repo_root = std::env::var("AURA_REPO_ROOT").unwrap_or_default();
    let agent_id = std::env::var("AURA_AGENT_ID").unwrap_or_default();
    let project_label = if repo_root.is_empty() {
        "Direct agent".to_string()
    } else {
        std::path::Path::new(&repo_root)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Direct agent")
            .to_string()
    };
    let objective = if agent_id.is_empty() {
        "Direct agent dispatches".to_string()
    } else {
        format!("Direct {agent_id} session")
    };
    let value = json!({
        "id": session_id,
        "objective": objective,
        "status": "running",
        "projects": if repo_root.is_empty() {
            json!([])
        } else {
            json!([{ "root": repo_root, "label": project_label }])
        },
        "tasks": [],
        "ribbon": [{
            "at": now,
            "event": { "kind": "plan_ready" },
        }],
        "chat": [],
        "pending_assistant_blocks": null,
        "pending_tool_results": null,
        "brain_backend": null,
        "cli_session_id": null,
        "pending_question": null,
        "pending_plan": null,
        "created_at": now,
        "updated_at": now,
    });
    write_session(&path, &value).ok()?;
    Some((path, value))
}

fn write_session(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent dir")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("serialize: {e}"))?;
    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .suffix(".json")
        .tempfile_in(dir)
        .map_err(|e| format!("tempfile: {e}"))?;
    tmp.write_all(body.as_bytes())
        .map_err(|e| format!("write tempfile: {e}"))?;
    tmp.persist(path)
        .map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(())
}

fn record_dispatch(
    session_id: &str,
    provider_id: &str,
    prompt: &str,
    zones: &[String],
    depends_on: &[usize],
    a2a_task_id: Option<&str>,
) -> Option<usize> {
    let (path, mut value) = ensure_session(session_id)?;
    let now = now_secs();

    // Compute next task id from the existing tasks array.
    let next_id = value
        .get("tasks")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("id").and_then(|n| n.as_u64()))
                .max()
                .unwrap_or(0)
                + 1
        })
        .unwrap_or(1) as usize;

    // Resolve project_root from session.projects[0] when present.
    let project_root = value
        .pointer("/projects/0/root")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();

    let channel = format!("subagent-{session_id}-{next_id}");
    let task = json!({
        "id": next_id,
        "description": prompt,
        "agent_id": provider_id,
        "depends_on": depends_on,
        "status": "running",
        "project_root": project_root,
        "zones": zones,
        "blocked_reason": null,
        "output": "",
        "summary": null,
        "started_at": now,
        "completed_at": null,
        "stream_channel": channel,
        "worktree_path": null,
        "a2a_task_id": a2a_task_id,
    });

    if let Some(arr) = value.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        arr.push(task);
    } else {
        value["tasks"] = json!([task]);
    }

    let ribbon_entry = json!({
        "at": now,
        "event": {
            "kind": "task_dispatched",
            "task_id": next_id,
            "agent_id": provider_id,
            "channel": format!("subagent-{session_id}-{next_id}"),
        },
    });
    if let Some(arr) = value.get_mut("ribbon").and_then(|v| v.as_array_mut()) {
        arr.push(ribbon_entry);
    } else {
        value["ribbon"] = json!([ribbon_entry]);
    }
    value["status"] = json!("running");
    value["updated_at"] = json!(now);

    if write_session(&path, &value).is_err() {
        return None;
    }
    Some(next_id)
}

fn record_completion(session_id: &str, task_id: usize, exit_code: i32, output: &str) {
    // Re-read so we don't clobber chat turns / brain edits made between
    // dispatch and completion.
    let Some((path, mut value)) = read_session(session_id) else {
        return;
    };
    let now = now_secs();
    let success = exit_code == 0;

    if let Some(arr) = value.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        for t in arr.iter_mut() {
            if t.get("id").and_then(|n| n.as_u64()) == Some(task_id as u64) {
                t["status"] = json!(if success { "done" } else { "failed" });
                t["output"] = json!(truncate(output, 16_000));
                t["completed_at"] = json!(now);
                if success {
                    t["summary"] = json!(first_line(output, 240));
                }
            }
        }
    }
    let ribbon_entry = if success {
        json!({
            "at": now,
            "event": { "kind": "task_completed", "task_id": task_id, "exit_code": exit_code },
        })
    } else {
        json!({
            "at": now,
            "event": {
                "kind": "task_failed",
                "task_id": task_id,
                "error": format!("exit {exit_code}: {}", first_line(output, 200)),
            },
        })
    };
    if let Some(arr) = value.get_mut("ribbon").and_then(|v| v.as_array_mut()) {
        arr.push(ribbon_entry);
    } else {
        value["ribbon"] = json!([ribbon_entry]);
    }
    value["updated_at"] = json!(now);

    let _ = write_session(&path, &value);
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        let mut out = s[..max].to_string();
        out.push_str("\n\n…(truncated)");
        out
    }
}

fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        truncate(s.trim(), max)
    } else if line.len() > max {
        format!("{}…", &line[..max])
    } else {
        line.to_string()
    }
}
