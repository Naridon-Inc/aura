//! Disk persistence for ManagerSession.
//!
//! Sessions live at `~/.aura/manager-sessions/<sid>.json`. Atomic writes
//! via tempfile + rename so a crash mid-flush leaves the previous JSON
//! intact. Listed via `list_session_ids()` on shell startup so the UI
//! can re-attach to in-flight sessions.
//!
//! We are not the only writer. When the Manager runs as a CLI brain
//! (Claude Code / Gemini / Codex / Cursor) it fans work out with
//! `aura subagent spawn-bg`, and that command appends the dispatched
//! task plus its ribbon events straight into this same JSON — see
//! `aura-cli/src/subagent.rs`. The shell meanwhile holds the session in
//! memory for the life of the tab, so a plain whole-file write erases
//! everything the CLI added since our last read. See
//! [`graft_cli_subagents`] for how that is merged back.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde_json::Value;

use super::{ManagerSession, ManagerTask, ManagerTaskStatus, RibbonEntry};

/// mtime-gated parse cache, keyed by session id → (mtime_nanos, len, session).
/// `manager_list` (which the Trace/Sessions pane fires on every open) reads and
/// JSON-parses every off-runtime session file from `~/.aura/manager-sessions/`;
/// for a user with many past sessions that is the bulk of the list cost. Gating
/// on (mtime, len) makes a repeat list against unchanged files a pure clone, yet
/// `save()`'s atomic tempfile+rename moves both mtime and len, so a mutated
/// session re-parses on the next load. The healed `pending_plan` is cached too,
/// so the heal pass also only runs on a miss.
#[allow(clippy::type_complexity)]
fn load_cache() -> &'static Mutex<HashMap<String, (u128, u64, ManagerSession)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u128, u64, ManagerSession)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// (mtime as unix-epoch nanos, byte length) used to validate the load cache.
fn file_stamp(path: &Path) -> Option<(u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

pub fn sessions_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("manager-sessions");
    Some(p)
}

fn session_path(id: &str) -> Option<PathBuf> {
    let mut p = sessions_dir()?;
    p.push(format!("{id}.json"));
    Some(p)
}

/// (mtime, len) of the last file *we* wrote, keyed by session id. If the
/// file still carries that stamp when we come to save again, nothing else
/// has touched it and the CLI-subagent merge can be skipped — the common
/// case costs one `stat` rather than a re-read and parse of a session
/// that can run to megabytes of chat.
fn write_stamps() -> &'static Mutex<HashMap<String, (u128, u64)>> {
    static STAMPS: OnceLock<Mutex<HashMap<String, (u128, u64)>>> = OnceLock::new();
    STAMPS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wrote_last(id: &str, path: &Path) -> bool {
    let Some(stamp) = file_stamp(path) else {
        return false;
    };
    write_stamps()
        .lock()
        .ok()
        .and_then(|m| m.get(id).copied())
        .is_some_and(|ours| ours == stamp)
}

pub fn save(session: &ManagerSession) -> Result<(), String> {
    let dir = sessions_dir().ok_or("HOME not set")?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = session_path(&session.id).ok_or("HOME not set")?;

    // Serialise through `Value` rather than straight to a string so any
    // subagent rows a CLI brain appended behind our back can be grafted
    // back in before the write. Skipped entirely when the file on disk is
    // still byte-for-byte the one we last wrote.
    let mut doc = serde_json::to_value(session).map_err(|e| format!("serialize: {e}"))?;
    if !wrote_last(&session.id, &path) {
        if let Some(disk) = read_value(&path) {
            graft_cli_subagents(&mut doc, &disk);
        }
    }
    let json = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;

    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .suffix(".json")
        .tempfile_in(&dir)
        .map_err(|e| format!("tempfile: {e}"))?;
    tmp.write_all(json.as_bytes())
        .map_err(|e| format!("write tempfile: {e}"))?;
    tmp.persist(&path)
        .map_err(|e| format!("rename to {}: {e}", path.display()))?;

    if let (Some(stamp), Ok(mut m)) = (file_stamp(&path), write_stamps().lock()) {
        m.insert(session.id.clone(), stamp);
    }
    Ok(())
}

fn read_value(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// A task row the CLI owns, recognised by the `subagent-<sid>-<n>` stream
/// channel `aura subagent spawn-bg` stamps on it. Tasks the shell itself
/// dispatched have no channel, so this never matches our own rows.
fn is_cli_subagent(task: &Value) -> bool {
    task.get("stream_channel")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.starts_with("subagent-"))
}

fn is_terminal(status: Option<&str>) -> bool {
    matches!(status, Some("done") | Some("failed"))
}

fn task_id_of(task: &Value) -> Option<u64> {
    task.get("id").and_then(|n| n.as_u64())
}

