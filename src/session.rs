use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const SESSIONS_DIR: &str = ".aura/sessions";
const TRANSCRIPTS_DIR: &str = ".aura/transcripts";
const MAX_TRANSCRIPT_LINES: usize = 5000;

/// Session phase — tracks lifecycle of an agent conversation
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum SessionPhase {
    Active,
    Idle,
    Ended,
}

/// A tracked agent session
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AgentSession {
    pub session_id: String,
    pub agent_id: String,
    pub phase: SessionPhase,
    pub started_at: u64,
    pub last_activity: u64,
    pub files_touched: Vec<String>,
    pub checkpoint_count: u32,
    pub base_commit: Option<String>,
}

/// A single turn in a conversation transcript
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TranscriptEntry {
    pub role: String,       // "user", "assistant", "tool_use", "tool_result"
    pub content: String,    // The actual text (truncated for tool results)
    pub timestamp: u64,
    pub session_id: String,
}

pub struct SessionManager;

impl SessionManager {
    fn ensure_dirs() {
        let _ = fs::create_dir_all(SESSIONS_DIR);
        let _ = fs::create_dir_all(TRANSCRIPTS_DIR);
    }

    /// Start or resume a session for an agent
    pub fn start_session(agent_id: &str) -> AgentSession {
        Self::ensure_dirs();

        // Check for existing active session
        if let Some(existing) = Self::get_active_session() {
            if existing.agent_id == agent_id && existing.phase != SessionPhase::Ended {
                return existing;
            }
        }

        let session_id = format!(
            "{}-{}",
            chrono_like_date(),
            &uuid::Uuid::new_v4().to_string()[..8]
        );

        let now = now_secs();
        let base_commit = git2::Repository::open(".")
            .ok()
            .and_then(|r| {
                let head = r.head().ok()?;
                let commit = head.peel_to_commit().ok()?;
                Some(commit.id().to_string()[..7].to_string())
            });

        let session = AgentSession {
            session_id: session_id.clone(),
            agent_id: agent_id.to_string(),
            phase: SessionPhase::Active,
            started_at: now,
            last_activity: now,
            files_touched: Vec::new(),
            checkpoint_count: 0,
            base_commit,
        };

        Self::save_session(&session);
        session
    }

    /// Record a file as touched in the current session
    pub fn touch_file(file_path: &str) {
        if let Some(mut session) = Self::get_active_session() {
            if !session.files_touched.contains(&file_path.to_string()) {
                session.files_touched.push(file_path.to_string());
            }
            session.last_activity = now_secs();
            Self::save_session(&session);
        }
    }

    /// Transition session phase
    pub fn set_phase(phase: SessionPhase) {
        if let Some(mut session) = Self::get_active_session() {
            session.phase = phase;
            session.last_activity = now_secs();
            Self::save_session(&session);
        }
    }

    /// Increment checkpoint count
    pub fn increment_checkpoint() {
        if let Some(mut session) = Self::get_active_session() {
            session.checkpoint_count += 1;
            session.last_activity = now_secs();
            Self::save_session(&session);
        }
    }

    /// End the current session
    pub fn end_session() {
        Self::set_phase(SessionPhase::Ended);
    }

    /// Get the currently active session
    pub fn get_active_session() -> Option<AgentSession> {
        Self::ensure_dirs();
        if let Ok(entries) = fs::read_dir(SESSIONS_DIR) {
            let mut sessions: Vec<AgentSession> = entries
                .flatten()
                .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
                .filter_map(|e| {
                    fs::read_to_string(e.path())
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                })
                .collect();
            sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
            sessions.into_iter().find(|s| s.phase != SessionPhase::Ended)
        } else {
            None
        }
    }

