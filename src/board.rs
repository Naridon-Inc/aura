//! Faithful read / light-write access to the ADE **Tasks board**
//! (`.aura/tasks/tasks.json`) and **Pages wiki** (`.aura/notes/`) for the
//! agent-facing MCP tools.
//!
//! These two files are authored by the aura-shell desktop app. We operate on
//! the SAME on-disk schema — `serde_json::Value` for tasks, the
//! frontmatter-sandwich markdown for pages — so a CLI agent (Claude Code,
//! Codex, Gemini, …) and a human share ONE board and ONE wiki. We
//! deliberately do NOT stand up a second task store: there is already a
//! separate `task.rs` (`T-<uuid>` per-file model) in this crate used by the
//! older `aura task` CLI, and pointing agents at that would split the board
//! the user sees in the app from the one agents write.
//!
//! Scope is intentionally narrow: read everything, and patch only the few
//! fields an agent needs — status / assignee / priority for a task; title /
//! body / tags for a page. We mirror the legacy↔canonical pairs the shell
//! heals on read (`status`↔`state_id`, `assignee`↔`assignee_ids`) so a write
//! here stays consistent with what the app renders. Anything richer (cycles,
//! modules, labels catalog, sub-task trees) is left to the app.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

// ─── Tasks ──────────────────────────────────────────────────────────────

fn tasks_file(root: &Path) -> PathBuf {
    root.join(".aura").join("tasks").join("tasks.json")
}

/// Read the raw `{ "tasks": [...] }` document. A missing file is an empty
/// board, not an error — the app writes it lazily on first task create.
fn read_doc(root: &Path) -> Result<Value, String> {
    let p = tasks_file(root);
    if !p.exists() {
        return Ok(json!({ "tasks": [] }));
    }
    let bytes = fs::read(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", p.display()))
}

fn write_doc(root: &Path, doc: &Value) -> Result<(), String> {
    let p = tasks_file(root);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    atomic_write(&p, serde_json::to_string_pretty(doc).unwrap_or_default().as_bytes())
}

/// Legacy `status` → canonical `state_id`, mirroring aura-shell's
/// `legacy_status_to_state_id` so a status we set here heals to the same
/// state the app would pick.
fn status_to_state_id(status: &str) -> &'static str {
    match status {
        "backlog" => "backlog",
        "todo" => "unstarted",
        "in_progress" => "started",
        "in_review" => "started",
        "done" => "completed",
        "cancelled" => "cancelled",
        _ => "unstarted",
    }
}

/// The set an agent may set `status` to. Kept tight so a typo'd state
/// doesn't land on the board as a free-form string the kanban can't place.
pub const TASK_STATUSES: [&str; 6] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "cancelled",
];

const PRIORITIES: [&str; 5] = ["urgent", "high", "medium", "low", "none"];

/// Human-facing `AURA-{n}` handle, falling back to the raw id on rows that
/// predate the sequence allocator (sequence_id == 0).
fn task_ref(task: &Value) -> String {
    let seq = task.get("sequence_id").and_then(Value::as_u64).unwrap_or(0);
    if seq > 0 {
        format!("AURA-{seq}")
    } else {
        task.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }
}

/// Does `needle` identify `task`? Matches the raw id, an `AURA-{n}` ref
/// (case-insensitive, `AURA-` optional), or a bare sequence number.
fn task_matches(task: &Value, needle: &str) -> bool {
    let needle = needle.trim();
    if task.get("id").and_then(Value::as_str) == Some(needle) {
        return true;
    }
    let seq = task.get("sequence_id").and_then(Value::as_u64).unwrap_or(0);
    if seq == 0 {
        return false;
    }
    let stripped = needle
        .strip_prefix("AURA-")
        .or_else(|| needle.strip_prefix("aura-"))
        .unwrap_or(needle);
    stripped.parse::<u64>().map(|n| n == seq).unwrap_or(false)
}

