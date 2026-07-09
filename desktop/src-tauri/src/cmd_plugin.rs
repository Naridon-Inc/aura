//! Tauri commands for the plugin registry.
//!
//! Thin facade over `plugin_host::Registry` so the JS side (api.ts)
//! can list / enable / disable / rescan plugins without holding a Rust
//! handle to the registry. The registry itself is stored in Tauri's
//! managed state — see `lib.rs::setup_plugin_host` (W0.3).
//!
//! Enable/disable state persists to `<install_root>/.state.json` so
//! both the running shell and a future `aura plugin disable` CLI
//! invocation see the same source of truth.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::plugin_host::{
    manifest::{
        AppContrib, PluginContributes, RailTileContrib, RightRailPanelContrib, SlashCommandContrib,
        StatusPillContrib,
    },
    registry::default_install_root,
    Manifest, ManifestKind, Registry,
};

/// Tauri managed state — holds the shared Registry handle + the
/// install root we're scanning. Created in `lib.rs::setup()`.
pub struct PluginHostState {
    pub registry: Arc<Registry>,
    pub install_root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PluginRow {
    pub id: String,
    pub kind: String,
    pub version: String,
    pub enabled: bool,
    pub install_dir: String,
    pub capabilities_count: usize,
    pub description: Option<String>,
    /// Install-bundle id (`@scope/name`, derived from install_dir).
    /// Secrets are scoped to the bundle, so the Settings UI keys its
    /// secret rows by this — manifests in one bundle share it.
    pub bundle: Option<String>,
    /// Bundle signature verdict: "unsigned" | "verified" |
    /// "unknown_key". Tampered bundles never appear here — the
    /// registry rejects them at scan time.
    pub signature: String,
    /// Publisher label from the trust store when verified; the bare
    /// key id when the key is unknown; None when unsigned.
    pub signed_by: Option<String>,
}

/// Flatten the registry's signature verdict for the UI — keeps the
/// string contract with api.ts in one place.
fn signature_fields(status: &aura_plugin_sign::SignatureStatus) -> (String, Option<String>) {
    use aura_plugin_sign::SignatureStatus as S;
    match status {
        S::Unsigned => ("unsigned".to_string(), None),
        S::Verified { publisher, .. } => ("verified".to_string(), Some(publisher.clone())),
        S::UnknownKey { publisher_key_id } => {
            ("unknown_key".to_string(), Some(publisher_key_id.clone()))
        }
        // Invalid bundles are rejected before they reach the cache;
        // map defensively anyway.
        S::Invalid { .. } => ("unknown_key".to_string(), None),
    }
}

#[tauri::command]
pub fn plugin_list(state: State<'_, PluginHostState>) -> Vec<PluginRow> {
    state
        .registry
        .list()
        .into_iter()
        .map(|e| {
            let (signature, signed_by) = signature_fields(&e.signature);
            PluginRow {
                id: e.id.clone(),
                kind: kind_label(e.kind).to_string(),
                version: e.version.clone(),
                enabled: e.enabled,
                install_dir: e.install_dir.display().to_string(),
                capabilities_count: e.capabilities.len(),
                description: extract_description(&e.manifest),
                bundle: crate::plugin_host::secrets::bundle_id_from_install_dir(&e.install_dir),
                signature,
                signed_by,
            }
        })
        .collect()
}

#[tauri::command]
pub fn plugin_rescan(state: State<'_, PluginHostState>) -> RescanResult {
    let report = state.registry.scan(&state.install_root);
    // Replay persisted enable/disable state — Registry::scan resets
    // every entry to enabled=true.
    apply_persisted_state(&state.registry, &state.install_root);
    RescanResult {
        loaded: report.loaded,
        rejected: report
            .rejections
            .into_iter()
            .map(|r| RescanRejection {
                path: r.path.display().to_string(),
                reason: r.reason,
            })
            .collect(),
    }
}

/// Per-plugin contributes payload exposed to the renderer. Renderer
/// uses this to merge plugin-declared UI surfaces (slash commands,
/// rail tiles, right-rail panels, status pills) into the in-app
/// catalogs. Only enabled native plugins surface here — skills and
/// MCP servers don't contribute UI.
#[derive(Debug, Serialize, Deserialize)]
pub struct PluginContributesRow {
    pub plugin_id: String,
    pub version: String,
    /// Manifest-declared worker entry, relative to install_dir. Frontend
    /// resolves to a file URL via convertFileSrc + install_dir to spawn
    /// the Worker.
    pub entry: String,
    /// Manifest-declared install root. The frontend resolves panel
    /// entries and the worker entry against this path.
    pub install_dir: String,
    /// Raw capability strings (`fs:read:**`, `net:fetch:api.linear.app`,
    /// …). Frontend parses these into a CapabilitySet.
    pub capabilities: Vec<String>,
    pub slash_commands: Vec<SlashCommandContrib>,
    pub rail_tiles: Vec<RailTileContrib>,
    pub right_rail_panels: Vec<RightRailPanelContrib>,
    pub status_pills: Vec<StatusPillContrib>,
    /// Full-surface mini-apps — open in the center WorkSurface, not the
    /// narrow rail. The Commons "Apps" launcher lists these.
    pub apps: Vec<AppContrib>,
    /// Id of the MCP server bundled in the same install dir (the
    /// `aura.mcp.json` sibling), when one exists AND is enabled. The
    /// plugin runtime routes the `mcp.call` host method to this server
    /// — a plugin can only ever reach its own bundle's MCP server.
    pub mcp_server_id: Option<String>,
}

#[tauri::command]
pub fn plugin_contributes(state: State<'_, PluginHostState>) -> Vec<PluginContributesRow> {
    let all = state.registry.list();
    all.iter()
        .filter(|e| e.enabled && e.kind == ManifestKind::NativePlugin)
        .filter_map(|e| match &e.manifest {
            Manifest::Plugin(p) => {
                let sibling_mcp = all
                    .iter()
                    .find(|m| {
                        m.kind == ManifestKind::Mcp
                            && m.enabled
                            && m.install_dir == e.install_dir
                    })
                    .map(|m| m.id.clone());
                Some(contribs_row(
                    &e.id,
                    &e.version,
                    &p.entry,
                    &e.install_dir,
                    &p.capabilities,
                    &p.contributes,
                    sibling_mcp,
                ))
            }
            _ => None,
        })
        .collect()
}

fn contribs_row(
    id: &str,
    version: &str,
    entry: &str,
    install_dir: &std::path::Path,
    capabilities: &[String],
    c: &PluginContributes,
    mcp_server_id: Option<String>,
) -> PluginContributesRow {
    PluginContributesRow {
        plugin_id: id.to_string(),
        version: version.to_string(),
        entry: entry.to_string(),
        install_dir: install_dir.to_string_lossy().to_string(),
        capabilities: capabilities.to_vec(),
        slash_commands: c.slash_commands.clone(),
        rail_tiles: c.rail_tiles.clone(),
        right_rail_panels: c.right_rail_panels.clone(),
        status_pills: c.status_pills.clone(),
        apps: c.apps.clone(),
        mcp_server_id,
    }
}

#[derive(Debug, Serialize)]
pub struct RescanResult {
    pub loaded: usize,
    pub rejected: Vec<RescanRejection>,
}

#[derive(Debug, Serialize)]
pub struct RescanRejection {
    pub path: String,
    pub reason: String,
}

#[tauri::command]
pub fn plugin_enable(
    state: State<'_, PluginHostState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    set_enabled(&state, &kind, &id, true)
}

#[tauri::command]
pub fn plugin_disable(
    state: State<'_, PluginHostState>,
    kind: String,
    id: String,
) -> Result<(), String> {
    set_enabled(&state, &kind, &id, false)
}

fn set_enabled(
    state: &PluginHostState,
    kind_raw: &str,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    let kind = parse_kind(kind_raw)?;
    set_enabled_persisted(state, kind, id, enabled)
}

/// Flip + persist enable state for any manifest kind. Shared with
/// `cmd_mcp_servers::mcp_servers_toggle`, which routes plugin-bundled
/// MCP server toggles here so the MCP pane and the Plugins pane stay
/// one source of truth (`.state.json`).
pub fn set_enabled_persisted(
    state: &PluginHostState,
    kind: ManifestKind,
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    if !state.registry.set_enabled(kind, id, enabled) {
        return Err(format!(
            "no installed plugin matches {}/{id}",
            kind_label(kind)
        ));
    }
    persist_state(&state.registry, &state.install_root)
        .map_err(|e| format!("persist plugin state: {e}"))?;
    Ok(())
}

fn parse_kind(raw: &str) -> Result<ManifestKind, String> {
    match raw {
        "plugin" => Ok(ManifestKind::NativePlugin),
        "skill" => Ok(ManifestKind::Skill),
        "mcp" => Ok(ManifestKind::Mcp),
        _ => Err(format!(
            "unknown plugin kind `{raw}` (expected plugin|skill|mcp)"
        )),
    }
}

fn kind_label(k: ManifestKind) -> &'static str {
    match k {
        ManifestKind::NativePlugin => "plugin",
        ManifestKind::Skill => "skill",
        ManifestKind::Mcp => "mcp",
    }
}

