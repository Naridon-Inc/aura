//! Cloud placement — the tools that let Aura move work you already have onto
//! a machine that isn't this one.
//!
//! The cloud runner shipped as a *destination*: a panel you navigate to, with
//! a box you type a job description into. That is the wrong shape and it shows
//! in the usage — nobody opens a separate screen to describe work they are
//! already looking at. The thing people actually want to say is "take this and
//! run it on the box", about a worktree they just made or a task already on
//! the board.
//!
//! So placement belongs here, on the orchestrator, next to the tools that
//! already know what "this" is. `aura_worktrees_list` can name the branch,
//! `aura_tasks_list` can name the task, and now `aura_cloud_send` can put
//! either one on a machine — one turn, in the sentence the user was already
//! typing.
//!
//! ## Local and remote are the same board
//!
//! There is no separate cloud queue to reconcile. `aura_cloud_send` mints a
//! task on the shared A2A board (`aura a2a-task create`) scoped to the same
//! `owner/repo` the local work is on, and a runner draining that board picks
//! it up. That is the same board `aura loop cloud-sync` pulls finished work
//! back through, so a crew can have some tasks running on this Mac and others
//! on the box without either side knowing or caring — they are rows in one
//! place, distinguished only by who claimed them.
//!
//! ## Refusing to send into the void
//!
//! `aura_cloud_send` preflights the machine board and will NOT mint a task
//! when nothing can run it. This is the honesty rule that the machine card
//! got wrong: a box that is online but has no working sign-in for the agent
//! is not "Ready", and a task sent to it is a task that fails in ten minutes
//! instead of a sentence that tells the user what to fix now. Readiness is
//! derived from evidence — the registry's liveness plus the newest terminal
//! job for that agent — never assumed.

use serde_json::{Value, json};

use super::control_plane::resolve_one;
use crate::cmd_cloud_runners::{CloudRunner, cloud_runners};

/// Cap on one tool result fed back to the model. Matches the other tool
/// modules' budget.
const MAX_RESULT_CHARS: usize = 16_000;

/// How many recent board rows we read to decide whether an agent's sign-in is
/// working. Only the newest terminal row per agent decides, so this is just
/// enough history to find one.
const AUTH_PROBE_ROWS: i64 = 40;

/// The tool names this module owns.
pub const TOOL_NAMES: &[&str] = &[
    "aura_cloud_machines",
    "aura_cloud_send",
    "aura_cloud_jobs",
    "aura_cloud_cancel",
];

/// The one tool in this module that actually places work somewhere else.
///
/// Named rather than matched inline because the authority gate in
/// `native_tools` has to know which of the four is the dispatch, and a
/// string literal repeated in two files is how the gate ends up guarding
/// a tool that has since been renamed.
pub const DISPATCH_TOOL: &str = "aura_cloud_send";

/// True when `name` is one of the cloud-placement tools.
pub fn is_cloud_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Anthropic-format schemas for the cloud-placement tools.
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "aura_cloud_machines",
            "description": "List the always-on machines connected to this account — the ones that can run work while the user's laptop is closed. Call this before offering to move anything to the cloud, and whenever the user asks what machines they have or whether the box is up. Returns each machine's name, whether it is online, which agent CLIs it can run, its Aura version, when it last checked in, what it is doing right now, and an honest `can_run` verdict with `blocked_reason` when it cannot take work. Do NOT describe a machine as ready unless `can_run` is true. A machine may also carry a `warning` — it can take work, but something on the account suggests it might fail; relay it rather than promising a clean run.",
            "input_schema": { "type": "object", "properties": {}, "required": [] }
        }),
        json!({
            "name": "aura_cloud_send",
            "description": "Move a piece of work onto an always-on machine so it keeps going after the user closes their laptop. This is the tool for 'run this in the cloud', 'move this to the box', 'do the rest remotely' — said about work that already exists (a worktree, a branch, a task on the board), not a separate cloud queue. Its counterpart is aura_work_start, which runs work here; call both to split a batch across places ('the first three in the cloud, the rest locally'). Prefer passing `task` over retyping the work: the brief is then built from the board entry itself rather than from your summary of it, and the task is linked to the job. The job is scoped to the named project's repo and branch, so results come back into the same place the user is working. Refuses (without creating anything) when no connected machine can run it — relay the reason rather than retrying.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "A board task to send — 'AURA-12', a bare sequence number, or an internal id. The brief comes from the task's own title and description, and the task is moved to started and labelled as running in the cloud. Omit only for work that is not on the board."
                    },
                    "text": {
                        "type": "string",
                        "description": "The brief for the remote agent, when the work is not a board task. Self-contained: it will run with no memory of this conversation. Name files, the goal, and any constraint that matters. Ignored if `task` is given and the task has a description."
                    },
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path (a worktree path is fine — that is how you send one worktree's work). Omit for the project this chat is open on."
                    },
                    "acceptance": {
                        "type": "string",
                        "description": "One line describing what 'done' means, in terms Aura can later prove. Include it whenever the user stated an outcome."
                    },
                    "agent": {
                        "type": "string",
                        "description": "Which agent CLI should run it — 'claude', 'gemini', 'codex'. Defaults to claude. Must be one the machine lists in agent_kinds."
                    },
                    "continue_conversation": {
                        "type": "boolean",
                        "description": "Send THIS conversation along with the work, so the remote agent picks up where you left off instead of starting cold. Set it whenever the user says 'continue this in the cloud', 'hand this over to the box', 'take it from here remotely' — anything that means the machine should know what has been discussed. Carries the decisions, answers and alerts from this chat plus the most recent turns; the reply reports how much travelled. Leave it off for work that is self-contained (a board task, a one-line brief) — the transcript is not free and adds nothing there."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_cloud_jobs",
            "description": "What is on the cloud board — work sent to the always-on machines, and how it went. Use this to answer 'did that finish?', 'what is the box working on?', or 'why did that fail?'. Scoped by default to the project this chat is open on, so the answer is about the user's current work; pass scope='all' for every repo, or scope='conversation' for only the jobs THIS chat placed — that is the return leg for anything handed over with aura_cloud_send. Returns each job's id, status, agent, branch, when it was created, and the error when it failed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "Project label, id, or absolute path. Omit for the project this chat is open on." },
                    "scope": { "type": "string", "description": "'project' (default), 'all' for every repo, or 'conversation' for the jobs this chat placed." },
                    "status": { "type": "string", "description": "Filter: submitted | working | input-required | completed | failed | canceled | rejected | auth-required." },
                    "limit": { "type": "integer", "description": "Max rows (default 20)." }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_cloud_cancel",
            "description": "Cancel a job that was sent to a machine — 'stop that', 'never mind, cancel it'. Takes the job id from aura_cloud_send or aura_cloud_jobs. A job that already finished cannot be cancelled; that comes back as an error, not a silent no-op.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Job id from aura_cloud_send or aura_cloud_jobs." }
                },
                "required": ["id"]
            }
        }),
    ]
}

