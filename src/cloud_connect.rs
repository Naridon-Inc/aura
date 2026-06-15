use crate::config::ConfigManager;
use colored::Colorize;
use serde::Deserialize;
use std::time::{Duration, Instant};

const DEFAULT_CLOUD: &str = "https://auravcs.com";

#[derive(Debug, Deserialize)]
struct StartResp {
    user_code: String,
    device_code: String,
    verify_url: String,
    expires_in: u64,
    poll_interval: u64,
}

#[derive(Debug, Deserialize)]
struct PollResp {
    status: String,
    token: Option<String>,
    user: Option<String>,
    org_slug: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeResp {
    user: Option<serde_json::Value>,
    // Server returns `organizations`; older builds emitted `orgs`. Accept
    // either so `aura whoami` works against both.
    #[serde(default, alias = "orgs")]
    organizations: Vec<serde_json::Value>,
}

pub fn connect(url: Option<String>, no_browser: bool) -> Result<(), Box<dyn std::error::Error>> {
    let cloud = url.unwrap_or_else(|| {
        let cfg = ConfigManager::load();
        cfg.cloud_url.unwrap_or_else(|| DEFAULT_CLOUD.to_string())
    });
    let cloud = cloud.trim_end_matches('/').to_string();

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;

    let client_name = format!("aura-cli v{} on {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS);
    let start_url = format!("{}/api/v2/auth/device/start", cloud);
    let start: StartResp = client.post(&start_url)
        .json(&serde_json::json!({ "client_name": client_name }))
        .send()?
        .error_for_status()?
        .json()?;

    println!();
    println!("{}", "  Aura Connect".bold().cyan());
    println!();
    println!("  Your code: {}", start.user_code.bold().yellow());
    println!("  Open in browser: {}", start.verify_url.underline());
    println!();

    if !no_browser {
        let _ = webbrowser::open(&start.verify_url);
        println!("  Browser should open automatically. If not, copy the URL above.");
    } else {
        println!("  Open the URL on any device to approve.");
    }
    println!();
    println!("  Waiting for approval… (expires in {}s)", start.expires_in);

    let poll_url = format!("{}/api/v2/auth/device/poll", cloud);
    let deadline = Instant::now() + Duration::from_secs(start.expires_in);
    let interval = Duration::from_secs(start.poll_interval.max(1));

    while Instant::now() < deadline {
        std::thread::sleep(interval);
        let resp = client.post(&poll_url)
            .json(&serde_json::json!({ "device_code": start.device_code }))
            .send();
        let resp = match resp {
            Ok(r) => r,
            Err(_) => continue,
        };
        if resp.status() == reqwest::StatusCode::GONE {
            return Err("This device code was already used. Run `aura connect` again.".into());
        }
        let body: PollResp = match resp.json() {
            Ok(b) => b,
            Err(_) => continue,
        };
        match body.status.as_str() {
            "pending" => continue,
            "expired" => return Err("Approval window expired. Run `aura connect` again.".into()),
            "invalid" => return Err("Device code no longer valid.".into()),
            "approved" => {
                let token = body.token.ok_or("approved response missing token")?;
                let mut cfg = ConfigManager::load();
                cfg.cloud_url = Some(cloud.clone());
                cfg.cloud_api_token = Some(token);
                cfg.sync_enabled = true;
                ConfigManager::save(&cfg)?;
                let user = body.user.as_deref().unwrap_or("you");
                let org = body.org_slug.as_deref().unwrap_or("(no org)");
                println!();
                println!("  {} Connected as @{} at {}", "✓".green().bold(), user, org);
                match crate::daemon_install::install() {
                    Ok(desc) => {
                        println!("  {} Background daemon: {}", "☁".cyan(), desc);
                    }
                    Err(e) => {
                        println!("  {} Daemon install skipped ({}) — run `aura daemon` manually.",
                            "⚠".yellow(), e);
                    }
                }
                println!();
                return Ok(());
            }
            other => return Err(format!("Unexpected status from server: {}", other).into()),
        }
    }
    Err("Timed out waiting for approval.".into())
}

pub fn whoami() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = ConfigManager::load();
    let token = cfg.cloud_api_token.ok_or("Not connected. Run `aura connect`.")?;
    let cloud = cfg.cloud_url.unwrap_or_else(|| DEFAULT_CLOUD.to_string());
    let cloud = cloud.trim_end_matches('/');

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let resp = client.get(format!("{}/api/v2/me", cloud))
        .bearer_auth(&token)
        .send()?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Token rejected. Run `aura connect` to re-authenticate.".into());
    }
    let me: MeResp = resp.error_for_status()?.json()?;
    let login = me.user.as_ref()
        .and_then(|u| u.get("github_login").and_then(|v| v.as_str()))
        .unwrap_or("(unknown)");
    let orgs: Vec<String> = me.organizations.iter()
        .filter_map(|o| o.get("slug").and_then(|v| v.as_str()).map(String::from))
        .collect();
    println!("Cloud: {}", cloud);
    println!("User:  @{}", login);
    println!("Orgs:  {}", if orgs.is_empty() { "(none)".to_string() } else { orgs.join(", ") });
    Ok(())
}

pub fn disconnect() -> Result<(), Box<dyn std::error::Error>> {
    let mut cfg = ConfigManager::load();
    if cfg.cloud_api_token.is_none() {
        println!("Not connected. Nothing to do.");
        return Ok(());
    }
    cfg.cloud_api_token = None;
    ConfigManager::save(&cfg)?;
    println!("{} Disconnected. Cloud token cleared.", "✓".green().bold());
    Ok(())
}
