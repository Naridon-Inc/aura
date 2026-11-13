//! Void (an open-source VS Code–based editor).
//!
//! Verified against a real install: every chat lives in one row of
//! `User/globalStorage/state.vscdb`, ItemTable key `void.chatThreadStorageII`,
//! a JSON map of thread id → `{id, createdAt, lastModified (ISO), messages,
//! state, filesWithUserChanges}`. A message is one of:
//!
//! * `user` — `content` (what was sent, with attached code) and
//!   `displayContent` (what the person typed), `selections`, `state`;
//! * `assistant` — `displayContent`, `reasoning`, `anthropicReasoning`;
//! * `tool` — `type` (`success`, `tool_error`, …), `name`, `id`, `params`,
//!   `rawParams`, `result`, `content`;
//! * `checkpoint` — file snapshots, keyed by file URI.
//!
//! A thread doesn't say which folder it was in. The file URIs it touched
//! (checkpoints, `filesWithUserChanges`, selections) do: the repo they sit in
//! is the chat's project. A thread that touched no file has no project and
//! is listed as such.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::apply::ChatImport;
use super::model::{Item, ItemKind};
use super::{path_str, repo_item, rules_item, sqlite_ro, tilde, vscode_folders, ChatPlan, Ctx, Plan, Scanned};
use crate::cmd_agent_history::PrerollTurn;
use crate::manager::{PersistedToolCall, PersistedToolResult};

pub const ID: &str = "void";
pub const NAME: &str = "Void";
const KEY: &str = "void.chatThreadStorageII";

fn user_dir(home: &Path) -> PathBuf {
    vscode_folders::user_dir(home, "Void")
}

pub fn db_path(home: &Path) -> PathBuf {
    user_dir(home).join("globalStorage").join("state.vscdb")
}

pub struct ChatRef {
    pub db: PathBuf,
    pub thread_id: String,
    pub title: String,
    pub root: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

fn read_threads(db: &Path) -> Result<serde_json::Map<String, Value>, String> {
    let conn = sqlite_ro::open(db)?;
    let text: Option<String> = conn
        .query_row("select cast(value as text) from ItemTable where key = ?1", [KEY], |r| r.get(0))
        .ok();
    let Some(text) = text else { return Ok(Default::default()) };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err("Void's chat list isn't in the shape Aura knows".into()),
        Err(e) => Err(format!("couldn't read Void's chats: {e}")),
    }
}

fn iso_ms(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .or_else(|| v.as_i64())
}

/// Every local file a thread names: object keys and string values that are
/// `file://` URIs, plus `fsPath` fields.
fn file_paths(v: &Value, out: &mut Vec<PathBuf>) {
    match v {
        Value::String(s) if s.starts_with("file://") => out.extend(vscode_folders::file_uri_to_path(s)),
        Value::Array(a) => a.iter().for_each(|x| file_paths(x, out)),
        Value::Object(m) => {
            for (k, x) in m {
                if k.starts_with("file://") {
                    out.extend(vscode_folders::file_uri_to_path(k));
                }
                if k == "fsPath" {
                    if let Some(p) = x.as_str() {
                        out.push(PathBuf::from(p));
                    }
                    continue;
                }
                file_paths(x, out);
            }
        }
        _ => {}
    }
}

/// The git repo a path sits in: the nearest ancestor holding `.git`.
pub fn repo_of(path: &Path) -> Option<PathBuf> {
    path.ancestors().skip(1).find(|a| a.join(".git").exists()).map(Path::to_path_buf)
}

/// The repo most of a thread's files sit in.
pub fn thread_root(thread: &Value) -> Option<PathBuf> {
    let mut files = Vec::new();
    file_paths(thread, &mut files);
    let mut votes: HashMap<PathBuf, usize> = HashMap::new();
    let mut checked: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    for f in files {
        let root = checked.entry(f.clone()).or_insert_with(|| repo_of(&f)).clone();
        if let Some(r) = root {
            *votes.entry(r).or_default() += 1;
        }
    }
    votes.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(r, _)| r)
}

fn spoken(m: &Value) -> bool {
    matches!(m.get("role").and_then(Value::as_str), Some("user" | "assistant" | "tool"))
}

