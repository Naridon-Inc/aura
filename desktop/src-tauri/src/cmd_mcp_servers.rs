//! MCP server registry + thin JSON-RPC 2.0 client.
//!
//! "MCP-as-plugins" pivot (2026-05). Rather than continue building the
//! bespoke worker-bridge SDK (parked under `cmd_plugin.rs` +
//! `plugin_host/`), we let MCP servers be the extension surface. Atlassian,
//! Linear, GitHub, Sentry all ship MCP servers; the user adds one to
//! `~/.aura/mcp/<name>.json`, this module spawns it on demand, asks for
//! its tool catalog, and routes composer @-mentions / slash commands
//! straight to `tools/call`.
//!
//! Why not use `rmcp` (the official Rust SDK)? It's not yet in this
//! workspace's lockfile and pulling a new top-level dep just to wrap a
//! 200-line JSON-RPC protocol is overkill. The aura-cli MCP *server* in
//! `aura-cli/src/mcp.rs` speaks the same dialect by hand — we mirror
//! that here on the *client* side. Swap in `rmcp` later if the surface
//! grows (resources, prompts, sampling); for now `tools/list` +
//! `tools/call` are all the shell needs.
//!
//! File-on-disk format (`~/.aura/mcp/<name>.json`):
//! ```json
//! {
//!   "name": "atlassian",
//!   "command": "npx",
//!   "args": ["-y", "@atlassian/mcp-server"],
//!   "env": { "ATLASSIAN_TOKEN": "..." },
//!   "enabled": true
//! }
//! ```
//!
//! Plugin-bundled servers (P2, 2026-06): bundles under
//! `~/.aura/plugins/<scope>/<name>/` may ship an `aura.mcp.json`
//! manifest. Those are unioned in at READ time (list / tools / invoke)
//! straight from the plugin registry — never materialized into
//! `~/.aura/mcp/`, so their `${secrets:…}` env placeholders resolve
//! through the keychain-backed broker at spawn and secret values never
//! touch disk. Their server name is the manifest id (`@scope/name-mcp`)
//! — ids contain `/`, file names can't, so the namespaces are disjoint.
//! File-mutating commands (remove / update-env / update-url) reject
//! them; enable/disable routes to the plugin registry's .state.json.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::cloud_session_sync::aura_dir;
use crate::cmd_plugin::PluginHostState;
use crate::plugin_host::{secrets, Manifest, ManifestKind};

/// JSON-on-disk shape for a single server config. The file name on disk
/// (`<name>.json`) is the source of truth for `name`; the field inside is
/// redundant but kept so a user-edited file round-trips cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Optional human-readable note shown next to the row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    // Wave C — remote-transport fields. All optional + skipped when
    // empty so existing stdio configs serialise identically.
    /// Remote MCP base URL (https://…). Presence implies the server is
    /// reachable via HTTP/SSE; the `command`/`args` then describe how
    /// to spawn a local proxy (typically `npx -y mcp-remote <url>`).
    /// Used by the OAuth flow to discover auth-server metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    /// Optional pre-registered OAuth client_id. Skipped if absent —
    /// the flow attempts Dynamic Client Registration in that case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
    /// Optional OAuth scope. If absent we fall back to whatever the
    /// auth-server metadata advertises in `scopes_supported`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_scope: Option<String>,
    /// Working directory for the spawned child. Plugin-bundled servers
    /// set this to their install dir so manifest-relative script paths
    /// (`args: ["server.js"]`) resolve; file-based configs leave it
    /// unset (inherit the app's cwd, as before).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

fn default_enabled() -> bool {
    true
}

/// Renderer-facing row. Mirrors the on-disk config but adds a `status`
/// field the UI can colour ("unknown" until the first `tools/list`
/// succeeds, "ok" / "error: <msg>" thereafter — populated lazily by
/// `mcp_tools_list`).
#[derive(Debug, Clone, Serialize)]
pub struct McpServerEntry {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub enabled: bool,
    pub description: Option<String>,
    /// "unknown" | "ok" | "disabled" | "error: <msg>"
    pub status: String,
    // Wave C — mirrored remote-transport fields so the renderer can
    // surface "(remote)" / "(authenticated)" badges without re-reading
    // the config from disk.
    pub server_url: Option<String>,
    pub oauth_client_id: Option<String>,
    pub oauth_scope: Option<String>,
    /// True iff `keychain_load(name)` finds a stored token blob. Lets
    /// the UI tell "needs auth" from "auth already done".
    pub has_oauth_token: bool,
    /// Set when this server comes from a plugin bundle's
    /// `aura.mcp.json` rather than `~/.aura/mcp/`. The UI badges these
    /// and hides the file-mutating actions (remove / env edit) — they
    /// are managed through the plugin lifecycle instead.
    pub plugin_id: Option<String>,
}

impl From<McpServerConfig> for McpServerEntry {
    fn from(c: McpServerConfig) -> Self {
        let status = if c.enabled { "unknown" } else { "disabled" }.to_string();
        let has_oauth_token = crate::mcp_oauth::keychain_load(&c.name)
            .ok()
            .flatten()
            .is_some();
        Self {
            name: c.name,
            command: c.command,
            args: c.args,
            env: c.env,
            enabled: c.enabled,
            description: c.description,
            status,
            server_url: c.server_url,
            oauth_client_id: c.oauth_client_id,
            oauth_scope: c.oauth_scope,
            has_oauth_token,
            plugin_id: None,
        }
    }
}

/// A single tool exposed by an MCP server. Matches the MCP spec
/// `Tool` object — we forward the JSON schema verbatim so the renderer
/// can decide how to prompt for arguments.
#[derive(Debug, Clone, Serialize)]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub description: Option<String>,
    /// JSON schema for the tool's input. `null` if the server doesn't
    /// declare one.
    pub input_schema: Value,
}

