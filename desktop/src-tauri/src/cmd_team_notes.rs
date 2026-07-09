// Slack-canvas-style team notes — per-channel + one team-wide note.
//
// Storage is plain Markdown on disk; users commit it through git like
// any other file. There is no DB and no cloud sync — the file IS the
// canonical state, so two teammates editing concurrently get a normal
// git merge conflict. That tradeoff is intentional: notes are low-rate
// and human-edited, so reusing git's merge semantics is simpler than
// inventing a CRDT for a doc that rarely changes.
//
// Paths:
//   per-channel : <repoRoot>/.aura/team/channels/<channel>.notes.md
//   team-wide   : <repoRoot>/.aura/team/notes.md
//
// Channel sanitization is strict: must match `^[a-z0-9][a-z0-9_:-]*$`.
// This is the same character class the chat substrate slugifies into,
// and it prevents `../` traversal even if the frontend forwards an
// unsanitized channel name from a URL/event payload.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteDoc {
    pub body: String,
    /// Unix seconds for the last filesystem modification. `0` when the
    /// file did not exist at read time — the frontend treats "no file"
    /// and "empty file" identically, so collapsing the missing case to
    /// `0` is easier to consume than an `Option<u64>`.
    pub updated_at: u64,
    pub byte_len: usize,
}

const CHANNEL_RE_ERR: &str = "invalid channel name";

fn valid_channel(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let bytes = name.as_bytes();
    // First char: [a-z0-9]
    let first = bytes[0] as char;
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    // Rest: [a-z0-9_:-]
    for b in &bytes[1..] {
        let c = *b as char;
        let ok = c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || c == '_'
            || c == ':'
            || c == '-';
        if !ok {
            return false;
        }
    }
    true
}

fn team_dir(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root).join(".aura").join("team")
}

fn channel_note_path(repo_root: &str, channel: &str) -> PathBuf {
    team_dir(repo_root)
        .join("channels")
        .join(format!("{channel}.notes.md"))
}

fn team_note_path(repo_root: &str) -> PathBuf {
    team_dir(repo_root).join("notes.md")
}

fn read_doc(path: &PathBuf) -> Result<NoteDoc, String> {
    if !path.exists() {
        return Ok(NoteDoc {
            body: String::new(),
            updated_at: 0,
            byte_len: 0,
        });
    }
    let body = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let updated_at = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let byte_len = body.len();
    Ok(NoteDoc {
        body,
        updated_at,
        byte_len,
    })
}

fn write_doc(path: &PathBuf, body: &str) -> Result<NoteDoc, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, body).map_err(|e| e.to_string())?;
    let updated_at = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        });
    Ok(NoteDoc {
        body: body.to_string(),
        updated_at,
        byte_len: body.len(),
    })
}

#[tauri::command]
pub async fn channel_notes_read(
    repo_root: String,
    channel: String,
) -> Result<NoteDoc, String> {
    if !valid_channel(&channel) {
        return Err(CHANNEL_RE_ERR.to_string());
    }
    read_doc(&channel_note_path(&repo_root, &channel))
}

#[tauri::command]
pub async fn channel_notes_write(
    repo_root: String,
    channel: String,
    body: String,
) -> Result<NoteDoc, String> {
    if !valid_channel(&channel) {
        return Err(CHANNEL_RE_ERR.to_string());
    }
    write_doc(&channel_note_path(&repo_root, &channel), &body)
}

#[tauri::command]
pub async fn team_notes_read(repo_root: String) -> Result<NoteDoc, String> {
    read_doc(&team_note_path(&repo_root))
}

#[tauri::command]
pub async fn team_notes_write(
    repo_root: String,
    body: String,
) -> Result<NoteDoc, String> {
    write_doc(&team_note_path(&repo_root), &body)
}

