//! Safe cross-machine sync for coding-agent preferences.
//!
//! Only three explicit preference files are eligible. Authentication stores
//! (`auth.json`, OAuth caches, keychains, credentials) are never opened. JSON
//! and TOML values are recursively scrubbed by key before upload, scrubbed a
//! second time after download, and written atomically with an adjacent backup.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::cloud_session_sync::{cloud_origin, cloud_token, read_credentials};

const MAX_FILE_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy)]
enum ConfigFormat {
    Json,
    Toml,
}

#[derive(Clone, Copy)]
struct ConfigSpec {
    agent: &'static str,
    relative_path: &'static str,
    format: ConfigFormat,
}

const CONFIG_SPECS: [ConfigSpec; 3] = [
    ConfigSpec {
        agent: "Claude Code",
        relative_path: ".claude/settings.json",
        format: ConfigFormat::Json,
    },
    ConfigSpec {
        agent: "Codex",
        relative_path: ".codex/config.toml",
        format: ConfigFormat::Toml,
    },
    ConfigSpec {
        agent: "Gemini CLI",
        relative_path: ".gemini/settings.json",
        format: ConfigFormat::Json,
    },
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncedAgentConfigFile {
    agent: String,
    relative_path: String,
    format: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentConfigBundle {
    version: u32,
    source_device: String,
    files: Vec<SyncedAgentConfigFile>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CloudEnvelope {
    bundle: Option<AgentConfigBundle>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigSyncStatus {
    signed_in: bool,
    local_files: Vec<String>,
    remote_files: Vec<String>,
    remote_updated_at: Option<String>,
    remote_source_device: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigApplyResult {
    applied: Vec<String>,
    backups: Vec<String>,
    status: AgentConfigSyncStatus,
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "no HOME / USERPROFILE".to_string())
}

fn spec_for(relative_path: &str) -> Option<ConfigSpec> {
    CONFIG_SPECS
        .iter()
        .copied()
        .find(|spec| spec.relative_path == relative_path)
}

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if matches!(
        normalized.as_str(),
        "token"
            | "oauth"
            | "auth"
            | "apikey"
            | "password"
            | "passwd"
            | "secret"
            | "credential"
            | "authorization"
    ) {
        return true;
    }
    [
        "apikey",
        "accesstoken",
        "refreshtoken",
        "authtoken",
        "oauthtoken",
        "password",
        "passwd",
        "secret",
        "credential",
        "authorization",
        "bearertoken",
        "sessiontoken",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn sanitize_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| !sensitive_key(key));
            for child in map.values_mut() {
                sanitize_json(child);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(sanitize_json),
        _ => {}
    }
}

fn sanitize_toml(value: &mut toml::Value) {
    match value {
        toml::Value::Table(table) => {
            table.retain(|key, _| !sensitive_key(key));
            for (_, child) in table.iter_mut() {
                sanitize_toml(child);
            }
        }
        toml::Value::Array(values) => values.iter_mut().for_each(sanitize_toml),
        _ => {}
    }
}

fn sanitize_content(spec: ConfigSpec, raw: &str) -> Result<String, String> {
    if raw.len() > MAX_FILE_BYTES {
        return Err(format!("{} exceeds the 512 KiB sync limit", spec.relative_path));
    }
    match spec.format {
        ConfigFormat::Json => {
            let mut value: Value = serde_json::from_str(raw)
                .map_err(|e| format!("parse {}: {e}", spec.relative_path))?;
            sanitize_json(&mut value);
            serde_json::to_string_pretty(&value)
                .map(|text| format!("{text}\n"))
                .map_err(|e| e.to_string())
        }
        ConfigFormat::Toml => {
            let mut value: toml::Value = raw
                .parse()
                .map_err(|e| format!("parse {}: {e}", spec.relative_path))?;
            sanitize_toml(&mut value);
            toml::to_string_pretty(&value).map_err(|e| e.to_string())
        }
    }
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Aura desktop".to_string())
}

fn local_file_names() -> Result<Vec<String>, String> {
    let home = home_dir()?;
    Ok(CONFIG_SPECS
        .iter()
        .filter(|spec| home.join(spec.relative_path).is_file())
        .map(|spec| spec.relative_path.to_string())
        .collect())
}

fn build_local_bundle() -> Result<AgentConfigBundle, String> {
    let home = home_dir()?;
    let mut files = Vec::new();
    for spec in CONFIG_SPECS {
        let path = home.join(spec.relative_path);
        if !path.is_file() {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        files.push(SyncedAgentConfigFile {
            agent: spec.agent.to_string(),
            relative_path: spec.relative_path.to_string(),
            format: match spec.format {
                ConfigFormat::Json => "json",
                ConfigFormat::Toml => "toml",
            }
            .to_string(),
            content: sanitize_content(spec, &raw)?,
        });
    }
    Ok(AgentConfigBundle {
        version: 1,
        source_device: device_name(),
        files,
        updated_at: None,
    })
}

fn cloud_context() -> Result<Option<(String, String)>, String> {
    let credentials = read_credentials()?;
    Ok(cloud_token(&credentials).map(|token| (cloud_origin(&credentials), token)))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("client build: {e}"))
}

async fn fetch_remote(origin: &str, token: &str) -> Result<Option<AgentConfigBundle>, String> {
    let url = format!("{origin}/api/v1/sync/agent-configs");
    let response = http_client()?
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("cloud returned {status}: {body}"));
    }
    serde_json::from_str::<CloudEnvelope>(&body)
        .map(|envelope| envelope.bundle)
        .map_err(|e| format!("decode cloud bundle: {e}"))
}

async fn put_remote(
    origin: &str,
    token: &str,
    bundle: &AgentConfigBundle,
) -> Result<AgentConfigBundle, String> {
    let url = format!("{origin}/api/v1/sync/agent-configs");
    let response = http_client()?
        .put(&url)
        .bearer_auth(token)
        .json(bundle)
        .send()
        .await
        .map_err(|e| format!("PUT {url}: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("cloud returned {status}: {body}"));
    }
    serde_json::from_str::<CloudEnvelope>(&body)
        .map_err(|e| format!("decode cloud bundle: {e}"))?
        .bundle
        .ok_or_else(|| "cloud did not return the saved bundle".to_string())
}

fn make_status(
    signed_in: bool,
    remote: Option<&AgentConfigBundle>,
    error: Option<String>,
) -> Result<AgentConfigSyncStatus, String> {
    Ok(AgentConfigSyncStatus {
        signed_in,
        local_files: local_file_names()?,
        remote_files: remote
            .map(|bundle| {
                bundle
                    .files
                    .iter()
                    .map(|file| file.relative_path.clone())
                    .collect()
            })
            .unwrap_or_default(),
        remote_updated_at: remote.and_then(|bundle| bundle.updated_at.clone()),
        remote_source_device: remote.map(|bundle| bundle.source_device.clone()),
        error,
    })
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("invalid config path: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| format!("create temporary config: {e}"))?;
    temp.write_all(content.as_bytes())
        .map_err(|e| format!("write temporary config: {e}"))?;
    temp.flush().map_err(|e| format!("flush temporary config: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = temp.as_file().set_permissions(fs::Permissions::from_mode(0o600));
    }
    temp.persist(path)
        .map(|_| ())
        .map_err(|e| format!("install {}: {}", path.display(), e.error))
}

fn apply_bundle(bundle: &AgentConfigBundle) -> Result<(Vec<String>, Vec<String>), String> {
    if bundle.version != 1 {
        return Err("unsupported agent-config bundle version".into());
    }
    if bundle.files.len() > CONFIG_SPECS.len() {
        return Err("too many agent config files".into());
    }
    let home = home_dir()?;
    let mut seen = std::collections::HashSet::new();
    let mut prepared = Vec::new();
    // Validate and sanitize the complete remote bundle before moving even one
    // local file. A malformed later entry must not leave a partial apply.
    for file in &bundle.files {
        let spec = spec_for(&file.relative_path)
            .ok_or_else(|| format!("unsupported config path: {}", file.relative_path))?;
        if !seen.insert(file.relative_path.as_str()) {
            return Err(format!("duplicate config path: {}", file.relative_path));
        }
        if file.agent != spec.agent {
            return Err(format!("wrong agent label for {}", file.relative_path));
        }
        let expected_format = match spec.format {
            ConfigFormat::Json => "json",
            ConfigFormat::Toml => "toml",
        };
        if file.format != expected_format {
            return Err(format!("wrong format for {}", file.relative_path));
        }
        let clean = sanitize_content(spec, &file.content)?;
        prepared.push((spec, home.join(spec.relative_path), clean));
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut applied = Vec::new();
    let mut backups = Vec::new();
    for (spec, path, clean) in prepared {
        let extension = path.extension().and_then(|v| v.to_str()).unwrap_or("config");
        let mut sequence = 1u32;
        let backup = loop {
            let suffix = if sequence == 1 {
                format!("{extension}.aura-backup-{stamp}")
            } else {
                format!("{extension}.aura-backup-{stamp}-{sequence}")
            };
            let candidate = path.with_extension(suffix);
            if !candidate.exists() {
                break candidate;
            }
            sequence = sequence.saturating_add(1);
        };
        let had_existing = path.exists();
        if had_existing {
            fs::rename(&path, &backup).map_err(|e| {
                format!("backup {} to {}: {e}", path.display(), backup.display())
            })?;
        }
        if let Err(e) = atomic_write(&path, &clean) {
            if had_existing {
                let _ = fs::rename(&backup, &path);
            }
            return Err(e);
        }
        applied.push(spec.relative_path.to_string());
        if had_existing {
            backups.push(backup.display().to_string());
        }
    }
    Ok((applied, backups))
}

#[tauri::command]
pub async fn settings_agent_configs_status() -> Result<AgentConfigSyncStatus, String> {
    let Some((origin, token)) = cloud_context()? else {
        return make_status(false, None, None);
    };
    match fetch_remote(&origin, &token).await {
        Ok(remote) => make_status(true, remote.as_ref(), None),
        Err(e) => make_status(true, None, Some(e)),
    }
}

#[tauri::command]
pub async fn settings_agent_configs_push() -> Result<AgentConfigSyncStatus, String> {
    let (origin, token) = cloud_context()?
        .ok_or_else(|| "sign in to Aura Cloud before syncing agent configs".to_string())?;
    let bundle = build_local_bundle()?;
    let saved = put_remote(&origin, &token, &bundle).await?;
    make_status(true, Some(&saved), None)
}

#[tauri::command]
pub async fn settings_agent_configs_pull() -> Result<AgentConfigApplyResult, String> {
    let (origin, token) = cloud_context()?
        .ok_or_else(|| "sign in to Aura Cloud before syncing agent configs".to_string())?;
    let remote = fetch_remote(&origin, &token)
        .await?
        .ok_or_else(|| "no synced agent configuration exists yet".to_string())?;
    let (applied, backups) = apply_bundle(&remote)?;
    Ok(AgentConfigApplyResult {
        applied,
        backups,
        status: make_status(true, Some(&remote), None)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_sanitizer_removes_nested_credentials_but_keeps_preferences() {
        let mut value = serde_json::json!({
            "model": "claude-sonnet-5",
            "env": {
                "ANTHROPIC_API_KEY": "secret",
                "theme": "dark"
            },
            "nested": { "access_token": "secret", "effort": "high" }
            ,"auth": { "token": "secret", "scope": "preferences" }
        });
        sanitize_json(&mut value);
        assert_eq!(value["model"], "claude-sonnet-5");
        assert_eq!(value["env"]["theme"], "dark");
        assert!(value["env"].get("ANTHROPIC_API_KEY").is_none());
        assert!(value["nested"].get("access_token").is_none());
        assert_eq!(value["nested"]["effort"], "high");
        // An explicitly authentication-shaped parent is removed wholesale;
        // retaining sibling values under it risks preserving opaque secrets.
        assert!(value.get("auth").is_none());
    }

    #[test]
    fn toml_sanitizer_removes_credentials() {
        let mut value: toml::Value = r#"
model = "gpt-5.5"
api_key = "secret"
[provider]
base_url = "https://example.test"
refresh_token = "secret"
"#
        .parse()
        .unwrap();
        sanitize_toml(&mut value);
        let text = toml::to_string(&value).unwrap();
        assert!(text.contains("gpt-5.5"));
        assert!(text.contains("base_url"));
        assert!(!text.contains("secret"));
        assert!(!text.contains("api_key"));
    }
}
