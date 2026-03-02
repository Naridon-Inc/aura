use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone)]
pub struct AuraConfig {
    pub ai_provider: Option<String>, // "gemini", "anthropic", "openai"
    pub gemini_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub openai_api_key: Option<String>,
    pub mercury_api_key: Option<String>, // For Mercury-2 (Inception)
    
    // specialized model overrides
    pub model_architect: Option<String>,
    pub model_researcher: Option<String>,
    pub model_auditor: Option<String>,
    pub model_arbitrator: Option<String>,

    pub saas_token: Option<String>,
    pub sync_enabled: bool,
    #[serde(default)]
    pub last_update_check: u64, // UNIX timestamp
    #[serde(default)]
    pub strict_gatekeeper_mode: bool, // Toggle for strict AST dependency blocking
    #[serde(default)]
    pub use_local_embeddings: bool, // Toggle to enforce 100% offline sovereign embeddings
    #[serde(default)]
    pub dev_mode: bool, // Toggle to bypass heavy infrastructure for local development
    #[serde(default)]
    pub secret_allowlist: Vec<String>, // List of node identifiers allowed to contain high-entropy data
    #[serde(default = "default_telemetry")]
    pub telemetry_enabled: bool, // Allow users to opt-out of anonymous usage ping
}

fn default_telemetry() -> bool { true }

impl Default for AuraConfig {
    fn default() -> Self {
        Self {
            ai_provider: Some("gemini".to_string()),
            gemini_api_key: None,
            anthropic_api_key: None,
            openai_api_key: None,
            mercury_api_key: None,
            model_architect: None,
            model_researcher: None,
            model_auditor: None,
            model_arbitrator: None,
            saas_token: None,
            sync_enabled: false,
            last_update_check: 0,
            strict_gatekeeper_mode: false, // Warn-by-default is the standard
            use_local_embeddings: false, // Cloud APIs are the default MVP
            dev_mode: false,
            secret_allowlist: vec![],
            telemetry_enabled: true,
        }
    }
}

pub struct ConfigManager;

impl ConfigManager {
    /// Returns the path to the global ~/.aura/credentials.json
    pub fn get_config_path() -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()
            .or_else(|| std::env::var("USERPROFILE").ok())?;
        
        let aura_dir = PathBuf::from(home).join(".aura");
        if !aura_dir.exists() {
            let _ = fs::create_dir_all(&aura_dir);
        }
        
        // Migrate legacy config if it exists
        let new_path = aura_dir.join("credentials.json");
        if !new_path.exists() {
            if let Some(proj_dirs) = ProjectDirs::from("com", "AuraLabs", "Aura") {
                let legacy_path = proj_dirs.config_dir().join("credentials.json");
                if legacy_path.exists() {
                    let _ = fs::copy(&legacy_path, &new_path);
                }
            }
        }

        Some(new_path)
    }

    /// Load the global configuration from disk
    pub fn load() -> AuraConfig {
        if let Some(path) = Self::get_config_path() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(config) = serde_json::from_str(&content) {
                    return config;
                }
            }
        }
        AuraConfig::default()
    }

    /// Save the global configuration to disk with strict permissions
    pub fn save(config: &AuraConfig) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(path) = Self::get_config_path() {
            let content = serde_json::to_string_pretty(config)?;
            
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // Write file first
                fs::write(&path, content)?;
                // Restrict permissions to owner read/write (0600)
                let mut perms = fs::metadata(&path)?.permissions();
                perms.set_mode(0o600);
                fs::set_permissions(&path, perms)?;
            }
            
            #[cfg(not(unix))]
            {
                fs::write(path, content)?;
            }
        }
        Ok(())
    }

    /// Fetch the active provider's name (gemini, anthropic, openai)
    pub fn get_active_provider() -> String {
        let config = Self::load();
        config.ai_provider.unwrap_or_else(|| "gemini".to_string())
    }

    /// Helper to fetch the API key for a specific provider
    pub fn get_api_key(provider: &str) -> Option<String> {
        let config = Self::load();
        
        match provider {
            "anthropic" => {
                if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
                    return Some(key);
                }
                config.anthropic_api_key
            },
            "openai" => {
                if let Ok(key) = std::env::var("OPENAI_API_KEY") {
                    return Some(key);
                }
                config.openai_api_key
            },
            "mercury" => {
                if let Ok(key) = std::env::var("MERCURY_API_KEY") {
                    return Some(key);
                }
                config.mercury_api_key
            },
            "gemini" | _ => {
                if let Ok(key) = std::env::var("GEMINI_API_KEY") {
                    return Some(key);
                }
                if let Some(key) = config.gemini_api_key {
                    return Some(key);
                }
                
                // Zero-Configuration Fallback: Read from the user's global Gemini CLI configuration
                let home_dir = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
                let gemini_config_path = std::path::Path::new(&home_dir).join(".gemini/settings.json");
                if gemini_config_path.exists() {
                    if let Ok(content) = std::fs::read_to_string(gemini_config_path) {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                            if let Some(api_key) = json.get("api_key").and_then(|k| k.as_str()) {
                                return Some(api_key.to_string());
                            }
                        }
                    }
                }
                None
            }
        }
    }
}
// test
// test 2
