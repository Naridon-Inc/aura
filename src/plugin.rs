use serde::{Deserialize, Serialize};
use std::path::Path;

/// Context passed to plugin lifecycle hooks
#[derive(Debug, Clone)]
pub struct PluginContext {
    pub repo_root: String,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub branch: Option<String>,
    pub checkpoint_id: Option<String>,
    pub review_result: Option<String>,
}

impl PluginContext {
    pub fn from_cwd() -> Self {
        let repo_root = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        let branch = git2::Repository::open(".")
            .ok()
            .and_then(|r| {
                let head = r.head().ok()?;
                head.shorthand().map(|s| s.to_string())
            });

        let session = crate::session::SessionManager::get_active_session();

        Self {
            repo_root,
            session_id: session.as_ref().map(|s| s.session_id.clone()),
            agent_id: session.as_ref().map(|s| s.agent_id.clone()),
            branch,
            checkpoint_id: None,
            review_result: None,
        }
    }
}

/// Trait that all Aura plugins must implement.
/// Plugins receive lifecycle events and can optionally provide custom commands.
pub trait AuraPlugin: Send + Sync {
    /// Unique name of the plugin (e.g., "cost-reporter")
    fn name(&self) -> &str;

    /// Semantic version string
    fn version(&self) -> &str;