/// Dispatch one cloud-placement tool. Same `(result_text, is_error)` contract
/// as the other tool modules — a bad argument comes back as a string the model
/// can recover from.
///
/// `session_id` is the chat this tool call came from. Two tools use it and the
/// rest ignore it: sending can carry the conversation over with the work, and
/// listing can narrow to the jobs this conversation placed. It is a plain `&str`
/// rather than an `Option` because every real caller has one and the empty
/// string is the honest "no session" — a headless caller then simply cannot
/// hand over a conversation it does not have.
pub async fn execute(
    repo_root: &str,
    session_id: &str,
    name: &str,
    input: &Value,
) -> (String, bool) {
    let (text, is_error) = match name {
        "aura_cloud_machines" => tool_machines().await,
        "aura_cloud_send" => tool_send(repo_root, session_id, input).await,
        "aura_cloud_jobs" => tool_jobs(repo_root, session_id, input).await,
        "aura_cloud_cancel" => tool_cancel(repo_root, input).await,
        other => (format!("unknown cloud tool: {other}"), true),
    };
    (truncate(&text, MAX_RESULT_CHARS), is_error)
}

// ── readiness ──────────────────────────────────────────────────────────
//
// "Ready" has to mean "will run your work", not "the row exists". The machine
// card used to read the registry's `idle` and print Ready for a box that could
// not authenticate a single job — the user's next ten minutes were spent
// watching a task fail. Two independent facts decide it: the registry says the
// box is beating and lists the agent, and the board's newest terminal job for
// that agent did not die on sign-in.

/// What the board's newest terminal job says about an agent's credentials —
/// and, just as importantly, *whom* it says it about.
///
/// Board rows record the repo, the agent kind and the error, but nothing that
/// names the machine that claimed them. So a credential failure is evidence
/// about the fleet, not about a box, and turning it into a per-machine verdict
/// takes one more step: count who could have run it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SignIn {
    /// No terminal job for this agent, or the newest one didn't die on
    /// credentials.
    Fine,
    /// The newest terminal job died on credentials and exactly one online
    /// machine runs this agent — so that machine is the one that failed.
    /// Holds its runner id.
    BrokenOn(String),
    /// The newest terminal job died on credentials, but several online machines
    /// run this agent and the board can't say which one claimed it. Warn on all
    /// of them and block none: condemning a healthy box on a peer's dead key
    /// sends the user to fix a machine that was never broken.
    BrokenSomewhere,
}

/// Turn the board's fleet-wide credential evidence into a per-machine verdict.
fn attribute_sign_in(agent: &str, board: &[Value], runners: &[CloudRunner]) -> SignIn {
    if !sign_in_broken_for(agent, board) {
        return SignIn::Fine;
    }
    let mut candidates = runners
        .iter()
        .filter(|r| r.online && r.agent_kinds.iter().any(|k| k == agent));
    match (candidates.next(), candidates.next()) {
        (Some(only), None) => SignIn::BrokenOn(only.id.clone()),
        _ => SignIn::BrokenSomewhere,
    }
}

/// Why a machine can't take work, or `None` when it can.
fn blocked_reason(r: &CloudRunner, agent: &str, sign_in: &SignIn) -> Option<String> {
    if !r.online {
        return Some(match r.last_heartbeat_at.as_deref() {
            Some(t) => format!("hasn't checked in since {t}"),
            None => "registered but has never checked in — the runner was never started".into(),
        });
    }
    if !r.agent_kinds.iter().any(|k| k == agent) {
        let has = if r.agent_kinds.is_empty() {
            "no agent CLI".to_string()
        } else {
            r.agent_kinds.join(", ")
        };
        return Some(format!("runs {has}, not {agent}"));
    }
    if matches!(sign_in, SignIn::BrokenOn(id) if *id == r.id) {
        return Some(format!(
            "{agent} on this machine can't sign in — its last job failed on credentials. \
             Re-add the key on the box (aura runner creds set --agent {agent} --key-stdin)."
        ));
    }
    None
}

/// A non-blocking caution for a machine that *might* be the one whose key died.
///
/// Only reachable when more than one online box runs the agent, so the honest
/// thing is to name the ambiguity rather than pick a scapegoat.
fn sign_in_warning(r: &CloudRunner, agent: &str, sign_in: &SignIn) -> Option<String> {
    if *sign_in != SignIn::BrokenSomewhere || !r.online {
        return None;
    }
    if !r.agent_kinds.iter().any(|k| k == agent) {
        return None;
    }
    Some(format!(
        "the last {agent} job on this account failed on credentials, and more than one machine \
         runs {agent} — it may or may not have been this one. If work sent here fails to sign in, \
         re-add the key on the box (aura runner creds set --agent {agent} --key-stdin)."
    ))
}

