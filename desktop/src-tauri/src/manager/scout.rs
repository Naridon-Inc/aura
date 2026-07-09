//! Aura Scout — pre-build architectural review pass.
//!
//! When the brain emits a `propose_plan` envelope that crosses the
//! complexity threshold (≥3 file refs OR a new-feature deliverable),
//! `cmd_permission_socket::handle_propose_plan` calls
//! [`start_scout`] instead of going straight to PlanCard. We:
//!
//!   1. Set `pending_scout` on the session (status Spawning).
//!   2. Fan out 3 `claude -p` specialists in parallel (Architecture,
//!      Security, UX), each with its own prompt template and stdout
//!      stream.
//!   3. Parse each specialist's closing fenced ```json``` block into a
//!      `SpecialistRun` (graceful degrade: malformed JSON → summary
//!      only, no findings).
//!   4. Append each specialist's one-line summary as a chat-system
//!      bubble so the user sees findings flow into the thread alongside
//!      the live ScoutCard.
//!   5. Promote the original (annotated) plan draft into
//!      `pending_plan`, which fires the existing PlanCard render.
//!
//! The brain's `aura propose-plan` process stays parked on the same
//! `pending_plans` waiter that the legacy direct-PlanCard path uses —
//! so Build/Cancel resolves the bridge identically once Scout finishes.
//!
//! MVP per plan §15 — single-pass: we don't run the C1-C4 grouped Q&A
//! consolidation loop yet. Q&A waves are a follow-up; the data shapes
//! (`QaWave`, `SpecialistQuestion`) are already wired through
//! `manager::mod` so the wave dispatcher can be added without
//! reshaping state.

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::cli_bridge::ProposePlanPayload;
use crate::manager::skill::{ScoutFinding, Severity};
use crate::manager::{
    ChatRole, ManagerSession, PendingScout, ScoutStatus, SpecialistKind, SpecialistQuestion,
    SpecialistRun, SpecialistStatus,
};

const ARCH_TEMPLATE: &str = include_str!("../../templates/scout/arch.md");
const SECURITY_TEMPLATE: &str = include_str!("../../templates/scout/security.md");
const UX_TEMPLATE: &str = include_str!("../../templates/scout/ux.md");

const ALL_KINDS: [SpecialistKind; 3] = [
    SpecialistKind::Architecture,
    SpecialistKind::Security,
    SpecialistKind::Ux,
];

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Default per-specialist wall-clock cap. A single `claude -p` from a
/// repo root can take a while on a cold start (CLAUDE.md load, model
/// warm-up), and three run concurrently, so the ceiling is generous. We
/// keep MCP cold-boot out of the loop via `--strict-mcp-config` below,
/// which is what actually keeps each run snappy.
const DEFAULT_SPECIALIST_TIMEOUT_SECS: u64 = 180;

/// Per-specialist wall-clock cap, overridable via the
/// `AURA_SCOUT_SPECIALIST_TIMEOUT_SECS` env var. Clamped to a sane
/// floor so a stray `0`/garbage value can't make every specialist
/// instantly "skip". A timeout is a soft degrade, never a build block.
fn specialist_timeout_secs() -> u64 {
    std::env::var("AURA_SCOUT_SPECIALIST_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v >= 10)
        .unwrap_or(DEFAULT_SPECIALIST_TIMEOUT_SECS)
}

/// Whether the `claude` CLI is on PATH. Scout shells `claude -p` per
/// specialist; if the binary isn't installed there's no point spawning
/// three processes just to watch them all fail with a spawn error — we
/// degrade the whole pass to a calm "skipped" up front instead.
fn claude_binary_available() -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(probe)
        .arg("claude")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Fast model for the specialist pass. Scout is a quick advisory review,
/// not deep work, so we pin Haiku to keep all three runs cheap and well
/// inside the timeout. (Same id already used elsewhere in the app.)
const SCOUT_MODEL: &str = "claude-haiku-4-5-20251001";

fn template_for(kind: SpecialistKind) -> &'static str {
    match kind {
        SpecialistKind::Architecture => ARCH_TEMPLATE,
        SpecialistKind::Security => SECURITY_TEMPLATE,
        SpecialistKind::Ux => UX_TEMPLATE,
    }
}