/// Returned by `mcp_tools_list` — keeps per-server results separate so
/// the UI can render an error against a single bad server without
/// dropping the others.
#[derive(Debug, Serialize)]
pub struct McpServerToolList {
    pub server: String,
    pub ok: bool,
    pub error: Option<String>,
    pub tools: Vec<McpToolInfo>,
}

/// Result of a single `tools/call`. The server's `content` array rides
/// through as opaque JSON — the renderer pretty-prints whatever shape
/// came back (text blocks, resource refs, structured data).
#[derive(Debug, Serialize)]
pub struct McpToolInvokeResult {
    pub server: String,
    pub tool: String,
    pub ok: bool,
    /// Pretty-printed result body for OutputDialog. Empty when `ok` is
    /// false (look at `error` instead).
    pub text: String,
    pub raw: Value,
    pub error: Option<String>,
}

// ─── on-disk CRUD ────────────────────────────────────────────────────

fn mcp_dir() -> Result<PathBuf, String> {
    let dir = aura_dir()?.join("mcp");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    Ok(dir)
}

fn server_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("invalid server name: {name:?}"));
    }
    Ok(mcp_dir()?.join(format!("{name}.json")))
}

fn read_config(path: &PathBuf) -> Result<McpServerConfig, String> {
    let s = std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut cfg: McpServerConfig =
        serde_json::from_str(&s).map_err(|e| format!("parse {}: {e}", path.display()))?;
    // The on-disk `name` is advisory — trust the filename so renames on
    // disk don't desync the registry.
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
        cfg.name = stem.to_string();
    }
    Ok(cfg)
}

