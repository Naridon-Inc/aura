//! "Open this chat in <agent>" — bridge an Aura desktop chat back into a
//! real coding-agent CLI so the user can keep going from a terminal.
//!
//! The original feature was Claude-only; this generalizes it to every agent
//! the `aura_agents` registry knows, each handed off by its OWN session model.
//! Two honest tiers, chosen per agent:
//!
//!   * **True resume** — the agent has an on-disk, resumable session store and
//!     a resume command. We write (or locate) the conversation in that agent's
//!     NATIVE transcript format and hand back the id/path its resume command
//!     wants. The user lands in a terminal that genuinely continues the thread.
//!       - Claude: `~/.claude/projects/<slug>/<uuid>.jsonl` → `claude --resume <uuid>`
//!         (live Claude chats already have a real session on disk; mixed/native
//!         chats are SYNTHESIZED into that exact format).
//!       - Gemini: a native session JSON → `gemini --session-file <path>`
//!         (verified: `--session-file` loads the conversation directly, with no
//!         per-project store match needed).
//!       - Codex:  a native rollout JSONL under
//!         `~/.codex/sessions/<Y>/<M>/<D>/rollout-…-<uuid>.jsonl` → `codex resume <uuid>`
//!         (verified: codex locates the rollout by uuid and replays it).
//!
//!   * **Context-handoff seeding** — the agent has no resumable on-disk store
//!     we can author (its sessions are server-side / opaque, or unverifiable
//!     because the CLI isn't installed here). We render the conversation to a
//!     compact primer and hand it back as the agent's OPENING prompt, so it
//!     continues with full context. Labeled honestly as a handoff, never a
//!     resume. This is the universal fallback so EVERY known agent works.
//!       - Cursor, Kimi, OpenCode, Pi, and any community/TOML provider.
//!
//! Fidelity, never fabrication: user turns become user records, assistant
//! turns become assistant text records, and a turn's recorded tool calls
//! become a short bracketed text note (we never forge synthetic tool_use /
//! tool_result blocks with invented ids the agent would mis-thread).
//!
//! The single Tauri command is `chat_export_for_agent(agent_id, session_id)`.
//! `chat_export_to_claude_code(session_id)` stays as a thin back-compat wrapper
//! around the `claude` case so the original frontend path keeps working.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::cmd_claude_sessions::{encode_path, projects_root_dir};
use crate::manager::{persist, ChatRole, ChatTurn};

/// Result of preparing a Claude Code resume target for an Aura chat. Kept for
/// the original `chat_export_to_claude_code` command + `ClaudeExport` frontend
/// type — byte-for-byte the same shape as before generalization.
#[derive(Serialize, Clone, Debug)]
pub struct ClaudeExport {
    /// The Claude Code session id to resume (`claude --resume <session_id>`).
    pub session_id: String,
    /// Absolute working directory the session must be resumed FROM. Claude
    /// keys `--resume` resolution by launch cwd, so the terminal has to spawn
    /// here (the worktree the chat is bound to), not wherever the app happens
    /// to sit.
    pub cwd: String,
    /// Absolute path to the JSONL transcript Claude will resume. For a
    /// pre-existing live session this is the file Claude already wrote; for a
    /// synthesized one it's the file we just authored.
    pub jsonl_path: String,
    /// True when we synthesized the transcript from the Aura conversation.
    /// False when an existing real Claude session was surfaced as-is.
    pub synthesized: bool,
    /// True when the `claude` CLI is installed and on PATH.
    pub claude_installed: bool,
}

