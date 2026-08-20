//! Aura Manager — Tauri command surface + in-process runtime.
//!
//! `ManagerRuntime` is held as a Tauri State. It owns the tick loop +
//! per-session shared state (`Arc<Mutex<ManagerSession>>`). Agent
//! dispatches go through the `aura-agents` provider registry; results
//! stream back to the React side as `manager:<sid>` events.
//!
//! The loop ticks every 500ms or on a kick from any user action
//! (resume/override/complete_manual). `manager_start` only stages the
//! plan — actual agent spawning waits for `manager_resume`.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aura_agents::{InvokeMode, InvokeRequest, registry};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::cli_bridge::{BridgeRegistry, PlanDecision};
use crate::manager::{
    self, ChatRole, ChatTurn, ManagerSession, ManagerStatus, ManagerTask, ManagerTaskStatus,
    OverrideMode, PendingPlan, PendingQuestion, ProjectRef, RibbonEvent, brain, chat, persist,
    prompt, summarize_objective, team, tick, worktree,
};
use tauri::Manager as _;

/// Tracks the live state of a session — the JSON file is the source of
/// truth for cold loads, but while the runtime owns the session this
/// `Arc<Mutex>` is. `in_flight` mirrors `tick::compute_dispatches` so
/// re-tick doesn't double-spawn while children are still running.
pub(crate) struct LiveSession {
    pub(crate) state: Arc<Mutex<ManagerSession>>,
    in_flight: Arc<Mutex<HashMap<usize, String>>>,
    /// Send anything to wake the tick loop early.
    kick_tx: mpsc::UnboundedSender<()>,
}

pub struct ManagerRuntime {
    pub(crate) sessions: Mutex<HashMap<String, LiveSession>>,
    /// Held so `ensure_attached` can spawn a `loop_session` for sessions
    /// re-loaded from disk after a shell restart. Set in `setup` once the
    /// app is built; remains `None` until then so unit tests that build
    /// the runtime in isolation still work.
    app_handle: Mutex<Option<AppHandle>>,
    /// Session IDs we've already spawned a cloud-inbox poller for, so
    /// `ensure_cloud_inbox_poller` doesn't leak tasks if it's called
    /// multiple times for the same session.
    cloud_inbox_sessions: Mutex<std::collections::HashSet<String>>,
    /// Session IDs we've already attempted a transcript backfill for this
    /// process, so the startup sweep + a later resume don't double-upload
    /// (and don't race each other's cloud-empty check). See
    /// `ensure_transcript_backfilled`.
    transcript_backfilled: Mutex<std::collections::HashSet<String>>,
}

impl ManagerRuntime {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            app_handle: Mutex::new(None),
            cloud_inbox_sessions: Mutex::new(std::collections::HashSet::new()),
            transcript_backfilled: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Stash the AppHandle so disk-loaded sessions can spawn their own
    /// tick loops without an active Tauri command on the stack.
    pub fn set_app(&self, app: AppHandle) {
        *self.app_handle.lock().unwrap() = Some(app);
    }
}

// ── Snapshot DTOs ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManagerSummary {
    pub id: String,
    pub objective: String,
    pub status: ManagerStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub task_count: usize,
    pub done_count: usize,
    /// First project root this session is bound to, if any. Lets the
    /// history dropdown render where a session lives and lets callers
    /// scope the list to the open workspace.
    pub repo_root: Option<String>,
    /// The machine this conversation's hands are on, or `None` for this
    /// laptop. A list of chats about one project now spans several copies of
    /// it, so a row that can't say where it runs is a row you have to open to
    /// find out — and a surface that adopts one can't tell whether it belongs.
    pub machine_id: Option<String>,
}

impl From<&ManagerSession> for ManagerSummary {
    fn from(s: &ManagerSession) -> Self {
        let done = s
            .tasks
            .iter()
            .filter(|t| matches!(t.status, ManagerTaskStatus::Done | ManagerTaskStatus::Skipped))
            .count();
        ManagerSummary {
            id: s.id.clone(),
            objective: s.objective.clone(),
            status: s.status,
            created_at: s.created_at,
            updated_at: s.updated_at,
            task_count: s.tasks.len(),
            done_count: done,
            repo_root: s.projects.first().map(|p| p.root.clone()),
            machine_id: s.machine_id.clone(),
        }
    }
}

/// True when two filesystem paths name the same directory. Canonicalizes
/// both (resolving symlinks / `..`) when they exist on disk, falling back
/// to a trailing-slash-trimmed string compare so the check still works for
/// roots that have since moved. The workspace-scoping guard for
/// `manager_list` leans on this — a session only belongs to the open
/// workspace when one of its project roots matches the workspace root.
fn same_root(a: &str, b: &str) -> bool {
    let canon = |p: &str| std::fs::canonicalize(p).ok();
    match (canon(a), canon(b)) {
        (Some(ca), Some(cb)) => ca == cb,
        _ => a.trim_end_matches('/') == b.trim_end_matches('/'),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManagerStartArgs {
    pub objective: String,
    pub projects: Vec<ProjectRef>,
    pub tasks: Vec<ManagerTaskSpec>,
    /// Which connected machine this conversation's hands are on. Absent — the
    /// overwhelming default — is a chat about the code on this disk.
    #[serde(default)]
    pub machine_id: Option<String>,
}

/// User-facing task spec used by `manager_start`. Stripped down compared
/// to `ManagerTask` — the runtime fills in id, status, timestamps.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManagerTaskSpec {
    pub description: String,
    pub agent_id: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<usize>,
    pub project_root: String,
    #[serde(default)]
    pub zones: Vec<String>,
}

// ── Tauri commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn manager_start(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    args: ManagerStartArgs,
) -> Result<String, String> {
    start_session(&app, &runtime, args).await
}

/// Manager-from-picker entry point. The user picked "Aura Manager" in
/// the agent picker and sent a freeform prompt — there's no pre-decom-
/// posed task list yet. We stage a chat-only session in `AwaitingApproval`
/// with `objective = prompt` and an empty task list. Track B's
/// `manager_chat` command then routes follow-up messages: trivial
/// queries answered via `aura ask`, objective-style messages routed
/// through `aura plan_discover` to populate `tasks` and flip the
/// session to Running.
///
/// `machine_id` names a connected machine when this is a conversation about
/// code that lives over there. The brain still runs here — only its hands
/// reach across — so the session, its transcript and its board stay on this
/// laptop either way, and the two chats are the same chat.
///
/// `projects` is every project the conversation may be about. A chat used to be
/// born with exactly one, which is right for "the chat about this repo" and was
/// never right for Aura's own door: the control plane is about your projects,
/// plural, and one that carries a single root has to be told about the others
/// every time it is opened. `repo_root` still leads — it is the cwd the tools
/// run in, and every surface that reads `projects.first()` means it — so an
/// omitted or empty list is exactly the old behaviour.
#[tauri::command]
pub async fn manager_chat_start(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    repo_root: String,
    prompt: String,
    machine_id: Option<String>,
    projects: Option<Vec<String>>,
) -> Result<String, String> {
    let args = ManagerStartArgs {
        objective: prompt,
        projects: project_refs(&repo_root, projects.unwrap_or_default()),
        tasks: vec![],
        machine_id,
    };
    start_session(&app, &runtime, args).await
}

/// The session's projects, anchor first and no repeats.
///
/// Deduplicated on the same trailing-slash rule the rest of this file compares
/// roots with, because `/a/b` and `/a/b/` reaching the board as two projects
/// would push one conversation onto the cloud twice and list it twice beside
/// itself. Blank entries are dropped rather than becoming a project with no
/// name whose tools would run in the app's own launch directory.
fn project_refs(anchor: &str, extra: Vec<String>) -> Vec<ProjectRef> {
    let mut out: Vec<ProjectRef> = Vec::with_capacity(extra.len() + 1);
    for root in std::iter::once(anchor.to_string()).chain(extra) {
        let root = root.trim().to_string();
        if root.is_empty() {
            continue;
        }
        if out.iter().any(|p| same_root(&p.root, &root)) {
            continue;
        }
        out.push(ProjectRef {
            label: project_label(&root),
            root,
        });
    }
    out
}

/// Cross-agent continuity — resume a Claude Code / Gemini CLI conversation
/// inside the native Aura chat. Reads the agent's own on-disk transcript
/// (the same JSONL the resumed-PTY pre-roll reads), mints a fresh Aura chat
/// session, and hydrates its `chat` with the full prior history mapped to
/// `ChatTurn`s — assistant turns tagged with the agent's brain id so the
/// timeline paints the agent's real brand mark (Claude/Gemini) next to each
/// reply. The session is fully registered with the runtime (loop, cloud
/// inbox, kick channel) exactly like a freshly-typed chat, so the user can
/// keep the conversation going from where the CLI left off — now on any Aura
/// brain, with every message visible.
///
/// `agent_id` ∈ {"claude", "gemini"}; `agent_session_id` is the agent's own
/// session id (Claude's JSONL stem, or Gemini's UUID / the token "latest").
#[tauri::command]
pub async fn manager_import_agent_session(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    agent_id: String,
    repo_root: String,
    agent_session_id: String,
) -> Result<String, String> {
    let history_agent_id = agent_id.clone();
    let history_repo_root = repo_root.clone();
    let history_session_id = agent_session_id.clone();
    let turns = crate::blocking::run(move || {
        crate::cmd_agent_history::read_agent_history(
            &history_agent_id,
            &history_repo_root,
            &history_session_id,
        )
    })
    .await?;
    if turns.is_empty() {
        return Err(format!(
            "No {} transcript found for that session.",
            humanize_agent(&agent_id)
        ));
    }
    // Seed the objective off the first user prompt so the session reads
    // sensibly in lists / the header; fall back to a generic label. Done
    // against the FULL history, before the recent-window trim below, so a
    // long session still names itself from where it actually began.
    let objective = turns
        .iter()
        .find(|t| t.role == "user")
        .map(|t| summarize_objective(&t.text))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Resumed {} session", humanize_agent(&agent_id)));

    // Bound the import to a recent window. A long-running CLI session can
    // hold thousands of turns, each carrying tool activity; mapping +
    // persisting all of them, shipping the lot over IPC, and rendering them
    // as bubbles froze the whole app on resume. Keep the most recent slice —
    // the part the user is actually continuing — and surface an honest marker
    // for what was left out (never a silent truncation).
    const MAX_IMPORT_TURNS: usize = 400;
    let total = turns.len();
    let hidden = total.saturating_sub(MAX_IMPORT_TURNS);
    let turns: Vec<_> = if hidden > 0 {
        turns.into_iter().skip(hidden).collect()
    } else {
        turns
    };

    // Reuse the normal chat-start path so the session is registered with the
    // runtime identically to a typed chat — then hydrate `chat` in place.
    let project = ProjectRef {
        root: repo_root.clone(),
        label: project_label(&repo_root),
    };
    let args = ManagerStartArgs {
        objective,
        projects: vec![project],
        tasks: vec![],
        // An imported CLI transcript is a record of work that ran on this
        // laptop; continuing it continues here.
        machine_id: None,
    };
    let id = start_session(&app, &runtime, args).await?;

    let mut mapped = map_preroll_turns(turns, &agent_id);
    if hidden > 0 {
        // Prepend a calm note so the trim is visible, anchored just before the
        // earliest kept turn. Renders as an ordinary manager bubble.
        let first_at = mapped.first().map(|t| t.at).unwrap_or(0);
        mapped.insert(
            0,
            ChatTurn {
                role: ChatRole::Manager,
                text: format!(
                    "Earlier history trimmed — {hidden} older message{} from this {} session aren't shown here, so the chat stays responsive. The full transcript is still on disk in the CLI.",
                    if hidden == 1 { "" } else { "s" },
                    humanize_agent(&agent_id),
                ),
                at: first_at.saturating_sub(1),
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
            },
        );
    }
    let hydrated = if let Some(live) = runtime.sessions.lock().unwrap().get(&id) {
        let mut state = live.state.lock().unwrap();
        state.chat = mapped;
        // Leave status as `start_session` set it (AwaitingApproval) — the
        // same calm chat-only state `manager_chat_start` uses. The composer
        // still sends, `manager_chat` routes follow-ups, and the header dot
        // stays faint rather than pulsing "running" with nothing in flight.
        Some(state.clone())
    } else {
        None
    };
    if let Some(hydrated) = hydrated {
        let to_save = hydrated.clone();
        crate::blocking::run(move || persist::save(&to_save)).await?;
        let _ = app.emit(&format!("manager:{id}"), &hydrated);
    }
    Ok(id)
}

/// Fork an existing Aura chat at a given turn. Clones the conversation up to
/// and including `up_to_index` into a brand-new session so the user can branch
/// the thread (try a different direction, hand it to another brain, pull it
/// into its own window) without disturbing the original. The fork is a fully
/// runtime-registered chat-only session in the same calm AwaitingApproval
/// state as a typed chat; follow-ups route through `manager_chat` as usual.
#[tauri::command]
pub async fn manager_fork_session(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    up_to_index: usize,
) -> Result<String, String> {
    // Snapshot the source under its lock: objective, project list, and the
    // chat prefix through the chosen turn. Drop the guard before starting the
    // new session so there's no nested-lock hazard.
    let (objective, projects, machine_id, prefix) = {
        let sessions = runtime.sessions.lock().unwrap();
        let live = sessions
            .get(&session_id)
            .ok_or_else(|| format!("no session {session_id}"))?;
        let state = live.state.lock().unwrap();
        let end = up_to_index.saturating_add(1).min(state.chat.len());
        (
            state.objective.clone(),
            state.projects.clone(),
            // A fork of a conversation about a machine is still about that
            // machine. Dropping it would quietly move the branch home, where
            // the same questions have different answers.
            state.machine_id.clone(),
            state.chat[..end].to_vec(),
        )
    };
    if prefix.is_empty() {
        return Err("Nothing to fork — the conversation is empty.".into());
    }

    let args = ManagerStartArgs {
        objective,
        projects,
        tasks: vec![],
        machine_id,
    };
    let id = start_session(&app, &runtime, args).await?;
    let forked = if let Some(live) = runtime.sessions.lock().unwrap().get(&id) {
        let mut state = live.state.lock().unwrap();
        state.chat = prefix;
        Some(state.clone())
    } else {
        None
    };
    if let Some(forked) = forked {
        let to_save = forked.clone();
        crate::blocking::run(move || persist::save(&to_save)).await?;
        let _ = app.emit(&format!("manager:{id}"), &forked);
    }
    Ok(id)
}

/// Map an agent transcript's flat `PrerollTurn`s to native `ChatTurn`s,
/// preserving each turn's real timestamp (so the per-message elapsed stat
/// reads truthfully) and tagging assistant turns with the agent's brain id
/// (`cli:claude_code` / `cli:gemini`) so the provenance row shows the real
/// vendor mark.
// ── Import display caps (characters) ───────────────────────────────────
// A resumed Claude/Gemini session can carry tool outputs thousands of lines
// long — a `Read` of a whole file, a long `Bash` log, a `Write` whose input is
// an entire file body. Carried verbatim, a handful of those balloon the
// imported ManagerSession into a multi-megabyte blob: slow to clone + ship over
// IPC, and — rendered as un-virtualized chat bubbles — it freezes the chat the
// instant it opens (the symptom: a big CLI session stuck on "Loading…"). The
// existing 400-turn cap bounds the COUNT of turns but not their BYTES, which is
// why a tool-heavy session still hung. We keep the useful head of each field
// and replace the tail with an honest marker — never a silent truncation; the
// full transcript still lives in the CLI on disk.
const IMPORT_MAX_TURN_TEXT: usize = 8_000;
const IMPORT_MAX_THINKING: usize = 4_000;
const IMPORT_MAX_TOOL_INPUT: usize = 3_000;
const IMPORT_MAX_TOOL_RESULT: usize = 6_000;
// Absolute ceiling on the total characters carried across the whole import.
// Once crossed, later turns keep their (already per-field-capped) prose but shed
// heavy tool bodies to a one-line marker — so a session that is pathologically
// large in aggregate (hundreds of tool-heavy turns) still opens responsively.
const IMPORT_MAX_TOTAL: usize = 1_200_000;

/// Trim `s` to at most `max` characters, appending an honest marker when the
/// tail is dropped. Counts/takes by `char` so a multi-byte boundary is never
/// split. A no-op when already within budget.
fn trim_for_import(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    let omitted = count - max;
    format!(
        "{head}\n\n… {omitted} more character{} trimmed so the chat stays responsive — the full text is in the CLI transcript on disk.",
        if omitted == 1 { "" } else { "s" }
    )
}

/// Trim every string leaf in a tool call's JSON input to `max` chars. A `Write`
/// or `Edit` call can carry a whole file body in `input`; left whole it bloats
/// the import as much as a giant result does.
fn trim_value_for_import(v: &mut serde_json::Value, max: usize) {
    match v {
        serde_json::Value::String(s) => {
            if s.chars().count() > max {
                *s = trim_for_import(s, max);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                trim_value_for_import(item, max);
            }
        }
        serde_json::Value::Object(map) => {
            for (_k, val) in map.iter_mut() {
                trim_value_for_import(val, max);
            }
        }
        _ => {}
    }
}