fn write_config(cfg: &McpServerConfig) -> Result<(), String> {
    let path = server_path(&cfg.name)?;
    let body = serde_json::to_string_pretty(cfg)
        .map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn list_configs() -> Result<Vec<McpServerConfig>, String> {
    let dir = mcp_dir()?;
    let mut out = Vec::new();
    let read = std::fs::read_dir(&dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for ent in read {
        let ent = match ent {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        match read_config(&path) {
            Ok(cfg) => out.push(cfg),
            Err(e) => {
                // Don't fail the whole list on one bad file — tracing
                // surfaces it for developers without breaking the UI.
                tracing::warn!("mcp config skipped: {e}");
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

// ─── plugin-bundled servers ──────────────────────────────────────────

/// Plugin manifest ids are npm-style `@scope/name` — they always carry
/// a `/`, which `server_path` forbids in file names. That makes the
/// two namespaces disjoint and this check unambiguous.
fn is_plugin_server_name(name: &str) -> bool {
    name.starts_with('@') && name.contains('/')
}

/// Raw (uninterpolated) configs for every plugin-bundled MCP server,
/// regardless of enable state — listing shows disabled rows too.
/// `${secrets:…}` placeholders ride through verbatim; secret values
/// never reach the renderer.
fn plugin_mcp_configs(state: &PluginHostState) -> Vec<(McpServerConfig, String)> {
    state
        .registry
        .list()
        .into_iter()
        .filter(|e| e.kind == ManifestKind::Mcp)
        .filter_map(|e| match &e.manifest {
            Manifest::Mcp(m) => Some((
                McpServerConfig {
                    name: e.id.clone(),
                    command: m.command.clone(),
                    args: m.args.clone(),
                    env: m.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                    enabled: e.enabled,
                    description: Some(format!(
                        "from plugin bundle {}",
                        secrets::bundle_id_from_install_dir(&e.install_dir)
                            .unwrap_or_else(|| e.install_dir.display().to_string())
                    )),
                    server_url: None,
                    oauth_client_id: None,
                    oauth_scope: None,
                    cwd: Some(e.install_dir.display().to_string()),
                },
                e.id.clone(),
            )),
            _ => None,
        })
        .collect()
}

/// Resolve one plugin-bundled server for SPAWNING: env fully
/// interpolated through the secrets broker (keychain), gated on the
/// manifest's own `secrets:<key>` capabilities. Errors name the
/// missing key so the UI can point the user at Settings → Plugins.
fn resolve_plugin_mcp(state: &PluginHostState, name: &str) -> Result<McpServerConfig, String> {
    let entry = state
        .registry
        .get(ManifestKind::Mcp, name)
        .ok_or_else(|| format!("no plugin-bundled MCP server named '{name}'"))?;
    if !entry.enabled {
        return Err(format!("server '{name}' is disabled"));
    }
    let Manifest::Mcp(m) = &entry.manifest else {
        return Err(format!("'{name}' is not an MCP manifest"));
    };
    let bundle = secrets::bundle_id_from_install_dir(&entry.install_dir)
        .ok_or_else(|| format!("cannot derive bundle id for '{name}'"))?;
    let env = secrets::interpolate_env(&bundle, &entry.capabilities, &m.env)?;
    Ok(McpServerConfig {
        name: entry.id.clone(),
        command: m.command.clone(),
        args: m.args.clone(),
        env,
        enabled: true,
        description: None,
        server_url: None,
        oauth_client_id: None,
        oauth_scope: None,
        // Spawn from the bundle dir so manifest-relative script args
        // (`node server.js`) resolve without absolute paths.
        cwd: Some(entry.install_dir.display().to_string()),
    })
}

// ─── public tauri commands ───────────────────────────────────────────

#[tauri::command]
pub fn mcp_servers_list(
    plugin_state: State<'_, PluginHostState>,
) -> Result<Vec<McpServerEntry>, String> {
    let mut out: Vec<McpServerEntry> =
        list_configs()?.into_iter().map(Into::into).collect();
    for (cfg, plugin_id) in plugin_mcp_configs(&plugin_state) {
        let mut entry: McpServerEntry = cfg.into();
        entry.plugin_id = Some(plugin_id);
        out.push(entry);
    }
    Ok(out)
}

#[tauri::command]
pub fn mcp_servers_add(
    name: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    description: Option<String>,
    // Wave C — optional remote-transport fields. Frontend may always
    // forward a string; we normalise empty → None so the JSON-on-disk
    // shape stays clean (skip_serializing_if on the struct fields).
    server_url: Option<String>,
    oauth_client_id: Option<String>,
    oauth_scope: Option<String>,
) -> Result<McpServerEntry, String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("server name is required".into());
    }
    // A pure-remote server has no command — `list_tools` / `call_tool`
    // branch on `server_url` and hand the whole call to the HTTP
    // transport without ever reading `command`. Demanding one here made
    // the "Atlassian (remote · native OAuth)" template — which ships
    // `command: ""` on purpose — impossible to add: the form let you
    // save it and the backend refused. One of the two has to be
    // reachable; neither on its own is enough.
    let has_remote = server_url
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty());
    if command.trim().is_empty() && !has_remote {
        return Err("give the server a command to run, or a remote URL".into());
    }
    let path = server_path(&trimmed)?;
    if path.exists() {
        return Err(format!("server '{trimmed}' already exists"));
    }
    let normalise = |v: Option<String>| -> Option<String> {
        v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    };
    let cfg = McpServerConfig {
        name: trimmed,
        command,
        args,
        env,
        enabled: true,
        description,
        server_url: normalise(server_url),
        oauth_client_id: normalise(oauth_client_id),
        oauth_scope: normalise(oauth_scope),
        cwd: None,
    };
    write_config(&cfg)?;
    Ok(cfg.into())
}

// ─── QQ.2 — Discover MCP servers configured by other agents ──────────
//
// Most agent CLIs / IDE extensions persist their MCP server registry
// as JSON on disk. We probe a curated list of well-known locations
// (Claude Code, Claude Desktop, Cursor, Windsurf, Cline, Zed, plus
// repo-local `.mcp.json`) and surface every entry the user has
// already authenticated. They one-click into Aura's catalog so the
// user never has to re-paste tokens.
//
// Three on-disk shapes exist:
//   1. The "standard" — `mcpServers: { "<name>": { command, args, env } }`.
//      Used by Claude Code, Claude Desktop, Cursor, Windsurf, Cline,
//      and the de-facto `.mcp.json` standard.
//   2. The "nested per-project" — `projects.<repo>.mcpServers: { … }`.
//      Used by Claude Code's user config to scope per-cwd servers.
//   3. The "alternate key" — Zed uses `context_servers` with the same
//      inner shape. (Continue.dev uses a different shape — deferred.)
//
// Across all of them we only support stdio servers (Aura's invoker
// spawns a child per call). SSE/HTTP remote MCPs are skipped silently
// — when remote transport lands they'll auto-surface here.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredMcp {
    /// Server name from the source config. Used verbatim as the Aura
    /// filename (with conflict warning surfaced via `already_imported`).
    pub name: String,
    /// Human-readable source label for the picker UI (e.g.
    /// "Claude Code", "Cursor", "Windsurf", "Cline (VSCode)", "Zed",
    /// "Project .mcp.json").
    pub source: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    /// True when `~/.aura/mcp/<name>.json` already exists. The picker
    /// shows these as "Already imported" + disables their checkbox.
    pub already_imported: bool,
    /// Pre-stamped remote MCP URL when the source agent config knows
    /// it (Claude Desktop / Cursor remote MCP entries, the canonical
    /// `npx -y mcp-remote <url>` proxy pattern, or explicit
    /// `url`/`serverUrl`/`endpoint` fields). `None` for plain stdio
    /// entries — the import path will fall back to scanning args.
    #[serde(default)]
    pub server_url: Option<String>,
}

#[tauri::command]
pub fn mcp_servers_discover_agents(
    repo_root: Option<String>,
) -> Result<Vec<DiscoveredMcp>, String> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Ok(Vec::new()),
    };
    let mut sources: Vec<(String, PathBuf, ConfigShape)> = Vec::new();

    // ── Claude Code (anthropic CLI) ─────────────────────────────────
    sources.push((
        "Claude Code".into(),
        home.join(".claude.json"),
        ConfigShape::TopLevelMcpServers,
    ));
    if let Some(repo) = repo_root.as_ref().filter(|s| !s.trim().is_empty()) {
        sources.push((
            "Claude Code (project)".into(),
            home.join(".claude.json"),
            ConfigShape::NestedProjectMcpServers {
                project: repo.clone(),
            },
        ));
        sources.push((
            "Project .mcp.json".into(),
            PathBuf::from(repo).join(".mcp.json"),
            ConfigShape::McpJsonRoot,
        ));
        // Cursor's project-local override
        sources.push((
            "Cursor (project)".into(),
            PathBuf::from(repo).join(".cursor/mcp.json"),
            ConfigShape::TopLevelMcpServers,
        ));
        // Codex / openai-agent-cli style — same shape if present
        sources.push((
            "Codex CLI (project)".into(),
            PathBuf::from(repo).join(".codex/mcp.json"),
            ConfigShape::TopLevelMcpServers,
        ));
    }

    // ── Claude Desktop ─────────────────────────────────────────────
    sources.push((
        "Claude Desktop".into(),
        home.join("Library/Application Support/Claude/claude_desktop_config.json"),
        ConfigShape::TopLevelMcpServers,
    ));
    sources.push((
        "Claude Desktop".into(),
        home.join(".config/Claude/claude_desktop_config.json"),
        ConfigShape::TopLevelMcpServers,
    ));

    // ── Cursor (user-level) ────────────────────────────────────────
    sources.push((
        "Cursor".into(),
        home.join(".cursor/mcp.json"),
        ConfigShape::TopLevelMcpServers,
    ));

    // ── Windsurf (Codeium) ────────────────────────────────────────
    sources.push((
        "Windsurf".into(),
        home.join(".codeium/windsurf/mcp_config.json"),
        ConfigShape::TopLevelMcpServers,
    ));

    // ── Cline (VSCode extension) — global storage ──────────────────
    sources.push((
        "Cline (VSCode)".into(),
        home.join(
            "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
        ),
        ConfigShape::TopLevelMcpServers,
    ));
    sources.push((
        "Cline (VSCode)".into(),
        home.join(
            ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
        ),
        ConfigShape::TopLevelMcpServers,
    ));
    // Roo Cline (forked extension id)
    sources.push((
        "Roo Cline (VSCode)".into(),
        home.join(
            "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json",
        ),
        ConfigShape::TopLevelMcpServers,
    ));

    // ── Zed (uses `context_servers` instead of `mcpServers`) ───────
    sources.push((
        "Zed".into(),
        home.join(".config/zed/settings.json"),
        ConfigShape::ContextServers,
    ));

    // ── opencode (SST-style; keeps stdio servers in `mcp`) ─────────
    sources.push((
        "opencode".into(),
        home.join(".config/opencode/opencode.json"),
        ConfigShape::OpencodeMcp,
    ));

    // ── Gemini CLI (per-user `settings.json` carries mcpServers) ───
    sources.push((
        "Gemini CLI".into(),
        home.join(".gemini/settings.json"),
        ConfigShape::TopLevelMcpServers,
    ));

    let existing: Vec<String> = list_configs()
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.name)
        .collect();
    let mut out: Vec<DiscoveredMcp> = Vec::new();
    // De-dupe across sources by (name, command, args). A server
    // configured identically in Claude Code + Cursor + Windsurf
    // surfaces once; if any one diverges (e.g. different token in
    // `env`) the args+command hash differs and both show up so the
    // user can pick consciously.
    let mut seen: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    for (label, path, shape) in sources {
        if !path.exists() {
            continue;
        }
        let body = match std::fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let root: Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let entries = extract_servers(&root, &shape);
        for (name, entry) in entries {
            let Some(obj) = entry.as_object() else {
                continue;
            };
            // Detect explicit URL fields first — some agents (Claude
            // Desktop, Cursor remote MCP) describe remote MCPs as a
            // bare `{ url|serverUrl|endpoint: "https://…" }` with no
            // command at all. We accept those by stamping `server_url`
            // and synthesising the canonical `npx -y mcp-remote <url>`
            // proxy spawn so Aura's invoker (which currently only
            // speaks stdio) has something to launch.
            let url_field = obj
                .get("url")
                .or_else(|| obj.get("serverUrl"))
                .or_else(|| obj.get("endpoint"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            // Skip non-stdio transports unless we recovered a URL above
            // — those become a synthesised mcp-remote proxy.
            let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("stdio");
            if kind != "stdio" && kind != "command" && url_field.is_none() {
                continue;
            }
            let raw_command = obj
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let raw_args: Vec<String> = obj
                .get("args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            // Synthesise a proxy spawn for URL-only remote entries.
            let (command, args) = if raw_command.is_empty() {
                match &url_field {
                    Some(url) => (
                        "npx".to_string(),
                        vec![
                            "-y".to_string(),
                            "mcp-remote".to_string(),
                            url.clone(),
                        ],
                    ),
                    None => continue,
                }
            } else {
                (raw_command, raw_args)
            };
            let env: HashMap<String, String> = obj
                .get("env")
                .and_then(|v| v.as_object())
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| {
                            v.as_str().map(|s| (k.clone(), s.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            // Detect the canonical `npx -y mcp-remote <url>` proxy and
            // lift the URL out so the import path can stamp it on the
            // McpServerConfig. The exact arg shape `npx`/`bunx` + flag
            // + `mcp-remote` + url is what Anthropic ships in their
            // docs — we accept either runner and either flag position.
            let mcp_remote_url = if matches!(command.as_str(), "npx" | "bunx" | "pnpx") {
                let has_mcp_remote =
                    args.iter().any(|a| a == "mcp-remote" || a.ends_with("/mcp-remote"));
                if has_mcp_remote {
                    args.iter()
                        .find(|a| a.starts_with("https://"))
                        .cloned()
                } else {
                    None
                }
            } else {
                None
            };
            let server_url = url_field.or(mcp_remote_url);
            let dedupe_key = format!("{name}|{command}|{}", args.join(" "));
            if !seen.insert(dedupe_key) {
                continue;
            }
            out.push(DiscoveredMcp {
                name: name.clone(),
                source: label.clone(),
                command,
                args,
                env,
                already_imported: existing.contains(&name),
                server_url,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn mcp_servers_import_discovered(
    entries: Vec<DiscoveredMcp>,
) -> Result<Vec<McpServerEntry>, String> {
    let mut out: Vec<McpServerEntry> = Vec::new();
    for entry in entries {
        // Already-imported rows are silently skipped — the picker
        // disables those checkboxes, but a stale snapshot from a
        // parallel import shouldn't blow up the whole batch.
        if entry.already_imported {
            continue;
        }
        let path = server_path(&entry.name)?;
        if path.exists() {
            continue;
        }
        // Prefer the picker-supplied `server_url` (extracted from the
        // source agent config — see `extract_servers`) when present.
        // Falls back to the legacy args-scan: if exactly one arg looks
        // like an https URL, treat it as the remote MCP endpoint so
        // the HTTP transport can take over once the user authenticates.
        // Zero or multiple URLs is ambiguous — leave it None and let
        // the user set it explicitly via the Auth modal's URL field.
        let server_url = entry
            .server_url
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let https_args: Vec<&str> = entry
                    .args
                    .iter()
                    .map(String::as_str)
                    .filter(|a| a.starts_with("https://"))
                    .collect();
                if https_args.len() == 1 {
                    Some(https_args[0].to_string())
                } else {
                    None
                }
            });
        let cfg = McpServerConfig {
            name: entry.name.clone(),
            command: entry.command,
            args: entry.args,
            env: entry.env,
            enabled: true,
            description: Some(format!("Imported from {}", entry.source)),
            server_url,
            oauth_client_id: None,
            oauth_scope: None,
            cwd: None,
        };
        write_config(&cfg)?;
        out.push(cfg.into());
    }
    Ok(out)
}

enum ConfigShape {
    /// `{ "mcpServers": { "<name>": { command, args, env } } }` — the
    /// de-facto standard used by Claude Code, Claude Desktop, Cursor,
    /// Windsurf, Cline, Gemini CLI.
    TopLevelMcpServers,
    /// `{ "projects": { "<repo>": { "mcpServers": { … } } } }` — Claude
    /// Code's per-project scope inside the user config.
    NestedProjectMcpServers { project: String },
    /// `.mcp.json` — usually wraps in `mcpServers` but some forks emit
    /// the map at root level. We try the nested form first.
    McpJsonRoot,
    /// Zed: `{ "context_servers": { "<name>": { command, args, env } } }`.
    ContextServers,
    /// opencode: `{ "mcp": { "<name>": { type:"local", command:[…], environment } } }`.
    /// Different inner shape too — `command` is an array we have to
    /// split into command + args.
    OpencodeMcp,
}

/// Returns a vec of (server_name, server_value) pulled from the
/// document according to the given shape. opencode is handled
/// specially because its inner record uses an array `command` and
/// renames `env` → `environment`; we normalise it back to the
/// standard shape on the fly.
fn extract_servers(root: &Value, shape: &ConfigShape) -> Vec<(String, Value)> {
    let raw = match shape {
        ConfigShape::TopLevelMcpServers => root.get("mcpServers"),
        ConfigShape::NestedProjectMcpServers { project } => root
            .get("projects")
            .and_then(|p| p.get(project))
            .and_then(|p| p.get("mcpServers")),
        ConfigShape::McpJsonRoot => root.get("mcpServers").or(Some(root)),
        ConfigShape::ContextServers => root.get("context_servers"),
        ConfigShape::OpencodeMcp => root.get("mcp"),
    };
    let Some(obj) = raw.and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Value)> = Vec::new();
    for (name, entry) in obj.iter() {
        let Some(inner) = entry.as_object() else {
            continue;
        };
        if matches!(shape, ConfigShape::OpencodeMcp) {
            // opencode wires `command` as `[exec, ...args]` and `env`
            // as `environment`. Normalise to the standard shape so the
            // outer loop doesn't need to special-case it.
            let kind = inner
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("local");
            if kind != "local" {
                // remote/sse — skip, see file-level note.
                continue;
            }
            let cmd_arr = match inner.get("command").and_then(|v| v.as_array()) {
                Some(a) => a,
                None => continue,
            };
            let mut iter = cmd_arr
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string));
            let command = match iter.next() {
                Some(c) => c,
                None => continue,
            };
            let args: Vec<String> = iter.collect();
            let env = inner
                .get("environment")
                .cloned()
                .or_else(|| inner.get("env").cloned())
                .unwrap_or(Value::Object(serde_json::Map::new()));
            let normalised = json!({
                "type": "stdio",
                "command": command,
                "args": args,
                "env": env,
            });
            out.push((name.clone(), normalised));
        } else {
            out.push((name.clone(), entry.clone()));
        }
    }
    out
}

#[tauri::command]
pub fn mcp_servers_remove(name: String) -> Result<(), String> {
    if is_plugin_server_name(&name) {
        return Err(format!(
            "'{name}' comes from a plugin bundle — manage it in Settings → Plugins"
        ));
    }
    let path = server_path(&name)?;
    if !path.exists() {
        return Err(format!("server '{name}' not found"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("remove {}: {e}", path.display()))
}

#[tauri::command]
pub fn mcp_servers_toggle(
    plugin_state: State<'_, PluginHostState>,
    name: String,
    enabled: bool,
) -> Result<McpServerEntry, String> {
    if is_plugin_server_name(&name) {
        // Plugin-bundled server: route through the plugin registry's
        // persisted enable state (.state.json) so the MCP pane and the
        // Plugins pane stay one source of truth.
        crate::cmd_plugin::set_enabled_persisted(
            &plugin_state,
            ManifestKind::Mcp,
            &name,
            enabled,
        )?;
        let (cfg, plugin_id) = plugin_mcp_configs(&plugin_state)
            .into_iter()
            .find(|(c, _)| c.name == name)
            .ok_or_else(|| format!("server '{name}' not found after toggle"))?;
        let mut entry: McpServerEntry = cfg.into();
        entry.plugin_id = Some(plugin_id);
        return Ok(entry);
    }
    let path = server_path(&name)?;
    let mut cfg = read_config(&path)?;
    cfg.enabled = enabled;
    write_config(&cfg)?;
    Ok(cfg.into())
}

// Wave A — secrets/env patch for an existing server. Used by the
// AuthSetupModal: user pastes provider tokens, we merge them into the
// existing env block (empty strings clear), leaving command/args/etc
// untouched. Returns the refreshed entry so the UI can re-render the
// row immediately without a second list call.
#[tauri::command]
pub fn mcp_servers_update_env(
    name: String,
    env: HashMap<String, String>,
) -> Result<McpServerEntry, String> {
    if is_plugin_server_name(&name) {
        return Err(format!(
            "'{name}' comes from a plugin bundle — its env lives in the bundle manifest; set secrets in Settings → Plugins"
        ));
    }
    let path = server_path(&name)?;
    let mut cfg = read_config(&path)?;
    for (k, v) in env {
        if v.is_empty() {
            cfg.env.remove(&k);
        } else {
            cfg.env.insert(k, v);
        }
    }
    write_config(&cfg)?;
    Ok(cfg.into())
}

// Wave B — browser-OAuth flow for `mcp-remote`-style stdio proxies.
//
// `mcp-remote` is a thin npm CLI shipped by Anthropic that proxies a
// remote MCP (e.g. mcp.atlassian.com) over stdio while owning the
// OAuth flow. On first invocation it prints an auth URL to stderr and
// either auto-opens the browser or waits for the user to paste the
// callback. After the user completes the OAuth handshake, it caches
// the token in `~/.mcp-auth/` and exits cleanly (later invocations
// don't need browser auth at all — they just read the cached token).
//
// This command runs that first-invocation dance for the user from
// inside Settings → MCP, so they never have to drop to a terminal:
//   1. Spawn the configured server command with stderr captured.
//   2. Stream every stderr line back to the frontend via a Tauri
//      event (`mcp:auth_log:<name>`).
//   3. When we see an `https://…` URL on stderr we ALSO emit an
//      `mcp:auth_url:<name>` event so the frontend can pop a browser
//      tab via `openUrl`.
//   4. Wait for the child to exit (or time out at 5 minutes). Exit
//      code 0 means token was cached successfully — subsequent normal
//      MCP probes will work without auth.
//
// We don't read stdin on this child — `mcp-remote` doesn't expect any
// MCP traffic during auth (it's just running the OAuth dance), and
// piping our usual MCP-init handshake here would race the auth flow.
#[derive(Debug, Serialize)]
pub struct McpAuthRunResult {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub log: String,
}

#[tauri::command]
pub async fn mcp_servers_auth_run(
    app: tauri::AppHandle,
    name: String,
) -> Result<McpAuthRunResult, String> {
    use tauri::Emitter;
    let config_name = name.clone();
    let cfg = crate::blocking::run(move || {
        let path = server_path(&config_name)?;
        read_config(&path)
    })
    .await?;

    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn '{}': {e}", cfg.command))?;

    // Capture stderr line-by-line; pipe to a Tauri event so the UI can
    // surface the auth-flow output in real time, and watch for the
    // auth URL so we can auto-open the user's browser.
    let stderr = child.stderr.take().ok_or("no stderr handle")?;
    let stdout = child.stdout.take().ok_or("no stdout handle")?;

    let log_topic = format!("mcp:auth_log:{}", name);
    let url_topic = format!("mcp:auth_url:{}", name);
    let app_err = app.clone();
    let app_out = app.clone();
    let name_err = name.clone();
    let name_out = name.clone();

    // Concatenated log we return at the end (capped — the UI doesn't
    // need megabytes of npm install output).
    let log_buf = std::sync::Arc::new(tokio::sync::Mutex::new(String::new()));
    let log_buf_err = log_buf.clone();
    let log_buf_out = log_buf.clone();

    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(&log_topic, &line);
            if let Some(url) = extract_https_url(&line) {
                let _ = app_err.emit(&url_topic, &url);
            }
            let mut buf = log_buf_err.lock().await;
            if buf.len() < 32 * 1024 {
                buf.push_str(&line);
                buf.push('\n');
            }
            drop(buf);
            let _ = name_err;
        }
    });
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            // Some proxies also print URL guidance on stdout — capture
            // the same way so the UI sees both streams.
            let _ = app_out.emit(&format!("mcp:auth_log:{}", name_out), &line);
            if let Some(url) = extract_https_url(&line) {
                let _ = app_out.emit(&format!("mcp:auth_url:{}", name_out), &url);
            }
            let mut buf = log_buf_out.lock().await;
            if buf.len() < 32 * 1024 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    });

    let wait = child.wait();
    let outcome = tokio::time::timeout(Duration::from_secs(300), wait).await;
    let (exit_code, timed_out) = match outcome {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(e)) => return Err(format!("child wait: {e}")),
        Err(_) => {
            // Timed out — try to drop the child cleanly. kill_on_drop
            // will follow when `child` goes out of scope.
            (None, true)
        }
    };
    let _ = stderr_task.await;
    let _ = stdout_task.await;
    let log = log_buf.lock().await.clone();
    Ok(McpAuthRunResult {
        exit_code,
        timed_out,
        log,
    })
}

// Yank the first https:// URL out of a log line. Used to spot the
// OAuth start URL that `mcp-remote` and similar proxies emit.
fn extract_https_url(line: &str) -> Option<String> {
    let lower = line;
    let idx = lower.find("https://")?;
    let tail = &lower[idx..];
    // Stop at the first whitespace or closing punctuation that's not
    // part of a URL (parens, brackets, trailing periods/commas).
    let end = tail
        .find(|c: char| c.is_whitespace() || matches!(c, ')' | ']' | '\'' | '"' | '`' | '>'))
        .unwrap_or(tail.len());
    let mut url = &tail[..end];
    while let Some(last) = url.chars().last() {
        if matches!(last, '.' | ',' | ';' | ':') {
            url = &url[..url.len() - last.len_utf8()];
        } else {
            break;
        }
    }
    if url.len() < 12 {
        return None;
    }
    Some(url.to_string())
}

#[tauri::command]
pub async fn mcp_tools_list(
    plugin_state: State<'_, PluginHostState>,
) -> Result<Vec<McpServerToolList>, String> {
    let mut cfgs: Vec<McpServerConfig> = crate::blocking::run(|| {
        list_configs().map(|configs| configs.into_iter().filter(|c| c.enabled).collect())
    })
    .await?;
    // Plugin-bundled servers: resolve secrets BEFORE any await (the
    // registry borrow is synchronous). A failed interpolation — secret
    // not set, capability missing — becomes an error row, not a crash,
    // so the UI can point the user at Settings → Plugins.
    let mut out = Vec::new();
    for (raw, _plugin_id) in plugin_mcp_configs(&plugin_state) {
        if !raw.enabled {
            continue;
        }
        match resolve_plugin_mcp(&plugin_state, &raw.name) {
            Ok(cfg) => cfgs.push(cfg),
            Err(e) => out.push(McpServerToolList {
                server: raw.name,
                ok: false,
                error: Some(e),
                tools: Vec::new(),
            }),
        }
    }
    for cfg in cfgs {
        let name = cfg.name.clone();
        match fetch_tools(&cfg).await {
            Ok(tools) => out.push(McpServerToolList {
                server: name,
                ok: true,
                error: None,
                tools,
            }),
            Err(e) => out.push(McpServerToolList {
                server: name,
                ok: false,
                error: Some(e),
                tools: Vec::new(),
            }),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn mcp_tool_invoke(
    plugin_state: State<'_, PluginHostState>,
    server: String,
    tool: String,
    args: Value,
) -> Result<McpToolInvokeResult, String> {
    // Plugin-bundled servers resolve through the registry + secrets
    // broker (synchronously, before the await); file-based ones read
    // their JSON config. Disjoint namespaces — see is_plugin_server_name.
    let cfg = if is_plugin_server_name(&server) {
        resolve_plugin_mcp(&plugin_state, &server)?
    } else {
        let path = server_path(&server)?;
        let cfg = read_config(&path)?;
        if !cfg.enabled {
            return Err(format!("server '{server}' is disabled"));
        }
        cfg
    };
    match call_tool(&cfg, &tool, args).await {
        Ok(raw) => {
            let text = pretty_print_call_result(&raw);
            Ok(McpToolInvokeResult {
                server,
                tool,
                ok: true,
                text,
                raw,
                error: None,
            })
        }
        Err(e) => Ok(McpToolInvokeResult {
            server,
            tool,
            ok: false,
            text: String::new(),
            raw: Value::Null,
            error: Some(e),
        }),
    }
}

// ─── JSON-RPC client ─────────────────────────────────────────────────
//
// Each request spawns a short-lived child process — same approach
// Claude Code and Cursor take for stdio MCP servers. The alternative
// (persistent connection pool) buys throughput we don't need here and
// would force us to deal with crashed-server cleanup on every
// composer keystroke. If `tools/list` ever lands on the hot path we can
// memoize the schema by `(command, args)` digest.

const SPAWN_TIMEOUT: Duration = Duration::from_secs(20);

async fn fetch_tools(cfg: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
    let build = |id: u64| {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/list",
            "params": {}
        })
    };
    let raw = if let Some(url) = cfg.server_url.as_deref() {
        let token = crate::mcp_oauth::valid_access_token(
            &cfg.name,
            url,
            cfg.oauth_client_id.as_deref(),
        )
        .await?;
        crate::mcp_http_transport::http_rpc_session(url, token.as_deref(), build).await?
    } else {
        rpc_session(cfg, build).await?
    };
    let arr = raw
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or_else(|| "tools/list: missing result.tools array".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for t in arr {
        let name = match t.get("name").and_then(|v| v.as_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        out.push(McpToolInfo {
            server: cfg.name.clone(),
            name,
            description: t
                .get("description")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            input_schema: t
                .get("inputSchema")
                .cloned()
                .unwrap_or(Value::Null),
        });
    }
    Ok(out)
}

async fn call_tool(cfg: &McpServerConfig, tool: &str, args: Value) -> Result<Value, String> {
    let tool = tool.to_string();
    let raw = if let Some(url) = cfg.server_url.as_deref() {
        let token = crate::mcp_oauth::valid_access_token(
            &cfg.name,
            url,
            cfg.oauth_client_id.as_deref(),
        )
        .await?;
        let tool_for_closure = tool.clone();
        let args_for_closure = args.clone();
        crate::mcp_http_transport::http_rpc_session(url, token.as_deref(), move |id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": tool_for_closure,
                    "arguments": args_for_closure,
                }
            })
        })
        .await?
    } else {
        rpc_session(cfg, move |id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": {
                    "name": tool,
                    "arguments": args,
                }
            })
        })
        .await?
    };
    if let Some(err) = raw.get("error") {
        return Err(format!("server error: {err}"));
    }
    Ok(raw.get("result").cloned().unwrap_or(Value::Null))
}

