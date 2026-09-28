//! Disk persistence for ManagerSession.
//!
//! Sessions live at `~/.aura/manager-sessions/<sid>.json`. Atomic writes
//! via tempfile + rename so a crash mid-flush leaves the previous JSON
//! intact. Listed via `list_session_ids()` on shell startup so the UI
//! can re-attach to in-flight sessions.
//!
//! The transcript is not in that file. All but the last few turns live in
//! `<sid>.chat.jsonl` and are appended to rather than rewritten — see
//! [`super::chat_log`], which also explains why the split is a few turns
//! short of the end. What stays here is the session's description of itself:
//! its objective, status, projects, task DAG, ribbon and mid-turn brain
//! state, plus `chat_start`, the number of turns it handed to the log.
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

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::chat_log;
use super::{
    brain, ChatTurn, ManagerSession, ManagerStatus, ManagerTask, ManagerTaskStatus, PendingPlan,
    PendingQuestion, PendingScout, PlanParallelism, ProjectRef, RibbonEntry,
};

/// mtime-gated parse cache, keyed by session id → (stamp, session). Gating on
/// (mtime, len) makes a repeat load against unchanged files a pure clone, yet
/// `save()`'s atomic tempfile+rename moves both mtime and len, so a mutated
/// session re-parses on the next load. The healed `pending_plan` is cached
/// too, so the heal pass also only runs on a miss.
#[allow(clippy::type_complexity)]
fn load_cache() -> &'static Mutex<HashMap<String, (Stamp, ManagerSession)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Stamp, ManagerSession)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What a session is currently made of on disk: the stamp of its own file,
/// and the stamp of its transcript log if it has one. A load has to watch
/// both, because a turn appended to the log without anything else changing
/// still changes the conversation the cache is holding.
type Stamp = (Option<(u128, u64)>, Option<(u128, u64)>);

fn session_stamp(dir: &Path, id: &str, path: &Path) -> Stamp {
    (file_stamp(path), file_stamp(&chat_log::path(dir, id)))
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

/// Where a session id's JSON lives. Exposed for the card sidecar, which has
/// to stamp cards against the exact file they describe.
pub fn session_path_of(id: &str) -> Option<PathBuf> {
    session_path(id)
}

/// (mtime, len) of a path — the same stamp the load cache validates against,
/// shared with the card sidecar so both agree on what "unchanged" means.
pub fn stamp_of(path: &Path) -> Option<(u128, u64)> {
    file_stamp(path)
}

/// The session as it is written down: every field of [`ManagerSession`]
/// except that `chat` is only the live tail, and `chat_start` says how many
/// turns came before it in the log.
///
/// It borrows rather than clones because the thing it is avoiding is copies.
/// The fields are spelled out a second time here, which is a cost — so
/// [`SessionDoc::new`] destructures `ManagerSession` exhaustively, with no
/// `..` rest pattern. This is the only place that decides what reaches the
/// disk, and a field added to the session must fail to compile here rather
/// than quietly stop being saved.
#[derive(Serialize)]
struct SessionDoc<'a> {
    id: &'a String,
    objective: &'a String,
    status: &'a ManagerStatus,
    projects: &'a Vec<ProjectRef>,
    machine_id: &'a Option<String>,
    tasks: &'a Vec<ManagerTask>,
    ribbon: &'a Vec<RibbonEntry>,
    /// How many turns of this conversation are in `<sid>.chat.jsonl`, and so
    /// the index of the first turn `chat` below carries. Absent from files
    /// written before the split, where `chat` was the whole transcript —
    /// which is exactly what a defaulted `0` means on the way back in.
    chat_start: usize,
    chat: &'a [ChatTurn],
    pending_assistant_blocks: &'a Option<Vec<Value>>,
    pending_tool_results: &'a Option<Vec<Value>>,
    brain_backend: &'a Option<brain::BrainBackend>,
    cli_session_id: &'a Option<String>,
    pending_question: &'a Option<PendingQuestion>,
    pending_plan: &'a Option<PendingPlan>,
    #[serde(skip_serializing_if = "is_none")]
    pending_scout: &'a Option<PendingScout>,
    plan_parallelism: &'a PlanParallelism,
    #[serde(skip_serializing_if = "is_none")]
    brain_override: &'a Option<String>,
    created_at: u64,
    updated_at: u64,
}

