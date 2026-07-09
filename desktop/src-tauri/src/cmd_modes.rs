//! Tauri commands for Modes + Marketplace (MM.1).
//!
//! Every command is a thin shim around `manager::modes` — the heavy
//! lifting (parse/validate/store/fetch) lives there as pure Rust so the
//! MCP server companion can call the same primitives without going
//! through Tauri.
//!
//! Twelve commands ship in this wave:
//!
//! ```text
//! modes_marketplace_list   -> fetch index, return entries
//! modes_marketplace_refresh-> force-refresh index (alias for list, no cache today)
//! modes_install_from_url   -> download + pin + validate + persist
//! modes_list_installed     -> bundled + on-disk merged
//! modes_uninstall          -> delete <slug>.yaml + .meta.json
//! modes_edit               -> in-place edit (validate + atomic write)
//! modes_publish_to_gist    -> POST to GitHub Gist (anon)
//! modes_search             -> filter list by query
//! modes_enable             -> flip meta.enabled = true
//! modes_disable            -> flip meta.enabled = false
//! modes_check_updates      -> compare pins against marketplace
//! modes_validate_yaml      -> dry-run validator for the editor surface
//! ```
//!
//! Network IO uses `reqwest` async; the rest is synchronous and runs on
//! Tauri's command thread. Bodies are tiny so blocking IO on the
//! command thread is acceptable.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::manager::modes::marketplace::{
    self, IndexEntry, MarketplaceIndex, check_update_for, fetch_index, install_from_url,
};
use crate::manager::modes::registry::{self, ModeDescriptor};
use crate::manager::modes::storage::{
    self, ModeMeta, blake3_hex, delete_mode, list_slugs, load_meta, load_mode, save_meta,
    save_mode,
};
use crate::manager::modes::validate::{self, ValidationReport};

/// Result shape for `modes_check_updates`. One row per installed mode
/// that has an upstream pin newer than the local one.
#[derive(Debug, Clone, Serialize)]
pub struct ModeUpdateRow {
    pub slug: String,
    pub installed_pin: String,
    pub marketplace: IndexEntry,
}

/// Wrapper for `modes_install_from_url` body. Tauri spreads named
/// fields out of the invoke args by default, so each command takes
/// individual parameters rather than a struct.
#[derive(Debug, Deserialize)]
pub struct InstallArgs {
    pub url: String,
    #[serde(default)]
    pub expected_pin: Option<String>,
    #[serde(default)]
    pub advanced_acknowledged: bool,
}

