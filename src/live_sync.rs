use crate::config::ConfigManager;
use crate::live_events::{LiveEvent, LiveEventBuffer, current_branch, repo_name, git_user};
use colored::Colorize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Build a reqwest client that respects the accept_self_signed config for mothership TLS.
fn build_cloud_client() -> reqwest::blocking::Client {
    let config = ConfigManager::load();
    let mut builder = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10));
    if config.accept_self_signed {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder.build().unwrap_or_else(|_| reqwest::blocking::Client::new())
}

/// Manages the daemon-to-cloud sync loop.
/// Batches local events every SYNC_INTERVAL and POSTs to Aura Cloud.
/// Sends heartbeats every HEARTBEAT_INTERVAL to maintain presence.
pub struct LiveSyncWorker {
    cloud_url: String,
    cloud_token: String,
    repo: String,
    branch: String,
    user: String,
    client: reqwest::blocking::Client,
    running: Arc<AtomicBool>,
}

const SYNC_INTERVAL_SECS: u64 = 5;
const HEARTBEAT_INTERVAL_SECS: u64 = 30;

impl LiveSyncWorker {
    /// Try to create a sync worker. Returns None if no cloud token is configured.
    pub fn new(running: Arc<AtomicBool>) -> Option<Self> {
        let config = ConfigManager::load();
        let token = config.cloud_api_token
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())?;

        let cloud_url = config.cloud_url
            .unwrap_or_else(|| "https://auravcs.com".to_string())
            .trim_end_matches('/')
            .to_string();

        Some(Self {
            cloud_url,
            cloud_token: token,
            repo: repo_name(),
            branch: current_branch(),
            user: git_user(),
            client: {
                let mut builder = reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(10));
                if config.accept_self_signed {
                    builder = builder.danger_accept_invalid_certs(true);
                }
                builder.build().unwrap_or_else(|_| reqwest::blocking::Client::new())
            },
            running,
        })
    }

    /// Start the sync loop in a background thread. Returns the join handle.
    pub fn start(self) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            self.run_loop();
        })
    }

    fn run_loop(&self) {
        let mut ticks_since_heartbeat: u64 = 0;

        while self.running.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_secs(SYNC_INTERVAL_SECS));

            if !self.running.load(Ordering::Relaxed) {
                break;
            }

            // Drain and sync events
            let events = LiveEventBuffer::drain();
            if !events.is_empty() {
                self.sync_events(&events);
            }

            // Heartbeat every HEARTBEAT_INTERVAL
            ticks_since_heartbeat += SYNC_INTERVAL_SECS;
            if ticks_since_heartbeat >= HEARTBEAT_INTERVAL_SECS {
                self.send_heartbeat();
                ticks_since_heartbeat = 0;
            }
        }

        // Final drain on shutdown
        let remaining = LiveEventBuffer::drain();
        if !remaining.is_empty() {
            self.sync_events(&remaining);
        }
    }

    fn sync_events(&self, events: &[LiveEvent]) {
        let event_data: Vec<serde_json::Value> = events.iter().map(|e| {
            json!({
                "event_id": e.event_id,
                "branch": e.branch,
                "file_path": e.file_path,
                "changes": e.changes.iter().map(|c| {
                    json!({
                        "name": c.name,
                        "kind": c.kind,
                        "change_type": c.change_type,
                        "old_hash": c.old_hash,
                        "new_hash": c.new_hash,
                        "dependencies": c.dependencies,
                    })
                }).collect::<Vec<_>>(),
            })
        }).collect();

        let payload = json!({
            "repo_full_name": self.repo,
            "events": event_data,
        });

        let url = format!("{}/api/v1/live/events", self.cloud_url);

        match self.client.post(&url)
            .header("Authorization", format!("Bearer {}", self.cloud_token))
            .json(&payload)
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                println!("  {} Synced {} events to Aura Cloud", "☁".cyan(), events.len());
            }
            Ok(resp) => {
                println!("  {} Cloud sync failed ({}), events buffered locally",
                    "⚠".yellow(), resp.status());
                // Re-buffer the events so they aren't lost
                for event in events {
                    let _ = LiveEventBuffer::append(event);
                }
            }
            Err(e) => {
                println!("  {} Cloud unreachable ({}), operating offline",
                    "⚠".yellow(), e);
                for event in events {
                    let _ = LiveEventBuffer::append(event);
                }
            }
        }
    }

    fn send_heartbeat(&self) {
        let payload = json!({
            "repo_full_name": self.repo,
            "branch": current_branch(), // Re-read in case branch changed
        });

        let url = format!("{}/api/v1/live/heartbeat", self.cloud_url);

        match self.client.post(&url)
            .header("Authorization", format!("Bearer {}", self.cloud_token))
            .json(&payload)
            .send()
        {
            Ok(resp) if resp.status().is_success() => {
                // Parse pending impacts + unread messages from heartbeat response
                if let Ok(data) = resp.json::<serde_json::Value>() {
                    let marker_dir = std::path::Path::new(".aura/live");
                    let _ = std::fs::create_dir_all(marker_dir);

                    // Impact alerts marker
                    let pending = data["pending_impacts"].as_u64().unwrap_or(0);
                    let impact_marker = marker_dir.join("impacts_pending");
                    if pending > 0 {
                        let _ = std::fs::write(&impact_marker, pending.to_string());
                    } else if impact_marker.exists() {
                        let _ = std::fs::remove_file(&impact_marker);
                    }

                    // Unread messages marker
                    let unread = data["unread_messages"].as_u64().unwrap_or(0);
                    let msg_marker = marker_dir.join("unread_messages");
                    if unread > 0 {
                        let _ = std::fs::write(&msg_marker, unread.to_string());
                    } else if msg_marker.exists() {
                        let _ = std::fs::remove_file(&msg_marker);
                    }

                    // Sync pending marker
                    let sync_pending = data["sync_pending"].as_u64().unwrap_or(0);
                    let sync_marker = marker_dir.join("sync_pending");
                    if sync_pending > 0 {
                        let _ = std::fs::write(&sync_marker, sync_pending.to_string());
                    } else if sync_marker.exists() {
                        let _ = std::fs::remove_file(&sync_marker);
                    }
                }
            }
            _ => {
                // Heartbeat failures are non-critical, just log
                println!("  {} Heartbeat failed, will retry", "⚠".yellow());
            }
        }
    }
}

