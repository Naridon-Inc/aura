//! Deterministic agent-integration install (AUDIT-REL-04).
//!
//! Before this module, `aura init` wrote agent configs through ad-hoc match
//! arms with three consent leaks (a cancelled picker installed Claude, a
//! non-TTY run installed Claude + Gemini, and the Claude status line landed
//! unconditionally), no record of what was installed, no backup of what was
//! replaced, and no uninstall for anything but git hooks. This module is the
//! single door for the agent matrix — Claude, Codex, Gemini, Kimi, OpenCode,
//! Pi — with three invariants:
//!
//! 1. **Selected-only**: `install` touches exactly the files of the agents it
//!    was handed. An empty selection writes nothing, not even the manifest.
//! 2. **Owned**: every file written is recorded in `.aura/integrations.json`
//!    with how it was written (`created` / `block` / `json` / `hook_entries`)
//!    and, for merged JSON keys, the value that was there before — so
//!    `uninstall` restores the developer's prior config instead of merely
//!    deleting ours.
//! 3. **Idempotent**: re-running `install` upserts marker blocks and JSON
//!    keys in place; it never appends a second copy, and it keeps the
//!    *original* prior when the current on-disk value is already ours (so an
//!    install → install → uninstall round trip still restores what the
//!    developer had first).
//!
//! Scope rule: repo-shared files (`.mcp.json`, context markdown, project
//! `.gemini/settings.json`) reference the binary as bare `aura` because they
//! are committed and travel to other machines; machine-local files (anything
//! under `$HOME`) get the absolute verified binary from
//! [`verified_aura_binary`], because PATH is exactly what a GUI-launched
//! agent doesn't reliably have.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MANIFEST_REL: &str = ".aura/integrations.json";
const BLOCK_START: &str = "<!-- AURA_START -->";
const BLOCK_END: &str = "<!-- AURA_END -->";
/// Substring that identifies OUR entry inside a Gemini hooks array — user
/// entries never reference our staged hook script.
const GEMINI_HOOK_MARKER: &str = "aura-intent.js";

// ── The agent matrix ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Agent {
    Claude,
    Codex,
    Gemini,
    Kimi,
    OpenCode,
    Pi,
}

impl Agent {
    pub const ALL: [Agent; 6] = [
        Agent::Claude,
        Agent::Codex,
        Agent::Gemini,
        Agent::Kimi,
        Agent::OpenCode,
        Agent::Pi,
    ];

    pub fn id(&self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Gemini => "gemini",
            Agent::Kimi => "kimi",
            Agent::OpenCode => "opencode",
            Agent::Pi => "pi",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
            Agent::Gemini => "Gemini CLI",
            Agent::Kimi => "Kimi",
            Agent::OpenCode => "OpenCode",
            Agent::Pi => "Pi",
        }
    }

    pub fn parse(s: &str) -> Option<Agent> {
        match s.trim().to_lowercase().as_str() {
            "claude" | "claude-code" | "claude code" => Some(Agent::Claude),
            "codex" => Some(Agent::Codex),
            "gemini" | "gemini-cli" | "gemini cli" => Some(Agent::Gemini),
            "kimi" => Some(Agent::Kimi),
            "opencode" | "open-code" => Some(Agent::OpenCode),
            "pi" => Some(Agent::Pi),
            _ => None,
        }
    }
}

// ── Binary resolution ───────────────────────────────────────────────────────

/// The aura binary as it should appear in machine-local configs.
pub struct AuraBin {
    /// Absolute canonical path when verified; bare `"aura"` otherwise.
    pub command: String,
    /// True only when the path exists, canonicalizes, and is executable —
    /// callers should warn before baking an unverified command into a hook.
    pub verified: bool,
}

