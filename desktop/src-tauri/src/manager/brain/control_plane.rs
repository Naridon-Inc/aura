//! Control-plane tools for the native brain chat loop — the half that makes
//! Aura a command centre rather than one repo's assistant.
//!
//! Everything in `native_tools` is scoped to the single `repo_root` the chat
//! was opened on: the board, the Pages, the atlas. That is correct for those
//! tools and wrong for the orchestrator itself. Aura is a *who*, not a
//! *where* — the user's actual question is usually "what is running, across
//! everything?", and answering it meant the model shelling out to `bash` and
//! guessing at paths, because it had no way to even enumerate the projects.
//!
//! So this module hands the brain the same control plane the app's own
//! surfaces read:
//!
//!   * **projects** — every workspace registered in `~/.aura/projects.json`,
//!     the union of what the user has opened (`cmd_projects`).
//!   * **worktrees** — the parallel copies of any project (`cmd_files`), which
//!     is where agent work actually happens.
//!   * **sessions** — Claude Code transcripts, unioned across every sibling
//!     worktree by `cmd_claude_sessions` so no run goes missing just because
//!     it was authored from another checkout.
//!   * **live agents** — who is running *right now*, from the Sentinel claim
//!     files every Aura-hooked CLI heartbeats into (`cmd_sentinel`). This is
//!     the engine-agnostic half: Claude, Gemini, Codex and Cursor all land
//!     here, and a transcript that stopped being written an hour ago does not.
//!   * **pull requests** — list, detail and CI state via `cmd_prs` (which
//!     drives `gh` under the hood).
//!
//! Every tool takes an OPTIONAL `project`. Omitted, it means "the one this
//! chat is open on" — and for the list tools, omitting it means *every*
//! project, which is the whole point: "any failing checks anywhere?" is one
//! tool call, not a loop the model has to invent. Supplied, it resolves by
//! label, by id, or by absolute path, so the model can use the same name the
//! user just said.
//!
//! Read tools here are unconditional. Tools that change something outside
//! this machine are deliberately NOT in this module — see `MUTATING` at the
//! bottom for what was left out and why.

use serde_json::{Value, json};

use crate::cmd_projects::{ProjectEntry, registered_projects};

/// Cap on one tool result fed back to the model. Matches `native_tools`'
/// budget — a fleet-wide sweep can be large, and the leading rows are the
/// ones actually reasoned over.
const MAX_RESULT_CHARS: usize = 16_000;

/// How many projects a fleet-wide sweep will touch in one call. Each one can
/// mean a `gh` round-trip, so an unbounded sweep over a 32-project registry
/// would stall the turn. The result says when this bit, so a truncated sweep
/// never reads as a complete one.
const MAX_FLEET_PROJECTS: usize = 12;

/// The tool names this module owns.
pub const TOOL_NAMES: &[&str] = &[
    "aura_projects_list",
    "aura_worktrees_list",
    "aura_sessions_list",
    "aura_session_read",
    "aura_agents_live",
    "aura_prs_list",
    "aura_pr_detail",
];

/// A heartbeat older than this means the agent stopped reporting. The CLI only
/// deletes a claim file when the *process* is gone, so a claim can outlive the
/// work by a long way; we treat pid-liveness as the truth and this as the
/// fallback for the platform where we can't check one.
const HEARTBEAT_STALE_SECS: i64 = 300;