fn map_preroll_turns(
    turns: Vec<crate::cmd_agent_history::PrerollTurn>,
    agent_id: &str,
) -> Vec<ChatTurn> {
    let brain_id = match agent_id {
        "gemini" => "cli:gemini",
        _ => "cli:claude_code",
    };
    let mut out = Vec::with_capacity(turns.len());
    // Running tally of characters carried so far. Heavy tool bodies are the
    // first thing shed once we cross the absolute ceiling (prose is kept — a
    // person's actual message is worse to mangle than a tool dump).
    let mut budget_used: usize = 0;
    for t in turns {
        let is_user = t.role == "user";

        let text = trim_for_import(&t.text, IMPORT_MAX_TURN_TEXT);
        budget_used += text.chars().count();

        let thinking = t.thinking.map(|s| {
            let trimmed = trim_for_import(&s, IMPORT_MAX_THINKING);
            budget_used += trimmed.chars().count();
            trimmed
        });

        let over_budget = budget_used > IMPORT_MAX_TOTAL;
        let mut tool_calls = t.tool_calls;
        for call in tool_calls.iter_mut() {
            if over_budget {
                // Past the ceiling: keep the call (so the card still shows WHAT
                // ran) but drop its heavy payloads to a one-line marker.
                call.input = serde_json::Value::String(
                    "(input hidden to keep the imported chat responsive — see the CLI transcript on disk)".to_string(),
                );
                if let Some(res) = call.result.as_mut() {
                    res.content =
                        "(output hidden to keep the imported chat responsive — see the CLI transcript on disk)".to_string();
                }
                continue;
            }
            trim_value_for_import(&mut call.input, IMPORT_MAX_TOOL_INPUT);
            budget_used += serde_json::to_string(&call.input)
                .map(|s| s.len())
                .unwrap_or(0);
            if let Some(res) = call.result.as_mut() {
                res.content = trim_for_import(&res.content, IMPORT_MAX_TOOL_RESULT);
                budget_used += res.content.chars().count();
            }
        }

        out.push(ChatTurn {
            role: if is_user {
                ChatRole::User
            } else {
                ChatRole::Manager
            },
            text,
            // PrerollTurn.ts is epoch MILLIS (parse_iso_ts →
            // timestamp_millis); ChatTurn.at is epoch SECONDS (now_secs).
            at: (t.ts.max(0) / 1000) as u64,
            answered_question: None,
            anchor: None,
            attachments: Vec::new(),
            brain: if is_user {
                None
            } else {
                Some(brain_id.to_string())
            },
            // Carry the transcript's tool activity and reasoning through so
            // the native chat renders the read/edit/run cards and thinking
            // whispers that lived between the assistant's prose turns —
            // otherwise the import shows text-then-gap-then-text.
            tool_calls,
            thinking,
            // No savings signal in an imported transcript — the estimate is
            // computed only when Aura's own native tools run a turn.
            saved_tokens: None,
            input_tokens: None,
            output_tokens: None,
            model: None,
            cost_usd: None,
            cost_estimated: None,
        });
    }
    out
}


/// Display name for the agents we can import history from.
fn humanize_agent(agent_id: &str) -> &'static str {
    match agent_id {
        "gemini" => "Gemini",
        "claude" => "Claude Code",
        _ => "agent",
    }
}

fn project_label(root: &str) -> String {
    root.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(root)
        .to_string()
}

async fn start_session(
    app: &AppHandle,
    runtime: &State<'_, ManagerRuntime>,
    args: ManagerStartArgs,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let tasks: Vec<ManagerTask> = args
        .tasks
        .into_iter()
        .enumerate()
        .map(|(i, spec)| ManagerTask {
            id: i + 1,
            description: spec.description,
            agent_id: spec.agent_id,
            depends_on: spec.depends_on,
            status: ManagerTaskStatus::Pending,
            project_root: spec.project_root,
            zones: spec.zones,
            blocked_reason: None,
            output: String::new(),
            summary: None,
            started_at: None,
            completed_at: None,
            stream_channel: None,
            worktree_path: None,
            a2a_task_id: None,
            pre_dispatch_snapshot_ids: Vec::new(),
            recent_output: Vec::new(),
            line_count: 0,
            pending_skill: None,
        })
        .collect();

    let mut session = ManagerSession::new(id.clone(), args.objective, args.projects, tasks);
    // Where this conversation's hands are. Set once, at birth, because a chat
    // that changed machines mid-thread would have half its transcript about
    // one copy of the code and half about another.
    session.machine_id = args.machine_id;
    let to_save = session.clone();
    crate::blocking::run(move || persist::save(&to_save)).await?;
    let _ = app.emit(&format!("manager:{id}"), &session);

    // Best-effort: surface this session to aura-cloud so paired mobile
    // + dashboard surfaces show it under Workspaces. One push per
    // project root the session touches — if multiple projects are
    // involved the cloud just ends up with one row per repo.
    for project in &session.projects {
        crate::cloud_session_sync::spawn_push(
            project.root.clone(),
            id.clone(),
            session.objective.clone(),
            "manager",
        );
    }
    // Start polling for inbound mobile turns so the user can hand off
    // mid-conversation between desktop and phone.
    runtime
        .cloud_inbox_sessions
        .lock()
        .unwrap()
        .insert(id.clone());
    crate::cloud_inbox::spawn_inbox_poller(app.clone(), id.clone());

    let (kick_tx, kick_rx) = mpsc::unbounded_channel();
    let live = LiveSession {
        state: Arc::new(Mutex::new(session)),
        in_flight: Arc::new(Mutex::new(HashMap::new())),
        kick_tx,
    };
    let state = live.state.clone();
    let in_flight = live.in_flight.clone();
    runtime
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), live);

    tauri::async_runtime::spawn(loop_session(app.clone(), id.clone(), state, in_flight, kick_rx));

    Ok(id)
}

#[tauri::command]
pub async fn manager_status(
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<ManagerSession, String> {
    load_session(&runtime, &session_id).await
}

/// Bucket O — Subagent monitor probe. Returns the most recent
/// stdout/stderr lines (cap 200) for an in-flight or completed task,
/// so the UI's expanded TaskCard can render them in xterm.js. Also
/// the same shape the MCP `aura_subagent_monitor` tool returns to the
/// Manager brain when it needs to check on a long-running fan-out.
#[tauri::command]
pub async fn manager_subagent_monitor(
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    task_id: usize,
) -> Result<crate::manager::SubagentMonitorView, String> {
    let session = load_session(&runtime, &session_id).await?;
    let task = session
        .task(task_id)
        .ok_or_else(|| format!("task {task_id} not found in session {session_id}"))?;
    Ok(crate::manager::SubagentMonitorView {
        task_id,
        line_count: task.line_count,
        recent: task.recent_output.clone(),
        status: task.status.clone(),
    })
}

/// Bucket M7 — Memory Health probe. Surfaces the working/anchored
/// turn counts, estimated tokens, budget consumption, and episode
/// digest count so `aura status --manager <id>` and the shell can
/// show "memory is healthy" rather than letting the user guess
/// whether the session is silently overflowing.
#[tauri::command]
pub async fn manager_memory_health(
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<crate::manager::tokens::MemoryHealth, String> {
    /// Same budget the brain sizes against. Keeping it in cmd_manager
    /// keeps the Tauri surface independent of brain.rs internals.
    const CHAT_BUDGET: u32 = 150_000;

    let session = load_session(&runtime, &session_id).await?;
    Ok(crate::manager::tokens::memory_health(&session.chat, CHAT_BUDGET))
}

/// List Aura chat sessions, newest first.
///
/// When `repo_root` is `Some`, the result is scoped to sessions bound to
/// that workspace — a session is included only when one of its project
/// roots is the same directory as `repo_root` (see [`same_root`]). This is
/// the workspace-isolation guarantee the `/resume` history dropdown relies
/// on: with the Mixrank workspace open you must never see — let alone be
/// able to resume into and touch — a New Git session. `None` returns every
/// session (used by global probes like the running-agents status pill).
#[tauri::command]
pub async fn manager_list(
    runtime: State<'_, ManagerRuntime>,
    repo_root: Option<String>,
) -> Result<Vec<ManagerSummary>, String> {
    // A session belongs to the workspace when any of its project roots is
    // the same directory as the requested root. Sessions with no projects
    // are workspace-agnostic scratch chats — excluded from a scoped list so
    // they can't leak across workspaces.
    let runtime_ids: Vec<String> = runtime.sessions.lock().unwrap().keys().cloned().collect();
    let mut live_sessions = Vec::new();
    for id in &runtime_ids {
        let live = {
            let lock = runtime.sessions.lock().unwrap();
            lock.get(id).map(|l| l.state.clone())
        };
        if let Some(state) = live {
            live_sessions.push(state.lock().unwrap().clone());
        }
    }
    crate::blocking::run(move || {
        let belongs = |s: &ManagerSession| -> bool {
            match &repo_root {
                None => true,
                Some(root) => s.projects.iter().any(|p| same_root(&p.root, root)),
            }
        };
        let mut summaries = Vec::new();
        for session in live_sessions {
            if belongs(&session) {
                summaries.push(ManagerSummary::from(&session));
            }
        }
        let in_runtime: std::collections::HashSet<String> = runtime_ids.into_iter().collect();
        for id in persist::list_session_ids() {
            if in_runtime.contains(&id) {
                continue;
            }
            if let Ok(session) = persist::load(&id) {
                if belongs(&session) {
                    summaries.push(ManagerSummary::from(&session));
                }
            }
        }
        summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(summaries)
    })
    .await
}

/// One global conversation-search result. Unlike `manager_list`, this scans
/// the persisted message bodies across every workspace, so Command Palette
/// can find an old discussion without first switching into its project.
#[derive(Debug, Clone, Serialize)]
pub struct ManagerSearchHit {
    pub session_id: String,
    pub objective: String,
    pub repo_root: Option<String>,
    pub role: String,
    pub snippet: String,
    pub turn_index: Option<usize>,
    pub updated_at: u64,
}

fn search_snippet(text: &str, query_lower: &str) -> Option<String> {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| line.to_lowercase().contains(query_lower))?;
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 220 {
        Some(collapsed)
    } else {
        Some(format!("{}…", collapsed.chars().take(219).collect::<String>()))
    }
}

fn session_search_hits(session: &ManagerSession, query_lower: &str) -> Vec<ManagerSearchHit> {
    let mut hits = Vec::new();
    let repo_root = session.projects.first().map(|project| project.root.clone());
    if let Some(snippet) = search_snippet(&session.objective, query_lower) {
        hits.push(ManagerSearchHit {
            session_id: session.id.clone(),
            objective: session.objective.clone(),
            repo_root: repo_root.clone(),
            role: "title".to_string(),
            snippet,
            turn_index: None,
            updated_at: session.updated_at,
        });
    }
    for (turn_index, turn) in session.chat.iter().enumerate().rev() {
        let Some(snippet) = search_snippet(&turn.text, query_lower) else {
            continue;
        };
        let role = match turn.role {
            ChatRole::User => "you",
            ChatRole::Manager => "assistant",
            ChatRole::System => "system",
        };
        hits.push(ManagerSearchHit {
            session_id: session.id.clone(),
            objective: session.objective.clone(),
            repo_root: repo_root.clone(),
            role: role.to_string(),
            snippet,
            turn_index: Some(turn_index),
            updated_at: session.updated_at,
        });
        // A few strong matches from one long chat are useful; hundreds are not.
        if hits.len() >= 4 {
            break;
        }
    }
    hits
}

/// Search all native Aura conversations, newest first. A two-character floor
/// avoids scanning the session archive for accidental single-key palette input.
#[tauri::command]
pub async fn manager_search(
    runtime: State<'_, ManagerRuntime>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<ManagerSearchHit>, String> {
    let query_lower = query.trim().to_lowercase();
    if query_lower.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(40).clamp(1, 100);
    let runtime_ids: std::collections::HashSet<String> =
        runtime.sessions.lock().unwrap().keys().cloned().collect();
    let live_sessions: Vec<ManagerSession> = runtime
        .sessions
        .lock()
        .unwrap()
        .values()
        .map(|live| live.state.lock().unwrap().clone())
        .collect();
    crate::blocking::run(move || {
        let mut sessions = live_sessions;
        for id in persist::list_session_ids() {
            if !runtime_ids.contains(&id) {
                if let Ok(session) = persist::load(&id) {
                    sessions.push(session);
                }
            }
        }
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut hits = Vec::new();
        for session in sessions {
            hits.extend(session_search_hits(&session, &query_lower));
            if hits.len() >= limit {
                break;
            }
        }
        hits.truncate(limit);
        Ok(hits)
    })
    .await
}

/// Replay a native Aura chat session as the same `StreamEvent` stream the
/// Trace transcript renderer consumes for Claude Code JSONL sessions.
///
/// Native manager sessions persist to `~/.aura/manager-sessions/<id>.json`
/// rather than a Claude JSONL, so they have no `file_path` for the
/// transcript pane to read. This maps each persisted `ChatTurn` into the
/// renderer's event shape: a user turn → `UserPrompt`; a Manager turn →
/// `AssistantText` plus one `ToolUse`/`ToolResult` pair per persisted
/// `tool_calls` entry (so the read/edit/run cards re-render exactly as the
/// JSONL path does). Turn ids are synthesised per turn so the renderer's
/// turn-grouping (prompt → tools → response) holds.
///
/// Loads from the live runtime when the session is attached (freshest
/// chat), else cold-loads off disk via [`persist::load`].
#[tauri::command]
pub async fn manager_load_transcript(
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<Vec<crate::cmd_agent_stream::StreamEvent>, String> {
    use crate::cmd_agent_stream::StreamEvent;

    let session = load_session(&runtime, &session_id).await?;

    let mut events: Vec<StreamEvent> = Vec::new();
    let mut turn_seq: u64 = 0;
    for turn in &session.chat {
        turn_seq += 1;
        let turn_id = format!("mgr-{turn_seq}");
        // ChatTurn.at is epoch SECONDS; UserPrompt.ts is epoch MILLIS.
        let ts = (turn.at as i64).saturating_mul(1000);
        match turn.role {
            ChatRole::User => {
                events.push(StreamEvent::UserPrompt {
                    text: turn.text.clone(),
                    turn_id: turn_id.clone(),
                    ts,
                });
            }
            ChatRole::Manager | ChatRole::System => {
                if !turn.text.trim().is_empty() {
                    events.push(StreamEvent::AssistantText {
                        text: turn.text.clone(),
                        turn_id: turn_id.clone(),
                    });
                }
                for call in &turn.tool_calls {
                    events.push(StreamEvent::ToolUse {
                        id: call.tool_use_id.clone(),
                        name: call.name.clone(),
                        input: call.input.clone(),
                        turn_id: turn_id.clone(),
                    });
                    if let Some(result) = &call.result {
                        events.push(StreamEvent::ToolResult {
                            tool_use_id: call.tool_use_id.clone(),
                            content: result.content.clone(),
                            is_error: result.is_error,
                            turn_id: turn_id.clone(),
                        });
                    }
                }
            }
        }
    }
    Ok(events)
}

/// Edit-class tool names whose `input` names a file the session mutated. The
/// native Aura brain itself only orchestrates (tasks / pages / atlas / ask), so
/// a pure-orchestrator chat edits nothing directly. But a CLI-wrapper brain
/// (`claude -p`, `gemini`) streams its real Edit/Write tool calls into the
/// session's persisted `tool_calls`, so for those the calls carry exactly the
/// paths the session touched. Matched case-insensitively on the bare name.
fn is_edit_tool(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "edit"
            | "write"
            | "multiedit"
            | "notebookedit"
            | "str_replace_editor"
            | "str_replace_based_edit_tool"
            | "create_file"
            | "write_file"
            | "edit_file"
            | "apply_patch"
            | "fs_write"
    )
}

/// Pull the file path an edit-tool call names, across the input shapes the
/// different CLI brains use. None when no recognizable path (the call is then
/// simply skipped — never guessed).
fn edit_tool_path(input: &serde_json::Value) -> Option<String> {
    for key in ["file_path", "path", "notebook_path", "filePath"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
    }
    None
}

/// Normalize a tool-reported path to an absolute path under `repo_root`
/// (CLI brains usually report absolute; relatives are joined). The diff
/// commands strip the repo prefix again, so absolute is the safe canonical form.
fn abs_under(repo_root: &str, p: &str) -> String {
    let path = std::path::Path::new(p);
    if path.is_absolute() {
        p.to_string()
    } else {
        std::path::Path::new(repo_root)
            .join(p)
            .to_string_lossy()
            .into_owned()
    }
}

/// The session's earliest per-turn baseline `tree_commit` — the working-tree
/// state from before any of the session's work. Every edited file diffs against
/// it. None for a pre-baseline-feature session (the changeset then falls back to
/// a plain `git diff HEAD` for each file, i.e. uncommitted-only).
fn earliest_session_baseline(repo_root: &str, session_id: &str) -> Option<String> {
    let dir = baseline_dir(repo_root, session_id);
    let mut best: Option<(usize, String)> = None;
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let Ok(idx) = stem.parse::<usize>() else {
            continue;
        };
        if best.as_ref().map(|(b, _)| idx >= *b).unwrap_or(false) {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(entry.path()) {
            if let Ok(baseline) = serde_json::from_str::<TurnBaseline>(&text) {
                let sha = baseline.tree_commit.trim().to_string();
                if !sha.is_empty() {
                    best = Some((idx, sha));
                }
            }
        }
    }
    best.map(|(_, sha)| sha)
}

/// Did `rel` exist in the tree of `base`? `git cat-file -e <base>:<rel>` — used
/// to classify a file as Added (absent before, present now) or Deleted (present
/// before, gone now) without trusting porcelain letters across an untracked path.
fn existed_in_base(repo_root: &str, base: &str, rel: &std::path::Path) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .arg("cat-file")
        .arg("-e")
        .arg(format!("{base}:{}", rel.display()))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Per-file change stats for the session changeset: the git-porcelain status
/// letter (`A`/`M`/`D`) plus added/deleted line counts, computed from the
/// baseline (or `HEAD` when there's no baseline) to the live working tree.
/// Counts are None for a binary file or a brand-new untracked path (numstat
/// can't see it) — honest absence, not a faked zero.
fn session_file_stats(
    repo_root: &str,
    base: Option<&str>,
    abs_path: &str,
) -> (String, Option<u64>, Option<u64>) {
    let cwd = std::path::Path::new(repo_root);
    let p = std::path::Path::new(abs_path);
    let rel = p.strip_prefix(cwd).unwrap_or(p);
    let base_ref = base.unwrap_or("HEAD");

    let (mut adds, mut dels) = (None, None);
    if let Ok(out) = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_root)
        .args(["diff", "--numstat", base_ref, "--"])
        .arg(rel)
        .output()
    {
        if out.status.success() {
            if let Some(line) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let mut it = line.split('\t');
                adds = it.next().and_then(|s| s.parse::<u64>().ok());
                dels = it.next().and_then(|s| s.parse::<u64>().ok());
            }
        }
    }

    let exists_now = p.exists();
    let existed_before = base.map(|b| existed_in_base(repo_root, b, rel)).unwrap_or(true);
    let status = if !existed_before && exists_now {
        "A"
    } else if existed_before && !exists_now {
        "D"
    } else {
        "M"
    };
    (status.to_string(), adds, dels)
}