/// Resolve the running executable to an absolute, verified path. A hook that
/// says bare `aura` silently no-ops for any agent launched outside a shell
/// that has aura on PATH (GUI-launched Claude Code being the canonical case),
/// so machine-local configs must carry the real path — but only a path we
/// proved exists and is executable, never a stale guess.
pub fn verified_aura_binary() -> AuraBin {
    let resolved = std::env::current_exe()
        .ok()
        .and_then(|p| p.canonicalize().ok())
        .filter(|p| is_executable_file(p));
    match resolved {
        Some(p) => AuraBin { command: p.to_string_lossy().into_owned(), verified: true },
        None => AuraBin { command: "aura".to_string(), verified: false },
    }
}

fn is_executable_file(p: &Path) -> bool {
    let Ok(meta) = fs::metadata(p) else { return false };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

// ── Context ─────────────────────────────────────────────────────────────────

/// Everything an install needs, injectable so tests run against temp dirs
/// instead of the developer's real HOME.
pub struct InstallCtx {
    pub repo_root: PathBuf,
    pub home: PathBuf,
    pub aura_bin: AuraBin,
}

impl InstallCtx {
    /// Real context: cwd as the repo root (init runs there), `$HOME`, and the
    /// verified running binary. `None` when HOME is unset — installing agent
    /// configs without a home directory has no sane meaning.
    pub fn current() -> Option<InstallCtx> {
        let home = std::env::var("HOME").ok()?;
        Some(InstallCtx {
            repo_root: std::env::current_dir().ok()?,
            home: PathBuf::from(home),
            aura_bin: verified_aura_binary(),
        })
    }

    fn resolve(&self, stored: &str) -> PathBuf {
        match stored.strip_prefix("~/") {
            Some(rest) => self.home.join(rest),
            None => self.repo_root.join(stored),
        }
    }

    fn manifest_path(&self) -> PathBuf {
        self.repo_root.join(MANIFEST_REL)
    }
}

// ── Manifest ────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    /// agent id → what we installed for it.
    pub agents: BTreeMap<String, AgentRecord>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AgentRecord {
    pub installed_at: String,
    pub files: Vec<FileRecord>,
}

/// One file we own (wholly or partially), with enough to undo it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    /// `~/`-prefixed = under HOME; otherwise relative to the repo root.
    pub path: String,
    /// `created` (whole file is ours — delete on uninstall), `block`
    /// (marker-delimited section — strip on uninstall), `json` (one key we
    /// set — restore `prior` on uninstall), `hook_entries` (our elements in
    /// Gemini hook arrays — remove only ours).
    pub kind: String,
    /// For `json`: slash pointer to the key we own, e.g. `/mcpServers/aura-vcs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    /// For `json`: the value that was there before us. `None` = the key did
    /// not exist (uninstall removes it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prior: Option<Value>,
    /// For `block`: whether we created the whole file (uninstall may delete
    /// it once the block is stripped and nothing else remains).
    #[serde(default)]
    pub created: bool,
}

impl Manifest {
    pub fn load(ctx: &InstallCtx) -> Manifest {
        let path = ctx.manifest_path();
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, ctx: &InstallCtx) -> Result<(), String> {
        let path = ctx.manifest_path();
        if self.agents.is_empty() {
            // An empty manifest is noise; a missing one means "nothing owned".
            let _ = fs::remove_file(&path);
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&path, body).map_err(|e| e.to_string())
    }

    pub fn installed_agents(&self) -> Vec<Agent> {
        self.agents.keys().filter_map(|k| Agent::parse(k)).collect()
    }

    /// Prior for a (path, pointer) pair already on record for this agent —
    /// consulted so a re-install never overwrites the original prior with our
    /// own previously-installed value.
    fn recorded_prior(&self, agent: Agent, path: &str, pointer: &str) -> Option<Option<Value>> {
        self.agents.get(agent.id()).and_then(|rec| {
            rec.files
                .iter()
                .find(|f| f.kind == "json" && f.path == path && f.pointer.as_deref() == Some(pointer))
                .map(|f| f.prior.clone())
        })
    }
}

// ── Install ─────────────────────────────────────────────────────────────────

