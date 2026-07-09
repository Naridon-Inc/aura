//! Manifest types for the three plugin kinds.
//!
//! Serde deserializes the JSON; `validate()` runs the structural checks
//! that can't be encoded in the type system (semver shape on `version`
//! and `engines.aura`, well-formed capability strings, kind-specific
//! required-field presence, plugin id namespacing).
//!
//! Errors carry both a human-readable message and a JSON pointer to the
//! offending field so the registry's loader (W0.2) can render a clear
//! "this plugin is rejected because…" message without re-parsing the
//! source.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::capability::CapabilitySet;
use super::secrets::valid_secret_key;

// ─── kind dispatch ───────────────────────────────────────────────────

/// Which manifest variant this directory holds. Distinguished by the
/// filename the registry found (not by a field in the file) — keeps
/// the three schemas independent and forward-compatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ManifestKind {
    NativePlugin,
    Skill,
    Mcp,
}

impl ManifestKind {
    /// Filename the kind ships under, by convention.
    pub const fn filename(self) -> &'static str {
        match self {
            ManifestKind::NativePlugin => "aura.plugin.json",
            ManifestKind::Skill => "aura.skill.json",
            ManifestKind::Mcp => "aura.mcp.json",
        }
    }

    /// Reverse lookup — used by the scanner when walking a plugin
    /// directory and deciding which parse path to take.
    pub fn from_filename(name: &str) -> Option<Self> {
        match name {
            "aura.plugin.json" => Some(Self::NativePlugin),
            "aura.skill.json" => Some(Self::Skill),
            "aura.mcp.json" => Some(Self::Mcp),
            _ => None,
        }
    }
}

/// Unified handle so the registry can store all three kinds together
/// without losing strong typing at consumption sites.
#[derive(Debug, Clone)]
pub enum Manifest {
    Plugin(NativePluginManifest),
    Skill(SkillManifest),
    Mcp(McpManifest),
}

impl Manifest {
    pub fn id(&self) -> &str {
        match self {
            Manifest::Plugin(m) => &m.id,
            Manifest::Skill(m) => &m.id,
            Manifest::Mcp(m) => &m.id,
        }
    }

    pub fn version(&self) -> &str {
        match self {
            Manifest::Plugin(m) => &m.version,
            Manifest::Skill(m) => &m.version,
            Manifest::Mcp(m) => &m.version,
        }
    }

    pub fn kind(&self) -> ManifestKind {
        match self {
            Manifest::Plugin(_) => ManifestKind::NativePlugin,
            Manifest::Skill(_) => ManifestKind::Skill,
            Manifest::Mcp(_) => ManifestKind::Mcp,
        }
    }

    pub fn engines_aura(&self) -> &str {
        match self {
            Manifest::Plugin(m) => &m.engines.aura,
            Manifest::Skill(m) => &m.engines.aura,
            Manifest::Mcp(m) => &m.engines.aura,
        }
    }

    /// Run kind-specific structural validation on top of the type-level
    /// deserialization checks. Called once after `parse_from_path`.
    pub fn validate(&self) -> Result<(), ManifestError> {
        match self {
            Manifest::Plugin(m) => m.validate(),
            Manifest::Skill(m) => m.validate(),
            Manifest::Mcp(m) => m.validate(),
        }
    }
}

// ─── shared types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Engines {
    /// Semver range string, e.g. ">=0.12.0 <0.14.0". The registry's
    /// version resolver (W1) parses this; here we only check that it
    /// is non-empty.
    pub aura: String,
}