/// Build the Changes-tab changeset for a native Aura chat session — the files
/// it edited directly and each file's net diff from the session's start.
///
/// Native chat doesn't commit; it edits the working tree and stamps per-turn
/// `tree_commit` baselines. So this gathers the paths the session's own
/// Edit/Write tool calls touched and stamps each with `base` = the earliest
/// baseline, which the diff view renders as `git diff <base> -- <path>` (the
/// file's whole change since the session began — correct whether still
/// uncommitted or later committed). An orchestrator-only session (one that
/// dispatched agents but never edited a file itself) returns an empty
/// changeset, which is honest: its changes live in the child agent sessions,
/// not here. Never errors — a git/IO hiccup just yields fewer files.
#[tauri::command]
pub async fn manager_session_changeset(
    runtime: State<'_, ManagerRuntime>,
    repo_root: String,
    session_id: String,
) -> Result<crate::cmd_aura::IntentChangeset, String> {
    use crate::cmd_aura::{IntentChangeset, IntentChangesetFile};

    let session = load_session(&runtime, &session_id).await?;

    // Distinct edited paths in first-touch order.
    let mut seen = std::collections::HashSet::new();
    let mut paths: Vec<String> = Vec::new();
    for turn in &session.chat {
        for call in &turn.tool_calls {
            if !is_edit_tool(&call.name) {
                continue;
            }
            if let Some(p) = edit_tool_path(&call.input) {
                let abs = abs_under(&repo_root, &p);
                if seen.insert(abs.clone()) {
                    paths.push(abs);
                }
            }
        }
    }
    if paths.is_empty() {
        return Ok(IntentChangeset::default());
    }

    crate::blocking::run(move || {
        let base = earliest_session_baseline(&repo_root, &session_id);
        let mut files = Vec::with_capacity(paths.len());
        for abs in paths {
            // Stats need the absolute path (the `.exists()` Added/Deleted probe is
            // CWD-independent only when absolute), but the changeset stores a
            // repo-relative path to match the intent-log changesets the Changes
            // tree + diff view already render (`src/lib/x.ts`, not the full abs).
            let (status, additions, deletions) =
                session_file_stats(&repo_root, base.as_deref(), &abs);
            // A no-op edit (wrote identical bytes) leaves nothing to show; skip it
            // so the Changes count reflects real change, not tool invocations.
            if status == "M" && additions.unwrap_or(0) == 0 && deletions.unwrap_or(0) == 0 {
                continue;
            }
            let rel = std::path::Path::new(&abs)
                .strip_prefix(&repo_root)
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_else(|_| abs.clone());
            files.push(IntentChangesetFile {
                path: rel,
                status,
                additions,
                deletions,
                symbols: Vec::new(),
                commit: None,
                base: base.clone(),
                remote_only: false,
            });
        }
        Ok(IntentChangeset {
            files,
            block_id: None,
            source: Some("manager_session".into()),
            captured_at: None,
        })
    })
    .await
}