/// Install exactly `agents` — nothing more, and nothing at all for an empty
/// slice. Returns human-readable lines describing what happened.
pub fn install(ctx: &InstallCtx, agents: &[Agent]) -> Result<Vec<String>, String> {
    if agents.is_empty() {
        return Ok(vec![]);
    }
    let mut manifest = Manifest::load(ctx);
    let mut lines = Vec::new();
    for agent in agents {
        let files = install_one(ctx, &manifest, *agent, &mut lines)?;
        manifest.agents.insert(
            agent.id().to_string(),
            AgentRecord { installed_at: now_iso(), files },
        );
    }
    manifest.save(ctx)?;
    Ok(lines)
}

/// Re-run installs for every agent the manifest records — the `aura update`
/// refresh path. A repo that never opted in has no manifest and gets nothing.
pub fn refresh_installed(ctx: &InstallCtx) -> Result<Vec<String>, String> {
    let installed = Manifest::load(ctx).installed_agents();
    install(ctx, &installed)
}

fn install_one(
    ctx: &InstallCtx,
    manifest: &Manifest,
    agent: Agent,
    lines: &mut Vec<String>,
) -> Result<Vec<FileRecord>, String> {
    let mut files = Vec::new();
    match agent {
        Agent::Claude => {
            // Repo-shared: bare `aura` (committed file, travels to teammates).
            files.push(json_upsert(
                ctx,
                manifest,
                agent,
                ".mcp.json",
                "/mcpServers/aura-vcs",
                json!({"command": "aura", "args": ["mcp"]}),
            )?);
            files.push(block_upsert(
                ctx,
                "CLAUDE.md",
                include_str!("../integrations/claude-md-block.md"),
            )?);
            // Machine-local: the status line script plus the settings key
            // pointing at it. The prior statusLine is recorded, not lost.
            files.push(created_file(
                ctx,
                "~/.claude/aura-statusline.sh",
                include_str!("../integrations/aura-statusline.sh"),
                true,
            )?);
            files.push(json_upsert(
                ctx,
                manifest,
                agent,
                "~/.claude/settings.json",
                "/statusLine",
                json!({"type": "command", "command": "bash $HOME/.claude/aura-statusline.sh"}),
            )?);
            lines.push(format!("{}: MCP server, CLAUDE.md block, status line", agent.label()));
        }
        Agent::Gemini => {
            files.push(created_file(
                ctx,
                "~/.gemini/skills/aura-gsd.md",
                include_str!("../integrations/aura-gsd.skill"),
                false,
            )?);
            files.push(created_file(
                ctx,
                ".gemini/hooks/aura-intent.js",
                include_str!("../assets/gemini-hooks/aura-intent.js"),
                false,
            )?);
            // Global config is machine-local → absolute verified binary.
            files.push(json_upsert(
                ctx,
                manifest,
                agent,
                "~/.gemini/settings.json",
                "/mcpServers/aura-vcs",
                json!({"command": ctx.aura_bin.command, "args": ["mcp"]}),
            )?);
            // Project config is repo-shared → bare `aura`.
            files.push(json_upsert(
                ctx,
                manifest,
                agent,
                ".gemini/settings.json",
                "/mcpServers/aura-vcs",
                json!({"command": "aura", "args": ["mcp"]}),
            )?);
            files.push(gemini_hooks_upsert(ctx, ".gemini/settings.json")?);
            files.push(block_upsert(
                ctx,
                "GEMINI.md",
                include_str!("../integrations/gemini-md-block.md"),
            )?);
            lines.push(format!(
                "{}: skill, intent hook, MCP (global + project), GEMINI.md block",
                agent.label()
            ));
        }
        // The CLI-first agents share one AGENTS.md managed block — the
        // context-file convention they all read. Each records its own
        // ownership; the block is stripped only when the last owner leaves.
        Agent::Codex | Agent::Kimi | Agent::OpenCode | Agent::Pi => {
            files.push(block_upsert(
                ctx,
                "AGENTS.md",
                include_str!("../integrations/agents-md-block.md"),
            )?);
            lines.push(format!("{}: AGENTS.md block", agent.label()));
        }
    }
    Ok(files)
}

