//! Local placement — the tools that let Aura start work *here*, and bring
//! cloud work home.
//!
//! `cloud_plane` gave the orchestrator a way to push work onto a machine that
//! isn't this one. It had no counterpart, and that asymmetry is a real hole:
//! asked to "do the first three in the cloud and the rest here", Aura could
//! only do the first half of the sentence. It would send three, then describe
//! the remainder in prose — which reads as agreement and leaves nothing
//! running. A tool that can only place work *away* cannot divide work.
//!
//! So this is the other half of one idea, not a second feature. `aura_work_start`
//! puts a job on this machine the same way `aura_cloud_send` puts one on the
//! box, and `aura_work_sync` is the return leg for whatever went out.
//!
//! ## The same board, two drainers
//!
//! Local and remote are not separate queues. A local job is a node on this
//! repo's own crew graph (`.aura/a2a/`), driven through the real Crew harness
//! — the identical path the automations scheduler uses, so a job started from
//! chat lands in the proof gate and the run ledger exactly like one started by
//! a schedule. A cloud job is a row on the shared A2A board that a runner
//! drains. Both come back through `aura loop cloud-sync`. What differs is who
//! claims the work, not what the work is.
//!
//! ## Placing a task, not a paraphrase
//!
//! Both placement tools take an optional `task` — a board handle (`AURA-12`, a
//! sequence number, an internal id). Given one, the brief is built from the
//! task itself rather than from the model's summary of it, and the task is
//! moved to started and stamped with where it went. That linkage is the
//! difference between "three jobs are running somewhere" and a board that can
//! answer which task each one is. Without it the model must re-describe work
//! it has already read, and a paraphrase is where detail goes to die.

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use super::control_plane::resolve_one;
use crate::cmd_tasks::{Task, UpdateTaskInput};

/// Cap on one tool result fed back to the model. Matches the sibling planes.
const MAX_RESULT_CHARS: usize = 16_000;

/// The tool names this module owns.
pub const TOOL_NAMES: &[&str] = &["aura_work_start", "aura_work_sync"];

/// True when `name` is one of the local-placement tools.
pub fn is_local_tool(name: &str) -> bool {
    TOOL_NAMES.contains(&name)
}

/// Anthropic-format schemas for the local-placement tools.
pub fn tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "aura_work_start",
            "description": "Start a piece of work on THIS machine, right now — the local counterpart of aura_cloud_send. This is the tool for 'do that here', 'run it locally', 'and the rest on my laptop'. The job is minted on this repo's own crew graph and driven through the real Crew harness, so it lands in the proof gate and the run ledger like any other run — it is not a suggestion, it starts. Use it together with aura_cloud_send to split a batch across places: send the ones that should survive the laptop closing, start the rest here. Prefer passing `task` over retyping the work: the brief is then built from the board entry itself rather than from your summary of it.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "A board task to run — 'AURA-12', a bare sequence number, or an internal id. The brief comes from the task's own title and description, and the task is moved to started and stamped with where it ran. Omit only for work that is not on the board."
                    },
                    "text": {
                        "type": "string",
                        "description": "The brief for the agent, when the work is not a board task. Self-contained: name the files, the goal, and any constraint that matters. Ignored if `task` is given and the task has a description."
                    },
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path (a worktree path is fine). Omit for the project this chat is open on."
                    },
                    "acceptance": {
                        "type": "string",
                        "description": "One line describing what 'done' means, in terms Aura can later prove. Include it whenever the user stated an outcome."
                    },
                    "agent": {
                        "type": "string",
                        "description": "Which agent CLI should run it — 'claude', 'gemini', 'codex', 'opencode'. Defaults to claude."
                    }
                },
                "required": []
            }
        }),
        json!({
            "name": "aura_work_sync",
            "description": "Bring finished cloud work home, and report finished local work up. Call this after cloud jobs complete — 'did that come back?', 'sync it', 'pull the results' — and whenever the user is about to look at code a machine was working on. Returns how many nodes came down and went up. Sync is safe to repeat: work already pulled is not pulled twice.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "project": {
                        "type": "string",
                        "description": "Project label, id, or absolute path. Omit for the project this chat is open on."
                    },
                    "direction": {
                        "type": "string",
                        "description": "'pull' (bring cloud work home), 'push' (report local work up), or 'both' (default)."
                    }
                },
                "required": []
            }
        }),
    ]
}