/// True when the newest *terminal* board row for `agent` failed on sign-in.
///
/// Newest-terminal-wins on purpose: a credential failure from last week that
/// has since been followed by a completed job proves the key was fixed, and
/// treating it as current would block a machine that works.
fn sign_in_broken_for(agent: &str, rows: &[Value]) -> bool {
    for row in rows {
        let kind = row
            .get("agent_kind")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if kind.trim_start_matches("a2a:") != agent {
            continue;
        }
        match row.get("status").and_then(|v| v.as_str()).unwrap_or_default() {
            "failed" | "rejected" | "auth-required" => {
                let err = row
                    .get("error_message")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                return looks_like_sign_in_failure(err);
            }
            "completed" | "canceled" => return false,
            _ => continue, // still in flight — says nothing about credentials
        }
    }
    false
}

/// Whether a job's error text is about credentials rather than the work.
fn looks_like_sign_in_failure(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    [
        "api key",
        "not logged in",
        "unauthorized",
        "authentication",
        "auth-required",
        "credential",
        "sign in",
        "invalid_api_key",
    ]
    .iter()
    .any(|needle| e.contains(needle))
}

async fn tool_machines() -> (String, bool) {
    let runners = match cloud_runners().await {
        Ok(r) => r,
        Err(e) => {
            return (
                format!(
                    "can't read the machine board: {e}. If this says not signed in, the user \
                     needs to connect Aura cloud in Settings → Account."
                ),
                true,
            );
        }
    };
    if runners.is_empty() {
        return (
            json!({
                "machines": [],
                "note": "No machines connected to this account. Work can only run on this Mac \
                         until one is added — Settings → Machines → Connect a machine walks \
                         through pointing Aura at a box the user already has."
            })
            .to_string(),
            false,
        );
    }

    let board = recent_board_rows(None).await.unwrap_or_default();
    let rows: Vec<Value> = runners
        .iter()
        .map(|r| {
            let agent = r.agent_kinds.first().cloned().unwrap_or_default();
            let sign_in = if agent.is_empty() {
                SignIn::Fine
            } else {
                attribute_sign_in(&agent, &board, &runners)
            };
            let reason = blocked_reason(r, &agent, &sign_in);
            json!({
                "id": r.id,
                "name": r.name,
                "online": r.online,
                "agents": r.agent_kinds,
                "aura_version": r.version,
                "last_seen": r.last_heartbeat_at,
                "doing_now": r.current_task,
                "can_run": reason.is_none(),
                "blocked_reason": reason,
                "warning": sign_in_warning(r, &agent, &sign_in),
            })
        })
        .collect();
    (json!({ "machines": rows }).to_string(), false)
}

// ── sending work ───────────────────────────────────────────────────────

