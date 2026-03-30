use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_TRANSCRIPT_LINES: usize = 5000;

/// Resolve session/transcript directories — worktree-aware.
/// In a git worktree, uses the worktree-local .aura directory so concurrent
/// agents in different worktrees don't collide on session state.
fn sessions_dir() -> String {
    worktree_aura_path("sessions")
}

fn transcripts_dir() -> String {
    worktree_aura_path("transcripts")
}

pub(crate) fn worktree_aura_path(subdir: &str) -> String {
    // Check if we're in a worktree by looking for .git file (not directory)
    let git_path = std::path::Path::new(".git");
    if git_path.is_file() {
        // We're in a worktree — .git is a file pointing to the main repo.
        // Derive a unique aura dir from the worktree directory name to
        // prevent concurrent agents from colliding on session state.
        if let Ok(cwd) = std::env::current_dir() {
            let worktree_name = cwd.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "default".to_string());
            // Also find the main repo root to store worktree data there
            if let Ok(git_content) = fs::read_to_string(".git") {
                // .git file contains "gitdir: /path/to/main/.git/worktrees/<name>"
                if let Some(main_git) = git_content.trim().strip_prefix("gitdir: ") {
                    // Navigate up from .git/worktrees/<name> to repo root
                    let main_git_path = Path::new(main_git);
                    if let Some(repo_root) = main_git_path.parent()
                        .and_then(|p| p.parent())
                        .and_then(|p| p.parent())
                    {
                        let wt_aura = repo_root.join(".aura").join("worktrees")
                            .join(&worktree_name).join(subdir);
                        return wt_aura.to_string_lossy().to_string();
                    }
                }
            }
            // Fallback: use worktree-namespaced dir locally
            return format!(".aura/worktrees/{}/{}", worktree_name, subdir);
        }
    }
    format!(".aura/{}", subdir)
}

/// Session phase — tracks lifecycle of an agent conversation
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum SessionPhase {
    Active,
    Idle,
    Ended,
}

/// Token usage tracking per session (inspired by Entire CLI)
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub api_call_count: u32,
}

impl TokenUsage {
    pub fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens
    }

    pub fn merge(&mut self, other: &TokenUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_creation_tokens += other.cache_creation_tokens;
        self.api_call_count += other.api_call_count;
    }
}

/// Tracked subagent (Claude Code Task/Agent tool spawned agents)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SubagentRecord {
    pub agent_id: String,
    pub agent_type: String,
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub result_summary: Option<String>,
}

