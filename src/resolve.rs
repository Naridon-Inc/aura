//! `aura resolve` — drain open function conflicts from the cloud.
//!
//! Flow (plan W3.2):
//!   1. GET /api/v2/conflicts?resolved=false → open conflicts for the caller's org.
//!   2. --list prints them; --interactive walks each one with dialoguer.
//!   3. POST /api/v2/conflicts/{id}/resolve with {resolution:"local"|"remote"|"merged"}.
//!
//! The full 3-way merge UX (side-by-side, hunk-picker) is deferred; we
//! start with the three-way choice, since W4 CRDT makes this rare anyway.

use colored::Colorize;
use dialoguer::{theme::ColorfulTheme, Select};
use serde::Deserialize;

use crate::config::ConfigManager;

#[derive(Debug, Deserialize)]
struct ConflictSummary {
    id: String,
    branch: String,
    file_path: String,
    function_name: String,
    #[serde(default)]
    resolved: bool,
    #[serde(default)]
    created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ConflictDetail {
    id: String,
    #[allow(dead_code)] branch: String,
    file_path: String,
    function_name: String,
    local_body: String,
    remote_body: String,
    #[serde(default)] local_hash: Option<String>,
    #[serde(default)] remote_hash: Option<String>,
}

fn client() -> Result<(reqwest::blocking::Client, String, String), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected — run `aura connect`")?;
    let token = cfg.cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token")?;
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http: {}", e))?;
    Ok((c, url, token))
}

fn list_open() -> Result<Vec<ConflictSummary>, String> {
    let (c, url, token) = client()?;
    let resp = c
        .get(format!("{}/api/v2/conflicts?resolved=false", url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
    let arr = body["conflicts"].as_array().cloned().unwrap_or_default();
    Ok(arr.into_iter()
        .filter_map(|v| serde_json::from_value::<ConflictSummary>(v).ok())
        .collect())
}

fn fetch_detail(id: &str) -> Result<ConflictDetail, String> {
    let (c, url, token) = client()?;
    let resp = c
        .get(format!("{}/api/v2/conflicts/{}", url, id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.json().map_err(|e| format!("parse: {}", e))
}

fn post_resolution(id: &str, resolution: &str, body: Option<&str>) -> Result<(), String> {
    let (c, url, token) = client()?;
    let payload = serde_json::json!({
        "resolution": resolution,
        "resolved_body": body,
    });
    let resp = c
        .post(format!("{}/api/v2/conflicts/{}/resolve", url, id))
        .header("Authorization", format!("Bearer {}", token))
        .json(&payload)
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

pub fn run(list_only: bool, interactive: bool) -> Result<(), String> {
    let conflicts = list_open()?;
    if conflicts.is_empty() {
        println!("{} No open conflicts.", "✓".green());
        return Ok(());
    }

    if list_only || !interactive {
        println!("{} {} open conflicts:", "⚠".yellow(), conflicts.len());
        for (i, c) in conflicts.iter().enumerate() {
            println!(
                "  {}. [{}] {} :: {} on {}",
                i + 1,
                crate::text::clip(&c.id, 8),
                c.file_path,
                c.function_name.cyan(),
                c.branch,
            );
        }
        if !interactive {
            println!();
            println!("  {} Run `aura resolve --interactive` to pick a winner per conflict.",
                "→".dimmed());
        }
        if list_only {
            return Ok(());
        }
    }

    for summary in &conflicts {
        println!();
        println!("{} Conflict on {} :: {}",
            "⚠".yellow().bold(),
            summary.file_path.bold(),
            summary.function_name.cyan(),
        );

        let detail = match fetch_detail(&summary.id) {
            Ok(d) => d,
            Err(e) => {
                println!("  {} skipping ({})", "✗".red(), e);
                continue;
            }
        };

        println!("  {} local  ({}): {} chars",
            "•".dimmed(),
            detail.local_hash.as_deref().unwrap_or("?"),
            detail.local_body.len());
        println!("  {} remote ({}): {} chars",
            "•".dimmed(),
            detail.remote_hash.as_deref().unwrap_or("?"),
            detail.remote_body.len());

        let choice = Select::with_theme(&ColorfulTheme::default())
            .with_prompt(format!("Pick winner for {}", detail.function_name))
            .items(&["Keep local (server's current)", "Accept remote (incoming)", "Skip"])
            .default(0)
            .interact()
            .map_err(|e| format!("prompt: {}", e))?;

        let resolution = match choice {
            0 => "local",
            1 => "remote",
            _ => continue,
        };

        match post_resolution(&detail.id, resolution, None) {
            Ok(_) => println!("  {} resolved as {}", "✓".green(), resolution),
            Err(e) => println!("  {} failed ({})", "✗".red(), e),
        }
    }

    Ok(())
}
