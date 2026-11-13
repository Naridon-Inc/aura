//! Zed.
//!
//! Verified against a real install (`~/Library/Application Support/Zed`):
//!
//! * `db/0-stable/db.sqlite` — `workspaces(paths, timestamp,
//!   remote_connection_id, …)`: every window Zed opened, `paths` being its
//!   folder (one per line for a multi-folder window).
//! * `threads/threads.db` — `threads(id, summary, updated_at, created_at,
//!   parent_id, folder_paths, data_type, data)`: one agent conversation per
//!   row, `summary` its title, `data` the thread as JSON, zstd-compressed
//!   when `data_type` is `zstd`. The JSON (`version` 0.3.0) holds `title`,
//!   `model {provider, model}`, `messages` — `{"User": {id, content}}`,
//!   `{"Agent": {content, tool_results}}` or the string `"Resume"` — and
//!   `initial_project_snapshot.worktree_snapshots[].worktree_path`, the
//!   folder the conversation ran in. User content parts are `Text`, `Image`
//!   and `Mention {uri, content}`; agent parts are `Text`, `Thinking` and
//!   `ToolUse {id, name, raw_input, input}`, with each tool's
//!   `{tool_use_id, tool_name, is_error, content, output}` in
//!   `tool_results`.
//!
//! MCP servers (`context_servers` in `~/.config/zed/settings.json`) come
//! through Aura's existing reader.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::apply::ChatImport;
use super::model::{Item, ItemKind};
use super::{mcp_items, path_str, repo_item, rules_item, sqlite_ro, tilde, vscode_folders, ChatPlan, Ctx, Plan, Scanned};
use crate::cmd_agent_history::PrerollTurn;
use crate::manager::{PersistedToolCall, PersistedToolResult};

pub const ID: &str = "zed";
pub const NAME: &str = "Zed";

/// The largest thread Aura will open, uncompressed. The biggest seen on a
/// real install is 25 MB; past this something is wrong with the row.
const MAX_THREAD_BYTES: u64 = 256 * 1024 * 1024;

fn data_dir(home: &Path) -> PathBuf {
    vscode_folders::app_support(home).join("Zed")
}

pub fn threads_db(home: &Path) -> PathBuf {
    data_dir(home).join("threads").join("threads.db")
}

pub fn workspace_db(home: &Path) -> PathBuf {
    data_dir(home).join("db").join("0-stable").join("db.sqlite")
}

pub fn found(home: &Path) -> bool {
    threads_db(home).is_file() || workspace_db(home).is_file() || home.join(".config").join("zed").join("settings.json").is_file()
}

pub struct ChatRef {
    pub db: PathBuf,
    pub thread_id: String,
    pub title: String,
    pub root: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

fn parse_time(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|d| d.and_utc().timestamp_millis())
        })
}

/// A thread's `data` as a byte stream, uncompressed.
fn thread_reader<'a>(data_type: &str, data: &'a [u8]) -> Result<Box<dyn Read + 'a>, String> {
    match data_type {
        "zstd" => {
            let dec = ruzstd::streaming_decoder::StreamingDecoder::new(data).map_err(|e| format!("couldn't open the thread: {e}"))?;
            Ok(Box::new(dec.take(MAX_THREAD_BYTES)))
        }
        "json" => Ok(Box::new(data.take(MAX_THREAD_BYTES))),
        other => Err(format!("Zed saved this thread in a format Aura doesn't know ({other})")),
    }
}

#[cfg(test)]
pub fn thread_reader_for_tests<'a>(data_type: &str, data: &'a [u8]) -> Result<Box<dyn Read + 'a>, String> {
    thread_reader(data_type, data)
}

const SNAPSHOT_MARK: &[u8] = br#""initial_project_snapshot":{"worktree_snapshots":[{"worktree_path":""#;