// ── Uninstall ───────────────────────────────────────────────────────────────

/// Undo one agent's integration, restoring recorded priors. Files shared with
/// agents still installed (the AGENTS.md block) are left in place.
pub fn uninstall(ctx: &InstallCtx, agent: Agent) -> Result<Vec<String>, String> {
    let mut manifest = Manifest::load(ctx);
    let Some(record) = manifest.agents.remove(agent.id()) else {
        return Ok(vec![]);
    };
    let mut lines = Vec::new();
    for file in record.files.iter().rev() {
        let abs = ctx.resolve(&file.path);
        match file.kind.as_str() {
            "created" => {
                if abs.exists() {
                    fs::remove_file(&abs).map_err(|e| e.to_string())?;
                    lines.push(format!("removed {}", file.path));
                }
            }
            "block" => {
                let mut still_owned = false;
                for rec in manifest.agents.values_mut() {
                    if let Some(f) = rec
                        .files
                        .iter_mut()
                        .find(|f| f.kind == "block" && f.path == file.path)
                    {
                        still_owned = true;
                        // The departing owner may hold the "we created this
                        // file" bit (first installer wins it) — hand it to a
                        // survivor so the LAST owner leaving can still delete
                        // a file that was entirely ours.
                        if file.created {
                            f.created = true;
                        }
                    }
                }
                if !still_owned {
                    block_strip(&abs, file.created)?;
                    lines.push(format!("stripped Aura block from {}", file.path));
                }
            }
            "json" => {
                json_restore(&abs, file.pointer.as_deref().unwrap_or(""), file.prior.clone())?;
                lines.push(format!("restored {} in {}", file.pointer.as_deref().unwrap_or("?"), file.path));
            }
            "hook_entries" => {
                gemini_hooks_strip(&abs)?;
                lines.push(format!("removed Aura hook entries from {}", file.path));
            }
            _ => {}
        }
    }
    manifest.save(ctx)?;
    Ok(lines)
}

/// Undo every recorded integration — the `aura disable` path.
pub fn uninstall_all(ctx: &InstallCtx) -> Result<Vec<String>, String> {
    let installed = Manifest::load(ctx).installed_agents();
    let mut lines = Vec::new();
    for agent in installed {
        lines.extend(uninstall(ctx, agent)?);
    }
    Ok(lines)
}

// ── Mechanics: managed markdown blocks ──────────────────────────────────────

fn block_upsert(ctx: &InstallCtx, rel: &str, block: &str) -> Result<FileRecord, String> {
    let path = ctx.resolve(rel);
    let block = block.trim_end();
    let (created, content) = match fs::read_to_string(&path) {
        Ok(existing) => {
            let updated = match (existing.find(BLOCK_START), existing.find(BLOCK_END)) {
                (Some(start), Some(end_at)) if end_at >= start => {
                    let end = end_at + BLOCK_END.len();
                    format!("{}{}{}", &existing[..start], block, &existing[end..])
                }
                _ => format!("{}\n\n{}\n", existing.trim_end(), block),
            };
            (false, updated)
        }
        Err(_) => (true, format!("{}\n", block)),
    };
    write_creating_dirs(&path, &content)?;
    Ok(FileRecord {
        path: rel.to_string(),
        kind: "block".to_string(),
        pointer: None,
        prior: None,
        created,
    })
}

fn block_strip(path: &Path, we_created: bool) -> Result<(), String> {
    let Ok(existing) = fs::read_to_string(path) else { return Ok(()) };
    let stripped = match (existing.find(BLOCK_START), existing.find(BLOCK_END)) {
        (Some(start), Some(end_at)) if end_at >= start => {
            let end = end_at + BLOCK_END.len();
            let end = if existing[end..].starts_with('\n') { end + 1 } else { end };
            format!("{}{}", existing[..start].trim_end_matches([' ', '\n']), &existing[end..])
        }
        _ => return Ok(()),
    };
    if we_created && stripped.trim().is_empty() {
        fs::remove_file(path).map_err(|e| e.to_string())
    } else {
        fs::write(path, stripped.trim_start_matches('\n')).map_err(|e| e.to_string())
    }
}