/// `Option::is_none` through the extra reference serde hands a borrowed field.
fn is_none<T>(v: &&Option<T>) -> bool {
    v.is_none()
}

impl<'a> SessionDoc<'a> {
    fn new(s: &'a ManagerSession, chat_start: usize) -> Self {
        let ManagerSession {
            id,
            objective,
            status,
            projects,
            machine_id,
            tasks,
            ribbon,
            chat,
            pending_assistant_blocks,
            pending_tool_results,
            brain_backend,
            cli_session_id,
            pending_question,
            pending_plan,
            pending_scout,
            plan_parallelism,
            brain_override,
            created_at,
            updated_at,
        } = s;
        Self {
            id,
            objective,
            status,
            projects,
            machine_id,
            tasks,
            ribbon,
            chat_start,
            chat: &chat[chat_start.min(chat.len())..],
            pending_assistant_blocks,
            pending_tool_results,
            brain_backend,
            cli_session_id,
            pending_question,
            pending_plan,
            pending_scout,
            plan_parallelism,
            brain_override,
            created_at: *created_at,
            updated_at: *updated_at,
        }
    }
}

pub fn save(session: &ManagerSession) -> Result<(), String> {
    let dir = sessions_dir().ok_or("HOME not set")?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let path = session_path(&session.id).ok_or("HOME not set")?;

    // Transcript first, session second. The log only ever gains whole lines,
    // so an interrupted save leaves turns on disk that no session file claims
    // — which `chat_log::read_prefix` discards — rather than a session file
    // pointing past the end of its own transcript.
    let chat_start = chat_log::flush(&dir, &session.id, &session.chat)?;
    let doc = SessionDoc::new(session, chat_start);

    let mut tmp = tempfile::Builder::new()
        .prefix(".tmp-")
        .suffix(".json")
        .tempfile_in(&dir)
        .map_err(|e| format!("tempfile: {e}"))?;

    // Two routes to the same bytes. The `Value` route exists only so subagent
    // rows a CLI brain appended behind our back can be grafted back in, and it
    // builds a tree of the whole document to do it. When the file on disk
    // still carries our own stamp, nobody else has written to it, there is
    // nothing to graft, and the session goes straight into the tempfile.
    let mut out = std::io::BufWriter::new(tmp.as_file_mut());
    if wrote_last(&session.id, &path) {
        serde_json::to_writer_pretty(&mut out, &doc).map_err(|e| format!("serialize: {e}"))?;
    } else {
        let mut value = serde_json::to_value(&doc).map_err(|e| format!("serialize: {e}"))?;
        if let Some(disk) = read_value(&path) {
            graft_cli_subagents(&mut value, &disk);
        }
        serde_json::to_writer_pretty(&mut out, &value).map_err(|e| format!("serialize: {e}"))?;
    }
    // Flushed by hand: a `BufWriter` dropped with bytes still in it flushes
    // too, but swallows the error, and a half-written session that reports
    // success is the one failure this file exists to prevent.
    out.flush().map_err(|e| format!("write tempfile: {e}"))?;
    drop(out);
    tmp.persist(&path)
        .map_err(|e| format!("rename to {}: {e}", path.display()))?;

    if let (Some(stamp), Ok(mut m)) = (file_stamp(&path), write_stamps().lock()) {
        m.insert(session.id.clone(), stamp);
    }
    // Refresh the listing card in the same breath, so the chat list never has
    // to open this file again — however large its transcript has grown.
    super::session_card::write_beside(session, &path);
    Ok(())
}

/// The two arrays the merge below reads off disk, and nothing else.
///
/// Both callers of [`read_value`] ask the on-disk document for `tasks` and
/// `ribbon` — a handful of rows the CLI may have appended. Parsing the file
/// into a whole `Value` to reach them meant building a tree of every message
/// in the conversation first, and a save that happens after every tool call
/// paid for it each time. Serde walks past a key this struct does not name
/// without allocating.
#[derive(Deserialize)]
struct GraftSource {
    #[serde(default)]
    tasks: Vec<Value>,
    #[serde(default)]
    ribbon: Vec<Value>,
}

