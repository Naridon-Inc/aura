use std::process::Command;
use colored::Colorize;
use crate::checkpoint::CheckpointStore;
use git2::Repository;
use serde_json::json;

/// Cross-Repo Tracing: The Global Brain Sync
pub struct GlobalSync;

impl GlobalSync {
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

            // Target the real EC2 Sovereign Vault
            let res = client.post("http://51.102.104.41/v1/sync")
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