/// Compact, agent-readable projection of a task — the shape `aura_tasks_list`
/// returns. Derives a display `state` from `state_id` (canonical) or the
/// healed legacy `status`, and the `AURA-{n}` ref so the agent can address it
/// in a follow-up `aura_task_update`.
fn project_summary(task: &Value) -> Value {
    let status = task.get("status").and_then(Value::as_str).unwrap_or("");
    let state_id = task.get("state_id").and_then(Value::as_str).unwrap_or("");
    let state = if state_id.is_empty() {
        status_to_state_id(status).to_string()
    } else {
        state_id.to_string()
    };
    // Assignees: prefer the multi-assignee array, fall back to the singular.
    let mut assignees: Vec<String> = task
        .get("assignee_ids")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if assignees.is_empty() {
        if let Some(a) = task.get("assignee").and_then(Value::as_str) {
            assignees.push(a.to_string());
        }
    }
    json!({
        "id": task.get("id").and_then(Value::as_str).unwrap_or(""),
        "ref": task_ref(task),
        "title": task.get("title").and_then(Value::as_str).unwrap_or(""),
        "status": status,
        "state": state,
        "priority": task.get("priority").and_then(Value::as_str).unwrap_or("none"),
        "assignees": assignees,
        "agent_assignee": task.get("agent_assignee").and_then(Value::as_str),
        "labels": task.get("labels").cloned().unwrap_or_else(|| json!([])),
        "due_date": task.get("due_date").and_then(Value::as_str),
        "updated_at": task.get("updated_at").and_then(Value::as_str).unwrap_or(""),
    })
}

/// List tasks as compact summaries, newest-updated first. `status` filters by
/// the friendly status bucket (matching either the legacy `status` or the
/// canonical `state` group); `limit` caps the result (0 ⇒ no cap).
pub fn list_tasks(root: &Path, status: Option<&str>, limit: usize) -> Result<Vec<Value>, String> {
    let doc = read_doc(root)?;
    let empty = vec![];
    let tasks = doc.get("tasks").and_then(Value::as_array).unwrap_or(&empty);

    let want_state = status.map(|s| status_to_state_id(s).to_string());
    let mut out: Vec<Value> = tasks
        .iter()
        .filter(|t| {
            let Some(want) = &want_state else { return true };
            let s = t.get("status").and_then(Value::as_str).unwrap_or("");
            let sid = t.get("state_id").and_then(Value::as_str).unwrap_or("");
            let have = if sid.is_empty() { status_to_state_id(s) } else { sid };
            have == want
        })
        .map(project_summary)
        .collect();

    // Newest-updated first so the agent sees current work at the top.
    out.sort_by(|a, b| {
        let av = a.get("updated_at").and_then(Value::as_str).unwrap_or("");
        let bv = b.get("updated_at").and_then(Value::as_str).unwrap_or("");
        bv.cmp(av)
    });
    if limit > 0 && out.len() > limit {
        out.truncate(limit);
    }
    Ok(out)
}

/// Fetch one task in full by id / `AURA-{n}` ref / bare sequence number.
pub fn get_task(root: &Path, id: &str) -> Result<Option<Value>, String> {
    let doc = read_doc(root)?;
    let empty = vec![];
    let tasks = doc.get("tasks").and_then(Value::as_array).unwrap_or(&empty);
    Ok(tasks.iter().find(|t| task_matches(t, id)).cloned())
}

/// A single field patch for `update_task`. `None` ⇒ leave untouched;
/// `assignee: Some(None)` ⇒ explicitly unassign.
#[derive(Default)]
pub struct TaskPatch {
    pub status: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<Option<String>>,
    pub agent_assignee: Option<Option<String>>,
}

/// Apply a patch to the matching task, mirroring the legacy↔canonical pairs
/// the app heals on read, bump `updated_at`, and persist. Returns the full
/// updated task. Validation rejects unknown status/priority values up front
/// so a typo never lands on the board.
pub fn update_task(root: &Path, id: &str, patch: TaskPatch) -> Result<Value, String> {
    if let Some(s) = &patch.status {
        if !TASK_STATUSES.contains(&s.as_str()) {
            return Err(format!(
                "Invalid status '{s}'. One of: {}",
                TASK_STATUSES.join(", ")
            ));
        }
    }
    if let Some(p) = &patch.priority {
        if !PRIORITIES.contains(&p.as_str()) {
            return Err(format!(
                "Invalid priority '{p}'. One of: {}",
                PRIORITIES.join(", ")
            ));
        }
    }

    let mut doc = read_doc(root)?;
    let tasks = doc
        .get_mut("tasks")
        .and_then(Value::as_array_mut)
        .ok_or("tasks.json has no `tasks` array")?;
    let task = tasks
        .iter_mut()
        .find(|t| task_matches(t, id))
        .ok_or_else(|| format!("No task matching '{id}'"))?;
    let obj = task
        .as_object_mut()
        .ok_or("task row is not an object")?;

    if let Some(s) = patch.status {
        let state_id = status_to_state_id(&s).to_string();
        obj.insert("status".into(), json!(s));
        obj.insert("state_id".into(), json!(state_id));
    }
    if let Some(p) = patch.priority {
        obj.insert("priority".into(), json!(p));
    }
    if let Some(a) = patch.assignee {
        match a {
            Some(handle) => {
                obj.insert("assignee".into(), json!(handle));
                obj.insert("assignee_ids".into(), json!([handle]));
            }
            None => {
                obj.insert("assignee".into(), Value::Null);
                obj.insert("assignee_ids".into(), json!([]));
            }
        }
    }
    if let Some(a) = patch.agent_assignee {
        obj.insert(
            "agent_assignee".into(),
            a.map(|h| json!(h)).unwrap_or(Value::Null),
        );
    }
    obj.insert("updated_at".into(), json!(now_iso()));

    let updated = task.clone();
    write_doc(root, &doc)?;
    Ok(updated)
}

