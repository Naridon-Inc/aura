//! Zone-rule surface. Sentinel zones live at
//! `<repo>/.aura/sentinel/zones/<zone_id>.json` — one file per rule.
//! Reads AND writes go straight to disk: there is no local top-level
//! `aura zones` CLI (only `aura team zones`, which talks to the remote
//! mothership, not these files), so the desktop mirrors the sentinel
//! engine's own format — `zone-<uuid8>` ids and capitalized `"Warn"` /
//! `"Block"` mode casing so the CLI's `ZoneMode` serde keeps parsing
//! what we write. A best-effort `aura radar emit zone` after a claim
//! puts the zone on teammates' radars; its absence never fails the op.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ZoneRule {
    #[serde(default)]
    pub zone_id: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub patterns: Vec<String>,
    /// "Warn" or "Block" (the CLI's enum casing) — dictates whether a
    /// colliding edit is just flagged or actively rejected.
    #[serde(default)]
    pub mode: String,
    /// Optional human-friendly purpose ("auth refactor"). Desktop-claimed
    /// zones carry it; the CLI's serde ignores unknown fields so older
    /// readers stay compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Filesystem mtime of the rule file (unix seconds). Lets the UI
    /// render an "age" column without tracking this server-side.
    #[serde(default)]
    pub mtime: i64,
}

/// Session id stamped on desktop-claimed zones. Matches the frontend's
/// self-ownership convention (Tabs.tsx `ownerForFile` treats this id as
/// "mine" and skips the owner pill).
const DESKTOP_SESSION: &str = "aura-shell";

fn zones_dir(repo_root: &str) -> PathBuf {
    PathBuf::from(repo_root)
        .join(".aura")
        .join("sentinel")
        .join("zones")
}

#[tauri::command]
pub async fn zone_list(repo_root: String) -> Result<Vec<ZoneRule>, String> {
    crate::blocking::run(move || {
        let dir = zones_dir(&repo_root);
        if !dir.is_dir() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.filter_map(|r| r.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let body = match fs::read_to_string(&path) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if let Ok(mut z) = serde_json::from_str::<ZoneRule>(&body) {
                if z.zone_id.is_empty() {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        z.zone_id = stem.to_string();
                    }
                }
                z.mtime = mtime;
                out.push(z);
            }
        }
        out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn zone_claim(
    repo_root: String,
    patterns: Vec<String>,
    mode: Option<String>,
    label: Option<String>,
) -> Result<String, String> {
    let patterns: Vec<String> = patterns
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();
    if patterns.is_empty() {
        return Err("at least one pattern required".to_string());
    }
    // Reject path traversal in patterns — these are repo-relative globs.
    for p in &patterns {
        if p.contains("..") || p.starts_with('/') {
            return Err(format!("pattern must be repo-relative: {p}"));
        }
    }
    let dir = zones_dir(&repo_root);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let zone_id = format!(
        "zone-{}",
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    // Capitalized casing — the CLI's `ZoneMode` enum derives plain serde,
    // so anything else would make the zone invisible to sentinel checks.
    let mode_norm = match mode.as_deref().map(|m| m.to_ascii_lowercase()) {
        Some(ref m) if m == "block" => "Block",
        _ => "Warn",
    };
    let zone = ZoneRule {
        zone_id: zone_id.clone(),
        session_id: DESKTOP_SESSION.to_string(),
        patterns: patterns.clone(),
        mode: mode_norm.to_string(),
        label: label.clone().filter(|l| !l.trim().is_empty()),
        mtime: 0,
    };
    let path = dir.join(format!("{zone_id}.json"));
    crate::fs_atomic::write_json_pretty(&path, &zone)?;

    // Put the claim on the team's radar (awareness plane). Best-effort:
    // an old CLI without `radar emit` must never fail the claim itself.
    let intent = zone
        .label
        .clone()
        .unwrap_or_else(|| format!("claimed {} ({})", patterns.join(", "), mode_norm));
    let _ = Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args([
            "radar",
            "emit",
            "zone",
            "--file",
            &patterns[0],
            "--intent",
            &intent,
        ])
        .current_dir(&repo_root)
        .output()
        .await;

    Ok(zone_id)
}

#[tauri::command]
pub async fn zone_release(repo_root: String, zone_id: String) -> Result<String, String> {
    // Ids are minted as `zone-<uuid8>`; refuse anything that could walk
    // out of the zones directory.
    if zone_id.is_empty()
        || !zone_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid zone id: {zone_id}"));
    }
    let path = zones_dir(&repo_root).join(format!("{zone_id}.json"));
    if !path.is_file() {
        return Err(format!("zone not found: {zone_id}"));
    }
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(zone_id)
}

/// Structured zone/claim list for the `/zones` slash card — "who claimed
/// what" in this repo. Returns the local sentinel zones (the same on-disk
/// `.aura/sentinel/zones/*.json` rules `zone_list` reads and that
/// `aura_zone_claim`/`zone_claim` write), which is the offline source of
/// truth the card needs — no network, no cloud session required.
///
/// Distinct from `aura team zones list --json`, which hits the remote
/// mothership for cross-machine zones; that path needs a cloud session and
/// isn't what the desktop card surfaces. This command is a thin alias over
/// `zone_list` so the slash layer has a stable, intent-named entry point.
#[tauri::command]
pub async fn aura_zones_json(repo_root: String) -> Result<Vec<ZoneRule>, String> {
    zone_list(repo_root).await
}