/// True when `name` is one of the control-plane tools.
pub fn is_control_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Anthropic-format schemas for the control-plane tools.
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "aura_projects_list",
            "description": "List EVERY project the user has open in Aura — not just the one this chat was started on. Use this first whenever the question spans more than the current repo ('what's running?', 'any PRs waiting?', 'which project was I on?'), and to resolve a project the user names in passing into a real path. Returns each project's label, absolute root, and when it was last opened (newest first).",
            "input_schema": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "aura_worktrees_list",
            "description": "List a project's git worktrees — the parallel copies where agents do their work, each on its own branch. Omit `project` to sweep EVERY project at once (this is how you answer 'what am I working on?'). Returns path, branch, HEAD, whether it's the main checkout, and when that branch was last committed to.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path. Omit to sweep every project; pass 'current' for the one this chat is open on."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_sessions_list",
            "description": "List coding-agent sessions (Claude Code transcripts) for a project — including ones authored from a sibling worktree, so nothing is missed because it ran on another branch. This is how you see what work is ongoing or recent. Omit `project` to sweep every project. Returns each session's id, last prompt, turn and step counts, working directory, and last-modified time (newest first). Use `aura_session_read` to open one.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path. Omit to sweep every project; pass 'current' for the one this chat is open on."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max sessions to return per project (default 15)."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_session_read",
            "description": "Read the tail of one coding-agent session's transcript — what the agent actually did. Identify it by the `session_id` from `aura_sessions_list`. Returns the last N transcript events (prompts, assistant turns, tool calls) oldest→newest.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session id from aura_sessions_list." },
                    "project": { "type": "string", "description": "Project the session belongs to (label, id, or path). Omit to search every project." },
                    "limit": { "type": "integer", "description": "How many trailing transcript events to return (default 40)." }
                },
                "required": ["session_id"]
            }
        }),
        json!({
            "name": "aura_agents_live",
            "description": "Which coding agents are RUNNING RIGHT NOW — any engine, not just Claude Code (Gemini, Codex and Cursor register here too). Prefer this over `aura_sessions_list` whenever the user asks what is happening now ('what's running?', 'is anything still going?', 'who's touching that file?'); sessions are transcripts on disk and include finished work, this is live processes. Omit `project` to sweep every project. Returns each agent's engine, session id, pid, branch and worktree, how long since its last heartbeat, and which files and functions it currently holds claimed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path. Omit to sweep every project; pass 'current' for the one this chat is open on."
                    },
                    "include_stopped": {
                        "type": "boolean",
                        "description": "Also return agents whose process has exited but whose claim file is still on disk (default false)."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_prs_list",
            "description": "List open pull requests for a project, with CI state and Aura's own risk score where a review has been run. Omit `project` to sweep EVERY project — that is how you answer 'any PR needing me?' in one call. Returns number, title, author, branches, review decision, checks state, and size.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path. Omit to sweep every project; pass 'current' for the one this chat is open on."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_pr_detail",
            "description": "Full detail on one pull request — body, changed files, and every individual CI check with its state and logs link. Use after `aura_prs_list` to look into a specific PR, especially a failing one.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "number": { "type": "integer", "description": "PR number." },
                    "project": { "type": "string", "description": "Project the PR belongs to (label, id, or path). Omit for the project this chat is open on." }
                },
                "required": ["number"]
            }
        }),
    ]
}

/// Dispatch one control-plane tool. Returns `(result_text, is_error)` on the
/// same contract as `native_tools::execute_board_tool` — a bad argument comes
/// back as an error string the model can recover from, never a panic.
pub async fn execute(repo_root: &str, name: &str, input: &Value) -> (String, bool) {
    let (text, is_error) = match name {
        "aura_projects_list" => tool_projects_list().await,
        "aura_worktrees_list" => tool_worktrees_list(repo_root, input).await,
        "aura_sessions_list" => tool_sessions_list(repo_root, input).await,
        "aura_session_read" => tool_session_read(repo_root, input).await,
        "aura_agents_live" => tool_agents_live(repo_root, input).await,
        "aura_prs_list" => tool_prs_list(repo_root, input).await,
        "aura_pr_detail" => tool_pr_detail(repo_root, input).await,
        other => (format!("unknown control-plane tool: {other}"), true),
    };
    (truncate(&text, MAX_RESULT_CHARS), is_error)
}

// ── project resolution ─────────────────────────────────────────────────
//
// The model gets to name a project however the user did. We accept the
// registry label ("Naridon Mono"), the registry id ("p-3f2a…"), an absolute
// path, or the literal "current"/"this" for the chat's own root — and match
// labels case-insensitively, because the user's phrasing rarely matches the
// folder's capitalisation.

/// What a `project` argument resolved to.
///
/// Shared with `cloud_plane`: a project the user named in passing has to mean
/// the same directory whether they asked to *read* it or to move its work onto
/// a machine, so both go through one resolver rather than two that drift.
pub(super) struct Target {
    pub(super) label: String,
    pub(super) root: String,
}

fn norm_path(p: &str) -> String {
    if p.len() > 1 {
        p.trim_end_matches('/').to_string()
    } else {
        p.to_string()
    }
}