/// Result of preparing ANY agent's continuation target for an Aura chat.
/// Generalizes `ClaudeExport`: one shape the frontend uses to open the right
/// PTY for whichever agent the user picked.
#[derive(Serialize, Clone, Debug)]
pub struct AgentExport {
    /// Registry id the export was built for (`claude`, `gemini`, `codex`,
    /// `cursor`, `kimi`, …). Canonicalized through the registry.
    pub agent_id: String,
    /// Human label for the picked agent (`Claude Code`, `Gemini CLI`, …),
    /// straight from the provider so the UI never hard-codes names.
    pub label: String,
    /// `"resume"` when we wrote/located the conversation in this agent's native
    /// session format and the terminal will genuinely continue it.
    /// `"handoff"` when there's no resumable store and we seed the agent with a
    /// primer instead. The UI words the confirmation off this.
    pub mode: ExportMode,
    /// True when we serialized the Aura conversation into a fresh native
    /// transcript (vs surfacing a real on-disk session as-is). Always true for
    /// gemini/codex/handoff; false only for a live Claude chat with a real
    /// session already on disk. Carries the foundation's honesty distinction
    /// through to every agent.
    pub synthesized: bool,
    /// Absolute working directory the terminal must open in. For true-resume
    /// agents this is where the session is keyed/replayed from (worktree-
    /// correct); for handoff it's the chat's bound project root.
    pub cwd: String,
    /// For `mode == Resume`: the single argument to feed the agent's resume
    /// command via the PTY `resume_session_id` slot — a session id (claude
    /// uuid, codex uuid) or an absolute session-file path (gemini). The
    /// provider's `build_invocation(PtyRepl)` turns this into the right argv.
    /// `None` for handoff.
    pub resume_arg: Option<String>,
    /// For `mode == Handoff`: the compact primer to hand the agent as its
    /// opening prompt so it continues with the full conversation as context.
    /// `None` for resume.
    pub primer: Option<String>,
    /// Absolute path to the native transcript we authored, when one was
    /// written (resume agents). Useful for diagnostics / a future "reveal in
    /// Finder". `None` for handoff and for a surfaced-as-is live session.
    pub transcript_path: Option<String>,
    /// True when the agent's CLI binary is installed and on PATH. When false
    /// the caller still gets a valid target, but should explain the CLI isn't
    /// installed rather than spawn a doomed terminal.
    pub installed: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportMode {
    /// The terminal genuinely continues the conversation from the agent's own
    /// resumable session store.
    Resume,
    /// The terminal starts a fresh session seeded with a primer of the prior
    /// conversation — full context, but a new thread.
    Handoff,
}

/// Prepare a Claude Code resume target for an Aura chat session. Thin
/// back-compat wrapper over the generalized path so the original frontend
/// (`chatExportToClaudeCode`) keeps its exact contract + behavior.
#[tauri::command]
pub async fn chat_export_to_claude_code(session_id: String) -> Result<ClaudeExport, String> {
    crate::blocking::run(move || {
        let export = build_agent_export("claude", &session_id)?;
        Ok(ClaudeExport {
            session_id: export.resume_arg.clone().unwrap_or_default(),
            cwd: export.cwd,
            jsonl_path: export.transcript_path.unwrap_or_default(),
            synthesized: export.synthesized,
            claude_installed: export.installed,
        })
    })
    .await
}

/// Prepare a continuation target for an Aura chat in ANY registry agent.
///
/// `agent_id` is a registry id / alias (`claude`, `gemini`, `codex`, `cursor`,
/// `cc`, …). `session_id` is the Aura `ManagerSession` id. Returns enough for
/// the frontend to open the right PTY tab — either a `resume_arg` to feed the
/// agent's resume command, or a `primer` to seed a fresh session.
#[tauri::command]
pub async fn chat_export_for_agent(
    agent_id: String,
    session_id: String,
) -> Result<AgentExport, String> {
    crate::blocking::run(move || {
        build_agent_export(&agent_id, &session_id)
    })
    .await
}

/// Core builder shared by both commands. Loads the chat, resolves the agent in
/// the registry, then routes to the agent's native resume writer or the
/// universal handoff primer.
fn build_agent_export(agent_id: &str, session_id: &str) -> Result<AgentExport, String> {
    let reg = aura_agents::registry();
    let provider = reg
        .get(agent_id)
        .ok_or_else(|| format!("Unknown agent \"{agent_id}\" — it isn't in the agent registry."))?;
    let canonical = provider.id().to_string();
    let label = provider.label().to_string();
    let installed = provider.is_available();

    let session = persist::load(session_id)
        .map_err(|e| format!("load chat {session_id}: {e}"))?;

    // The chat's real working directory — the first bound project root. Resume
    // targets are keyed by this cwd, and synthesized transcripts land under its
    // slug. A project-less scratch chat has no folder to open an agent in.
    let cwd = session
        .projects
        .first()
        .map(|p| p.root.clone())
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| {
            "This chat isn't bound to a project, so there's no folder to open an agent in."
                .to_string()
        })?;

    let chat = &session.chat;
    if chat.iter().all(|t| t.text.trim().is_empty() && t.tool_calls.is_empty()) {
        return Err(format!(
            "This chat has no messages yet, so there's nothing to open in {label}."
        ));
    }

    match canonical.as_str() {
        // Claude — the original verified path. Surface a real on-disk session
        // verbatim, else synthesize one.
        "claude" => build_claude_export(&session, &cwd, &canonical, &label, installed),
        // Gemini — true resume via a native session JSON + `--session-file`.
        "gemini" => {
            let (path, written) = write_gemini_session(&cwd, chat)?;
            Ok(AgentExport {
                agent_id: canonical,
                label,
                mode: ExportMode::Resume,
                synthesized: written,
                cwd,
                resume_arg: Some(path.to_string_lossy().into_owned()),
                primer: None,
                transcript_path: Some(path.to_string_lossy().into_owned()),
                installed,
            })
        }
        // Codex — true resume via a native rollout JSONL + `codex resume <uuid>`.
        "codex" => {
            let (uuid, path) = write_codex_rollout(&cwd, chat)?;
            Ok(AgentExport {
                agent_id: canonical,
                label,
                mode: ExportMode::Resume,
                synthesized: true,
                cwd,
                resume_arg: Some(uuid),
                primer: None,
                transcript_path: Some(path.to_string_lossy().into_owned()),
                installed,
            })
        }
        // Everyone else — no on-disk store we can author (server-side / opaque
        // sessions, or an uninstalled CLI we can't verify). Seed a primer.
        _ => Ok(AgentExport {
            agent_id: canonical,
            label,
            mode: ExportMode::Handoff,
            synthesized: true,
            cwd,
            resume_arg: None,
            primer: Some(render_primer(chat)),
            transcript_path: None,
            installed,
        }),
    }
}