    /// List all sessions (newest first)
    pub fn list_sessions() -> Vec<AgentSession> {
        Self::ensure_dirs();
        let mut sessions = Vec::new();
        if let Ok(entries) = fs::read_dir(SESSIONS_DIR) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(session) = serde_json::from_str::<AgentSession>(&content) {
                            sessions.push(session);
                        }
                    }
                }
            }
        }
        sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        sessions
    }

    fn save_session(session: &AgentSession) {
        Self::ensure_dirs();
        let path = format!("{}/{}.json", SESSIONS_DIR, session.session_id);
        let json = serde_json::to_string_pretty(session).unwrap_or_default();
        let _ = fs::write(path, json);
    }

    // ── Transcript capture ──

    /// Append a transcript entry for the current session
    pub fn append_transcript(role: &str, content: &str) {
        Self::ensure_dirs();
        let session_id = Self::get_active_session()
            .map(|s| s.session_id)
            .unwrap_or_else(|| "unknown".to_string());

        let entry = TranscriptEntry {
            role: role.to_string(),
            content: content.to_string(),
            timestamp: now_secs(),
            session_id: session_id.clone(),
        };

        let path = format!("{}/{}.jsonl", TRANSCRIPTS_DIR, session_id);
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            if let Ok(json) = serde_json::to_string(&entry) {
                let _ = writeln!(file, "{}", json);
            }
        }

        // Prune if too large
        Self::prune_transcript(&path);
    }

    /// Capture transcript from Claude Code's JSONL files
    pub fn capture_claude_transcript() -> Option<Vec<TranscriptEntry>> {
        let home = std::env::var("HOME").ok()?;
        let cwd = std::env::current_dir().ok()?;
        let dir_name = cwd.to_string_lossy().to_string();
        let re = regex::Regex::new(r"[^a-zA-Z0-9]").ok()?;
        let safe_name = re.replace_all(dir_name.trim_start_matches('/'), "-").to_string();

        let claude_dir = Path::new(&home).join(".claude").join("projects").join(&safe_name);
        if !claude_dir.exists() {
            return None;
        }

        // Find the most recently modified JSONL
        let mut latest_file = None;
        let mut latest_time = SystemTime::UNIX_EPOCH;
        for entry in fs::read_dir(&claude_dir).ok()?.flatten() {
            if entry.path().extension().map(|e| e == "jsonl").unwrap_or(false) {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(time) = meta.modified() {
                        if time > latest_time {
                            latest_time = time;
                            latest_file = Some(entry.path());
                        }
                    }
                }
            }
        }

        let path = latest_file?;
        let file = fs::File::open(&path).ok()?;
        let reader = BufReader::new(file);
        let mut entries = Vec::new();

        for line in reader.lines().flatten() {
            if let Ok(d) = serde_json::from_str::<serde_json::Value>(&line) {
                let msg_type = d.get("type").and_then(|t| t.as_str()).unwrap_or("");
                let session_id = d.get("sessionId").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let ts = d.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");

                let timestamp = parse_timestamp(ts);

                if msg_type == "user" || msg_type == "assistant" {
                    let msg = d.get("message").unwrap_or(&serde_json::Value::Null);
                    let content = extract_message_content(msg);
                    if !content.is_empty() {
                        entries.push(TranscriptEntry {
                            role: msg_type.to_string(),
                            content,
                            timestamp,
                            session_id: session_id.clone(),
                        });
                    }
                }
            }
        }

        if entries.is_empty() { None } else { Some(entries) }
    }

    /// Capture transcript from Gemini CLI hook history
    pub fn capture_gemini_transcript() -> Option<Vec<TranscriptEntry>> {
        // Gemini stores conversation in the hook's history array
        // The hook writes the last response to .gemini.intent, but the full
        // history is only available during hook execution.
        // We read .aura/transcripts/ for any Gemini entries already captured by hooks.
        Self::ensure_dirs();
        let mut all_entries = Vec::new();
        if let Ok(entries) = fs::read_dir(TRANSCRIPTS_DIR) {
            for entry in entries.flatten() {
                if let Ok(content) = fs::read_to_string(entry.path()) {
                    for line in content.lines() {
                        if let Ok(te) = serde_json::from_str::<TranscriptEntry>(line) {
                            all_entries.push(te);
                        }
                    }
                }
            }
        }
        if all_entries.is_empty() { None } else { Some(all_entries) }
    }

    /// Get transcript for a specific session
    pub fn get_transcript(session_id: &str) -> Vec<TranscriptEntry> {
        Self::ensure_dirs();
        let path = format!("{}/{}.jsonl", TRANSCRIPTS_DIR, session_id);
        let mut entries = Vec::new();
        if let Ok(content) = fs::read_to_string(&path) {
            for line in content.lines() {
                if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(line) {
                    entries.push(entry);
                }
            }
        }
        entries
    }

    /// Find the session/transcript that introduced a specific function
    /// by correlating git blame → commit → checkpoint → session
    pub fn explain_code(file_path: &str, identifier: &str) -> Option<(AgentSession, Vec<TranscriptEntry>)> {
        // 1. Find which commit introduced/last modified this code via git blame
        let repo = git2::Repository::open(".").ok()?;
        let blame = repo.blame_file(Path::new(file_path), None).ok()?;

        // Search the file for the identifier to find the line number
        let file_content = fs::read_to_string(file_path).ok()?;
        let mut target_line = None;
        for (i, line) in file_content.lines().enumerate() {
            if line.contains(identifier) {
                target_line = Some(i);
                break;
            }
        }

        let line_num = target_line?;
        let hunk = blame.get_line(line_num + 1)?; // 1-indexed
        let commit_id = hunk.final_commit_id().to_string();
        let short_commit = &commit_id[..7];

        // 2. Find the session that was active around this commit
        let sessions = Self::list_sessions();
        let matching_session = sessions.iter().find(|s| {
            s.base_commit.as_deref() == Some(short_commit)
                || s.files_touched.iter().any(|f| f.contains(file_path))
        });

        if let Some(session) = matching_session {
            let transcript = Self::get_transcript(&session.session_id);
            return Some((session.clone(), transcript));
        }

        // 3. Fallback: check checkpoint intent from git notes
        // Find the checkpoint for this commit and show its intent
        let commit = repo.find_commit(hunk.final_commit_id()).ok()?;
        let notes_ref = "refs/notes/aura";
        if let Ok(note) = repo.find_note(Some(notes_ref), commit.id()) {
            let note_text = note.message().unwrap_or("").to_string();
            if let Ok(checkpoint) = serde_json::from_str::<serde_json::Value>(&note_text) {
                let agent = checkpoint["agent_id"].as_str().unwrap_or("unknown").to_string();
                let intent = checkpoint["intent"].as_str().unwrap_or("").to_string();

                // Create a synthetic session + transcript from the checkpoint
                let session = AgentSession {
                    session_id: format!("commit-{}", short_commit),
                    agent_id: agent.clone(),
                    phase: SessionPhase::Ended,
                    started_at: checkpoint["timestamp"].as_u64().unwrap_or(0),
                    last_activity: checkpoint["timestamp"].as_u64().unwrap_or(0),
                    files_touched: vec![file_path.to_string()],
                    checkpoint_count: 1,
                    base_commit: Some(short_commit.to_string()),
                };

                let transcript = vec![TranscriptEntry {
                    role: "intent".to_string(),
                    content: intent,
                    timestamp: checkpoint["timestamp"].as_u64().unwrap_or(0),
                    session_id: session.session_id.clone(),
                }];

                return Some((session, transcript));
            }
        }

        None
    }

    /// Condense a session transcript into a summary for storage efficiency
    pub fn condense_transcript(session_id: &str) -> String {
        let entries = Self::get_transcript(session_id);
        if entries.is_empty() {
            return String::new();
        }

        let mut summary = String::new();
        for entry in &entries {
            let role_prefix = match entry.role.as_str() {
                "user" => "U",
                "assistant" => "A",
                "tool_use" => "T",
                _ => "?",
            };
            // Truncate long entries for condensed view
            let content = if entry.content.len() > 200 {
                format!("{}...", &entry.content[..200])
            } else {
                entry.content.clone()
            };
            summary.push_str(&format!("[{}] {}\n", role_prefix, content));
        }
        summary
    }

    fn prune_transcript(path: &str) {
        if let Ok(content) = fs::read_to_string(path) {
            let lines: Vec<&str> = content.lines().collect();
            if lines.len() > MAX_TRANSCRIPT_LINES {
                let trimmed = lines[lines.len() - MAX_TRANSCRIPT_LINES..].join("\n");
                let _ = fs::write(path, trimmed);
            }
        }
    }
}