    /// Called when a semantic checkpoint is persisted
    fn on_checkpoint(&self, _ctx: &PluginContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// Called when a PR review completes
    fn on_review(&self, _ctx: &PluginContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// Called when an agent session starts
    fn on_session_start(&self, _ctx: &PluginContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// Called when an agent session ends
    fn on_session_end(&self, _ctx: &PluginContext) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    /// Handle a custom command. Returns Some(output) if the plugin handles it, None otherwise.
    fn custom_command(
        &self,
        _cmd: &str,
        _args: &[String],
    ) -> Result<Option<String>, Box<dyn std::error::Error>> {
        Ok(None)
    }
}

/// Plugin configuration stored in .aura/config.toml or project config
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PluginConfig {
    /// List of built-in plugin names to enable (e.g., ["cost-reporter"])
    #[serde(default)]
    pub enabled: Vec<String>,
    /// Paths to dynamic plugin shared libraries (.so/.dylib)
    #[serde(default)]
    pub custom_paths: Vec<String>,
}

/// Registry that manages plugin lifecycle
pub struct PluginRegistry {
    plugins: Vec<Box<dyn AuraPlugin>>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            plugins: Vec::new(),
        }
    }

    /// Register a built-in (compile-time) plugin
    pub fn register(&mut self, plugin: Box<dyn AuraPlugin>) {
        self.plugins.push(plugin);
    }

    /// Load plugins based on configuration
    pub fn load_from_config(config: &PluginConfig) -> Self {
        let mut registry = Self::new();

        // Register built-in plugins based on enabled list
        for name in &config.enabled {
            match name.as_str() {
                "cost-reporter" => {
                    registry.register(Box::new(crate::plugins::cost_reporter::CostReporterPlugin));
                }
                other => {
                    eprintln!("  Warning: Unknown built-in plugin '{}', skipping.", other);
                }
            }
        }

        // Load dynamic plugins from custom paths
        for path_str in &config.custom_paths {
            let expanded = shellexpand(path_str);
            let path = Path::new(&expanded);
            if !path.exists() {
                eprintln!(
                    "  Warning: Plugin path '{}' does not exist, skipping.",
                    path_str
                );
                continue;
            }

            match Self::load_dynamic_plugin(&expanded) {
                Ok(plugin) => {
                    eprintln!("  Loaded dynamic plugin: {} v{}", plugin.name(), plugin.version());
                    registry.register(plugin);
                }
                Err(e) => {
                    eprintln!("  Warning: Failed to load plugin '{}': {}", path_str, e);
                }
            }
        }

        registry
    }

    /// Load a dynamic plugin from a shared library (.so/.dylib)
    ///
    /// The shared library must export a `create_plugin` function with signature:
    /// `extern "C" fn() -> *mut dyn AuraPlugin`
    fn load_dynamic_plugin(
        path: &str,
    ) -> Result<Box<dyn AuraPlugin>, Box<dyn std::error::Error>> {
        // Safety: Dynamic loading requires the plugin to export the correct symbol.
        // This is inherently unsafe but necessary for extensibility.
        unsafe {
            let lib = libloading::Library::new(path)?;
            let constructor: libloading::Symbol<unsafe extern "C" fn() -> *mut dyn AuraPlugin> =
                lib.get(b"create_plugin")?;
            let plugin = Box::from_raw(constructor());

            // Leak the library handle so it stays loaded for the plugin's lifetime
            std::mem::forget(lib);

            Ok(plugin)
        }
    }

    /// Dispatch a lifecycle event to all registered plugins
    pub fn dispatch_checkpoint(&self, ctx: &PluginContext) {
        for plugin in &self.plugins {
            if let Err(e) = plugin.on_checkpoint(ctx) {
                eprintln!("  Plugin '{}' checkpoint error: {}", plugin.name(), e);
            }
        }
    }

    pub fn dispatch_review(&self, ctx: &PluginContext) {
        for plugin in &self.plugins {
            if let Err(e) = plugin.on_review(ctx) {
                eprintln!("  Plugin '{}' review error: {}", plugin.name(), e);
            }
        }
    }

    pub fn dispatch_session_start(&self, ctx: &PluginContext) {
        for plugin in &self.plugins {
            if let Err(e) = plugin.on_session_start(ctx) {
                eprintln!("  Plugin '{}' session_start error: {}", plugin.name(), e);
            }
        }
    }

    pub fn dispatch_session_end(&self, ctx: &PluginContext) {
        for plugin in &self.plugins {
            if let Err(e) = plugin.on_session_end(ctx) {
                eprintln!("  Plugin '{}' session_end error: {}", plugin.name(), e);
            }
        }
    }

    /// Try to dispatch a custom command to all plugins. Returns first match.
    pub fn dispatch_custom_command(
        &self,
        cmd: &str,
        args: &[String],
    ) -> Option<String> {
        for plugin in &self.plugins {
            match plugin.custom_command(cmd, args) {
                Ok(Some(output)) => return Some(output),
                Err(e) => {
                    eprintln!("  Plugin '{}' command error: {}", plugin.name(), e);
                }
                _ => {}
            }
        }
        None
    }

    /// List all registered plugins
    pub fn list(&self) -> Vec<(&str, &str)> {
        self.plugins
            .iter()
            .map(|p| (p.name(), p.version()))
            .collect()
    }

    /// Get the number of registered plugins
    pub fn count(&self) -> usize {
        self.plugins.len()
    }
}

/// Read plugin config from .aura/plugins.toml (project-local) or ~/.aura/plugins.toml (global)
pub fn load_plugin_config() -> PluginConfig {
    // Try project-local first
    let local_path = ".aura/plugins.toml";
    if let Ok(content) = std::fs::read_to_string(local_path) {
        if let Ok(config) = toml_parse(&content) {
            return config;
        }
    }

    // Try global
    if let Ok(home) = std::env::var("HOME") {
        let global_path = format!("{}/.aura/plugins.toml", home);
        if let Ok(content) = std::fs::read_to_string(global_path) {
            if let Ok(config) = toml_parse(&content) {
                return config;
            }
        }
    }

    PluginConfig::default()
}

/// Simple TOML parser for plugin config (avoids adding toml crate dependency)
fn toml_parse(content: &str) -> Result<PluginConfig, ()> {
    let mut config = PluginConfig::default();

    let mut in_plugins_section = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[plugins]" {
            in_plugins_section = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_plugins_section = false;
            continue;
        }
        if !in_plugins_section {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("enabled") {
            let rest = rest.trim().strip_prefix('=').unwrap_or("").trim();
            // Parse array: ["cost-reporter", "other"]
            let inner = rest.trim_start_matches('[').trim_end_matches(']');
            config.enabled = inner
                .split(',')
                .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }

        if let Some(rest) = trimmed.strip_prefix("custom_paths") {
            let rest = rest.trim().strip_prefix('=').unwrap_or("").trim();
            let inner = rest.trim_start_matches('[').trim_end_matches(']');
            config.custom_paths = inner
                .split(',')
                .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    Ok(config)
}

/// Expand ~ in paths
fn shellexpand(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{}/{}", home, rest);
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestPlugin;
    impl AuraPlugin for TestPlugin {
        fn name(&self) -> &str { "test-plugin" }
        fn version(&self) -> &str { "0.1.0" }
    }

    #[test]
    fn test_registry_register() {
        let mut registry = PluginRegistry::new();
        registry.register(Box::new(TestPlugin));
        assert_eq!(registry.count(), 1);
        assert_eq!(registry.list()[0], ("test-plugin", "0.1.0"));
    }

    #[test]
    fn test_toml_parse() {
        let content = r#"
[plugins]
enabled = ["cost-reporter", "my-plugin"]
custom_paths = ["~/.aura/plugins/test.dylib"]
"#;
        let config = toml_parse(content).unwrap();
        assert_eq!(config.enabled, vec!["cost-reporter", "my-plugin"]);
        assert_eq!(config.custom_paths, vec!["~/.aura/plugins/test.dylib"]);
    }

    #[test]
    fn test_shellexpand() {
        let expanded = shellexpand("~/test/path");
        assert!(!expanded.starts_with('~') || std::env::var("HOME").is_err());
    }
}