// ─── v0.2.11 — timed notes feed ─────────────────────────────────────
//
// In addition to the single-document markdown notes above, v0.2.11
// introduces a discrete-entry notes feed: each note is its own row in
// a JSONL file with author, timestamp, mentions, and body. Lets a team
// keep a running log per channel (committed + shared) and each user
// keep a personal scratchpad (local-only, never committed).
//
// Scopes:
//   - "team"             → <repoRoot>/.aura/team/notes.feed.jsonl       (committed)
//   - "channel:<name>"   → <repoRoot>/.aura/team/channels/<name>.feed.jsonl (committed)
//   - "user:<handle>"    → ~/.aura/notes/<repo-key>/<handle>.feed.jsonl    (local-only)
//
// Repo-key for user scope is the sha256 of the absolute repo path, so
// notes for different repos don't collide and the path is filesystem-safe.

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteEntry {
    pub id: String,
    pub ts: u64,
    pub author_handle: String,
    pub author_name: String,
    pub body: String,
    /// `@handle` substrings extracted from the body at write time.
    #[serde(default)]
    pub mentions: Vec<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn user_notes_dir(repo_root: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(repo_root.as_bytes());
    let key = format!("{:x}", hasher.finalize());
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".aura")
        .join("notes")
        .join(&key[..16])
}

fn parse_scope(scope: &str, repo_root: &str) -> Result<(PathBuf, bool), String> {
    // Returns (path, is_user_scope)
    if scope == "team" {
        return Ok((team_dir(repo_root).join("notes.feed.jsonl"), false));
    }
    if let Some(rest) = scope.strip_prefix("channel:") {
        if !valid_channel(rest) {
            return Err(CHANNEL_RE_ERR.to_string());
        }
        return Ok((
            team_dir(repo_root)
                .join("channels")
                .join(format!("{rest}.feed.jsonl")),
            false,
        ));
    }
    if let Some(handle) = scope.strip_prefix("user:") {
        if handle.is_empty() || handle.len() > 64 {
            return Err("invalid user handle".to_string());
        }
        if !handle
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' || c == '.')
        {
            return Err("invalid user handle".to_string());
        }
        return Ok((
            user_notes_dir(repo_root).join(format!("{handle}.feed.jsonl")),
            true,
        ));
    }
    Err(format!("invalid scope: {scope}"))
}

fn extract_mentions(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = body.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c != '@' {
            continue;
        }
        // Mention must follow whitespace or start-of-string.
        if i > 0 {
            let prev = body[..i].chars().next_back();
            if prev.map(|p| !(p.is_whitespace() || p == '(' || p == '[')).unwrap_or(false) {
                continue;
            }
        }
        let start = i + 1;
        let mut end = start;
        while let Some(&(j, ch)) = chars.peek() {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                end = j + ch.len_utf8();
                chars.next();
            } else {
                break;
            }
        }
        if end > start {
            let h = body[start..end].to_ascii_lowercase();
            if !h.is_empty() && !out.contains(&h) {
                out.push(h);
            }
        }
    }
    out
}

fn load_feed(path: &PathBuf) -> Vec<NoteEntry> {
    if !path.exists() {
        return Vec::new();
    }
    let raw = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in raw.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if let Ok(e) = serde_json::from_str::<NoteEntry>(l) {
            out.push(e);
        }
    }
    out
}

fn save_feed(path: &PathBuf, entries: &[NoteEntry]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        use std::io::Write;
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        for e in entries {
            let line = serde_json::to_string(e).map_err(|e| e.to_string())?;
            writeln!(f, "{line}").map_err(|e| e.to_string())?;
        }
    }
    fs::rename(tmp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn notes_feed_list(
    repo_root: String,
    scope: String,
) -> Result<Vec<NoteEntry>, String> {
    let (path, _) = parse_scope(&scope, &repo_root)?;
    Ok(load_feed(&path))
}

#[tauri::command]
pub async fn notes_feed_add(
    repo_root: String,
    scope: String,
    body: String,
    author_handle: String,
    author_name: String,
) -> Result<NoteEntry, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("empty body".to_string());
    }
    if trimmed.len() > 16 * 1024 {
        return Err("body too large".to_string());
    }
    let (path, _) = parse_scope(&scope, &repo_root)?;
    let mut entries = load_feed(&path);
    let entry = NoteEntry {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now_secs(),
        author_handle,
        author_name,
        body: trimmed.to_string(),
        mentions: extract_mentions(trimmed),
    };
    entries.push(entry.clone());
    save_feed(&path, &entries)?;
    Ok(entry)
}

#[tauri::command]
pub async fn notes_feed_delete(
    repo_root: String,
    scope: String,
    note_id: String,
) -> Result<(), String> {
    let (path, _) = parse_scope(&scope, &repo_root)?;
    let mut entries = load_feed(&path);
    let len_before = entries.len();
    entries.retain(|e| e.id != note_id);
    if entries.len() == len_before {
        return Ok(());
    }
    save_feed(&path, &entries)
}