/// Spawn the configured server, do the MCP `initialize` handshake, then
/// fire one user-defined request and read one response. Closes stdin
/// after the request goes out so the child knows it's done.
async fn rpc_session<F>(cfg: &McpServerConfig, build_req: F) -> Result<Value, String>
where
    F: FnOnce(u64) -> Value + Send + 'static,
{
    let cfg_clone = cfg.clone();
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        let res = rpc_session_inner(&cfg_clone, build_req).await;
        let _ = tx.send(res);
    });
    match timeout(SPAWN_TIMEOUT, rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("rpc task dropped".into()),
        Err(_) => Err(format!(
            "timed out waiting for MCP server '{}' (> {:?})",
            cfg.name, SPAWN_TIMEOUT
        )),
    }
}

async fn rpc_session_inner<F>(cfg: &McpServerConfig, build_req: F) -> Result<Value, String>
where
    F: FnOnce(u64) -> Value,
{
    let mut child = spawn_child(cfg)?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to capture stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture stdout".to_string())?;
    let mut reader = BufReader::new(stdout);

    // 1. initialize — required handshake per the MCP spec.
    let init_req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {
                "name": "aura-shell",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    write_line(&mut stdin, &init_req).await?;
    let _init_resp = read_response(&mut reader, 1).await?;

    // 2. notifications/initialized — fire-and-forget; many servers
    // wait for this before they'll answer subsequent calls.
    let init_done = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    write_line(&mut stdin, &init_done).await?;

    // 3. the actual request.
    let req = build_req(2);
    write_line(&mut stdin, &req).await?;
    let resp = read_response(&mut reader, 2).await?;

    // Best-effort shutdown — drop stdin so the server sees EOF and
    // exits cleanly; if it doesn't, kill on drop.
    drop(stdin);
    let _ = timeout(Duration::from_secs(2), child.wait()).await;
    let _ = child.start_kill();
    Ok(resp)
}

fn spawn_child(cfg: &McpServerConfig) -> Result<Child, String> {
    let mut cmd = Command::new(&cfg.command);
    cmd.args(&cfg.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = &cfg.cwd {
        cmd.current_dir(dir);
    }
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    cmd.spawn()
        .map_err(|e| format!("spawn '{}': {e}", cfg.command))
}

async fn write_line<W: AsyncWriteExt + Unpin>(w: &mut W, v: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(v).map_err(|e| format!("encode request: {e}"))?;
    line.push('\n');
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write to mcp stdin: {e}"))?;
    w.flush()
        .await
        .map_err(|e| format!("flush mcp stdin: {e}"))
}

/// Read newline-delimited JSON responses from stdout until we see the
/// one matching `expect_id` (or hit EOF). Notifications + unrelated
/// responses are tolerated and discarded.
async fn read_response<R: AsyncBufReadExt + Unpin>(
    r: &mut R,
    expect_id: u64,
) -> Result<Value, String> {
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = r
            .read_line(&mut buf)
            .await
            .map_err(|e| format!("read mcp stdout: {e}"))?;
        if n == 0 {
            return Err("mcp server closed stdout before responding".into());
        }
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // some servers print log lines on stdout
        };
        let id_match = v
            .get("id")
            .and_then(|i| i.as_u64())
            .map(|i| i == expect_id)
            .unwrap_or(false);
        if id_match {
            return Ok(v);
        }
        // notifications / unrelated ids — keep reading.
    }
}