fn label_for(root: &str, projects: &[ProjectEntry]) -> String {
    projects
        .iter()
        .find(|p| norm_path(&p.root) == norm_path(root))
        .map(|p| p.label.clone())
        .unwrap_or_else(|| {
            std::path::Path::new(root)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(root)
                .to_string()
        })
}

/// Resolve the optional `project` argument to a single target.
///
/// `None`/"current" means the chat's own root. An unresolvable name is an
/// error naming what IS available, so the model can correct itself in one
/// step instead of guessing again.
pub(super) fn resolve_one(repo_root: &str, input: &Value) -> Result<Target, String> {
    let projects = registered_projects();
    let arg = input
        .get("project")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let wants_current = matches!(arg, None | Some("current") | Some("this"));
    if wants_current {
        if repo_root.is_empty() {
            return Err(
                "this chat isn't open on a project, so there is no \"current\" one — \
                 pass `project` explicitly (call aura_projects_list to see them)"
                    .to_string(),
            );
        }
        return Ok(Target {
            label: label_for(repo_root, &projects),
            root: repo_root.to_string(),
        });
    }

    let want = arg.unwrap_or_default();
    // Absolute path wins outright — it needs no registry entry, so a worktree
    // or a freshly cloned repo is addressable before it's ever been opened.
    if want.starts_with('/') {
        return Ok(Target {
            label: label_for(want, &projects),
            root: norm_path(want),
        });
    }
    let hit = projects
        .iter()
        .find(|p| p.id == want)
        .or_else(|| projects.iter().find(|p| p.label.eq_ignore_ascii_case(want)))
        // Last resort: a unique substring of the label, so "naridon" finds
        // "Naridon Mono". Ambiguity falls through to the error rather than
        // silently picking one.
        .or_else(|| {
            let lower = want.to_ascii_lowercase();
            let mut it = projects
                .iter()
                .filter(|p| p.label.to_ascii_lowercase().contains(&lower));
            match (it.next(), it.next()) {
                (Some(only), None) => Some(only),
                _ => None,
            }
        });
    match hit {
        Some(p) => Ok(Target {
            label: p.label.clone(),
            root: p.root.clone(),
        }),
        None => {
            let known = projects
                .iter()
                .map(|p| p.label.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!(
                "no project matching {want:?}. Known projects: {known}"
            ))
        }
    }
}

/// Resolve to the set of projects a sweep should cover: the one named, or
/// every registered project when `project` was omitted. The `bool` is whether
/// the fleet was capped.
fn resolve_many(repo_root: &str, input: &Value) -> Result<(Vec<Target>, bool), String> {
    let named = input
        .get("project")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if named.is_some() {
        return resolve_one(repo_root, input).map(|t| (vec![t], false));
    }
    let projects = registered_projects();
    if projects.is_empty() {
        // No registry yet — fall back to the chat's own root so a
        // single-project user still gets an answer.
        if repo_root.is_empty() {
            return Err("no projects are registered yet".to_string());
        }
        return Ok((
            vec![Target {
                label: label_for(repo_root, &[]),
                root: repo_root.to_string(),
            }],
            false,
        ));
    }
    let capped = projects.len() > MAX_FLEET_PROJECTS;
    let targets = projects
        .into_iter()
        .take(MAX_FLEET_PROJECTS)
        .map(|p| Target {
            label: p.label,
            root: p.root,
        })
        .collect();
    Ok((targets, capped))
}

/// The note appended to a capped sweep. Silence here would read as "that's
/// everything" when it isn't.
fn cap_note(capped: bool) -> Value {
    if capped {
        json!(format!(
            "swept the {MAX_FLEET_PROJECTS} most recently opened projects only — \
             name a project explicitly to reach the others"
        ))
    } else {
        Value::Null
    }
}

// ── projects ───────────────────────────────────────────────────────────

async fn tool_projects_list() -> (String, bool) {
    let projects = registered_projects();
    if projects.is_empty() {
        return ("No projects registered yet.".to_string(), false);
    }
    let rows: Vec<Value> = projects
        .iter()
        .map(|p| {
            json!({
                "label": p.label,
                "root": p.root,
                "id": p.id,
                "last_opened_at": p.last_opened_at,
            })
        })
        .collect();
    (
        json!({ "count": rows.len(), "projects": rows }).to_string(),
        false,
    )
}

// ── worktrees ──────────────────────────────────────────────────────────