/// Build the Claude export — case 1 (real on-disk session) or case 2
/// (synthesize). Lifted verbatim from the original Claude-only command so its
/// verified behavior is preserved exactly.
fn build_claude_export(
    session: &crate::manager::ManagerSession,
    cwd: &str,
    canonical: &str,
    label: &str,
    installed: bool,
) -> Result<AgentExport, String> {
    // ── Case 1: a real Claude session already exists on disk ──────────────
    if let Some(existing) = session.cli_session_id.as_deref() {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            if let Some(path) = locate_existing_session(trimmed, cwd) {
                // Claude resolves `--resume <id>` by launch cwd, so we prefer
                // the cwd stamped into the transcript — a session born in a
                // sibling worktree then resumes verbatim. BUT a session born
                // outside any project (most often a `claude` run in the user's
                // HOME) records that non-project dir, and launching there
                // strands the agent somewhere it can't see the repo ("No git
                // here, /Users/<me> is not a repo"). When the recorded cwd
                // isn't a usable project dir, fall back to the chat's bound
                // project root so the agent always opens *in the project*.
                let resume_cwd = usable_resume_cwd(recorded_cwd(&path), cwd);
                return Ok(AgentExport {
                    agent_id: canonical.to_string(),
                    label: label.to_string(),
                    mode: ExportMode::Resume,
                    synthesized: false,
                    cwd: resume_cwd,
                    resume_arg: Some(trimmed.to_string()),
                    primer: None,
                    transcript_path: Some(path.to_string_lossy().into_owned()),
                    installed,
                });
            }
            // `cli_session_id` is set but the file is gone — fall through to
            // synthesis so the handoff still works rather than dead-ends.
        }
    }

    // ── Case 2: synthesize a resumable Claude transcript from the chat ────
    let new_uuid = Uuid::new_v4().to_string();
    let jsonl_path = write_synthetic_transcript(&new_uuid, cwd, &session.chat)?;
    Ok(AgentExport {
        agent_id: canonical.to_string(),
        label: label.to_string(),
        mode: ExportMode::Resume,
        synthesized: true,
        cwd: cwd.to_string(),
        resume_arg: Some(new_uuid),
        primer: None,
        transcript_path: Some(jsonl_path.to_string_lossy().into_owned()),
        installed,
    })
}

// ──────────────────────────────────────────────────────────────────────────
// Claude — synthetic JSONL transcript (verified path, unchanged behavior).
// ──────────────────────────────────────────────────────────────────────────

