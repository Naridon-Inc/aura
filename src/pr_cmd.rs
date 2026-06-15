//! `aura pr` — trigger cloud PR AI review + list events (plan W7.3).

use crate::config::ConfigManager;

fn cloud() -> Result<(reqwest::blocking::Client, String, String), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected")?;
    let token = cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token")?;
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http: {}", e))?;
    Ok((c, url, token))
}

fn current_repo() -> String {
    crate::live_events::repo_name()
}

fn current_sha() -> Option<String> {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            }
        })
}

pub fn review(pr_number: i32, dry_run: bool, base: Option<&str>) -> Result<(), String> {
    let (c, url, token) = cloud()?;
    let sha = current_sha().unwrap_or_default();
    let body = serde_json::json!({
        "repo": current_repo(),
        "pr_number": pr_number,
        "head_sha": sha,
        "base_sha": base,
        "platform": "github",
        "dry_run": dry_run,
    });
    let resp = c
        .post(format!("{}/api/v2/pr/review", url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
    if dry_run {
        if let Some(preview) = v["body_preview"].as_str() {
            println!("{}", preview);
        } else {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
        }
    } else {
        println!(
            "✓ review event {} (posted comment id: {:?})",
            v["event_id"], v["posted_comment_id"]
        );
    }
    Ok(())
}

pub fn status() -> Result<(), String> {
    let (c, url, token) = cloud()?;
    let resp = c
        .get(format!("{}/api/v2/pr/events?repo={}", url, current_repo()))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
    let events = v["events"].as_array().cloned().unwrap_or_default();
    if events.is_empty() {
        println!("No reviews yet for {}.", current_repo());
        return Ok(());
    }
    println!("Recent Aura reviews for {}:", current_repo());
    for e in &events {
        let pr = e["pr_number"].as_i64().unwrap_or(0);
        let platform = e["platform"].as_str().unwrap_or("?");
        let risk = e["risk_score"].as_i64().unwrap_or(0);
        let label = e["risk_label"].as_str().unwrap_or("?");
        let summary = e["ai_summary"].as_str().unwrap_or("");
        let when = e["generated_at"].as_str().unwrap_or("");
        let short = if summary.len() > 100 { &summary[..100] } else { summary };
        println!("  [{}] {} #{} risk {}/{} — {}", when, platform, pr, risk, label, short);
    }
    Ok(())
}

pub fn connect(platform: &str) -> Result<(), String> {
    println!(
        "Open this URL to install Aura's {} App on your org:",
        platform
    );
    let (_, url, _) = cloud()?;
    println!("{}/install/{}", url, platform);
    Ok(())
}

pub fn feedback(event_id: &str, verdict: &str, note: Option<&str>) -> Result<(), String> {
    let (c, url, token) = cloud()?;
    let body = serde_json::json!({
        "event_id": event_id,
        "verdict": verdict,
        "note": note,
    });
    let resp = c
        .post(format!("{}/api/v2/pr/feedback", url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    println!("✓ feedback recorded");
    Ok(())
}
