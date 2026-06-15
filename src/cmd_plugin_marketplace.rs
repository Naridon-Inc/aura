//! `aura plugin <list|enable|disable|rescan>` — read-only scanner over
//! `~/.aura/plugins/<scope>/<name>/aura.{plugin,skill,mcp}.json`.
//!
//! Parallel to the shell-side `plugin_host::Registry` (W0.2). Reads the
//! same on-disk shape, mutates the same `.state.json` file. Importantly
//! the CLI does NOT load capabilities, hooks, or watch the directory —
//! that's the shell's job. We only need enough manifest fields to print
//! a table and toggle the enabled bit.
//!
//! Why a parallel implementation: aura-cli is excluded from the cargo
//! workspace (standalone tool), so it cannot depend on aura-shell's
//! `plugin_host` module. Keeping both readers tiny means the schema is
//! the source of truth, not either implementation.

use clap::Subcommand;
use colored::Colorize;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Subcommand)]
pub enum PluginSubcommands {
    /// List installed plugins, skills, and MCP servers.
    List {
        /// Only show entries of this kind. One of: plugin|skill|mcp.
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Re-scan the install root and print a brief report.
    Rescan {
        #[arg(long)]
        json: bool,
    },
    /// Enable a previously disabled entry. `kind` is plugin|skill|mcp.
    Enable { kind: String, id: String },
    /// Disable an entry. The shell will skip it on next launch.
    Disable { kind: String, id: String },
    /// Scaffold a new plugin bundle in ./<name> (id = @scope/name).
    New { id: String },
    /// Symlink a plugin working tree into ~/.aura/plugins for live dev.
    Link { dir: PathBuf },
    /// Create (or reuse) your dev signing key + trust it locally.
    Keygen {
        /// Publisher label shown next to the verified badge.
        #[arg(long)]
        publisher: String,
    },
    /// Sign a bundle — embeds an ed25519 signature in aura.plugin.json.
    Sign { dir: PathBuf },
    /// Verify a bundle the way the desktop shell will at scan time.
    Verify { dir: PathBuf },
    /// Trust a publisher's public key (base64, 32-byte ed25519).
    Trust {
        #[arg(long)]
        publisher: String,
        #[arg(long)]
        public_key: String,
    },
}

pub fn run(sub: &PluginSubcommands) -> Result<(), Box<dyn std::error::Error>> {
    let root = default_install_root();
    match sub {
        PluginSubcommands::List { kind, json } => {
            let entries = scan(&root)?;
            let filtered: Vec<_> = match kind.as_deref() {
                Some(k) => {
                    let want = parse_kind_label(k)?;
                    entries.into_iter().filter(|e| e.kind == want).collect()
                }
                None => entries,
            };
            if *json {
                println!("{}", serde_json::to_string_pretty(&filtered)?);
            } else {
                print_table(&filtered);
            }
            Ok(())
        }
        PluginSubcommands::Rescan { json } => {
            let entries = scan(&root)?;
            let report = RescanReport {
                install_root: root.display().to_string(),
                loaded: entries.len(),
            };
            if *json {
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                println!(
                    "{} {} entries from {}",
                    "rescan:".bold(),
                    report.loaded,
                    report.install_root.dimmed()
                );
            }
            Ok(())
        }
        PluginSubcommands::Enable { kind, id } => set_enabled(&root, kind, id, true),
        PluginSubcommands::Disable { kind, id } => set_enabled(&root, kind, id, false),
        PluginSubcommands::New { id } => crate::cmd_plugin_dev::scaffold(id),
        PluginSubcommands::Link { dir } => crate::cmd_plugin_dev::link(dir, &root),
        PluginSubcommands::Keygen { publisher } => crate::cmd_plugin_dev::keygen(publisher),
        PluginSubcommands::Sign { dir } => crate::cmd_plugin_dev::sign(dir),
        PluginSubcommands::Verify { dir } => crate::cmd_plugin_dev::verify(dir),
        PluginSubcommands::Trust {
            publisher,
            public_key,
        } => crate::cmd_plugin_dev::trust(publisher, public_key),
    }
}

// ─── scanning ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Plugin,
    Skill,
    Mcp,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Plugin => "plugin",
            Kind::Skill => "skill",
            Kind::Mcp => "mcp",
        }
    }
}

