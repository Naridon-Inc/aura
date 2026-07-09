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
    ///
    /// Also spawns the WS client thread (W2.1b) — it runs independently
    /// and fails closed (HTTP polling here still works if the WS connect
    /// cannot be established).
    pub fn start(self) -> thread::JoinHandle<()> {
        let _ = crate::live_ws::spawn(
            self.cloud_url.clone(),
            self.cloud_token.clone(),
            self.running.clone(),
        );
        // Spawn the whole-file CRDT daemon whenever CRDT is the writer for this
        // repo (cloud-routed, or Go Live turned it on) — not only when
        // cloud-routed. While it runs it owns the bytes; the function-body pull
        // below demotes itself to detection-only on the same predicate.
        if crate::crdt_daemon::live_crdt_enabled() {
            let _ = crate::crdt_daemon::spawn(self.running.clone());
        }
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

            // Drain and sync events (PUSH)
            let events = LiveEventBuffer::drain();
            if !events.is_empty() {
                self.sync_events(&events);
            }

            // Retry any outbox entries queued from prior failures
            self.drain_outbox();

            // Auto-pull teammate changes (PULL) — the "Google Docs" half
            self.try_auto_pull();

            // Heartbeat every HEARTBEAT_INTERVAL
            ticks_since_heartbeat += SYNC_INTERVAL_SECS;
            if ticks_since_heartbeat >= HEARTBEAT_INTERVAL_SECS {
                self.send_heartbeat();
                ticks_since_heartbeat = 0;
            }
        }

        // Final drain on shutdown — in-memory buffer first, then outbox.
        let remaining = LiveEventBuffer::drain();
        if !remaining.is_empty() {
            self.sync_events(&remaining);
        }
        self.drain_outbox();
    }

    fn sync_events(&self, events: &[LiveEvent]) {
        // Pull the most recent prose intent (if any) from .aura/intent_log.jsonl
        // and attach it as the rationale for any change that doesn't have one
        // yet. Without this fallback, dashboard "Intent Log" rows fall back
        // to AST-diff summaries ("1 added: foo in bar.rs") even though the
        // agent logged full prose via `aura_log_intent`.
        let latest_prose = read_latest_intent_prose(30 * 60); // 30min window
        let event_data: Vec<serde_json::Value> = events.iter().map(|e| {
            json!({
                "event_id": e.event_id,
                "branch": e.branch,
                "file_path": e.file_path,
                "changes": e.changes.iter().map(|c| {
                    let rationale = c.rationale.clone().or_else(|| latest_prose.clone());
                    json!({
                        "name": c.name,
                        "kind": c.kind,
                        "change_type": c.change_type,
                        "old_hash": c.old_hash,
                        "new_hash": c.new_hash,
                        "dependencies": c.dependencies,
                        "rationale": rationale,
                        "summary": c.summary,
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
                let status = resp.status();
                if status.is_client_error() {
                    println!("  {} Cloud rejected events ({}), dropping (4xx poison)",
                        "⚠".yellow(), status);
                } else {
                    println!("  {} Cloud sync failed ({}), queued to outbox",
                        "⚠".yellow(), status);
                    let _ = crate::outbox::enqueue(
                        crate::outbox::OutboxKind::Event,
                        payload.clone(),
                    );
                }
            }
            Err(e) => {
                println!("  {} Cloud unreachable ({}), queued to outbox",
                    "⚠".yellow(), e);
                let _ = crate::outbox::enqueue(
                    crate::outbox::OutboxKind::Event,
                    payload.clone(),
                );
            }
        }
    }

    /// Drain the file-backed outbox and retry each payload against the cloud.
    /// 2xx → ack; 4xx → drop (poison); 5xx/network → leave queued.
    fn drain_outbox(&self) {
        let entries = crate::outbox::drain(None);
        if entries.is_empty() {
            return;
        }
        for loaded in entries {
            // Respect per-entry retry backoff: an entry that keeps failing
            // (down cloud, persistent 5xx, or a kind with no endpoint yet)
            // waits progressively longer between retries instead of being
            // re-POSTed every 5s. Nothing is dropped — it resumes the moment
            // the cloud recovers. Explicit `aura` drains skip this gate.
            if crate::outbox::is_backing_off(&loaded.entry) {
                continue;
            }
            let kind = match crate::outbox::OutboxKind::from_str(&loaded.entry.kind) {
                Some(k) => k,
                None => continue,
            };
            let url = match kind {
                crate::outbox::OutboxKind::Event =>
                    format!("{}/api/v1/live/events", self.cloud_url),
                crate::outbox::OutboxKind::Message =>
                    format!("{}/api/v1/live/messages", self.cloud_url),
                crate::outbox::OutboxKind::SyncPush =>
                    format!("{}/api/v1/live/sync/push", self.cloud_url),
                crate::outbox::OutboxKind::Impact =>
                    format!("{}/api/v1/live/impacts", self.cloud_url),
                crate::outbox::OutboxKind::Intent =>
                    format!("{}/api/v1/live/intents", self.cloud_url),
                // Kinds without a stable v1 endpoint yet — leave queued for
                // later waves (W2+) to handle.
                _ => continue,
            };
            match self.client.post(&url)
                .header("Authorization", format!("Bearer {}", self.cloud_token))
                .json(&loaded.entry.body)
                .send()
            {
                Ok(resp) if resp.status().is_success() => {
                    let _ = crate::outbox::ack(&loaded.path);
                }
                Ok(resp) if resp.status().is_client_error() => {
                    // Poison pill — drop so it doesn't block the queue.
                    let _ = crate::outbox::ack(&loaded.path);
                    println!("  {} Outbox entry rejected ({}), dropped",
                        "⚠".yellow(), resp.status());
                }
                _ => {
                    // 5xx / network — leave queued, bump attempt count.
                    let _ = crate::outbox::bump_attempt(&loaded.path);
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
                        // Auto-responder: spawn `claude -p` if enabled, cooldown clear, daily cap not hit
                        crate::responder::maybe_spawn(unread, &self.repo);
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

    /// Auto-pull teammate changes every sync cycle.
    /// Safe functions (not locally modified) are applied immediately.
    /// Dirty functions (locally modified in last 30s) are queued for manual pull.
    fn try_auto_pull(&self) {
        use crate::live_events::DirtyTracker;

        // Pull from mothership
        let functions = match pull_function_bodies() {
            Ok(resp) => {
                match resp["functions"].as_array() {
                    Some(f) if !f.is_empty() => f.clone(),
                    _ => return, // Nothing to pull
                }
            }
            Err(_) => return, // Network error — silent, will retry next cycle
        };

        // Capture the ancestor hashes BEFORE overwriting the cache with the
        // freshly pulled ones — this is the common base a divergence forked
        // from, recorded on any conflict below.
        let parent_hash_cache = load_parent_hash_cache();
        // W3: refresh parent_hash cache for next push.
        update_parent_hash_cache_from_pull(&functions);

        let mut safe_functions = Vec::new();
        let mut queued_count = 0u64;

        for func in &functions {
            let file_path = func["file_path"].as_str().unwrap_or("");
            let function_name = func["function_name"].as_str().unwrap_or("");
            let pushed_by = func["pushed_by"].as_str().unwrap_or("");

            // Skip our own pushes (shouldn't happen due to cursor, but safety check)
            if pushed_by == self.user {
                continue;
            }

            if DirtyTracker::is_dirty(file_path, function_name) {
                // Function is being locally edited AND a teammate pushed a new
                // body for it → a same-node divergence. Queue it for manual
                // resolution and record a durable first-class ConflictedNode
                // (jj-style) so it survives until a human resolves it, rather
                // than being silently merged across the logic boundary.
                queued_count += 1;
                if let (Some(remote_body), Ok(local_src)) =
                    (pulled_body(func), std::fs::read_to_string(file_path))
                {
                    if let Some(local_body) = extract_function_body(&local_src, function_name) {
                        if local_body.trim() != remote_body.trim() {
                            let base_hash = parent_hash_cache
                                .get(&parent_hash_key(file_path, function_name))
                                .cloned()
                                .or_else(|| {
                                    func["content_hash"].as_str().map(|s| s.to_string())
                                })
                                .unwrap_or_default();
                            crate::live_conflicts::record_conflict(
                                file_path,
                                function_name,
                                &base_hash,
                                &local_body,
                                &remote_body,
                                &git_user(),
                                pushed_by,
                            );
                        }
                    }
                }
            } else {
                // Safe to auto-apply
                safe_functions.push(func.clone());
            }
        }

        // Apply safe functions with pull_in_progress lock to prevent watcher feedback
        if !safe_functions.is_empty() {
            let lock_path = ".aura/live/pull_in_progress";
            let _ = std::fs::write(lock_path, "1");

            let (applied, _skipped, conflicts) = apply_pulled_functions(&safe_functions);

            // Remove lock after a short delay so watcher skips the inotify events
            std::thread::sleep(Duration::from_millis(200));
            let _ = std::fs::remove_file(lock_path);

            if applied > 0 {
                println!("  {} Auto-synced {} function{} from teammates",
                    "🔄".cyan(), applied, if applied == 1 { "" } else { "s" });
            }
            for c in &conflicts {
                println!("  {} Conflict: {}", "⚠".yellow(), c);
            }
        }

        // Update pending queue marker
        if queued_count > 0 {
            let marker_dir = std::path::Path::new(".aura/live");
            let _ = std::fs::create_dir_all(marker_dir);
            let _ = std::fs::write(marker_dir.join("sync_pending"), queued_count.to_string());
            println!("  {} {} function{} queued (locally modified) — run `aura pull` to resolve",
                "⏳".yellow(), queued_count, if queued_count == 1 { "" } else { "s" });
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
    // AURA-15: function bodies are un-pushed CODE — only the `diffs` privacy
    // level may ship them off the box. Pull stays ungated (inbound leaks
    // nothing); only the outbound direction is policy-checked.
    let policy = crate::awareness::policy::load();
    if !policy.allows_code_sync() {
        return Err(format!(
            "privacy policy '{}' blocks function-body sync — run `aura radar privacy diffs` to allow sharing un-pushed code",
            policy.as_str()
        ));
    }

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

    // W3: hydrate parent_hash from the last-pulled hash cache so the
    // server can detect stale-parent conflicts.
    let parent_cache = load_parent_hash_cache();
    let functions: Vec<SyncFunctionPayload> = functions.iter().map(|f| {
        let mut out = f.clone();
        if out.parent_hash.is_none() {
            let key = parent_hash_key(&f.file_path, &f.function_name);
            out.parent_hash = parent_cache.get(&key).cloned();
        }
        // W6: if the user has unlocked an org content key, seal the body
        // and clear the plaintext before it leaves the machine. Server
        // stores only ciphertext for E2E orgs.
        if let Some((ct, nonce, ver)) = crate::crypto::maybe_seal_body(out.body.as_bytes()) {
            out.body_ciphertext_b64 = Some(ct);
            out.body_nonce_b64 = Some(nonce);
            out.body_key_version = Some(ver);
            out.body.clear();
        }
        out
    }).collect();

    // W5: run build verification locally before attaching the push.
    // We give it a 30s budget; `skipped` is safe (no matching adapter).
    let build = crate::build_verify::verify(30);
    let force_red = std::env::var("AURA_FORCE_RED").is_ok();

    let payload = json!({
        "repo_full_name": repo,
        "branch": branch,
        "functions": functions,
        "build_status": build.status,
        "build_checks": build.checks,
        "force_red": force_red,
    });

    let client = build_cloud_client();

    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    if resp.status() == reqwest::StatusCode::CONFLICT {
        return Err(
            "build verification red — push blocked. Fix failing checks or set AURA_FORCE_RED=1 to push anyway.".into(),
        );
    }
    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }

    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid JSON response: {}", e))
}

/// Pull function bodies from other developers since last cursor.
pub fn pull_function_bodies() -> Result<serde_json::Value, String> {
    pull_function_bodies_opts(false)
}

/// W5: `allow_red=true` asks the server to include rows the author flagged
/// as a broken build. Default false so `aura pull` keeps your tree green.
pub fn pull_function_bodies_opts(allow_red: bool) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;

    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let repo = repo_name();
    let branch = current_branch();
    let url = format!("{}/api/v1/live/sync/pull?repo={}&branch={}&allow_red={}",
        cloud_url.trim_end_matches('/'), repo, branch, allow_red);

    if std::env::var("AURA_TRACE").is_ok() {
        eprintln!("  [trace] pull GET {}", url);
    }

    let client = build_cloud_client();

    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("Cloud returned {} — {}", status, body));
    }

    let body_text = resp.text()
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    if std::env::var("AURA_TRACE").is_ok() {
        eprintln!("  [trace] pull response ({} bytes): {}",
            body_text.len(),
            &body_text[..body_text.len().min(400)]);
    }
    serde_json::from_str::<serde_json::Value>(&body_text)
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

// ── W3 parent-hash cache ──────────────────────────────────────────────────
// `.aura/live/parent_hashes.json` maps "<file_path>::<fn_name>" → last
// content_hash the server showed us. Written on pull, read on push so
// the server can detect stale-parent conflicts.

fn parent_hash_cache_path() -> std::path::PathBuf {
    std::path::PathBuf::from(".aura/live/parent_hashes.json")
}

pub fn parent_hash_key(file_path: &str, function_name: &str) -> String {
    format!("{}::{}", file_path, function_name)
}

pub fn load_parent_hash_cache() -> std::collections::HashMap<String, String> {
    let path = parent_hash_cache_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    }
}

pub fn save_parent_hash_cache(cache: &std::collections::HashMap<String, String>) {
    let path = parent_hash_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string(cache) {
        let _ = std::fs::write(&path, s);
    }
}

/// Record each pulled function's hash so subsequent pushes can cite it
/// as `parent_hash`.
pub fn update_parent_hash_cache_from_pull(functions: &[serde_json::Value]) {
    let mut cache = load_parent_hash_cache();
    for f in functions {
        let (Some(fp), Some(fn_name), Some(hash)) = (
            f["file_path"].as_str(),
            f["function_name"].as_str(),
            f["content_hash"].as_str(),
        ) else { continue };
        cache.insert(parent_hash_key(fp, fn_name), hash.to_string());
    }
    save_parent_hash_cache(&cache);
}

/// Payload for pushing function bodies to cloud.
#[derive(Clone, Default, serde::Serialize)]
pub struct SyncFunctionPayload {
    pub file_path: String,
    pub function_name: String,
    pub function_kind: String,
    pub content_hash: String,
    pub body: String,
    /// W6: populated when the repo's org has E2E enabled and the user has
    /// unlocked their wrapped content key. When present, `body` is empty
    /// and the server stores only ciphertext.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_ciphertext_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_nonce_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_key_version: Option<i32>,
    /// W3: hash the author based this edit on. Populated from the last
    /// pulled hash cache (`.aura/live/parent_hashes.json`) so the server
    /// can detect stale-parent conflicts on `sync_push`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_hash: Option<String>,
}

/// Extract the usable function body from a pulled record: prefer ciphertext if
/// present and the org content key is cached (E2E orgs), else the plaintext
/// `body`. Returns None when neither is available/usable.
pub fn pulled_body(func: &serde_json::Value) -> Option<String> {
    let decrypted: Option<String> = func["body_ciphertext_b64"].as_str().and_then(|ct_b64| {
        let nonce_b64 = func["body_nonce_b64"].as_str()?;
        let key_ver = func["body_key_version"].as_i64()? as i32;
        crate::crypto::decrypt_for_active(ct_b64, nonce_b64, key_ver).ok()
    });
    match decrypted {
        Some(s) => Some(s),
        None => match func["body"].as_str() {
            Some(b) if !b.is_empty() => Some(b.to_string()),
            _ => None,
        },
    }
}

/// Contain a peer-supplied file path before we ever write it to disk.
///
/// Sync and CRDT payloads carry a `file_path` chosen by a remote peer. Writing
/// that path verbatim let a malicious peer target `../../.git/hooks/pre-commit`
/// (arbitrary code execution on the victim's next commit) or any absolute path
/// outside the repo. This clamps the path to the repo working tree:
///   * absolute paths, drive prefixes and UNC roots are refused;
///   * any `..` component is refused (no traversal — belt-and-suspenders with
///     the final `starts_with` check below);
///   * anything under a `.git` directory is refused (hooks/config = RCE);
///   * the lexically-joined result must still resolve inside the repo root.
///
/// Returns the safe absolute path to write, or `None` if the path must be
/// rejected (the caller counts it as skipped). The path need not exist yet, so
/// this uses lexical normalisation rather than `canonicalize` on the target.
pub(crate) fn contain_sync_path(file_path: &str) -> Option<std::path::PathBuf> {
    use std::path::{Component, Path, PathBuf};

    let raw = Path::new(file_path);
    if raw.is_absolute() {
        return None;
    }
    // Live sync runs with the repo root as the working directory.
    let root = std::env::current_dir().ok()?.canonicalize().ok()?;

    let mut normalized = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(segment) => {
                if segment.eq_ignore_ascii_case(".git") {
                    return None;
                }
                normalized.push(segment);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    if normalized.as_os_str().is_empty() {
        return None;
    }

    let full = root.join(&normalized);
    if !full.starts_with(&root) {
        return None;
    }
    Some(full)
}

/// Apply pulled function bodies to local files using AST-level splice.
/// Returns (applied_count, skipped_count, conflicts).
///
/// When whole-file CRDT is the disk writer (`crdt_daemon::live_crdt_enabled`)
/// this runs in *detection-only* mode: the CRDT daemon already materialises
/// teammate edits, so we must not splice/write the same bytes — that double
/// write is the two-writer clobber. (Same-function semantic conflicts are
/// surfaced as durable ConflictedNodes from `try_auto_pull`'s dirty branch,
/// where the local node is known to have diverged.) Assumes peers run the same
/// unified engine; a peer that only pushes function bodies and never whole-file
/// CRDT ops would not have its edits applied in this mode.
pub fn apply_pulled_functions(
    functions: &[serde_json::Value],
) -> (usize, usize, Vec<String>) {
    let crdt_writer = crate::crdt_daemon::live_crdt_enabled();

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
        let new_body_owned = match pulled_body(func) {
            Some(b) => b,
            None => { skipped += 1; continue; }
        };
        let new_body: &str = &new_body_owned;
        let pushed_by = func["pushed_by"].as_str().unwrap_or("unknown");

        // Detection-only when CRDT owns the bytes: the daemon already wrote
        // this edit. Count it as synced for the status line, never splice.
        if crdt_writer {
            applied += 1;
            continue;
        }

        // Contain the peer-supplied path before any filesystem write: reject
        // absolute paths, `..` traversal, and anything under `.git` (writing
        // `.git/hooks/*` would be code execution on the victim's next commit).
        let safe_path = match contain_sync_path(file_path) {
            Some(p) => p,
            None => {
                skipped += 1;
                continue;
            }
        };
        let path = safe_path.as_path();
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
/// Public wrapper for splice_function — returns Ok(new_content) or Err(reason).
pub fn splice_function_public(file_content: &str, function_name: &str, new_body: &str) -> Result<String, String> {
    match splice_function(file_content, function_name, new_body) {
        SpliceResult::Replaced(content) => Ok(content),
        SpliceResult::NotFound => Err(format!("Function '{}' not found in file", function_name)),
        SpliceResult::Conflict(reason) => Err(reason),
    }
}

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

// ─── Mothership Connectivity Check ─────────────────────────────────────────

/// Quick connectivity probe. Returns (reachable, latency_ms, peer_count).
pub fn check_mothership() -> (bool, u64, u64) {
    let config = ConfigManager::load();
    let token = match config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok()) {
        Some(t) => t,
        None => return (false, 0, 0),
    };
    let cloud_url = match config.cloud_url {
        Some(ref u) if !u.is_empty() => u.clone(),
        _ => return (false, 0, 0),
    };
    let client = build_cloud_client();
    let start = std::time::Instant::now();
    let url = format!("{}/api/v1/live/presence?repo={}", cloud_url.trim_end_matches('/'), repo_name());
    match client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .timeout(Duration::from_secs(3))
        .send() {
        Ok(resp) if resp.status().is_success() => {
            let ms = start.elapsed().as_millis() as u64;
            let peers = resp.json::<serde_json::Value>()
                .ok()
                .and_then(|j| j["developers"].as_array().map(|a| a.len() as u64))
                .unwrap_or(0);
            (true, ms, peers)
        }
        _ => (false, 0, 0),
    }
}

/// Print a one-line mothership status. Returns true if online.
pub fn print_mothership_status_line() -> bool {
    let config = ConfigManager::load();
    let has_token = config.cloud_api_token.is_some()
        || std::env::var("AURA_CLOUD_TOKEN").is_ok();
    if !has_token || config.cloud_url.is_none() {
        return false;
    }
    let (online, ms, peers) = check_mothership();
    if online {
        println!("  {} Mothership: {} ({}ms, {} peer{})",
            "●".green(), "online".green().bold(), ms, peers,
            if peers == 1 { "" } else { "s" });
        true
    } else {
        println!("  {} Mothership: {} (buffering locally)",
            "●".red(), "offline".red().bold());
        false
    }
}

// ─── Sentinel Zones (P2P) ──────────────────────────────────────────────────

pub fn create_remote_zone(patterns: &[String], mode: &str, label: Option<&str>) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/zones", cloud_url.trim_end_matches('/'));

    let mut body = json!({
        "repo_full_name": repo_name(),
        "patterns": patterns,
        "mode": mode,
    });
    if let Some(l) = label {
        body["label"] = json!(l);
    }

    let client = build_cloud_client();
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

pub fn fetch_remote_zones() -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/zones?repo={}", cloud_url.trim_end_matches('/'), repo_name());

    let client = build_cloud_client();
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

pub fn check_remote_zone(file_path: &str) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/zones/check?repo={}&file_path={}",
        cloud_url.trim_end_matches('/'), repo_name(), file_path);

    let client = build_cloud_client();
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

pub fn delete_remote_zone(zone_id: &str) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/zones/{}", cloud_url.trim_end_matches('/'), zone_id);

    let client = build_cloud_client();
    let resp = client.delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

// ─── Team Knowledge (P2P) ──────────────────────────────────────────────────

pub fn store_team_knowledge(question: &str, answer: &str, category: Option<&str>, tags: &[String], source: &str) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/knowledge", cloud_url.trim_end_matches('/'));

    let body = json!({
        "repo_full_name": repo_name(),
        "category": category.unwrap_or("general"),
        "question": question,
        "answer": answer,
        "source": source,
        "tags": tags,
    });

    let client = build_cloud_client();
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

pub fn query_team_knowledge(search: Option<&str>, category: Option<&str>, limit: usize) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());

    let mut url = format!("{}/api/v1/live/knowledge?repo={}&limit={}",
        cloud_url.trim_end_matches('/'), repo_name(), limit);
    if let Some(q) = search { url.push_str(&format!("&search={}", q)); }
    if let Some(c) = category { url.push_str(&format!("&category={}", c)); }

    let client = build_cloud_client();
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

pub fn upvote_team_knowledge(id: &str) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/knowledge/{}/upvote", cloud_url.trim_end_matches('/'), id);

    let client = build_cloud_client();
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

// ─── Cross-Branch Merge ────────────────────────────────────────────────────

/// Pull all function bodies from a different branch for merge.
pub fn pull_branch_for_merge(source_branch: &str) -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/merge?repo={}&source_branch={}",
        cloud_url.trim_end_matches('/'), repo_name(), source_branch);

    let client = build_cloud_client();
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Cloud returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

/// Merge result for a single function.
#[derive(Debug)]
pub enum MergeAction {
    /// Function only exists on source branch — auto-apply (new function)
    Add { file_path: String, function_name: String, body: String, pushed_by: String },
    /// Function exists on both, same content — skip
    Identical { file_path: String, function_name: String },
    /// Function exists on both, different content — conflict
    Conflict { file_path: String, function_name: String, local_body: String, remote_body: String, pushed_by: String },
    /// Function only exists locally — no action (local-only)
    LocalOnly { file_path: String, function_name: String },
}

/// Compare source branch functions against local files and classify each.
pub fn classify_merge(remote_functions: &[serde_json::Value]) -> Vec<MergeAction> {
    let mut actions = Vec::new();

    for func in remote_functions {
        let file_path = func["file_path"].as_str().unwrap_or("").to_string();
        let function_name = func["function_name"].as_str().unwrap_or("").to_string();
        let remote_body = func["body"].as_str().unwrap_or("").to_string();
        let remote_hash = func["content_hash"].as_str().unwrap_or("").to_string();
        let pushed_by = func["pushed_by"].as_str().unwrap_or("?").to_string();

        // Read local file and try to extract the same function
        if let Ok(local_source) = std::fs::read_to_string(&file_path) {
            if let Some(local_body) = extract_function_body(&local_source, &function_name) {
                // Function exists locally — compare
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(local_body.trim().as_bytes());
                let local_hash = hex::encode(hasher.finalize());

                if local_hash == remote_hash || local_body.trim() == remote_body.trim() {
                    actions.push(MergeAction::Identical { file_path, function_name });
                } else {
                    actions.push(MergeAction::Conflict {
                        file_path, function_name,
                        local_body, remote_body, pushed_by,
                    });
                }
            } else {
                // Function doesn't exist locally — it's new from source branch
                actions.push(MergeAction::Add {
                    file_path, function_name, body: remote_body, pushed_by,
                });
            }
        } else {
            // File doesn't exist locally — new file + function from source branch
            actions.push(MergeAction::Add {
                file_path, function_name, body: remote_body, pushed_by,
            });
        }
    }

    actions
}

// ─── Scaffold Push/Pull ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ScaffoldPushPayload {
    pub file_path: String,
    pub content_hash: String,
    pub content: String,
    pub file_type: String,
}

pub fn push_scaffolds(scaffolds: &[ScaffoldPushPayload]) -> Result<serde_json::Value, String> {
    if scaffolds.is_empty() { return Ok(json!({"pushed": 0})); }

    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/scaffolds/push", cloud_url.trim_end_matches('/'));

    let payload = json!({
        "repo_full_name": repo_name(),
        "branch": current_branch(),
        "scaffolds": scaffolds,
    });

    let client = build_cloud_client();
    let resp = client.post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

pub fn pull_scaffolds_from_team() -> Result<serde_json::Value, String> {
    let config = ConfigManager::load();
    let token = config.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "No cloud token configured".to_string())?;
    let cloud_url = config.cloud_url
        .unwrap_or_else(|| "https://auravcs.com".to_string());
    let url = format!("{}/api/v1/live/scaffolds/pull?repo={}&branch={}",
        cloud_url.trim_end_matches('/'), repo_name(), current_branch());

    let client = build_cloud_client();
    let resp = client.get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("Cloud unreachable: {}", e))?;
    resp.json::<serde_json::Value>()
        .map_err(|e| format!("Invalid response: {}", e))
}

/// Public wrapper for repo_name from live_events (for use from main.rs).
pub fn repo_name_from_cwd() -> String {
    repo_name()
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

/// Read the tail of `.aura/intent_log.jsonl` and return the most recent
/// prose intent — anything that's not the AST-diff fallback shape
/// ("N added/modified/removed: ..."). Returns None if the file is missing,
/// no entries exist within `max_age_secs`, or every entry is the
/// auto-generated summary shape. Used by `sync_events` to ensure dashboard
/// Intent Log rows render human-written narrative instead of AST diffs.
#[cfg(test)]
mod intent_tests {
    use super::read_latest_intent_prose;
    use std::io::Write;

    fn setup_tempdir() -> std::path::PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "aura-intent-prose-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(tmp.join(".aura")).unwrap();
        tmp
    }

    fn run_in<P: AsRef<std::path::Path>, F: FnOnce()>(dir: P, f: F) {
        let prev = std::env::current_dir().unwrap();
        std::env::set_current_dir(dir.as_ref()).unwrap();
        f();
        std::env::set_current_dir(prev).unwrap();
    }

    #[test]
    fn returns_most_recent_prose_skipping_fallback_shape() {
        let tmp = setup_tempdir();
        let path = tmp.join(".aura/intent_log.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        // Old prose entry (still within window).
        writeln!(
            f,
            r#"{{"intent":"Rewired auth middleware","timestamp":{}}}"#,
            now - 60
        )
        .unwrap();
        // Newer fallback-shape summary — must be skipped.
        writeln!(
            f,
            r#"{{"intent":"1 modified: foo in bar.rs","timestamp":{}}}"#,
            now - 10
        )
        .unwrap();
        drop(f);

        run_in(&tmp, || {
            let got = read_latest_intent_prose(30 * 60);
            assert_eq!(got.as_deref(), Some("Rewired auth middleware"));
        });
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn returns_none_when_freshest_entry_is_stale() {
        let tmp = setup_tempdir();
        let path = tmp.join(".aura/intent_log.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(
            f,
            r#"{{"intent":"Very old prose","timestamp":100}}"#
        )
        .unwrap();
        drop(f);

        run_in(&tmp, || {
            assert!(read_latest_intent_prose(60).is_none());
        });
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn returns_none_when_log_missing() {
        let tmp = setup_tempdir();
        run_in(&tmp, || {
            assert!(read_latest_intent_prose(3600).is_none());
        });
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

pub fn read_latest_intent_prose(max_age_secs: u64) -> Option<String> {
    use std::io::{BufRead, BufReader};
    let path = ".aura/intent_log.jsonl";
    let file = std::fs::File::open(path).ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    let fallback_shape =
        regex::Regex::new(r"^\s*\d+\s+(added|modified|removed|changed|deleted)").ok()?;

    let lines: Vec<String> = BufReader::new(file).lines().filter_map(|l| l.ok()).collect();
    for line in lines.iter().rev() {
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ts = v["timestamp"].as_u64().unwrap_or(0);
        if ts > 0 && now.saturating_sub(ts) > max_age_secs {
            return None; // freshest entry already stale → no override
        }
        let intent = v["intent"].as_str().unwrap_or("").trim().to_string();
        if intent.is_empty() || fallback_shape.is_match(&intent) {
            continue;
        }
        return Some(intent);
    }
    None
}