/// Best-effort textification of a `tools/call` result. The MCP spec
/// returns `{ content: [{type: "text", text: ...}, ...], isError? }`
/// — we flatten all text blocks. Non-text content lands as pretty JSON.
fn pretty_print_call_result(raw: &Value) -> String {
    let Some(content) = raw.get("content").and_then(|c| c.as_array()) else {
        return serde_json::to_string_pretty(raw).unwrap_or_default();
    };
    let mut out = String::new();
    for c in content {
        match c.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(txt) = c.get("text").and_then(|t| t.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(txt);
                }
            }
            _ => {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(&serde_json::to_string_pretty(c).unwrap_or_default());
            }
        }
    }
    if out.is_empty() {
        serde_json::to_string_pretty(raw).unwrap_or_default()
    } else {
        out
    }
}

// ─── Wave C — Native OAuth 2.1 + PKCE ────────────────────────────────
//
// The flow lives in `crate::mcp_oauth`. These commands tie it to the
// per-server config on disk and the OS keychain:
//
//   * `mcp_servers_update_url` patches the remote-transport fields on
//     an existing config (server_url + optional pre-registered
//     client_id / scope).
//   * `mcp_servers_oauth_start` runs the full PKCE dance, opens the
//     authorize URL in the user's browser, and stores the resulting
//     tokens in the keychain. Emits `mcp:auth_log:<name>` events with
//     a progress trail so the UI can show what's happening.
//   * `mcp_servers_oauth_clear` deletes the stored tokens so the user
//     can re-authenticate from scratch.