/// Allocate one fresh `sequence_id`, mirroring aura-shell's
/// `allocate_sequence_id`: read `.aura/tasks/_meta.json`, take the larger of
/// its `next_seq` and `max(existing) + 1`, then persist `next_seq + 1`. Both
/// the app and the CLI recompute from `existing_max`, so even a missed meta
/// write self-heals on the next create rather than handing out a duplicate
/// `AURA-{n}`.
fn allocate_sequence_id(root: &Path, tasks: &[Value]) -> u64 {
    let meta_path = tasks_file(root).with_file_name("_meta.json");
    let mut next = fs::read(&meta_path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("next_seq").and_then(Value::as_u64))
        .unwrap_or(0);
    let existing_max = tasks
        .iter()
        .filter_map(|t| t.get("sequence_id").and_then(Value::as_u64))
        .max()
        .unwrap_or(0);
    if next <= existing_max {
        next = existing_max + 1;
    }
    if next == 0 {
        next = 1;
    }
    let _ = atomic_write(
        &meta_path,
        serde_json::to_vec_pretty(&json!({ "next_seq": next + 1 }))
            .unwrap_or_default()
            .as_slice(),
    );
    next
}

/// Create a task on the shared board (the same `.aura/tasks/tasks.json` the
/// desktop app reads). Writes exactly the columns the app needs — `id`,
/// `sequence_id`, `title`, `description`, `status` + its mirrored `state_id`,
/// `priority`, optional `agent_assignee`, and timestamps — and leaves every
/// other field to its serde default so the app's typed read stays valid.
/// `status` defaults to `todo`, `priority` to `medium`; both are validated so
/// a typo can't land an unplaceable row on the kanban. Returns the full row.
pub fn create_task(
    root: &Path,
    title: &str,
    description: Option<&str>,
    status: Option<&str>,
    priority: Option<&str>,
    agent_assignee: Option<&str>,
) -> Result<Value, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("`title` is required.".into());
    }
    let status = status.unwrap_or("todo");
    if !TASK_STATUSES.contains(&status) {
        return Err(format!(
            "Invalid status '{status}'. One of: {}",
            TASK_STATUSES.join(", ")
        ));
    }
    let priority = priority.unwrap_or("medium");
    if !PRIORITIES.contains(&priority) {
        return Err(format!(
            "Invalid priority '{priority}'. One of: {}",
            PRIORITIES.join(", ")
        ));
    }

    let mut doc = read_doc(root)?;
    if !doc.is_object() {
        doc = json!({ "tasks": [] });
    }
    if !doc
        .get("tasks")
        .map(|t| t.is_array())
        .unwrap_or(false)
    {
        doc.as_object_mut()
            .unwrap()
            .insert("tasks".into(), json!([]));
    }

    let seq = {
        let existing = doc
            .get("tasks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        allocate_sequence_id(root, &existing)
    };
    let now = now_iso();
    let agent = agent_assignee
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(String::from);
    let row = json!({
        "id": format!("task_{}", uuid::Uuid::new_v4()),
        "sequence_id": seq,
        "title": title,
        "description": description.unwrap_or(""),
        "status": status,
        "state_id": status_to_state_id(status),
        "priority": priority,
        "assignee_ids": [],
        "labels": [],
        "agent_assignee": agent,
        "created_at": now,
        "updated_at": now,
    });
    doc.get_mut("tasks")
        .and_then(Value::as_array_mut)
        .ok_or("tasks.json has no `tasks` array")?
        .push(row.clone());
    write_doc(root, &doc)?;
    Ok(row)
}

