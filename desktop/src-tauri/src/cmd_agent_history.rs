//! Pre-roll history reader for resumed agent tabs.
//!
//! When the shell restarts and AgentSurface spawns a Claude/Gemini PTY
//! with `--resume`, the CLI loads prior context but doesn't replay turns
//! visually. This command reads the agent's own on-disk session
//! transcript and returns a flat list of role/text/ts turns so the
//! renderer can show a collapsible history pane ABOVE the live terminal.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::SystemTime;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug)]
pub struct PrerollTurn {
    pub role: String,
    pub text: String,
    pub ts: i64,
    /// Tool calls the assistant made on this turn, in emission order, each
    /// paired with its eventual `tool_result` (back-filled from the following
    /// user line that carried it). Empty for user turns and for assistant
    /// turns that called no tools. Carries the read/edit/run/command activity
    /// that otherwise vanished into the "gap" between two assistant messages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<crate::manager::PersistedToolCall>,
    /// Extended-thinking text the assistant emitted on this turn (Claude
    /// `thinking` blocks), joined. None when the turn had no reasoning blocks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

/// Read the prior conversation for a resumed agent session.
///
/// `agent_id` ∈ {"claude", "gemini"}; other agents return an empty list.
/// `session_id` is the agent's own session id (Claude's JSONL stem or
/// Gemini's session UUID). For Gemini, the special token "latest"
/// resolves to the most-recently-modified chat file under the project's
/// `~/.gemini/tmp/<dir>/chats/` directory.
#[tauri::command]
pub async fn agent_history_preroll(
    agent_id: String,
    repo_root: String,
    session_id: String,
) -> Result<Vec<PrerollTurn>, String> {
    crate::blocking::run(move || {
        read_agent_history(&agent_id, &repo_root, &session_id)
    })
    .await
}

/// Non-command transcript reader, shared by the `agent_history_preroll`
/// command (resumed-tab pre-roll pane) and `manager_import_agent_session`
/// (hydrating a native Aura chat from a Claude/Gemini session). `agent_id` ∈
/// {"claude", "gemini"}; anything else returns an empty list.
pub(crate) fn read_agent_history(
    agent_id: &str,
    repo_root: &str,
    session_id: &str,
) -> Result<Vec<PrerollTurn>, String> {
    let mut turns = match agent_id {
        "claude" => claude_preroll(repo_root, session_id)?,
        "gemini" => gemini_preroll(repo_root, session_id)?,
        _ => vec![],
    };
    scrub_brokered_secrets(repo_root, &mut turns);
    Ok(turns)
}

/// Take any brokered secret back out of a transcript before it becomes context.
///
/// This is the one path in the app where text an agent has already written comes
/// *back* as a prompt: the pre-roll pane replays it, and
/// `manager_import_agent_session` hydrates a native Aura chat from it. Nothing
/// puts a secret here — the values are handed to the CLI's process environment
/// and never to its input (`manager::brain::place_secrets`) — so this is the
/// second lock rather than the first. It exists because the two failures are not
/// symmetrical: a transcript nobody scrubbed is a token in a model's context
/// forever, and a scrub that never had anything to find costs one pass over a
/// few kilobytes.
fn scrub_brokered_secrets(repo_root: &str, turns: &mut [PrerollTurn]) {
    let held = crate::manager::brain::place_secrets::boot_here(repo_root);
    if held.is_empty() || turns.is_empty() {
        return;
    }
    for turn in turns.iter_mut() {
        turn.text = held.redact(&turn.text);
        if let Some(thinking) = turn.thinking.as_mut() {
            *thinking = held.redact(thinking);
        }
        for call in turn.tool_calls.iter_mut() {
            // The arguments a tool was given and what it printed back — where a
            // token would be if a CLI had ever been handed one, since a `bash`
            // call's input is a command line and its result is that command's
            // output.
            held.redact_json(&mut call.input);
            if let Some(result) = call.result.as_mut() {
                result.content = held.redact(&result.content);
            }
        }
    }
}

fn claude_preroll(repo_root: &str, session_id: &str) -> Result<Vec<PrerollTurn>, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "no HOME".to_string())?;
    let mut path = PathBuf::from(home);
    path.push(".claude");
    path.push("projects");
    path.push(crate::cmd_claude_sessions::encode_path(repo_root));
    path.push(format!("{session_id}.jsonl"));

    if !path.exists() {
        // Fallback: try same encoding but with a CWD child (Claude keys
        // by the launching cwd, not the workspace root). Iterate every
        // dir that starts with the encoded root and matches our session.
        let mut parent = PathBuf::from(std::env::var_os("HOME").unwrap());
        parent.push(".claude");
        parent.push("projects");
        if let Ok(entries) = fs::read_dir(&parent) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let candidate = p.join(format!("{session_id}.jsonl"));
                if candidate.exists() {
                    path = candidate;
                    break;
                }
            }
        }
    }

    if !path.exists() {
        return Ok(vec![]);
    }
    let file = fs::File::open(&path).map_err(|e| format!("open {path:?}: {e}"))?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let ts_ms = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_ts)
            .unwrap_or(0);
        match kind {
            "user" => {
                if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(origin) = v
                    .get("origin")
                    .and_then(|o| o.get("kind"))
                    .and_then(Value::as_str)
                {
                    if matches!(
                        origin,
                        "task-notification"
                            | "slash-command"
                            | "hook"
                            | "system-reminder"
                            | "queue-operation"
                    ) {
                        continue;
                    }
                }
                let content = v.get("message").and_then(|m| m.get("content"));
                if let Some(text) = content.and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() && !is_synthetic(trimmed) {
                        out.push(PrerollTurn {
                            role: "user".into(),
                            text: trimmed.to_string(),
                            ts: ts_ms,
                            tool_calls: Vec::new(),
                            thinking: None,
                        });
                    }
                } else if let Some(arr) = content.and_then(Value::as_array) {
                    // Array-form user line: a mix of `tool_result` blocks (the
                    // outputs of the PRIOR assistant turn's tool_use calls) and
                    // any plain `text` the user typed alongside. Back-fill each
                    // result into the tool_call it answers; surface the typed
                    // text (if any) as a normal user turn.
                    let mut typed = String::new();
                    for block in arr {
                        match block.get("type").and_then(Value::as_str) {
                            Some("tool_result") => {
                                if let Some(id) =
                                    block.get("tool_use_id").and_then(Value::as_str)
                                {
                                    let is_error = block
                                        .get("is_error")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false);
                                    let body = tool_result_text(block.get("content"));
                                    backfill_result(&mut out, id, is_error, body);
                                }
                            }
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    if !typed.is_empty() {
                                        typed.push_str("\n\n");
                                    }
                                    typed.push_str(t);
                                }
                            }
                            _ => {}
                        }
                    }
                    let trimmed = typed.trim();
                    if !trimmed.is_empty() && !is_synthetic(trimmed) {
                        out.push(PrerollTurn {
                            role: "user".into(),
                            text: trimmed.to_string(),
                            ts: ts_ms,
                            tool_calls: Vec::new(),
                            thinking: None,
                        });
                    }
                }
            }
            "assistant" => {
                let blocks = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array);
                if let Some(arr) = blocks {
                    let mut joined = String::new();
                    let mut thinking = String::new();
                    let mut tools: Vec<crate::manager::PersistedToolCall> = Vec::new();
                    for block in arr {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(Value::as_str) {
                                    if !joined.is_empty() {
                                        joined.push_str("\n\n");
                                    }
                                    joined.push_str(t);
                                }
                            }
                            Some("thinking") => {
                                // Claude extended-thinking block: the prose lives
                                // under `thinking` (the `signature` field is the
                                // cryptographic seal we don't surface).
                                if let Some(t) = block.get("thinking").and_then(Value::as_str)
                                {
                                    if !thinking.is_empty() {
                                        thinking.push_str("\n\n");
                                    }
                                    thinking.push_str(t);
                                }
                            }
                            Some("tool_use") => {
                                let id = block
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let name = block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool")
                                    .to_string();
                                let input = block
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(Value::Null);
                                tools.push(crate::manager::PersistedToolCall {
                                    tool_use_id: id,
                                    name,
                                    input,
                                    result: None,
                                });
                            }
                            _ => {}
                        }
                    }
                    let has_thinking = !thinking.trim().is_empty();
                    let has_text = !joined.trim().is_empty();
                    if has_text || has_thinking || !tools.is_empty() {
                        out.push(PrerollTurn {
                            role: "assistant".into(),
                            text: joined,
                            ts: ts_ms,
                            tool_calls: tools,
                            thinking: if has_thinking { Some(thinking) } else { None },
                        });
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn gemini_preroll(repo_root: &str, session_id: &str) -> Result<Vec<PrerollTurn>, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "no HOME".to_string())?;
    let mut tmp_root = PathBuf::from(home);
    tmp_root.push(".gemini");
    tmp_root.push("tmp");

    // Find the project dir whose .project_root matches repo_root.
    let project_dir = match find_gemini_project_dir(&tmp_root, repo_root) {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    let chats_dir = project_dir.join("chats");
    if !chats_dir.exists() {
        return Ok(vec![]);
    }

    // Resolve "latest" → newest JSONL by mtime.
    let target_file = if session_id == "latest" {
        let mut newest: Option<(SystemTime, PathBuf)> = None;
        for entry in fs::read_dir(&chats_dir).map_err(|e| format!("read {chats_dir:?}: {e}"))? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = entry.metadata().and_then(|m| m.modified()).ok();
            if let Some(t) = mtime {
                if newest.as_ref().map(|n| t > n.0).unwrap_or(true) {
                    newest = Some((t, p));
                }
            }
        }
        match newest {
            Some((_, p)) => p,
            None => return Ok(vec![]),
        }
    } else {
        // Gemini stores chats as `session-<ts>-<short>.jsonl` where
        // <short> is the first 8 chars of the session id. Match the
        // file whose internal `sessionId` field equals the request.
        let mut found: Option<PathBuf> = None;
        for entry in fs::read_dir(&chats_dir).map_err(|e| format!("read {chats_dir:?}: {e}"))? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if first_line(&p)
                .and_then(|v| v.get("sessionId").and_then(Value::as_str).map(str::to_string))
                .map(|sid| sid == session_id)
                .unwrap_or(false)
            {
                found = Some(p);
                break;
            }
        }
        match found {
            Some(p) => p,
            None => return Ok(vec![]),
        }
    };

    let file = fs::File::open(&target_file).map_err(|e| format!("open {target_file:?}: {e}"))?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines().map_while(Result::ok) {
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let ts_ms = v
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso_ts)
            .unwrap_or(0);
        match kind {
            "user" => {
                let parts = v.get("content").and_then(Value::as_array);
                if let Some(arr) = parts {
                    let mut joined = String::new();
                    for part in arr {
                        if let Some(t) = part.get("text").and_then(Value::as_str) {
                            if !joined.is_empty() {
                                joined.push('\n');
                            }
                            joined.push_str(t);
                        }
                    }
                    if !joined.trim().is_empty() {
                        out.push(PrerollTurn {
                            role: "user".into(),
                            text: joined,
                            ts: ts_ms,
                            tool_calls: Vec::new(),
                            thinking: None,
                        });
                    }
                }
            }
            "gemini" => {
                if let Some(t) = v.get("content").and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        out.push(PrerollTurn {
                            role: "assistant".into(),
                            text: t.to_string(),
                            ts: ts_ms,
                            tool_calls: Vec::new(),
                            thinking: None,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn find_gemini_project_dir(tmp_root: &PathBuf, repo_root: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(tmp_root).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let marker = dir.join(".project_root");
        if let Ok(bytes) = fs::read(&marker) {
            if let Ok(s) = std::str::from_utf8(&bytes) {
                if s.trim() == repo_root {
                    return Some(dir);
                }
            }
        }
    }
    None
}

fn first_line(path: &PathBuf) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    serde_json::from_str(&line).ok()
}

fn parse_iso_ts(s: &str) -> Option<i64> {
    // Minimal RFC3339 → epoch ms without pulling chrono into this
    // module — the caller only uses the value for ordering hints.
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Flatten a `tool_result` block's `content` into display text. Claude
/// writes it either as a bare string or as an array of `{type:"text",
/// text}` blocks (the same shape an assistant message uses). Non-text
/// blocks (rare image results) are skipped.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => {
            let mut out = String::new();
            for block in arr {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Back-fill a tool_result into the most recent matching tool_use call.
/// Claude emits `tool_use` on an assistant line and the answering
/// `tool_result` on the FOLLOWING user line, so we scan emitted turns in
/// reverse for the first still-unanswered call with this id. No match is a
/// no-op (orphaned result — e.g. the assistant turn was filtered out).
fn backfill_result(out: &mut [PrerollTurn], tool_use_id: &str, is_error: bool, content: String) {
    for turn in out.iter_mut().rev() {
        for call in turn.tool_calls.iter_mut() {
            if call.tool_use_id == tool_use_id && call.result.is_none() {
                call.result = Some(crate::manager::PersistedToolResult { is_error, content });
                return;
            }
        }
    }
}

fn is_synthetic(text: &str) -> bool {
    let lower = text.trim().to_lowercase();
    lower.starts_with("<command-name>")
        || lower.starts_with("<local-command-stdout>")
        || lower.starts_with("[request interrupted")
        || lower.starts_with("caveat:")
}