/// AI-generated session summary
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SessionSummary {
    pub intent: String,
    pub outcome: String,
    pub files_changed: Vec<String>,
    #[serde(default)]
    pub learnings: Vec<String>,
    #[serde(default)]
    pub open_items: Vec<String>,
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
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub token_usage: Option<TokenUsage>,
    #[serde(default)]
    pub summary: Option<SessionSummary>,
    #[serde(default)]
    pub model_name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub first_prompt: Option<String>,
    #[serde(default)]
    pub subagents: Vec<SubagentRecord>,
    #[serde(default)]
    pub pid: Option<u32>,
    /// Project name (repo directory name) — used for cross-project usage tracking
    #[serde(default)]
    pub project: Option<String>,
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
        let _ = fs::create_dir_all(&sessions_dir());
        let _ = fs::create_dir_all(&transcripts_dir());
    }

    /// Start or resume a session for an agent
    pub fn start_session(agent_id: &str) -> AgentSession {
        Self::ensure_dirs();

        // Check for existing active session from THIS process
        if let Some(existing) = Self::get_active_session() {
            let my_pid = std::process::id();
            if existing.agent_id == agent_id
                && existing.phase != SessionPhase::Ended
                && existing.pid == Some(my_pid)
            {
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

        let branch = git2::Repository::open(".")
            .ok()
            .and_then(|r| {
                let head = r.head().ok()?;
                head.shorthand().map(|s| s.to_string())
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
            worktree: std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()),
            token_usage: Some(TokenUsage::default()),
            summary: None,
            model_name: None,
            branch,
            first_prompt: None,
            subagents: Vec::new(),
            pid: Some(std::process::id()),
            project: std::env::current_dir().ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())),
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

    /// End the current session and release sentinel claims.
    /// Auto-replies to any unread messages so senders aren't left hanging.
    pub fn end_session() {
        if let Some(session) = Self::get_active_session() {
            // Auto-reply to unread messages before ending
            let unread = crate::sentinel::SentinelManager::get_unread_messages(&session.session_id);
            if !unread.is_empty() {
                // Collect unique senders to reply to
                let mut replied_sessions = std::collections::HashSet::new();
                for msg in &unread {
                    if msg.from_session != session.session_id && !replied_sessions.contains(&msg.from_session) {
                        replied_sessions.insert(msg.from_session.clone());
                        crate::sentinel::SentinelManager::send_message(
                            &session.session_id,
                            &session.agent_id,
                            Some(&msg.from_session),
                            &format!(
                                "[AUTO] {} session ended. {} unread message{} were not seen. \
                                 Files touched: {}. The work may be incomplete — check git log for latest state.",
                                session.agent_id,
                                unread.iter().filter(|m| m.from_session == msg.from_session).count(),
                                if unread.iter().filter(|m| m.from_session == msg.from_session).count() == 1 { "" } else { "s" },
                                if session.files_touched.is_empty() {
                                    "none".to_string()
                                } else {
                                    session.files_touched.iter().take(5).cloned().collect::<Vec<_>>().join(", ")
                                }
                            ),
                        );
                    }
                }
            }
            crate::sentinel::SentinelManager::release_claims(&session.session_id);
        }
        Self::set_phase(SessionPhase::Ended);
    }

    /// Get the currently active session for this process.
    /// Prefers a session matching the current PID; falls back to most recent active.
    pub fn get_active_session() -> Option<AgentSession> {
        Self::ensure_dirs();
        if let Ok(entries) = fs::read_dir(&sessions_dir()) {
            let my_pid = std::process::id();
            let mut sessions: Vec<AgentSession> = entries
                .flatten()
                .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
                .filter_map(|e| {
                    fs::read_to_string(e.path())
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                })
                .filter(|s: &AgentSession| s.phase != SessionPhase::Ended)
                .collect();
            sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

            // Prefer session matching our PID (multi-agent safe)
            if let Some(mine) = sessions.iter().find(|s| s.pid == Some(my_pid)) {
                return Some(mine.clone());
            }
            // Fallback: most recent active session
            sessions.into_iter().next()
        } else {
            None
        }
    }

    /// List all sessions (newest first)
    pub fn list_sessions() -> Vec<AgentSession> {
        Self::ensure_dirs();
        let mut sessions = Vec::new();
        if let Ok(entries) = fs::read_dir(&sessions_dir()) {
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

    /// Update token usage for the active session
    pub fn add_tokens(input: u64, output: u64) {
        if let Some(mut session) = Self::get_active_session() {
            let usage = session.token_usage.get_or_insert_with(TokenUsage::default);
            usage.input_tokens += input;
            usage.output_tokens += output;
            usage.api_call_count += 1;
            session.last_activity = now_secs();
            Self::save_session(&session);
        }
    }

    /// Set the model name for the active session
    pub fn set_model(model: &str) {
        if let Some(mut session) = Self::get_active_session() {
            if session.model_name.is_none() {
                session.model_name = Some(model.to_string());
                Self::save_session(&session);
            }
        }
    }

    /// Set the first prompt for the active session
    pub fn set_first_prompt(prompt: &str) {
        if let Some(mut session) = Self::get_active_session() {
            if session.first_prompt.is_none() {
                let truncated = if prompt.len() > 200 {
                    format!("{}...", &prompt[..200])
                } else {
                    prompt.to_string()
                };
                session.first_prompt = Some(truncated);
                Self::save_session(&session);
            }
        }
    }

    /// Track a subagent being spawned
    pub fn record_subagent_start(agent_id: &str, agent_type: &str) {
        if let Some(mut session) = Self::get_active_session() {
            session.subagents.push(SubagentRecord {
                agent_id: agent_id.to_string(),
                agent_type: agent_type.to_string(),
                started_at: now_secs(),
                ended_at: None,
                result_summary: None,
            });
            session.last_activity = now_secs();
            Self::save_session(&session);
        }
    }

    /// Track a subagent finishing
    pub fn record_subagent_stop(agent_id: &str, result_summary: Option<&str>) {
        if let Some(mut session) = Self::get_active_session() {
            if let Some(sub) = session.subagents.iter_mut()
                .rev()  // find most recent matching
                .find(|s| s.agent_id == agent_id && s.ended_at.is_none())
            {
                sub.ended_at = Some(now_secs());
                sub.result_summary = result_summary.map(|s| {
                    if s.len() > 200 { format!("{}...", &s[..200]) }
                    else { s.to_string() }
                });
            }
            session.last_activity = now_secs();
            Self::save_session(&session);
        }
    }

    /// Extract token usage from a Claude Code transcript JSONL file.
    /// Claude Code transcripts contain `usage` objects with token counts.
    pub fn extract_tokens_from_transcript(transcript_path: &str) -> Option<TokenUsage> {
        let content = fs::read_to_string(transcript_path).ok()?;
        let mut usage = TokenUsage::default();

        for line in content.lines() {
            if let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) {
                // Claude Code transcript format: {"type":"assistant","message":{"usage":{...}}}
                if let Some(msg_usage) = entry.get("message")
                    .and_then(|m| m.get("usage"))
                {
                    usage.input_tokens += msg_usage["input_tokens"].as_u64().unwrap_or(0);
                    usage.output_tokens += msg_usage["output_tokens"].as_u64().unwrap_or(0);
                    if let Some(cache) = msg_usage.get("cache_read_input_tokens") {
                        usage.cache_read_tokens += cache.as_u64().unwrap_or(0);
                    }
                    if let Some(cache) = msg_usage.get("cache_creation_input_tokens") {
                        usage.cache_creation_tokens += cache.as_u64().unwrap_or(0);
                    }
                    usage.api_call_count += 1;
                }
                // Also check top-level usage field
                if let Some(top_usage) = entry.get("usage") {
                    usage.input_tokens += top_usage["input_tokens"].as_u64().unwrap_or(0);
                    usage.output_tokens += top_usage["output_tokens"].as_u64().unwrap_or(0);
                    usage.api_call_count += 1;
                }
            }
        }

        if usage.api_call_count > 0 {
            Some(usage)
        } else {
            None
        }
    }

    /// Sync token usage from transcript into the active session
    pub fn sync_tokens_from_transcript(transcript_path: &str) {
        if let Some(mut session) = Self::get_active_session() {
            if let Some(extracted) = Self::extract_tokens_from_transcript(transcript_path) {
                session.token_usage = Some(extracted);
                session.last_activity = now_secs();
                Self::save_session(&session);
            }
        }
    }

    /// Resume: find sessions associated with a branch and show resume info
    pub fn resume_branch(branch: &str) -> Vec<AgentSession> {
        let sessions = Self::list_sessions();
        sessions.into_iter()
            .filter(|s| s.branch.as_deref() == Some(branch))
            .collect()
    }

    /// Doctor: find stuck sessions (active but stale > 1 hour)
    pub fn find_stuck_sessions() -> Vec<(AgentSession, String)> {
        let now = now_secs();
        let staleness_threshold = 3600; // 1 hour
        let sessions = Self::list_sessions();
        let mut stuck = Vec::new();

        for sess in sessions {
            match sess.phase {
                SessionPhase::Active => {
                    if now - sess.last_activity > staleness_threshold {
                        let reason = format!(
                            "Active but no interaction for {} minutes",
                            (now - sess.last_activity) / 60
                        );
                        stuck.push((sess, reason));
                    }
                }
                SessionPhase::Idle => {
                    if now - sess.last_activity > staleness_threshold * 24 {
                        let reason = format!(
                            "Idle for {} hours",
                            (now - sess.last_activity) / 3600
                        );
                        stuck.push((sess, reason));
                    }
                }
                _ => {}
            }
        }
        stuck
    }

    /// Doctor: force-end a stuck session
    pub fn force_end_session(session_id: &str) -> bool {
        let sessions = Self::list_sessions();
        if let Some(mut sess) = sessions.into_iter().find(|s| s.session_id == session_id) {
            sess.phase = SessionPhase::Ended;
            sess.last_activity = now_secs();
            Self::save_session(&sess);
            true
        } else {
            false
        }
    }

    /// Cleanup: remove ended sessions older than N days
    pub fn cleanup_stale(max_age_days: u64) -> usize {
        let now = now_secs();
        let max_age_secs = max_age_days * 86400;
        let mut removed = 0;

        if let Ok(entries) = fs::read_dir(&sessions_dir()) {
            for entry in entries.flatten() {
                if entry.path().extension().map(|x| x == "json").unwrap_or(false) {
                    if let Ok(content) = fs::read_to_string(entry.path()) {
                        if let Ok(sess) = serde_json::from_str::<AgentSession>(&content) {
                            if sess.phase == SessionPhase::Ended && now - sess.last_activity > max_age_secs {
                                let _ = fs::remove_file(entry.path());
                                // Also remove transcript
                                let transcript = format!("{}/{}.jsonl", &transcripts_dir(), sess.session_id);
                                let _ = fs::remove_file(&transcript);
                                removed += 1;
                            }
                        }
                    }
                }
            }
        }
        removed
    }

    /// Auto-summarize a session using AI (Gemini/Claude)
    pub fn summarize_session(session_id: &str) -> Option<SessionSummary> {
        let transcript = Self::get_transcript(session_id);
        if transcript.is_empty() {
            return None;
        }

        // Build a condensed transcript for the AI
        let mut condensed = String::new();
        for entry in transcript.iter().take(50) {
            let content = if entry.content.len() > 300 {
                format!("{}...", &entry.content[..300])
            } else {
                entry.content.clone()
            };
            condensed.push_str(&format!("[{}] {}\n", entry.role, content));
        }

        // Try to summarize via Gemini API
        let config = crate::config::ConfigManager::load();
        let api_key = config.gemini_api_key
            .or(crate::config::ConfigManager::get_api_key("gemini"));

        if let Some(key) = api_key {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .ok()?;

            let prompt = format!(
                "Summarize this AI coding session in JSON format. Return ONLY valid JSON:\n\
                {{\"intent\": \"what the user wanted\", \"outcome\": \"what was achieved\", \
                \"files_changed\": [\"file1.rs\"], \"learnings\": [\"key insight\"], \
                \"open_items\": [\"remaining work\"]}}\n\nSession transcript:\n{}",
                condensed
            );

            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={}",
                key
            );
            let body = serde_json::json!({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 500}
            });

            if let Ok(res) = client.post(&url).json(&body).send() {
                if let Ok(json) = res.json::<serde_json::Value>() {
                    let text = json["candidates"][0]["content"]["parts"][0]["text"]
                        .as_str()
                        .unwrap_or("");
                    // Extract JSON from response (may have markdown fences)
                    let json_str = text
                        .trim()
                        .trim_start_matches("```json")
                        .trim_start_matches("```")
                        .trim_end_matches("```")
                        .trim();
                    if let Ok(summary) = serde_json::from_str::<SessionSummary>(json_str) {
                        // Save to session
                        if let Some(mut sess) = Self::list_sessions().into_iter()
                            .find(|s| s.session_id == session_id)
                        {
                            sess.summary = Some(summary.clone());
                            Self::save_session(&sess);
                        }
                        return Some(summary);
                    }
                }
            }
        }

        // Fallback: basic summary without AI
        let sessions = Self::list_sessions();
        let sess = sessions.iter().find(|s| s.session_id == session_id)?;
        Some(SessionSummary {
            intent: sess.first_prompt.clone().unwrap_or_else(|| "Unknown".to_string()),
            outcome: format!("{} files modified, {} checkpoints", sess.files_touched.len(), sess.checkpoint_count),
            files_changed: sess.files_touched.clone(),
            learnings: vec![],
            open_items: vec![],
        })
    }

    /// Calculate turn count from transcript entries (user prompts = turns)
    pub fn turn_count(session_id: &str) -> u32 {
        let entries = Self::get_transcript(session_id);
        entries.iter().filter(|e| e.role == "user").count() as u32
    }

    /// Get subagent count and types for a session
    pub fn subagent_summary(session_id: &str) -> (u32, Vec<String>) {
        let sessions = Self::list_sessions();
        if let Some(sess) = sessions.iter().find(|s| s.session_id == session_id) {
            let count = sess.subagents.len() as u32;
            let types: Vec<String> = sess
                .subagents
                .iter()
                .map(|s| s.agent_type.clone())
                .collect::<std::collections::HashSet<_>>()
                .into_iter()
                .collect();
            (count, types)
        } else {
            (0, vec![])
        }
    }

    /// Detect if a branch was squash-merged into the base branch.
    /// Returns the merge commit message if found.
    pub fn detect_squash_merge(branch: &str) -> Option<String> {
        let repo = git2::Repository::open(".").ok()?;

        // Check if the branch still exists — if not, it was likely merged and deleted
        let branch_exists = repo
            .find_branch(branch, git2::BranchType::Local)
            .is_ok();

        if branch_exists {
            // Branch still exists, check if its commits are in main/master
            return None;
        }

        // Branch was deleted — look for squash merge in recent commits on HEAD
        let mut revwalk = repo.revwalk().ok()?;
        revwalk.push_head().ok()?;

        for oid in revwalk.take(50) {
            let oid = oid.ok()?;
            let commit = repo.find_commit(oid).ok()?;
            if let Some(message) = commit.message() {
                // Common squash merge patterns
                if message.contains(branch)
                    || message.contains(&format!("Squashed commit of {}", branch))
                    || message.contains(&format!("Merge branch '{}'", branch))
                    || message.contains(&format!("(#"))  // GitHub PR merge
                {
                    return Some(message.to_string());
                }
            }
        }

        None
    }

    fn save_session(session: &AgentSession) {
        Self::ensure_dirs();
        let path = format!("{}/{}.json", &sessions_dir(), session.session_id);
        let json = serde_json::to_string_pretty(session).unwrap_or_default();
        let _ = fs::write(path, &json);

        // Mirror to global ~/.aura/usage/ for cross-project aggregation
        if let Ok(home) = std::env::var("HOME") {
            let global_dir = format!("{}/.aura/usage", home);
            let _ = fs::create_dir_all(&global_dir);
            let global_path = format!("{}/{}.json", global_dir, session.session_id);
            let _ = fs::write(global_path, &json);
        }
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

        let path = format!("{}/{}.jsonl", &transcripts_dir(), session_id);
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
        if let Ok(entries) = fs::read_dir(&transcripts_dir()) {
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
        let path = format!("{}/{}.jsonl", &transcripts_dir(), session_id);
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
                    worktree: None,
                    token_usage: None,
                    summary: None,
                    model_name: None,
                    branch: None,
                    first_prompt: Some(intent.clone()),
                    subagents: Vec::new(),
                    pid: None,
                    project: None,
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
        let path = format!("{}/{}.jsonl", &transcripts_dir(), session.session_id);
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