async fn tool_worktrees_list(repo_root: &str, input: &Value) -> (String, bool) {
    let (targets, capped) = match resolve_many(repo_root, input) {
        Ok(v) => v,
        Err(e) => return (e, true),
    };
    let mut out: Vec<Value> = Vec::new();
    // Projects git refused to answer for. Kept apart from the empty ones and
    // reported as such: telling the user "no worktrees" when the truth is "I
    // couldn't look" is how a working checkout gets mistaken for a lost one.
    let mut unreadable: Vec<String> = Vec::new();
    for t in &targets {
        let trees = match crate::cmd_files::git_worktree_list(t.root.clone()).await {
            Ok(v) => v,
            Err(e) => {
                unreadable.push(format!("{} ({e})", t.label));
                continue;
            }
        };
        if trees.is_empty() {
            continue;
        }
        let rows: Vec<Value> = trees
            .iter()
            .map(|w| {
                json!({
                    "path": w.path,
                    "branch": w.branch,
                    "head": w.head,
                    "is_main": w.is_main,
                    "locked": w.locked,
                    "head_committed_at": w.head_committed_at,
                })
            })
            .collect();
        out.push(json!({ "project": t.label, "root": t.root, "worktrees": rows }));
    }
    if out.is_empty() {
        // Only claim "none" when every project actually answered.
        if !unreadable.is_empty() {
            return (
                format!("Could not list worktrees for: {}", unreadable.join("; ")),
                true,
            );
        }
        return ("No git worktrees found.".to_string(), false);
    }
    (
        json!({
            "projects": out,
            "unreadable": unreadable,
            "note": cap_note(capped)
        })
        .to_string(),
        false,
    )
}

// ── sessions ───────────────────────────────────────────────────────────

async fn tool_sessions_list(repo_root: &str, input: &Value) -> (String, bool) {
    let (targets, capped) = match resolve_many(repo_root, input) {
        Ok(v) => v,
        Err(e) => return (e, true),
    };
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(15)
        .clamp(1, 100) as usize;
    let mut out: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for t in &targets {
        let mut sessions = match crate::cmd_claude_sessions::claude_list_sessions(t.root.clone())
            .await
        {
            Ok(s) => s,
            // One unreadable project must not sink a fleet sweep — record it
            // and keep going.
            Err(e) => {
                out.push(json!({ "project": t.label, "root": t.root, "error": e }));
                continue;
            }
        };
        if sessions.is_empty() {
            continue;
        }
        sessions.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        sessions.truncate(limit);
        total += sessions.len();
        let rows: Vec<Value> = sessions
            .iter()
            .map(|s| {
                json!({
                    "session_id": s.session_id,
                    "last_prompt": s.last_prompt,
                    "first_prompt": s.first_prompt,
                    "turns": s.turn_count,
                    "steps": s.step_count,
                    "cwd": s.cwd,
                    "cwd_rel": s.cwd_rel,
                    "modified_at": s.mtime,
                })
            })
            .collect();
        out.push(json!({ "project": t.label, "root": t.root, "sessions": rows }));
    }
    if out.is_empty() {
        return ("No coding-agent sessions found.".to_string(), false);
    }
    (
        json!({ "session_count": total, "projects": out, "note": cap_note(capped) }).to_string(),
        false,
    )
}

async fn tool_session_read(repo_root: &str, input: &Value) -> (String, bool) {
    let Some(want) = input
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return ("session_id is required".to_string(), true);
    };
    let limit = input
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(40)
        .clamp(1, 200) as usize;

    // Find the transcript. A session id is unique across the machine, so a
    // named project just narrows the search; without one we sweep.
    let (targets, _) = match resolve_many(repo_root, input) {
        Ok(v) => v,
        Err(e) => return (e, true),
    };
    let mut found: Option<(String, String)> = None; // (file_path, project label)
    for t in &targets {
        let Ok(sessions) = crate::cmd_claude_sessions::claude_list_sessions(t.root.clone()).await
        else {
            continue;
        };
        if let Some(s) = sessions.iter().find(|s| s.session_id == want) {
            found = Some((s.file_path.clone(), t.label.clone()));
            break;
        }
    }
    let Some((file_path, project)) = found else {
        return (
            format!("no session {want:?} found — call aura_sessions_list first"),
            true,
        );
    };

    // `None`: the brain is reading somebody else's transcript to answer a
    // question about it, not about to tail it. Recording a read position here
    // would move the mark of whichever tab is live-tailing that same file, and
    // that tab would then skip everything up to where this read finished.
    match crate::cmd_claude_sessions::claude_load_session(file_path.clone(), limit, None).await {
        Ok(events) => {
            let rows: Vec<Value> = events
                .iter()
                .map(|e| serde_json::to_value(e).unwrap_or(Value::Null))
                .collect();
            (
                json!({
                    "session_id": want,
                    "project": project,
                    "file_path": file_path,
                    "event_count": rows.len(),
                    "events": rows,
                })
                .to_string(),
                false,
            )
        }
        Err(e) => (format!("could not read session {want}: {e}"), true),
    }
}