/// Dispatch one local-placement tool. Same `(result_text, is_error)` contract
/// as the sibling planes.
///
/// `app` is what separates this module from its siblings: starting work needs
/// the running app's dispatcher, and there is no honest way to fake one. A
/// caller with no app (the tests, any headless reuse) gets a refusal that says
/// so rather than a panic or a job that is minted and never driven.
pub async fn execute(
    app: Option<&AppHandle>,
    repo_root: &str,
    name: &str,
    input: &Value,
) -> (String, bool) {
    let (text, is_error) = match name {
        "aura_work_start" => tool_start(app, repo_root, input).await,
        "aura_work_sync" => tool_sync(repo_root, input).await,
        other => (format!("unknown local tool: {other}"), true),
    };
    if text.len() > MAX_RESULT_CHARS {
        let mut cut = text;
        cut.truncate(MAX_RESULT_CHARS);
        cut.push_str("\n… (truncated)");
        return (cut, is_error);
    }
    (text, is_error)
}

/// A brief plus, when it came from the board, the task it belongs to.
///
/// Shared with `cloud_plane`: both placements resolve a brief the same way, and
/// two copies of this rule would drift into local and cloud disagreeing about
/// what a task means.
#[derive(Debug)]
pub(super) struct Brief {
    pub(super) text: String,
    pub(super) acceptance: Option<String>,
    pub(super) task: Option<Task>,
}

/// Build the brief from a board task when one is named, else from `text`.
///
/// A task's description is the brief the user already wrote. Preferring it over
/// the model's `text` is deliberate: asked to run five board tasks, a model
/// will compress each into a sentence, and the agent that receives that
/// sentence never sees the acceptance criteria, the file names, or the caveat
/// in paragraph three. The one case `text` still wins is a task with an empty
/// description — then the model's summary is all there is.
pub(super) async fn resolve_brief(repo_root: &str, input: &Value) -> Result<Brief, String> {
    let free_text = input
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let acceptance = input
        .get("acceptance")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let Some(needle) = input
        .get("task")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        let text = free_text.ok_or_else(|| {
            "Nothing to run — pass `task` to run something already on the board, \
             or `text` to brief the agent directly."
                .to_string()
        })?;
        return Ok(Brief { text, acceptance, task: None });
    };

    let tasks = crate::cmd_tasks::tasks_list(repo_root.to_string())
        .await
        .map_err(|e| format!("couldn't read the board: {e}"))?;
    let found = tasks
        .iter()
        .find(|t| task_matches(t, needle))
        .cloned()
        .ok_or_else(|| {
            format!(
                "no task matching '{needle}' on this project's board — call aura_tasks_list \
                 to see what is there, and check `project` names the right one."
            )
        })?;

    // Title alone is a label, not a brief; the description is where the actual
    // instruction lives. Keep both so the agent has the headline and the body.
    let desc = found.description.trim();
    let text = if desc.is_empty() {
        match free_text {
            Some(t) => format!("{}\n\n{t}", found.title.trim()),
            None => found.title.trim().to_string(),
        }
    } else {
        format!("{}\n\n{desc}", found.title.trim())
    };
    Ok(Brief { text, acceptance, task: Some(found) })
}

/// Same matching rule the board tools use: internal id, bare sequence, or the
/// `AURA-n` handle the UI shows.
fn task_matches(t: &Task, needle: &str) -> bool {
    let n = needle.trim();
    if t.id == n {
        return true;
    }
    let seq = t.sequence_id.to_string();
    n == seq || n.eq_ignore_ascii_case(&format!("AURA-{seq}"))
}

/// The label a placed task wears, so the board itself can answer "what is
/// running where" without joining against the job list.
pub(super) const PLACED_LOCAL: &str = "running-local";
pub(super) const PLACED_CLOUD: &str = "running-cloud";

/// Move a placed task to started, name the agent on it, and label where it
/// went.
///
/// The labels are merged rather than set: `labels` is a whole-list writer, so
/// assigning `["running-cloud"]` would silently drop whatever the user had put
/// there. Placing work is not a reason to lose their labels. The two placement
/// labels are also mutually exclusive — moving a task from one place to the
/// other should not leave it claiming both.
///
/// Best-effort on purpose: the work is already running by the time this is
/// called, and failing the tool because a status write didn't land would tell
/// the user nothing started when something did. The miss is reported in the
/// result instead, where it is true and harmless.
pub(super) async fn mark_task_placed(
    repo_root: &str,
    task: &Task,
    placed: &str,
    agent: &str,
) -> Option<String> {
    let mut labels: Vec<String> = task
        .labels
        .iter()
        .filter(|l| l.as_str() != PLACED_LOCAL && l.as_str() != PLACED_CLOUD)
        .cloned()
        .collect();
    labels.push(placed.to_string());

    let patch = json!({
        "id": task.id,
        "status": "in_progress",
        "agent_assignee": agent,
        "labels": labels,
    });
    let upd: UpdateTaskInput = match serde_json::from_value(patch) {
        Ok(u) => u,
        Err(e) => return Some(format!("couldn't shape the board update: {e}")),
    };
    match crate::cmd_tasks::tasks_update(repo_root.to_string(), upd).await {
        Ok(_) => None,
        Err(e) => Some(format!("started, but the board still shows it unstarted: {e}")),
    }
}

