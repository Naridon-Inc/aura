//! Cursor.
//!
//! Verified against a real install:
//!
//! * `User/globalStorage/state.vscdb` — a key/value table `cursorDiskKV`.
//!   `composerData:<id>` is one chat: `name`, `createdAt` (epoch ms), `_v`,
//!   and `fullConversationHeadersOnly` — the ordered `[{bubbleId, type}]`
//!   list of its messages. Each message is `bubbleId:<composer>:<bubble>`:
//!   `type` 1 = the person, 2 = the agent, `text`, `createdAt` (ISO), and
//!   for a tool step `toolFormerData {name, rawArgs, params, result,
//!   status, toolCallId}`, plus `allThinkingBlocks`.
//! * Newer chats (`_v` 11 and up) keep a `conversationState` instead; when
//!   they have no message headers their body is an encrypted blob
//!   (`blobEncryptionKey`) Aura can't read, so they are counted, not offered.
//! * `User/workspaceStorage/<hash>/` — one per opened folder
//!   (`workspace.json`), whose `state.vscdb` ItemTable row
//!   `composer.composerData` lists `allComposers[].composerId`: which chats
//!   were in which folder. Newer chats also carry it in `composerHeaders`
//!   (`workspaceIdentifier.uri.fsPath`).
//!
//! MCP servers (`~/.cursor/mcp.json`, a repo's `.cursor/mcp.json`) and rules
//! (`.cursorrules`, `.cursor/rules/*.mdc`) come through Aura's existing
//! readers.
//!
//! The global database can be many gigabytes: every read here is a range
//! scan on its key index, and JSON fields are pulled out inside SQLite rather
//! than parsing whole values.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use super::apply::ChatImport;
use super::model::{Item, ItemKind};
use super::{mcp_items, path_str, repo_item, rules_item, sqlite_ro, tilde, vscode_folders, ChatPlan, Ctx, Plan, Scanned};
use crate::cmd_agent_history::PrerollTurn;
use crate::manager::{PersistedToolCall, PersistedToolResult};

pub const ID: &str = "cursor";
pub const NAME: &str = "Cursor";

fn user_dir(home: &Path) -> PathBuf {
    vscode_folders::user_dir(home, "Cursor")
}

pub fn global_db(home: &Path) -> PathBuf {
    user_dir(home).join("globalStorage").join("state.vscdb")
}

pub fn found(home: &Path) -> bool {
    global_db(home).is_file() || home.join(".cursor").join("mcp.json").is_file()
}

pub struct ChatRef {
    pub db: PathBuf,
    pub composer_id: String,
    pub title: String,
    pub root: String,
    pub created_ms: i64,
    pub updated_ms: i64,
}

/// composer id → the folder it was opened in, from each folder's own state.
fn folder_of_composers(folders: &[vscode_folders::Folder]) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    for f in folders {
        let db = f.storage.join("state.vscdb");
        let Ok(conn) = sqlite_ro::open(&db) else { continue };
        let Ok(text) = conn.query_row(
            "select cast(value as text) from ItemTable where key = 'composer.composerData'",
            [],
            |r| r.get::<_, String>(0),
        ) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        for c in v.get("allComposers").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = c.get("composerId").and_then(Value::as_str) {
                map.entry(id.to_string()).or_insert_with(|| f.path.clone());
            }
        }
    }
    map
}

/// composer id → (folder, name) from the newer `composerHeaders` table.
fn headers(conn: &Connection) -> HashMap<String, (Option<PathBuf>, Option<String>)> {
    if !sqlite_ro::has_table(conn, "composerHeaders") {
        return HashMap::new();
    }
    let Ok(mut stmt) = conn.prepare(
        "select composerId, json_extract(value, '$.workspaceIdentifier.uri.fsPath'), json_extract(value, '$.name') \
         from composerHeaders where json_valid(value)",
    ) else {
        return HashMap::new();
    };
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.map(PathBuf::from),
            r.get::<_, Option<String>>(2)?.filter(|s| !s.trim().is_empty()),
        ))
    })
    .map(|rows| rows.filter_map(Result::ok).map(|(id, p, n)| (id, (p, n))).collect())
    .unwrap_or_default()
}

struct Composer {
    id: String,
    name: Option<String>,
    created: Option<i64>,
    updated: Option<i64>,
    messages: usize,
    readable: bool,
    encrypted: bool,
}