/// Fetch unresolved impact alerts as JSON from Aura Cloud.
/// Used by MCP tools and `aura live impacts --json`.
pub fn fetch_impacts_json() -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let repo = repo_name();
    let url = format!("{}/api/v1/live/impacts?repo={}",
        cloud_url.trim_end_matches('/'), repo);

    let client = build_cloud_client();

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Send a team message via Aura Cloud.
pub fn send_team_message(message: &str, to: Option<&str>) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/messages",
        cloud_url.trim_end_matches('/'));

    let repo = repo_name();
    let branch = current_branch();

    let mut payload = json!({
        "repo_full_name": repo,
        "branch": branch,
        "message": message,
    });
    if let Some(recipient) = to {
        payload["to"] = json!(recipient);
    }

    let client = build_cloud_client();

    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Fetch recent team messages from Aura Cloud.
pub fn fetch_team_messages(limit: usize) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let repo = repo_name();
    let url = format!("{}/api/v1/live/messages?repo={}&limit={}",
        cloud_url.trim_end_matches('/'), repo, limit);

    let client = build_cloud_client();

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Push function bodies to Aura Cloud for sync.
pub fn push_function_bodies(functions: &[SyncFunctionPayload]) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/sync/push",
        cloud_url.trim_end_matches('/'));

    let repo = repo_name();
    let branch = current_branch();

    let payload = json!({
        "repo_full_name": repo,
        "branch": branch,
        "functions": functions,
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Pull function bodies from other developers since last cursor.
pub fn pull_function_bodies() -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let repo = repo_name();
    let branch = current_branch();
    let url = format!("{}/api/v1/live/sync/pull?repo={}&branch={}",
        cloud_url.trim_end_matches('/'), repo, branch);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Get sync status from Aura Cloud.
pub fn fetch_sync_status() -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let repo = repo_name();
    let branch = current_branch();
    let url = format!("{}/api/v1/live/sync/status?repo={}&branch={}",
        cloud_url.trim_end_matches('/'), repo, branch);

    let client = build_cloud_client();

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Payload for pushing function bodies to cloud.
#[derive(serde::Serialize)]
pub struct SyncFunctionPayload {
    pub file_path: String,
    pub function_name: String,
    pub function_kind: String,
    pub content_hash: String,
    pub body: String,
}

/// Apply pulled function bodies to local files using AST-level splice.
/// Returns (applied_count, skipped_count, conflicts).
pub fn apply_pulled_functions(
    functions: &[serde_json::Value],
) -> (usize, usize, Vec<String>) {
    let mut applied = 0;
    let mut skipped = 0;
    let mut conflicts = Vec::new();

    for func in functions {
        let file_path = match func["file_path"].as_str() {
            Some(p) => p,
            None => { skipped += 1; continue; }
        };
        let function_name = match func["function_name"].as_str() {
            Some(n) => n,
            None => { skipped += 1; continue; }
        };
        let new_body = match func["body"].as_str() {
            Some(b) => b,
            None => { skipped += 1; continue; }
        };
        let remote_hash = func["content_hash"].as_str().unwrap_or("");
        let pushed_by = func["pushed_by"].as_str().unwrap_or("unknown");

        // Check if file exists
        let path = std::path::Path::new(file_path);
        if !path.exists() {
            // File doesn't exist locally — create it with just this function
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, format!("{}\n", new_body));
            applied += 1;
            continue;
        }

        // Read current file
        let file_content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => { skipped += 1; continue; }
        };

        // Snapshot before modifying
        let _ = crate::checkpoint::SnapshotStore::snapshot_file(file_path, "sync_pull", "aura-sync");

        // Try to find and replace the function in the file
        match splice_function(&file_content, function_name, new_body) {
            SpliceResult::Replaced(new_content) => {
                let _ = std::fs::write(path, &new_content);
                applied += 1;
            }
            SpliceResult::NotFound => {
                // Function doesn't exist locally — append it
                let mut content = file_content;
                if !content.ends_with('\n') {
                    content.push('\n');
                }
                content.push('\n');
                content.push_str(new_body);
                content.push('\n');
                let _ = std::fs::write(path, &content);
                applied += 1;
            }
            SpliceResult::Conflict(reason) => {
                conflicts.push(format!(
                    "{}::{} (from {}) — {}",
                    file_path, function_name, pushed_by, reason
                ));
                skipped += 1;
            }
        }
    }

    (applied, skipped, conflicts)
}