// ─── native plugin ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NativePluginManifest {
    pub schema: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub publisher: String,
    pub engines: Engines,
    pub description: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub entry: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, rename = "activationEvents")]
    pub activation_events: Vec<String>,
    #[serde(default)]
    pub contributes: PluginContributes,
    #[serde(default)]
    pub secrets: Vec<SecretDecl>,
    /// Host-side credential injections (the mini-app network seam). Each
    /// binding lets the host attach a keychain secret to outbound
    /// `net.fetch` requests for a given host — the sandbox never sees the
    /// value. Validated fail-closed at scan: see `validate()`.
    #[serde(default, rename = "netAuth")]
    pub net_auth: Vec<NetAuthBinding>,
    #[serde(default)]
    pub signature: Option<Signature>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PluginContributes {
    #[serde(default, rename = "slashCommands")]
    pub slash_commands: Vec<SlashCommandContrib>,
    #[serde(default, rename = "railTiles")]
    pub rail_tiles: Vec<RailTileContrib>,
    #[serde(default, rename = "rightRailPanels")]
    pub right_rail_panels: Vec<RightRailPanelContrib>,
    #[serde(default, rename = "statusPills")]
    pub status_pills: Vec<StatusPillContrib>,
    /// Full-surface mini-apps (Gmail/Gemini/Reddit-style clients). Unlike
    /// `rightRailPanels` these open in the center WorkSurface as a large
    /// sandboxed iframe, not the narrow rail.
    #[serde(default)]
    pub apps: Vec<AppContrib>,
    #[serde(default, rename = "preToolHooks")]
    pub pre_tool_hooks: Vec<ToolHookContrib>,
    #[serde(default, rename = "postToolHooks")]
    pub post_tool_hooks: Vec<ToolHookContrib>,
    #[serde(default)]
    pub workflows: Option<WorkflowContribs>,
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlashCommandContrib {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RailTileContrib {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default, rename = "defaultPinned")]
    pub default_pinned: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RightRailPanelContrib {
    pub id: String,
    pub title: String,
    pub entry: String,
    #[serde(default, rename = "linkedRailTile")]
    pub linked_rail_tile: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StatusPillContrib {
    pub id: String,
    /// "worker:status" or another well-known render kind (W1 expands).
    pub render: String,
}

/// A full-surface mini-app contributed by a plugin. Renders in the
/// center WorkSurface as a large sandboxed iframe (same `allow-scripts`
/// opaque-origin sandbox + postMessage bridge as a rail panel) — the
/// home for Gmail/Gemini/Reddit-style clients people "do things" in.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppContrib {
    pub id: String,
    pub title: String,
    /// Relative path to the app's HTML entry inside the bundle. Loaded
    /// through the jailed asset reader, exactly like a rail panel's entry.
    pub entry: String,
    #[serde(default)]
    pub icon: Option<String>,
}

/// Host-side credential injection for outbound `net.fetch`. The host
/// resolves `secret` from the OS keychain and attaches it to requests
/// whose host matches `host` — the sandboxed plugin never sees the
/// value. This is what lets a mini-app call an authenticated API (an API
/// key today, an OAuth `Bearer` token later) without ever holding the
/// credential. Every field is checked fail-closed at scan time
/// (`NativePluginManifest::validate`): the secret must be declared in
/// `secrets` AND granted via `secrets:<id>`, and the host must be granted
/// via `net:fetch:<host>` — so a plugin can never ship a binding that
/// smuggles a credential to a host or key the user never approved.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NetAuthBinding {
    /// Host (or glob) the injection applies to, e.g.
    /// `generativelanguage.googleapis.com` or `*.googleapis.com`.
    pub host: String,
    /// Secret id to resolve (snake-case; see `valid_secret_key`).
    pub secret: String,
    pub inject: NetInject,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NetInject {
    /// Where to attach the secret: `"header"` or `"query"`.
    pub kind: String,
    /// Header name (e.g. `Authorization`) or query-param name (e.g. `key`).
    pub name: String,
    /// Value template; the literal `${secret}` is replaced with the
    /// resolved value. e.g. `Bearer ${secret}` (header) or `${secret}`
    /// (query). Must contain the placeholder so the secret is actually used.
    pub template: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolHookContrib {
    pub id: String,
    #[serde(default, rename = "matchTool")]
    pub match_tool: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct WorkflowContribs {
    #[serde(default)]
    pub triggers: Vec<WorkflowTriggerDecl>,
    #[serde(default)]
    pub actions: Vec<WorkflowActionDecl>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkflowTriggerDecl {
    pub id: String,
    #[serde(default)]
    pub schema: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WorkflowActionDecl {
    pub id: String,
    #[serde(default)]
    pub inputs: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SecretDecl {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Signature {
    pub algorithm: String,
    #[serde(rename = "publisher_key_id")]
    pub publisher_key_id: String,
    pub signature: String,
}

impl NativePluginManifest {
    fn validate(&self) -> Result<(), ManifestError> {
        require_non_empty(&self.id, "/id")?;
        require_plugin_id(&self.id, "/id")?;
        require_non_empty(&self.name, "/name")?;
        require_semver(&self.version, "/version")?;
        require_non_empty(&self.publisher, "/publisher")?;
        require_non_empty(&self.engines.aura, "/engines/aura")?;
        require_non_empty(&self.entry, "/entry")?;
        for (i, cap) in self.capabilities.iter().enumerate() {
            require_capability(cap, &format!("/capabilities/{i}"))?;
        }
        // Activation events: free-form for now ("onStartup", "onSlashCommand:/foo")
        // but the empty string is never meaningful.
        for (i, ev) in self.activation_events.iter().enumerate() {
            require_non_empty(ev, &format!("/activationEvents/{i}"))?;
        }
        // Mini-app contributions: id/title/entry must be present. The
        // entry path is read through the jailed asset reader at mount
        // time, so the path-escape guard lives there; here we only catch
        // an obviously empty contribution.
        for (i, app) in self.contributes.apps.iter().enumerate() {
            let ptr = format!("/contributes/apps/{i}");
            require_non_empty(&app.id, &format!("{ptr}/id"))?;
            require_non_empty(&app.title, &format!("{ptr}/title"))?;
            require_non_empty(&app.entry, &format!("{ptr}/entry"))?;
        }
        // Credential injections — the security keystone. Validate fail
        // closed: a binding may only reach a secret this manifest both
        // DECLARED (`secrets`) and was GRANTED (`secrets:<id>`), targeting
        // a host it was granted to fetch (`net:fetch:<host>`). Anything
        // malformed or over-reaching rejects the whole manifest, so a
        // plugin can never load a binding that would smuggle a credential
        // to a host or key the user never approved.
        if !self.net_auth.is_empty() {
            let caps = CapabilitySet::from_manifest_strings(&self.capabilities)
                .map_err(|e| ManifestError::structural("/capabilities", &e.to_string()))?;
            for (i, b) in self.net_auth.iter().enumerate() {
                let ptr = format!("/netAuth/{i}");
                require_non_empty(&b.host, &format!("{ptr}/host"))?;
                if !valid_secret_key(&b.secret) {
                    return Err(ManifestError::structural(
                        &format!("{ptr}/secret"),
                        "secret must be a snake-case id (a-z, 0-9, '_', '-')",
                    ));
                }
                if !self.secrets.iter().any(|s| s.id == b.secret) {
                    return Err(ManifestError::structural(
                        &format!("{ptr}/secret"),
                        "secret is not declared in the manifest `secrets` list",
                    ));
                }
                if !caps.allows("secrets", &b.secret, None) {
                    return Err(ManifestError::structural(
                        &format!("{ptr}/secret"),
                        "manifest does not grant capability `secrets:<id>` for this secret",
                    ));
                }
                if !caps.allows("net", "fetch", Some(&b.host)) {
                    return Err(ManifestError::structural(
                        &format!("{ptr}/host"),
                        "manifest does not grant capability `net:fetch:<host>` for this host",
                    ));
                }
                match b.inject.kind.as_str() {
                    "header" | "query" => {}
                    _ => {
                        return Err(ManifestError::structural(
                            &format!("{ptr}/inject/kind"),
                            "inject.kind must be \"header\" or \"query\"",
                        ))
                    }
                }
                require_non_empty(&b.inject.name, &format!("{ptr}/inject/name"))?;
                if !b.inject.template.contains("${secret}") {
                    return Err(ManifestError::structural(
                        &format!("{ptr}/inject/template"),
                        "inject.template must contain the ${secret} placeholder",
                    ));
                }
            }
        }
        Ok(())
    }
}

// ─── skill ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SkillManifest {
    pub schema: String,
    pub id: String,
    pub version: String,
    pub engines: Engines,
    pub description: String,
    #[serde(default)]
    pub agents: Vec<String>,
    /// Relative path inside the skill directory to the markdown body.
    pub body: String,
    #[serde(default)]
    pub frontmatter: Option<serde_json::Value>,
}

impl SkillManifest {
    fn validate(&self) -> Result<(), ManifestError> {
        require_non_empty(&self.id, "/id")?;
        require_plugin_id(&self.id, "/id")?;
        require_semver(&self.version, "/version")?;
        require_non_empty(&self.engines.aura, "/engines/aura")?;
        require_non_empty(&self.description, "/description")?;
        require_non_empty(&self.body, "/body")?;
        // Body must be a relative path — absolute paths or "../escape"
        // are rejected. The full file existence check happens in W0.2
        // when the registry walks the install dir.
        let bp = Path::new(&self.body);
        if bp.is_absolute() {
            return Err(ManifestError::structural(
                "/body",
                "skill body path must be relative to the skill directory",
            ));
        }
        if bp.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err(ManifestError::structural(
                "/body",
                "skill body path may not escape the skill directory ('..' is disallowed)",
            ));
        }
        Ok(())
    }
}

// ─── mcp server ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct McpManifest {
    pub schema: String,
    pub id: String,
    pub version: String,
    pub engines: Engines,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Environment variables. Values may interpolate `${secrets:<key>}`
    /// — the secrets broker (W2.2) resolves these before spawn.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The tools the server advertises. Used at registration time so the
    /// host can route `host.mcp.call(tool, …)` calls without first
    /// spawning the subprocess (W2.3).
    #[serde(default)]
    pub tools: Vec<String>,
}

impl McpManifest {
    fn validate(&self) -> Result<(), ManifestError> {
        require_non_empty(&self.id, "/id")?;
        require_plugin_id(&self.id, "/id")?;
        require_semver(&self.version, "/version")?;
        require_non_empty(&self.engines.aura, "/engines/aura")?;
        require_non_empty(&self.command, "/command")?;
        for (i, cap) in self.capabilities.iter().enumerate() {
            require_capability(cap, &format!("/capabilities/{i}"))?;
        }
        Ok(())
    }
}

// ─── parser entry points ─────────────────────────────────────────────

/// Read + parse + validate a manifest from a file path. The filename
/// must match one of the three kinds; otherwise returns
/// `ManifestError::UnknownKind`.
pub fn parse_from_path(path: &Path) -> Result<Manifest, ManifestError> {
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(ManifestError::UnknownKind)?;
    let kind = ManifestKind::from_filename(filename).ok_or(ManifestError::UnknownKind)?;
    let raw = std::fs::read_to_string(path)
        .map_err(|e| ManifestError::Io(format!("{}: {e}", path.display())))?;
    let m = parse_from_str(kind, &raw)?;
    m.validate()?;
    Ok(m)
}

/// Parse + validate a manifest from a JSON string. Useful from tests
/// and from the scanner when the file contents are already in memory.
pub fn parse_from_str(kind: ManifestKind, raw: &str) -> Result<Manifest, ManifestError> {
    let m = match kind {
        ManifestKind::NativePlugin => Manifest::Plugin(
            serde_json::from_str::<NativePluginManifest>(raw).map_err(ManifestError::from_serde)?,
        ),
        ManifestKind::Skill => Manifest::Skill(
            serde_json::from_str::<SkillManifest>(raw).map_err(ManifestError::from_serde)?,
        ),
        ManifestKind::Mcp => Manifest::Mcp(
            serde_json::from_str::<McpManifest>(raw).map_err(ManifestError::from_serde)?,
        ),
    };
    m.validate()?;
    Ok(m)
}

// ─── validators ──────────────────────────────────────────────────────

fn require_non_empty(value: &str, pointer: &str) -> Result<(), ManifestError> {
    if value.trim().is_empty() {
        return Err(ManifestError::structural(
            pointer,
            "value must be a non-empty string",
        ));
    }
    Ok(())
}

/// Plugin ids follow the npm-style `@scope/name` form.
fn require_plugin_id(value: &str, pointer: &str) -> Result<(), ManifestError> {
    let trimmed = value.trim();
    if !trimmed.starts_with('@') || !trimmed.contains('/') {
        return Err(ManifestError::structural(
            pointer,
            "plugin id must follow the `@scope/name` form (e.g. `@aura-demo/linear`)",
        ));
    }
    let rest = &trimmed[1..];
    let mut parts = rest.splitn(2, '/');
    let scope = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if scope.is_empty() || name.is_empty() {
        return Err(ManifestError::structural(
            pointer,
            "plugin id scope and name must both be non-empty",
        ));
    }
    for part in [scope, name] {
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(ManifestError::structural(
                pointer,
                "plugin id parts may only contain a-z, 0-9, '-' and '_'",
            ));
        }
    }
    Ok(())
}

/// Minimal semver shape check — `MAJOR.MINOR.PATCH` with optional
/// pre-release suffix. Full range parsing happens in W1 when the
/// version resolver lands.
fn require_semver(value: &str, pointer: &str) -> Result<(), ManifestError> {
    let core = value.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 || !parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
        return Err(ManifestError::structural(
            pointer,
            "version must be a semver `MAJOR.MINOR.PATCH` string",
        ));
    }
    Ok(())
}

/// Capability strings live in a flat `family:verb[:scope]` form. The
/// host only enforces the well-known families at this layer; unknown
/// families are accepted so plugin authors can prototype new ones (the
/// gate that actually enforces a permission lives in the bridge layer
/// in W1.1).
fn require_capability(value: &str, pointer: &str) -> Result<(), ManifestError> {
    if value.trim().is_empty() {
        return Err(ManifestError::structural(
            pointer,
            "capability string must be non-empty",
        ));
    }
    let mut parts = value.split(':');
    let family = parts.next().unwrap_or("");
    let verb = parts.next().unwrap_or("");
    if family.is_empty() || verb.is_empty() {
        return Err(ManifestError::structural(
            pointer,
            "capability must take the form `family:verb[:scope]` (e.g. `net:fetch:*.linear.app`)",
        ));
    }
    // Scope segment is optional and free-form (host evaluates globs at
    // call time). Anything past the third colon collapses back into the
    // scope segment when split() is consumed lazily — that's fine.
    Ok(())
}

// ─── errors ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum ManifestError {
    /// File extension/name did not match one of the three known kinds.
    UnknownKind,
    /// Filesystem read failed.
    Io(String),
    /// Serde-level parse failure with the JSON path it surfaced at.
    Parse { pointer: String, message: String },
    /// Structural validation failure — types parsed but the values
    /// didn't satisfy the kind's constraints.
    Structural { pointer: String, message: String },
}

impl ManifestError {
    fn structural(pointer: &str, message: &str) -> Self {
        Self::Structural {
            pointer: pointer.to_string(),
            message: message.to_string(),
        }
    }

    fn from_serde(err: serde_json::Error) -> Self {
        // serde_json::Error doesn't expose a stable JSON-path accessor,
        // so we surface line/col instead. Good enough for the user-facing
        // "this plugin is rejected because…" message; W0.2's loader can
        // re-print the offending line if it wants more context.
        Self::Parse {
            pointer: format!("line {}, col {}", err.line(), err.column()),
            message: err.to_string(),
        }
    }
}

impl std::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownKind => write!(f, "manifest filename does not match a known plugin kind"),
            Self::Io(s) => write!(f, "manifest io error: {s}"),
            Self::Parse { pointer, message } => write!(f, "manifest parse at {pointer}: {message}"),
            Self::Structural { pointer, message } => {
                write!(f, "manifest invalid at {pointer}: {message}")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

// ─── tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin_ok() -> &'static str {
        r#"{
            "schema": "https://aura.dev/schemas/plugin@1",
            "id": "@aura-demo/linear",
            "name": "Linear",
            "version": "0.1.0",
            "publisher": "aura-demo",
            "engines": { "aura": ">=0.12.0 <0.14.0" },
            "description": "Bidirectional Linear sync.",
            "entry": "dist/plugin.js",
            "capabilities": ["net:fetch:api.linear.app", "ui:slash-command"],
            "activationEvents": ["onStartup"]
        }"#
    }

    #[test]
    fn parses_plugin_happy_path() {
        let m = parse_from_str(ManifestKind::NativePlugin, plugin_ok()).expect("parse");
        assert_eq!(m.id(), "@aura-demo/linear");
        assert_eq!(m.version(), "0.1.0");
        assert_eq!(m.kind(), ManifestKind::NativePlugin);
    }

    #[test]
    fn rejects_bad_plugin_id() {
        let bad = plugin_ok().replace("@aura-demo/linear", "linear");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    #[test]
    fn rejects_non_semver_version() {
        let bad = plugin_ok().replace("0.1.0", "v0.1");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    #[test]
    fn rejects_empty_engines_aura() {
        let bad = plugin_ok().replace(">=0.12.0 <0.14.0", "");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    #[test]
    fn rejects_capability_without_verb() {
        let bad = plugin_ok().replace("net:fetch:api.linear.app", "net");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    #[test]
    fn parses_skill_happy_path() {
        let raw = r#"{
            "schema": "https://aura.dev/schemas/skill@1",
            "id": "@aura-demo/linear-skill",
            "version": "0.1.0",
            "engines": { "aura": ">=0.12.0" },
            "description": "Writing crisp Linear issues from PR diffs.",
            "agents": ["claude"],
            "body": "skill.md"
        }"#;
        let m = parse_from_str(ManifestKind::Skill, raw).expect("parse");
        assert!(matches!(m, Manifest::Skill(_)));
    }

    #[test]
    fn rejects_skill_absolute_body() {
        let raw = r#"{
            "schema": "https://aura.dev/schemas/skill@1",
            "id": "@aura-demo/skill",
            "version": "0.1.0",
            "engines": { "aura": ">=0.12.0" },
            "description": "x",
            "body": "/etc/passwd"
        }"#;
        let e = parse_from_str(ManifestKind::Skill, raw).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    #[test]
    fn rejects_skill_escaping_body() {
        let raw = r#"{
            "schema": "https://aura.dev/schemas/skill@1",
            "id": "@aura-demo/skill",
            "version": "0.1.0",
            "engines": { "aura": ">=0.12.0" },
            "description": "x",
            "body": "../../../etc/passwd"
        }"#;
        let e = parse_from_str(ManifestKind::Skill, raw).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    #[test]
    fn parses_mcp_happy_path() {
        let raw = r#"{
            "schema": "https://aura.dev/schemas/mcp@1",
            "id": "@aura-demo/linear-mcp",
            "version": "0.1.0",
            "engines": { "aura": ">=0.12.0" },
            "command": "node",
            "args": ["./dist/server.js"],
            "env": { "LINEAR_API_TOKEN": "${secrets:linear_api_token}" },
            "capabilities": ["secrets:linear_api_token", "net:fetch:api.linear.app"],
            "tools": ["linear_issues_list"]
        }"#;
        let m = parse_from_str(ManifestKind::Mcp, raw).expect("parse");
        assert!(matches!(m, Manifest::Mcp(_)));
    }

    #[test]
    fn rejects_mcp_without_command() {
        let raw = r#"{
            "schema": "https://aura.dev/schemas/mcp@1",
            "id": "@aura-demo/m",
            "version": "0.1.0",
            "engines": { "aura": ">=0.12.0" },
            "command": ""
        }"#;
        let e = parse_from_str(ManifestKind::Mcp, raw).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }));
    }

    fn plugin_with_net_auth(extra: &str) -> String {
        format!(
            r#"{{
                "schema": "https://aura.dev/schemas/plugin@1",
                "id": "@aura/gemini",
                "name": "Gemini",
                "version": "0.1.0",
                "publisher": "aura",
                "engines": {{ "aura": ">=0.17.0" }},
                "description": "Gemini chat.",
                "entry": "worker.js",
                "capabilities": ["net:fetch:generativelanguage.googleapis.com", "secrets:gemini_api_key"],
                "secrets": [{{ "id": "gemini_api_key", "title": "Gemini API key" }}],
                "netAuth": [{{
                    "host": "generativelanguage.googleapis.com",
                    "secret": "gemini_api_key",
                    "inject": {{ "kind": "query", "name": "key", "template": "${{secret}}" }}
                }}]
                {extra}
            }}"#
        )
    }

    #[test]
    fn accepts_well_formed_net_auth() {
        let m = parse_from_str(ManifestKind::NativePlugin, &plugin_with_net_auth(""))
            .expect("valid net_auth should parse");
        match m {
            Manifest::Plugin(p) => {
                assert_eq!(p.net_auth.len(), 1);
                assert_eq!(p.net_auth[0].secret, "gemini_api_key");
                assert_eq!(p.net_auth[0].inject.kind, "query");
            }
            _ => panic!("expected plugin"),
        }
    }

    #[test]
    fn rejects_net_auth_secret_not_declared() {
        // Binding references a secret missing from the `secrets` list.
        let bad = plugin_with_net_auth("")
            .replace("\"id\": \"gemini_api_key\"", "\"id\": \"other_key\"");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }), "{e:?}");
    }

    #[test]
    fn rejects_net_auth_host_without_fetch_capability() {
        // Binding targets a host the net:fetch capability doesn't cover.
        let bad = plugin_with_net_auth("").replace(
            "\"host\": \"generativelanguage.googleapis.com\",\n                    \"secret\"",
            "\"host\": \"evil.example.com\",\n                    \"secret\"",
        );
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }), "{e:?}");
    }

    #[test]
    fn rejects_net_auth_secret_without_capability() {
        // Drop the `secrets:gemini_api_key` grant — declared but not granted.
        let bad = plugin_with_net_auth("").replace(", \"secrets:gemini_api_key\"", "");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }), "{e:?}");
    }

    #[test]
    fn rejects_net_auth_template_without_placeholder() {
        let bad = plugin_with_net_auth("").replace("\"template\": \"${secret}\"", "\"template\": \"static\"");
        let e = parse_from_str(ManifestKind::NativePlugin, &bad).unwrap_err();
        assert!(matches!(e, ManifestError::Structural { .. }), "{e:?}");
    }

    #[test]
    fn unknown_filename_returns_unknown_kind() {
        // Use parse_from_path with a non-existent file; we just want the
        // kind detection branch.
        let p = Path::new("/tmp/aura.weird.json");
        let e = parse_from_path(p).unwrap_err();
        assert!(matches!(e, ManifestError::UnknownKind | ManifestError::Io(_)));
    }

    /// The shipped @aura/gemini reference app must always parse + validate —
    /// it is the canonical proof of the `apps` + `netAuth` (host-side
    /// credential injection) pipeline, so a regression in either struct or
    /// the fail-closed validation should break the build here, not in prod.
    #[test]
    fn gemini_reference_bundle_validates() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/plugins/@aura/gemini/aura.plugin.json");
        let m = parse_from_path(&path).expect("gemini manifest parses");
        m.validate().expect("gemini manifest validates");
        match m {
            Manifest::Plugin(p) => {
                assert_eq!(p.id, "@aura/gemini");
                assert_eq!(p.contributes.apps.len(), 1);
                assert_eq!(p.contributes.apps[0].id, "chat");
                assert_eq!(p.net_auth.len(), 1);
                assert_eq!(p.net_auth[0].host, "generativelanguage.googleapis.com");
                assert_eq!(p.net_auth[0].inject.kind, "query");
            }
            _ => panic!("expected a native plugin manifest"),
        }
    }

    /// The shipped @aura/reddit reference app must always parse + validate. It
    /// is the canonical proof that a mini-app needs NEITHER `secrets` NOR
    /// `netAuth` to reach a public API — just a `net:fetch:<host>` capability.
    /// A regression that started requiring those (or dropped the `apps`
    /// contribution) should break the build here, not in prod.
    #[test]
    fn reddit_reference_bundle_validates() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../examples/plugins/@aura/reddit/aura.plugin.json");
        let m = parse_from_path(&path).expect("reddit manifest parses");
        m.validate().expect("reddit manifest validates");
        match m {
            Manifest::Plugin(p) => {
                assert_eq!(p.id, "@aura/reddit");
                assert_eq!(p.contributes.apps.len(), 1);
                assert_eq!(p.contributes.apps[0].id, "reader");
                assert!(p.net_auth.is_empty(), "reddit declares no netAuth");
                assert!(p.secrets.is_empty(), "reddit declares no secrets");
                assert!(
                    p.capabilities
                        .iter()
                        .any(|c| c == "net:fetch:www.reddit.com"),
                    "reddit grants net:fetch for www.reddit.com"
                );
            }
            _ => panic!("expected a native plugin manifest"),
        }
    }
}