#[tauri::command]
pub async fn modes_marketplace_list() -> Result<MarketplaceIndex, String> {
    fetch_index().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn modes_marketplace_refresh() -> Result<MarketplaceIndex, String> {
    // Currently identical to list — no in-process cache to invalidate.
    // The renderer's mode store does its own caching with `Date.now()`
    // timestamps; pressing Refresh just re-issues the request.
    fetch_index().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn modes_install_from_url(args: InstallArgs) -> Result<ModeDescriptor, String> {
    let (mode, meta) = install_from_url(
        &args.url,
        args.expected_pin.as_deref(),
        args.advanced_acknowledged,
    )
    .await
    .map_err(|e| e.to_string())?;
    // Build the descriptor we just persisted — saves the renderer a
    // round-trip to refresh the list after install.
    Ok(ModeDescriptor {
        bundled: registry::is_bundled_slug(&mode.id),
        installed: true,
        enabled: meta.enabled,
        used: meta.used,
        source: meta.source,
        pin_blake3: meta.pin_blake3,
        installed_at: meta.installed_at,
        mode,
    })
}

#[tauri::command]
pub fn modes_list_installed() -> Result<Vec<ModeDescriptor>, String> {
    registry::descriptors().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn modes_uninstall(slug: String) -> Result<(), String> {
    if registry::is_bundled_slug(&slug) {
        // For bundled defaults, "uninstall" disables instead — the
        // bundled YAML stays available so the picker doesn't lose a
        // built-in.
        let mut meta = load_meta(&slug)
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| ModeMeta::now("bundled", String::new()));
        meta.enabled = false;
        save_meta(&slug, &meta).map_err(|e| e.to_string())?;
        return Ok(());
    }
    delete_mode(&slug).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn modes_edit(slug: String, yaml: String) -> Result<ModeDescriptor, String> {
    let report = validate::validate(&yaml);
    let mode = report.mode.ok_or_else(|| {
        format!(
            "validation failed: {}",
            report
                .issues
                .iter()
                .map(|i| format!("{}: {}", i.field, i.message))
                .collect::<Vec<_>>()
                .join("; ")
        )
    })?;
    if mode.id != slug {
        return Err(format!(
            "slug mismatch: editing `{slug}` but YAML id is `{}`",
            mode.id
        ));
    }
    // Preserve the existing meta if any; bump install timestamp.
    let pin = blake3_hex(yaml.as_bytes());
    let meta = match load_meta(&slug).map_err(|e| e.to_string())? {
        Some(mut m) => {
            m.pin_blake3 = pin;
            m
        }
        None => ModeMeta::now("local", pin),
    };
    save_mode(&mode, &yaml, &meta).map_err(|e| e.to_string())?;
    let descriptor = ModeDescriptor {
        bundled: registry::is_bundled_slug(&mode.id),
        installed: true,
        enabled: meta.enabled,
        used: meta.used,
        source: meta.source.clone(),
        pin_blake3: meta.pin_blake3.clone(),
        installed_at: meta.installed_at,
        mode,
    };
    Ok(descriptor)
}

/// Body for `modes_publish_to_gist`. Github's anon-gist API lets us
/// publish without an auth token at the cost of an unlisted gist; the
/// returned URL is what the user shares.
#[derive(Debug, Deserialize)]
pub struct PublishArgs {
    pub slug: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublishResult {
    pub url: String,
    pub raw_url: String,
}

#[tauri::command]
pub async fn modes_publish_to_gist(args: PublishArgs) -> Result<PublishResult, String> {
    let entry = registry::get(&args.slug)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("mode `{}` not found", args.slug))?;
    // Re-serialise from the typed Mode so the published YAML is canonical
    // (avoids leaking provenance comments the user might have added).
    let yaml = serde_yaml::to_string(&entry.mode).map_err(|e| format!("serialize: {e}"))?;
    let filename = format!("{}.yaml", entry.mode.id);
    let body = json!({
        "description": args.description.unwrap_or_else(|| format!("Aura mode: {}", entry.mode.display_name)),
        "public": false,
        "files": {
            &filename: { "content": yaml }
        }
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client
        .post("https://api.github.com/gists")
        .header("user-agent", "aura-shell/modes-publisher")
        .header("accept", "application/vnd.github+json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST gist: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("gist POST failed: HTTP {status}: {txt}"));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    let html_url = v
        .get("html_url")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "gist response missing html_url".to_string())?
        .to_string();
    let raw_url = v
        .get("files")
        .and_then(|f| f.get(&filename))
        .and_then(|f| f.get("raw_url"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| "gist response missing raw_url".to_string())?
        .to_string();
    Ok(PublishResult {
        url: html_url,
        raw_url,
    })
}

#[derive(Debug, Deserialize)]
pub struct SearchArgs {
    pub query: String,
}

/// Server-side search across installed + marketplace modes. The
/// renderer could filter client-side, but routing through Rust keeps
/// the search semantics identical between the picker and any future
/// MCP exposure.
#[tauri::command]
pub async fn modes_search(args: SearchArgs) -> Result<Vec<ModeDescriptor>, String> {
    let q = args.query.trim().to_lowercase();
    let all = registry::descriptors().map_err(|e| e.to_string())?;
    if q.is_empty() {
        return Ok(all);
    }
    let out = all
        .into_iter()
        .filter(|d| {
            d.mode.id.to_lowercase().contains(&q)
                || d.mode.display_name.to_lowercase().contains(&q)
                || d.mode.description.to_lowercase().contains(&q)
                || d.mode
                    .tags
                    .iter()
                    .any(|t| t.to_lowercase().contains(&q))
        })
        .collect();
    Ok(out)
}

#[tauri::command]
pub fn modes_enable(slug: String) -> Result<(), String> {
    let mut meta = load_meta(&slug)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| ModeMeta::now("local", String::new()));
    meta.enabled = true;
    save_meta(&slug, &meta).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn modes_disable(slug: String) -> Result<(), String> {
    let mut meta = load_meta(&slug)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| ModeMeta::now("local", String::new()));
    meta.enabled = false;
    save_meta(&slug, &meta).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn modes_check_updates() -> Result<Vec<ModeUpdateRow>, String> {
    let slugs = list_slugs().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    // Fetch the index ONCE rather than per-slug to keep the network
    // footprint minimal. Then walk every installed slug and check.
    let idx = match fetch_index().await {
        Ok(i) => i,
        Err(_) => return Ok(out), // offline → no updates
    };
    for slug in slugs {
        let Ok(Some(meta)) = load_meta(&slug) else { continue };
        if let Some(entry) = idx.entries.iter().find(|e| e.id == slug) {
            let marketplace_pin = entry.pin_blake3.clone().unwrap_or_default();
            if !marketplace_pin.is_empty() && marketplace_pin != meta.pin_blake3 {
                out.push(ModeUpdateRow {
                    slug,
                    installed_pin: meta.pin_blake3,
                    marketplace: entry.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// Pure dry-run for the editor surface. Returns the full
/// `ValidationReport` so the renderer can render each issue inline.
#[tauri::command]
pub fn modes_validate_yaml(yaml: String) -> Result<ValidationReport, String> {
    Ok(validate::validate(&yaml))
}

// Silence unused-import warnings for the items we re-export via the
// command surface but don't reference inside the file body.
#[allow(dead_code)]
fn _force_use_imports() {
    let _ = marketplace::DEFAULT_INDEX_URL;
    let _ = storage::modes_dir;
    let _ = check_update_for;
    let _ = load_mode;
}