enum SpliceResult {
    Replaced(String),
    NotFound,
    Conflict(String),
}

/// Find a function/class/struct by name in the file content and replace its body.
/// Uses simple brace-matching for languages with braces (Rust, JS, TS, Go, Java, etc.)
fn splice_function(file_content: &str, function_name: &str, new_body: &str) -> SpliceResult {
    // Strategy: Find the function signature line, then match braces to find the end
    let lines: Vec<&str> = file_content.lines().collect();

    // Look for function definition patterns
    let mut start_line = None;
    for (i, line) in lines.iter().enumerate() {
        // Match common function definition patterns
        let trimmed = line.trim();
        if (trimmed.contains(&format!("fn {}", function_name))
            || trimmed.contains(&format!("function {}", function_name))
            || trimmed.contains(&format!("def {}", function_name))
            || trimmed.contains(&format!("class {}", function_name))
            || trimmed.contains(&format!("struct {}", function_name))
            || trimmed.contains(&format!("impl {}", function_name))
            || trimmed.contains(&format!("pub fn {}", function_name))
            || trimmed.contains(&format!("pub struct {}", function_name))
            || trimmed.contains(&format!("pub enum {}", function_name))
            || trimmed.contains(&format!("enum {}", function_name))
            || trimmed.contains(&format!("async fn {}", function_name))
            || trimmed.contains(&format!("pub async fn {}", function_name))
            || trimmed.contains(&format!("const {}", function_name))
            || trimmed.contains(&format!("pub const {}", function_name))
            || trimmed.contains(&format!("let {}", function_name))
            || trimmed.contains(&format!("export function {}", function_name))
            || trimmed.contains(&format!("export const {}", function_name))
            || trimmed.contains(&format!("export default function {}", function_name)))
            && !trimmed.starts_with("//")
            && !trimmed.starts_with("*")
            && !trimmed.starts_with("#")
        {
            start_line = Some(i);
            break;
        }
    }

    let start = match start_line {
        Some(s) => s,
        None => return SpliceResult::NotFound,
    };

    // Find the end using brace matching
    let file_from_start = lines[start..].join("\n");
    let mut brace_depth = 0;
    let mut found_open = false;
    let mut end_offset = 0;

    for (i, ch) in file_from_start.char_indices() {
        match ch {
            '{' => {
                if !found_open {
                    found_open = true;
                }
                brace_depth += 1;
            }
            '}' => {
                brace_depth -= 1;
                if found_open && brace_depth == 0 {
                    end_offset = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if end_offset == 0 {
        // No matching braces found — might be a Python def or single-line
        // For Python: find the next line with equal or less indentation
        let start_indent = lines[start].len() - lines[start].trim_start().len();
        let mut end_line = start + 1;
        while end_line < lines.len() {
            let line = lines[end_line];
            if !line.trim().is_empty() {
                let indent = line.len() - line.trim_start().len();
                if indent <= start_indent {
                    break;
                }
            }
            end_line += 1;
        }

        // Replace lines[start..end_line] with new_body
        let mut result = String::new();
        for line in &lines[..start] {
            result.push_str(line);
            result.push('\n');
        }
        result.push_str(new_body);
        if !new_body.ends_with('\n') {
            result.push('\n');
        }
        for line in &lines[end_line..] {
            result.push_str(line);
            result.push('\n');
        }

        return SpliceResult::Replaced(result);
    }

    // Count lines consumed from start
    let consumed_text = &file_from_start[..end_offset];
    let consumed_lines = consumed_text.matches('\n').count();
    let end_line = start + consumed_lines + 1;

    // Replace lines[start..end_line] with new_body
    let mut result = String::new();
    for line in &lines[..start] {
        result.push_str(line);
        result.push('\n');
    }
    result.push_str(new_body);
    if !new_body.ends_with('\n') {
        result.push('\n');
    }
    if end_line < lines.len() {
        for line in &lines[end_line..] {
            result.push_str(line);
            result.push('\n');
        }
    }

    SpliceResult::Replaced(result)
}

/// Extract a function body from source text by identifier name.
/// Returns the full text of the function/struct/class definition.
pub fn extract_function_body(source: &str, function_name: &str) -> Option<String> {
    let lines: Vec<&str> = source.lines().collect();

    // Find the start line
    let mut start_line = None;
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if (trimmed.contains(&format!("fn {}", function_name))
            || trimmed.contains(&format!("function {}", function_name))
            || trimmed.contains(&format!("def {}", function_name))
            || trimmed.contains(&format!("class {}", function_name))
            || trimmed.contains(&format!("struct {}", function_name))
            || trimmed.contains(&format!("impl {}", function_name))
            || trimmed.contains(&format!("enum {}", function_name))
            || trimmed.contains(&format!("const {}", function_name))
            || trimmed.contains(&format!("export function {}", function_name))
            || trimmed.contains(&format!("export const {}", function_name))
            || trimmed.contains(&format!("export default function {}", function_name)))
            && !trimmed.starts_with("//")
            && !trimmed.starts_with("*")
            && !trimmed.starts_with("#")
        {
            start_line = Some(i);
            break;
        }
    }

    let start = start_line?;

    // Find end using brace matching
    let file_from_start = lines[start..].join("\n");
    let mut brace_depth = 0;
    let mut found_open = false;
    let mut end_offset = 0;

    for (i, ch) in file_from_start.char_indices() {
        match ch {
            '{' => {
                if !found_open { found_open = true; }
                brace_depth += 1;
            }
            '}' => {
                brace_depth -= 1;
                if found_open && brace_depth == 0 {
                    end_offset = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }

    if end_offset > 0 {
        Some(file_from_start[..end_offset].to_string())
    } else {
        // Python style — indentation based
        let start_indent = lines[start].len() - lines[start].trim_start().len();
        let mut end_line = start + 1;
        while end_line < lines.len() {
            let line = lines[end_line];
            if !line.trim().is_empty() {
                let indent = line.len() - line.trim_start().len();
                if indent <= start_indent {
                    break;
                }
            }
            end_line += 1;
        }
        Some(lines[start..end_line].join("\n"))
    }
}

/// Check if cloud sync is configured and print status.
pub fn print_sync_status() {
    let config = ConfigManager::load();
    let has_token = config.cloud_api_token.is_some()
        || std::env::var("AURA_CLOUD_TOKEN").is_ok();

    if has_token {
        let url = config.cloud_url
            .unwrap_or_else(|| "https://auravcs.com".to_string());
        println!("  {} Cloud sync: {} ({})", "☁".cyan(), "enabled".green(), url.dimmed());
    } else {
        println!("  {} Cloud sync: {} (set token with {})",
            "☁".dimmed(),
            "offline".yellow(),
            "aura config set cloud-token <token>".cyan());
    }
}