// ─── Pages (notes) ──────────────────────────────────────────────────────

const SCOPES: [&str; 3] = ["team", "channel", "member"];

fn notes_root(root: &Path) -> PathBuf {
    root.join(".aura").join("notes")
}

/// Strip path-unsafe characters from a single segment — mirrors aura-shell's
/// `sanitize_segment` so a bucket/id can't escape the notes root.
fn sanitize_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '/' || c == '\\' || c == '\0' || c.is_control() {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    let out = out.replace("..", "_");
    if out.is_empty() {
        "_".to_string()
    } else {
        out
    }
}

fn scope_dir(root: &Path, scope: &str, bucket: &str) -> PathBuf {
    let base = notes_root(root).join(scope);
    match scope {
        "team" => base,
        _ => {
            if bucket.is_empty() {
                base
            } else {
                base.join(sanitize_segment(bucket))
            }
        }
    }
}

fn note_path(root: &Path, scope: &str, bucket: &str, id: &str) -> PathBuf {
    scope_dir(root, scope, bucket).join(format!("{}.md", sanitize_segment(id)))
}

/// Split the optional JSON-frontmatter sandwich, returning `(frontmatter,
/// body)`. Mirrors aura-shell's `split_frontmatter`. Frontmatter is kept as a
/// `Value` object so unknown keys round-trip rather than being dropped.
fn split_frontmatter(text: &str) -> (Value, String) {
    let trimmed = text.trim_start_matches('\u{feff}');
    let mut lines = trimmed.lines();
    let Some(first) = lines.next() else {
        return (json!({}), String::new());
    };
    if first.trim() != "---" {
        return (json!({}), text.to_string());
    }
    let mut fm_buf = String::new();
    let mut closed = false;
    let mut body_offset = first.len() + 1;
    for line in lines.by_ref() {
        body_offset += line.len() + 1;
        if line.trim() == "---" {
            closed = true;
            break;
        }
        fm_buf.push_str(line);
        fm_buf.push('\n');
    }
    if !closed {
        return (json!({}), text.to_string());
    }
    let body = trimmed
        .get(body_offset..)
        .map(|s| s.trim_start_matches('\n').to_string())
        .unwrap_or_default();
    let fm: Value = serde_json::from_str(fm_buf.trim()).unwrap_or_else(|_| json!({}));
    (fm, body)
}

fn assemble(frontmatter: &Value, body: &str) -> String {
    let header = serde_json::to_string(frontmatter).unwrap_or_else(|_| "{}".to_string());
    let trimmed_body = body.trim_start_matches('\n');
    format!("---\n{header}\n---\n{trimmed_body}")
}

fn fm_str<'a>(fm: &'a Value, key: &str) -> Option<&'a str> {
    fm.get(key).and_then(Value::as_str)
}

fn project_note_summary(scope: &str, bucket: &str, id: &str, fm: &Value, body: &str) -> Value {
    // Title falls back to the first markdown heading, then the id — matching
    // how the app derives a display title for untitled notes.
    let title = fm_str(fm, "title").map(String::from).unwrap_or_else(|| {
        body.lines()
            .find(|l| l.trim_start().starts_with('#'))
            .map(|l| l.trim_start_matches('#').trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.to_string())
    });
    let default_vis = if scope == "member" { "private" } else { "shared" };
    json!({
        "id": id,
        "scope": scope,
        "bucket": bucket,
        "title": title,
        "updated_at": fm_str(fm, "updated_at").unwrap_or(""),
        "visibility": fm_str(fm, "visibility").unwrap_or(default_vis),
        "tags": fm.get("tags").cloned().unwrap_or_else(|| json!([])),
    })
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if SCOPES.contains(&scope) {
        Ok(())
    } else {
        Err(format!("Invalid scope '{scope}'. One of: {}", SCOPES.join(", ")))
    }
}

/// List page summaries. With no `scope`, walks all three scopes; `bucket`
/// narrows a channel/member scope to one channel handle / member.
pub fn list_notes(
    root: &Path,
    scope: Option<&str>,
    bucket: Option<&str>,
) -> Result<Vec<Value>, String> {
    if let Some(s) = scope {
        validate_scope(s)?;
    }
    let scopes: Vec<&str> = match scope {
        Some(s) => vec![s],
        None => SCOPES.to_vec(),
    };
    let mut out = Vec::new();
    for sc in scopes {
        collect_scope(root, sc, bucket, &mut out);
    }
    out.sort_by(|a, b| {
        let av = a.get("updated_at").and_then(Value::as_str).unwrap_or("");
        let bv = b.get("updated_at").and_then(Value::as_str).unwrap_or("");
        bv.cmp(av)
    });
    Ok(out)
}