/// The folder a thread ran in, found by streaming the thread for its
/// project snapshot rather than parsing the whole conversation. The key can't
/// occur inside a message: there its quotes would be escaped.
pub fn snapshot_folder(r: &mut dyn Read) -> Option<PathBuf> {
    let mut window: Vec<u8> = Vec::with_capacity(128 * 1024);
    let mut chunk = vec![0u8; 64 * 1024];
    let mut found_at: Option<usize> = None;
    loop {
        if found_at.is_none() {
            if let Some(i) = window.windows(SNAPSHOT_MARK.len()).position(|w| w == SNAPSHOT_MARK) {
                found_at = Some(i + SNAPSHOT_MARK.len());
            } else if window.len() > SNAPSHOT_MARK.len() {
                window.drain(..window.len() - SNAPSHOT_MARK.len());
            }
        }
        if let Some(start) = found_at {
            // The value runs to the first quote that isn't escaped.
            let rest = &window[start..];
            let mut escaped = false;
            for (j, b) in rest.iter().enumerate() {
                match (escaped, *b) {
                    (true, _) => escaped = false,
                    (false, b'\\') => escaped = true,
                    (false, b'"') => {
                        let quoted = &window[start - 1..start + j + 1];
                        return serde_json::from_slice::<String>(quoted).ok().map(PathBuf::from);
                    }
                    _ => {}
                }
            }
            if rest.len() > 64 * 1024 {
                return None;
            }
        }
        let n = r.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        window.extend_from_slice(&chunk[..n]);
    }
}

fn folder_column(s: &str) -> Option<PathBuf> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if s.starts_with('[') {
        return serde_json::from_str::<Vec<String>>(s).ok()?.into_iter().next().map(PathBuf::from);
    }
    s.lines().map(str::trim).find(|l| !l.is_empty()).map(PathBuf::from)
}

struct ThreadRow {
    id: String,
    title: String,
    created: Option<i64>,
    updated: Option<i64>,
    folder: Option<PathBuf>,
    data_type: String,
    data: Vec<u8>,
}