// ── live agents ────────────────────────────────────────────────────────
//
// `aura_sessions_list` answers "what has been worked on"; this answers "what
// is working". The two are genuinely different questions and the model was
// conflating them, because a transcript file looks identical whether the agent
// writing it is mid-turn or exited three hours ago.

/// Where the Sentinel claim files for `root` actually live.
///
/// Claims are written to the *shared* `.aura` (the CLI's `shared_aura_path`),
/// so every agent across every worktree of a repo lands in one directory —
/// that's what makes a fleet answer possible at all. A worktree's own `.aura`
/// has no `sentinel/` in it, so asking one directly returns an empty list and
/// the user hears "nothing is running" while three agents are mid-edit.
///
/// Pure path arithmetic, deliberately: this runs inside an async tool call and
/// shelling out to `git rev-parse` per project would put a subprocess on the
/// executor for every repo in a fleet sweep.
fn shared_root(root: &str) -> String {
    let dotgit = std::path::Path::new(root).join(".git");
    // A directory `.git` is the main checkout — already shared.
    let Ok(body) = std::fs::read_to_string(&dotgit) else {
        return root.to_string();
    };
    let Some(gitdir) = body
        .lines()
        .find_map(|l| l.trim().strip_prefix("gitdir:"))
        .map(|p| std::path::PathBuf::from(p.trim()))
    else {
        return root.to_string();
    };
    // `…/main/.git/worktrees/<name>` → `…/main/.git` → `…/main`.
    crate::cmd_capture::strip_worktrees(&gitdir)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string())
}

