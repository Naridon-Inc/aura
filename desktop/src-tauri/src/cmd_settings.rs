//! Settings tauri commands — backs the SettingsDialog tabs.
//!
//! The Aura CLI stores its global configuration as JSON at
//! `~/.aura/credentials.json` (see `aura-cli::config::AuraConfig`). We
//! read/write the file directly here so the dialog can render the same
//! state the CLI sees, and edits land in the same place. We don't
//! depend on `aura-cli` as a Rust dep because aura-cli is a binary
//! crate (not a library); the JSON shape is stable enough that the
//! shell mirroring a subset of fields is the lighter coupling.
//!
//! The Agents tab edits `~/.aura/agents.toml` (consumed by
//! `aura-agents::toml_loader`) — we round-trip that via the `toml`
//! crate so user-authored comments / extra fields aren't preserved
//! (acceptable in v1; anyone hand-editing already knows what they're
//! doing).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use aura_agents::generic_cli::GenericProviderConfig;

fn aura_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no HOME / USERPROFILE".to_string())?;
    let p = PathBuf::from(home).join(".aura");
    if !p.exists() {
        fs::create_dir_all(&p).map_err(|e| format!("create {}: {e}", p.display()))?;
    }
    Ok(p)
}

fn credentials_path() -> Result<PathBuf, String> {
    Ok(aura_dir()?.join("credentials.json"))
}

fn agents_toml_path() -> Result<PathBuf, String> {
    Ok(aura_dir()?.join("agents.toml"))
}

/// Subset of `aura-cli::AuraConfig` the shell knows how to surface and
/// edit. Anything not listed here is preserved verbatim through the
/// untyped `serde_json::Value` round-trip in `read_raw` / `write_raw`.
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SettingsView {
    /// Active provider id ("gemini" | "anthropic" | "openai" | "mercury").
    pub ai_provider: Option<String>,
    /// Last 4 chars only — never echo the full key back to the renderer.
    pub gemini_key_last4: Option<String>,
    pub anthropic_key_last4: Option<String>,
    pub openai_key_last4: Option<String>,
    pub mercury_key_last4: Option<String>,
    pub strict_gatekeeper_mode: bool,
    pub strict_mode_locked: bool,
    pub telemetry_enabled: bool,
    pub use_local_embeddings: bool,
    pub dev_mode: bool,
    pub sync_enabled: bool,
    pub cloud_url: Option<String>,
    pub cloud_token_present: bool,
    /// Absolute path used as the parent of managed worktrees. When None
    /// the default (`~/.aura/worktrees`) applies. Surfaced read-only in
    /// the renderer; writes go through `settings_set_worktree_base`.
    pub worktree_base_path: Option<String>,
}

fn last4(s: &Option<String>) -> Option<String> {
    s.as_ref().and_then(|k| {
        let trimmed = k.trim();
        if trimmed.is_empty() {
            None
        } else if trimmed.len() <= 4 {
            Some(trimmed.to_string())
        } else {
            Some(trimmed[trimmed.len() - 4..].to_string())
        }
    })
}

fn read_raw() -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let path = credentials_path()?;
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(serde_json::Map::new());
    }
    let v: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse credentials.json: {e}"))?;
    match v {
        serde_json::Value::Object(m) => Ok(m),
        _ => Err("credentials.json is not a JSON object".into()),
    }
}

fn write_raw(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let path = credentials_path()?;
    let pretty = serde_json::to_string_pretty(map)
        .map_err(|e| format!("serialize credentials.json: {e}"))?;
    fs::write(&path, pretty).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(&path, perms);
    }
    Ok(())
}