/// Find a Claude session JSONL by id. Claude scatters a project's sessions
/// across one dir per launch-cwd, so we can't assume the file sits under
/// `encode_path(cwd)`. Look there first (the common case), then sweep every
/// project dir for a `<id>.jsonl`. `None` when the session isn't on disk.
fn locate_existing_session(session_id: &str, cwd: &str) -> Option<PathBuf> {
    let projects_root = projects_root_dir()?;
    let direct = projects_root
        .join(encode_path(cwd))
        .join(format!("{session_id}.jsonl"));
    if direct.is_file() {
        return Some(direct);
    }
    let entries = fs::read_dir(&projects_root).ok()?;
    for dir_entry in entries.flatten() {
        let dir = dir_entry.path();
        if !dir.is_dir() {
            continue;
        }
        let candidate = dir.join(format!("{session_id}.jsonl"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The `cwd` recorded in the first transcript line that carries one — the
/// directory Claude actually launched from.
fn recorded_cwd(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            if !c.is_empty() && Path::new(c).is_dir() {
                return Some(c.to_string());
            }
        }
    }
    None
}

/// Choose the directory to launch `claude --resume` in. Prefer `recorded`
/// (the cwd stamped into the transcript) so a session born in a sibling
/// worktree resumes verbatim — Claude resolves `--resume` by launch cwd.
/// Fall back to `bound` (the chat's bound project root) when `recorded` is
/// absent or not a usable project dir, so a session recorded in the user's
/// HOME (or any non-repo path) never strands the agent outside the project.
fn usable_resume_cwd(recorded: Option<String>, bound: &str) -> String {
    if let Some(rc) = recorded {
        let trimmed = rc.trim();
        if is_resumable_dir(trimmed) {
            return trimmed.to_string();
        }
    }
    bound.to_string()
}

/// A recorded launch-cwd is reusable only if it's a real git work tree that
/// is neither the user's HOME nor the filesystem root. HOME and `/` are
/// "valid directories" yet wrong as an agent cwd — a coding agent launched
/// there can't see the project (the classic "Claude opens in /Users/<me>"
/// bug). Anything failing these checks routes the caller back to the bound
/// project root.
fn is_resumable_dir(dir: &str) -> bool {
    if dir.is_empty() {
        return false;
    }
    let path = Path::new(dir);
    if !path.is_dir() || path == Path::new("/") {
        return false;
    }
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() && path == Path::new(&home) {
            return false;
        }
    }
    crate::worktree::is_git_work_tree(dir)
}

/// Serialize an Aura chat into a valid Claude Code JSONL transcript and write
/// it under `~/.claude/projects/<slug>/<uuid>.jsonl`. Returns the path.
fn write_synthetic_transcript(
    session_id: &str,
    cwd: &str,
    chat: &[ChatTurn],
) -> Result<PathBuf, String> {
    let projects_root =
        projects_root_dir().ok_or_else(|| "HOME not set — can't locate ~/.claude".to_string())?;
    let dir = projects_root.join(encode_path(cwd));
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{session_id}.jsonl"));

    let version = cli_version("claude").unwrap_or_else(|| "2.1.0".to_string());
    let git_branch = current_git_branch(cwd);

    let mut lines: Vec<String> = Vec::new();
    let mut parent: Option<String> = None;

    for turn in chat {
        let text = turn.text.trim();
        if text.is_empty() && turn.tool_calls.is_empty() {
            continue;
        }
        let uuid = Uuid::new_v4().to_string();
        let ts = iso_timestamp(turn.at);

        let record = match turn.role {
            ChatRole::User => {
                json!({
                    "parentUuid": parent,
                    "isSidechain": false,
                    "type": "user",
                    "message": { "role": "user", "content": text },
                    "uuid": uuid,
                    "timestamp": ts,
                    "userType": "external",
                    "cwd": cwd,
                    "sessionId": session_id,
                    "version": version,
                    "gitBranch": git_branch,
                })
            }
            ChatRole::Manager | ChatRole::System => {
                let mut blocks: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                if let Some(note) = tool_activity_note(turn) {
                    blocks.push(json!({ "type": "text", "text": note }));
                }
                if blocks.is_empty() {
                    continue;
                }
                json!({
                    "parentUuid": parent,
                    "isSidechain": false,
                    "type": "assistant",
                    "message": { "role": "assistant", "content": blocks },
                    "uuid": uuid,
                    "timestamp": ts,
                    "userType": "external",
                    "cwd": cwd,
                    "sessionId": session_id,
                    "version": version,
                    "gitBranch": git_branch,
                })
            }
        };

        lines.push(
            serde_json::to_string(&record)
                .map_err(|e| format!("serialize transcript record: {e}"))?,
        );
        parent = Some(uuid);
    }

    if lines.is_empty() {
        return Err("This chat has no messages to carry into Claude Code.".to_string());
    }

    let body = format!("{}\n", lines.join("\n"));
    write_atomic(&dir, &path, session_id, body.as_bytes())?;
    Ok(path)
}

// ──────────────────────────────────────────────────────────────────────────
// Gemini — native session JSON, resumed via `gemini --session-file <path>`.
// Schema mirrors the files gemini itself writes under
// `~/.gemini/tmp/<projectHash>/chats/session-*.json`:
//   { sessionId, projectHash, startTime, lastUpdated, kind, summary, messages }
// with messages of type "user" (content = [{text}]) and "gemini"
// (content = "<string>"). Verified live: `--session-file` loads this directly
// and the model answers from the seeded context.
// ──────────────────────────────────────────────────────────────────────────

/// Write an Aura chat as a Gemini session JSON under Aura's own export dir
/// (`~/.aura/agent-handoff/gemini/`) and return its path. We keep it out of
/// gemini's real per-project store so we never collide with or corrupt a live
/// gemini session — `--session-file` loads any path, so the location is free.
/// The `bool` is always `true` (we always synthesize; gemini has no
/// Aura-side live session to surface as-is).
fn write_gemini_session(cwd: &str, chat: &[ChatTurn]) -> Result<(PathBuf, bool), String> {
    let dir = handoff_dir("gemini")?;
    let session_id = Uuid::new_v4().to_string();

    let mut messages: Vec<Value> = Vec::new();
    let mut summary = String::new();
    for turn in chat {
        let text = turn.text.trim();
        if text.is_empty() && turn.tool_calls.is_empty() {
            continue;
        }
        let id = Uuid::new_v4().to_string();
        let ts = iso_timestamp(turn.at);
        match turn.role {
            ChatRole::User => {
                if summary.is_empty() {
                    summary = truncate_summary(text);
                }
                messages.push(json!({
                    "id": id,
                    "timestamp": ts,
                    "type": "user",
                    "content": [ { "text": text } ],
                }));
            }
            ChatRole::Manager | ChatRole::System => {
                let body = compose_assistant_text(text, turn);
                if body.trim().is_empty() {
                    continue;
                }
                // Gemini's assistant ("gemini") record carries content as a
                // plain string, not a block array.
                messages.push(json!({
                    "id": id,
                    "timestamp": ts,
                    "type": "gemini",
                    "content": body,
                }));
            }
        }
    }

    if messages.is_empty() {
        return Err("This chat has no messages to carry into Gemini CLI.".to_string());
    }

    let now = iso_timestamp(0);
    let session = json!({
        "sessionId": session_id,
        // gemini ignores projectHash when a session is loaded via
        // --session-file (it reads the file directly), but real sessions carry
        // it, so we stamp a stable hash of the cwd to keep the file well-formed.
        "projectHash": cwd_hash(cwd),
        "startTime": now,
        "lastUpdated": now,
        "kind": "main",
        "summary": if summary.is_empty() { "Continued from Aura".to_string() } else { summary },
        "messages": messages,
    });

    let body = serde_json::to_string_pretty(&session)
        .map_err(|e| format!("serialize gemini session: {e}"))?;
    let path = dir.join(format!("session-{session_id}.json"));
    write_atomic(&dir, &path, &session_id, body.as_bytes())?;
    Ok((path, true))
}

// ──────────────────────────────────────────────────────────────────────────
// Codex — native rollout JSONL, resumed via `codex resume <uuid>`. Codex
// locates the rollout itself by uuid under
// `~/.codex/sessions/<Y>/<M>/<D>/rollout-<iso>-<uuid>.jsonl`, so we MUST write
// into that dated path with a matching `session_meta.payload.id`. Verified
// live: a synthetic rollout is picked up by `codex resume <uuid>` and the
// model answers from the seeded conversation.
// ──────────────────────────────────────────────────────────────────────────

/// Write an Aura chat as a Codex rollout JSONL under
/// `~/.codex/sessions/<Y>/<M>/<D>/` and return `(uuid, path)`. The uuid is what
/// `codex resume <uuid>` takes; codex finds the file by scanning that store.
fn write_codex_rollout(cwd: &str, chat: &[ChatTurn]) -> Result<(String, PathBuf), String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "HOME not set — can't locate ~/.codex".to_string())?;
    let uuid = Uuid::new_v4().to_string();
    let now = chrono::Utc::now();
    // Codex buckets sessions by UTC calendar date of creation.
    let day_dir = PathBuf::from(home)
        .join(".codex")
        .join("sessions")
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string())
        .join(now.format("%d").to_string());
    fs::create_dir_all(&day_dir).map_err(|e| format!("create {}: {e}", day_dir.display()))?;
    // Filename matches codex's own `rollout-<iso>-<uuid>.jsonl` convention
    // (colons in the time swapped for `-`, as codex writes them).
    let stamp = now.format("%Y-%m-%dT%H-%M-%S").to_string();
    let path = day_dir.join(format!("rollout-{stamp}-{uuid}.jsonl"));

    let cli_version = cli_version("codex").unwrap_or_else(|| "0.128.0".to_string());
    let meta_ts = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    let mut lines: Vec<String> = Vec::new();
    // session_meta — first record, carries the resumable id + cwd.
    lines.push(
        serde_json::to_string(&json!({
            "timestamp": meta_ts,
            "type": "session_meta",
            "payload": {
                "id": uuid,
                "timestamp": meta_ts,
                "cwd": cwd,
                "originator": "codex_exec",
                "cli_version": cli_version,
                "source": "exec",
                "model_provider": "openai",
            },
        }))
        .map_err(|e| format!("serialize codex meta: {e}"))?,
    );

    let mut any_message = false;
    for turn in chat {
        let text = turn.text.trim();
        if text.is_empty() && turn.tool_calls.is_empty() {
            continue;
        }
        let ts = iso_timestamp(turn.at);
        let record = match turn.role {
            ChatRole::User => json!({
                "timestamp": ts,
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [ { "type": "input_text", "text": text } ],
                },
            }),
            ChatRole::Manager | ChatRole::System => {
                let body = compose_assistant_text(text, turn);
                if body.trim().is_empty() {
                    continue;
                }
                json!({
                    "timestamp": ts,
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "content": [ { "type": "output_text", "text": body } ],
                    },
                })
            }
        };
        lines.push(
            serde_json::to_string(&record)
                .map_err(|e| format!("serialize codex record: {e}"))?,
        );
        any_message = true;
    }

    if !any_message {
        return Err("This chat has no messages to carry into Codex.".to_string());
    }

    let body = format!("{}\n", lines.join("\n"));
    write_atomic(&day_dir, &path, &uuid, body.as_bytes())?;
    Ok((uuid, path))
}