#[tauri::command]
pub fn mcp_servers_update_url(
    name: String,
    server_url: Option<String>,
    oauth_client_id: Option<String>,
    oauth_scope: Option<String>,
) -> Result<McpServerEntry, String> {
    if is_plugin_server_name(&name) {
        return Err(format!(
            "'{name}' comes from a plugin bundle — manage it in Settings → Plugins"
        ));
    }
    let path = server_path(&name)?;
    let mut cfg = read_config(&path)?;
    // Empty strings clear the field; missing keys leave the existing
    // value alone. Matches the env-patch semantics in update_env.
    if let Some(url) = server_url {
        cfg.server_url = if url.trim().is_empty() {
            None
        } else {
            Some(url)
        };
    }
    if let Some(id) = oauth_client_id {
        cfg.oauth_client_id = if id.trim().is_empty() {
            None
        } else {
            Some(id)
        };
    }
    if let Some(scope) = oauth_scope {
        cfg.oauth_scope = if scope.trim().is_empty() {
            None
        } else {
            Some(scope)
        };
    }
    write_config(&cfg)?;
    Ok(cfg.into())
}

#[tauri::command]
pub async fn mcp_servers_oauth_start(
    app: tauri::AppHandle,
    name: String,
) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_opener::OpenerExt;

    let path = server_path(&name)?;
    let cfg = read_config(&path)?;
    let server_url = cfg
        .server_url
        .clone()
        .ok_or("server has no remote URL configured")?;

    let log_topic = format!("mcp:auth_log:{}", name);
    let url_topic = format!("mcp:auth_url:{}", name);
    let _ = app.emit(&log_topic, "starting native OAuth flow…");

    let oauth_cfg = crate::mcp_oauth::OAuthConfig {
        server_url: server_url.clone(),
        client_id: cfg.oauth_client_id.clone(),
        client_secret: None,
        scope: cfg.oauth_scope.clone(),
    };

    let flow = crate::mcp_oauth::start_flow(oauth_cfg).await?;
    let _ = app.emit(
        &log_topic,
        format!("loopback listener bound at {}", flow.redirect_uri),
    );
    let _ = app.emit(&url_topic, &flow.authorize_url);
    let _ = app.emit(
        &log_topic,
        format!("opening {} in your browser…", flow.authorize_url),
    );
    // Best-effort browser open. If this fails the URL is still emitted
    // on `mcp:auth_url:<name>` so the UI can render a manual link.
    if let Err(e) = app.opener().open_url(&flow.authorize_url, None::<String>) {
        let _ = app.emit(
            &log_topic,
            format!("browser open failed ({e}); use the link above manually"),
        );
    }

    let tokens = flow
        .completion
        .await
        .map_err(|e| format!("flow task panicked: {e}"))??;
    crate::mcp_oauth::keychain_store(&name, &tokens)?;
    let _ = app.emit(&log_topic, "tokens stored in OS keychain ✓");
    Ok(())
}

#[tauri::command]
pub fn mcp_servers_oauth_clear(name: String) -> Result<(), String> {
    crate::mcp_oauth::keychain_delete(&name)
}