/// Ribbon rows the CLI wrote: the dispatch event carries the channel
/// directly, and the completion/failure events are matched by task id.
fn ribbon_is_cli(entry: &Value, cli_ids: &[u64]) -> bool {
    let Some(event) = entry.get("event") else {
        return false;
    };
    if event
        .get("channel")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.starts_with("subagent-"))
    {
        return true;
    }
    event
        .get("task_id")
        .and_then(|n| n.as_u64())
        .is_some_and(|id| cli_ids.contains(&id))
}

/// Merge the CLI's subagent rows from `disk` into the about-to-be-written
/// `fresh` document.
///
/// Without this the shell's write wins outright and the rows vanish, which
/// is not merely a display bug: `aura subagent wait <id>` finds the task by
/// id and reports "task not found", and `record_completion` writes the
/// finished agent's output into the matching row — so a subagent that ran
/// to completion has its result silently dropped.
///
/// Memory wins on every field it has an opinion about, with one exception:
/// a terminal status on disk beats a non-terminal one in memory, because
/// the CLI is the only party that observes the subagent exiting.
///
/// Id collision is possible in principle — `manager_set_tasks` renumbers
/// from 1 — but that path belongs to the native planning brain, which does
/// not dispatch through `aura subagent`. A collision resolves in memory's
/// favour rather than duplicating an id.
fn graft_cli_subagents(fresh: &mut Value, disk: &Value) {
    let Some(disk_tasks) = disk.get("tasks").and_then(|v| v.as_array()) else {
        return;
    };
    let cli: Vec<&Value> = disk_tasks.iter().filter(|t| is_cli_subagent(t)).collect();
    if cli.is_empty() {
        return;
    }
    let cli_ids: Vec<u64> = cli.iter().filter_map(|t| task_id_of(t)).collect();

    let mut added = Vec::new();
    for dt in &cli {
        let Some(id) = task_id_of(dt) else { continue };
        let slot = fresh
            .get_mut("tasks")
            .and_then(|v| v.as_array_mut())
            .and_then(|arr| arr.iter_mut().find(|t| task_id_of(t) == Some(id)));
        match slot {
            None => added.push((*dt).clone()),
            Some(ft) => {
                let disk_done = is_terminal(dt.get("status").and_then(|s| s.as_str()));
                let mem_done = is_terminal(ft.get("status").and_then(|s| s.as_str()));
                if disk_done && !mem_done {
                    for key in ["status", "output", "summary", "completed_at"] {
                        if let Some(v) = dt.get(key) {
                            ft[key] = v.clone();
                        }
                    }
                }
            }
        }
    }
    if let Some(arr) = fresh.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        if !added.is_empty() {
            arr.extend(added);
        }
        arr.sort_by_key(|t| task_id_of(t).unwrap_or(0));
    }

    let Some(disk_ribbon) = disk.get("ribbon").and_then(|v| v.as_array()) else {
        return;
    };
    let missing: Vec<Value> = {
        let held = fresh.get("ribbon").and_then(|v| v.as_array());
        disk_ribbon
            .iter()
            .filter(|e| ribbon_is_cli(e, &cli_ids))
            .filter(|e| !held.is_some_and(|h| h.iter().any(|x| *x == **e)))
            .cloned()
            .collect()
    };
    if missing.is_empty() {
        return;
    }
    if let Some(arr) = fresh.get_mut("ribbon").and_then(|v| v.as_array_mut()) {
        arr.extend(missing);
        arr.sort_by_key(|e| e.get("at").and_then(|n| n.as_u64()).unwrap_or(0));
    }
}

/// Pull CLI-dispatched subagent rows off disk into a live in-memory
/// session, so the next `manager:<id>` emit carries them and the user can
/// actually see the agents their Manager just fanned out. [`save`] keeps
/// them on disk; this is what puts them on screen.
///
/// Returns whether anything changed, so callers can skip a redundant emit.
pub fn absorb_cli_subagents(session: &mut ManagerSession) -> bool {
    let Some(path) = session_path(&session.id) else {
        return false;
    };
    absorb_cli_subagents_from(session, &path)
}