fn str_field(map: &serde_json::Map<String, serde_json::Value>, k: &str) -> Option<String> {
    map.get(k)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

fn bool_field(map: &serde_json::Map<String, serde_json::Value>, k: &str) -> bool {
    map.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
}

#[tauri::command]
pub async fn settings_load() -> Result<SettingsView, String> {
    let map = read_raw()?;
    let gem = str_field(&map, "gemini_api_key");
    let ant = str_field(&map, "anthropic_api_key");
    let oai = str_field(&map, "openai_api_key");
    let mer = str_field(&map, "mercury_api_key");
    Ok(SettingsView {
        ai_provider: str_field(&map, "ai_provider"),
        gemini_key_last4: last4(&gem),
        anthropic_key_last4: last4(&ant),
        openai_key_last4: last4(&oai),
        mercury_key_last4: last4(&mer),
        strict_gatekeeper_mode: bool_field(&map, "strict_gatekeeper_mode"),
        strict_mode_locked: str_field(&map, "strict_mode_passcode_hash").is_some(),
        telemetry_enabled: map
            .get("telemetry_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        use_local_embeddings: bool_field(&map, "use_local_embeddings"),
        dev_mode: bool_field(&map, "dev_mode"),
        sync_enabled: bool_field(&map, "sync_enabled"),
        cloud_url: str_field(&map, "cloud_url"),
        cloud_token_present: str_field(&map, "cloud_api_token").is_some(),
        worktree_base_path: str_field(&map, "worktree_base_path"),
    })
}

/// Set or clear the parent directory used for managed worktrees. Empty
/// `path` clears the override (returns to the default `~/.aura/worktrees`).
/// We don't validate the path exists — the caller surfaces it as a
/// directory-picker and the worktree creator will error clearly if it's
/// unwritable when the user tries to make one.
#[tauri::command]
pub async fn settings_set_worktree_base(path: String) -> Result<(), String> {
    let mut map = read_raw()?;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        map.remove("worktree_base_path");
    } else {
        map.insert(
            "worktree_base_path".into(),
            serde_json::Value::String(trimmed.into()),
        );
    }
    write_raw(&map)
}

/// Set or clear a provider API key. `provider` is one of
/// `gemini` | `anthropic` | `openai` | `mercury`. Empty `key` clears.
#[tauri::command]
pub async fn settings_set_provider_key(provider: String, key: String) -> Result<(), String> {
    let field = match provider.as_str() {
        "gemini" => "gemini_api_key",
        "anthropic" => "anthropic_api_key",
        "openai" => "openai_api_key",
        "mercury" => "mercury_api_key",
        _ => return Err(format!("unknown provider: {provider}")),
    };
    let mut map = read_raw()?;
    if key.trim().is_empty() {
        map.remove(field);
    } else {
        map.insert(field.into(), serde_json::Value::String(key.trim().into()));
    }
    write_raw(&map)
}

#[tauri::command]
pub async fn settings_set_active_provider(provider: String) -> Result<(), String> {
    let allowed = ["gemini", "anthropic", "openai", "mercury"];
    if !allowed.contains(&provider.as_str()) {
        return Err(format!("unknown provider: {provider}"));
    }
    let mut map = read_raw()?;
    map.insert("ai_provider".into(), serde_json::Value::String(provider));
    write_raw(&map)
}

#[tauri::command]
pub async fn settings_set_telemetry(enabled: bool) -> Result<(), String> {
    let mut map = read_raw()?;
    map.insert("telemetry_enabled".into(), serde_json::Value::Bool(enabled));
    // A deliberate toggle here IS a consent decision — record the marker the
    // first-run prompt gates on, so setting your preference in Settings stops
    // the prompt from ever reappearing. Mirrors telemetry::write_consent.
    map.insert(
        "telemetry_consent_decided".into(),
        serde_json::Value::Bool(true),
    );
    write_raw(&map)
}

#[tauri::command]
pub async fn settings_set_dev_mode(enabled: bool) -> Result<(), String> {
    let mut map = read_raw()?;
    map.insert("dev_mode".into(), serde_json::Value::Bool(enabled));
    write_raw(&map)
}

#[tauri::command]
pub async fn settings_set_local_embeddings(enabled: bool) -> Result<(), String> {
    let mut map = read_raw()?;
    map.insert(
        "use_local_embeddings".into(),
        serde_json::Value::Bool(enabled),
    );
    write_raw(&map)
}

/// Turn strict mode ON without setting a passcode.
///
/// The shell could already turn the guard *off* in one click but had no way
/// to turn it on — the pane told you to run `aura config set strict-mode
/// true` in a terminal, which makes the protective direction the hard one
/// and the risky direction the easy one.
///
/// Deliberately does not touch `strict_mode_passcode_hash`. Locking is what
/// needs a human at a terminal: a passcode set over the IPC bridge is a
/// passcode an agent could have chosen, and the whole point of the lock is
/// that nothing on this machine can undo it. Enabling has no such hazard —
/// switching a guard on is never the dangerous direction — and the resulting
/// on-but-unlocked state is one the CLI, the pane and the pre-commit hook
/// already understand. Idempotent, and preserves an existing hash if one is
/// somehow present so this can never quietly unlock a locked repo.
#[tauri::command]
pub async fn settings_enable_strict_unlocked() -> Result<(), String> {
    let mut map = read_raw()?;
    map.insert("strict_gatekeeper_mode".into(), serde_json::Value::Bool(true));
    write_raw(&map)
}

/// Disable strict mode WITHOUT a passcode. Refuses if the mode is
/// locked (passcode hash present) — locked-mode disable must go
/// through the CLI's interactive `aura config reset-passcode` flow,
/// since exposing passcode entry over the IPC bridge would weaken the
/// "human at a real terminal" guarantee.
#[tauri::command]
pub async fn settings_disable_strict_unlocked() -> Result<(), String> {
    let mut map = read_raw()?;
    if str_field(&map, "strict_mode_passcode_hash").is_some() {
        return Err("strict mode is passcode-locked; disable from `aura config reset-passcode`".into());
    }
    map.insert(
        "strict_gatekeeper_mode".into(),
        serde_json::Value::Bool(false),
    );
    write_raw(&map)
}

// ── Agents tab ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct AgentsTomlFile {
    #[serde(default)]
    agent: Vec<GenericProviderConfig>,
}