fn thread_rows(conn: &rusqlite::Connection) -> Result<Vec<ThreadRow>, String> {
    let cols = sqlite_ro::columns(conn, "threads");
    let has = |c: &str| cols.iter().any(|x| x == c);
    let sql = format!(
        "select id, summary, updated_at, {}, {}, data_type, data from threads {} order by updated_at desc",
        if has("created_at") { "created_at" } else { "null" },
        if has("folder_paths") { "folder_paths" } else { "null" },
        if has("parent_id") { "where parent_id is null" } else { "" },
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("couldn't read Zed's threads: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let updated: Option<String> = r.get(2)?;
            let created: Option<String> = r.get(3)?;
            let folder: Option<String> = r.get(4)?;
            Ok(ThreadRow {
                id: r.get(0)?,
                title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                updated: updated.as_deref().and_then(parse_time),
                created: created.as_deref().and_then(parse_time),
                folder: folder.as_deref().and_then(folder_column),
                data_type: r.get(5)?,
                data: r.get(6)?,
            })
        })
        .map_err(|e| format!("couldn't read Zed's threads: {e}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Folders Zed opened, newest first.
fn workspace_folders(home: &Path) -> Vec<(PathBuf, Option<i64>)> {
    let Ok(conn) = sqlite_ro::open(&workspace_db(home)) else { return Vec::new() };
    let cols = sqlite_ro::columns(&conn, "workspaces");
    if !cols.iter().any(|c| c == "paths") {
        return Vec::new();
    }
    let remote = if cols.iter().any(|c| c == "remote_connection_id") { "where remote_connection_id is null" } else { "" };
    let ts = if cols.iter().any(|c| c == "timestamp") { "timestamp" } else { "null" };
    let Ok(mut stmt) = conn.prepare(&format!("select paths, {ts} from workspaces {remote} order by {ts} desc")) else {
        return Vec::new();
    };
    let rows: Vec<(Option<String>, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map(|rows| rows.filter_map(Result::ok).collect())
        .unwrap_or_default();
    let mut out: Vec<(PathBuf, Option<i64>)> = Vec::new();
    for (paths, when) in rows {
        for line in paths.unwrap_or_default().lines().map(str::trim).filter(|l| l.starts_with('/')) {
            let p = PathBuf::from(line);
            if !out.iter().any(|(q, _)| q == &p) {
                out.push((p, when.as_deref().and_then(parse_time)));
            }
        }
    }
    out
}

pub fn scan(ctx: &Ctx, out: &mut Scanned) {
    let mut chats_per_root: HashMap<PathBuf, usize> = HashMap::new();
    let mut chat_items = Vec::new();
    let db = threads_db(&ctx.home);
    if db.is_file() {
        match sqlite_ro::open(&db).and_then(|c| thread_rows(&c)) {
            Err(e) => out.note(format!("Aura couldn't read Zed's threads: {e}")),
            Ok(rows) => {
                for t in rows {
                    let folder = t.folder.clone().or_else(|| {
                        thread_reader(&t.data_type, &t.data).ok().and_then(|mut r| snapshot_folder(&mut *r))
                    });
                    let key = format!("chat:{}", t.id);
                    let place = folder.as_ref().and_then(|f| f.file_name()).map(|n| n.to_string_lossy().into_owned());
                    let mut bits = vec!["Zed agent".to_string()];
                    bits.extend(place);
                    let title = if t.title.trim().is_empty() { "Untitled Zed thread".to_string() } else { t.title.clone() };
                    let when = t.updated.or(t.created);
                    let mut item = Item::new(key.clone(), ItemKind::Chat, title.clone()).detail(bits.join(" · ")).when(when);
                    if let Some(f) = &folder {
                        item = item.root(path_str(f));
                    }
                    item = match &folder {
                        None => item.unavailable("Zed didn't record which folder this thread was in"),
                        Some(f) if !f.is_dir() => item.unavailable(format!("{} isn't on this Mac any more", tilde(&ctx.home, f))),
                        Some(_) if ctx.ledger.done(ID, &key).is_some() => item.done("Already in Aura"),
                        Some(f) => {
                            *chats_per_root.entry(f.clone()).or_default() += 1;
                            item
                        }
                    };
                    chat_items.push((
                        item,
                        Plan::Chat(ChatPlan::Zed(ChatRef {
                            db: db.clone(),
                            thread_id: t.id.clone(),
                            title,
                            root: folder.map(|f| path_str(&f)).unwrap_or_default(),
                            created_ms: t.created.or(when).unwrap_or(0),
                            updated_ms: when.unwrap_or(0),
                        })),
                    ));
                }
            }
        }
    }

    let mut roots: Vec<PathBuf> = workspace_folders(&ctx.home)
        .into_iter()
        .map(|(p, _)| p)
        .filter(|p| vscode_folders::is_git(p))
        .collect();
    for r in chats_per_root.keys() {
        if !roots.contains(r) && vscode_folders::is_git(r) {
            roots.push(r.clone());
        }
    }
    for path in &roots {
        let n = *chats_per_root.get(path).unwrap_or(&0);
        let detail = format!("{n} {} · {}", if n == 1 { "thread" } else { "threads" }, tilde(&ctx.home, path));
        out.push(repo_item(ctx, format!("repo:{}", path_str(path)), path, None, detail), Plan::Repo { root: path.clone() });
        if let Some(item) = rules_item(ctx, ID, path) {
            out.push(item, Plan::Rules { root: path.clone() });
        }
    }
    for (item, plan) in chat_items {
        out.push(item, plan);
    }
    mcp_items(out, &["Zed"], &[]);
}

fn part_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(m) => m
            .get("Text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| serde_json::to_string(v).unwrap_or_default()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn mention_label(m: &Value) -> String {
    let uri = m.get("uri");
    let path = uri
        .and_then(|u| u.as_object())
        .and_then(|o| o.values().next())
        .and_then(|inner| inner.get("abs_path").or_else(|| inner.get("path")))
        .and_then(Value::as_str);
    match path {
        Some(p) => format!("@{p}"),
        None => "@mention".to_string(),
    }
}

/// One Zed thread's messages as turns.
pub fn messages_to_turns(messages: &[Value], ts: i64) -> Vec<PrerollTurn> {
    let mut out: Vec<PrerollTurn> = Vec::new();
    for m in messages {
        if let Some(user) = m.get("User") {
            let mut parts: Vec<String> = Vec::new();
            for p in user.get("content").and_then(Value::as_array).into_iter().flatten() {
                if let Some(t) = p.get("Text").and_then(Value::as_str) {
                    parts.push(t.to_string());
                } else if let Some(mention) = p.get("Mention") {
                    parts.push(mention_label(mention));
                } else if p.get("Image").is_some() {
                    parts.push("[image]".to_string());
                }
            }
            let text = parts.join(" ").trim().to_string();
            if !text.is_empty() {
                out.push(PrerollTurn { role: "user".into(), text, ts, tool_calls: Vec::new(), thinking: None });
            }
        } else if let Some(agent) = m.get("Agent") {
            let results = agent.get("tool_results").and_then(Value::as_object);
            let reply = match out.last_mut() {
                Some(last) if last.role == "assistant" => last,
                _ => {
                    out.push(PrerollTurn { role: "assistant".into(), text: String::new(), ts, tool_calls: Vec::new(), thinking: None });
                    out.last_mut().expect("just pushed")
                }
            };
            for p in agent.get("content").and_then(Value::as_array).into_iter().flatten() {
                if let Some(t) = p.get("Text").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                    if !reply.text.is_empty() {
                        reply.text.push_str("\n\n");
                    }
                    reply.text.push_str(t);
                } else if let Some(th) = p.get("Thinking") {
                    let t = th.get("text").and_then(Value::as_str).or_else(|| th.as_str()).unwrap_or("").trim();
                    if !t.is_empty() {
                        match &mut reply.thinking {
                            Some(prev) => {
                                prev.push_str("\n\n");
                                prev.push_str(t);
                            }
                            None => reply.thinking = Some(t.to_string()),
                        }
                    }
                } else if let Some(tu) = p.get("ToolUse") {
                    let id = tu.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                    let input = tu
                        .get("input")
                        .cloned()
                        .filter(|v| !v.is_null())
                        .or_else(|| tu.get("raw_input").and_then(Value::as_str).map(|s| serde_json::from_str(s).unwrap_or(Value::String(s.into()))))
                        .unwrap_or(Value::Null);
                    let result = results.and_then(|r| r.get(&id)).map(|r| {
                        let content = r
                            .get("content")
                            .map(part_text)
                            .filter(|s| !s.trim().is_empty())
                            .or_else(|| r.get("output").map(part_text))
                            .unwrap_or_default();
                        PersistedToolResult { is_error: r.get("is_error").and_then(Value::as_bool).unwrap_or(false), content }
                    });
                    reply.tool_calls.push(PersistedToolCall {
                        tool_use_id: id,
                        name: tu.get("name").and_then(Value::as_str).unwrap_or("tool").to_string(),
                        input,
                        result,
                    });
                }
            }
        }
        // "Resume" marks where the person pressed continue; nothing to carry.
    }
    out.retain(|t| t.role == "user" || !t.text.is_empty() || !t.tool_calls.is_empty() || t.thinking.is_some());
    out
}

pub fn load_chat(r: &ChatRef) -> Result<ChatImport, String> {
    let conn = sqlite_ro::open(&r.db)?;
    let (data_type, data): (String, Vec<u8>) = conn
        .query_row("select data_type, data from threads where id = ?1", [&r.thread_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| format!("couldn't find the thread in Zed: {e}"))?;
    let mut bytes = Vec::new();
    thread_reader(&data_type, &data)?
        .read_to_end(&mut bytes)
        .map_err(|e| format!("couldn't open the thread: {e}"))?;
    let v: Value = serde_json::from_slice(&bytes).map_err(|e| format!("couldn't read the thread: {e}"))?;
    let messages = v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let raw = vec![String::from_utf8_lossy(&bytes).into_owned()];
    drop(bytes);
    Ok(ChatImport {
        source: ID,
        source_name: NAME,
        source_key: r.thread_id.clone(),
        title: r.title.clone(),
        root: r.root.clone(),
        created_ms: r.created_ms,
        updated_ms: r.updated_ms,
        brain: "cli:zed",
        turns: messages_to_turns(&messages, r.updated_ms.max(r.created_ms)),
        raw,
    })
}