async fn tool_start(app: Option<&AppHandle>, repo_root: &str, input: &Value) -> (String, bool) {
    let Some(app) = app else {
        return (
            "Can't start work here — this chat has no running app to drive it. \
             Offer aura_cloud_send instead, which places the work on a machine."
                .into(),
            true,
        );
    };
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
    let brief = match resolve_brief(&target.root, input).await {
        Ok(b) => b,
        Err(e) => return (e, true),
    };

    // The dispatcher is the app's own managed state — the same one Mission
    // Control and the automations scheduler drive. Reaching for it here rather
    // than making a second one is what keeps a chat-started run indistinguishable
    // from any other run: one lease table, one ledger, one set of proofs.
    let Some(dispatcher) = app.try_state::<std::sync::Arc<crate::manager::dispatcher::DispatcherState>>()
    else {
        return (
            "Can't start work here — the run dispatcher isn't up yet. Try again in a moment, \
             or use aura_cloud_send to place it on a machine."
                .into(),
            true,
        );
    };
    let dispatcher = dispatcher.inner().clone();

    let graph = aura_loop::LoopGraph::at(std::path::Path::new(&target.root));
    let title = first_line(&brief.text, 80);
    let node = match graph.create(
        title.clone(),
        brief.text.clone(),
        "medium".to_string(),
        aura_loop::KIND_TASK.to_string(),
        vec![],
        brief.acceptance.clone().or_else(|| Some(brief.text.clone())),
        Some(format!("a2a:{agent}")),
        // Tagged like its cloud sibling so "who started this?" has an answer on
        // a board several things write to.
        vec!["aura-chat".to_string(), "local".to_string()],
    ) {
        Ok(n) => n,
        Err(e) => return (format!("couldn't put the work on this project's board: {e}"), true),
    };

    // Drive exactly the node we just minted — `max: 1` — so asking for one
    // thing never quietly drains a backlog the user didn't mention.
    let dispatch = crate::cmd_loop::run_native_dispatch(
        app.clone(),
        dispatcher,
        target.root.clone(),
        Some(1),
        Some(1),
        None,
        None,
    )
    .await;

    let board_note = match brief.task.as_ref() {
        Some(t) => mark_task_placed(&target.root, t, PLACED_LOCAL, &agent).await,
        None => None,
    };

    match dispatch {
        Ok(res) => (
            json!({
                "started": true,
                "where": "this machine",
                "node": node.id,
                "task": brief.task.as_ref().map(|t| format!("AURA-{}", t.sequence_id)),
                "project": target.label,
                "agent": agent,
                "title": title,
                "ran": serde_json::to_value(&res).unwrap_or(Value::Null),
                "board_note": board_note,
                "note": "Running here, in this project's crew lane. It stops if the app quits — \
                         use aura_cloud_send for work that must outlive the laptop."
            })
            .to_string(),
            false,
        ),
        // The node is real and on the board even when the harness refused it,
        // so say that rather than implying nothing happened — the user can see
        // the row, and a message claiming otherwise is the confusing one.
        Err(e) => (
            format!(
                "The work is on this project's board as {} but the local run didn't start: {e}. \
                 It can be run from Mission Control, or sent to a machine with aura_cloud_send.",
                node.id
            ),
            true,
        ),
    }
}