/// Is that pid still a live process? Mirrors the CLI's own liveness check
/// (`Sentinel::is_pid_alive`) so the app and the CLI never disagree about
/// whether an agent is running.
fn process_running(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    let mut sys = sysinfo::System::new();
    let target = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
    sys.process(target).is_some()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn tool_agents_live(repo_root: &str, input: &Value) -> (String, bool) {
    let (targets, capped) = match resolve_many(repo_root, input) {
        Ok(v) => v,
        Err(e) => return (e, true),
    };
    let include_stopped = input
        .get("include_stopped")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let now = now_secs();

    let mut out: Vec<Value> = Vec::new();
    let mut running_total = 0usize;
    // Several registered projects can share one shared root (a project opened
    // both at its main checkout and via a sibling path). Reading the same
    // claims directory twice would double-count every agent in the answer.
    let mut seen_roots: Vec<String> = Vec::new();
    for t in &targets {
        let shared = shared_root(&t.root);
        if seen_roots.iter().any(|r| norm_path(r) == norm_path(&shared)) {
            continue;
        }
        seen_roots.push(shared.clone());

        let Ok(agents) = crate::cmd_sentinel::sentinel_agents(shared).await else {
            continue;
        };
        let mut rows: Vec<Value> = Vec::new();
        for a in &agents {
            let running = process_running(a.pid);
            if running {
                running_total += 1;
            } else if !include_stopped {
                continue;
            }
            let age = now.saturating_sub(a.last_heartbeat);
            let claims: Vec<Value> = a
                .claims
                .iter()
                .map(|c| {
                    json!({
                        "file": c.file_path,
                        "function": c.function_name,
                        "claimed_at": c.claimed_at,
                    })
                })
                .collect();
            rows.push(json!({
                "engine": a.agent_id,
                "session_id": a.session_id,
                "pid": a.pid,
                "running": running,
                "branch": a.branch,
                "worktree": a.worktree,
                "heartbeat_age_secs": age,
                // A live process that stopped heartbeating is worth saying out
                // loud — it usually means the agent is blocked, not finished.
                "heartbeat_stale": running && age > HEARTBEAT_STALE_SECS,
                "holding": claims,
            }));
        }
        if rows.is_empty() {
            continue;
        }
        out.push(json!({ "project": t.label, "root": t.root, "agents": rows }));
    }
    if out.is_empty() {
        let msg = if include_stopped {
            "No coding agents have registered with Aura on these projects."
        } else {
            "No coding agents are running right now."
        };
        return (msg.to_string(), false);
    }
    (
        json!({
            "running_count": running_total,
            "projects": out,
            "note": cap_note(capped),
        })
        .to_string(),
        false,
    )
}

// ── pull requests ──────────────────────────────────────────────────────

async fn tool_prs_list(repo_root: &str, input: &Value) -> (String, bool) {
    let (targets, capped) = match resolve_many(repo_root, input) {
        Ok(v) => v,
        Err(e) => return (e, true),
    };
    let mut out: Vec<Value> = Vec::new();
    let mut total = 0usize;
    for t in &targets {
        // A project with no GitHub remote (or no `gh`) errors here. In a
        // fleet sweep that is ordinary, not a failure — skip it quietly
        // rather than filling the result with noise about local-only repos.
        let Ok(prs) = crate::cmd_prs::pr_list(t.root.clone()).await else {
            continue;
        };
        if prs.is_empty() {
            continue;
        }
        total += prs.len();
        let rows: Vec<Value> = prs
            .iter()
            .map(|p| {
                json!({
                    "number": p.number,
                    "title": p.title,
                    "state": p.state,
                    "author": p.author,
                    "head": p.head_ref,
                    "base": p.base_ref,
                    "draft": p.is_draft,
                    "additions": p.additions,
                    "deletions": p.deletions,
                    "review_decision": p.review_decision,
                    "checks": p.checks_state,
                    "aura_risk": p.aura_risk_label,
                    "updated_at": p.updated_at,
                    "url": p.url,
                })
            })
            .collect();
        out.push(json!({ "project": t.label, "root": t.root, "prs": rows }));
    }
    if out.is_empty() {
        return ("No open pull requests found.".to_string(), false);
    }
    (
        json!({ "pr_count": total, "projects": out, "note": cap_note(capped) }).to_string(),
        false,
    )
}

async fn tool_pr_detail(repo_root: &str, input: &Value) -> (String, bool) {
    let Some(number) = input.get("number").and_then(|v| v.as_u64()) else {
        return ("number is required".to_string(), true);
    };
    let target = match resolve_one(repo_root, input) {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let detail = match crate::cmd_prs::pr_detail(target.root.clone(), number).await {
        Ok(d) => d,
        Err(e) => return (format!("PR #{number} in {}: {e}", target.label), true),
    };
    // Checks are a separate call; a failure there shouldn't lose the detail
    // we already have, so it degrades to an empty list.
    let checks = crate::cmd_prs::pr_checks(target.root.clone(), number)
        .await
        .unwrap_or_default();
    let check_rows: Vec<Value> = checks
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "state": c.bucket,
                "workflow": c.workflow,
                "description": c.description,
                "url": c.url,
            })
        })
        .collect();
    (
        json!({
            "project": target.label,
            "pr": serde_json::to_value(&detail).unwrap_or(Value::Null),
            "checks": check_rows,
        })
        .to_string(),
        false,
    )
}