// ──────────────────────────────────────────────────────────────────────────
// Handoff primer — the universal fallback for agents with no resumable store.
// ──────────────────────────────────────────────────────────────────────────

/// Render the conversation as a compact, plain-text primer to hand a fresh
/// agent as its opening prompt. Honest framing ("continuing a conversation
/// from Aura"), one labeled line per turn, tool activity folded into a short
/// note — never forged tool calls. The agent reads this as the context and
/// picks the thread up.
fn render_primer(chat: &[ChatTurn]) -> String {
    let mut out = String::new();
    out.push_str(
        "You are continuing a conversation that was started in Aura. Below is the prior \
         exchange between the user (\"User\") and the previous assistant (\"Assistant\"). \
         Read it as context, then continue helping the user from where it left off.\n\n\
         ──────── prior conversation ────────\n",
    );
    for turn in chat {
        let text = turn.text.trim();
        if text.is_empty() && turn.tool_calls.is_empty() {
            continue;
        }
        match turn.role {
            ChatRole::User => {
                if !text.is_empty() {
                    out.push_str("\nUser: ");
                    out.push_str(text);
                    out.push('\n');
                }
            }
            ChatRole::Manager | ChatRole::System => {
                let body = compose_assistant_text(text, turn);
                if !body.trim().is_empty() {
                    out.push_str("\nAssistant: ");
                    out.push_str(body.trim());
                    out.push('\n');
                }
            }
        }
    }
    out.push_str(
        "\n──────── end of prior conversation ────────\n\n\
         Continue from here. If the user's last message was a question or request, answer it.",
    );
    out
}

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers.
// ──────────────────────────────────────────────────────────────────────────

