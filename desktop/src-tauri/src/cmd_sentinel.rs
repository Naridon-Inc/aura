//! Sentinel inbox + agent-presence surface, backed entirely by the
//! `.aura/sentinel/` directory tree the CLI's SentinelManager writes.
//!
//! There is no `aura sentinel` subcommand to call — the manager lives
//! inside `aura-cli/src/sentinel.rs` as a library API and the on-disk
//! layout is the canonical channel between agents. That actually fits
//! us: we tail the directory and let the desktop be a passive observer
//! when no agent is writing through us, and write our own message files
//! when the user sends from the UI.
//!
//! Layout:
//!   <repo>/.aura/sentinel/
//!     messages/msg-<uuid>.json   — one per message
//!     claims/<session>.json      — one per active session, file-claim list
//!     zones/<zone>.json          — zone-rule definitions (read by cmd_zones)

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentinelMessage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub from_session: String,
    #[serde(default)]
    pub from_agent: String,
    #[serde(default)]
    pub to_session: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub read_by: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentinelClaim {
    #[serde(default)]
    pub file_path: String,
    #[serde(default)]
    pub function_name: String,
    #[serde(default)]
    pub node_id: String,
    #[serde(default)]
    pub claimed_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SentinelAgent {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub agent_id: String,
    #[serde(default)]
    pub pid: i64,
    #[serde(default)]
    pub last_heartbeat: i64,
    #[serde(default)]
    pub claims: Vec<SentinelClaim>,
}

#[tauri::command]
pub async fn sentinel_inbox(repo_root: String) -> Result<Vec<SentinelMessage>, String> {
    let dir = PathBuf::from(&repo_root)
        .join(".aura")
        .join("sentinel")
        .join("messages");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Ok(mut msg) = serde_json::from_str::<SentinelMessage>(&body) {
            // Backfill id from filename if the JSON body forgot to carry
            // it — older sentinel writers did that.
            if msg.id.is_empty() {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    msg.id = stem.to_string();
                }
            }
            out.push(msg);
        }
    }
    // Newest first — same direction the CommsPanel renders project feed.
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

#[tauri::command]
pub async fn sentinel_agents(repo_root: String) -> Result<Vec<SentinelAgent>, String> {
    let dir = PathBuf::from(&repo_root)
        .join(".aura")
        .join("sentinel")
        .join("claims");
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.filter_map(|r| r.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Ok(mut a) = serde_json::from_str::<SentinelAgent>(&body) {
            if a.session_id.is_empty() {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    a.session_id = stem.to_string();
                }
            }
            out.push(a);
        }
    }
    out.sort_by(|a, b| b.last_heartbeat.cmp(&a.last_heartbeat));
    Ok(out)
}

#[tauri::command]
pub async fn sentinel_send(
    repo_root: String,
    from_agent: String,
    from_session: String,
    to_session: String,
    content: String,
) -> Result<SentinelMessage, String> {
    let dir = PathBuf::from(&repo_root)
        .join(".aura")
        .join("sentinel")
        .join("messages");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let id = format!("msg-{}", Uuid::new_v4());
    let msg = SentinelMessage {
        id: id.clone(),
        from_session,
        from_agent,
        to_session,
        content,
        timestamp: now_secs(),
        read_by: Vec::new(),
    };
    let path = dir.join(format!("{id}.json"));
    let body = serde_json::to_string_pretty(&msg).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(msg)
}

#[tauri::command]
pub async fn sentinel_mark_read(
    repo_root: String,
    message_id: String,
    reader_session: String,
) -> Result<(), String> {
    let dir = PathBuf::from(&repo_root)
        .join(".aura")
        .join("sentinel")
        .join("messages");
    let path = dir.join(format!("{message_id}.json"));
    if !path.is_file() {
        return Err(format!("message not found: {message_id}"));
    }
    let body = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut msg: SentinelMessage = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if !msg.read_by.iter().any(|r| r == &reader_session) {
        msg.read_by.push(reader_session);
        let out = serde_json::to_string_pretty(&msg).map_err(|e| e.to_string())?;
        fs::write(&path, out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