fn collect_scope(root: &Path, scope: &str, bucket: Option<&str>, out: &mut Vec<Value>) {
    let base = notes_root(root).join(scope);
    if !base.exists() {
        return;
    }
    if scope == "team" {
        collect_dir(&base, scope, "", out);
        return;
    }
    // channel / member: one sub-dir per bucket.
    let entries = match fs::read_dir(&base) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let b = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(want) = bucket {
            if b != want {
                continue;
            }
        }
        collect_dir(&path, scope, b, out);
    }
}

fn collect_dir(dir: &Path, scope: &str, bucket: &str, out: &mut Vec<Value>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let text = fs::read_to_string(&path).unwrap_or_default();
        let (fm, body) = split_frontmatter(&text);
        out.push(project_note_summary(scope, bucket, &id, &fm, &body));
    }
}

/// Read one page in full — frontmatter, markdown body, and the raw on-disk
/// text (so an agent that wants to edit the whole file gets it verbatim).
pub fn read_note(
    root: &Path,
    scope: &str,
    bucket: &str,
    id: &str,
) -> Result<Option<Value>, String> {
    validate_scope(scope)?;
    let p = note_path(root, scope, bucket, id);
    if !p.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    let (fm, body) = split_frontmatter(&raw);
    Ok(Some(json!({
        "id": id,
        "scope": scope,
        "bucket": bucket,
        "frontmatter": fm,
        "body": body,
        "raw": raw,
    })))
}

/// Fields a page write may set. `id: None` mints a new page; an existing id
/// updates it in place, preserving `created_at` and any frontmatter keys not
/// named here.
pub struct NoteWrite<'a> {
    pub scope: &'a str,
    pub bucket: &'a str,
    pub id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub body: &'a str,
    pub tags: Option<Vec<String>>,
    pub visibility: Option<&'a str>,
    pub author: &'a str,
}

/// Create or update a page. Returns its summary (including the resolved id,
/// so a fresh create round-trips the new id back to the caller).
pub fn write_note(root: &Path, w: NoteWrite) -> Result<Value, String> {
    validate_scope(w.scope)?;
    if w.scope != "team" && w.bucket.is_empty() {
        return Err(format!(
            "scope '{}' requires a bucket (the channel handle / member)",
            w.scope
        ));
    }

    let id = w.id.map(String::from).unwrap_or_else(new_id);
    let p = note_path(root, w.scope, w.bucket, &id);

    // Preserve existing frontmatter + created_at when updating.
    let (mut fm, _) = if p.exists() {
        let raw = fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
        split_frontmatter(&raw)
    } else {
        (json!({}), String::new())
    };
    let obj = fm
        .as_object_mut()
        .ok_or("frontmatter is not a JSON object")?;

    let now = now_iso();
    if obj.get("created_at").and_then(Value::as_str).unwrap_or("").is_empty() {
        obj.insert("created_at".into(), json!(now));
    }
    obj.insert("updated_at".into(), json!(now));
    obj.insert("author".into(), json!(w.author));
    if let Some(t) = w.title {
        obj.insert("title".into(), json!(t));
    }
    if let Some(tags) = w.tags {
        obj.insert("tags".into(), json!(tags));
    }
    if let Some(v) = w.visibility {
        obj.insert("visibility".into(), json!(v));
    } else if !obj.contains_key("visibility") {
        let default_vis = if w.scope == "member" { "private" } else { "shared" };
        obj.insert("visibility".into(), json!(default_vis));
    }

    let text = assemble(&fm, w.body);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    atomic_write(&p, text.as_bytes())?;
    Ok(project_note_summary(w.scope, w.bucket, &id, &fm, w.body))
}

// ─── shared helpers ─────────────────────────────────────────────────────

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    format!("note_{}", uuid::Uuid::new_v4())
}