fn parse_kind_label(raw: &str) -> Result<Kind, Box<dyn std::error::Error>> {
    match raw {
        "plugin" => Ok(Kind::Plugin),
        "skill" => Ok(Kind::Skill),
        "mcp" => Ok(Kind::Mcp),
        _ => Err(format!("unknown plugin kind `{raw}` (expected plugin|skill|mcp)").into()),
    }
}

#[derive(Debug, Serialize)]
pub struct PluginRow {
    pub id: String,
    pub kind: Kind,
    pub version: String,
    pub enabled: bool,
    pub description: Option<String>,
    pub capabilities_count: usize,
    pub install_dir: String,
    /// Bundle signature verdict: unsigned | verified | unknown_key |
    /// invalid. The CLI only *reports* invalid — enforcement (refusing
    /// to load) is the shell's job at scan time.
    pub signature: String,
    /// Publisher label (verified) or bare key id (unknown_key).
    pub signed_by: Option<String>,
}

#[derive(Debug, Serialize)]
struct RescanReport {
    install_root: String,
    loaded: usize,
}

/// Cheapest manifest shape we can get away with: id/version/description
/// plus the capability list count. Anything richer lives in the shell's
/// validator.
#[derive(Debug, Deserialize)]
struct ManifestMin {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
}

fn scan(root: &Path) -> Result<Vec<PluginRow>, Box<dyn std::error::Error>> {
    let disabled = load_disabled(root);
    // One trust-store read per scan; one verification per bundle dir
    // (every manifest in a dir shares the bundle's verdict).
    let trust = match aura_plugin_sign::TrustStore::load(
        &aura_plugin_sign::TrustStore::default_path(),
    ) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "{} plugin trust store unreadable ({e}) — signatures shown as unverified",
                "warning:".yellow().bold()
            );
            aura_plugin_sign::TrustStore::default()
        }
    };
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(out);
    }
    // <root>/<scope>/<name>/aura.<kind>.json
    for scope_entry in fs_dir(root)? {
        let scope_path = scope_entry.path();
        if !scope_path.is_dir() {
            continue;
        }
        for plugin_entry in fs_dir(&scope_path)? {
            let dir = plugin_entry.path();
            if !dir.is_dir() {
                continue;
            }
            let (signature, signed_by) =
                signature_fields(&aura_plugin_sign::verify_bundle(&dir, &trust));
            for (filename, kind) in [
                ("aura.plugin.json", Kind::Plugin),
                ("aura.skill.json", Kind::Skill),
                ("aura.mcp.json", Kind::Mcp),
            ] {
                let manifest_path = dir.join(filename);
                if !manifest_path.is_file() {
                    continue;
                }
                let raw = match std::fs::read_to_string(&manifest_path) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let parsed: ManifestMin = match serde_json::from_str(&raw) {
                    Ok(m) => m,
                    Err(_) => continue, // shell-side validator owns rejection display
                };
                let dir_id = derive_id_from_dir(&dir);
                let id = parsed.id.unwrap_or_else(|| dir_id.clone());
                let key = format!("{}/{}", kind.label(), id);
                out.push(PluginRow {
                    id,
                    kind,
                    version: parsed.version.unwrap_or_else(|| "0.0.0".to_string()),
                    enabled: !disabled.contains(&key),
                    description: parsed.description,
                    capabilities_count: parsed.capabilities.len(),
                    install_dir: dir.display().to_string(),
                    signature: signature.clone(),
                    signed_by: signed_by.clone(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.kind.label().cmp(b.kind.label()).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// Flatten the bundle verdict into the same string contract the shell
/// emits over its `plugin_list` bridge, plus `invalid` (which the
/// shell never lists — it rejects at scan; the CLI shows everything).
fn signature_fields(status: &aura_plugin_sign::SignatureStatus) -> (String, Option<String>) {
    use aura_plugin_sign::SignatureStatus as S;
    match status {
        S::Unsigned => ("unsigned".to_string(), None),
        S::Verified { publisher, .. } => ("verified".to_string(), Some(publisher.clone())),
        S::UnknownKey { publisher_key_id } => {
            ("unknown_key".to_string(), Some(publisher_key_id.clone()))
        }
        S::Invalid { .. } => ("invalid".to_string(), None),
    }
}

fn derive_id_from_dir(dir: &Path) -> String {
    let name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("unknown");
    let scope = dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    format!("{}/{}", scope, name)
}

fn fs_dir(path: &Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
    let mut v: Vec<_> = std::fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
    v.sort_by_key(|e| e.file_name());
    Ok(v)
}

// ─── persistence (mirrors aura-shell cmd_plugin.rs::StateFile) ──────

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default)]
    disabled: HashSet<String>,
}

fn state_path(install_root: &Path) -> PathBuf {
    install_root.join(".state.json")
}

fn load_disabled(install_root: &Path) -> HashSet<String> {
    let raw = match std::fs::read(state_path(install_root)) {
        Ok(b) => b,
        Err(_) => return HashSet::new(),
    };
    match serde_json::from_slice::<StateFile>(&raw) {
        Ok(s) => s.disabled,
        Err(_) => HashSet::new(),
    }
}

fn set_enabled(
    root: &Path,
    kind_raw: &str,
    id: &str,
    enabled: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let kind = parse_kind_label(kind_raw)?;
    let entries = scan(root)?;
    let exists = entries.iter().any(|e| e.kind == kind && e.id == id);
    if !exists {
        return Err(format!("no installed plugin matches {kind_raw}/{id}").into());
    }
    let key = format!("{}/{}", kind.label(), id);
    let mut disabled = load_disabled(root);
    if enabled {
        disabled.remove(&key);
    } else {
        disabled.insert(key);
    }
    let sf = StateFile { disabled };
    std::fs::create_dir_all(root)?;
    let body = serde_json::to_vec_pretty(&sf)?;
    std::fs::write(state_path(root), body)?;
    let verb = if enabled { "enabled" } else { "disabled" };
    eprintln!("{verb} {kind_raw}/{id}");
    Ok(())
}

// ─── output ─────────────────────────────────────────────────────────

fn print_table(rows: &[PluginRow]) {
    if rows.is_empty() {
        println!(
            "{}",
            "(no plugins installed under ~/.aura/plugins)".dimmed()
        );
        return;
    }
    println!(
        "{:<8} {:<32} {:<10} {:<7} {:<5} {:<14} {}",
        "KIND".bold(),
        "ID".bold(),
        "VERSION".bold(),
        "STATE".bold(),
        "CAPS".bold(),
        "SIGNATURE".bold(),
        "DESCRIPTION".bold()
    );
    for r in rows {
        let state = if r.enabled {
            "on".green().to_string()
        } else {
            "off".red().to_string()
        };
        let sig = match r.signature.as_str() {
            "verified" => format!("✓ {}", r.signed_by.as_deref().unwrap_or("?"))
                .green()
                .to_string(),
            "unknown_key" => "unverified".yellow().to_string(),
            "invalid" => "INVALID".red().bold().to_string(),
            _ => "unsigned".dimmed().to_string(),
        };
        let desc = r
            .description
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(50)
            .collect::<String>();
        println!(
            "{:<8} {:<32} {:<10} {:<7} {:<5} {:<14} {}",
            r.kind.label(),
            r.id,
            r.version,
            state,
            r.capabilities_count,
            sig,
            desc.dimmed()
        );
    }
}

// ─── install root ───────────────────────────────────────────────────

fn default_install_root() -> PathBuf {
    if let Ok(v) = std::env::var("AURA_PLUGIN_ROOT") {
        return PathBuf::from(v);
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".aura").join("plugins");
    }
    PathBuf::from(".aura/plugins")
}