// ── Mechanics: merged JSON keys ─────────────────────────────────────────────

/// Set one pointer in a JSON file, recording what was there. Corrupt JSON is
/// an error, never a clobber. On re-install the original prior is kept when
/// the on-disk value is already ours.
fn json_upsert(
    ctx: &InstallCtx,
    manifest: &Manifest,
    agent: Agent,
    rel: &str,
    pointer: &str,
    ours: Value,
) -> Result<FileRecord, String> {
    let path = ctx.resolve(rel);
    let mut root = read_json_or_empty(&path)?;
    let on_disk = root.pointer(pointer).cloned();
    let prior = if on_disk.as_ref() == Some(&ours) {
        // Already ours — the true prior is what the manifest remembered.
        manifest.recorded_prior(agent, rel, pointer).unwrap_or(None)
    } else {
        on_disk
    };
    json_set(&mut root, pointer, ours)?;
    write_json(&path, &root)?;
    Ok(FileRecord {
        path: rel.to_string(),
        kind: "json".to_string(),
        pointer: Some(pointer.to_string()),
        prior,
        created: false,
    })
}

fn json_restore(path: &Path, pointer: &str, prior: Option<Value>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_or_empty(path)?;
    match prior {
        Some(v) => json_set(&mut root, pointer, v)?,
        None => json_remove(&mut root, pointer),
    }
    write_json(path, &root)
}

fn read_json_or_empty(path: &Path) -> Result<Value, String> {
    match fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|_| {
            format!(
                "{} is not valid JSON — refusing to overwrite it. Fix or move the file, then re-run.",
                path.display()
            )
        }),
        Err(_) => Ok(json!({})),
    }
}

fn write_json(path: &Path, root: &Value) -> Result<(), String> {
    let body = serde_json::to_string_pretty(root).map_err(|e| e.to_string())?;
    write_creating_dirs(path, &body)
}

fn json_set(root: &mut Value, pointer: &str, value: Value) -> Result<(), String> {
    let segments: Vec<&str> = pointer.trim_start_matches('/').split('/').collect();
    if segments.is_empty() || segments[0].is_empty() {
        return Err(format!("bad pointer: {pointer}"));
    }
    let mut cur = root;
    for seg in &segments[..segments.len() - 1] {
        if !cur.is_object() {
            return Err(format!("cannot descend into non-object at {seg}"));
        }
        cur = cur
            .as_object_mut()
            .unwrap()
            .entry(seg.to_string())
            .or_insert_with(|| json!({}));
    }
    match cur.as_object_mut() {
        Some(obj) => {
            obj.insert(segments[segments.len() - 1].to_string(), value);
            Ok(())
        }
        None => Err(format!("cannot set key on non-object at {pointer}")),
    }
}

fn json_remove(root: &mut Value, pointer: &str) {
    let segments: Vec<&str> = pointer.trim_start_matches('/').split('/').collect();
    if segments.is_empty() {
        return;
    }
    let mut cur = root;
    for seg in &segments[..segments.len() - 1] {
        match cur.get_mut(*seg) {
            Some(next) => cur = next,
            None => return,
        }
    }
    if let Some(obj) = cur.as_object_mut() {
        obj.remove(segments[segments.len() - 1]);
    }
}

// ── Mechanics: Gemini hook arrays ───────────────────────────────────────────

