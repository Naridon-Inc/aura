use std::process::Command;
use colored::Colorize;
use crate::checkpoint::CheckpointStore;
use crate::config::ConfigManager;
use git2::Repository;
use serde_json::json;

/// Cross-Repo Tracing: The Global Brain Sync
pub struct GlobalSync;

impl GlobalSync {
    /// Get the configured cloud URL (default: https://api.auravcs.com)
    fn cloud_url() -> String {
        let config = ConfigManager::load();
        config.cloud_url
            .unwrap_or_else(|| "https://api.auravcs.com".to_string())
            .trim_end_matches('/')
            .to_string()
    }

    /// Get the cloud API token if configured
    fn cloud_token() -> Option<String> {
        let config = ConfigManager::load();
        config.cloud_api_token
            .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
    }

    /// Build an authenticated HTTP client for cloud API
    fn cloud_client() -> reqwest::blocking::Client {
        reqwest::blocking::Client::new()
    }

    /// Sync checkpoints to Aura Cloud
    pub fn sync_checkpoints(repo_url: &str) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => {
                // Fall back to legacy sync
                Self::sync_remote(repo_url);
                return;
            }
        };

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(e) => {
                println!("{} Failed to open local repository: {}", "✗".red(), e);
                return;
            }
        };

        let checkpoints = match CheckpointStore::get_all_checkpoints(&repo) {
            Ok(c) => c,
            Err(e) => {
                println!("{} Failed to read checkpoints: {}", "✗".red(), e);
                return;
            }
        };

        if checkpoints.is_empty() {
            println!("  {} No checkpoints to sync", "↳".dimmed());
            return;
        }

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();

        let checkpoint_data: Vec<serde_json::Value> = checkpoints.iter().map(|cp| {
            json!({
                "commit_id": cp.id,
                "branch": null,
                "risk_score": 0,
                "risk_label": "Clean",
                "summary": cp.intent,
                "ast_node_count": cp.ast_nodes.len(),
                "data": {
                    "agent_id": cp.agent_id,
                    "timestamp": cp.timestamp,
                }
            })
        }).collect();

        let payload = json!({
            "repo_full_name": repo_url,
            "checkpoints": checkpoint_data,
        });

        println!("  {} Syncing {} checkpoints to Aura Cloud...", "↳".dimmed(), checkpoints.len());

        let res = client
            .post(format!("{}/api/v1/sync/checkpoints", cloud_url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();

        match res {
            Ok(response) if response.status().is_success() => {
                println!("{} Checkpoints synced to Aura Cloud.", "✓".green().bold());
            }
            Ok(response) => {
                println!("{} Cloud sync failed ({}). Data saved locally.", "⚠️".yellow(), response.status());
            }
            Err(e) => {
                println!("{} Cloud sync error: {}. Operating offline.", "⚠️".yellow(), e);
            }
        }
    }

    /// Sync a review result to Aura Cloud
    pub fn sync_review(repo_url: &str, review_json: &serde_json::Value) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return,
        };

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();

        let payload = json!({
            "repo_full_name": repo_url,
            "reviews": [review_json],
        });

        let _ = client
            .post(format!("{}/api/v1/sync/reviews", cloud_url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();
    }

    /// Sync session data to Aura Cloud
    pub fn sync_session(repo_url: &str, session_json: &serde_json::Value) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return,
        };

        let cloud_url = Self::cloud_url();
        let client = Self::cloud_client();

        let payload = json!({
            "repo_full_name": repo_url,
            "sessions": [session_json],
        });

        let _ = client
            .post(format!("{}/api/v1/sync/sessions", cloud_url))
            .header("Authorization", format!("Bearer {}", token))
            .json(&payload)
            .send();
    }

    /// Fire a POST to /api/v2/{thing} with a JSON body. Silent on failure.
    fn post_v2(path: &str, body: serde_json::Value) {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => return,
        };
        let config = ConfigManager::load();
        if !config.sync_enabled {
            return;
        }
        let url = format!("{}/api/v2/{}", Self::cloud_url(), path.trim_start_matches('/'));
        let client = Self::cloud_client();
        let _ = client
            .post(url)
            .header("Authorization", format!("Bearer {}", token))
            .json(&body)
            .timeout(std::time::Duration::from_secs(5))
            .send();
    }

    /// Push a snapshot record (content hash, not raw content).
    pub fn push_snapshot(
        file_path: &str,
        content_sha256: &str,
        size_bytes: u64,
        trigger: &str,
        agent_id: &str,
        repo_full_name: Option<&str>,
    ) {
        let body = json!({
            "file_path": file_path,
            "content_sha256": content_sha256,
            "size_bytes": size_bytes as i64,
            "trigger": trigger,
            "agent_id": agent_id,
            "repo_full_name": repo_full_name,
        });
        Self::post_v2("snapshots", body);
    }

    /// Push a handover record.
    pub fn push_handover(session_id: Option<&str>, agent_name: &str, summary: &str, token_count: u64) {
        let body = json!({
            "session_id": session_id,
            "agent_name": agent_name,
            "summary": summary,
            "token_count": token_count as i32,
        });
        Self::post_v2("handovers", body);
    }

    /// Push a plan record.
    pub fn push_plan(
        objective: &str,
        waves: serde_json::Value,
        status: &str,
        repo_full_name: Option<&str>,
    ) {
        let body = json!({
            "objective": objective,
            "waves": waves,
            "status": status,
            "repo_full_name": repo_full_name,
        });
        Self::post_v2("plans", body);
    }

    /// Push an orchestration start/end record.
    pub fn push_orchestration(
        mode: &str,
        agents: serde_json::Value,
        status: &str,
        session_id: Option<&str>,
        ended: bool,
    ) {
        let body = json!({
            "mode": mode,
            "agents": agents,
            "status": status,
            "session_id": session_id,
            "ended": ended,
        });
        Self::post_v2("orchestrations", body);
    }

    /// Push a memory entry.
    pub fn push_memory_entry(
        kind: &str,
        title: Option<&str>,
        body_text: &str,
        repo_full_name: Option<&str>,
    ) {
        let body = json!({
            "kind": kind,
            "title": title,
            "body": body_text,
            "repo_full_name": repo_full_name,
        });
        Self::post_v2("memory", body);
    }

    /// Push a zone claim.
    pub fn push_zone(zone_path: &str, claim_type: &str) {
        let body = json!({
            "zone_path": zone_path,
            "claim_type": claim_type,
            "status": "active",
        });
        Self::post_v2("zones", body);
    }

    /// Backfill existing .aura/snapshots/*.json to the cloud. Returns count pushed.
    pub fn backfill_snapshots(repo_full_name: Option<&str>) -> usize {
        let token = match Self::cloud_token() {
            Some(t) => t,
            None => {
                println!("  {} No cloud token configured — skipping backfill", "↳".dimmed());
                return 0;
            }
        };
        let config = ConfigManager::load();
        if !config.sync_enabled {
            println!("  {} Cloud sync disabled — skipping backfill", "↳".dimmed());
            return 0;
        }

        let dir = std::path::Path::new(".aura/snapshots");
        if !dir.exists() {
            return 0;
        }

        let mut pushed = 0usize;
        let url = format!("{}/api/v2/snapshots", Self::cloud_url());
        let client = Self::cloud_client();

        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return 0,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e != "json").unwrap_or(true) {
                continue;
            }
            let raw = match std::fs::read_to_string(&path) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let file_path = parsed["file_path"].as_str().unwrap_or("");
            let content = parsed["content"].as_str().unwrap_or("");
            if file_path.is_empty() {
                continue;
            }
            let sha = {
                use sha2::{Digest, Sha256};
                let mut h = Sha256::new();
                h.update(content.as_bytes());
                format!("{:x}", h.finalize())
            };
            let trigger = parsed["trigger"].as_str().unwrap_or("backfill");
            let agent_id = parsed["agent_id"].as_str().unwrap_or("cli");

            let body = json!({
                "file_path": file_path,
                "content_sha256": sha,
                "size_bytes": content.len() as i64,
                "trigger": trigger,
                "agent_id": agent_id,
                "repo_full_name": repo_full_name,
            });

            let res = client
                .post(&url)
                .header("Authorization", format!("Bearer {}", token))
                .json(&body)
                .timeout(std::time::Duration::from_secs(10))
                .send();

            if let Ok(resp) = res {
                if resp.status().is_success() {
                    pushed += 1;
                }
            }
        }

        pushed
    }

    /// Legacy sync: push to the old endpoint and git microservice
    pub fn sync_remote(repo_url: &str) {
        println!("{} {} {}", "🌐".bold(), "Aura Global Brain: Syncing semantic checkpoints from".bold().blue(), repo_url.yellow());

        let repo = match Repository::open(".") {
            Ok(r) => r,
            Err(e) => {
                println!("{} Failed to open local repository: {}", "✗".red(), e);
                return;
            }
        };

        let checkpoints = match CheckpointStore::get_all_checkpoints(&repo) {
            Ok(c) => c,
            Err(e) => {
                println!("{} Failed to read checkpoints: {}", "✗".red(), e);
                return;
            }
        };

        if let Some(latest) = checkpoints.first() {
            println!("  {} Pushing local Merkle-Graph to Sovereign Vault...", "↳".dimmed());

            let client = reqwest::blocking::Client::new();
            let payload = json!({
                "repo_id": repo_url,
                "nodes": latest.ast_nodes.iter().map(|n| {
                    json!({
                        "node_id": n.node_id,
                        "content_hash": n.content_hash,
                        "identifier": n.identifier
                    })
                }).collect::<Vec<_>>()
            });

            let cloud_url = Self::cloud_url();
            let res = client.post(format!("{}/v1/sync", cloud_url))
                .json(&payload)
                .send();

            match res {
                Ok(response) if response.status().is_success() => {
                    println!("{} Local brain synced to cloud vault successfully.", "✓".green().bold());
                },
                _ => {
                    println!("{} Failed to sync with cloud vault. Operating in offline mode.", "⚠️".yellow());
                }
            }
        }

        // Standard Git Sync
        let safe_remote_name = repo_url.replace("https://", "").replace("http://", "").replace("/", "_");

        println!("  {} Connecting to remote Git microservice...", "↳".dimmed());
        let _ = Command::new("git")
            .args(["remote", "add", &safe_remote_name, repo_url])
            .output();

        println!("  {} Fetching remote semantic metadata...", "↳".dimmed());
        let _ = Command::new("git")
            .args(["fetch", &safe_remote_name, "refs/heads/aura/checkpoints/v1:refs/remotes/aura_global/checkpoints/v1"])
            .output();

        println!("{} Merkle-Graph extended. External DependencyURIs will now resolve locally.", "✓".green().bold());
    }
}