// ── deliberately not here ──────────────────────────────────────────────
//
// MUTATING: merging, approving, closing and commenting on a PR are all
// reachable from `cmd_prs`, and were left out of this pass on purpose. They
// act on GitHub — outside this machine, visible to other people, and in the
// case of a merge not undoable from here. The brain already has `bash`, so
// nothing is *blocked* by leaving them out; what would change is that the
// model could take an outward-facing action as a silent side effect of a
// read-shaped request like "check my PRs". Wiring them belongs with a
// confirmation card (the `ask_user` / `propose_plan` surface this loop
// already drives), not with the readers.

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max).collect();
    format!("{kept}\n… [truncated]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(label: &str, root: &str, id: &str) -> ProjectEntry {
        ProjectEntry {
            id: id.to_string(),
            label: label.to_string(),
            root: root.to_string(),
            last_opened_at: 0,
        }
    }

    #[test]
    fn control_tools_are_recognised() {
        assert!(is_control_tool("aura_prs_list"));
        assert!(!is_control_tool("aura_tasks_list"));
        assert!(!is_control_tool("bash"));
    }

    #[test]
    fn every_declared_tool_has_a_schema() {
        let schemas = tool_schemas();
        assert_eq!(schemas.len(), TOOL_NAMES.len());
        for name in TOOL_NAMES {
            assert!(
                schemas
                    .iter()
                    .any(|s| s.get("name").and_then(|v| v.as_str()) == Some(*name)),
                "no schema declared for {name}"
            );
        }
    }

    #[test]
    fn label_falls_back_to_the_directory_name() {
        let known = vec![entry("Naridon Mono", "/Users/x/Naridon Mono", "p-1")];
        assert_eq!(label_for("/Users/x/Naridon Mono", &known), "Naridon Mono");
        // Trailing slash must not defeat the match.
        assert_eq!(label_for("/Users/x/Naridon Mono/", &known), "Naridon Mono");
        // Unregistered path still gets a readable name.
        assert_eq!(label_for("/Users/x/other-repo", &known), "other-repo");
    }

    #[test]
    fn an_absolute_path_resolves_without_a_registry_entry() {
        let input = json!({ "project": "/Users/x/fresh-clone/" });
        let t = resolve_one("/Users/x/current", &input).expect("absolute path resolves");
        assert_eq!(t.root, "/Users/x/fresh-clone");
    }

    #[test]
    fn current_needs_a_root() {
        // No `project` and no chat root is the case that used to strand the
        // model; it must come back as a recoverable error, not a panic.
        let (msg, is_error) = match resolve_one("", &json!({})) {
            Ok(_) => (String::new(), false),
            Err(e) => (e, true),
        };
        assert!(is_error);
        assert!(msg.contains("aura_projects_list"), "got: {msg}");
    }

    #[test]
    fn current_resolves_to_the_chat_root() {
        let t = resolve_one("/Users/x/repo", &json!({ "project": "current" }))
            .expect("current resolves");
        assert_eq!(t.root, "/Users/x/repo");
        let t2 = resolve_one("/Users/x/repo", &json!({})).expect("omitted resolves");
        assert_eq!(t2.root, "/Users/x/repo");
    }

    #[test]
    fn a_plain_checkout_is_its_own_shared_root() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(".git")).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert_eq!(shared_root(&root), root);
        // A directory that isn't a git repo at all must not vanish either.
        let bare = tempfile::tempdir().unwrap();
        let bare_root = bare.path().to_string_lossy().to_string();
        assert_eq!(shared_root(&bare_root), bare_root);
    }

    #[test]
    fn shared_root_follows_a_worktree_to_the_main_checkout() {
        // This is the case that used to answer "nothing is running" while
        // agents were mid-edit: a worktree's own `.aura` holds no claims.
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let tree = tmp.path().join("wt");
        std::fs::create_dir_all(main.join(".git").join("worktrees").join("feat-x")).unwrap();
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(
            tree.join(".git"),
            format!("gitdir: {}\n", main.join(".git/worktrees/feat-x").display()),
        )
        .unwrap();
        assert_eq!(
            shared_root(&tree.to_string_lossy()),
            main.to_string_lossy().to_string()
        );
    }

    #[test]
    fn liveness_is_decided_by_the_process_not_the_claim_file() {
        // Our own pid is the one process we can assert about with certainty.
        assert!(process_running(std::process::id() as i64));
        assert!(!process_running(0));
        assert!(!process_running(-1));
        // Out of pid range entirely — must be false, not a panic.
        assert!(!process_running(i64::MAX));
    }

    #[test]
    fn cap_note_stays_silent_when_nothing_was_dropped() {
        assert_eq!(cap_note(false), Value::Null);
        assert!(cap_note(true).as_str().unwrap().contains("name a project"));
    }

    #[test]
    fn truncate_marks_what_it_cut() {
        let long = "x".repeat(MAX_RESULT_CHARS + 10);
        let out = truncate(&long, MAX_RESULT_CHARS);
        assert!(out.ends_with("… [truncated]"));
        assert_eq!(truncate("short", MAX_RESULT_CHARS), "short");
    }
}