/// Upsert our SessionStart/AfterAgent entries, preserving every entry that
/// isn't ours. The old init assigned whole arrays here, destroying developer
/// hooks — the exact drift/clobber REL-04 exists to end.
fn gemini_hooks_upsert(ctx: &InstallCtx, rel: &str) -> Result<FileRecord, String> {
    let path = ctx.resolve(rel);
    let mut root = read_json_or_empty(&path)?;
    if root.get("hooks").is_none() {
        json_set(&mut root, "/hooks", json!({}))?;
    }
    for (event, name) in [("SessionStart", "Aura Status"), ("AfterAgent", "Aura Intent Capture")] {
        let ours = json!({
            "matcher": "*",
            "hooks": [{
                "name": name,
                "type": "command",
                "command": "node .gemini/hooks/aura-intent.js"
            }]
        });
        let arr = root
            .pointer_mut("/hooks")
            .and_then(|h| h.as_object_mut())
            .ok_or_else(|| format!("hooks is not an object in {rel}"))?
            .entry(event.to_string())
            .or_insert_with(|| json!([]));
        match arr.as_array_mut() {
            Some(entries) => {
                entries.retain(|e| !is_our_gemini_entry(e));
                entries.push(ours);
            }
            None => return Err(format!("hooks.{event} is not an array in {rel}")),
        }
    }
    write_json(&path, &root)?;
    Ok(FileRecord {
        path: rel.to_string(),
        kind: "hook_entries".to_string(),
        pointer: None,
        prior: None,
        created: false,
    })
}

fn gemini_hooks_strip(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let mut root = read_json_or_empty(path)?;
    let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(());
    };
    for event in ["SessionStart", "AfterAgent"] {
        if let Some(entries) = hooks.get_mut(event).and_then(|a| a.as_array_mut()) {
            entries.retain(|e| !is_our_gemini_entry(e));
        }
    }
    hooks.retain(|_, v| v.as_array().map(|a| !a.is_empty()).unwrap_or(true));
    if hooks.is_empty() {
        root.as_object_mut().map(|o| o.remove("hooks"));
    }
    write_json(path, &root)
}

fn is_our_gemini_entry(entry: &Value) -> bool {
    serde_json::to_string(entry)
        .map(|s| s.contains(GEMINI_HOOK_MARKER))
        .unwrap_or(false)
}

// ── Mechanics: whole files we create ────────────────────────────────────────

