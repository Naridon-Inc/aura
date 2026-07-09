//! Marketplace client — fetches the public index and downloads modes
//! pinned by URL.
//!
//! The index lives at `https://auravcs.com/marketplace/modes.json` and is
//! a plain JSON array of `IndexEntry` records (no auth — it's a public
//! list). The user's installer hits one URL per install, hashes the
//! bytes with blake3, and persists the pin so the next refresh can
//! detect a silent upstream rewrite.
//!
//! Network policy:
//!
//! - 5s timeout on index fetch (the JSON is small but the CDN can be slow).
//! - 3s connect / 8s body timeout on per-mode download (modes are tiny
//!   YAML files; anything longer is suspicious).
//! - Direct `reqwest::Client::new()` per call — these are cold paths,
//!   no need to share a long-lived pool with the brain client.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::ModesError;
use super::storage::{ModeMeta, blake3_hex, load_meta, save_mode};
use super::validate::validate;

/// Default index URL. Override via the `AURA_MARKETPLACE_URL` env var
/// for tests / staging.
pub const DEFAULT_INDEX_URL: &str = "https://auravcs.com/marketplace/modes.json";

/// One row in the marketplace index. Shape is intentionally minimal —
/// the rich data (system_prompt, tool_acl, etc.) lives in the YAML
/// fetched on install, not in the index. Lets the index stay small
/// and the YAML stay portable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEntry {
    /// Slug — matches the YAML's `id` field after install.
    pub id: String,
    pub display_name: String,
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Where to fetch the YAML from. Any https:// URL the server trusts.
    pub url: String,
    /// Optional blake3 hash the marketplace publisher computed at upload
    /// time. The installer compares the freshly-downloaded bytes
    /// against this; mismatch = install rejected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin_blake3: Option<String>,
    /// Optional install count for sorting "Popular".
    #[serde(default)]
    pub installs: u64,
    /// Optional 0..5 rating average for the same.
    #[serde(default)]
    pub rating: f32,
}

/// Top-level shape of `modes.json`. Wrapping in a struct rather than a
/// bare array lets the publisher add metadata (last_updated, schema)
/// without breaking older clients.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MarketplaceIndex {
    #[serde(default)]
    pub entries: Vec<IndexEntry>,
    #[serde(default)]
    pub generated_at: Option<u64>,
}

/// Fetch the marketplace index. Resolves the URL from
/// `AURA_MARKETPLACE_URL` if set, else the default. Returns an empty
/// index on transport errors so the UI can render an "offline" state
/// rather than crashing.
pub async fn fetch_index() -> Result<MarketplaceIndex, ModesError> {
    let url = std::env::var("AURA_MARKETPLACE_URL")
        .unwrap_or_else(|_| DEFAULT_INDEX_URL.to_string());
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| ModesError::Network {
            message: format!("build client: {e}"),
        })?;
    let resp = client
        .get(&url)
        .header("user-agent", "aura-shell/modes-marketplace")
        .send()
        .await
        .map_err(|e| ModesError::Network {
            message: format!("GET {url}: {e}"),
        })?;
    if !resp.status().is_success() {
        return Err(ModesError::Network {
            message: format!("GET {url}: HTTP {}", resp.status()),
        });
    }
    let body = resp.text().await.map_err(|e| ModesError::Network {
        message: format!("read body: {e}"),
    })?;
    // Accept either a bare array (legacy publishers) or the struct form.
    if let Ok(idx) = serde_json::from_str::<MarketplaceIndex>(&body) {
        return Ok(idx);
    }
    let arr: Vec<IndexEntry> = serde_json::from_str(&body).map_err(|e| ModesError::Validation {
        message: format!("parse index: {e}"),
    })?;
    Ok(MarketplaceIndex {
        entries: arr,
        generated_at: None,
    })
}

/// Download + validate + install a mode from a URL. The optional
/// `expected_pin` is the blake3 the caller expects to see (from the
/// index row); if it's present and doesn't match the freshly-downloaded
/// bytes, the install is rejected. When `expected_pin` is `None` (user
/// installing a hand-pasted URL with no index reference) we pin against
/// whatever we got and surface the new pin in the returned `ModeMeta`.
pub async fn install_from_url(
    url: &str,
    expected_pin: Option<&str>,
    advanced_acknowledged: bool,
) -> Result<(super::schema::Mode, ModeMeta), ModesError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| ModesError::Network {
            message: format!("build client: {e}"),
        })?;
    let resp = client
        .get(url)
        .header("user-agent", "aura-shell/modes-installer")
        .send()
        .await
        .map_err(|e| ModesError::Network {
            message: format!("GET {url}: {e}"),
        })?;
    if !resp.status().is_success() {
        return Err(ModesError::Network {
            message: format!("GET {url}: HTTP {}", resp.status()),
        });
    }
    let body = resp.bytes().await.map_err(|e| ModesError::Network {
        message: format!("read body: {e}"),
    })?;

    let pin = blake3_hex(&body);
    if let Some(expected) = expected_pin {
        if !expected.is_empty() && expected != pin {
            return Err(ModesError::PinMismatch {
                expected: expected.to_string(),
                actual: pin,
            });
        }
    }

    let yaml = std::str::from_utf8(&body).map_err(|e| ModesError::Validation {
        message: format!("install body is not UTF-8: {e}"),
    })?;
    let report = validate(yaml);
    let mode = report.mode.ok_or_else(|| ModesError::Validation {
        message: format!(
            "{} failed validation: {}",
            url,
            report
                .issues
                .iter()
                .map(|i| format!("{}: {}", i.field, i.message))
                .collect::<Vec<_>>()
                .join("; ")
        ),
    })?;

    // Advanced gate — if the mode asks for any RESERVED_TOOLS in its
    // allow / advanced lists, the caller MUST pass
    // `advanced_acknowledged=true`. The UI surfaces a checkbox the user
    // must tick to flip this bit.
    let wants_advanced = mode
        .tool_acl
        .allow
        .iter()
        .chain(mode.tool_acl.advanced.iter())
        .any(|t| super::validate::RESERVED_TOOLS.contains(&t.as_str()));
    if wants_advanced && !advanced_acknowledged {
        return Err(ModesError::AdvancedGate {
            wanted: mode
                .tool_acl
                .allow
                .iter()
                .chain(mode.tool_acl.advanced.iter())
                .filter(|t| super::validate::RESERVED_TOOLS.contains(&t.as_str()))
                .cloned()
                .collect(),
        });
    }

    let mut meta = ModeMeta::now(url, pin);
    // Preserve the user's enabled/used flags across reinstall.
    if let Ok(Some(old)) = load_meta(&mode.id) {
        meta.used = old.used;
        meta.enabled = old.enabled;
    }
    save_mode(&mode, yaml, &meta)?;
    Ok((mode, meta))
}

/// Compare the user's installed pin against the marketplace's current
/// pin for the same slug. `Ok(None)` means "no update available" (pin
/// match or slug not in index); `Ok(Some(entry))` means the index has
/// a newer pin and the UI should offer Refresh.
pub async fn check_update_for(slug: &str) -> Result<Option<IndexEntry>, ModesError> {
    let installed = load_meta(slug)?;
    let installed_pin = installed.map(|m| m.pin_blake3).unwrap_or_default();
    let idx = fetch_index().await?;
    if let Some(entry) = idx.entries.into_iter().find(|e| e.id == slug) {
        let marketplace_pin = entry.pin_blake3.clone().unwrap_or_default();
        if !marketplace_pin.is_empty() && marketplace_pin != installed_pin {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}