/// Write `bytes` to `path` via a temp file + rename so a reader (the app)
/// never sees a torn write.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename into {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aura_board_{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(dir.join(".aura").join("tasks")).unwrap();
        dir
    }

    fn seed_task(root: &Path) {
        let doc = json!({ "tasks": [{
            "id": "t1",
            "sequence_id": 5,
            "title": "Wire fallback",
            "description": "",
            "status": "backlog",
            "state_id": "backlog",
            "priority": "medium",
            "assignee": null,
            "assignee_ids": [],
            "created_at": "2026-06-07T00:00:00Z",
            "updated_at": "2026-06-07T00:00:00Z"
        }]});
        write_doc(root, &doc).unwrap();
    }

    #[test]
    fn tasks_list_filter_and_ref() {
        let root = scratch();
        seed_task(&root);
        let all = list_tasks(&root, None, 0).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["ref"], "AURA-5");
        assert_eq!(all[0]["state"], "backlog");
        // Filter that doesn't match → empty.
        assert_eq!(list_tasks(&root, Some("done"), 0).unwrap().len(), 0);
        // Filter that matches the legacy bucket.
        assert_eq!(list_tasks(&root, Some("backlog"), 0).unwrap().len(), 1);
    }

    #[test]
    fn task_get_by_id_ref_and_seq() {
        let root = scratch();
        seed_task(&root);
        assert!(get_task(&root, "t1").unwrap().is_some());
        assert!(get_task(&root, "AURA-5").unwrap().is_some());
        assert!(get_task(&root, "5").unwrap().is_some());
        assert!(get_task(&root, "AURA-99").unwrap().is_none());
    }

    #[test]
    fn task_update_mirrors_and_persists() {
        let root = scratch();
        seed_task(&root);
        let patch = TaskPatch {
            status: Some("in_progress".into()),
            priority: Some("high".into()),
            assignee: Some(Some("alice".into())),
            agent_assignee: Some(Some("claude".into())),
        };
        let updated = update_task(&root, "AURA-5", patch).unwrap();
        assert_eq!(updated["status"], "in_progress");
        assert_eq!(updated["state_id"], "started"); // mirrored
        assert_eq!(updated["priority"], "high");
        assert_eq!(updated["assignee"], "alice");
        assert_eq!(updated["assignee_ids"][0], "alice");
        assert_eq!(updated["agent_assignee"], "claude");
        // Persisted: a fresh read sees it.
        let fresh = get_task(&root, "t1").unwrap().unwrap();
        assert_eq!(fresh["status"], "in_progress");
        // Bad status is rejected, not written.
        let bad = update_task(&root, "t1", TaskPatch { status: Some("nope".into()), ..Default::default() });
        assert!(bad.is_err());
    }

    #[test]
    fn page_write_read_list_roundtrip() {
        let root = scratch();
        // Create a team page (no bucket).
        let summary = write_note(
            &root,
            NoteWrite {
                scope: "team",
                bucket: "",
                id: None,
                title: Some("Smoke"),
                body: "# Hi\n\nbody text",
                tags: Some(vec!["sprint".into()]),
                visibility: None,
                author: "claude",
            },
        )
        .unwrap();
        let id = summary["id"].as_str().unwrap().to_string();
        assert_eq!(summary["title"], "Smoke");
        assert_eq!(summary["visibility"], "shared"); // team default

        let read = read_note(&root, "team", "", &id).unwrap().unwrap();
        assert!(read["body"].as_str().unwrap().contains("body text"));
        assert_eq!(read["frontmatter"]["author"], "claude");
        let created = read["frontmatter"]["created_at"].as_str().unwrap().to_string();

        let listed = list_notes(&root, Some("team"), None).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["id"], id.as_str());

        // Update in place preserves created_at, keeps one file.
        write_note(
            &root,
            NoteWrite {
                scope: "team",
                bucket: "",
                id: Some(&id),
                title: Some("Smoke v2"),
                body: "# Hi\n\nupdated",
                tags: None,
                visibility: None,
                author: "claude",
            },
        )
        .unwrap();
        let read2 = read_note(&root, "team", "", &id).unwrap().unwrap();
        assert!(read2["body"].as_str().unwrap().contains("updated"));
        assert_eq!(read2["frontmatter"]["created_at"], created.as_str());
        assert_eq!(list_notes(&root, Some("team"), None).unwrap().len(), 1);
    }

    #[test]
    fn channel_page_requires_bucket() {
        let root = scratch();
        let err = write_note(
            &root,
            NoteWrite {
                scope: "channel",
                bucket: "",
                id: None,
                title: None,
                body: "x",
                tags: None,
                visibility: None,
                author: "claude",
            },
        );
        assert!(err.is_err());
    }
}