fn created_file(
    ctx: &InstallCtx,
    rel: &str,
    content: &str,
    executable: bool,
) -> Result<FileRecord, String> {
    let path = ctx.resolve(rel);
    write_creating_dirs(&path, content)?;
    #[cfg(unix)]
    if executable {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = executable;
    Ok(FileRecord {
        path: rel.to_string(),
        kind: "created".to_string(),
        pointer: None,
        prior: None,
        created: true,
    })
}

fn write_creating_dirs(path: &Path, content: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(path, content).map_err(|e| e.to_string())
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("@{secs}")
}

// ── Tests: the REL-04 acceptance matrix ─────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_ctx() -> (InstallCtx, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        let home = dir.path().join("home");
        fs::create_dir_all(&repo).unwrap();
        fs::create_dir_all(&home).unwrap();
        let ctx = InstallCtx {
            repo_root: repo,
            home,
            aura_bin: AuraBin { command: "/opt/aura/bin/aura".into(), verified: true },
        };
        (ctx, dir)
    }

    fn walk(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else { return out };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p.to_string_lossy().into_owned());
            }
        }
        out.sort();
        out
    }

    /// Which files each agent is allowed to touch — the matrix the audit
    /// asked for. Anything an install writes beyond its row is a failure.
    fn expected_suffixes(agent: Agent) -> Vec<&'static str> {
        match agent {
            Agent::Claude => vec![
                ".mcp.json",
                "CLAUDE.md",
                ".claude/aura-statusline.sh",
                ".claude/settings.json",
            ],
            Agent::Gemini => vec![
                ".gemini/skills/aura-gsd.md",
                ".gemini/hooks/aura-intent.js",
                ".gemini/settings.json",
                "GEMINI.md",
            ],
            Agent::Codex | Agent::Kimi | Agent::OpenCode | Agent::Pi => vec!["AGENTS.md"],
        }
    }

    #[test]
    fn matrix_each_agent_installs_only_its_own_files() {
        for agent in Agent::ALL {
            let (ctx, _guard) = tmp_ctx();
            install(&ctx, &[agent]).unwrap();
            let mut written = walk(&ctx.repo_root);
            written.extend(walk(&ctx.home));
            let manifest = ctx.manifest_path().to_string_lossy().into_owned();
            let allowed = expected_suffixes(agent);
            for w in &written {
                if *w == manifest {
                    continue;
                }
                assert!(
                    allowed.iter().any(|suf| w.ends_with(suf)),
                    "{:?} wrote unexpected file {w}",
                    agent
                );
            }
            // And every allowed file actually landed.
            for suf in allowed {
                assert!(
                    written.iter().any(|w| w.ends_with(suf)),
                    "{:?} did not write {suf}",
                    agent
                );
            }
        }
    }

    #[test]
    fn declining_installs_nothing_at_all() {
        let (ctx, _guard) = tmp_ctx();
        let lines = install(&ctx, &[]).unwrap();
        assert!(lines.is_empty());
        assert!(walk(&ctx.repo_root).is_empty(), "repo touched on decline");
        assert!(walk(&ctx.home).is_empty(), "HOME touched on decline");
    }

    #[test]
    fn repeated_install_is_idempotent_byte_for_byte() {
        let (ctx, _guard) = tmp_ctx();
        let all: Vec<Agent> = Agent::ALL.to_vec();
        install(&ctx, &all).unwrap();
        let snapshot: Vec<(String, String)> = walk(&ctx.repo_root)
            .into_iter()
            .chain(walk(&ctx.home))
            .map(|p| {
                let body = fs::read_to_string(&p).unwrap_or_default();
                (p, body)
            })
            .collect();
        install(&ctx, &all).unwrap();
        for (path, before) in snapshot {
            // installed_at moves; every real integration file must not.
            if path.ends_with("integrations.json") {
                continue;
            }
            let after = fs::read_to_string(&path).unwrap_or_default();
            assert_eq!(before, after, "second install changed {path}");
        }
    }

    #[test]
    fn uninstall_restores_the_developers_prior_config() {
        let (ctx, _guard) = tmp_ctx();
        // A developer with their own status line, MCP server, CLAUDE.md and
        // Gemini session hook.
        let settings = ctx.home.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            serde_json::to_string_pretty(&json!({
                "statusLine": {"type": "command", "command": "my-own-status"},
                "model": "opus"
            }))
            .unwrap(),
        )
        .unwrap();
        let mcp = ctx.repo_root.join(".mcp.json");
        fs::write(
            &mcp,
            serde_json::to_string_pretty(&json!({
                "mcpServers": {"other": {"command": "other-server"}}
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(ctx.repo_root.join("CLAUDE.md"), "# My rules\n\nBe kind.\n").unwrap();
        let gset = ctx.repo_root.join(".gemini/settings.json");
        fs::create_dir_all(gset.parent().unwrap()).unwrap();
        fs::write(
            &gset,
            serde_json::to_string_pretty(&json!({
                "hooks": {"SessionStart": [{"matcher": "*", "hooks": [{"name": "mine", "type": "command", "command": "echo hi"}]}]}
            }))
            .unwrap(),
        )
        .unwrap();

        install(&ctx, &[Agent::Claude, Agent::Gemini]).unwrap();

        // Installed state: ours present, theirs intact.
        let s: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(s["statusLine"]["command"].as_str().unwrap().contains("aura-statusline"));
        assert_eq!(s["model"], "opus");
        let g: Value = serde_json::from_str(&fs::read_to_string(&gset).unwrap()).unwrap();
        let session = g["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session.len(), 2, "user hook must survive install");

        uninstall(&ctx, Agent::Claude).unwrap();
        uninstall(&ctx, Agent::Gemini).unwrap();

        // Restored state: exactly what the developer had.
        let s: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(s["statusLine"]["command"], "my-own-status");
        assert_eq!(s["model"], "opus");
        let m: Value = serde_json::from_str(&fs::read_to_string(&mcp).unwrap()).unwrap();
        assert_eq!(m["mcpServers"]["other"]["command"], "other-server");
        assert!(m["mcpServers"].get("aura-vcs").is_none());
        let claude_md = fs::read_to_string(ctx.repo_root.join("CLAUDE.md")).unwrap();
        assert!(claude_md.contains("Be kind."));
        assert!(!claude_md.contains("AURA_START"));
        let g: Value = serde_json::from_str(&fs::read_to_string(&gset).unwrap()).unwrap();
        let session = g["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session.len(), 1);
        assert_eq!(session[0]["hooks"][0]["name"], "mine");
        assert!(!ctx.home.join(".claude/aura-statusline.sh").exists());
        assert!(!ctx.manifest_path().exists(), "empty manifest must be removed");
    }

    #[test]
    fn reinstall_keeps_the_original_prior_for_the_round_trip() {
        let (ctx, _guard) = tmp_ctx();
        let settings = ctx.home.join(".claude/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            &settings,
            serde_json::to_string_pretty(&json!({
                "statusLine": {"type": "command", "command": "original"}
            }))
            .unwrap(),
        )
        .unwrap();
        install(&ctx, &[Agent::Claude]).unwrap();
        install(&ctx, &[Agent::Claude]).unwrap(); // second run sees OUR value on disk
        uninstall(&ctx, Agent::Claude).unwrap();
        let s: Value = serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(s["statusLine"]["command"], "original");
    }

    #[test]
    fn shared_agents_md_block_survives_until_the_last_owner_leaves() {
        let (ctx, _guard) = tmp_ctx();
        install(&ctx, &[Agent::Codex, Agent::Kimi]).unwrap();
        let agents_md = ctx.repo_root.join("AGENTS.md");
        assert!(agents_md.exists());

        uninstall(&ctx, Agent::Codex).unwrap();
        assert!(
            fs::read_to_string(&agents_md).unwrap().contains("AURA_START"),
            "block must survive while Kimi still owns it"
        );
        uninstall(&ctx, Agent::Kimi).unwrap();
        assert!(!agents_md.exists(), "we created it; last owner leaving removes it");
    }

    #[test]
    fn corrupt_json_is_an_error_never_a_clobber() {
        let (ctx, _guard) = tmp_ctx();
        fs::write(ctx.repo_root.join(".mcp.json"), "{ not json").unwrap();
        let err = install(&ctx, &[Agent::Claude]).unwrap_err();
        assert!(err.contains("not valid JSON"));
        assert_eq!(fs::read_to_string(ctx.repo_root.join(".mcp.json")).unwrap(), "{ not json");
    }

    #[test]
    fn home_scoped_writes_only_for_selected_agents() {
        let (ctx, _guard) = tmp_ctx();
        install(&ctx, &[Agent::Codex, Agent::Pi]).unwrap();
        assert!(walk(&ctx.home).is_empty(), "CLI-first agents must not touch HOME");
    }

    #[test]
    fn verified_binary_is_absolute_and_executable() {
        let bin = verified_aura_binary();
        // In tests current_exe is the test runner — still a real executable,
        // which is exactly what the contract demands.
        assert!(bin.verified);
        assert!(Path::new(&bin.command).is_absolute());
        assert!(is_executable_file(Path::new(&bin.command)));
    }

    #[test]
    fn machine_local_gemini_config_carries_the_absolute_binary() {
        let (ctx, _guard) = tmp_ctx();
        install(&ctx, &[Agent::Gemini]).unwrap();
        let global: Value = serde_json::from_str(
            &fs::read_to_string(ctx.home.join(".gemini/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(global["mcpServers"]["aura-vcs"]["command"], "/opt/aura/bin/aura");
        // Repo-shared config stays portable.
        let project: Value = serde_json::from_str(
            &fs::read_to_string(ctx.repo_root.join(".gemini/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(project["mcpServers"]["aura-vcs"]["command"], "aura");
    }
}