/// Assistant turn text plus an honest tool-activity note (when the turn ran
/// tools), joined with a newline. Shared by the gemini / codex / primer
/// writers so tool activity is summarized identically everywhere.
fn compose_assistant_text(text: &str, turn: &ChatTurn) -> String {
    match tool_activity_note(turn) {
        Some(note) if text.is_empty() => note,
        Some(note) => format!("{text}\n{note}"),
        None => text.to_string(),
    }
}

/// A one-line, human-readable note summarizing a turn's tool calls, e.g.
/// `[Earlier in this Aura conversation I used these tools: Read, Edit, Bash]`.
/// `None` when the turn called no tools. Names only — never tool bodies.
fn tool_activity_note(turn: &ChatTurn) -> Option<String> {
    if turn.tool_calls.is_empty() {
        return None;
    }
    let mut names: Vec<&str> = Vec::new();
    for call in &turn.tool_calls {
        let n = call.name.trim();
        if !n.is_empty() && !names.contains(&n) {
            names.push(n);
        }
    }
    if names.is_empty() {
        return None;
    }
    Some(format!(
        "[Earlier in this Aura conversation I used these tools: {}]",
        names.join(", ")
    ))
}

/// Aura's own per-agent handoff export dir, `~/.aura/agent-handoff/<agent>/`.
/// Keeps authored session files out of each agent's real store so we never
/// collide with a live session.
fn handoff_dir(agent: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .ok_or_else(|| "HOME not set — can't locate ~/.aura".to_string())?;
    let dir = PathBuf::from(home)
        .join(".aura")
        .join("agent-handoff")
        .join(agent);
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Write `bytes` to `path` atomically (tmp file in the same dir + rename) so a
/// resume reading the file never sees a half-written transcript.
fn write_atomic(dir: &Path, path: &Path, stem: &str, bytes: &[u8]) -> Result<(), String> {
    let tmp = dir.join(format!(".tmp-{stem}"));
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        f.write_all(bytes)
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename to {}: {e}", path.display()))?;
    Ok(())
}

/// Format an Aura epoch-seconds timestamp as the ISO-8601 string the agents
/// stamp (`2026-06-20T14:07:00.000Z`). `0` → now.
fn iso_timestamp(at_secs: u64) -> String {
    let dt = if at_secs == 0 {
        chrono::Utc::now()
    } else {
        chrono::DateTime::from_timestamp(at_secs as i64, 0).unwrap_or_else(chrono::Utc::now)
    };
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `<bin> --version` leading version token, used to stamp synthesized records
/// realistically. `None` when the probe fails (caller falls back to a literal).
fn cli_version(bin: &str) -> Option<String> {
    let out = std::process::Command::new(bin).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.split_whitespace()
        .find(|tok| tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// The current git branch at `cwd`. Empty string when not a repo / git absent.
fn current_git_branch(cwd: &str) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .output();
    if let Ok(out) = out {
        if out.status.success() {
            return String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
    }
    String::new()
}

/// A stable hex hash of the cwd, used to fill gemini's `projectHash` field so
/// the authored session is well-formed. Not load-bearing for `--session-file`
/// (gemini reads the file directly) — just keeps the record realistic.
fn cwd_hash(cwd: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cwd.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// First user prompt, truncated for a session summary line.
fn truncate_summary(s: &str) -> String {
    let one_line = s.split('\n').next().unwrap_or("").trim();
    if one_line.chars().count() <= 80 {
        return one_line.to_string();
    }
    let mut out: String = one_line.chars().take(79).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ChatRole, ChatTurn, PersistedToolCall};
    use serde_json::Value;
    use std::sync::Mutex;

    /// These tests re-home `HOME` to a tempdir so the writers land under a
    /// throwaway `~/.claude` / `~/.codex` / `~/.aura`. `set_var` mutates a
    /// process-global, so they must not run concurrently — serialize them
    /// behind one lock (the rest of the test binary keeps running in parallel).
    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn user_turn(text: &str) -> ChatTurn {
        ChatTurn {
            role: ChatRole::User,
            text: text.into(),
            at: 1_750_000_000,
            answered_question: None,
            anchor: None,
            attachments: Vec::new(),
            brain: None,
            tool_calls: Vec::new(),
            thinking: None,
            saved_tokens: None,
            input_tokens: None,
            output_tokens: None,
            model: None,
            cost_usd: None,
            cost_estimated: None,
        }
    }

    fn asst_turn(text: &str, tools: Vec<&str>) -> ChatTurn {
        ChatTurn {
            role: ChatRole::Manager,
            text: text.into(),
            at: 1_750_000_060,
            answered_question: None,
            anchor: None,
            attachments: Vec::new(),
            brain: Some("anthropic_native".into()),
            tool_calls: tools
                .into_iter()
                .map(|n| PersistedToolCall {
                    tool_use_id: format!("t-{n}"),
                    name: n.into(),
                    input: Value::Null,
                    result: None,
                })
                .collect(),
            thinking: None,
            saved_tokens: None,
            input_tokens: None,
            output_tokens: None,
            model: None,
            cost_usd: None,
            cost_estimated: None,
        }
    }

    fn sample_chat() -> Vec<ChatTurn> {
        vec![
            user_turn("fix the auth bug"),
            asst_turn("Looked at the middleware.", vec!["Read", "Edit"]),
            user_turn("thanks, now add a test"),
        ]
    }

    /// The synthesized Claude transcript must parse line-by-line as JSON, chain
    /// parentUuid → uuid correctly, and carry the exact field set the Claude
    /// reader keys on, so `claude --resume` accepts it. (Preserved from the
    /// original Claude-only suite.)
    #[test]
    fn synthetic_transcript_is_valid_chained_jsonl() {
        let _guard = HOME_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", tmp.path()) };
        let cwd = tmp.path().to_string_lossy().into_owned();

        let path = write_synthetic_transcript("sess-1", &cwd, &sample_chat()).unwrap();
        assert!(path.is_file());
        assert!(path.to_string_lossy().contains(&encode_path(&cwd)));

        let raw = std::fs::read_to_string(&path).unwrap();
        let records: Vec<Value> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("each line is valid JSON"))
            .collect();
        assert_eq!(records.len(), 3, "one record per non-empty turn");

        assert!(records[0].get("parentUuid").unwrap().is_null());
        for w in records.windows(2) {
            let prev_uuid = w[0].get("uuid").and_then(Value::as_str).unwrap();
            let this_parent = w[1].get("parentUuid").and_then(Value::as_str).unwrap();
            assert_eq!(prev_uuid, this_parent, "parentUuid chains to prior uuid");
        }

        for r in &records {
            assert!(r.get("type").and_then(Value::as_str).is_some());
            assert!(r.get("uuid").and_then(Value::as_str).is_some());
            assert!(r.get("sessionId").and_then(Value::as_str) == Some("sess-1"));
            assert!(r.get("cwd").and_then(Value::as_str) == Some(cwd.as_str()));
            assert!(r.get("timestamp").and_then(Value::as_str).is_some());
            assert!(r.get("message").is_some());
        }

        assert_eq!(records[0].get("type").and_then(Value::as_str), Some("user"));
        assert!(records[0]
            .pointer("/message/content")
            .and_then(Value::as_str)
            .is_some());
        assert_eq!(
            records[1].get("type").and_then(Value::as_str),
            Some("assistant")
        );
        let blocks = records[1]
            .pointer("/message/content")
            .and_then(Value::as_array)
            .unwrap();
        assert_eq!(blocks.len(), 2, "prose block + tool-activity note block");
        assert!(blocks[1]
            .get("text")
            .and_then(Value::as_str)
            .unwrap()
            .contains("Read, Edit"));
    }

    #[test]
    fn iso_timestamp_round_shape() {
        let s = iso_timestamp(1_750_000_000);
        assert!(s.ends_with('Z'));
        assert!(s.contains('T'));
        assert_eq!(s.matches('-').count(), 2);
    }

    /// Gemini session JSON round-trips: it parses as JSON, carries the field
    /// set gemini's `--session-file` reader keys on, maps roles to user /
    /// gemini records, and lands under Aura's handoff dir.
    #[test]
    fn gemini_session_is_valid_and_well_shaped() {
        let _guard = HOME_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", tmp.path()) };
        let cwd = tmp.path().to_string_lossy().into_owned();

        let (path, written) = write_gemini_session(&cwd, &sample_chat()).unwrap();
        assert!(written);
        assert!(path.is_file());
        // Lands under ~/.aura/agent-handoff/gemini/, not gemini's real store.
        assert!(path.to_string_lossy().contains("agent-handoff/gemini"));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("session-"));

        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(v.get("sessionId").and_then(Value::as_str).is_some());
        assert!(v.get("projectHash").and_then(Value::as_str).is_some());
        assert!(v.get("startTime").and_then(Value::as_str).is_some());
        assert_eq!(v.get("kind").and_then(Value::as_str), Some("main"));
        // Summary seeds from the first user prompt.
        assert_eq!(
            v.get("summary").and_then(Value::as_str),
            Some("fix the auth bug")
        );

        let msgs = v.get("messages").and_then(Value::as_array).unwrap();
        assert_eq!(msgs.len(), 3, "one record per non-empty turn");
        // User record: type "user", content = [{text}].
        assert_eq!(msgs[0].get("type").and_then(Value::as_str), Some("user"));
        assert_eq!(
            msgs[0].pointer("/content/0/text").and_then(Value::as_str),
            Some("fix the auth bug")
        );
        // Assistant record: type "gemini", content = plain string, tool note folded in.
        assert_eq!(msgs[1].get("type").and_then(Value::as_str), Some("gemini"));
        let body = msgs[1].get("content").and_then(Value::as_str).unwrap();
        assert!(body.contains("Looked at the middleware."));
        assert!(body.contains("Read, Edit"), "tool note folded into text");
    }

    /// Codex rollout round-trips: every line is JSON, the first is
    /// session_meta with the resumable uuid + cwd, content records map roles to
    /// input_text / output_text, and the file lands under the dated
    /// ~/.codex/sessions/<Y>/<M>/<D>/ store with a uuid-bearing name.
    #[test]
    fn codex_rollout_is_valid_and_resumable_by_uuid() {
        let _guard = HOME_LOCK.lock().unwrap();
        let tmp = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("HOME", tmp.path()) };
        let cwd = tmp.path().to_string_lossy().into_owned();

        let (uuid, path) = write_codex_rollout(&cwd, &sample_chat()).unwrap();
        assert!(path.is_file());
        // Under ~/.codex/sessions/<Y>/<M>/<D>/, named rollout-…-<uuid>.jsonl.
        assert!(path.to_string_lossy().contains(".codex/sessions"));
        let fname = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(fname.starts_with("rollout-"));
        assert!(fname.contains(&uuid), "filename carries the resume uuid");

        let raw = std::fs::read_to_string(&path).unwrap();
        let records: Vec<Value> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("each codex line is valid JSON"))
            .collect();
        // meta + 3 message records.
        assert_eq!(records.len(), 4);

        // First record is session_meta carrying the resumable id == uuid + cwd.
        assert_eq!(
            records[0].get("type").and_then(Value::as_str),
            Some("session_meta")
        );
        assert_eq!(
            records[0].pointer("/payload/id").and_then(Value::as_str),
            Some(uuid.as_str())
        );
        assert_eq!(
            records[0].pointer("/payload/cwd").and_then(Value::as_str),
            Some(cwd.as_str())
        );

        // User record: response_item / message / role user / input_text.
        assert_eq!(
            records[1].get("type").and_then(Value::as_str),
            Some("response_item")
        );
        assert_eq!(
            records[1].pointer("/payload/role").and_then(Value::as_str),
            Some("user")
        );
        assert_eq!(
            records[1]
                .pointer("/payload/content/0/type")
                .and_then(Value::as_str),
            Some("input_text")
        );
        // Assistant record: output_text, with the tool note folded in.
        assert_eq!(
            records[2].pointer("/payload/role").and_then(Value::as_str),
            Some("assistant")
        );
        assert_eq!(
            records[2]
                .pointer("/payload/content/0/type")
                .and_then(Value::as_str),
            Some("output_text")
        );
        let asst_text = records[2]
            .pointer("/payload/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        assert!(asst_text.contains("Read, Edit"));
    }

    /// The handoff primer renders an honest, labeled, plain-text continuation
    /// of the conversation — user/assistant turns labeled, tool activity folded
    /// into a note, framed as a handoff (never claiming a resume).
    #[test]
    fn primer_is_honest_labeled_plain_text() {
        let primer = render_primer(&sample_chat());
        assert!(primer.contains("continuing a conversation that was started in Aura"));
        assert!(primer.contains("User: fix the auth bug"));
        assert!(primer.contains("Assistant: Looked at the middleware."));
        assert!(primer.contains("Read, Edit"), "tool activity summarized");
        assert!(primer.contains("User: thanks, now add a test"));
        // Honest: no forged tool_use ids / JSON.
        assert!(!primer.contains("tool_use"));
    }

    // ── resume-cwd selection — the "Claude opens in /Users/<me>" fix ──────

    fn git_init(dir: &std::path::Path) {
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(dir)
            .status()
            .expect("git init");
    }

    fn fresh_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aura_resume_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir
    }

    #[test]
    fn is_resumable_dir_rejects_root_empty_and_missing() {
        assert!(!is_resumable_dir(""));
        assert!(!is_resumable_dir("/"));
        assert!(!is_resumable_dir("/no/such/aura/resume/path"));
    }

    #[test]
    fn is_resumable_dir_accepts_a_git_work_tree() {
        let dir = fresh_dir("repo");
        git_init(&dir);
        assert!(is_resumable_dir(dir.to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_resumable_dir_rejects_a_real_nonrepo_dir() {
        let dir = fresh_dir("plain"); // created, never git-init'd
        assert!(!is_resumable_dir(dir.to_str().unwrap()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_resumable_dir_rejects_home_even_when_it_is_a_repo() {
        let _g = HOME_LOCK.lock().unwrap();
        let home = fresh_dir("home");
        git_init(&home); // HOME is a git tree, yet must still be rejected
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", &home);
        let rejected = !is_resumable_dir(home.to_str().unwrap());
        match prev {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
        assert!(rejected, "HOME must never be a resume cwd, even if it is a repo");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn usable_resume_cwd_falls_back_to_bound_when_unusable() {
        assert_eq!(usable_resume_cwd(None, "/bound/root"), "/bound/root");
        assert_eq!(usable_resume_cwd(Some("/".into()), "/bound/root"), "/bound/root");
        assert_eq!(
            usable_resume_cwd(Some("   ".into()), "/bound/root"),
            "/bound/root"
        );
    }

    #[test]
    fn usable_resume_cwd_keeps_a_real_worktree_trimmed() {
        let dir = fresh_dir("keep");
        git_init(&dir);
        let recorded = format!("  {}  ", dir.to_str().unwrap());
        assert_eq!(
            usable_resume_cwd(Some(recorded), "/bound/root"),
            dir.to_str().unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