fn label_for(kind: SpecialistKind) -> &'static str {
    match kind {
        SpecialistKind::Architecture => "arch",
        SpecialistKind::Security => "security",
        SpecialistKind::Ux => "ux",
    }
}

/// Render the prompt template for a specialist with the draft plan
/// fields substituted. Placeholders use the brace style
/// `{title}`, `{summary}`, `{file_refs_listing}`, `{project_root}`.
fn render_prompt(kind: SpecialistKind, plan: &ProposePlanPayload, project_root: &str) -> String {
    let mut all_refs: Vec<&String> = Vec::new();
    for phase in &plan.phases {
        for r in &phase.file_refs {
            all_refs.push(r);
        }
    }
    for todo in &plan.todos {
        for r in &todo.file_refs {
            all_refs.push(r);
        }
    }
    let listing = if all_refs.is_empty() {
        "(none specified)".to_string()
    } else {
        all_refs
            .iter()
            .map(|r| format!("- {r}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    template_for(kind)
        .replace("{title}", &plan.title)
        .replace("{summary}", &plan.summary)
        .replace("{file_refs_listing}", &listing)
        .replace("{project_root}", project_root)
}

/// Kick off a Scout pass for the given draft plan. Sets `pending_scout`
/// to Spawning, spawns the 3 specialists in a detached tokio task, and
/// returns Ok(()) immediately. The detached task drives state updates
/// and finally promotes the draft into `pending_plan`. On any failure
/// inside the detached task we fall back to promoting the draft as-is
/// so the user is never permanently stuck on a Scout card.
pub async fn start_scout(
    app: &AppHandle,
    session_id: &str,
    request_id: String,
    plan_draft: ProposePlanPayload,
) -> Result<(), String> {
    let scout_id = format!("scout-{}", uuid::Uuid::new_v4());
    let project_root = session_project_root(app, session_id).unwrap_or_else(|| ".".to_string());

    let initial = PendingScout {
        id: scout_id.clone(),
        request_id: request_id.clone(),
        plan_draft: plan_draft.clone(),
        status: ScoutStatus::Spawning,
        specialists: ALL_KINDS
            .iter()
            .map(|k| SpecialistRun {
                kind: *k,
                status: SpecialistStatus::Pending,
                summary: String::new(),
                findings: Vec::new(),
                questions: Vec::new(),
                started_at: None,
                completed_at: None,
                exit_code: None,
            })
            .collect(),
        qa_wave: None,
        waves_run: 0,
        consolidated_notes: String::new(),
        created_at: now_secs(),
    };
    set_pending_scout(app, session_id, Some(initial))?;

    let app_owned = app.clone();
    let sid = session_id.to_string();
    tokio::spawn(async move {
        if let Err(e) =
            run_specialists_and_finalize(&app_owned, &sid, &scout_id, &project_root, plan_draft)
                .await
        {
            eprintln!("aura-shell: scout run failed: {e}");
            // Hard fall-back (lock poisoned / session gone mid-run):
            // clear pending_scout so the user is never stuck on a spinner,
            // and try to promote the draft anyway so Build still appears.
            // Detail goes to the log, not an alarming chat bubble.
            let promoted = finalize_scout(&app_owned, &sid, &scout_id, String::new());
            if promoted.is_err() {
                let _ = set_pending_scout(&app_owned, &sid, None);
            }
        }
    });

    Ok(())
}

/// Detached driver — runs all 3 specialists, parses their output,
/// records each one's findings into `pending_scout`, then promotes
/// the draft plan into `pending_plan` so the existing Build/Cancel
/// path takes over.
async fn run_specialists_and_finalize(
    app: &AppHandle,
    session_id: &str,
    scout_id: &str,
    project_root: &str,
    plan_draft: ProposePlanPayload,
) -> Result<(), String> {
    update_scout_status(app, session_id, scout_id, ScoutStatus::Running)?;

    // No `claude` on PATH → there's nothing to run. Mark every reviewer
    // as cleanly skipped and promote the plan straight through. The user
    // sees a quiet "review skipped" row, never an error wall, and Build
    // is never blocked on a tool that isn't installed.
    if !claude_binary_available() {
        for kind in ALL_KINDS {
            let skipped = SpecialistRun {
                kind,
                status: SpecialistStatus::Failed,
                summary: "skipped — code reviewer not available".to_string(),
                findings: Vec::new(),
                questions: Vec::new(),
                started_at: None,
                completed_at: Some(now_secs()),
                exit_code: None,
            };
            write_specialist_run(app, session_id, scout_id, skipped);
        }
        update_scout_status(app, session_id, scout_id, ScoutStatus::Finalizing)?;
        finalize_scout(app, session_id, scout_id, String::new())?;
        return Ok(());
    }

    let arch = run_one_specialist(
        app,
        session_id,
        scout_id,
        SpecialistKind::Architecture,
        project_root,
        &plan_draft,
    );
    let sec = run_one_specialist(
        app,
        session_id,
        scout_id,
        SpecialistKind::Security,
        project_root,
        &plan_draft,
    );
    let ux = run_one_specialist(
        app,
        session_id,
        scout_id,
        SpecialistKind::Ux,
        project_root,
        &plan_draft,
    );
    let (arch_run, sec_run, ux_run) = tokio::join!(arch, sec, ux);

    let runs = vec![arch_run, sec_run, ux_run];
    // Only fold *completed* reviewers' notes into the plan. A skipped /
    // timed-out reviewer carries a calm "skipped …" line for the card,
    // but that's UI chrome — it must not leak into the plan's summary.
    let consolidated_notes = runs
        .iter()
        .filter(|r| r.status == SpecialistStatus::Done && !r.summary.is_empty())
        .map(|r| format!("[{}] {}", label_for(r.kind), r.summary))
        .collect::<Vec<_>>()
        .join("\n");

    update_scout_status(app, session_id, scout_id, ScoutStatus::Finalizing)?;
    finalize_scout(app, session_id, scout_id, consolidated_notes)?;
    Ok(())
}

/// Run one specialist subprocess: shell `claude -p` with the rendered
/// prompt, stream stdout (mirror per-line into Tauri event for the
/// ScoutCard), capture all of it, and parse the closing fenced JSON
/// block. On any subprocess failure (binary missing, non-zero exit,
/// timeout) returns a Failed `SpecialistRun` with the captured stderr
/// in `summary` so the user sees what went wrong.
async fn run_one_specialist(
    app: &AppHandle,
    session_id: &str,
    scout_id: &str,
    kind: SpecialistKind,
    project_root: &str,
    plan: &ProposePlanPayload,
) -> SpecialistRun {
    let started_at = now_secs();
    mark_specialist_status(
        app,
        session_id,
        scout_id,
        kind,
        SpecialistStatus::Running,
        Some(started_at),
        None,
        None,
    );

    let prompt = render_prompt(kind, plan, project_root);
    let event_channel = format!("manager-scout-stream:{session_id}:{}", label_for(kind));

    // Per-specialist wall-clock cap (env-overridable, generous default).
    // It's a soft ceiling: hitting it degrades this one reviewer to a
    // calm "skipped", it never blocks the build or the other reviewers.
    let timeout_secs = specialist_timeout_secs();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        spawn_and_capture(app, &event_channel, project_root, &prompt),
    )
    .await;

    let (stdout, exit_code, error_text, timed_out) = match result {
        Ok(Ok((out, code))) => (out, Some(code), None, false),
        Ok(Err(e)) => (String::new(), None, Some(e), false),
        Err(_) => (String::new(), None, None, true),
    };

    let parsed = parse_specialist_output(&stdout, kind);
    let mut run = SpecialistRun {
        kind,
        status: SpecialistStatus::Done,
        summary: parsed.summary,
        findings: parsed.findings,
        questions: parsed.questions,
        started_at: Some(started_at),
        completed_at: Some(now_secs()),
        exit_code,
    };

    // Degrade paths — each one lands a calm "skipped …" summary (the
    // word "skipped" is what the card uses to render the quiet amber
    // state) rather than an alarming error. None of these block Build.
    let nonzero_exit = exit_code.map(|c| c != 0).unwrap_or(true);
    if timed_out {
        run.status = SpecialistStatus::Failed;
        if run.findings.is_empty() {
            run.summary = format!("skipped — review took longer than {timeout_secs}s");
        }
    } else if error_text.is_some() {
        run.status = SpecialistStatus::Failed;
        if run.summary.is_empty() {
            run.summary = "skipped — couldn't reach the code reviewer".to_string();
        }
    } else if nonzero_exit && run.findings.is_empty() && run.summary.is_empty() {
        run.status = SpecialistStatus::Failed;
        run.summary = "skipped — reviewer returned nothing usable".to_string();
    }

    // Mirror only *real* findings into the chat thread (plan §B5). A
    // skip is UI chrome on the card; surfacing "[arch] skipped …" as its
    // own chat bubble would be noise, so completed reviewers only.
    if run.status == SpecialistStatus::Done && !run.summary.is_empty() {
        append_chat_system(
            app,
            session_id,
            format!("[{}] {}", label_for(kind), run.summary),
        );
    }

    write_specialist_run(app, session_id, scout_id, run.clone());
    run
}

/// Spawn `claude -p ...` in `project_root`, mirror each stdout line
/// into a Tauri event, and return (full_stdout, exit_code) on
/// completion. Errors only on subprocess-spawn failure (missing
/// binary, permissions); a non-zero exit still returns Ok with the
/// captured output so the caller can decide how to render the failure.
async fn spawn_and_capture(
    app: &AppHandle,
    event_channel: &str,
    project_root: &str,
    prompt: &str,
) -> Result<(String, i32), String> {
    // `--strict-mcp-config` + an explicit empty `--mcp-config {}` keep
    // this run from cold-booting the repo's MCP servers (aura-vcs etc.)
    // and loading the project CLAUDE.md protocol — that warm-up is what
    // pushed three concurrent runs past the old 90s cap. Scout only
    // needs the file tree, not the whole agent stack. `--model` pins the
    // fast Haiku tier since this is a quick advisory review, not deep
    // work. Default (text) output is kept so the closing ```json``` fence
    // the prompt asks for is parsed unchanged by `parse_specialist_output`.
    let mut child = Command::new("claude")
        .arg("-p")
        .arg(prompt)
        .arg("--model")
        .arg(SCOUT_MODEL)
        .arg("--strict-mcp-config")
        .arg("--mcp-config")
        .arg("{}")
        .current_dir(project_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn claude: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let mut reader = BufReader::new(stdout).lines();
    let mut full = String::new();
    while let Some(line) = reader
        .next_line()
        .await
        .map_err(|e| format!("read stdout: {e}"))?
    {
        let _ = app.emit(event_channel, &line);
        full.push_str(&line);
        full.push('\n');
    }

    let status = child.wait().await.map_err(|e| format!("wait: {e}"))?;
    Ok((full, status.code().unwrap_or(-1)))
}

#[derive(Default)]
struct ParsedSpecialist {
    summary: String,
    findings: Vec<ScoutFinding>,
    questions: Vec<SpecialistQuestion>,
}

/// Extract the LAST fenced ```json``` block from stdout. Falls back
/// gracefully on parse failure: returns the trailing ≤400 chars as
/// `summary` and no findings/questions, so a malformed specialist
/// still surfaces *something* to the user.
pub(crate) fn parse_specialist_output(stdout: &str, kind: SpecialistKind) -> ParsedSpecialist {
    if let Some(block) = last_json_block(stdout) {
        if let Ok(parsed) = serde_json::from_str::<RawSpecialistJson>(&block) {
            return ParsedSpecialist {
                summary: parsed.summary,
                findings: parsed
                    .findings
                    .into_iter()
                    .map(|f| ScoutFinding {
                        specialist: label_for(kind).to_string(),
                        severity: f.severity,
                        title: f.title,
                        body: f.body,
                        file_refs: f.file_refs,
                    })
                    .collect(),
                questions: parsed
                    .questions
                    .into_iter()
                    .map(|q| SpecialistQuestion {
                        id: q.id,
                        text: q.text,
                        options: q.options,
                    })
                    .collect(),
            };
        }
    }
    let tail = stdout.trim_end();
    let cut = tail.char_indices().rev().nth(400).map(|(i, _)| i).unwrap_or(0);
    ParsedSpecialist {
        summary: tail[cut..].trim().to_string(),
        ..Default::default()
    }
}

fn last_json_block(s: &str) -> Option<String> {
    let needle = "```json";
    let mut search_from = 0;
    let mut last: Option<(usize, usize)> = None;
    while let Some(start_rel) = s[search_from..].find(needle) {
        let start = search_from + start_rel;
        let after = start + needle.len();
        if let Some(end_rel) = s[after..].find("```") {
            let end = after + end_rel;
            last = Some((after, end));
            search_from = end + 3;
        } else {
            break;
        }
    }
    let (a, b) = last?;
    Some(s[a..b].trim().trim_start_matches('\n').to_string())
}

#[derive(serde::Deserialize)]
struct RawSpecialistJson {
    #[serde(default)]
    summary: String,
    #[serde(default)]
    findings: Vec<RawFinding>,
    #[serde(default)]
    questions: Vec<RawQuestion>,
}

#[derive(serde::Deserialize)]
struct RawFinding {
    severity: Severity,
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    file_refs: Vec<String>,
}

#[derive(serde::Deserialize)]
struct RawQuestion {
    id: String,
    text: String,
    #[serde(default)]
    options: Vec<String>,
}

// ── Session state mutators ────────────────────────────────────────────

fn session_project_root(app: &AppHandle, session_id: &str) -> Option<String> {
    let runtime: tauri::State<'_, crate::cmd_manager::ManagerRuntime> = app.state();
    let lock = runtime.sessions.lock().ok()?;
    let live = lock.get(session_id)?;
    let s = live.state.lock().ok()?;
    s.projects.first().map(|p| p.root.clone())
}

fn with_session<F, R>(app: &AppHandle, session_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut ManagerSession) -> R,
{
    let runtime: tauri::State<'_, crate::cmd_manager::ManagerRuntime> = app.state();
    let lock = runtime
        .sessions
        .lock()
        .map_err(|e| format!("runtime lock: {e}"))?;
    let live = lock
        .get(session_id)
        .ok_or_else(|| format!("session {session_id} not running"))?;
    let mut s = live
        .state
        .lock()
        .map_err(|e| format!("session lock: {e}"))?;
    let out = f(&mut s);
    s.touch();
    let snap = s.clone();
    drop(s);
    drop(lock);
    let _ = crate::manager::persist::save(&snap);
    let _ = app.emit(&format!("manager:{session_id}"), &snap);
    Ok(out)
}

fn set_pending_scout(
    app: &AppHandle,
    session_id: &str,
    pending: Option<PendingScout>,
) -> Result<(), String> {
    with_session(app, session_id, |s| {
        s.pending_scout = pending;
    })
}

fn update_scout_status(
    app: &AppHandle,
    session_id: &str,
    scout_id: &str,
    status: ScoutStatus,
) -> Result<(), String> {
    with_session(app, session_id, |s| {
        if let Some(scout) = s.pending_scout.as_mut() {
            if scout.id == scout_id {
                scout.status = status;
            }
        }
    })
}

fn mark_specialist_status(
    app: &AppHandle,
    session_id: &str,
    scout_id: &str,
    kind: SpecialistKind,
    status: SpecialistStatus,
    started_at: Option<u64>,
    completed_at: Option<u64>,
    exit_code: Option<i32>,
) {
    let _ = with_session(app, session_id, |s| {
        if let Some(scout) = s.pending_scout.as_mut() {
            if scout.id == scout_id {
                if let Some(spec) = scout.specialists.iter_mut().find(|sp| sp.kind == kind) {
                    spec.status = status;
                    if started_at.is_some() {
                        spec.started_at = started_at;
                    }
                    if completed_at.is_some() {
                        spec.completed_at = completed_at;
                    }
                    if exit_code.is_some() {
                        spec.exit_code = exit_code;
                    }
                }
            }
        }
    });
}

fn write_specialist_run(app: &AppHandle, session_id: &str, scout_id: &str, run: SpecialistRun) {
    let _ = with_session(app, session_id, |s| {
        if let Some(scout) = s.pending_scout.as_mut() {
            if scout.id == scout_id {
                if let Some(slot) = scout
                    .specialists
                    .iter_mut()
                    .find(|sp| sp.kind == run.kind)
                {
                    *slot = run;
                }
            }
        }
    });
}

/// Promote the draft into `pending_plan` and clear `pending_scout`.
/// The bridge waiter (held by `handle_propose_plan`) is still parked on
/// `pending_plans` and will resolve when the user clicks Build/Cancel
/// on the rendered PlanCard, exactly like the legacy direct path.
fn finalize_scout(
    app: &AppHandle,
    session_id: &str,
    scout_id: &str,
    consolidated_notes: String,
) -> Result<(), String> {
    let plan_draft = with_session(app, session_id, |s| {
        let draft = s
            .pending_scout
            .as_ref()
            .filter(|sc| sc.id == scout_id)
            .map(|sc| sc.plan_draft.clone());
        if let Some(scout) = s.pending_scout.as_mut() {
            if scout.id == scout_id {
                scout.status = ScoutStatus::Done;
                scout.consolidated_notes = consolidated_notes.clone();
            }
        }
        draft
    })?;

    let plan_draft = match plan_draft {
        Some(p) => p,
        None => {
            // Scout was canceled / replaced. Nothing to promote.
            return Ok(());
        }
    };

    // Build a PendingPlan from the draft. Same shape as the direct
    // path in cmd_permission_socket::handle_propose_plan, with the
    // request_id reused so the bridge waiter resolves correctly.
    let plan = crate::manager::PendingPlan {
        id: with_session(app, session_id, |s| {
            s.pending_scout
                .as_ref()
                .map(|sc| sc.request_id.clone())
                .unwrap_or_default()
        })?,
        title: plan_draft.title,
        summary: if consolidated_notes.is_empty() {
            plan_draft.summary
        } else {
            format!("{}\n\nScout notes:\n{}", plan_draft.summary, consolidated_notes)
        },
        objective: plan_draft.objective,
        baseline: plan_draft.baseline,
        architecture_mermaid: plan_draft.architecture_mermaid,
        phases: plan_draft
            .phases
            .into_iter()
            .map(|p| crate::manager::PlanPhase {
                title: p.title,
                body: p.body,
                file_refs: p.file_refs,
            })
            .collect(),
        deliverables: plan_draft.deliverables,
        tests: plan_draft.tests,
        todos: {
            let mut todos: Vec<crate::manager::PendingPlanTodo> = plan_draft
                .todos
                .into_iter()
                .map(|t| crate::manager::PendingPlanTodo {
                    description: t.description,
                    agent: t.agent,
                    file_refs: t.file_refs,
                    assignee: t.assignee,
                    suggested_provider: None,
                    goal: t.goal,
                    acceptance: t.acceptance,
                    subtasks: t
                        .subtasks
                        .into_iter()
                        .map(|s| crate::manager::PendingPlanSubtask {
                            description: s.description,
                            agent: s.agent,
                            goal: s.goal,
                            acceptance: s.acceptance,
                        })
                        .collect(),
                })
                .collect();
            // Bucket G2 — annotate after Scout finalizes, before
            // PlanCard renders. Same call as the direct path so the
            // SkillBadge appears identically in both flows.
            crate::manager::skill::annotate_todos_with_suggestions(&mut todos);
            todos
        },
        parallelism: crate::manager::PlanParallelism::Auto,
        // Inventory blocker #3 — Scout-promoted plans land unapproved,
        // identical to the direct path. User stamps approval via the
        // PlanCard's Approve button (manager_approve_plan).
        approved_by: None,
        approved_at: None,
        at: now_secs(),
    };

    crate::cmd_manager::set_pending_plan(app, session_id, plan)?;
    set_pending_scout(app, session_id, None)?;
    Ok(())
}

fn append_chat_system(app: &AppHandle, session_id: &str, text: String) {
    let _ = with_session(app, session_id, |s| {
        crate::manager::chat::append(s, ChatRole::System, text);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_json_block_extracts_only_block() {
        let s = "blah\n```json\n{\"summary\":\"ok\"}\n```\ntrailing";
        let block = last_json_block(s).unwrap();
        assert_eq!(block, "{\"summary\":\"ok\"}");
    }

    #[test]
    fn last_json_block_picks_last_when_multiple() {
        let s = "```json\n{\"summary\":\"first\"}\n```\nmore\n```json\n{\"summary\":\"second\"}\n```";
        let block = last_json_block(s).unwrap();
        assert_eq!(block, "{\"summary\":\"second\"}");
    }

    #[test]
    fn last_json_block_none_when_unterminated() {
        let s = "```json\n{\"summary\":\"oops\"}";
        assert!(last_json_block(s).is_none());
    }

    #[test]
    fn parse_specialist_output_happy_path() {
        let out = "preamble\n```json\n{\
            \"summary\":\"layer ok\",\
            \"findings\":[{\"severity\":\"warn\",\"title\":\"t\",\"body\":\"b\",\"file_refs\":[\"x.rs\"]}],\
            \"questions\":[{\"id\":\"q1\",\"text\":\"go?\",\"options\":[\"y\",\"n\"]}]\
        }\n```\n";
        let parsed = parse_specialist_output(out, SpecialistKind::Architecture);
        assert_eq!(parsed.summary, "layer ok");
        assert_eq!(parsed.findings.len(), 1);
        assert_eq!(parsed.findings[0].specialist, "arch");
        assert!(matches!(parsed.findings[0].severity, Severity::Warn));
        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.questions[0].id, "q1");
    }

    #[test]
    fn parse_specialist_output_falls_back_on_garbage() {
        let out = "no json fence here, just a wall of text".repeat(20);
        let parsed = parse_specialist_output(&out, SpecialistKind::Security);
        assert!(parsed.findings.is_empty());
        assert!(!parsed.summary.is_empty());
    }

    #[test]
    fn render_prompt_substitutes_placeholders() {
        let plan = ProposePlanPayload {
            session_id: "s".into(),
            title: "Add login".into(),
            summary: "do it".into(),
            objective: None,
            baseline: None,
            architecture_mermaid: None,
            phases: vec![],
            deliverables: vec![],
            tests: vec![],
            todos: vec![crate::cli_bridge::PlanTodo {
                description: "x".into(),
                agent: None,
                file_refs: vec!["src/foo.rs".into(), "src/bar.rs".into()],
                assignee: None,
                goal: None,
                acceptance: vec![],
                subtasks: vec![],
            }],
            force_skip_scout: false,
        };
        let rendered = render_prompt(SpecialistKind::Architecture, &plan, "/tmp/proj");
        assert!(rendered.contains("Add login"));
        assert!(rendered.contains("do it"));
        assert!(rendered.contains("/tmp/proj"));
        assert!(rendered.contains("src/foo.rs"));
        assert!(rendered.contains("src/bar.rs"));
    }
}