fn composers(conn: &Connection) -> Result<Vec<Composer>, String> {
    let mut stmt = conn
        .prepare(
            "select substr(k.key, 14), json_extract(k.value, '$.name'), json_extract(k.value, '$.createdAt'), \
                    json_extract(k.value, '$.lastUpdatedAt'), \
                    coalesce(json_array_length(k.value, '$.fullConversationHeadersOnly'), 0), \
                    json_type(k.value, '$.conversationState') is not null, \
                    exists(select 1 from cursorDiskKV b where b.key = 'bubbleId:' || substr(k.key, 14) || ':' || \
                           json_extract(k.value, '$.fullConversationHeadersOnly[0].bubbleId')) \
             from cursorDiskKV k \
             where k.key >= 'composerData:' and k.key < 'composerData;' and json_valid(k.value)",
        )
        .map_err(|e| format!("couldn't read Cursor's chats: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let messages = r.get::<_, i64>(4)?.max(0) as usize;
            let state: bool = r.get(5)?;
            let first_there: bool = r.get(6)?;
            Ok(Composer {
                id: r.get(0)?,
                name: r.get::<_, Option<String>>(1)?.filter(|s| !s.trim().is_empty()),
                created: r.get::<_, Option<i64>>(2).ok().flatten(),
                updated: r.get::<_, Option<i64>>(3).ok().flatten(),
                messages,
                readable: messages > 0 && first_there,
                encrypted: state && messages == 0,
            })
        })
        .map_err(|e| format!("couldn't read Cursor's chats: {e}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

pub fn scan(ctx: &Ctx, out: &mut Scanned) {
    let folders = vscode_folders::folders(&user_dir(&ctx.home));
    let git_folders: Vec<PathBuf> = folders.iter().filter(|f| f.is_git).map(|f| f.path.clone()).collect();

    let db = global_db(&ctx.home);
    let mut chats_per_folder: HashMap<PathBuf, usize> = HashMap::new();
    let mut chat_items: Vec<(Item, Plan)> = Vec::new();
    if db.is_file() {
        match sqlite_ro::open(&db).and_then(|conn| Ok((composers(&conn)?, headers(&conn)))) {
            Err(e) => out.note(format!("Aura couldn't read Cursor's chats: {e}")),
            Ok((list, header_map)) => {
                let by_folder = folder_of_composers(&folders);
                let (mut encrypted, mut empty) = (0usize, 0usize);
                for c in list {
                    if c.encrypted {
                        encrypted += 1;
                        continue;
                    }
                    if !c.readable {
                        empty += 1;
                        continue;
                    }
                    let header = header_map.get(&c.id);
                    let folder = by_folder.get(&c.id).cloned().or_else(|| header.and_then(|h| h.0.clone()));
                    let name = c.name.clone().or_else(|| header.and_then(|h| h.1.clone()));
                    let key = format!("chat:{}", c.id);
                    let place = folder
                        .as_ref()
                        .and_then(|f| f.file_name())
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let mut bits = vec![format!("{} {}", c.messages, if c.messages == 1 { "message" } else { "messages" })];
                    if !place.is_empty() {
                        bits.push(place);
                    }
                    let when = c.updated.or(c.created);
                    let mut item = Item::new(key.clone(), ItemKind::Chat, name.clone().unwrap_or_else(|| "Untitled Cursor chat".into()))
                        .detail(bits.join(" · "))
                        .when(when);
                    if let Some(f) = &folder {
                        item = item.root(path_str(f));
                    }
                    item = match &folder {
                        None => item.unavailable("Cursor didn't record which folder this chat was in"),
                        Some(f) if !f.is_dir() => item.unavailable(format!("{} isn't on this Mac any more", tilde(&ctx.home, f))),
                        Some(_) if ctx.ledger.done(ID, &key).is_some() => item.done("Already in Aura"),
                        Some(f) => {
                            *chats_per_folder.entry(f.clone()).or_default() += 1;
                            item
                        }
                    };
                    chat_items.push((
                        item,
                        Plan::Chat(ChatPlan::Cursor(ChatRef {
                            db: db.clone(),
                            composer_id: c.id.clone(),
                            title: name.unwrap_or_default(),
                            root: folder.map(|f| path_str(&f)).unwrap_or_default(),
                            created_ms: c.created.unwrap_or(0),
                            updated_ms: when.unwrap_or(0),
                        })),
                    ));
                }
                if encrypted > 0 {
                    out.note(format!(
                        "{encrypted} newer Cursor {} stored in an encrypted format only Cursor can open, so Aura can't bring {} over.",
                        if encrypted == 1 { "chat is" } else { "chats are" },
                        if encrypted == 1 { "it" } else { "them" }
                    ));
                }
                if empty > 0 {
                    out.note(format!("{empty} empty {} left out.", if empty == 1 { "chat is" } else { "chats are" }));
                }
            }
        }
    }

    for path in &git_folders {
        let n = *chats_per_folder.get(path).unwrap_or(&0);
        let detail = format!("{n} {} · {}", if n == 1 { "chat" } else { "chats" }, tilde(&ctx.home, path));
        out.push(repo_item(ctx, format!("repo:{}", path_str(path)), path, None, detail), Plan::Repo { root: path.clone() });
        if let Some(item) = rules_item(ctx, ID, path) {
            out.push(item, Plan::Rules { root: path.clone() });
        }
    }
    for (item, plan) in chat_items {
        out.push(item, plan);
    }
    mcp_items(out, &["Cursor", "Cursor (project)"], &git_folders);
    let gone = folders.iter().filter(|f| !f.exists).count();
    if gone > 0 {
        out.note(format!(
            "{gone} {} Cursor opened {} no longer on this Mac.",
            if gone == 1 { "folder" } else { "folders" },
            if gone == 1 { "is" } else { "are" }
        ));
    }
}

fn str_field<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str).filter(|s| !s.trim().is_empty())
}

fn thinking_of(bubble: &Value) -> Option<String> {
    let blocks = bubble.get("allThinkingBlocks")?.as_array()?;
    let parts: Vec<&str> = blocks
        .iter()
        .filter_map(|b| match b {
            Value::String(s) => Some(s.as_str()),
            other => str_field(other, "thinking").or_else(|| str_field(other, "text")),
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

fn tool_call_of(bubble: &Value, bubble_id: &str) -> Option<PersistedToolCall> {
    let t = bubble.get("toolFormerData")?;
    let name = str_field(t, "name")?.to_string();
    let input = str_field(t, "rawArgs")
        .or_else(|| str_field(t, "params"))
        .map(|s| serde_json::from_str::<Value>(s).unwrap_or_else(|_| Value::String(s.to_string())))
        .unwrap_or(Value::Null);
    let status = str_field(t, "status").unwrap_or("");
    let result = str_field(t, "result").map(|r| PersistedToolResult {
        is_error: matches!(status, "error" | "failed" | "cancelled"),
        content: r.to_string(),
    });
    Some(PersistedToolCall {
        tool_use_id: str_field(t, "toolCallId").unwrap_or(bubble_id).to_string(),
        name,
        input,
        result,
    })
}

/// Turn one chat's bubbles (in conversation order) into turns: each message
/// from the person opens a turn; the agent's text, tool steps and thinking
/// that follow it fold into one reply until the person speaks again.
pub fn bubbles_to_turns(bubbles: &[(String, Value)], fallback_ts: i64) -> Vec<PrerollTurn> {
    let mut out: Vec<PrerollTurn> = Vec::new();
    for (id, b) in bubbles {
        let ts = str_field(b, "createdAt")
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
            .unwrap_or(fallback_ts);
        let text = b.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
        match b.get("type").and_then(Value::as_i64) {
            Some(1) => {
                if !text.is_empty() {
                    out.push(PrerollTurn { role: "user".into(), text, ts, tool_calls: Vec::new(), thinking: None });
                }
            }
            Some(2) => {
                let call = tool_call_of(b, id);
                let thinking = thinking_of(b);
                if text.is_empty() && call.is_none() && thinking.is_none() {
                    continue;
                }
                let reply = match out.last_mut() {
                    Some(last) if last.role == "assistant" => last,
                    _ => {
                        out.push(PrerollTurn { role: "assistant".into(), text: String::new(), ts, tool_calls: Vec::new(), thinking: None });
                        out.last_mut().expect("just pushed")
                    }
                };
                if !text.is_empty() {
                    if !reply.text.is_empty() {
                        reply.text.push_str("\n\n");
                    }
                    reply.text.push_str(&text);
                }
                if let Some(call) = call {
                    reply.tool_calls.push(call);
                }
                if let Some(t) = thinking {
                    match &mut reply.thinking {
                        Some(prev) => {
                            prev.push_str("\n\n");
                            prev.push_str(&t);
                        }
                        None => reply.thinking = Some(t),
                    }
                }
            }
            _ => {}
        }
    }
    out
}

pub fn load_chat(r: &ChatRef) -> Result<ChatImport, String> {
    let conn = sqlite_ro::open(&r.db)?;
    let composer: String = conn
        .query_row(
            "select cast(value as text) from cursorDiskKV where key = ?1",
            [format!("composerData:{}", r.composer_id)],
            |row| row.get(0),
        )
        .map_err(|e| format!("couldn't find the chat in Cursor: {e}"))?;
    let v: Value = serde_json::from_str(&composer).map_err(|e| format!("couldn't read the chat: {e}"))?;
    let order: Vec<String> = v
        .get("fullConversationHeadersOnly")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|h| h.get("bubbleId").and_then(Value::as_str).map(str::to_string))
        .collect();

    let lo = format!("bubbleId:{}:", r.composer_id);
    let hi = format!("bubbleId:{};", r.composer_id);
    let mut stmt = conn
        .prepare("select substr(key, ?3), cast(value as text) from cursorDiskKV where key >= ?1 and key < ?2")
        .map_err(|e| format!("couldn't read the chat: {e}"))?;
    let mut by_id: HashMap<String, String> = stmt
        .query_map(rusqlite::params![lo, hi, (lo.len() + 1) as i64], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("couldn't read the chat: {e}"))?
        .filter_map(Result::ok)
        .collect();

    let mut raw = vec![composer.clone()];
    let mut bubbles = Vec::with_capacity(order.len());
    for id in order {
        let Some(text) = by_id.remove(&id) else { continue };
        if let Ok(b) = serde_json::from_str::<Value>(&text) {
            bubbles.push((id, b));
        }
        raw.push(text);
    }
    Ok(ChatImport {
        source: ID,
        source_name: NAME,
        source_key: r.composer_id.clone(),
        title: r.title.clone(),
        root: r.root.clone(),
        created_ms: r.created_ms,
        updated_ms: r.updated_ms,
        brain: "cli:cursor",
        turns: bubbles_to_turns(&bubbles, r.created_ms),
        raw,
    })
}