/// Path-taking half of [`absorb_cli_subagents`], so the merge can be tested
/// against a tempdir without reaching for the process-global `HOME` that the
/// rest of this module's tests already fight over.
fn absorb_cli_subagents_from(session: &mut ManagerSession, path: &Path) -> bool {
    if wrote_last(&session.id, path) {
        return false;
    }
    let Some(disk) = read_value(path) else {
        return false;
    };
    let Some(disk_tasks) = disk.get("tasks").and_then(|v| v.as_array()) else {
        return false;
    };

    let mut changed = false;
    let mut cli_ids: Vec<u64> = Vec::new();
    for dt in disk_tasks.iter().filter(|t| is_cli_subagent(t)) {
        let Some(id) = task_id_of(dt) else { continue };
        cli_ids.push(id);
        let Ok(parsed) = serde_json::from_value::<ManagerTask>(dt.clone()) else {
            continue;
        };
        match session.tasks.iter_mut().find(|t| t.id as u64 == id) {
            None => {
                session.tasks.push(parsed);
                changed = true;
            }
            Some(held) => {
                let mem_done = matches!(
                    held.status,
                    ManagerTaskStatus::Done | ManagerTaskStatus::Failed
                );
                let disk_done = matches!(
                    parsed.status,
                    ManagerTaskStatus::Done | ManagerTaskStatus::Failed
                );
                if disk_done && !mem_done {
                    *held = parsed;
                    changed = true;
                }
            }
        }
    }
    if cli_ids.is_empty() {
        return false;
    }
    if changed {
        session.tasks.sort_by_key(|t| t.id);
    }

    if let Some(disk_ribbon) = disk.get("ribbon").and_then(|v| v.as_array()) {
        for de in disk_ribbon.iter().filter(|e| ribbon_is_cli(e, &cli_ids)) {
            let Ok(entry) = serde_json::from_value::<RibbonEntry>(de.clone()) else {
                continue;
            };
            let held = session.ribbon.iter().any(|e| {
                e.at == entry.at
                    && serde_json::to_value(&e.event).ok() == serde_json::to_value(&entry.event).ok()
            });
            if !held {
                session.ribbon.push(entry);
                changed = true;
            }
        }
        if changed {
            session.ribbon.sort_by_key(|e| e.at);
        }
    }
    changed
}

