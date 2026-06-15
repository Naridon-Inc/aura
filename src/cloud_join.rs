//! `aura join-team <org-slug>` — zero-config cloud team onboarding.
//!
//! Flow (plan W1.1):
//!   1. Require `cloud_api_token` + `cloud_url` (error → run `aura connect` first).
//!   2. GET /api/v2/orgs/{slug}/repos to validate membership + pick a repo_id.
//!   3. If --repo omitted, match cwd's `git remote get-url origin` → github_full_name.
//!   4. Persist the repo into `team_repos` + map to the org slug in `team_repos_cloud`.
//!   5. Call `/api/v2/repos/{id}/bootstrap` to hydrate `.aura/` (function bodies,
//!      recent intents, zones, teammates).
//!   6. Print summary. (Daemon auto-spawn is wired separately in W1.4.)
//!
//! The existing mothership `aura join <token>` path is untouched.

use colored::Colorize;
use crate::config::ConfigManager;
use crate::live_events::repo_name;

pub fn join_team(org_slug: &str, repo_override: Option<&str>) -> Result<(), String> {
    let mut config = ConfigManager::load();

    let cloud_url = config
        .cloud_url
        .clone()
        .ok_or_else(|| "no cloud_url — run `aura connect` first".to_string())?;
    let token = config
        .cloud_api_token
        .clone()
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or_else(|| "no cloud_api_token — run `aura connect` first".to_string())?;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    // 1. Fetch org repos to confirm membership + resolve repo_id.
    let repos_url = format!("{}/api/v2/orgs/{}/repos", cloud_url, org_slug);
    let resp = client
        .get(&repos_url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("cloud unreachable: {}", e))?;

    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(format!(
            "not a member of '{}' (HTTP {}). Ask an admin to invite your account.",
            org_slug, status
        ));
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("org '{}' not found on cloud", org_slug));
    }
    if !status.is_success() {
        return Err(format!("cloud error {}: {}", status, repos_url));
    }

    let body: serde_json::Value = resp.json().map_err(|e| format!("parse orgs/repos: {}", e))?;
    let repos = body["repos"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    if repos.is_empty() {
        return Err(format!(
            "org '{}' has no repos on cloud yet. Push one via `aura save` first.",
            org_slug
        ));
    }

    // 2. Pick repo_id: --repo override, else match current git remote.
    let want_repo = repo_override
        .map(|s| s.to_string())
        .unwrap_or_else(repo_name);

    let matched = repos.iter().find(|r| {
        r["github_full_name"]
            .as_str()
            .map(|s| s.eq_ignore_ascii_case(&want_repo))
            .unwrap_or(false)
    });

    let repo_obj = match matched {
        Some(r) => r,
        None => {
            let available: Vec<String> = repos
                .iter()
                .filter_map(|r| r["github_full_name"].as_str().map(String::from))
                .collect();
            return Err(format!(
                "repo '{}' not in org '{}'. Available: {}",
                want_repo,
                org_slug,
                available.join(", ")
            ));
        }
    };

    let repo_id = repo_obj["id"]
        .as_str()
        .ok_or_else(|| "repo missing id".to_string())?
        .to_string();
    let repo_full = repo_obj["github_full_name"]
        .as_str()
        .unwrap_or(&want_repo)
        .to_string();

    // 3. Persist membership locally.
    if !config.team_repos.contains(&repo_full) {
        config.team_repos.push(repo_full.clone());
    }
    config
        .team_repos_cloud
        .insert(repo_full.clone(), org_slug.to_string());
    config.sync_enabled = true;
    ConfigManager::save(&config).map_err(|e| format!("save config: {}", e))?;

    println!(
        "{} Joined team {} ({})",
        "✓".green().bold(),
        org_slug.cyan(),
        repo_full.dimmed()
    );

    // 4. Bootstrap — hydrate .aura/ from cloud.
    match bootstrap(&client, &cloud_url, &token, &repo_id) {
        Ok(summary) => {
            println!(
                "  {} Bootstrap: {} functions, {} intents, {} zones, {} teammates online",
                "☁".cyan(),
                summary.functions,
                summary.intents,
                summary.zones,
                summary.teammates
            );
        }
        Err(e) => {
            println!("  {} Bootstrap failed ({}) — will retry on next sync", "⚠".yellow(), e);
        }
    }

    println!(
        "  {} Run `aura live watch` to see teammates in real time.",
        "→".dimmed()
    );

    Ok(())
}

struct BootstrapSummary {
    functions: usize,
    intents: usize,
    zones: usize,
    teammates: usize,
}

fn bootstrap(
    client: &reqwest::blocking::Client,
    cloud_url: &str,
    token: &str,
    repo_id: &str,
) -> Result<BootstrapSummary, String> {
    let url = format!("{}/api/v2/repos/{}/bootstrap", cloud_url, repo_id);
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;

    // Persist the raw payload under .aura/bootstrap.json for inspection + future
    // consumers. Actual AST rehydration is handled by the existing sync pipeline.
    let dir = std::path::Path::new(".aura");
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("bootstrap.json");
    let pretty = serde_json::to_vec_pretty(&data).map_err(|e| format!("serialize: {}", e))?;
    std::fs::write(&path, pretty).map_err(|e| format!("write: {}", e))?;

    Ok(BootstrapSummary {
        functions: data["function_bodies"].as_array().map(|a| a.len()).unwrap_or(0),
        intents: data["recent_intents"].as_array().map(|a| a.len()).unwrap_or(0),
        zones: data["zones"].as_array().map(|a| a.len()).unwrap_or(0),
        teammates: data["teammates"].as_array().map(|a| a.len()).unwrap_or(0),
    })
}
