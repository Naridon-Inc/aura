//! HTTP client for cloud-routed zones (plan W2.2).
//!
//! Thin wrappers over `/api/v2/zones` that mirror the local
//! `SentinelStore` API so callers can transparently switch between
//! on-disk zones (mothership / offline) and cloud zones.
//!
//! Local cache remains authoritative for `check_zone` so offline
//! ops keep working; the WS client in `live_ws.rs` updates the cache
//! on `type:zone` frames.

use serde::{Deserialize, Serialize};

use crate::config::ConfigManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudZone {
    pub id: String,
    #[serde(default)]
    pub zone_path: String,
    #[serde(default)]
    pub claim_type: String,
    #[serde(default)]
    pub status: String,
}

fn client() -> Result<(reqwest::blocking::Client, String, String), String> {
    let cfg = ConfigManager::load();
    let url = cfg.cloud_url.ok_or("not connected — run `aura connect`")?;
    let token = cfg
        .cloud_api_token
        .or_else(|| std::env::var("AURA_CLOUD_TOKEN").ok())
        .ok_or("no cloud token — run `aura connect`")?;
    let c = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("http client: {}", e))?;
    Ok((c, url, token))
}

pub fn list_zones() -> Result<Vec<CloudZone>, String> {
    let (c, url, token) = client()?;
    let resp = c
        .get(format!("{}/api/v2/zones", url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
    let zones = body["zones"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value::<CloudZone>(v).ok())
        .collect();
    Ok(zones)
}

pub fn claim_zone(path: &str, claim_type: &str) -> Result<CloudZone, String> {
    let (c, url, token) = client()?;
    let body = serde_json::json!({
        "zone_path": path,
        "claim_type": claim_type,
        "status": "active",
    });
    let resp = c
        .post(format!("{}/api/v2/zones", url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let data: serde_json::Value = resp.json().map_err(|e| format!("parse: {}", e))?;
    let id = data["zone"]["id"].as_str().unwrap_or_default().to_string();
    Ok(CloudZone {
        id,
        zone_path: path.to_string(),
        claim_type: claim_type.to_string(),
        status: "active".to_string(),
    })
}

pub fn release_zone(id: &str) -> Result<(), String> {
    let (c, url, token) = client()?;
    let resp = c
        .delete(format!("{}/api/v2/zones/{}", url, id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .map_err(|e| format!("network: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(())
}

/// Returns true if the current repo is cloud-routed per `team_repos_cloud`.
pub fn cloud_routed_for_current_repo() -> bool {
    let cfg = ConfigManager::load();
    let repo = crate::live_events::repo_name();
    cfg.team_repos_cloud.contains_key(&repo)
}