#[tauri::command]
pub async fn manager_resume(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| {
        s.status = ManagerStatus::Running;
        s.push_ribbon(RibbonEvent::Resumed);
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn manager_pause(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| {
        s.status = ManagerStatus::Paused;
        s.push_ribbon(RibbonEvent::Paused);
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn manager_cancel(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| {
        s.status = ManagerStatus::Cancelled;
        s.push_ribbon(RibbonEvent::Cancelled);
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    // Drop the live entry; the loop sees Cancelled status and exits.
    runtime.sessions.lock().unwrap().remove(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn manager_override(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    task_id: usize,
    mode: OverrideMode,
    agent_id: Option<String>,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| {
        if let Some(t) = s.task_mut(task_id) {
            match mode {
                OverrideMode::Skip => t.status = ManagerTaskStatus::Skipped,
                OverrideMode::Rerun => {
                    t.status = ManagerTaskStatus::Pending;
                    t.output.clear();
                    t.summary = None;
                    t.started_at = None;
                    t.completed_at = None;
                    t.blocked_reason = None;
                }
                OverrideMode::Reassign => {
                    if let Some(new_agent) = &agent_id {
                        t.agent_id = Some(new_agent.clone());
                    }
                    t.status = ManagerTaskStatus::Pending;
                }
                OverrideMode::TakeOver => {
                    t.status = ManagerTaskStatus::ManualPending;
                }
            }
        }
        s.push_ribbon(RibbonEvent::ManualOverride { task_id, mode });
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn manager_complete_manual(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    task_id: usize,
    output: String,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| {
        if let Some(t) = s.task_mut(task_id) {
            t.status = ManagerTaskStatus::Done;
            // Truncate the user-supplied summary. Anything richer would
            // need an LLM call we don't run from this path.
            let summary = output.lines().take(3).collect::<Vec<_>>().join(" ").chars().take(400).collect::<String>();
            t.output = output;
            t.summary = Some(summary);
            t.completed_at = Some(now_secs());
        }
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

/// Bucket F2 — record the user's thumbs vote on a terminal task.
///
/// Mutates `pending_skill.user_rating` in place. Writing the row to
/// `~/.aura/agent_skills.json` is deferred to the brain self-eval
/// grader (Bucket F5) which runs after the task completes; this
/// handler only records the signal so the grader sees it when it
/// finalizes. Callable repeatedly to flip the vote — last write wins.
///
/// Returns `Ok(())` even when the task hasn't terminated; the rating
/// silently no-ops in that case so the UI can't accidentally mark a
/// running task. Returns `Err` only when the rating is out-of-range
/// (`-1` and `+1` are the only valid values).
#[tauri::command]
pub async fn manager_rate_task(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    task_id: usize,
    rating: i8,
) -> Result<(), String> {
    if rating != -1 && rating != 1 {
        return Err(format!("rating must be -1 or +1, got {rating}"));
    }
    mutate(&runtime, &session_id, |s| {
        if let Some(t) = s.task_mut(task_id) {
            // Only terminal tasks can be rated. Pending/Running tasks
            // skip silently — UI shouldn't render the buttons in those
            // states but we double-check so a stale frontend can't
            // poison a row mid-flight.
            if !matches!(
                t.status,
                ManagerTaskStatus::Done
                    | ManagerTaskStatus::Failed
                    | ManagerTaskStatus::Skipped,
            ) {
                return;
            }
            if let Some(skill) = t.pending_skill.as_mut() {
                skill.user_rating = Some(rating);
            }
        }
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

/// Bucket G3 — user clicked the SkillBadge dropdown on a PlanCard
/// todo and picked a different provider (or accepted the suggestion
/// explicitly). We mutate the pending plan's todo in place. The
/// Build-time mint will read the override so the spawned subagent
/// uses `agent_kind=<override>`. The plan must still be pending; if
/// the user already clicked Build the override is a no-op (we silently
/// drop it rather than error so a stale frontend doesn't surface a
/// confusing toast).
#[tauri::command]
pub async fn manager_override_todo_agent(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    plan_id: String,
    todo_idx: usize,
    agent_id: String,
) -> Result<(), String> {
    if agent_id.trim().is_empty() {
        return Err("agent_id required".into());
    }
    mutate(&runtime, &session_id, |s| {
        if let Some(plan) = s.pending_plan.as_mut() {
            if plan.id != plan_id {
                return;
            }
            if let Some(todo) = plan.todos.get_mut(todo_idx) {
                todo.agent = Some(agent_id.clone());
            }
        }
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

/// Append a chat turn (user message or Manager narration) to the
/// session. Frontend uses this to record the user's prompt before
/// running `aura plan` / `aura ask`, and to push the Manager's
/// narration after.
#[tauri::command]
pub async fn manager_append_chat(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    role: ChatRole,
    text: String,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| chat::append(s, role, text.clone())).await?;
    save_and_kick(&app, &runtime, &session_id).await;
    ensure_cloud_session_pushed(&runtime, &session_id);
    ensure_cloud_inbox_poller(&app, &runtime, &session_id);
    crate::cloud_session_sync::spawn_push_message(
        session_id.clone(),
        chat_role_label(role),
        text,
    );
    Ok(())
}

/// Stringify ChatRole for the cloud / mobile transport. The cloud
/// stores the role verbatim so other clients can render it without
/// needing to know our internal enum.
fn chat_role_label(role: ChatRole) -> &'static str {
    match role {
        ChatRole::User => "user",
        ChatRole::Manager => "manager",
        ChatRole::System => "system",
    }
}

/// Make sure the cloud has a `sessions` row for this session before we
/// push a chat turn against it. Idempotent — the cloud upserts by
/// `(repo_id, external_id)` so re-firing on every chat is cheap.
///
/// Needed because the original `spawn_push` fires once at `start_session`,
/// so sessions that pre-date the cloud-push code never get registered
/// and their `spawn_push_message` calls 404. Calling this on every chat
/// turn closes that gap without requiring a shell restart.
fn ensure_cloud_session_pushed(runtime: &ManagerRuntime, session_id: &str) {
    let snapshot = {
        let lock = runtime.sessions.lock().unwrap();
        lock.get(session_id).map(|live| {
            let s = live.state.lock().unwrap();
            (s.objective.clone(), s.projects.clone())
        })
    };
    if let Some((objective, projects)) = snapshot {
        for project in &projects {
            crate::cloud_session_sync::spawn_push(
                project.root.clone(),
                session_id.to_string(),
                objective.clone(),
                "manager",
            );
        }
    }
}

/// Fire a one-time (per process) transcript backfill for a session. Snapshots
/// the chat — from the live runtime if attached, else cold-loaded from disk —
/// and hands it to the cloud sync, which uploads it only when the cloud has no
/// messages for the session yet. This is what makes a session's *earlier* turns
/// (authored before the live-push code, or while signed out) reach a paired
/// phone that would otherwise show "No transcript synced yet".
///
/// Guarded by `transcript_backfilled` so the startup sweep, a later resume, and
/// any other trigger collapse to a single attempt — which also keeps two
/// triggers from racing the cloud-empty check and double-uploading.
fn ensure_transcript_backfilled(runtime: &ManagerRuntime, session_id: &str) {
    {
        let mut set = runtime.transcript_backfilled.lock().unwrap();
        if !set.insert(session_id.to_string()) {
            return; // already attempted this run
        }
    }
    // Prefer the live in-memory chat; fall back to the on-disk copy for a
    // session that isn't attached to the runtime.
    let chat = {
        let lock = runtime.sessions.lock().unwrap();
        lock.get(session_id)
            .map(|live| live.state.lock().unwrap().chat.clone())
    };
    let chat = match chat.or_else(|| persist::load(session_id).ok().map(|s| s.chat)) {
        Some(c) => c,
        None => return, // nothing on disk — nothing to backfill
    };
    let turns: Vec<crate::cloud_session_sync::BackfillTurn> = chat
        .iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| crate::cloud_session_sync::BackfillTurn {
            role: chat_role_label(t.role),
            body: t.text.clone(),
            at_unix_secs: t.at,
        })
        .collect();
    crate::cloud_session_sync::spawn_backfill_messages(session_id.to_string(), turns);
}

/// Startup sweep: backfill the transcripts of recently-active Manager sessions
/// so a paired phone opening one sees its history without the user having to
/// send a fresh turn on the laptop first. Runs once, a few seconds after launch
/// (after the session heartbeat + roster sync have had their first ticks, so
/// the cloud rows the backfill writes against already exist). Bounded to the
/// most-recently-touched sessions by file mtime — cheap to pick, and older
/// sessions are unlikely to be opened on the phone. Each session still passes
/// through the cloud-empty guard, so this is a no-op for anything already
/// synced, and login-gated end to end.
pub fn spawn_startup_transcript_backfill(app: AppHandle) {
    // How long to wait so the heartbeat (first tick ~6s) + roster sync (~8s)
    // have registered live sessions' cloud rows before we upload against them.
    const STARTUP_DELAY: Duration = Duration::from_secs(14);
    // Cap on how many recent sessions we sweep — one GET (+ maybe N POSTs) each.
    const MAX_SESSIONS: usize = 50;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        // Signed out → the backfill is a no-op anyway; skip the disk walk.
        match crate::cloud_session_sync::read_credentials() {
            Ok(creds) if crate::cloud_session_sync::cloud_token(&creds).is_some() => {}
            _ => return,
        }
        // Pick the most-recently-modified session files without parsing them all.
        let mut stamped: Vec<(std::time::SystemTime, String)> = persist::list_session_ids()
            .into_iter()
            .filter_map(|id| {
                let path = persist::sessions_dir()?.join(format!("{id}.json"));
                let mtime = std::fs::metadata(&path).ok()?.modified().ok()?;
                Some((mtime, id))
            })
            .collect();
        stamped.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
        stamped.truncate(MAX_SESSIONS);
        let runtime = app.state::<ManagerRuntime>();
        for (_, id) in stamped {
            ensure_transcript_backfilled(&runtime, &id);
        }
    });
}

/// Start the cloud inbox poller for an existing session if one isn't
/// already running. The poller self-terminates when the session drops
/// from the runtime, so dup-spawning would just leak a task — we keep
/// the set in `ManagerRuntime.cloud_inbox_sessions` to gate re-entry.
fn ensure_cloud_inbox_poller(app: &AppHandle, runtime: &ManagerRuntime, session_id: &str) {
    let mut set = runtime.cloud_inbox_sessions.lock().unwrap();
    if set.insert(session_id.to_string()) {
        crate::cloud_inbox::spawn_inbox_poller(app.clone(), session_id.to_string());
    }
}

/// Send a user message to the Manager brain. Appends the turn, persists,
/// then fires the agentic loop in a background task. The brain emits
/// `manager-stream:<sid>` deltas as it streams + tools fire; UI subscribes
/// to those for live rendering. Returns immediately so the UI doesn't
/// block on the round-trip.
#[tauri::command]
pub async fn manager_chat(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    message: String,
    attachments: Option<Vec<crate::manager::ChatAttachment>>,
) -> Result<(), String> {
    let attachments = attachments.unwrap_or_default();
    manager_chat_impl(app, runtime, session_id, message, attachments, /* push_to_cloud = */ true).await
}

/// Mobile-driven entry point: a user typed in the paired phone, we
/// pulled the turn off `/api/v2/sessions/{id}/messages`, and now feed
/// it into the same brain pipeline as a local keystroke. `push_to_cloud
/// = false` keeps us from echoing the message back to the cloud and
/// creating a feedback loop.
pub(crate) async fn inject_user_message_from_cloud(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    manager_chat_impl(app, runtime, session_id, message, vec![], /* push_to_cloud = */ false).await
}

async fn manager_chat_impl(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    message: String,
    attachments: Vec<crate::manager::ChatAttachment>,
    push_to_cloud: bool,
) -> Result<(), String> {
    let pushed_message = message.clone();
    // Grab the new user turn's index + project root in the same lock pass as
    // the append, so we can record a per-turn git baseline (the full
    // working-tree state right now, BEFORE the assistant's edits) for a
    // possible later edit-and-resend "restore all".
    let (new_turn_index, project_root) = mutate_take(&runtime, &session_id, move |s| {
        if attachments.is_empty() {
            chat::append(s, ChatRole::User, message);
        } else {
            chat::append_with_attachments(
                s,
                ChatRole::User,
                message,
                attachments,
            );
        }
        // A fresh user turn invalidates any half-finished tool loop from
        // an earlier turn — clear the brain's mid-turn state so the next
        // request starts clean.
        s.pending_assistant_blocks = None;
        s.pending_tool_results = None;
        // A stale session re-attached after restart sits in
        // AwaitingApproval / Paused — flip to Running so the tick loop
        // ticks again and subagent dispatches can fire.
        if matches!(
            s.status,
            ManagerStatus::AwaitingApproval | ManagerStatus::Paused
        ) {
            s.status = ManagerStatus::Running;
        }
        (
            s.chat.len().saturating_sub(1),
            s.projects.first().map(|p| p.root.clone()),
        )
    })
    .await?;
    if let Some(root) = project_root.clone() {
        let baseline_session_id = session_id.clone();
        crate::blocking::run(move || {
            capture_turn_baseline(&root, &baseline_session_id, new_turn_index)
        })
        .await;
    }
    save_and_kick(&app, &runtime, &session_id).await;
    if push_to_cloud {
        ensure_cloud_session_pushed(&runtime, &session_id);
        ensure_cloud_inbox_poller(&app, &runtime, &session_id);
        crate::cloud_session_sync::spawn_push_message(session_id.clone(), "user", pushed_message);
    }

    let state = {
        let lock = runtime.sessions.lock().unwrap();
        let live = lock
            .get(&session_id)
            .ok_or_else(|| format!("session {session_id} not running"))?;
        live.state.clone()
    };
    let app_handle = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = brain::run_turn(app_handle.clone(), sid.clone(), state).await {
            let _ = app_handle.emit(
                &format!("manager-stream:{sid}"),
                &brain::StreamDelta::Error { message: e },
            );
        }
    });
    Ok(())
}

/// Edit a previous user turn and resend from that point.
///
/// Truncates `session.chat` to `turn_index` (drops every turn from
/// `turn_index` onwards), pushes a fresh user turn with `message`, and
/// re-runs the brain. When `restore_code` is set, performs a TRUE
/// full-working-tree revert: it restores the project's tracked files to
/// the git baseline captured when the edited turn was originally sent —
/// every change since then, frontend AND backend, not just files that
/// happened to have an Aura snapshot. This is the user's deliberate
/// "restore all" choice, so the whole code state goes back to how it
/// looked at that message.
#[tauri::command]
pub async fn manager_chat_edit_resend(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    turn_index: usize,
    message: String,
    restore_code: bool,
) -> Result<(), String> {
    // Snapshot the project root in one lock pass. Validate the turn index
    // up front so an out-of-bounds edit fails before we touch the tree.
    let project_root = mutate_take(&runtime, &session_id, |s| {
        if turn_index >= s.chat.len() {
            return None;
        }
        s.projects.first().map(|p| p.root.clone())
    })
    .await?;

    // Full-tree restore to the git baseline recorded for this exact turn.
    // The baseline is the working tree as it stood when the message was
    // originally sent (captured on the send path, BEFORE the assistant's
    // edits landed), so "restore to this message" reverts the complete
    // code state — every tracked file across the repo, not the snapshot
    // subset the old path walked. Untracked files and the `aura`
    // submodule are left untouched (see `restore_tree_to_baseline`).
    let restored = if restore_code {
        if let Some(root) = project_root.clone() {
            let restore_session_id = session_id.clone();
            match crate::blocking::run(move || {
                restore_tree_to_baseline(&root, &restore_session_id, turn_index)
            })
            .await
            {
                Ok(true) => true,
                Ok(false) => false,
                Err(e) => {
                    eprintln!("aura-shell: edit-resend full restore failed: {e}");
                    false
                }
            }
        } else {
            false
        }
    } else {
        false
    };
    mutate(&runtime, &session_id, move |s| {
        if turn_index < s.chat.len() {
            s.chat.truncate(turn_index);
        }
        s.pending_assistant_blocks = None;
        s.pending_tool_results = None;
        s.pending_question = None;
        s.pending_plan = None;
        chat::append(s, ChatRole::User, message);
        if matches!(s.status, ManagerStatus::AwaitingApproval | ManagerStatus::Paused) {
            s.status = ManagerStatus::Running;
        }
    })
    .await?;
    // The resent message becomes the new turn at `turn_index`. Capture a
    // fresh baseline for it so a later edit-resend back to *this* message
    // also reverts the whole tree, not a subset.
    if let Some(root) = project_root {
        let baseline_session_id = session_id.clone();
        crate::blocking::run(move || {
            capture_turn_baseline(&root, &baseline_session_id, turn_index)
        })
        .await;
    }
    save_and_kick(&app, &runtime, &session_id).await;
    if restored {
        let _ = app.emit(
            &format!("manager-stream:{session_id}"),
            &serde_json::json!({
                "kind": "system",
                "text": "Restored the project's code to how it looked at this message.",
            }),
        );
    }
    let state = {
        let lock = runtime.sessions.lock().unwrap();
        let live = lock
            .get(&session_id)
            .ok_or_else(|| format!("session {session_id} not running"))?;
        live.state.clone()
    };
    let app_handle = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = brain::run_turn(app_handle.clone(), sid.clone(), state).await {
            let _ = app_handle.emit(
                &format!("manager-stream:{sid}"),
                &brain::StreamDelta::Error { message: e },
            );
        }
    });
    Ok(())
}

/// Per-turn git baseline sidecar. Records the commit SHA that captures the
/// project's full working-tree state at the moment a user turn was sent, so
/// an edit-and-resend can revert the whole tree back to that point. Stored
/// under `<root>/.aura/manager-baselines/<session_id>/<turn_index>.json` —
/// keyed by turn index so each editable user message has its own baseline.
#[derive(serde::Serialize, serde::Deserialize)]
struct TurnBaseline {
    /// Commit object that captures the working tree as it was when the turn
    /// was sent. Produced by `git stash create` (full tracked-file state,
    /// staged + unstaged) or, for a clean tree, the plain `HEAD` sha.
    tree_commit: String,
}

/// Directory holding a session's per-turn baselines.
fn baseline_dir(project_root: &str, session_id: &str) -> std::path::PathBuf {
    std::path::Path::new(project_root)
        .join(".aura")
        .join("manager-baselines")
        .join(session_id)
}

/// Sidecar file for one turn's baseline.
fn baseline_path(project_root: &str, session_id: &str, turn_index: usize) -> std::path::PathBuf {
    baseline_dir(project_root, session_id).join(format!("{turn_index}.json"))
}

/// Capture a full-working-tree git baseline for the user turn at
/// `turn_index` and persist it as a sidecar. Best-effort: a non-git root,
/// a missing `git`, or any failure is a silent no-op (edit-resend simply
/// won't be able to full-restore to that turn, exactly as before this
/// feature existed) — it never blocks the send path.
///
/// `git stash create` writes a commit object capturing the current working
/// tree + index WITHOUT modifying the index, the working tree, or the stash
/// list — so it's safe to run on every send. It prints an empty sha when the
/// tree is clean, in which case `HEAD` already is the baseline.
fn capture_turn_baseline(project_root: &str, session_id: &str, turn_index: usize) {
    let Some(tree_commit) = capture_tree_commit(project_root) else {
        return;
    };
    let dir = baseline_dir(project_root, session_id);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let baseline = TurnBaseline { tree_commit };
    if let Ok(json) = serde_json::to_string(&baseline) {
        let _ = std::fs::write(baseline_path(project_root, session_id, turn_index), json);
    }
}

/// Resolve a commit SHA capturing the full current working tree of
/// `project_root`. Prefers `git stash create` (captures tracked changes,
/// staged and unstaged, with zero side effects); falls back to `HEAD` when
/// the tree is clean. Returns None on any non-git / git-failure path.
fn capture_tree_commit(project_root: &str) -> Option<String> {
    let stash = std::process::Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["stash", "create"])
        .output()
        .ok()?;
    if stash.status.success() {
        let sha = String::from_utf8_lossy(&stash.stdout).trim().to_string();
        if !sha.is_empty() {
            return Some(sha);
        }
    }
    // Clean tree (stash create prints nothing) — HEAD is the baseline.
    let head = std::process::Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !head.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if sha.is_empty() { None } else { Some(sha) }
}

/// Submodule (gitlink) pathspecs to EXCLUDE from any worktree restore, so a
/// full-tree revert in the main repo never stages or rewinds the `aura`
/// submodule (or any other gitlink). Reads the index for entries with mode
/// `160000` and returns them as `:(exclude)<path>` pathspecs. Best-effort:
/// an empty vec on failure just means no explicit excludes (git still won't
/// recurse into a submodule worktree from the parent on a `restore`).
fn submodule_exclude_pathspecs(project_root: &str) -> Vec<String> {
    let Ok(out) = std::process::Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(["ls-files", "-s"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let mut excludes = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // Format: "<mode> <sha> <stage>\t<path>". Gitlinks carry mode 160000.
        let mode = line.split_whitespace().next().unwrap_or("");
        if mode != "160000" {
            continue;
        }
        if let Some((_meta, path)) = line.split_once('\t') {
            let path = path.trim();
            if !path.is_empty() {
                excludes.push(format!(":(exclude){path}"));
            }
        }
    }
    excludes
}

/// Revert the ENTIRE tracked working tree of `project_root` to the git
/// baseline recorded for `turn_index`. This is the deliberate "restore all"
/// behaviour: every tracked file the assistant touched since that turn —
/// frontend and backend — goes back to how it looked at the message.
///
/// Uses `git restore --source=<sha> --worktree -- . <submodule excludes>`,
/// which rewrites tracked files in place. It deliberately does NOT run
/// `git clean`, so untracked files the user may still want are left alone;
/// and it excludes gitlink paths so the `aura` submodule is never touched.
///
/// Returns Ok(true) when a restore ran, Ok(false) when there's no baseline
/// for that turn (older sessions / clean-no-op), Err on a git failure.
fn restore_tree_to_baseline(
    project_root: &str,
    session_id: &str,
    turn_index: usize,
) -> Result<bool, String> {
    let path = baseline_path(project_root, session_id, turn_index);
    let Ok(text) = std::fs::read_to_string(&path) else {
        // No baseline recorded for this turn (pre-feature session). Nothing
        // to restore to — leave the tree as-is rather than guessing.
        return Ok(false);
    };
    let baseline: TurnBaseline =
        serde_json::from_str(&text).map_err(|e| format!("parse baseline: {e}"))?;
    let sha = baseline.tree_commit.trim();
    if sha.is_empty() {
        return Ok(false);
    }

    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C")
        .arg(project_root)
        .args(["restore", "--source", sha, "--worktree", "--", "."]);
    // Never touch the `aura` (or any) submodule on a full-tree restore.
    for spec in submodule_exclude_pathspecs(project_root) {
        cmd.arg(spec);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("spawn git restore: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git restore failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(true)
}

/// Set `pending_question` on a Manager session from outside the regular
/// Tauri-command path. Called by the CLI socket bridge when claude (or
/// any CLI brain) invokes `aura ask-user` — we project the question onto
/// the session so the existing QuestionCard renderer picks it up.
pub fn set_pending_question(
    app: &AppHandle,
    session_id: &str,
    question: PendingQuestion,
) -> Result<(), String> {
    let runtime: tauri::State<'_, ManagerRuntime> = app.state();
    let lock = runtime.sessions.lock().unwrap();
    let live = lock
        .get(session_id)
        .ok_or_else(|| format!("session {session_id} not running"))?;
    {
        let mut s = live.state.lock().unwrap();
        s.pending_question = Some(question);
        s.touch();
    }
    let snapshot = live.state.lock().unwrap().clone();
    let _ = persist::save(&snapshot);
    let _ = app.emit(&format!("manager:{session_id}"), &snapshot);
    Ok(())
}

/// Set `pending_plan` on a Manager session — called by the CLI socket
/// bridge when claude invokes `aura propose-plan`. UI renders a PlanCard;
/// Build/Cancel hits `manager_decide_plan` which resolves the bridge.
pub fn set_pending_plan(
    app: &AppHandle,
    session_id: &str,
    plan: PendingPlan,
) -> Result<(), String> {
    let runtime: tauri::State<'_, ManagerRuntime> = app.state();
    let lock = runtime.sessions.lock().unwrap();
    let live = lock
        .get(session_id)
        .ok_or_else(|| format!("session {session_id} not running"))?;
    {
        let mut s = live.state.lock().unwrap();
        s.pending_plan = Some(plan);
        s.touch();
    }
    let snapshot = live.state.lock().unwrap().clone();
    let _ = persist::save(&snapshot);
    let _ = app.emit(&format!("manager:{session_id}"), &snapshot);
    Ok(())
}

/// User clicked Build, Request changes, or Cancel on the PlanCard. Resolves the bridge
/// waiter (which unblocks the `aura propose-plan` CLI process so claude
/// continues), clears `pending_plan`, and appends a visible chat turn.
///
/// Bucket D3 — `parallelism` is captured from the segmented control on
/// the PlanCard. We snapshot it onto the session here (before clearing
/// `pending_plan`) so the dispatch tick honours the user's choice for
/// the lifetime of the plan, even after `pending_plan` is gone. Legacy
/// callers that don't pass it default to Auto (the historical
/// behaviour).
#[tauri::command]
pub async fn manager_decide_plan(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    bridge: State<'_, BridgeRegistry>,
    session_id: String,
    plan_id: String,
    decision: String,
    feedback: Option<String>,
    notify_team: Option<bool>,
    parallelism: Option<String>,
) -> Result<(), String> {
    // Snapshot the pending plan up front. We need the todos list for
    // a2a minting (Build path) and we want to clear pending_plan + log
    // the chat turn either way.
    let plan_snapshot = {
        let lock = runtime.sessions.lock().unwrap();
        lock.get(&session_id)
            .and_then(|live| {
                let s = live.state.lock().unwrap();
                s.pending_plan.clone()
            })
            .filter(|p| p.id == plan_id)
    };

    // Resolve the project root + current branch for the K2 hierarchy
    // mint — every minted row carries `branch` so `aura a2a-task list
    // --branch <name>` works without a backfill.
    let project_root = {
        let lock = runtime.sessions.lock().unwrap();
        lock.get(&session_id).and_then(|live| {
            let s = live.state.lock().unwrap();
            s.projects.first().map(|p| p.root.clone())
        })
    };

    let is_build = decision == "build";
    let is_revise = decision == "revise";
    if !matches!(decision.as_str(), "build" | "revise" | "cancel") {
        return Err(format!("unknown plan decision: {decision}"));
    }
    let revision_feedback = if is_revise {
        let value = feedback.unwrap_or_default().trim().to_string();
        if value.is_empty() {
            return Err("plan revision feedback cannot be empty".to_string());
        }
        if value.chars().count() > 8_000 {
            return Err("plan revision feedback is limited to 8,000 characters".to_string());
        }
        Some(value)
    } else {
        None
    };

    // Bucket D3 — resolve the user's parallelism pick from the segmented
    // control. Falls back to whatever `pending_plan.parallelism` already
    // carried (set by the brain), then to Auto. No mint needed, so we do
    // it before the immediate-feedback mutate below.
    let resolved_parallelism = match parallelism.as_deref() {
        Some("parallel") => Some(crate::manager::PlanParallelism::Parallel),
        Some("serial") => Some(crate::manager::PlanParallelism::Serial),
        Some("auto") => Some(crate::manager::PlanParallelism::Auto),
        Some(other) => return Err(format!("unknown parallelism mode: {other}")),
        None => None,
    };

    // IMMEDIATE feedback FIRST. Append the visible "Build/Cancel the plan"
    // chat turn, snapshot parallelism, and clear `pending_plan` *before*
    // the slow, cloud-bound a2a mint + board mirror below. The wizard
    // closes onto a chat that already reflects the decision instead of the
    // user watching an unchanged thread while N cloud round-trips run —
    // that lag was exactly the "I clicked Build but the chat never knew it
    // for some time" report. The mint result isn't needed to acknowledge
    // the click (it only carries a2a ids for the bridge), so it moves after.
    mutate(&runtime, &session_id, |s| {
        if let Some(p) = s.pending_plan.as_ref() {
            if p.id == plan_id {
                let message = if is_build {
                    "Build the plan".to_string()
                } else if let Some(ref feedback) = revision_feedback {
                    format!("Request plan changes:\n\n{feedback}")
                } else {
                    "Cancel the plan".to_string()
                };
                // Snapshot parallelism onto the session before we clear
                // pending_plan. Build only — Cancel won't dispatch anything.
                if is_build {
                    s.plan_parallelism = resolved_parallelism.unwrap_or(p.parallelism);
                }
                chat::append(s, ChatRole::User, message);
                s.pending_plan = None;
            }
        }
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;

    // Now the slow work — the user has already seen the acknowledgement.
    let action = if is_build {
        // Bucket K2 — mint the full plan → wave → task hierarchy in the
        // CLOUD a2a store (cross-agent / teammate visibility). Best-effort:
        // if cloud isn't configured the parent mint returns None and
        // per-todo mints fall back to flat. The brain treats any empty id
        // as "no a2a tracking for this row".
        let result = if let Some(ref plan) = plan_snapshot {
            mint_a2a_tasks_for_plan(&session_id, plan, project_root.as_deref()).await
        } else {
            MintResult::default()
        };
        // Mirror the plan onto the LOCAL Tasks board + Crew loop graph —
        // the surfaces the user expected ("these tasks should be on the
        // board, and visible in Crew"). This is a different store from the
        // cloud mint above: the board / Crew read `.aura/tasks/` + the
        // local `.aura/a2a/` graph, which the cloud mint never touches, so
        // without this the plan's todos land on neither. Best-effort,
        // local-only, never blocks the build; skipped without a root.
        if let (Some(plan), Some(root)) = (plan_snapshot.as_ref(), project_root.as_ref()) {
            mirror_plan_to_board(root, plan).await;
            // Crew becomes the runner. Now that the plan's tasks are on the
            // board and synced into the loop graph, hand them straight to the
            // Crew runner so Build *immediately* starts the work — real coding
            // agents in dependency order, with live status / retry / proof in
            // the Build rail — instead of the old invisible brain subagent
            // fan-out the user couldn't see or steer. Serial plans run one
            // task at a time; Auto/Parallel fan out across worktrees.
            let jobs_override = match resolved_parallelism.unwrap_or(plan.parallelism) {
                crate::manager::PlanParallelism::Serial => Some(1usize),
                _ => None,
            };
            autostart_crew(&app, root, jobs_override).await;
        }
        PlanDecision::Build {
            a2a_task_ids: result.todo_task_ids,
            plan_task_id: result.plan_task_id,
        }
    } else if let Some(feedback) = revision_feedback {
        PlanDecision::Revise { feedback }
    } else {
        PlanDecision::Cancel
    };

    // Bucket N3 — Notify-team broadcast on Build. Best-effort: cloud
    // off / msg cmd missing fails silent, the build itself proceeds.
    // We branch by `action` to skip the noise when the user clicked
    // Cancel.
    let should_notify = notify_team.unwrap_or(false)
        && matches!(action, PlanDecision::Build { .. });
    if should_notify {
        if let Some(ref plan) = plan_snapshot {
            let title = plan.title.clone();
            let plan_id_for_msg = action_plan_task_id(&action);
            let body = match plan_id_for_msg {
                Some(pid) => format!("Plan built: {title} ({pid})"),
                None => format!("Plan built: {title}"),
            };
            tokio::spawn(async move {
                let _ = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin())
                    .args(["msg", "send", &body])
                    .output()
                    .await;
            });
        }
    }
    if !bridge.resolve_plan(&plan_id, action) {
        return Err(format!("no waiter for plan {plan_id}"));
    }
    Ok(())
}

fn action_plan_task_id(action: &PlanDecision) -> Option<String> {
    match action {
        PlanDecision::Build { plan_task_id, .. } => plan_task_id.clone(),
        PlanDecision::Revise { .. } => None,
        PlanDecision::Cancel => None,
    }
}

/// First non-empty line of a todo description, clamped to `max` chars, for
/// use as a board-task title (the full text still lands in `description`).
fn first_line_clamped(s: &str, max: usize) -> String {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.is_empty() {
        return "Plan step".to_string();
    }
    if line.chars().count() <= max {
        line.to_string()
    } else {
        let mut out: String = line.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}

/// Mirror a freshly-built plan onto the LOCAL Tasks board (`.aura/tasks/`)
/// and project it into the Crew loop graph (`.aura/a2a/`), so the work
/// shows up where the user expects after clicking Build — the board, and
/// (after the board→graph sync) Crew.
///
/// This is deliberately separate from `mint_a2a_tasks_for_plan`, which
/// writes the *cloud* a2a task store for cross-agent / teammate
/// visibility. The board and Crew read the *local* stores, which the cloud
/// mint never touches — so without this the plan's todos appear on
/// neither. One epic (the plan) + one child task per todo, then a single
/// `loop_sync_board` so Crew renders them without a manual "Sync from
/// board". All best-effort: a failed leg is skipped, never fatal — the
/// build proceeds regardless. Execution still flows through the brain's
/// subagent dispatch; these rows are the visible plan-of-record.
async fn mirror_plan_to_board(repo_root: &str, plan: &PendingPlan) {
    use crate::cmd_tasks::{tasks_create, CreateTaskInput};

    if plan.todos.is_empty() {
        return;
    }

    let objective = plan
        .objective
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let epic_description = if plan.summary.trim().is_empty() {
        plan.title.clone()
    } else {
        plan.summary.clone()
    };

    // Epic — the plan itself, so the todos cluster under one card on the
    // board and one parent node in Crew.
    let epic_id = match tasks_create(
        repo_root.to_string(),
        CreateTaskInput {
            title: if plan.title.trim().is_empty() {
                "Plan".to_string()
            } else {
                plan.title.clone()
            },
            description: epic_description,
            objective,
            is_epic: true,
            labels: vec!["plan".to_string()],
            ..Default::default()
        },
    )
    .await
    {
        Ok(t) => Some(t.id),
        // Best-effort: if the epic fails, still create the children flat
        // (no parent) so the work at least lands on the board.
        Err(_) => None,
    };

    for todo in &plan.todos {
        let has_subs = !todo.subtasks.is_empty();
        let created = tasks_create(
            repo_root.to_string(),
            CreateTaskInput {
                title: first_line_clamped(&todo.description, 120),
                // Fold the goal + verify plan into the body so the task-detail
                // pane reads as a real spec, not a one-line title echo.
                description: compose_task_body(
                    &todo.description,
                    todo.goal.as_deref(),
                    &todo.acceptance,
                ),
                // The plain-language outcome shows on the card even before the
                // goal ledger hydrates; the linked goal below makes it provable.
                objective: todo
                    .goal
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string),
                agent_assignee: todo.agent.clone(),
                assignee: todo.assignee.clone(),
                parent_id: epic_id.clone(),
                epic_id: epic_id.clone(),
                // A todo that splits into sub-steps is a grouping the Crew does
                // NOT run directly — mark it an epic so loop_sync_board projects
                // it as a container (KIND_PLAN), exactly like the plan epic, and
                // the sub-steps below become the runnable leaves. A leaf todo
                // (no subtasks) stays a normal runnable task, as before.
                is_epic: has_subs,
                labels: vec!["plan".to_string()],
                ..Default::default()
            },
        )
        .await
        .ok();

        // Attach a provable goal carrying the verify plan to this unit (best
        // effort — a failed link never blocks the build). A grouping todo still
        // carries its parent goal for the detail pane; the sub-steps carry the
        // runnable goals.
        if let Some(t) = created.as_ref() {
            attach_goal(
                repo_root,
                t.sequence_id,
                todo.goal.as_deref(),
                &todo.description,
                &todo.acceptance,
            )
            .await;

            // Sub-steps → real runnable child tasks, each with its own goal +
            // verify plan, parented to this todo so they project as the
            // runnable leaves under the grouping.
            for sub in &todo.subtasks {
                let sub_created = tasks_create(
                    repo_root.to_string(),
                    CreateTaskInput {
                        title: first_line_clamped(&sub.description, 120),
                        description: compose_task_body(
                            &sub.description,
                            sub.goal.as_deref(),
                            &sub.acceptance,
                        ),
                        objective: sub
                            .goal
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string),
                        agent_assignee: sub.agent.clone().or_else(|| todo.agent.clone()),
                        parent_id: Some(t.id.clone()),
                        epic_id: epic_id.clone().or_else(|| Some(t.id.clone())),
                        labels: vec!["plan".to_string()],
                        ..Default::default()
                    },
                )
                .await
                .ok();
                if let Some(st) = sub_created.as_ref() {
                    attach_goal(
                        repo_root,
                        st.sequence_id,
                        sub.goal.as_deref(),
                        &sub.description,
                        &sub.acceptance,
                    )
                    .await;
                }
            }
        }
    }

    // Project the new board cards into the loop graph Crew renders. Keyed
    // on board_task_id, so re-running is idempotent.
    let _ = crate::cmd_loop::loop_sync_board(repo_root.to_string()).await;
}

/// Compose a board-task body from the step text plus its goal + verify plan,
/// so the task-detail pane renders a real spec instead of echoing the title.
/// The goal becomes a bold line; each acceptance check becomes a markdown
/// checkbox the user (or the Crew) can tick. Empties are omitted.
fn compose_task_body(base: &str, goal: Option<&str>, acceptance: &[String]) -> String {
    let mut out = base.trim().to_string();
    if let Some(g) = goal.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("\n\n**Goal:** ");
        out.push_str(g);
    }
    let checks: Vec<&str> = acceptance
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if !checks.is_empty() {
        out.push_str("\n\n**Verify:**\n");
        for c in checks {
            out.push_str("- [ ] ");
            out.push_str(c);
            out.push('\n');
        }
    }
    out
}

/// Shell `aura goals add` to mint-or-find a goal carrying the verify plan and
/// link it to a freshly-minted board task (`AURA-<seq>`). Skips entirely when
/// there's no goal text AND no checks (a bare leaf never spams the ledger);
/// when checks exist but no explicit goal was given, the step's first line
/// stands in as the goal text so the acceptance plan still lands. Best-effort:
/// a non-zero exit or missing CLI is swallowed so the build never blocks on it.
async fn attach_goal(
    repo_root: &str,
    task_seq: u64,
    goal: Option<&str>,
    fallback_text: &str,
    acceptance: &[String],
) {
    let goal = goal.map(str::trim).filter(|s| !s.is_empty());
    let checks: Vec<&str> = acceptance
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if goal.is_none() && checks.is_empty() {
        return;
    }
    let text = goal
        .map(str::to_string)
        .unwrap_or_else(|| first_line_clamped(fallback_text, 120));
    if text.trim().is_empty() {
        return;
    }
    let task_ref = format!("AURA-{task_seq}");
    let mut cmd = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin());
    cmd.current_dir(repo_root)
        .args(["goals", "add", &text, "--task", &task_ref]);
    for c in checks {
        cmd.args(["--check", c]);
    }
    let _ = cmd.output().await;
}

/// Hand a freshly-built plan's tasks to the Crew runner the instant the user
/// clicks Build — Crew *is* the runner. This is the in-app equivalent of
/// opening Build → Crew and pressing Run, but automatic: the user watches real
/// status move (working → done / failed), retries failures, and sees the proof
/// verdict, instead of an invisible subagent fan-out they couldn't steer.
///
/// Best-effort and non-blocking — `run_native_dispatch` registers the canvas
/// lanes and spawns `aura crew run` in the background, returning immediately,
/// so this never stalls the Build click. A missing dispatcher state or an empty
/// ready set is a quiet no-op: the board rows still stand as the plan-of-record
/// for a later manual Run.
async fn autostart_crew(app: &AppHandle, repo_root: &str, jobs_override: Option<usize>) {
    use tauri::Manager as _;
    let Some(state) =
        app.try_state::<Arc<crate::manager::dispatcher::DispatcherState>>()
    else {
        eprintln!("aura-shell: plan Build — no dispatcher state, skipping crew auto-start");
        return;
    };
    if let Err(e) = crate::cmd_loop::run_native_dispatch(
        app.clone(),
        state.inner().clone(),
        repo_root.to_string(),
        None,
        jobs_override,
        None,
        None,
    )
    .await
    {
        eprintln!("aura-shell: plan Build crew auto-start failed: {e}");
    }
}

/// Inventory blocker #3 (2026-05-20 audit) — explicit human approval row
/// on the PlanCard. Distinct from Build: Approve records *who* signed off
/// (and when) without resolving the propose-plan bridge, so a teammate
/// can rubber-stamp a plan and the audit row persists across reload even
/// if the actual Build click happens later (or by someone else).
///
/// Idempotent on already-approved plans: second call updates approver +
/// timestamp (later approver wins, matching how a fresh signature should
/// supersede a stale one). Returns the (approver, timestamp) pair the
/// frontend can use to render the row immediately without waiting for
/// the next `manager:<sid>` snapshot.
#[tauri::command]
pub async fn manager_approve_plan(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    plan_id: String,
    approver: String,
) -> Result<PlanApproval, String> {
    let now = crate::manager::now_secs();
    let approval = mutate_take(&runtime, &session_id, |s| {
        apply_plan_approval(s, &plan_id, &approver, now)
    })
    .await??;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(approval)
}

/// Pure mutation step extracted from `manager_approve_plan` so it can be
/// unit-tested without spinning up a Tauri runtime. Stamps `approved_by`
/// + `approved_at` onto the session's pending plan (when ids match),
/// then re-runs the heal-on-read normalizer so half-written rows can't
/// slip through. Returns Err when there's no pending plan or the plan id
/// doesn't match; returns Err for empty approver handles so the caller
/// can surface a clean validation error.
pub(crate) fn apply_plan_approval(
    session: &mut ManagerSession,
    plan_id: &str,
    approver: &str,
    now: u64,
) -> Result<PlanApproval, String> {
    let handle = approver.trim().to_string();
    if handle.is_empty() {
        return Err("approver handle cannot be empty".into());
    }
    let Some(plan) = session.pending_plan.as_mut() else {
        return Err(format!("session {} has no pending plan", session.id));
    };
    if plan.id != plan_id {
        return Err(format!(
            "pending plan id mismatch (have {}, requested {})",
            plan.id, plan_id
        ));
    }
    plan.approved_by = Some(handle.clone());
    plan.approved_at = Some(now);
    // Defensive — keep the pair consistent even if a future caller
    // mutates one half without the other.
    plan.heal_approval();
    Ok(PlanApproval {
        approved_by: handle,
        approved_at: now,
    })
}

/// Returned by `manager_approve_plan` so the frontend can render the
/// "Approved by @handle · just now" row immediately on click without
/// waiting for the next `manager:<sid>` snapshot to round-trip.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PlanApproval {
    pub approved_by: String,
    pub approved_at: u64,
}

/// Bucket K2 — beads-grade hierarchy mint. Returns the parent plan
/// task id alongside per-todo task ids so the brain can post status
/// against both rungs.
#[derive(Default, Debug, Clone)]
pub(crate) struct MintResult {
    pub plan_task_id: Option<String>,
    pub todo_task_ids: Vec<String>,
}

/// Best-effort fan-out: spawn `aura a2a-task create` calls to mint the
/// full plan → wave → task tree for a freshly-built PendingPlan.
///
/// Mint order:
///   1. ONE `task_kind=plan` parent — input=title, AC=objective (or
///      summary fallback), branch=current HEAD, tags=first 3 deliverables.
///      No parent_task_id.
///   2. If `plan.phases` is non-empty, ONE `task_kind=wave` per phase
///      with parent_task_id=plan_task_id, input=phase.title,
///      AC=phase.body, branch=current, tags=phase.file_refs[..3].
///   3. ONE `task_kind=task` per todo with input=todo.description,
///      AC=description, parent=matching wave (by index when
///      `phases.len() == todos.len()`) or the plan task otherwise.
///
/// Cloud-down / mint-failed legs fall back to None for the parent and
/// the corresponding todo id is omitted from `todo_task_ids` — the
/// brain treats a shorter list as "untracked", same as before K2.
async fn mint_a2a_tasks_for_plan(
    session_id: &str,
    plan: &PendingPlan,
    project_root: Option<&str>,
) -> MintResult {
    let branch = if let Some(root) = project_root {
        let root = root.to_string();
        crate::blocking::run(move || detect_current_branch(&root)).await
    } else {
        None
    };
    let plan_acceptance = plan
        .objective
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if plan.summary.trim().is_empty() {
                plan.title.clone()
            } else {
                plan.summary.clone()
            }
        });

    let plan_tags: Vec<String> = plan
        .deliverables
        .iter()
        .take(3)
        .map(|s| short_tag(s))
        .collect();

    // Surface the planner's rich content into metadata so the right-rail
    // detail drawer can render it. The drawer looks for `description`
    // and falls back to `body`; auxiliary keys (`baseline`,
    // `architecture_mermaid`, `deliverables`, `tests`) feed dedicated
    // sub-cards.
    let plan_description = plan
        .objective
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let s = plan.summary.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        });
    let mut plan_meta = serde_json::Map::new();
    plan_meta.insert(
        "manager_session_id".into(),
        serde_json::Value::String(session_id.to_string()),
    );
    plan_meta.insert("plan_id".into(), serde_json::Value::String(plan.id.clone()));
    plan_meta.insert(
        "plan_title".into(),
        serde_json::Value::String(plan.title.clone()),
    );
    if let Some(desc) = plan_description.as_ref() {
        plan_meta.insert(
            "description".into(),
            serde_json::Value::String(desc.clone()),
        );
    }
    if let Some(b) = plan.baseline.as_ref() {
        if !b.trim().is_empty() {
            plan_meta.insert("baseline".into(), serde_json::Value::String(b.clone()));
        }
    }
    if let Some(m) = plan.architecture_mermaid.as_ref() {
        if !m.trim().is_empty() {
            plan_meta.insert(
                "architecture_mermaid".into(),
                serde_json::Value::String(m.clone()),
            );
        }
    }
    if !plan.deliverables.is_empty() {
        plan_meta.insert(
            "deliverables".into(),
            serde_json::Value::Array(
                plan.deliverables
                    .iter()
                    .map(|s| serde_json::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    if !plan.tests.is_empty() {
        plan_meta.insert(
            "tests".into(),
            serde_json::Value::Array(
                plan.tests
                    .iter()
                    .map(|s| serde_json::Value::String(s.clone()))
                    .collect(),
            ),
        );
    }
    plan_meta.insert(
        "phase_count".into(),
        serde_json::Value::Number(plan.phases.len().into()),
    );
    plan_meta.insert(
        "todo_count".into(),
        serde_json::Value::Number(plan.todos.len().into()),
    );

    let plan_task_id = create_a2a_task(CreateArgs {
        agent_kind: "aura-manager".to_string(),
        input: plan.title.clone(),
        context_id: Some(plan.id.clone()),
        metadata: serde_json::Value::Object(plan_meta),
        task_kind: Some("plan".to_string()),
        parent_task_id: None,
        acceptance_criteria: Some(plan_acceptance),
        branch: branch.clone(),
        tags: plan_tags,
        assignee: None,
    })
    .await;

    // Wave layer — only if the plan declared phases.
    let wave_ids: Vec<Option<String>> = if !plan.phases.is_empty() && plan_task_id.is_some() {
        let mut waves = Vec::with_capacity(plan.phases.len());
        for phase in &plan.phases {
            let wave_ac = if phase.body.trim().is_empty() {
                phase.title.clone()
            } else {
                phase.body.clone()
            };
            let wave_tags: Vec<String> = phase
                .file_refs
                .iter()
                .take(3)
                .map(|s| short_tag(s))
                .collect();
            let mut wave_meta = serde_json::Map::new();
            wave_meta.insert(
                "manager_session_id".into(),
                serde_json::Value::String(session_id.to_string()),
            );
            wave_meta.insert("plan_id".into(), serde_json::Value::String(plan.id.clone()));
            wave_meta.insert(
                "plan_title".into(),
                serde_json::Value::String(plan.title.clone()),
            );
            wave_meta.insert(
                "phase_title".into(),
                serde_json::Value::String(phase.title.clone()),
            );
            if !phase.body.trim().is_empty() {
                wave_meta.insert(
                    "description".into(),
                    serde_json::Value::String(phase.body.clone()),
                );
            }
            if !phase.file_refs.is_empty() {
                wave_meta.insert(
                    "file_refs".into(),
                    serde_json::Value::Array(
                        phase
                            .file_refs
                            .iter()
                            .map(|s| serde_json::Value::String(s.clone()))
                            .collect(),
                    ),
                );
            }
            let id = create_a2a_task(CreateArgs {
                agent_kind: "aura-manager".to_string(),
                input: phase.title.clone(),
                context_id: Some(plan.id.clone()),
                metadata: serde_json::Value::Object(wave_meta),
                task_kind: Some("wave".to_string()),
                parent_task_id: plan_task_id.clone(),
                acceptance_criteria: Some(wave_ac),
                branch: branch.clone(),
                tags: wave_tags,
                assignee: None,
            })
            .await;
            waves.push(id);
        }
        waves
    } else {
        Vec::new()
    };

    // Todo layer — parent each todo to its matching wave when the
    // counts align (canonical case: one phase per todo). Otherwise
    // every todo parents up to the plan task.
    let waves_align = !wave_ids.is_empty() && wave_ids.len() == plan.todos.len();
    let mut todo_ids = Vec::with_capacity(plan.todos.len());
    for (idx, todo) in plan.todos.iter().enumerate() {
        let agent_kind = todo
            .agent
            .as_deref()
            .map(|a| format!("aura-manager-{a}"))
            .unwrap_or_else(|| "aura-manager".to_string());
        let parent = if waves_align {
            wave_ids[idx].clone().or_else(|| plan_task_id.clone())
        } else {
            plan_task_id.clone()
        };
        let todo_tags: Vec<String> = todo
            .file_refs
            .iter()
            .take(3)
            .map(|s| short_tag(s))
            .collect();
        let mut todo_meta = serde_json::Map::new();
        todo_meta.insert(
            "manager_session_id".into(),
            serde_json::Value::String(session_id.to_string()),
        );
        todo_meta.insert("plan_id".into(), serde_json::Value::String(plan.id.clone()));
        todo_meta.insert(
            "plan_title".into(),
            serde_json::Value::String(plan.title.clone()),
        );
        if !todo.description.trim().is_empty() {
            todo_meta.insert(
                "description".into(),
                serde_json::Value::String(todo.description.clone()),
            );
        }
        if !todo.file_refs.is_empty() {
            todo_meta.insert(
                "file_refs".into(),
                serde_json::Value::Array(
                    todo.file_refs
                        .iter()
                        .map(|s| serde_json::Value::String(s.clone()))
                        .collect(),
                ),
            );
        }
        if let Some(suggested) = todo.suggested_provider.as_ref() {
            if let Ok(value) = serde_json::to_value(suggested) {
                todo_meta.insert("suggested_provider".into(), value);
            }
        }
        // Carry the real goal + verify plan into metadata so the cross-agent
        // detail drawer renders them, and let the sub-steps ride along so a
        // teammate sees the breakdown even though the runnable child tasks live
        // on the local board the Crew works.
        if let Some(g) = todo
            .goal
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            todo_meta.insert("goal".into(), serde_json::Value::String(g.to_string()));
        }
        if !todo.acceptance.is_empty() {
            todo_meta.insert(
                "acceptance".into(),
                serde_json::Value::Array(
                    todo.acceptance
                        .iter()
                        .map(|s| serde_json::Value::String(s.clone()))
                        .collect(),
                ),
            );
        }
        if !todo.subtasks.is_empty() {
            todo_meta.insert(
                "subtasks".into(),
                serde_json::Value::Array(
                    todo.subtasks
                        .iter()
                        .map(|s| {
                            let mut m = serde_json::Map::new();
                            m.insert(
                                "description".into(),
                                serde_json::Value::String(s.description.clone()),
                            );
                            if let Some(g) = s
                                .goal
                                .as_deref()
                                .map(str::trim)
                                .filter(|x| !x.is_empty())
                            {
                                m.insert("goal".into(), serde_json::Value::String(g.to_string()));
                            }
                            if !s.acceptance.is_empty() {
                                m.insert(
                                    "acceptance".into(),
                                    serde_json::Value::Array(
                                        s.acceptance
                                            .iter()
                                            .map(|x| serde_json::Value::String(x.clone()))
                                            .collect(),
                                    ),
                                );
                            }
                            serde_json::Value::Object(m)
                        })
                        .collect(),
                ),
            );
        }
        // The cloud acceptance_criteria is one string — prefer the verify plan
        // (one check per line), fall back to the goal, then the description, so
        // it's never just a title echo.
        let todo_ac = if !todo.acceptance.is_empty() {
            todo.acceptance.join("\n")
        } else {
            todo.goal
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| todo.description.clone())
        };
        let id = create_a2a_task(CreateArgs {
            agent_kind,
            input: todo.description.clone(),
            context_id: Some(plan.id.clone()),
            metadata: serde_json::Value::Object(todo_meta),
            task_kind: Some("task".to_string()),
            parent_task_id: parent,
            acceptance_criteria: Some(todo_ac),
            branch: branch.clone(),
            tags: todo_tags,
            assignee: todo.assignee.clone(),
        })
        .await;
        if let Some(id) = id {
            todo_ids.push(id);
        }
    }

    MintResult {
        plan_task_id,
        todo_task_ids: todo_ids,
    }
}

struct CreateArgs {
    agent_kind: String,
    input: String,
    context_id: Option<String>,
    metadata: serde_json::Value,
    task_kind: Option<String>,
    parent_task_id: Option<String>,
    acceptance_criteria: Option<String>,
    branch: Option<String>,
    tags: Vec<String>,
    /// Bucket N1 — teammate email/username. Cloud resolves to
    /// `assignee_user_id`. None = task is unassigned (the dispatching
    /// developer implicitly owns it).
    assignee: Option<String>,
}

async fn create_a2a_task(args: CreateArgs) -> Option<String> {
    let mut metadata_obj = match args.metadata {
        serde_json::Value::Object(m) => m,
        other => {
            let mut m = serde_json::Map::new();
            m.insert("legacy".to_string(), other);
            m
        }
    };
    // Until the K1 migration ships in the deployed cloud, the parent
    // pointer + kind also stash in metadata — the backfill in
    // scripts/backfill_a2a_hierarchy.sql hoists them into the typed
    // columns. This is harmless once the migration lands (the columns
    // win because they're sent in the typed --kind / --parent flags).
    if let Some(ref kind) = args.task_kind {
        metadata_obj.insert("task_kind".to_string(), serde_json::Value::String(kind.clone()));
    }
    if let Some(ref parent) = args.parent_task_id {
        metadata_obj.insert(
            "parent_task_id".to_string(),
            serde_json::Value::String(parent.clone()),
        );
    }
    if let Some(ref branch) = args.branch {
        metadata_obj.insert(
            "branch".to_string(),
            serde_json::Value::String(branch.clone()),
        );
    }
    if let Some(ref a) = args.assignee {
        // Pre-K1 servers don't know `assignee` as a typed column;
        // stash in metadata so a backfill (or the cloud's resolver)
        // can hoist it. Post-K1 the typed flag wins, this is harmless.
        metadata_obj.insert(
            "assignee".to_string(),
            serde_json::Value::String(a.clone()),
        );
    }
    let metadata_str = serde_json::Value::Object(metadata_obj).to_string();

    let mut cmd = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin());
    cmd.args([
        "a2a-task",
        "create",
        "--agent-kind",
        &args.agent_kind,
        "--input",
        &args.input,
    ]);
    if let Some(ref cid) = args.context_id {
        cmd.args(["--context-id", cid]);
    }
    cmd.args(["--metadata-json", &metadata_str]);
    // Bucket K2 — pass the hierarchy fields as typed flags so the
    // K1-migrated cloud writes them into the proper columns. The same
    // values also stash in metadata above for backwards compat with
    // pre-K1 servers (the backfill SQL hoists them).
    if let Some(ref kind) = args.task_kind {
        cmd.args(["--kind", kind]);
    }
    if let Some(ref parent) = args.parent_task_id {
        cmd.args(["--parent", parent]);
    }
    if let Some(ref ac) = args.acceptance_criteria {
        cmd.args(["--acceptance-criteria", ac]);
    }
    if let Some(ref branch) = args.branch {
        cmd.args(["--branch", branch]);
    }
    for tag in &args.tags {
        cmd.args(["--tag", tag]);
    }
    if let Some(ref a) = args.assignee {
        cmd.args(["--assignee", a]);
    }
    cmd.arg("--json");

    let out = cmd.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    extract_a2a_task_id(&out.stdout)
}

/// Resolve `git rev-parse --abbrev-ref HEAD` against the session's
/// project root. Returns None on detached HEAD or non-git directory —
/// the mint fields stay None, which is fine.
fn detect_current_branch(root: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = std::str::from_utf8(&out.stdout).ok()?.trim().to_string();
    if s.is_empty() || s == "HEAD" {
        None
    } else {
        Some(s)
    }
}

/// Compress a deliverable / file ref into a single-token tag suitable
/// for `tags TEXT[]`. Lowercase, alnum + dash, capped at 24 chars.
fn short_tag(raw: &str) -> String {
    let s: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let collapsed: String = s
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    collapsed.chars().take(24).collect()
}

fn extract_a2a_task_id(stdout: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(stdout).ok()?;
    let v: serde_json::Value = serde_json::from_str(s.trim()).ok()?;
    v.get("id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// Bucket L1 — expand each zone glob against project_root and take a
/// durable file-level snapshot per match by spawning `aura snapshot-file`
/// in the project directory. Returns the snapshot ids parsed from the
/// CLI's `ok:<path>:<id>` lines; `skip:` lines (file doesn't exist yet)
/// and stderr failures fall through silently — the dispatch must not
/// block on snapshot trouble.
async fn snapshot_zones_pre_dispatch(
    project_root: &str,
    zones: &[String],
    agent_label: &str,
) -> Vec<String> {
    if zones.is_empty() {
        return Vec::new();
    }
    let expanded = expand_zone_globs(project_root, zones);
    if expanded.is_empty() {
        return Vec::new();
    }
    let mut cmd = tokio::process::Command::new(crate::agent_event_listener::resolve_aura_bin());
    cmd.current_dir(project_root)
        .arg("snapshot-file")
        .arg("--trigger")
        .arg("pre_dispatch_guard")
        .arg("--agent")
        .arg(agent_label);
    for path in &expanded {
        cmd.arg(path);
    }
    let out = match cmd.output().await {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix("ok:"))
        .filter_map(|rest| rest.split_once(':').map(|(_, id)| id.to_string()))
        .collect()
}

/// Walk each glob in `zones` against `project_root` and return the
/// matched paths relative to project_root. Globs that don't match
/// return nothing (the subagent may create the file post-dispatch —
/// that's the snapshot CLI's `skip:` path). Currently supports basic
/// glob patterns via the `glob` crate when present, falling back to
/// literal paths otherwise.
fn expand_zone_globs(project_root: &str, zones: &[String]) -> Vec<String> {
    let mut matched = Vec::new();
    for zone in zones {
        let trimmed = zone.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Literal-path fast path: most zones declared today are exact
        // file paths (`app/page.tsx`, `aura-cli/src/main.rs`).
        let abs = std::path::Path::new(project_root).join(trimmed);
        if abs.is_file() {
            matched.push(trimmed.to_string());
            continue;
        }
        // Glob path: walk via `glob` if available. We use the absolute
        // form so the matcher resolves against the project root.
        let pattern_abs = abs.to_string_lossy().to_string();
        if let Ok(iter) = glob::glob(&pattern_abs) {
            for entry in iter.flatten() {
                if entry.is_file() {
                    if let Ok(rel) = entry.strip_prefix(project_root) {
                        matched.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    matched.sort();
    matched.dedup();
    matched
}

/// Bucket L2 — append a single Manager-dispatch entry to
/// `<project_root>/.aura/intent_log.jsonl`. The shape mirrors what
/// `aura log-intent` writes from the CLI so the user's semantic
/// timeline reads as one continuous stream regardless of source.
fn log_dispatch_intent(
    project_root: &str,
    agent_label: &str,
    task_id: usize,
    description: &str,
    zones: &[String],
    a2a_task_id: Option<&str>,
) {
    let dir = std::path::Path::new(project_root).join(".aura");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("intent_log.jsonl");
    let entry = serde_json::json!({
        "agent_id": agent_label,
        "intent": format!("Manager dispatch: {description}"),
        "task_id": task_id,
        "a2a_task_id": a2a_task_id,
        "zones": zones,
        "timestamp": now_secs(),
        "source": "aura-shell-manager",
    });
    let line = format!("{}\n", entry);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Submit the user's answer to the brain's currently pending `ask_user`
/// question. Synthesises the missing `tool_result` block for the paused
/// tool_use, clears `pending_question`, appends a visible chat turn so
/// the user's reply shows in the transcript, and re-spawns `brain::run_turn`
/// to resume the loop. Errors if there's no pending question or the id
/// doesn't match (defensive — frontend should only call this with the id
/// it received in `QuestionAsked`).
#[tauri::command]
pub async fn manager_answer_question(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    bridge: State<'_, BridgeRegistry>,
    session_id: String,
    question_id: String,
    answer: String,
) -> Result<(), String> {
    let consumed: PendingQuestion = mutate_take(&runtime, &session_id, |s| {
        let pq = s.pending_question.take();
        if let Some(ref q) = pq {
            if q.tool_use_id == question_id {
                // Visible transcript turn — pairs the answer with the
                // originating question text so the timeline renders Q+A
                // as one grouped element (Cursor parity), not an
                // orphaned answer bubble.
                let display = if answer.len() > 200 {
                    format!("{}…", crate::text::clip(&answer, 199))
                } else {
                    answer.clone()
                };
                chat::append_answer(s, display, q.question.clone());
                if !q.from_cli {
                    // Anthropic API path: synthesize the missing tool_result
                    // so the brain's loop can resume.
                    let mut results = s.pending_tool_results.take().unwrap_or_default();
                    results.push(serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": question_id,
                        "is_error": false,
                        "content": answer,
                    }));
                    s.pending_tool_results = Some(results);
                }
                pq
            } else {
                s.pending_question = pq.clone();
                None
            }
        } else {
            None
        }
    })
    .await?
    .ok_or_else(|| "no matching pending question".to_string())?;
    save_and_kick(&app, &runtime, &session_id).await;

    if consumed.from_cli {
        // CLI bridge path — resolve the socket waiter so `aura ask-user`
        // returns the answer to claude's bash tool. No brain re-spawn:
        // the CLI process IS the brain, and it's about to wake up on its
        // own when the bash command returns.
        if !bridge.resolve_question(&question_id, answer) {
            // Stale waiter: the CLI subprocess that asked the question
            // exited (crashed, killed, restarted) before the user
            // answered. The answer is still preserved in the chat
            // transcript via `chat::append_answer` above; we just have
            // nobody to hand it to. Surface a soft notice in the
            // transcript instead of a red error so the user can keep
            // chatting — the next normal message will spawn a fresh
            // brain turn.
            eprintln!(
                "[manager] no bridge waiter for {question_id} — \
                 CLI brain disconnected; answer left in transcript only"
            );
            let _ = app.emit(
                &format!("manager-stream:{session_id}"),
                &brain::StreamDelta::TextDelta {
                    block_idx: 0,
                    text: "Agent disconnected before your answer landed. \
                           Type again to start a fresh turn."
                        .to_string(),
                },
            );
            let _ = app.emit(
                &format!("manager-stream:{session_id}"),
                &brain::StreamDelta::Done,
            );
        }
        return Ok(());
    }

    // Anthropic API path — re-spawn the brain to resume the tool loop.
    let state = {
        let lock = runtime.sessions.lock().unwrap();
        let live = lock
            .get(&session_id)
            .ok_or_else(|| format!("session {session_id} not running"))?;
        live.state.clone()
    };
    let app_handle = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = brain::run_turn(app_handle.clone(), sid.clone(), state).await {
            let _ = app_handle.emit(
                &format!("manager-stream:{sid}"),
                &brain::StreamDelta::Error { message: e },
            );
        }
    });
    Ok(())
}

/// Replace the session's task list with a freshly-decomposed plan.
/// Used when the chat router (frontend-side, calls `aura plan`) wants
/// to populate or repopulate tasks. If `auto_resume` is true, also
/// flips the session to Running so the tick loop dispatches.
#[tauri::command]
pub async fn manager_set_tasks(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    tasks: Vec<ManagerTaskSpec>,
    auto_resume: bool,
) -> Result<(), String> {
    mutate(&runtime, &session_id, |s| {
        s.tasks = tasks
            .into_iter()
            .enumerate()
            .map(|(i, spec)| ManagerTask {
                id: i + 1,
                description: spec.description,
                agent_id: spec.agent_id,
                depends_on: spec.depends_on,
                status: ManagerTaskStatus::Pending,
                project_root: spec.project_root,
                zones: spec.zones,
                blocked_reason: None,
                output: String::new(),
                summary: None,
                started_at: None,
                completed_at: None,
                stream_channel: None,
                worktree_path: None,
                a2a_task_id: None,
                pre_dispatch_snapshot_ids: Vec::new(),
                recent_output: Vec::new(),
                line_count: 0,
            pending_skill: None,
            })
            .collect();
        if auto_resume {
            s.status = ManagerStatus::Running;
            s.push_ribbon(RibbonEvent::Resumed);
        }
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

/// What backend powers a given session — used by the Manager surface
/// to render a "Brain: Claude Code" chip in the header. `None` means the
/// session hasn't been used yet (no backend picked); the next chat
/// turn will auto-pick.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BrainBackendInfo {
    pub id: String,
    pub label: String,
}

#[tauri::command]
pub async fn manager_brain_info(
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
) -> Result<Option<BrainBackendInfo>, String> {
    let session = load_session(&runtime, &session_id).await?;
    Ok(session.brain_backend.as_ref().map(|b| BrainBackendInfo {
        id: b.id(),
        label: b.label(),
    }))
}

/// What brain would be picked right now if a fresh session opened — used
/// by the picker to show "Aura Manager (Claude Code)" so the user sees
/// what they're getting before sending a message.
#[tauri::command]
pub async fn manager_brain_detect() -> Result<Option<BrainBackendInfo>, String> {
    crate::blocking::run(|| {
        Ok(brain::BrainBackend::detect().map(|b| BrainBackendInfo {
            id: b.id(),
            label: b.label(),
        }))
    })
    .await
}

/// WW-B1 — set (or clear) this session's mid-conversation brain override.
/// A non-empty `provider_id` swaps the session onto that brain for
/// subsequent chat turns — the chat-header BrainPicker's choice — while
/// leaving the global active brain and every other session untouched.
/// `None`/empty clears the override back to the global active brain.
/// Persisted so the swap survives reload. The id is validated against the
/// live brain registry so a typo can't strand the session on a dead
/// brain. `brain_chat_turn` honors the same id per-turn for the native
/// path; this command is the durable record + the legacy path's source.
#[tauri::command]
pub async fn manager_set_brain_override(
    app: AppHandle,
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    provider_id: Option<String>,
) -> Result<(), String> {
    let normalized = provider_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if let Some(id) = normalized.as_deref() {
        let known = brain::registry::descriptors()
            .iter()
            .any(|d| d.provider_id == id);
        if !known {
            return Err(format!(
                "unknown brain `{id}` — not in the registry; pick one from manager_list_brains"
            ));
        }
    }
    mutate(&runtime, &session_id, |s| {
        s.brain_override = normalized.clone();
    })
    .await?;
    save_and_kick(&app, &runtime, &session_id).await;
    Ok(())
}

/// Render the exact prompt that would be sent to the agent for `task_id`
/// — same `build_prompt` the tick loop uses, including upstream relay
/// summaries. UI uses this to expand the "→ summary" edge between two
/// task cards into the full handover the downstream agent will see.
#[tauri::command]
pub async fn manager_preview_prompt(
    runtime: State<'_, ManagerRuntime>,
    session_id: String,
    task_id: usize,
) -> Result<String, String> {
    let session = load_session(&runtime, &session_id).await?;
    let task = session
        .task(task_id)
        .ok_or_else(|| format!("task {task_id} not found"))?;
    Ok(prompt::build_prompt(&session, task))
}

// ── Internals ──────────────────────────────────────────────────────────

async fn load_session(
    runtime: &State<'_, ManagerRuntime>,
    session_id: &str,
) -> Result<ManagerSession, String> {
    if let Some(live) = runtime.sessions.lock().unwrap().get(session_id) {
        return Ok(live.state.lock().unwrap().clone());
    }
    let session_id = session_id.to_string();
    crate::blocking::run(move || persist::load(&session_id)).await
}

async fn mutate<F>(
    runtime: &State<'_, ManagerRuntime>,
    session_id: &str,
    f: F,
) -> Result<(), String>
where
    F: FnOnce(&mut ManagerSession),
{
    let state = ensure_attached(runtime, session_id).await?;
    let mut s = state.lock().unwrap();
    f(&mut s);
    s.touch();
    Ok(())
}

/// Like `mutate` but returns a value the closure produces. Used when the
/// caller needs to extract state during the same lock the mutation
/// happens under (e.g. take pending_question + return it for spawn-after-
/// release).
async fn mutate_take<F, R>(
    runtime: &State<'_, ManagerRuntime>,
    session_id: &str,
    f: F,
) -> Result<R, String>
where
    F: FnOnce(&mut ManagerSession) -> R,
{
    let state = ensure_attached(runtime, session_id).await?;
    let mut s = state.lock().unwrap();
    let out = f(&mut s);
    s.touch();
    Ok(out)
}

async fn save_and_kick(
    app: &AppHandle,
    runtime: &State<'_, ManagerRuntime>,
    session_id: &str,
) {
    let (state, kick_tx) = {
        let lock = runtime.sessions.lock().unwrap();
        let Some(live) = lock.get(session_id) else {
            return;
        };
        (live.state.clone(), live.kick_tx.clone())
    };
    let snapshot = state.lock().unwrap().clone();
    let to_save = snapshot.clone();
    crate::blocking::run(move || {
        let _ = persist::save(&to_save);
    })
    .await;
    let _ = app.emit(&format!("manager:{session_id}"), &snapshot);
    let _ = kick_tx.send(());
}

/// Lazy-attach a Manager session into the runtime. Looks up the in-memory
/// `LiveSession`; if absent, loads the JSON from disk, spawns a fresh
/// `loop_session`, and inserts. Lets old sessions resume after a shell
/// restart — the user's first chat send populates the runtime instead of
/// erroring with "session not running". Returns the live `Arc<Mutex>`
/// state so the caller can mutate without re-locking the runtime map.
/// Put `live` in the map unless another caller attached the same session while
/// we were reading it off disk. Returns the state every caller has to share,
/// and whether we are the one that must start its pump.
///
/// Loading a session from disk is an await point, so two commands naming the
/// same not-yet-attached session can both miss the map and both build a
/// `LiveSession`. Inserting unconditionally evicts the first one: its caller
/// goes on mutating an `Arc` nothing else can reach, so its writes are never
/// seen or persisted, and two `loop_session` pumps end up driving one session
/// and emitting its events twice.
fn attach_or_adopt(
    sessions: &mut HashMap<String, LiveSession>,
    session_id: &str,
    live: LiveSession,
) -> (Arc<Mutex<ManagerSession>>, bool) {
    if let Some(existing) = sessions.get(session_id) {
        return (existing.state.clone(), false);
    }
    let state = live.state.clone();
    sessions.insert(session_id.to_string(), live);
    (state, true)
}

async fn ensure_attached(
    runtime: &State<'_, ManagerRuntime>,
    session_id: &str,
) -> Result<Arc<Mutex<ManagerSession>>, String> {
    if let Some(live) = runtime.sessions.lock().unwrap().get(session_id) {
        return Ok(live.state.clone());
    }
    let load_session_id = session_id.to_string();
    let session = crate::blocking::run(move || persist::load(&load_session_id))
        .await
        .map_err(|e| format!("session {session_id} not found on disk: {e}"))?;
    let (kick_tx, kick_rx) = mpsc::unbounded_channel();
    let live = LiveSession {
        state: Arc::new(Mutex::new(session)),
        in_flight: Arc::new(Mutex::new(HashMap::new())),
        kick_tx,
    };
    let in_flight = live.in_flight.clone();
    let (state, attached) = {
        let mut sessions = runtime.sessions.lock().unwrap();
        attach_or_adopt(&mut sessions, session_id, live)
    };
    if !attached {
        return Ok(state);
    }
    let app = runtime.app_handle.lock().unwrap().clone();
    let sid = session_id.to_string();
    if let Some(app) = app {
        tauri::async_runtime::spawn(loop_session(app, sid, state.clone(), in_flight, kick_rx));
    }
    // A session cold-loaded here (resumed after a shell restart) may pre-date
    // the live message-push code — seed its history to the cloud once so a
    // paired phone opening it doesn't show "No transcript synced yet". No-op if
    // already synced or signed out.
    ensure_transcript_backfilled(runtime, session_id);
    Ok(state)
}

async fn loop_session(
    app: AppHandle,
    session_id: String,
    state: Arc<Mutex<ManagerSession>>,
    in_flight: Arc<Mutex<HashMap<usize, String>>>,
    mut kick_rx: mpsc::UnboundedReceiver<()>,
) {
    let event_name = format!("manager:{session_id}");
    loop {
        let (status, complete) = {
            let s = state.lock().unwrap();
            (s.status, s.is_complete())
        };
        match status {
            ManagerStatus::Cancelled => break,
            ManagerStatus::Completed => break,
            ManagerStatus::AwaitingApproval | ManagerStatus::Paused => {
                tokio::select! {
                    _ = kick_rx.recv() => {},
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                }
                continue;
            }
            ManagerStatus::Running => {}
        }

        if complete {
            {
                let mut s = state.lock().unwrap();
                s.status = ManagerStatus::Completed;
                s.touch();
            }
            let snapshot = state.lock().unwrap().clone();
            let _ = persist::save(&snapshot);
            let _ = app.emit(&event_name, &snapshot);
            break;
        }

        let tick_out = {
            let s = state.lock().unwrap();
            let in_flight_lock = in_flight.lock().unwrap();
            tick::compute_tick(&s, &in_flight_lock, &registry())
        };

        // Paint transient zone-collision blocked_reasons so the DAG
        // shows why a task is queued. The reason is rewritten every
        // tick — when the blocker completes and clears in_flight, the
        // next compute_tick produces no entry for this task and we
        // wipe the reason so the task can dispatch.
        {
            let mut s = state.lock().unwrap();
            let mut changed = false;
            for t in s.tasks.iter_mut() {
                let new_reason: Option<String> = tick_out.zone_blocks.get(&t.id).map(|blocker| {
                    format!("zone collision with task #{blocker}")
                });
                let is_existing_zone_block = matches!(
                    &t.blocked_reason,
                    Some(r) if r.starts_with("zone collision with task")
                );
                match (&t.blocked_reason, &new_reason) {
                    (Some(cur), Some(new)) if cur != new => {
                        t.blocked_reason = new_reason.clone();
                        changed = true;
                    }
                    (None, Some(_)) => {
                        t.blocked_reason = new_reason.clone();
                        changed = true;
                    }
                    (Some(_), None) if is_existing_zone_block => {
                        // Blocker finished — clear our transient reason.
                        t.blocked_reason = None;
                        changed = true;
                    }
                    _ => {}
                }
            }
            if changed {
                s.touch();
                let snapshot = s.clone();
                drop(s);
                let _ = persist::save(&snapshot);
                let _ = app.emit(&event_name, &snapshot);
            }
        }

        for d in tick_out.dispatches {
            tauri::async_runtime::spawn(spawn_task(
                app.clone(),
                session_id.clone(),
                state.clone(),
                in_flight.clone(),
                d.task_id,
                d.provider_id,
            ));
        }

        tokio::select! {
            _ = kick_rx.recv() => {},
            _ = tokio::time::sleep(Duration::from_millis(500)) => {},
        }
    }
}

async fn spawn_task(
    app: AppHandle,
    session_id: String,
    state: Arc<Mutex<ManagerSession>>,
    in_flight: Arc<Mutex<HashMap<usize, String>>>,
    task_id: usize,
    provider_id: String,
) {
    let event_name = format!("manager:{session_id}");
    let channel = format!("manager-{}-{}", session_id, task_id);

    // Snapshot zones + project_root + description out of the lock so we
    // can do the async zone claim + sentinel announce without holding
    // the session mutex across an await point.
    let (zones, project_root, description) = {
        let s = state.lock().unwrap();
        let Some(task) = s.task(task_id) else {
            return;
        };
        (
            task.zones.clone(),
            task.project_root.clone(),
            task.description.clone(),
        )
    };

    // Pre-dispatch: claim zones the task plans to touch. On conflict,
    // mark the task Pending with a `blocked_reason` so the user can see
    // why it's stuck; the loop will retry on the next tick.
    let claim_label = format!("manager-{session_id}#{task_id}");
    if !zones.is_empty() {
        match team::claim_zones(&project_root, &zones, &claim_label).await {
            team::ClaimOutcome::Ok => {}
            team::ClaimOutcome::Conflict(reason) => {
                let mut s = state.lock().unwrap();
                if let Some(t) = s.task_mut(task_id) {
                    t.status = ManagerTaskStatus::Pending;
                    t.blocked_reason = Some(reason.clone());
                }
                // Best-effort claimer parse — first non-empty line.
                let claimer = reason.lines().next().unwrap_or("unknown").to_string();
                s.push_ribbon(RibbonEvent::ZoneCollision { task_id, claimer });
                s.touch();
                let snapshot = s.clone();
                drop(s);
                let _ = persist::save(&snapshot);
                let _ = app.emit(&event_name, &snapshot);
                return;
            }
        }
    }

    // Bucket L1 — pre-dispatch snapshot every file the subagent will
    // touch. We expand each glob in `task.zones` against project_root
    // and take a durable file-level snapshot per match before the
    // worktree branches off. The snapshot ids land on
    // `ManagerTask.pre_dispatch_snapshot_ids` so `aura rewind --task
    // <id>` can revert in one shot. Best-effort: missing files /
    // missing CLI fail soft (we still dispatch).
    let snapshot_ids =
        snapshot_zones_pre_dispatch(&project_root, &zones, &claim_label).await;
    let a2a_task_id_for_intent = {
        let s = state.lock().unwrap();
        s.task(task_id).and_then(|t| t.a2a_task_id.clone())
    };
    if !snapshot_ids.is_empty() {
        let mut s = state.lock().unwrap();
        if let Some(t) = s.task_mut(task_id) {
            t.pre_dispatch_snapshot_ids = snapshot_ids.clone();
        }
        s.touch();
    }

    // Bucket L2 — auto log-intent on dispatch. The brain's intent for
    // every fan-out lands in `.aura/intent_log.jsonl` so the user's
    // semantic timeline shows what the Manager *intended* to do for
    // each subagent, not just what the subagent itself committed.
    log_dispatch_intent(
        &project_root,
        &claim_label,
        task_id,
        &description,
        &zones,
        a2a_task_id_for_intent.as_deref(),
    );

    // Announce intent. Best-effort — if the broadcast fails the task
    // still proceeds. We don't block dispatch on team comms.
    team::announce(
        &project_root,
        &session_id,
        &format!("Aura Manager starting task #{task_id}: {description}"),
    )
    .await;

    // Worktree-per-task isolation (Stage 6 Track C). Tasks with declared
    // zones get their own sibling worktree so two subagents touching
    // adjacent files in the same wave don't trip over each other. If
    // creation fails (git missing, parent unwritable, ...) we fall back
    // to the main project_root — the task still runs, just without
    // isolation. Failure surfaces in `output` for post-mortem.
    let task_cwd = if !zones.is_empty() {
        match worktree::create(&project_root, &session_id, task_id) {
            Ok(path) => {
                let mut s = state.lock().unwrap();
                if let Some(t) = s.task_mut(task_id) {
                    t.worktree_path = Some(path.clone());
                }
                path
            }
            Err(e) => {
                eprintln!(
                    "[manager] worktree create failed for #{task_id}: {e} — falling back to main"
                );
                project_root.clone()
            }
        }
    } else {
        project_root.clone()
    };

    // Build prompt + invocation under lock, then drop and spawn.
    let invocation = {
        let mut s = state.lock().unwrap();
        let task = match s.task_mut(task_id) {
            Some(t) => t,
            None => return,
        };
        task.status = ManagerTaskStatus::Running;
        task.started_at = Some(now_secs());
        task.stream_channel = Some(channel.clone());
        task.blocked_reason = None;
        let prompt_text = prompt::build_prompt(&s, s.task(task_id).unwrap());
        let reg = registry();
        let provider = match reg.get(&provider_id) {
            Some(p) => p,
            None => {
                let t = s.task_mut(task_id).unwrap();
                t.status = ManagerTaskStatus::Failed;
                t.output = format!("provider '{provider_id}' missing from registry");
                return;
            }
        };
        let inv = match provider.build_invocation(&InvokeRequest {
            prompt: &prompt_text,
            mode: InvokeMode::OneShot,
            resume_session_id: None,
            attachments_via_stdin: false,
            effort: None,
            fast: false,
            model: None,
            approval: None,
        }) {
            Ok(mut i) => {
                // Enforce the fleet agent-CLI config policy (e.g. codex
                // service_tier repair) before this task dispatches.
                crate::agent_policy::apply_to_invocation(&provider_id, &mut i);
                i
            }
            Err(e) => {
                let t = s.task_mut(task_id).unwrap();
                t.status = ManagerTaskStatus::Failed;
                t.output = format!("build invocation: {e}");
                return;
            }
        };
        s.push_ribbon(RibbonEvent::TaskDispatched {
            task_id,
            agent_id: provider_id.clone(),
            channel: channel.clone(),
        });
        s.touch();
        Some(inv)
    };
    let Some(inv) = invocation else { return };
    // Spawn cwd is the per-task worktree if zones isolated, else the
    // main project root.
    let spawn_cwd = task_cwd.clone();

    in_flight.lock().unwrap().insert(task_id, provider_id.clone());

    // Snapshot + emit so UI sees Running before child returns.
    {
        let snapshot = state.lock().unwrap().clone();
        let _ = persist::save(&snapshot);
        let _ = app.emit(&event_name, &snapshot);
    }

    {
        let mut cmd = Command::new(&inv.bin);
        cmd.args(&inv.args)
            .current_dir(&spawn_cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in &inv.env {
            cmd.env(k, v);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                finalize_task(&app, &session_id, &state, &in_flight, task_id, None, format!("spawn: {e}"));
                return;
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stream_event = format!("agent-stream:{channel}");
        // Bucket O — per-task event channel consumed by the React DAG
        // TaskCard expanded view. Single channel feeds both stdout +
        // stderr ({stream, line, ts} payload).
        let task_stream_event = format!("manager-task-stream:{session_id}:{task_id}");
        // Bucket O — tail file the MCP `aura_subagent_monitor` reads.
        // Lives next to the session JSON so cross-process consumers
        // (aura-cli, teammate-relayed cloud sentinel) can pick it up
        // without an IPC dance.
        let tail_path = persist::sessions_dir().map(|d| d.join(format!("{session_id}-{task_id}.tail")));
        if let Some(p) = &tail_path {
            if let Some(parent) = p.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // Truncate any stale tail from a prior run with the same id.
            let _ = std::fs::write(p, b"");
        }
        let mut captured = String::new();

        async fn record_line(
            app: &AppHandle,
            agent_event: &str,
            task_event: &str,
            tail_path: &Option<std::path::PathBuf>,
            state: &Arc<Mutex<ManagerSession>>,
            task_id: usize,
            stream: &str,
            line: &str,
            captured: &mut String,
        ) {
            let display = if stream == "stderr" {
                format!("[stderr] {line}")
            } else {
                line.to_string()
            };
            captured.push_str(&display);
            captured.push('\n');
            let _ = app.emit(agent_event, &display);
            let _ = app.emit(
                task_event,
                serde_json::json!({
                    "stream": stream,
                    "line": line,
                    "ts": now_secs(),
                }),
            );
            if let Some(p) = tail_path {
                use std::io::Write as _;
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(p)
                {
                    let _ = writeln!(f, "{display}");
                }
            }
            // In-memory ring buffer — capped at 200 to bound the
            // session JSON. Counter is monotonic so the UI shows
            // "≈420 lines" even after the buffer rotates.
            let mut s = state.lock().unwrap();
            if let Some(t) = s.task_mut(task_id) {
                t.recent_output.push(display);
                if t.recent_output.len() > 200 {
                    let drain_to = t.recent_output.len() - 200;
                    t.recent_output.drain(..drain_to);
                }
                t.line_count = t.line_count.saturating_add(1);
            }
        }

        if let Some(out) = stdout {
            let app_clone = app.clone();
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                record_line(
                    &app_clone,
                    &stream_event,
                    &task_stream_event,
                    &tail_path,
                    &state,
                    task_id,
                    "stdout",
                    &line,
                    &mut captured,
                )
                .await;
            }
        }
        if let Some(err) = stderr {
            let app_clone = app.clone();
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                record_line(
                    &app_clone,
                    &stream_event,
                    &task_stream_event,
                    &tail_path,
                    &state,
                    task_id,
                    "stderr",
                    &line,
                    &mut captured,
                )
                .await;
            }
        }

        let exit = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        finalize_task(&app, &session_id, &state, &in_flight, task_id, Some(exit), captured);
    }

    // Post-completion: announce summary to teammates. Best-effort.
    let summary_for_announce = {
        let s = state.lock().unwrap();
        s.task(task_id)
            .and_then(|t| t.summary.clone())
            .unwrap_or_else(|| format!("task #{task_id} done"))
    };
    team::announce(
        &project_root,
        &session_id,
        &format!("Aura Manager finished task #{task_id}: {summary_for_announce}"),
    )
    .await;
}

fn finalize_task(
    app: &AppHandle,
    session_id: &str,
    state: &Arc<Mutex<ManagerSession>>,
    in_flight: &Arc<Mutex<HashMap<usize, String>>>,
    task_id: usize,
    exit_code: Option<i32>,
    captured: String,
) {
    let success;
    let parent_worktree: Option<String>;
    {
        let mut s = state.lock().unwrap();
        if let Some(t) = s.task_mut(task_id) {
            t.completed_at = Some(now_secs());
            t.output = captured.clone();
            // Cheap heuristic summary — first non-empty line trimmed
            // to 400 chars. Sufficient relay for downstream prompts;
            // a real summarizer call can replace this later.
            let summary: String = captured
                .lines()
                .find(|l| !l.trim().is_empty())
                .map(|l| l.chars().take(400).collect())
                .unwrap_or_default();
            t.summary = if summary.is_empty() { None } else { Some(summary) };
            success = matches!(exit_code, Some(0));
            t.status = if success { ManagerTaskStatus::Done } else { ManagerTaskStatus::Failed };

            // Bucket F1 — stash the partial skill outcome. Exit code +
            // duration are captured here at terminal time; thumbs,
            // pr-review pass, and brain self-eval grade arrive later
            // and amend `pending_skill` in place. The actual write to
            // `~/.aura/agent_skills.json` happens once those signals
            // either land or time out (Bucket F2/F3/F5).
            //
            // Token usage is parsed from the trailing
            // `[usage] input=X output=Y cost=$Z` line that
            // orchestrate.rs prints; missing line → zeros (the cell
            // shows "cost unknown" downstream).
            let duration_ms = match (t.started_at, t.completed_at) {
                (Some(s), Some(e)) if e >= s => (e - s).saturating_mul(1000),
                _ => 0,
            };
            let (token_input, token_output, cost_usd) =
                manager::skill::parse_usage_trailer(&captured).unwrap_or((0, 0, 0.0));
            // Also fold the agent's tokens into the repo-local, project-scoped
            // usage ledger (the local Cost & usage surface) — separate from the
            // cloud skill leaderboard the pending_skill row feeds. CLI agents
            // don't report their model here, so the ledger prices it at its sane
            // fallback; the token counts themselves are exact.
            if token_input > 0 || token_output > 0 {
                let usage_session = t
                    .a2a_task_id
                    .clone()
                    .unwrap_or_else(|| format!("{}-t{}", session_id, t.id));
                let usage_agent =
                    t.agent_id.clone().unwrap_or_else(|| "agent".to_string());
                crate::cmd_brain_chat::record_turn_usage_async(
                    &t.project_root,
                    &usage_session,
                    &usage_agent,
                    None,
                    token_input,
                    token_output,
                );
            }
            let taxonomy = manager::skill::derive_taxonomy(
                &t.description,
                &t.zones,
                &[],
            );
            // Repo slug for per-repo skill leaderboards. GitHub remotes
            // only; local repos resolve to None → cloud stores NULL.
            let repo_slug = crate::cloud_session_sync::resolve_repo_full_name(
                std::path::Path::new(&t.project_root),
            );
            t.pending_skill = Some(manager::skill::PartialSkillOutcome {
                provider_id: t.agent_id.clone().unwrap_or_default(),
                manager_session_id: session_id.to_string(),
                manager_task_id: t.id,
                a2a_task_id: t.a2a_task_id.clone(),
                exit_code,
                duration_ms: Some(duration_ms),
                user_rating: None,
                pr_review_pass: None,
                token_input,
                token_output,
                cost_usd,
                brain_quality_grade: None,
                brain_quality_reason: None,
                taxonomy,
                scout_run_id: None,
                repo: repo_slug,
                started_at: t.started_at.unwrap_or(0),
            });
        } else {
            success = false;
        }
        parent_worktree = s
            .task(task_id)
            .and_then(|t| t.worktree_path.clone());
        let event = match exit_code {
            Some(c) if c == 0 => RibbonEvent::TaskCompleted { task_id, exit_code: c },
            Some(c) => RibbonEvent::TaskFailed {
                task_id,
                error: format!("exit {c}"),
            },
            None => RibbonEvent::TaskFailed {
                task_id,
                error: "spawn failed".into(),
            },
        };
        s.push_ribbon(event);

        // Aura semantic guard: scan the subagent's captured output for
        // the deletion-guard signature so the user sees inline what
        // Aura caught. Strict mode → commit blocked; non-strict →
        // warning only. Either way the alert surfaces in chat. We
        // detect on the printed banner ("Logic Node Deletion Guard: N
        // logic nodes REMOVED") plus the bullet list and pass both up
        // as `RibbonEvent::SemanticAlert`. Quiet on clean diffs.
        if let Some((deletions, reason)) = scan_deletion_guard(&captured) {
            s.push_ribbon(RibbonEvent::SemanticAlert {
                task_id,
                deletions,
                reason,
            });
        }
    }
    in_flight.lock().unwrap().remove(&task_id);

    // jj-style auto-rebase: if this task succeeded and its worktree
    // exists, rebase every in-flight downstream task's worktree onto
    // the new tip so cross-agent piping doesn't go stale. Conflicts
    // mark the downstream task `blocked_reason` and emit RebaseConflict.
    if success {
        rebase_descendants(state, task_id, parent_worktree.as_deref());
    }

    let snapshot = state.lock().unwrap().clone();
    let _ = persist::save(&snapshot);
    let _ = app.emit(&format!("manager:{session_id}"), &snapshot);

    // Bucket F3 + F5 — fire the post-task signal capture in a detached
    // tokio task. Two stages:
    //   1. pr_review_for_branch (worktree only; skipped when the task
    //      ran in the main repo root).
    //   2. grade_brain — `claude -p` with the grading prompt; 60s cap.
    // After both finish (or time out) we commit the SkillOutcome to
    // the local store via `skill::append_local`; the 30s flush ticker
    // pushes it to the cloud later. Detached so the dispatch loop
    // doesn't block on a slow grader.
    spawn_skill_finalizer(app.clone(), state.clone(), session_id.to_string(), task_id);
}

/// Bucket F3 + F5 — detached tokio task: PR-review pass → brain
/// self-eval grade → write the row. Bails out (silently) if the task's
/// `pending_skill` was never set (legacy session) or the agent_id is
/// empty (shouldn't happen post-F1 but cheap to guard).
fn spawn_skill_finalizer(
    app: AppHandle,
    state: Arc<Mutex<ManagerSession>>,
    session_id: String,
    task_id: usize,
) {
    tokio::spawn(async move {
        // Snapshot what F1 stashed so we don't hold the mutex across
        // the (potentially minute-long) shells.
        let (mut partial, description, zones, captured, worktree_path) = {
            let s = state.lock().unwrap();
            let Some(t) = s.task(task_id) else { return };
            let Some(p) = t.pending_skill.clone() else { return };
            (
                p,
                t.description.clone(),
                t.zones.clone(),
                t.output.clone(),
                t.worktree_path.clone(),
            )
        };

        // F3 — PR review. Only attempt when the task ran in its own
        // worktree; main-repo runs share the user's working tree and
        // pr-review is non-deterministic over a multi-task diff.
        if let Some(wt) = worktree_path.as_deref() {
            let base = std::env::var("AURA_PR_REVIEW_BASE")
                .unwrap_or_else(|_| "main".to_string());
            let pass = manager::skill::pr_review_for_branch(wt, &base).await;
            partial.pr_review_pass = pass;
            // Mid-flight write so the UI ribbon reflects the partial
            // signal even if the grader stalls.
            {
                let mut s = state.lock().unwrap();
                if let Some(t) = s.task_mut(task_id) {
                    if let Some(slot) = t.pending_skill.as_mut() {
                        slot.pr_review_pass = pass;
                    }
                }
            }
        }

        // F5 — brain self-eval. None on timeout / parse fail; we still
        // commit the outcome with grade=NULL + reason=grader-timeout.
        let exit = partial.exit_code;
        let dur = partial.duration_ms.unwrap_or(0);
        let pr_pass = partial.pr_review_pass;
        let graded = manager::skill::grade_brain(
            &description,
            &zones,
            exit,
            dur,
            pr_pass,
            &captured,
        )
        .await;
        match graded {
            Some((g, r)) => {
                partial.brain_quality_grade = Some(g);
                partial.brain_quality_reason = Some(r);
            }
            None => {
                partial.brain_quality_grade = None;
                partial.brain_quality_reason = Some("grader timeout".to_string());
            }
        }
        // Re-read the in-memory partial so we pick up any rating
        // (Bucket F2) the user landed during the grader window.
        let final_outcome = {
            let mut s = state.lock().unwrap();
            if let Some(t) = s.task_mut(task_id) {
                if let Some(slot) = t.pending_skill.as_mut() {
                    slot.pr_review_pass = partial.pr_review_pass;
                    slot.brain_quality_grade = partial.brain_quality_grade;
                    slot.brain_quality_reason = partial.brain_quality_reason.clone();
                    slot.clone()
                } else {
                    partial.clone()
                }
            } else {
                partial.clone()
            }
        };

        if final_outcome.ready_for_write() {
            let outcome = final_outcome.into_complete();
            let _ = manager::skill::append_local(outcome);
        }

        // Persist the session snapshot one more time so the UI sees
        // the final pr/grade state on next reload.
        let snapshot = state.lock().unwrap().clone();
        let _ = persist::save(&snapshot);
        let _ = app.emit(&format!("manager:{session_id}"), &snapshot);
    });
}

fn rebase_descendants(
    state: &Arc<Mutex<ManagerSession>>,
    parent_id: usize,
    parent_worktree: Option<&str>,
) {
    let parent_wt = match parent_worktree {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => return,
    };
    // Resolve the parent worktree's HEAD ref to use as the rebase
    // target. Prefer the branch name (so rebase respects upstream),
    // fall back to the sha. If neither resolves, skip silently.
    let onto_ref = match resolve_head_ref(&parent_wt) {
        Some(r) => r,
        None => return,
    };

    // Collect downstream candidates under a short lock.
    let candidates: Vec<(usize, String)> = {
        let s = state.lock().unwrap();
        s.tasks
            .iter()
            .filter(|t| t.depends_on.contains(&parent_id))
            .filter(|t| matches!(
                t.status,
                ManagerTaskStatus::Pending | ManagerTaskStatus::Running
            ))
            .filter_map(|t| t.worktree_path.clone().map(|p| (t.id, p)))
            .collect()
    };

    for (child_id, wt) in candidates {
        let out = std::process::Command::new("git")
            .args(["rebase", &onto_ref])
            .current_dir(&wt)
            .output();
        let (exit, conflicted) = match out {
            Ok(o) => {
                let exit = o.status.code().unwrap_or(-1);
                let mut conflicts = Vec::new();
                if exit != 0 {
                    if let Ok(d) = std::process::Command::new("git")
                        .args(["diff", "--name-only", "--diff-filter=U"])
                        .current_dir(&wt)
                        .output()
                    {
                        for line in String::from_utf8_lossy(&d.stdout).lines() {
                            let t = line.trim();
                            if !t.is_empty() {
                                conflicts.push(t.to_string());
                            }
                        }
                    }
                }
                (exit, conflicts)
            }
            Err(_) => continue,
        };
        if exit == 0 {
            continue;
        }
        let mut s = state.lock().unwrap();
        if let Some(t) = s.task_mut(child_id) {
            let summary = if conflicted.is_empty() {
                format!("rebase_conflict (exit {exit})")
            } else {
                format!("rebase_conflict on {}", conflicted.join(", "))
            };
            t.blocked_reason = Some(summary);
        }
        s.push_ribbon(RibbonEvent::RebaseConflict {
            task_id: child_id,
            onto_ref: onto_ref.clone(),
            files: conflicted,
        });
    }
}

fn resolve_head_ref(worktree: &str) -> Option<String> {
    // Try symbolic-ref first so the rebase target is the branch name
    // (matches user mental model). Fall back to short sha for detached
    // HEAD. We DON'T fall back to long sha because rebase prefers the
    // ref form when one exists.
    let sym = std::process::Command::new("git")
        .args(["symbolic-ref", "--short", "-q", "HEAD"])
        .current_dir(worktree)
        .output()
        .ok()?;
    if sym.status.success() {
        let s = String::from_utf8_lossy(&sym.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    let sha = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(worktree)
        .output()
        .ok()?;
    if !sha.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&sha.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Scan the subagent's captured output for the Aura deletion-guard
/// signature ("Logic Node Deletion Guard: N logic nodes REMOVED" plus
/// bullet items shaped `✗ N. <name>`). Returns the parsed deletion
/// list + a short reason string when the guard fired, None otherwise.
/// Pure parsing, no IO. Tested in-module.
fn scan_deletion_guard(output: &str) -> Option<(Vec<String>, String)> {
    if !output.contains("Logic Node Deletion Guard") {
        return None;
    }
    let mut deletions = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        // Guard prints rows like "  ✗ 1. some_function" possibly with
        // ANSI colour codes around the marker. Match on the dot-numbered
        // shape after the cross.
        if let Some(rest) = trimmed.split_once("✗") {
            let after = rest.1.trim();
            if let Some((idx, name)) = after.split_once(". ") {
                if idx.trim().chars().all(|c| c.is_ascii_digit()) {
                    let cleaned = strip_ansi(name).trim().to_string();
                    if !cleaned.is_empty() {
                        deletions.push(cleaned);
                    }
                }
            }
        }
    }
    if deletions.is_empty() {
        return None;
    }
    let strict = output.contains("Commit halted") || output.contains("Commit cancelled");
    let reason = if strict {
        "strict mode blocked the commit".to_string()
    } else {
        "warning — strict mode off, commit proceeded".to_string()
    };
    Some((deletions, reason))
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // Skip until the next 'm' (terminates SGR escape).
            for n in chars.by_ref() {
                if n == 'm' {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod plan_approval_tests {
    use super::{apply_plan_approval, PlanApproval};
    use crate::manager::{ManagerSession, PendingPlan, PlanParallelism};

    fn empty_plan(id: &str) -> PendingPlan {
        PendingPlan {
            id: id.into(),
            title: "T".into(),
            summary: String::new(),
            objective: None,
            baseline: None,
            architecture_mermaid: None,
            phases: vec![],
            deliverables: vec![],
            tests: vec![],
            todos: vec![],
            parallelism: PlanParallelism::Auto,
            approved_by: None,
            approved_at: None,
            at: 1_700_000_000,
        }
    }

    fn session_with(plan: Option<PendingPlan>) -> ManagerSession {
        let mut s = ManagerSession::new("sid".into(), "obj".into(), vec![], vec![]);
        s.pending_plan = plan;
        s
    }

    #[test]
    fn stamps_handle_and_timestamp() {
        let mut s = session_with(Some(empty_plan("p1")));
        let out = apply_plan_approval(&mut s, "p1", "alice@example.com", 1_700_001_000).unwrap();
        let PlanApproval { approved_by, approved_at } = out;
        assert_eq!(approved_by, "alice@example.com");
        assert_eq!(approved_at, 1_700_001_000);
        let plan = s.pending_plan.as_ref().unwrap();
        assert_eq!(plan.approved_by.as_deref(), Some("alice@example.com"));
        assert_eq!(plan.approved_at, Some(1_700_001_000));
    }

    #[test]
    fn trims_whitespace_and_rejects_empty() {
        let mut s = session_with(Some(empty_plan("p1")));
        let trimmed = apply_plan_approval(&mut s, "p1", "  bob  ", 42).unwrap();
        assert_eq!(trimmed.approved_by, "bob");

        let mut s2 = session_with(Some(empty_plan("p1")));
        let err = apply_plan_approval(&mut s2, "p1", "   ", 42).unwrap_err();
        assert!(err.contains("empty"), "expected empty-handle error, got: {err}");
        assert!(s2.pending_plan.as_ref().unwrap().approved_by.is_none());
    }

    #[test]
    fn errors_when_no_pending_plan() {
        let mut s = session_with(None);
        let err = apply_plan_approval(&mut s, "p1", "alice", 1).unwrap_err();
        assert!(err.contains("no pending plan"), "got: {err}");
    }

    #[test]
    fn errors_on_plan_id_mismatch() {
        let mut s = session_with(Some(empty_plan("p1")));
        let err = apply_plan_approval(&mut s, "other-id", "alice", 1).unwrap_err();
        assert!(err.contains("mismatch"), "got: {err}");
        // The stored plan must remain untouched on mismatch.
        let plan = s.pending_plan.as_ref().unwrap();
        assert!(plan.approved_by.is_none());
        assert!(plan.approved_at.is_none());
    }

    #[test]
    fn idempotent_repeat_updates_timestamp() {
        let mut s = session_with(Some(empty_plan("p1")));
        apply_plan_approval(&mut s, "p1", "alice", 100).unwrap();
        let second = apply_plan_approval(&mut s, "p1", "bob", 200).unwrap();
        assert_eq!(second.approved_by, "bob");
        assert_eq!(second.approved_at, 200);
        let plan = s.pending_plan.as_ref().unwrap();
        assert_eq!(plan.approved_by.as_deref(), Some("bob"));
        assert_eq!(plan.approved_at, Some(200));
    }
}

#[cfg(test)]
mod attach_tests {
    use super::{attach_or_adopt, LiveSession};
    use crate::manager::ManagerSession;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::sync::mpsc;

    /// A freshly loaded session, the way `ensure_attached` builds one.
    fn live(id: &str) -> LiveSession {
        let (kick_tx, _kick_rx) = mpsc::unbounded_channel();
        LiveSession {
            state: Arc::new(Mutex::new(ManagerSession::new(
                id.to_string(),
                "objective".to_string(),
                Vec::new(),
                Vec::new(),
            ))),
            in_flight: Arc::new(Mutex::new(HashMap::new())),
            kick_tx,
        }
    }

    #[test]
    fn the_first_caller_attaches_and_owns_the_pump() {
        let mut sessions = HashMap::new();
        let mine = live("s1");
        let mine_state = mine.state.clone();
        let (state, attached) = attach_or_adopt(&mut sessions, "s1", mine);
        assert!(attached, "nothing was attached, so this caller starts the pump");
        assert!(Arc::ptr_eq(&state, &mine_state));
        assert!(sessions.contains_key("s1"));
    }

    #[test]
    fn a_caller_that_lost_the_race_adopts_the_attached_session() {
        // Both callers missed the map and both read the session off disk; the
        // other one got back first.
        let mut sessions = HashMap::new();
        let winner = live("s1");
        let winning_state = winner.state.clone();
        sessions.insert("s1".to_string(), winner);

        let (state, attached) = attach_or_adopt(&mut sessions, "s1", live("s1"));
        assert!(!attached, "someone else is already pumping this session");
        assert!(
            Arc::ptr_eq(&state, &winning_state),
            "must hand back the state the winner attached, not our own copy",
        );
    }

    #[test]
    fn losing_the_race_leaves_the_attached_session_in_place() {
        let mut sessions = HashMap::new();
        let winner = live("s1");
        let winning_state = winner.state.clone();
        sessions.insert("s1".to_string(), winner);
        attach_or_adopt(&mut sessions, "s1", live("s1"));
        assert!(
            Arc::ptr_eq(&sessions["s1"].state, &winning_state),
            "the loser must not evict the session everyone else can see",
        );
    }

    #[test]
    fn what_the_loser_writes_reaches_the_caller_that_won() {
        // The failure this prevents is a lost write. The winner is still
        // holding its own `Arc` and goes on reading it; if the loser is handed
        // a different `Arc`, everything the loser does is stranded there.
        // Asserting through the map instead would prove nothing — an
        // unconditional insert puts the loser's copy in the map, so the map
        // agrees with itself either way.
        let mut sessions = HashMap::new();
        let winner = live("s1");
        let winners_handle = winner.state.clone();
        sessions.insert("s1".to_string(), winner);

        let (state, _) = attach_or_adopt(&mut sessions, "s1", live("s1"));
        state.lock().unwrap().objective = "changed".to_string();
        assert_eq!(
            winners_handle.lock().unwrap().objective, "changed",
            "a write that never reaches the caller that won is a lost write",
        );
    }

    #[test]
    fn a_different_session_still_attaches() {
        let mut sessions = HashMap::new();
        sessions.insert("s1".to_string(), live("s1"));
        let (_, attached) = attach_or_adopt(&mut sessions, "s2", live("s2"));
        assert!(attached);
        assert_eq!(sessions.len(), 2);
    }
}

#[cfg(test)]
mod scan_deletion_guard_tests {
    use super::scan_deletion_guard;

    #[test]
    fn quiet_on_clean_output() {
        assert!(scan_deletion_guard("commit succeeded\n").is_none());
        assert!(scan_deletion_guard("").is_none());
    }

    #[test]
    fn parses_strict_block() {
        let sample = "\n🛡️ Logic Node Deletion Guard: 2 logic nodes REMOVED\n  Missing:\n    ✗ 1. validate_email\n    ✗ 2. parse_token\n\n✗ Commit halted. 2 logic nodes would be lost.\n";
        let (dels, reason) = scan_deletion_guard(sample).unwrap();
        assert_eq!(dels, vec!["validate_email", "parse_token"]);
        assert!(reason.contains("strict mode blocked"));
    }

    #[test]
    fn parses_warn_only() {
        let sample = "🛡️ Logic Node Deletion Guard: 1 logic nodes REMOVED\n    ✗ 1. drop_user\n  ⚠️ Strict mode is OFF. Proceeding with warning.\n";
        let (dels, reason) = scan_deletion_guard(sample).unwrap();
        assert_eq!(dels, vec!["drop_user"]);
        assert!(reason.contains("warning"));
    }
}

#[cfg(test)]
mod conversation_search_tests {
    use super::search_snippet;

    #[test]
    fn finds_case_insensitive_matching_line() {
        let hit = search_snippet("first line\n  Fix OAuth Refresh now  \nlast", "oauth refresh");
        assert_eq!(hit.as_deref(), Some("Fix OAuth Refresh now"));
    }

    #[test]
    fn clamps_long_snippets_on_character_boundaries() {
        let text = format!("needle {}", "é".repeat(300));
        let hit = search_snippet(&text, "needle").unwrap();
        assert_eq!(hit.chars().count(), 220);
        assert!(hit.ends_with('…'));
    }
}