pub fn load(id: &str) -> Result<ManagerSession, String> {
    let path = session_path(id).ok_or("HOME not set")?;
    let stamp = file_stamp(&path);
    if let Some(stamp) = stamp {
        if let Ok(cache) = load_cache().lock() {
            if let Some((mtime, len, session)) = cache.get(id) {
                if (*mtime, *len) == stamp {
                    return Ok(session.clone());
                }
            }
        }
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut session: ManagerSession = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    // Inventory blocker #3 — heal the approved_by/approved_at pair on
    // read so half-written rows (older shells, hand-edited JSON, merge
    // artefacts) can't surface to the UI in an inconsistent state.
    if let Some(plan) = session.pending_plan.as_mut() {
        plan.heal_approval();
    }
    if let Some((mtime, len)) = stamp {
        if let Ok(mut cache) = load_cache().lock() {
            cache.insert(id.to_string(), (mtime, len, session.clone()));
        }
    }
    Ok(session)
}

pub fn list_session_ids() -> Vec<String> {
    let Some(dir) = sessions_dir() else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manager::{ManagerSession, ManagerTask, ManagerTaskStatus};

    fn task(id: usize) -> ManagerTask {
        ManagerTask {
            id,
            description: "t".into(),
            agent_id: Some("claude".into()),
            depends_on: vec![],
            status: ManagerTaskStatus::Pending,
            project_root: "/tmp".into(),
            zones: vec![],
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
        }
    }

    #[test]
    fn round_trip() {
        // Re-point HOME at a tempdir so this test doesn't pollute the
        // real `~/.aura/manager-sessions/`.
        let tmp = tempfile::tempdir().unwrap();
        // Note: set_var is process-global; tests in this module run
        // sequentially under default cargo test, so this is OK in
        // isolation but flaky under --test-threads=N. The `serial`
        // marker would harden this; keeping it simple for now.
        unsafe { std::env::set_var("HOME", tmp.path()) };

        let s = ManagerSession::new("abc".into(), "obj".into(), vec![], vec![task(1)]);
        save(&s).unwrap();
        let loaded = load("abc").unwrap();
        assert_eq!(loaded.id, "abc");
        assert_eq!(loaded.tasks.len(), 1);
        assert!(list_session_ids().contains(&"abc".to_string()));
    }

    /// Shape of a row `aura subagent spawn-bg` writes. Deliberately built
    /// from raw JSON rather than from `ManagerTask` so the test fails if the
    /// two crates' field names ever drift apart — the CLI writes this by
    /// hand (`aura-cli/src/subagent.rs::record_dispatch`) and cannot see our
    /// struct.
    fn cli_task(id: u64, status: &str) -> Value {
        serde_json::json!({
            "id": id,
            "description": "research pricing",
            "agent_id": "claude",
            "depends_on": [],
            "status": status,
            "project_root": "/repo",
            "zones": [],
            "blocked_reason": null,
            "output": if status == "done" { "the verdict" } else { "" },
            "summary": null,
            "started_at": 100,
            "completed_at": if status == "done" { Some(200) } else { None },
            "stream_channel": format!("subagent-sid-{id}"),
            "worktree_path": null,
            "a2a_task_id": null,
        })
    }

    fn dispatch_ribbon(id: u64) -> Value {
        serde_json::json!({
            "at": 100,
            "event": {
                "kind": "task_dispatched",
                "task_id": id,
                "agent_id": "claude",
                "channel": format!("subagent-sid-{id}"),
            },
        })
    }

    fn ids(doc: &Value) -> Vec<u64> {
        doc["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(task_id_of)
            .collect()
    }

    #[test]
    fn graft_keeps_subagents_the_shell_never_saw() {
        // The exact bug: the CLI appended two dispatched agents while the
        // shell held `tasks: []` in memory. A blind write erased both, which
        // left `aura subagent wait` reporting "task not found" and threw away
        // each agent's output at completion.
        let mut fresh = serde_json::json!({ "tasks": [], "ribbon": [] });
        let disk = serde_json::json!({
            "tasks": [cli_task(1, "running"), cli_task(2, "running")],
            "ribbon": [dispatch_ribbon(1), dispatch_ribbon(2)],
        });
        graft_cli_subagents(&mut fresh, &disk);
        assert_eq!(ids(&fresh), vec![1, 2]);
        assert_eq!(fresh["ribbon"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn graft_takes_a_finished_status_from_disk() {
        // Only the CLI watches the subagent exit, so its terminal row wins
        // over whatever memory still believes.
        let mut fresh = serde_json::json!({ "tasks": [cli_task(1, "running")], "ribbon": [] });
        let disk = serde_json::json!({ "tasks": [cli_task(1, "done")], "ribbon": [] });
        graft_cli_subagents(&mut fresh, &disk);
        let t = &fresh["tasks"][0];
        assert_eq!(t["status"], "done");
        assert_eq!(t["output"], "the verdict");
        assert_eq!(t["completed_at"], 200);
        assert_eq!(ids(&fresh), vec![1], "no duplicate row for the same id");
    }

    #[test]
    fn graft_leaves_a_running_task_alone() {
        // The reverse direction must not happen: a stale `running` row on
        // disk cannot undo a completion the shell already recorded.
        let mut fresh = serde_json::json!({ "tasks": [cli_task(1, "done")], "ribbon": [] });
        let disk = serde_json::json!({ "tasks": [cli_task(1, "running")], "ribbon": [] });
        graft_cli_subagents(&mut fresh, &disk);
        assert_eq!(fresh["tasks"][0]["status"], "done");
    }

    #[test]
    fn graft_does_not_resurrect_the_shells_own_tasks() {
        // Rows without a `subagent-` channel belong to the shell. Replanning
        // (`manager_set_tasks`) legitimately drops them, and a merge that
        // brought them back would make a replan impossible.
        let mut fresh = serde_json::json!({ "tasks": [], "ribbon": [] });
        let disk = serde_json::json!({
            "tasks": [{ "id": 7, "description": "shell task", "status": "done" }],
            "ribbon": [],
        });
        graft_cli_subagents(&mut fresh, &disk);
        assert!(ids(&fresh).is_empty());
    }

    #[test]
    fn graft_does_not_duplicate_ribbon_rows_it_already_holds() {
        let mut fresh = serde_json::json!({ "tasks": [], "ribbon": [dispatch_ribbon(1)] });
        let disk = serde_json::json!({
            "tasks": [cli_task(1, "running")],
            "ribbon": [dispatch_ribbon(1)],
        });
        graft_cli_subagents(&mut fresh, &disk);
        assert_eq!(fresh["ribbon"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn absorb_puts_cli_subagents_into_live_state() {
        // What makes the agents visible: the live session picks the rows up,
        // so the `manager:<sid>` emit that carries the turn also carries them.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("sid.json");
        let doc = serde_json::json!({
            "id": "sid",
            "objective": "obj",
            "status": "running",
            "projects": [],
            "tasks": [cli_task(1, "running"), cli_task(2, "done")],
            "ribbon": [dispatch_ribbon(1), dispatch_ribbon(2)],
        });
        fs::write(&path, serde_json::to_string_pretty(&doc).unwrap()).unwrap();

        let mut session = ManagerSession::new("sid".into(), "obj".into(), vec![], vec![]);
        assert!(absorb_cli_subagents_from(&mut session, &path));
        assert_eq!(
            session.tasks.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(session.tasks[1].output, "the verdict");
        // Counted by kind rather than by length — `ManagerSession::new`
        // seeds a ribbon entry of its own, which the graft leaves alone.
        let dispatched = session
            .ribbon
            .iter()
            .filter(|e| matches!(e.event, crate::manager::RibbonEvent::TaskDispatched { .. }))
            .count();
        assert_eq!(dispatched, 2);
        // Idempotent — a second pass finds nothing new to add.
        assert!(!absorb_cli_subagents_from(&mut session, &path));
    }
}