#[derive(Debug, Serialize)]
struct AgentsTomlOut<'a> {
    agent: &'a [GenericProviderConfig],
}

fn read_agents_toml() -> Result<Vec<GenericProviderConfig>, String> {
    let path = agents_toml_path()?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }
    let parsed: AgentsTomlFile =
        toml::from_str(&raw).map_err(|e| format!("parse agents.toml: {e}"))?;
    Ok(parsed.agent)
}

fn write_agents_toml(entries: &[GenericProviderConfig]) -> Result<(), String> {
    let path = agents_toml_path()?;
    let out = AgentsTomlOut { agent: entries };
    let serialized =
        toml::to_string_pretty(&out).map_err(|e| format!("serialize agents.toml: {e}"))?;
    fs::write(&path, serialized).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub async fn settings_agents_toml_list() -> Result<Vec<GenericProviderConfig>, String> {
    read_agents_toml()
}

/// Upsert a TOML-declared provider — replaces an existing entry with
/// the same id, otherwise appends.
#[tauri::command]
pub async fn settings_agents_toml_upsert(entry: GenericProviderConfig) -> Result<(), String> {
    if entry.id.trim().is_empty() {
        return Err("id is required".into());
    }
    if entry.bin.trim().is_empty() {
        return Err("bin is required".into());
    }
    let mut entries = read_agents_toml()?;
    if let Some(slot) = entries.iter_mut().find(|e| e.id == entry.id) {
        *slot = entry;
    } else {
        entries.push(entry);
    }
    write_agents_toml(&entries)
}

#[tauri::command]
pub async fn settings_agents_toml_remove(id: String) -> Result<(), String> {
    let mut entries = read_agents_toml()?;
    entries.retain(|e| e.id != id);
    write_agents_toml(&entries)
}

// ── Telemetry tab ─────────────────────────────────────────────────────

/// Anonymous usage counters. The CLI writes per-command counts to
/// `~/.aura/telemetry.json` on the same `telemetry_enabled` toggle. We
/// surface them so the user sees what's been recorded — and can clear.
#[derive(Debug, Serialize)]
pub struct TelemetryView {
    pub enabled: bool,
    /// Raw counts, command -> times invoked. Empty when telemetry is
    /// off or the file doesn't exist yet.
    pub counts: BTreeMap<String, u64>,
    /// File-mtime seconds, for "last updated X ago" labels. None when
    /// the file is absent.
    pub last_updated: Option<u64>,
}

#[tauri::command]
pub async fn settings_telemetry_show() -> Result<TelemetryView, String> {
    crate::blocking::run(move || {
        let creds = read_raw()?;
        let enabled = creds
            .get("telemetry_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let path = aura_dir()?.join("telemetry.json");
        if !path.exists() {
            return Ok(TelemetryView {
                enabled,
                counts: BTreeMap::new(),
                last_updated: None,
            });
        }
        let raw = fs::read_to_string(&path).unwrap_or_default();
        let counts: BTreeMap<String, u64> = if raw.trim().is_empty() {
            BTreeMap::new()
        } else {
            serde_json::from_str(&raw).unwrap_or_default()
        };
        let last_updated = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        Ok(TelemetryView {
            enabled,
            counts,
            last_updated,
        })
    })
    .await
}

#[tauri::command]
pub async fn settings_telemetry_clear() -> Result<(), String> {
    let path = aura_dir()?.join("telemetry.json");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}