async fn tool_send(repo_root: &str, session_id: &str, input: &Value) -> (String, bool) {
    let agent = input
        .get("agent")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("claude")
        .to_string();
    let target = match resolve_one(repo_root, input) {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    // Same brief rule as the local placement: a named board task briefs the
    // agent from its own description rather than from the model's summary of
    // it, and both placements agree on what a task means because there is one
    // resolver, not two.
    let brief = match super::local_plane::resolve_brief(&target.root, input).await {
        Ok(b) => b,
        Err(e) => return (e, true),
    };

    // Should the conversation travel with the work? A job minted from a brief
    // alone lands on a machine that has never heard any of this, so the remote
    // agent re-asks what was already answered. When the user says "continue
    // this in the cloud" the conversation IS the brief's other half.
    let carry = input
        .get("continue_conversation")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let handover = if carry {
        // Off the runtime: a long conversation's JSON runs to megabytes, and
        // parsing it on an async worker is exactly the stall #52 swept out of
        // the other commands.
        let sid = session_id.to_string();
        crate::blocking::run(move || load_handover(&sid)).await
    } else {
        None
    };
    // Refuse rather than pretend. Asked to continue a conversation we cannot
    // read, sending the bare brief would look like agreement and produce an
    // agent starting from nothing — the exact failure this flag exists to fix.
    if carry && handover.is_none() {
        return (
            "Nothing was sent — this conversation could not be read back from disk, so there is \
             nothing to hand over. Say so, and offer to send the work with a self-contained brief \
             (`text`) instead."
                .into(),
            true,
        );
    }
    let text = match &handover {
        Some(h) => format!("{}{}", h.text, brief.text),
        None => brief.text.clone(),
    };

    // Preflight. A task nobody can run is worse than a refusal: it looks like
    // it worked, and the truth arrives as a failure ten minutes later.
    let runners = match cloud_runners().await {
        Ok(r) => r,
        Err(e) => {
            return (
                format!("can't reach the machine board to check where this would run: {e}"),
                true,
            );
        }
    };
    if runners.is_empty() {
        return (
            "No machine is connected to this account, so there is nowhere to send this. \
             Tell the user they can connect one in Settings → Machines → Connect a machine \
             (it takes a box they already have — a VPS, a spare Mac, an EC2 instance), and \
             offer to run the work here instead."
                .into(),
            true,
        );
    }
    let board = recent_board_rows(None).await.unwrap_or_default();
    let sign_in = attribute_sign_in(&agent, &board, &runners);
    let ready: Vec<&CloudRunner> = runners
        .iter()
        .filter(|r| blocked_reason(r, &agent, &sign_in).is_none())
        .collect();
    if ready.is_empty() {
        let why: Vec<String> = runners
            .iter()
            .map(|r| {
                let reason = blocked_reason(r, &agent, &sign_in)
                    .unwrap_or_else(|| "unavailable".to_string());
                format!("{}: {reason}", r.name)
            })
            .collect();
        return (
            format!(
                "Nothing was sent — no connected machine can run {agent} right now. {}. \
                 Relay the reason and offer to run the work locally instead.",
                why.join("; ")
            ),
            true,
        );
    }

    let acceptance = brief.acceptance.clone();
    let repo = {
        let root = target.root.clone();
        crate::blocking::run(move || crate::cmd_loop::origin_full_name(&root)).await
    };
    // A job with no repo is an orphan: the board has nothing to scope it to, so
    // only an --all-projects runner will ever see it, and there is no repo for
    // the finished work to sync back into. Minting one and reporting success is
    // the worst outcome — the user waits for a result that cannot arrive.
    let Some(repo_full) = repo.clone() else {
        return (
            format!(
                "Nothing was sent — {} has no GitHub remote, and cloud work is scoped by repo: \
                 without one there is nowhere for the machine to pull from or push back to. \
                 Give the project an `origin` remote first, or pass `project` naming one that \
                 has one (aura_projects_list shows them). Offer to run the work here instead.",
                target.label
            ),
            true,
        );
    };

    // What the machine will NOT have. A runner works from a clone, so the
    // user's uncommitted edits and unpushed commits are invisible to it. That
    // is the likeliest way a handed-over conversation produces confident
    // nonsense: it discusses code the remote checkout does not contain. Measured
    // before the mint so the answer carries it, not after so a failure explains
    // it. Never fatal — sending stale work knowingly is a legitimate choice, and
    // refusing here would trade a real capability for a diagnostic.
    let gap_warning = {
        let root = target.root.clone();
        crate::blocking::run(move || super::handoff::worktree_gap(&root).warning()).await
    };

    let bin = crate::agent_event_listener::resolve_aura_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("a2a-task")
        .arg("create")
        .arg("--agent-kind")
        .arg(format!("a2a:{agent}"))
        .arg("--input")
        .arg(&text)
        // Tagged so a job the user asked for in chat is distinguishable from
        // one a crew or the CLI minted — the board is shared, and "who sent
        // this?" is the first question when something unexpected runs.
        .arg("--tag")
        .arg("aura-chat");
    cmd.arg("--repo").arg(&repo_full);
    if let Some(ac) = acceptance.as_deref() {
        cmd.arg("--kind").arg("task").arg("--acceptance-criteria").arg(ac);
    }
    // Stamp the originating chat onto the row. `context_id` is the board's own
    // grouping key, so every job placed from one conversation shares it and
    // "how did the work I handed over go?" becomes a filter rather than a guess
    // — that is the return leg. The metadata records how much of the
    // conversation actually travelled, so a thin handover is legible later
    // instead of being mistaken for a full one.
    if !session_id.is_empty() {
        cmd.arg("--context-id").arg(session_id);
        let meta = json!({
            "aura_chat_session": session_id,
            "handoff": if handover.is_some() { "conversation" } else { "brief" },
            "handover_turns": handover.as_ref().map(|h| h.turns_included),
            "handover_turns_dropped": handover.as_ref().map(|h| h.turns_dropped),
        });
        cmd.arg("--metadata-json").arg(meta.to_string());
    }
    // Run from the project root so the CLI picks up this worktree's branch —
    // that is what keeps a sent job on the branch the user is actually on.
    cmd.arg("--json").current_dir(&target.root);

    let out = match cmd.output().await {
        Ok(o) => o,
        Err(e) => return (format!("couldn't run the cloud send: {e}"), true),
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return (explain_send_failure(err.trim(), repo.as_deref()), true);
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: Value = match serde_json::from_str(stdout.trim()) {
        Ok(v) => v,
        Err(e) => return (format!("couldn't read the cloud's reply: {e} — {stdout}"), true),
    };
    let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default();
    if id.is_empty() {
        return (format!("the cloud accepted nothing back — {stdout}"), true);
    }
    let machines: Vec<&str> = ready.iter().map(|r| r.name.as_str()).collect();
    // Sent, but not silently: when the fleet's last job died on credentials and
    // the board can't say which box it was, the user deserves to hear that
    // before they walk away expecting a result.
    let caution = ready
        .iter()
        .find_map(|r| sign_in_warning(r, &agent, &sign_in));
    // Now the job exists, tie the board row to it. Placed after the mint, never
    // before: a task marked started for work that was then refused is a board
    // that lies, and the board is the thing everyone else on the team reads.
    let board_note = match brief.task.as_ref() {
        Some(t) => {
            super::local_plane::mark_task_placed(
                &target.root,
                t,
                super::local_plane::PLACED_CLOUD,
                &agent,
            )
            .await
        }
        None => None,
    };
    (
        json!({
            "sent": true,
            "id": id,
            "status": v.get("status").and_then(|x| x.as_str()).unwrap_or("submitted"),
            "project": target.label,
            "repo": repo,
            "branch": v.get("branch").and_then(|x| x.as_str()),
            "agent": agent,
            "task": brief.task.as_ref().map(|t| format!("AURA-{}", t.sequence_id)),
            "will_run_on": machines,
            "caution": caution,
            "board_note": board_note,
            // What went with the work. `null` when only the brief did — the
            // distinction matters to whoever reads this next, because a job
            // that carries the conversation and one that does not are two
            // different promises about what the remote agent knows.
            "carried_conversation": handover.as_ref().map(|h| json!({
                "turns": h.turns_included,
                "turns_left_behind": h.turns_dropped,
            })),
            // Relayed, not swallowed: the user is about to walk away, and this
            // is the one thing that would make the result wrong rather than
            // late.
            "machine_will_not_see": gap_warning,
            "note": "Picked up within a poll cycle (~20s). Check with aura_cloud_jobs \
                     (scope='conversation' lists what this chat placed); finished work \
                     comes back into this repo on the next cloud sync (aura_work_sync)."
        })
        .to_string(),
        false,
    )
}

/// The conversation this tool call came from, packed for travel.
///
/// Read back from `~/.aura/manager-sessions/<sid>.json` rather than held in
/// memory, and that is safe for one specific reason: `cmd_brain_chat` persists
/// the user's turn BEFORE it resolves a brain or runs a tool, so the file
/// already contains the message that asked for this. What it does not contain
/// is the in-flight assistant turn making the call — which is exactly right,
/// since that turn is the request, not the history.
///
/// `None` when there is no session id, no file, or nothing in the chat worth
/// carrying. The caller turns that into a refusal rather than a quiet fallback.
fn load_handover(session_id: &str) -> Option<super::handoff::Handover> {
    if session_id.trim().is_empty() {
        return None;
    }
    let session = crate::manager::persist::load(session_id).ok()?;
    let h = super::handoff::build(&session, super::handoff::DEFAULT_BUDGET);
    (!h.is_empty()).then_some(h)
}

/// Turn the CLI's transport-level complaint into something a person can act on.
///
/// The board resolves a repo by its `owner/name`, and a repo it has never seen
/// comes back as a bare 404 that surfaces as "response parse failed (HTTP 404
/// Not Found): error decoding response body". That sentence describes the HTTP
/// client's disappointment, not the user's problem — which is that this project
/// has never synced to the cloud, and one sync fixes it.
fn explain_send_failure(err: &str, repo: Option<&str>) -> String {
    if err.contains("404") {
        let name = repo.unwrap_or("this project");
        return format!(
            "Nothing was sent — Aura cloud has no record of {name}, so there is no board to put \
             the work on. A project registers itself the first time it syncs: ask the user to \
             sign in under Settings → Account and let this project sync once, then try again. \
             Offer to run the work here in the meantime."
        );
    }
    if looks_like_sign_in_failure(err) {
        return format!(
            "Nothing was sent — the cloud rejected this account's credentials: {err}. The user \
             needs to reconnect Aura cloud in Settings → Account."
        );
    }
    format!("cloud send failed: {err}")
}

// ── reading the board ──────────────────────────────────────────────────

/// The newest board rows, optionally narrowed to one repo. Used both by the
/// jobs tool and by the readiness probe.
async fn recent_board_rows(repo: Option<&str>) -> Result<Vec<Value>, String> {
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("a2a-task")
        .arg("list")
        .arg("--limit")
        .arg(AUTH_PROBE_ROWS.to_string());
    if let Some(r) = repo {
        cmd.arg("--repo").arg(r);
    }
    cmd.arg("--json");
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("run aura a2a-task list: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|e| format!("parse: {e}"))?;
    Ok(board_rows(&v))
}

/// Pull the task array out of whatever envelope the cloud returned.
///
/// The list endpoint has been seen as a bare array and as `{tasks: […]}`;
/// accepting both here means a server-side envelope change degrades to an
/// empty readiness probe rather than a tool that reports every machine broken.
fn board_rows(v: &Value) -> Vec<Value> {
    if let Some(a) = v.as_array() {
        return a.clone();
    }
    for key in ["tasks", "items", "results", "data"] {
        if let Some(a) = v.get(key).and_then(|x| x.as_array()) {
            return a.clone();
        }
    }
    Vec::new()
}

async fn tool_jobs(repo_root: &str, session_id: &str, input: &Value) -> (String, bool) {
    let scope = input
        .get("scope")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("project");
    let all = scope.eq_ignore_ascii_case("all");
    // "What happened to the work I handed over?" — answered by the board's own
    // grouping key, which `aura_cloud_send` stamped with this chat's id. Asked
    // in a chat that has no session, this would silently widen to every job in
    // the repo and read as an answer; it refuses instead.
    let this_chat = scope.eq_ignore_ascii_case("conversation");
    if this_chat && session_id.trim().is_empty() {
        return (
            "This chat has no session id, so there is no way to tell which jobs came from it. \
             Ask with scope='project' instead."
                .into(),
            true,
        );
    }

    let mut scope_label = "every repo".to_string();
    // A conversation's jobs are looked up across every repo, not just this one:
    // a chat can place work on more than one project, and narrowing by repo
    // would hide the jobs it placed elsewhere.
    let repo = if all || this_chat {
        None
    } else {
        let target = match resolve_one(repo_root, input) {
            Ok(t) => t,
            Err(e) => return (e, true),
        };
        scope_label = target.label.clone();
        let root = target.root.clone();
        crate::blocking::run(move || crate::cmd_loop::origin_full_name(&root)).await
    };
    if this_chat {
        scope_label = "this conversation".to_string();
    }

    let limit = input
        .get("limit")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .unwrap_or(20) as usize;
    let status = input
        .get("status")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let rows = match recent_board_rows(repo.as_deref()).await {
        Ok(r) => r,
        Err(e) => return (format!("can't read the cloud board: {e}"), true),
    };
    let jobs: Vec<Value> = rows
        .iter()
        .filter(|r| match status {
            Some(want) => r.get("status").and_then(|v| v.as_str()) == Some(want),
            None => true,
        })
        .filter(|r| !this_chat || row_context(r) == Some(session_id))
        .take(limit)
        .map(|r| job_row(r, session_id))
        .collect();
    (
        json!({
            "scope": scope_label,
            "repo": repo,
            "jobs": jobs,
        })
        .to_string(),
        false,
    )
}

/// One board row, reduced to what the model needs to recognise a job.
///
/// Extracted from `tool_jobs` so the field mapping can be pinned by a test:
/// the board's key names are the server's, not ours, and reading the wrong one
/// fails silently as a `null` that looks like missing data rather than a bug.
fn job_row(r: &Value, session_id: &str) -> Value {
    json!({
        "id": r.get("id"),
        "status": r.get("status"),
        "agent": r.get("agent_kind").and_then(|v| v.as_str())
            .map(|k| k.trim_start_matches("a2a:").to_string()),
        "branch": r.get("branch"),
        // The board returns `repo_id`, a uuid — no human name. Kept as the last
        // fallback so two jobs from different repos are at least
        // distinguishable under scope='all'.
        "repo": r.get("repo").or_else(|| r.get("github_full_name"))
            .or_else(|| r.get("repo_id")),
        "created_at": r.get("created_at"),
        // `input_text` is what the board actually calls the brief. This read
        // `input` and so was null on every row ever returned — a job list in
        // which no job could be recognised.
        "brief": r.get("input_text").or_else(|| r.get("input"))
            .and_then(|v| v.as_str()).map(|s| first_line(s, 160)),
        "from_this_chat": row_context(r) == Some(session_id),
        "error": r.get("error_message"),
    })
}

/// The chat a board row was placed from, when one stamped it.
///
/// `context_id` is the board's own grouping key rather than something Aura
/// invented, so a row minted by anything else simply has none and never
/// masquerades as this conversation's.
fn row_context(row: &Value) -> Option<&str> {
    row.get("context_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// First line of a brief, clipped — enough to recognise a job, not enough to
/// spend the tool budget replaying every prompt ever sent.
fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max {
        return line.to_string();
    }
    let kept: String = line.chars().take(max).collect();
    format!("{kept}…")
}

async fn tool_cancel(repo_root: &str, input: &Value) -> (String, bool) {
    let id = match input.get("id").and_then(|v| v.as_str()).map(str::trim) {
        Some(i) if !i.is_empty() => i.to_string(),
        _ => return ("`id` is required — the job id from aura_cloud_jobs.".into(), true),
    };
    let bin = crate::agent_event_listener::resolve_aura_bin();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("a2a-task")
        .arg("patch")
        .arg(&id)
        .arg("--status")
        .arg("canceled")
        .arg("--json");
    if !repo_root.is_empty() {
        cmd.current_dir(repo_root);
    }
    let out = match cmd.output().await {
        Ok(o) => o,
        Err(e) => return (format!("couldn't run the cancel: {e}"), true),
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let err = err.trim();
        // A finished job is sticky cloud-side. Say so plainly rather than
        // letting a 409 read as a transport failure the model retries.
        if err.contains("409") {
            return (
                format!("job {id} already reached a final state, so there is nothing to cancel."),
                true,
            );
        }
        return (format!("cancel failed: {err}"), true);
    }
    (json!({ "canceled": id }).to_string(), false)
}

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

    fn runner(name: &str, online: bool, kinds: &[&str]) -> CloudRunner {
        CloudRunner {
            id: name.to_string(),
            org_id: None,
            name: name.to_string(),
            agent_kinds: kinds.iter().map(|s| s.to_string()).collect(),
            version: Some("0.19.35".into()),
            status: if online { "idle".into() } else { "offline".into() },
            last_heartbeat_at: online.then(|| "2026-08-01T18:41:28Z".to_string()),
            current_task: None,
            online,
            created_by: None,
            created_at: None,
        }
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
    fn cloud_tools_are_recognised_and_dont_shadow_the_others() {
        assert!(is_cloud_tool("aura_cloud_send"));
        assert!(!is_cloud_tool("aura_tasks_list"));
        assert!(!is_cloud_tool("bash"));
    }

    /// The bug this module exists to not repeat: the machine card read the
    /// registry's `idle` and printed "Ready" for a box that could not run a
    /// single job. Online is necessary and nowhere near sufficient.
    #[test]
    fn an_online_box_that_cannot_sign_in_is_not_ready() {
        let r = runner("aura-runner", true, &["claude"]);
        assert!(blocked_reason(&r, "claude", &SignIn::Fine).is_none());
        let broken = SignIn::BrokenOn("aura-runner".into());
        let reason = blocked_reason(&r, "claude", &broken).expect("a broken sign-in blocks");
        assert!(reason.contains("can't sign in"), "{reason}");
        assert!(reason.contains("runner creds set"), "names the fix: {reason}");
    }

    #[test]
    fn a_box_that_never_started_says_so_rather_than_reporting_a_stale_time() {
        let mut r = runner("aura-runner", false, &["claude"]);
        r.last_heartbeat_at = None;
        let reason = blocked_reason(&r, "claude", &SignIn::Fine).expect("offline blocks");
        assert!(reason.contains("never"), "{reason}");
    }

    #[test]
    fn asking_a_box_for_an_agent_it_does_not_have_names_what_it_does_have() {
        let r = runner("aura-runner", true, &["claude"]);
        let reason = blocked_reason(&r, "gemini", &SignIn::Fine).expect("wrong agent blocks");
        assert!(reason.contains("claude"), "{reason}");
        assert!(reason.contains("gemini"), "{reason}");
    }

    /// The exact string the CLI produced against a repo the cloud had never
    /// seen. It names the HTTP client's problem, not the user's.
    #[test]
    fn an_unregistered_repo_is_explained_not_transcribed() {
        let raw = "✗ response parse failed (HTTP 404 Not Found): error decoding response body";
        let msg = explain_send_failure(raw, Some("MHASK/aura-cloud-sim"));
        assert!(msg.contains("MHASK/aura-cloud-sim"), "names the project: {msg}");
        assert!(msg.contains("sync"), "names the fix: {msg}");
        assert!(!msg.contains("decoding response body"), "drops the noise: {msg}");
        // And it must not claim anything was queued.
        assert!(msg.starts_with("Nothing was sent"), "{msg}");
    }

    #[test]
    fn a_repoless_send_still_explains_itself() {
        let msg = explain_send_failure("HTTP 404 Not Found", None);
        assert!(msg.contains("this project"), "{msg}");
    }

    #[test]
    fn an_expired_login_is_sent_to_the_account_screen() {
        let msg = explain_send_failure("401 unauthorized: token expired", None);
        assert!(msg.contains("Settings"), "{msg}");
    }

    /// Anything unrecognised is passed through rather than swallowed — a
    /// failure we can't explain is still a failure the user must see.
    #[test]
    fn an_unknown_failure_is_relayed_verbatim() {
        let msg = explain_send_failure("connection reset by peer", None);
        assert!(msg.contains("connection reset by peer"), "{msg}");
    }

    fn failed_claude_row() -> Vec<Value> {
        vec![json!({
            "agent_kind": "a2a:claude",
            "status": "failed",
            "error_message": "agent 'claude' exited 1: Invalid API key",
        })]
    }

    /// With one online box running the agent, the failure has exactly one
    /// possible author — name it, so the user knows which machine to fix.
    #[test]
    fn a_lone_online_box_owns_the_credential_failure() {
        let fleet = vec![runner("ec2-box", true, &["claude"])];
        assert_eq!(
            attribute_sign_in("claude", &failed_claude_row(), &fleet),
            SignIn::BrokenOn("ec2-box".into())
        );
    }

    /// The flaw a second machine exposed: board rows name the repo and the
    /// agent but never the runner that claimed them, so one box's dead key
    /// must not condemn a healthy peer. Warn both, block neither.
    #[test]
    fn a_second_box_is_not_blocked_by_its_peers_dead_key() {
        let fleet = vec![
            runner("ec2-box", true, &["claude"]),
            runner("mac-local-sim", true, &["claude"]),
        ];
        let verdict = attribute_sign_in("claude", &failed_claude_row(), &fleet);
        assert_eq!(verdict, SignIn::BrokenSomewhere);
        for r in &fleet {
            assert!(
                blocked_reason(r, "claude", &verdict).is_none(),
                "{} was blocked on ambiguous evidence",
                r.name
            );
            let warning = sign_in_warning(r, "claude", &verdict).expect("but it is warned about");
            assert!(warning.contains("more than one machine"), "{warning}");
        }
    }

    /// Offline boxes aren't candidates: they couldn't have run the job, and a
    /// warning on a machine that is already blocked for being down is noise.
    #[test]
    fn an_offline_peer_does_not_make_the_evidence_ambiguous() {
        let fleet = vec![
            runner("ec2-box", true, &["claude"]),
            runner("asleep", false, &["claude"]),
        ];
        assert_eq!(
            attribute_sign_in("claude", &failed_claude_row(), &fleet),
            SignIn::BrokenOn("ec2-box".into())
        );
        let verdict = SignIn::BrokenSomewhere;
        assert!(sign_in_warning(&fleet[1], "claude", &verdict).is_none());
    }

    /// A machine that doesn't run the agent at all has nothing to answer for.
    #[test]
    fn a_box_running_a_different_agent_is_neither_blamed_nor_warned() {
        let fleet = vec![
            runner("ec2-box", true, &["claude"]),
            runner("gem-box", true, &["gemini"]),
        ];
        let verdict = attribute_sign_in("claude", &failed_claude_row(), &fleet);
        assert_eq!(verdict, SignIn::BrokenOn("ec2-box".into()));
        assert!(sign_in_warning(&fleet[1], "claude", &SignIn::BrokenSomewhere).is_none());
    }

    /// No credential failure, no warning — the quiet case has to stay quiet or
    /// the caution stops meaning anything.
    #[test]
    fn a_healthy_fleet_raises_nothing() {
        let fleet = vec![
            runner("ec2-box", true, &["claude"]),
            runner("mac-local-sim", true, &["claude"]),
        ];
        let rows = vec![json!({ "agent_kind": "a2a:claude", "status": "completed" })];
        let verdict = attribute_sign_in("claude", &rows, &fleet);
        assert_eq!(verdict, SignIn::Fine);
        for r in &fleet {
            assert!(blocked_reason(r, "claude", &verdict).is_none());
            assert!(sign_in_warning(r, "claude", &verdict).is_none());
        }
    }

    /// Newest-terminal-wins. A credential failure that has since been followed
    /// by a completed job proves the key was fixed; treating it as current
    /// would lock the user out of a machine that works.
    #[test]
    fn a_sign_in_failure_stops_counting_once_a_later_job_succeeds() {
        // Newest first, the order the board returns.
        let rows = vec![
            json!({"agent_kind":"a2a:claude","status":"completed","error_message":null}),
            json!({"agent_kind":"a2a:claude","status":"failed",
                   "error_message":"agent 'claude' exited 1: Invalid API key"}),
        ];
        assert!(!sign_in_broken_for("claude", &rows));

        let rows_bad = vec![
            json!({"agent_kind":"a2a:claude","status":"failed",
                   "error_message":"agent 'claude' exited 1: Invalid API key · Fix external API key"}),
            json!({"agent_kind":"a2a:claude","status":"completed","error_message":null}),
        ];
        assert!(sign_in_broken_for("claude", &rows_bad));
    }

    #[test]
    fn one_agents_broken_key_does_not_condemn_another() {
        let rows = vec![json!({"agent_kind":"a2a:gemini","status":"failed",
                               "error_message":"Invalid API key"})];
        assert!(sign_in_broken_for("gemini", &rows));
        assert!(!sign_in_broken_for("claude", &rows));
    }

    /// A job that failed on the actual work is not a credential problem, and
    /// must not take the machine offline in the UI.
    #[test]
    fn a_job_that_failed_on_the_work_leaves_the_machine_usable() {
        let rows = vec![json!({"agent_kind":"a2a:claude","status":"failed",
                               "error_message":"tests failed: 3 assertions"})];
        assert!(!sign_in_broken_for("claude", &rows));
    }

    /// An in-flight job says nothing about credentials — it must not be read
    /// as either proof or refutation.
    #[test]
    fn a_running_job_is_not_evidence_either_way() {
        let rows = vec![
            json!({"agent_kind":"a2a:claude","status":"working","error_message":null}),
            json!({"agent_kind":"a2a:claude","status":"failed",
                   "error_message":"Not logged in"}),
        ];
        assert!(sign_in_broken_for("claude", &rows));
    }

    #[test]
    fn the_board_envelope_is_read_either_shape() {
        let bare = json!([{"id":"a"}]);
        let wrapped = json!({"tasks":[{"id":"a"}]});
        assert_eq!(board_rows(&bare).len(), 1);
        assert_eq!(board_rows(&wrapped).len(), 1);
        // An unknown envelope degrades to "no evidence", never to a panic.
        assert!(board_rows(&json!({"nope": 1})).is_empty());
    }

    #[test]
    fn a_brief_is_clipped_to_its_first_line() {
        assert_eq!(first_line("do the thing\nand more", 80), "do the thing");
        assert_eq!(first_line(&"x".repeat(200), 10), format!("{}…", "x".repeat(10)));
    }

    // ── handing a conversation over ────────────────────────────────────

    #[test]
    fn a_job_row_reads_the_brief_off_the_key_the_board_actually_uses() {
        // The regression this guards: the row was read as `input`, which the
        // board does not have, so every job in every list came back with a
        // null brief and nothing to recognise it by.
        let row = json!({
            "id": "job-1",
            "status": "working",
            "agent_kind": "a2a:claude",
            "input_text": "Finish the pi adapter\nsecond line",
        });
        let out = job_row(&row, "");
        assert_eq!(out["brief"], json!("Finish the pi adapter"));
        assert_eq!(out["agent"], json!("claude"));
    }

    #[test]
    fn a_job_placed_by_this_chat_is_marked_as_such() {
        let mine = json!({ "id": "a", "context_id": "sid-1" });
        let theirs = json!({ "id": "b", "context_id": "sid-2" });
        let nobodys = json!({ "id": "c" });
        assert_eq!(job_row(&mine, "sid-1")["from_this_chat"], json!(true));
        assert_eq!(job_row(&theirs, "sid-1")["from_this_chat"], json!(false));
        assert_eq!(job_row(&nobodys, "sid-1")["from_this_chat"], json!(false));
    }

    #[test]
    fn a_chat_with_no_session_claims_no_jobs_as_its_own() {
        // Otherwise an empty session id would match every unstamped row and a
        // headless caller would be told the whole board came from its chat.
        let nobodys = json!({ "id": "c" });
        assert_eq!(job_row(&nobodys, "")["from_this_chat"], json!(false));
    }

    #[test]
    fn a_row_stamped_with_blank_space_belongs_to_no_conversation() {
        assert_eq!(row_context(&json!({ "context_id": "   " })), None);
        assert_eq!(row_context(&json!({ "context_id": "sid" })), Some("sid"));
        assert_eq!(row_context(&json!({})), None);
    }

    #[test]
    fn the_model_can_actually_reach_the_handover() {
        // A capability the schema does not advertise is a capability nobody
        // can call — the tool loop only offers the model what is declared here.
        let schemas = tool_schemas();
        let send = schemas
            .iter()
            .find(|s| s["name"] == json!("aura_cloud_send"))
            .expect("aura_cloud_send is declared");
        assert!(
            send["input_schema"]["properties"]
                .get("continue_conversation")
                .is_some(),
            "the send tool must offer to carry the conversation"
        );
        let jobs = schemas
            .iter()
            .find(|s| s["name"] == json!("aura_cloud_jobs"))
            .expect("aura_cloud_jobs is declared");
        let scope = jobs["input_schema"]["properties"]["scope"]["description"]
            .as_str()
            .unwrap_or_default();
        assert!(
            scope.contains("conversation"),
            "the return leg must be reachable from the jobs tool"
        );
    }

    /// The parity gate for this plane.
    ///
    /// `native_tools::guard_dispatch` puts exactly one tool here through
    /// [`Capability::DispatchToMachine`](super::authority::Capability). The
    /// risk is not that the gate is wrong today — it is that somebody adds
    /// a fifth cloud tool next year that also places work, and it quietly
    /// runs ungated because nothing forced them to say so.
    ///
    /// So every tool in this module must be classified: either it is the
    /// dispatch, or it is named here as one that only reads or undoes. A
    /// new name fails the build until someone decides which it is.
    #[test]
    fn every_cloud_tool_is_classified_as_dispatch_or_not() {
        // Reads and undoes. Deliberately *not* gated: putting a card in
        // front of "what machines do I have" teaches people to click
        // through the card that matters, and cancelling a job you already
        // started takes authority away rather than granting it.
        const NEEDS_NO_CAPABILITY: &[&str] = &[
            "aura_cloud_machines",
            "aura_cloud_jobs",
            "aura_cloud_cancel",
        ];

        assert!(
            TOOL_NAMES.contains(&DISPATCH_TOOL),
            "DISPATCH_TOOL names a tool this module no longer serves, so the \
             authority gate in native_tools is guarding nothing"
        );

        for name in TOOL_NAMES {
            assert!(
                *name == DISPATCH_TOOL || NEEDS_NO_CAPABILITY.contains(name),
                "{name} is a new cloud tool nobody has classified. If it places \
                 work on another machine it belongs behind \
                 native_tools::guard_dispatch; if it only reads or undoes, add \
                 it to NEEDS_NO_CAPABILITY here and say why."
            );
        }
    }
}