/// The on-disk session, reduced to the parts a merge looks at. Returned as a
/// `Value` so [`graft_cli_subagents`] and [`absorb_cli_subagents_from`] keep
/// reading it exactly as they read a full document.
fn read_value(path: &Path) -> Option<Value> {
    let raw = fs::read(path).ok()?;
    let lean: GraftSource = serde_json::from_slice(&raw).ok()?;
    Some(serde_json::json!({ "tasks": lean.tasks, "ribbon": lean.ribbon }))
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

/// `chat_start` alone, read from the session file a second time.
///
/// It is storage bookkeeping rather than session state, so it has no field on
/// [`ManagerSession`] and cannot ride in on the same parse. A second pass
/// over the file is the price, and since the transcript left that file it is
/// a pass over a few kilobytes.
#[derive(Deserialize)]
struct ChatSplit {
    #[serde(default)]
    chat_start: usize,
}

pub fn load(id: &str) -> Result<ManagerSession, String> {
    let dir = sessions_dir().ok_or("HOME not set")?;
    let path = session_path(id).ok_or("HOME not set")?;
    let stamp = session_stamp(&dir, id, &path);
    if stamp.0.is_some() {
        if let Ok(cache) = load_cache().lock() {
            if let Some((held, session)) = cache.get(id) {
                if *held == stamp {
                    return Ok(session.clone());
                }
            }
        }
    }
    let raw = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut session: ManagerSession =
        serde_json::from_slice(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;

    // Put the conversation back together. A file written before the split
    // carries the whole transcript in `chat` and no `chat_start`, so the
    // defaulted zero reads it correctly and the next save migrates it out.
    let split: ChatSplit = serde_json::from_slice(&raw).unwrap_or(ChatSplit { chat_start: 0 });
    let settled = if split.chat_start > 0 {
        let mut prefix = chat_log::read_prefix(&dir, id, split.chat_start);
        let settled = prefix.len();
        prefix.append(&mut session.chat);
        session.chat = prefix;
        settled
    } else {
        0
    };
    // Tell the log what we just read, so the first save after opening a long
    // session appends a turn instead of writing the conversation out again.
    chat_log::note_loaded(&dir, id, settled, &session.chat);

    // Inventory blocker #3 — heal the approved_by/approved_at pair on
    // read so half-written rows (older shells, hand-edited JSON, merge
    // artefacts) can't surface to the UI in an inconsistent state.
    if let Some(plan) = session.pending_plan.as_mut() {
        plan.heal_approval();
    }
    if stamp.0.is_some() {
        if let Ok(mut cache) = load_cache().lock() {
            cache.insert(id.to_string(), (stamp, session.clone()));
        }
    }
    Ok(session)
}

/// Everything a list row needs, and nothing that grows with the conversation.
///
/// `manager_list` renders one line per past session, and that line is built
/// entirely from the fields below — it never reads a message. Loading each
/// session in full to produce it meant deserialising every turn of every
/// conversation ever held, on every list: on this machine that is ~165 MB
/// across 200-odd files, about a second of work, asked for by seven call
/// sites, and then kept parsed in [`load_cache`] for the rest of the run.
/// Serde skips a key the target struct does not mention without allocating
/// for it, so omitting `ribbon` and the task bodies — which carry the whole
/// captured output of every agent that ran — makes the reader scan past the
/// bulk instead of materialising it. The transcript has since moved out of
/// this file entirely ([`super::chat_log`]), which takes the largest share
/// again, but what is left is still far more than a list row shows and there
/// is no reason to parse it. The file is still read
/// whole and parsed with `from_slice`: a streaming `from_reader` was measured
/// at more than twice the wall time of reading the bytes up front, and the
/// saving here was never the read — it is the tens of thousands of `String`s
/// that are now not allocated, and not then kept in a cache for the rest of
/// the run.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionHead {
    pub id: String,
    #[serde(default)]
    pub objective: String,
    pub status: ManagerStatus,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub projects: Vec<ProjectRef>,
    #[serde(default)]
    pub machine_id: Option<String>,
    /// Task *statuses* only. A row shows "3 of 7 done"; a `ManagerTask`
    /// carries the whole captured output of the agent that ran it.
    #[serde(default)]
    pub tasks: Vec<TaskHead>,
}

/// The one field of a task a summary row counts on.
#[derive(Debug, Clone, Deserialize)]
pub struct TaskHead {
    pub status: ManagerTaskStatus,
}

/// mtime-gated head cache, the small sibling of [`load_cache`]. Gated the
/// same way and for the same reason, but a hit here clones a handful of
/// strings rather than a transcript, so repeat lists really are cheap
/// instead of merely cheaper.
fn head_cache() -> &'static Mutex<HashMap<String, (u128, u64, SessionHead)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u128, u64, SessionHead)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read just enough of a session to list it. Prefer this to [`load`] anywhere
/// the transcript is not about to be shown.
pub fn load_head(id: &str) -> Result<SessionHead, String> {
    let path = session_path(id).ok_or("HOME not set")?;
    let stamp = file_stamp(&path);
    if let Some(stamp) = stamp {
        if let Ok(cache) = head_cache().lock() {
            if let Some((mtime, len, head)) = cache.get(id) {
                if (*mtime, *len) == stamp {
                    return Ok(head.clone());
                }
            }
        }
    }
    let raw = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let head: SessionHead =
        serde_json::from_slice(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    if let Some((mtime, len)) = stamp {
        if let Ok(mut cache) = head_cache().lock() {
            cache.insert(id.to_string(), (mtime, len, head.clone()));
        }
    }
    Ok(head)
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
        // Re-point HOME at a tempdir so this test doesn't pollute the real
        // `~/.aura/manager-sessions/`. The borrow serialises against every
        // other HOME-moving test and puts HOME back afterwards — see
        // `crate::test_home` for why leaving it moved used to cause flakes.
        let _home = crate::test_home::borrow();

        let s = ManagerSession::new("abc".into(), "obj".into(), vec![], vec![task(1)]);
        save(&s).unwrap();
        let loaded = load("abc").unwrap();
        assert_eq!(loaded.id, "abc");
        assert_eq!(loaded.tasks.len(), 1);
        assert!(list_session_ids().contains(&"abc".to_string()));
    }

    /// `load_head` must agree with `load` on every field a list row shows.
    ///
    /// The failure this guards against is a quiet one. They are two separate
    /// structs reading one file, so a field added to `ManagerSession` and to
    /// the summary row — but not to `SessionHead` — makes a session look one
    /// way in the history dropdown and another way once it is open, and only
    /// for the sessions nobody has open, which is all of them until they are
    /// clicked. Nothing throws; the number is just wrong.
    #[test]
    fn head_agrees_with_full_load() {
        let _home = crate::test_home::borrow();

        let mut s = ManagerSession::new(
            "heady".into(),
            "obj".into(),
            vec![crate::manager::ProjectRef {
                root: "/repo".into(),
                label: "repo".into(),
            }],
            vec![task(1), task(2)],
        );
        s.tasks[0].status = ManagerTaskStatus::Done;
        // A transcript long enough that reading it would be the whole cost.
        for i in 0..50 {
            s.push_chat(crate::manager::ChatRole::Manager, format!("turn {i}"));
        }
        save(&s).unwrap();

        let full = load("heady").unwrap();
        let head = load_head("heady").unwrap();

        assert_eq!(head.id, full.id);
        assert_eq!(head.objective, full.objective);
        assert_eq!(head.status, full.status);
        assert_eq!(head.created_at, full.created_at);
        assert_eq!(head.updated_at, full.updated_at);
        assert_eq!(head.machine_id, full.machine_id);
        assert_eq!(head.tasks.len(), full.tasks.len());
        assert_eq!(
            head.tasks
                .iter()
                .filter(|t| matches!(t.status, ManagerTaskStatus::Done))
                .count(),
            full.tasks
                .iter()
                .filter(|t| matches!(t.status, ManagerTaskStatus::Done))
                .count(),
        );
        assert_eq!(
            head.projects
                .iter()
                .map(|p| p.root.as_str())
                .collect::<Vec<_>>(),
            full.projects
                .iter()
                .map(|p| p.root.as_str())
                .collect::<Vec<_>>(),
        );
        // And the point of the exercise: however long the conversation ran,
        // the head never read a word of it.
        assert_eq!(full.chat.len(), 50);
    }

    /// The conversation must survive the round trip through two files, and
    /// the session file must stop carrying it.
    ///
    /// The second half is the point of the exercise and the part that could
    /// regress silently: a `chat` that keeps serialising in full still reads
    /// back correctly, so only the file size shows the saving is gone.
    #[test]
    fn a_long_conversation_leaves_the_session_file() {
        let _home = crate::test_home::borrow();

        let mut s = ManagerSession::new("long".into(), "obj".into(), vec![], vec![task(1)]);
        for i in 0..200u64 {
            s.push_chat(crate::manager::ChatRole::Manager, format!("turn {i}"));
            s.chat.last_mut().unwrap().at = 1000 + i;
        }
        save(&s).unwrap();

        let back = load("long").unwrap();
        assert_eq!(back.chat.len(), 200);
        assert_eq!(back.chat[0].text, "turn 0");
        assert_eq!(back.chat[199].text, "turn 199");
        assert_eq!(back.tasks.len(), 1, "the rest of the session came too");

        let dir = sessions_dir().unwrap();
        let head = fs::read_to_string(dir.join("long.json")).unwrap();
        assert!(!head.contains("turn 0"), "the archived turns left the session file");
        assert!(head.contains("turn 199"), "the live tail stayed with it");
        assert_eq!(
            serde_json::from_str::<Value>(&head).unwrap()["chat"]
                .as_array()
                .unwrap()
                .len(),
            chat_log::TAIL,
        );
    }

    /// Adding a turn to a long conversation must not rewrite it.
    ///
    /// This is the bug the split exists to fix — the brain loop saves after
    /// every tool call, and each save used to re-serialise every message ever
    /// sent. Asserted on bytes written rather than on wall time, so it means
    /// the same thing on a slow machine.
    #[test]
    fn saving_one_more_turn_rewrites_only_the_tail() {
        let _home = crate::test_home::borrow();

        let mut s = ManagerSession::new("append".into(), "obj".into(), vec![], vec![]);
        for i in 0..400u64 {
            s.push_chat(crate::manager::ChatRole::Manager, "x".repeat(400));
            s.chat.last_mut().unwrap().at = 1000 + i;
        }
        save(&s).unwrap();

        let dir = sessions_dir().unwrap();
        let log = chat_log::path(&dir, "append");
        let before = fs::read_to_string(&log).unwrap();
        let head_len = fs::metadata(dir.join("append.json")).unwrap().len();

        s.push_chat(crate::manager::ChatRole::User, "and one more".into());
        s.chat.last_mut().unwrap().at = 2000;
        save(&s).unwrap();

        let after = fs::read_to_string(&log).unwrap();
        assert!(after.starts_with(&before), "the archive was added to, not rewritten");
        assert!(
            head_len < 8_000,
            "the session file stays small however long the chat runs, was {head_len}",
        );
        assert_eq!(load("append").unwrap().chat.len(), 401);
    }

    /// Sessions written before the split keep their transcript inline and
    /// have no `chat_start`. They must open unchanged, and move to the new
    /// shape the first time they are saved.
    #[test]
    fn a_session_written_before_the_split_still_opens() {
        let _home = crate::test_home::borrow();
        let dir = sessions_dir().unwrap();
        fs::create_dir_all(&dir).unwrap();

        let turns: Vec<Value> = (0..30)
            .map(|i| serde_json::json!({ "role": "manager", "text": format!("old {i}"), "at": 1000 + i }))
            .collect();
        fs::write(
            dir.join("legacy.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "id": "legacy",
                "objective": "obj",
                "status": "running",
                "projects": [],
                "tasks": [],
                "ribbon": [],
                "chat": turns,
                "created_at": 1,
                "updated_at": 2,
            }))
            .unwrap(),
        )
        .unwrap();

        let opened = load("legacy").unwrap();
        assert_eq!(opened.chat.len(), 30);
        assert_eq!(opened.chat[0].text, "old 0");

        save(&opened).unwrap();
        let migrated = load("legacy").unwrap();
        assert_eq!(migrated.chat.len(), 30);
        assert_eq!(migrated.chat[0].text, "old 0");
        assert_eq!(migrated.chat[29].text, "old 29");
        assert!(chat_log::path(&dir, "legacy").exists());
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