async fn tool_sync(repo_root: &str, input: &Value) -> (String, bool) {
    let target = match resolve_one(repo_root, input) {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let dir = input
        .get("direction")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("both");
    let (pull, push) = match dir {
        "pull" => (true, false),
        "push" => (false, true),
        _ => (false, false), // the command's own "run both legs" signal
    };

    match crate::cmd_loop::loop_cloud_sync(target.root.clone(), pull, push).await {
        Ok(res) => (
            json!({
                "synced": true,
                "project": target.label,
                "repo": res.repo,
                "pulled": res.pulled,
                "pushed": res.pushed,
                "notes": res.notes,
                "note": if res.pulled == 0 && res.pushed == 0 {
                    "Nothing moved — either the cloud work hasn't finished yet (check \
                     aura_cloud_jobs) or it was already brought home."
                } else {
                    "Cloud results are now in this project's graph."
                }
            })
            .to_string(),
            false,
        ),
        Err(e) => (format!("sync failed: {e}"), true),
    }
}

/// First line of a brief, clipped — the node's title. A title is a handle, not
/// a summary; the full brief is the node's input.
fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.chars().count() <= max {
        return line.to_string();
    }
    let cut: String = line.chars().take(max.saturating_sub(1)).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(seq: u64, id: &str, title: &str, desc: &str) -> Task {
        serde_json::from_value(json!({
            "id": id,
            "sequence_id": seq,
            "title": title,
            "description": desc,
            "status": "backlog",
            "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z",
        }))
        .expect("task fixture")
    }

    #[test]
    fn a_task_is_found_by_every_name_a_person_would_use() {
        let t = task(12, "abc123", "Fix the retry", "");
        assert!(task_matches(&t, "AURA-12"));
        assert!(task_matches(&t, "aura-12"));
        assert!(task_matches(&t, "12"));
        assert!(task_matches(&t, "abc123"));
        assert!(!task_matches(&t, "AURA-13"));
        assert!(!task_matches(&t, "1"));
    }

    #[test]
    fn a_title_becomes_a_handle_not_a_paragraph() {
        assert_eq!(first_line("Fix the retry\n\nlong body here", 80), "Fix the retry");
        // Leading blank lines are skipped rather than producing an empty title.
        assert_eq!(first_line("\n\n  Real title  ", 80), "Real title");
        let long = "a".repeat(200);
        let out = first_line(&long, 10);
        assert_eq!(out.chars().count(), 10);
        assert!(out.ends_with('…'));
    }

    #[tokio::test]
    async fn placing_nothing_is_refused_rather_than_guessed() {
        let err = resolve_brief("/nonexistent", &json!({})).await.unwrap_err();
        assert!(err.contains("Nothing to run"), "{err}");
    }

    #[tokio::test]
    async fn free_text_alone_is_a_valid_brief() {
        let b = resolve_brief("/nonexistent", &json!({ "text": "  do the thing  " }))
            .await
            .expect("free text is enough");
        assert_eq!(b.text, "do the thing");
        assert!(b.task.is_none());
    }

    #[tokio::test]
    async fn starting_without_an_app_says_so_instead_of_pretending() {
        // The honesty rule this module inherits from its cloud sibling: a tool
        // that cannot do the thing must refuse, not report success.
        let (out, err) = execute(None, "/nonexistent", "aura_work_start", &json!({"text": "x"})).await;
        assert!(err);
        assert!(out.contains("no running app"), "{out}");
    }

    /// The merge rule `mark_task_placed` applies, isolated from the file write
    /// so it can be asserted without a repo on disk.
    fn merged_labels(existing: &[&str], placed: &str) -> Vec<String> {
        let mut out: Vec<String> = existing
            .iter()
            .filter(|l| **l != PLACED_LOCAL && **l != PLACED_CLOUD)
            .map(|l| l.to_string())
            .collect();
        out.push(placed.to_string());
        out
    }

    #[test]
    fn placing_work_does_not_eat_the_labels_someone_put_there() {
        // `labels` is a whole-list writer. Setting it to just the placement tag
        // would quietly delete the user's own labels every time work was placed.
        assert_eq!(
            merged_labels(&["bug", "p1"], PLACED_CLOUD),
            vec!["bug", "p1", PLACED_CLOUD],
        );
    }

    #[test]
    fn a_task_cannot_be_running_in_two_places_at_once() {
        // Moving work from the cloud to this machine must clear the old claim,
        // or the board shows it in both places and neither reading is true.
        assert_eq!(
            merged_labels(&["bug", PLACED_CLOUD], PLACED_LOCAL),
            vec!["bug", PLACED_LOCAL],
        );
        // And re-placing in the same spot does not duplicate the tag.
        assert_eq!(merged_labels(&[PLACED_LOCAL], PLACED_LOCAL), vec![PLACED_LOCAL]);
    }

    #[tokio::test]
    async fn an_unknown_local_tool_is_an_error_not_a_silence() {
        let (out, err) = execute(None, "/x", "aura_work_teleport", &json!({})).await;
        assert!(err);
        assert!(out.contains("unknown local tool"), "{out}");
    }
}
