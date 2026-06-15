//! Loads `~/.aura/agents.toml` and merges entries into the registry.
//!
//! Each `[[agent]]` entry can either *override* an existing id (pushing
//! a new provider with the same id replaces the old entry — see
//! `Registry::push`) or *declare* a new id, in which case it's added.
//!
//! Example TOML:
//! ```toml
//! [[agent]]
//! id = "kimi"
//! label = "Kimi-Coder"
//! bin = "kimi"
//! args = ["chat", "--prompt", "{prompt}"]
//! supports_stream = false
//! supports_pty = true
//! cost_per_1k_in = 0.0006
//! cost_per_1k_out = 0.0024
//!
//! [[agent.classifier_prefs]]
//! keyword = "chinese"
//! score = 3
//! ```

use crate::Registry;
use crate::generic_cli::{GenericCliProvider, GenericProviderConfig};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Deserialize)]
struct AgentsToml {
    #[serde(default)]
    agent: Vec<GenericProviderConfig>,
}

pub fn merge_user_toml(reg: &mut Registry) -> Result<(), String> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    if !path.exists() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed: AgentsToml =
        toml::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    for cfg in parsed.agent {
        if cfg.id.is_empty() {
            return Err("agents.toml entry missing 'id'".into());
        }
        if cfg.bin.is_empty() {
            return Err(format!("agents.toml entry '{}' missing 'bin'", cfg.id));
        }
        reg.push(Arc::new(GenericCliProvider::new(cfg)));
    }
    Ok(())
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let mut p = PathBuf::from(home);
    p.push(".aura");
    p.push("agents.toml");
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_overrides_existing_id() {
        let mut reg = Registry::with_defaults();
        let before = reg.get("claude").unwrap();
        assert_eq!(before.bin_name(), "claude");

        let toml = r#"
[[agent]]
id = "claude"
label = "Claude (custom path)"
bin = "/opt/anthropic/bin/claude"
args = ["-p", "{prompt}"]
supports_stream = true
supports_pty = true
supports_resume = true
"#;
        let parsed: AgentsToml = toml::from_str(toml).unwrap();
        for cfg in parsed.agent {
            reg.push(Arc::new(GenericCliProvider::new(cfg)));
        }
        let after = reg.get("claude").unwrap();
        assert_eq!(after.bin_name(), "/opt/anthropic/bin/claude");
        assert_eq!(after.label(), "Claude (custom path)");
    }

    #[test]
    fn merge_declares_new_id() {
        let mut reg = Registry::with_defaults();
        let toml = r#"
[[agent]]
id = "myagent"
label = "My Agent"
bin = "myagent"
args = ["go", "{prompt}"]
"#;
        let parsed: AgentsToml = toml::from_str(toml).unwrap();
        for cfg in parsed.agent {
            reg.push(Arc::new(GenericCliProvider::new(cfg)));
        }
        let p = reg.get("myagent").unwrap();
        assert_eq!(p.label(), "My Agent");
    }
}