/// Capture full transcript on pre-commit — reads from all agent sources
pub fn capture_full_transcript() {
    // Claude Code
    if let Some(entries) = SessionManager::capture_claude_transcript() {
        let session = SessionManager::start_session("Claude Code");
        let path = format!("{}/{}.jsonl", TRANSCRIPTS_DIR, session.session_id);
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
            for entry in entries {
                if let Ok(json) = serde_json::to_string(&entry) {
                    let _ = writeln!(file, "{}", json);
                }
            }
        }
    }
}

fn extract_message_content(msg: &serde_json::Value) -> String {
    if let Some(content) = msg.get("content") {
        if let Some(text) = content.as_str() {
            return text.to_string();
        }
        if let Some(arr) = content.as_array() {
            for item in arr {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        return text.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn chrono_like_date() -> String {
    // Simple date string without chrono dependency
    let secs = now_secs();
    let days = secs / 86400;
    // Approximate — good enough for session IDs
    let year = 1970 + (days / 365);
    let day_of_year = days % 365;
    let month = day_of_year / 30 + 1;
    let day = day_of_year % 30 + 1;
    format!("{:04}-{:02}-{:02}", year, month.min(12), day.min(31))
}

fn parse_timestamp(ts: &str) -> u64 {
    // Try parsing ISO 8601 or unix timestamp
    if let Ok(secs) = ts.parse::<u64>() {
        return secs;
    }
    // Fallback: current time
    now_secs()
}