fn extract_description(m: &Manifest) -> Option<String> {
    match m {
        Manifest::Plugin(p) => Some(p.description.clone()),
        Manifest::Skill(s) => Some(s.description.clone()),
        Manifest::Mcp(_) => None,
    }
}

// ─── persistence ─────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    /// `"plugin/@scope/name"` / `"skill/@scope/name"` / `"mcp/@scope/name"`
    /// strings the user has disabled. Enable is the default; absence
    /// from this set == enabled.
    #[serde(default)]
    disabled: HashSet<String>,
}

fn state_path(install_root: &std::path::Path) -> PathBuf {
    install_root.join(".state.json")
}

fn state_key(kind: ManifestKind, id: &str) -> String {
    format!("{}/{}", kind_label(kind), id)
}

fn persist_state(
    registry: &Registry,
    install_root: &std::path::Path,
) -> Result<(), std::io::Error> {
    let mut sf = StateFile::default();
    for entry in registry.list() {
        if !entry.enabled {
            sf.disabled.insert(state_key(entry.kind, &entry.id));
        }
    }
    if let Some(parent) = state_path(install_root).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(&sf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(state_path(install_root), body)
}

fn apply_persisted_state(registry: &Registry, install_root: &std::path::Path) {
    let path = state_path(install_root);
    let raw = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return, // No state file → all enabled (default).
    };
    let sf: StateFile = match serde_json::from_slice(&raw) {
        Ok(s) => s,
        Err(_) => return, // Corrupt file → fail open (enabled).
    };
    for entry in registry.list() {
        if sf.disabled.contains(&state_key(entry.kind, &entry.id)) {
            registry.set_enabled(entry.kind, &entry.id, false);
        }
    }
}

// ─── setup helper ────────────────────────────────────────────────────

/// Build the PluginHostState used by Tauri's managed state. Performs
/// the initial scan + applies persisted enable/disable so the first
/// `plugin_list` call reflects the user's preferences.
pub fn build_state(install_root_override: Option<PathBuf>) -> PluginHostState {
    let install_root = install_root_override.unwrap_or_else(default_install_root);
    let registry = Arc::new(Registry::new());
    let _ = std::fs::create_dir_all(&install_root); // best-effort
    registry.scan(&install_root);
    apply_persisted_state(&registry, &install_root);
    // Best-effort watcher — failure here is non-fatal, the registry
    // still serves what it scanned at startup. The shell can recover
    // via `plugin_rescan` when the user expects new state.
    let _ = registry.watch(&install_root);
    PluginHostState {
        registry,
        install_root,
    }
}
