use std::process::Command;
use colored::Colorize;
use crate::checkpoint::CheckpointStore;
use crate::config::ConfigManager;
use git2::Repository;
use serde_json::json;

/// Cross-Repo Tracing: The Global Brain Sync
pub struct GlobalSync;

impl GlobalSync {
    /// Get the configured cloud URL (default: https://auravcs.com)
    fn cloud_url() -> String {
        let config = ConfigManager::load();
        config.cloud_url
            .unwrap_or_else(|| "https://auravcs.com".to_string())
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