pub fn scan(ctx: &Ctx, out: &mut Scanned) {
    let folders = vscode_folders::folders(&user_dir(&ctx.home));
    let mut chats_per_root: HashMap<PathBuf, usize> = HashMap::new();
    let db = db_path(&ctx.home);
    let mut chat_items = Vec::new();
    match read_threads(&db) {
        Err(e) => out.note(format!("Aura couldn't read Void's chats: {e}")),
        Ok(threads) => {
            let mut empty = 0usize;
            for (id, t) in &threads {
                let messages = t.get("messages").and_then(Value::as_array).map(|m| m.iter().filter(|x| spoken(x)).count()).unwrap_or(0);
                if messages == 0 {
                    empty += 1;
                    continue;
                }
                let root = thread_root(t);
                let created = t.get("createdAt").and_then(iso_ms);
                let updated = t.get("lastModified").and_then(iso_ms).or(created);
                let key = format!("chat:{id}");
                let place = root.as_ref().and_then(|r| r.file_name()).map(|n| n.to_string_lossy().into_owned());
                let title = match &place {
                    Some(p) => format!("Chat in {p}"),
                    None => "Void chat".to_string(),
                };
                let mut bits = vec![format!("{messages} {}", if messages == 1 { "message" } else { "messages" })];
                bits.extend(place.clone());
                let mut item = Item::new(key.clone(), ItemKind::Chat, title).detail(bits.join(" · ")).when(updated);
                if let Some(r) = &root {
                    item = item.root(path_str(r));
                }
                item = match &root {
                    None => item.unavailable("This chat didn't touch any file in a git repository, so it has no project to go in"),
                    Some(_) if ctx.ledger.done(ID, &key).is_some() => item.done("Already in Aura"),
                    Some(r) => {
                        *chats_per_root.entry(r.clone()).or_default() += 1;
                        item
                    }
                };
                chat_items.push((
                    item,
                    Plan::Chat(ChatPlan::Void(ChatRef {
                        db: db.clone(),
                        thread_id: id.clone(),
                        title: String::new(),
                        root: root.as_ref().map(|r| path_str(r)).unwrap_or_default(),
                        created_ms: created.unwrap_or(0),
                        updated_ms: updated.unwrap_or(0),
                    })),
                ));
            }
            if empty > 0 {
                out.note(format!("{empty} empty {} left out.", if empty == 1 { "chat is" } else { "chats are" }));
            }
        }
    }

    // Folders Void opened, plus any repo a chat points at that Void's folder
    // list no longer has.
    let mut roots: Vec<PathBuf> = folders.iter().filter(|f| f.is_git).map(|f| f.path.clone()).collect();
    for r in chats_per_root.keys() {
        if !roots.contains(r) {
            roots.push(r.clone());
        }
    }
    for path in &roots {
        let n = *chats_per_root.get(path).unwrap_or(&0);
        let detail = format!("{n} {} · {}", if n == 1 { "chat" } else { "chats" }, tilde(&ctx.home, path));
        out.push(repo_item(ctx, format!("repo:{}", path_str(path)), path, None, detail), Plan::Repo { root: path.clone() });
        if let Some(item) = rules_item(ctx, ID, path) {
            out.push(item, Plan::Rules { root: path.clone() });
        }
    }
    for (item, plan) in chat_items {
        out.push(item, plan);
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// One Void thread's messages as turns. Tool steps attach to the agent's
/// reply they belong to; a run of agent messages between two of the
/// person's becomes one reply.
pub fn messages_to_turns(messages: &[Value], ts: i64) -> Vec<PrerollTurn> {
    let mut out: Vec<PrerollTurn> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        match role {
            "user" => {
                let text = m
                    .get("displayContent")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| m.get("content").and_then(Value::as_str))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !text.is_empty() {
                    out.push(PrerollTurn { role: "user".into(), text, ts, tool_calls: Vec::new(), thinking: None });
                }
            }
            "assistant" | "tool" => {
                let reply = match out.last_mut() {
                    Some(last) if last.role == "assistant" => last,
                    _ => {
                        out.push(PrerollTurn { role: "assistant".into(), text: String::new(), ts, tool_calls: Vec::new(), thinking: None });
                        out.last_mut().expect("just pushed")
                    }
                };
                if role == "assistant" {
                    let text = m.get("displayContent").and_then(Value::as_str).unwrap_or("").trim();
                    if !text.is_empty() {
                        if !reply.text.is_empty() {
                            reply.text.push_str("\n\n");
                        }
                        reply.text.push_str(text);
                    }
                    if let Some(r) = m.get("reasoning").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
                        match &mut reply.thinking {
                            Some(prev) => {
                                prev.push_str("\n\n");
                                prev.push_str(r);
                            }
                            None => reply.thinking = Some(r.to_string()),
                        }
                    }
                } else {
                    let kind = m.get("type").and_then(Value::as_str).unwrap_or("");
                    let name = m.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
                    let input = m.get("rawParams").or_else(|| m.get("params")).cloned().unwrap_or(Value::Null);
                    let content = match m.get("content").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
                        Some(c) => c.to_string(),
                        None => text_of(m.get("result").unwrap_or(&Value::Null)),
                    };
                    let result = (!content.is_empty() || kind != "success").then(|| PersistedToolResult {
                        is_error: kind.contains("error") || kind == "rejected" || kind == "invalid_params",
                        content,
                    });
                    reply.tool_calls.push(PersistedToolCall {
                        tool_use_id: m.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                        name,
                        input,
                        result,
                    });
                }
            }
            _ => {}
        }
    }
    // A reply that ended up with nothing in it (a lone checkpoint run) is noise.
    out.retain(|t| t.role == "user" || !t.text.is_empty() || !t.tool_calls.is_empty() || t.thinking.is_some());
    out
}

pub fn load_chat(r: &ChatRef) -> Result<ChatImport, String> {
    let threads = read_threads(&r.db)?;
    let t = threads.get(&r.thread_id).ok_or("This chat is no longer in Void")?;
    let messages: Vec<Value> = t.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let raw = vec![serde_json::to_string(t).map_err(|e| e.to_string())?];
    Ok(ChatImport {
        source: ID,
        source_name: NAME,
        source_key: r.thread_id.clone(),
        title: r.title.clone(),
        root: r.root.clone(),
        created_ms: r.created_ms,
        updated_ms: r.updated_ms,
        brain: "cli:void",
        turns: messages_to_turns(&messages, r.updated_ms.max(r.created_ms)),
        raw,
    })
}
