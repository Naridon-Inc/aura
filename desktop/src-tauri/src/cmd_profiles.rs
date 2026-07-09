//! Agent + git identity profiles.
//!
//! Two independent concerns share this module because they bind to the
//! same place (a workspace) and ship through the same env-injection
//! site (agent PTY spawn).
//!
//! - **Agent profiles** — named isolated HOME dirs at
//!   `~/.aura/agent-profiles/<name>/`. Picking a profile when launching
//!   an agent PTY swaps `HOME` for the child so Claude/Gemini/Cursor see
//!   a fresh login state (`.claude/`, `.gemini/`, `.codex/` all live
//!   inside that dir). Lets the user run multiple accounts side-by-side.
//!
//! - **Git profiles** — named `{user_name, user_email, signing_key?}`
//!   tuples in `~/.aura/git-profiles.json`. Bound to a workspace via
//!   either a per-repo `<repo>/.aura/profile.json` (authoritative) or a
//!   global `~/.aura/workspace-profiles.json` (fallback). When an agent
//!   PTY opens for a workspace with a binding, we inject
//!   `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_*` env so any
//!   commit the agent makes carries the right identity — without
//!   touching `.git/config`.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ── locations ───────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn aura_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".aura"))
}

fn agent_profiles_root() -> Option<PathBuf> {
    aura_dir().map(|d| d.join("agent-profiles"))
}

fn git_profiles_path() -> Option<PathBuf> {
    aura_dir().map(|d| d.join("git-profiles.json"))
}

fn workspace_profiles_path() -> Option<PathBuf> {
    aura_dir().map(|d| d.join("workspace-profiles.json"))
}

fn per_repo_binding_path(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(".aura").join("profile.json")
}

// ── types ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub name: String,
    pub label: Option<String>,
    pub created_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitProfile {
    pub id: String,
    pub label: String,
    pub user_name: String,
    pub user_email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkspaceBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_profile_name: Option<String>,
    /// Where this binding was loaded from. "repo" = per-repo file
    /// (authoritative), "global" = ~/.aura map (fallback). Set by the
    /// resolver, not persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GlobalBindingsFile {
    /// Absolute repo path → binding.
    #[serde(default)]
    bindings: std::collections::BTreeMap<String, WorkspaceBinding>,
}

// ── agent profile helpers ────────────────────────────────────────────────

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sanitize_profile_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
}

/// Resolve a profile name to its on-disk HOME path, creating the
/// directory tree if missing. Returns None if HOME itself can't be
/// resolved.
pub fn agent_profile_home(name: &str) -> Option<PathBuf> {
    let root = agent_profiles_root()?;
    let safe = sanitize_profile_name(name);
    if safe.is_empty() {
        return None;
    }
    let dir = root.join(&safe);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn read_agent_profile_metadata(dir: &Path, name: &str) -> AgentProfile {
    let meta_path = dir.join("metadata.json");
    if let Ok(s) = fs::read_to_string(&meta_path) {
        if let Ok(mut p) = serde_json::from_str::<AgentProfile>(&s) {
            p.name = name.to_string();
            return p;
        }
    }
    AgentProfile {
        name: name.to_string(),
        label: None,
        created_at: dir
            .metadata()
            .and_then(|m| m.created())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
    }
}

// ── git profile helpers ──────────────────────────────────────────────────

fn read_git_profiles_file() -> Vec<GitProfile> {
    let Some(p) = git_profiles_path() else { return vec![] };
    let Ok(s) = fs::read_to_string(&p) else { return vec![] };
    serde_json::from_str::<Vec<GitProfile>>(&s).unwrap_or_default()
}

fn write_git_profiles_file(list: &[GitProfile]) -> Result<(), String> {
    let p = git_profiles_path().ok_or("no HOME — cannot write git profiles")?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let s = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

pub fn find_git_profile(id: &str) -> Option<GitProfile> {
    read_git_profiles_file().into_iter().find(|p| p.id == id)
}

// ── workspace binding resolver ───────────────────────────────────────────

fn read_per_repo_binding(repo_root: &str) -> Option<WorkspaceBinding> {
    let p = per_repo_binding_path(repo_root);
    let s = fs::read_to_string(&p).ok()?;
    let mut b: WorkspaceBinding = serde_json::from_str(&s).ok()?;
    b.source = Some("repo".into());
    Some(b)
}

fn read_global_binding(repo_root: &str) -> Option<WorkspaceBinding> {
    let p = workspace_profiles_path()?;
    let s = fs::read_to_string(&p).ok()?;
    let file: GlobalBindingsFile = serde_json::from_str(&s).ok()?;
    let mut b = file.bindings.get(repo_root).cloned()?;
    b.source = Some("global".into());
    Some(b)
}

/// Returns the binding for `repo_root`, repo file taking precedence over
/// the global map. Empty (non-None) binding still means "explicitly no
/// profile" — caller checks the inner Options.
pub fn resolve_workspace_binding(repo_root: &str) -> WorkspaceBinding {
    if let Some(b) = read_per_repo_binding(repo_root) {
        return b;
    }
    if let Some(b) = read_global_binding(repo_root) {
        return b;
    }
    WorkspaceBinding::default()
}

fn write_per_repo_binding(repo_root: &str, b: &WorkspaceBinding) -> Result<(), String> {
    let p = per_repo_binding_path(repo_root);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut to_write = b.clone();
    to_write.source = None; // never persist source field
    let s = serde_json::to_string_pretty(&to_write).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

fn write_global_binding(repo_root: &str, b: &WorkspaceBinding) -> Result<(), String> {
    let p = workspace_profiles_path().ok_or("no HOME — cannot write workspace bindings")?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file: GlobalBindingsFile = fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(GlobalBindingsFile {
            bindings: Default::default(),
        });
    let mut to_write = b.clone();
    to_write.source = None;
    if to_write.git_profile_id.is_none() && to_write.agent_profile_name.is_none() {
        file.bindings.remove(repo_root);
    } else {
        file.bindings.insert(repo_root.to_string(), to_write);
    }
    let s = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

// ── env injection helper (called from agent_pty_open) ────────────────────

/// Resolves the effective agent + git profile for a workspace, taking an
/// explicit override for the agent profile (when the user picks
/// "Isolated session…" from the launcher). Returns the env tuples to
/// inject on the spawned child:
///
/// - `HOME=<agent profile dir>` when an agent profile is selected.
/// - `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL` when a git
///   profile is bound. Also `GIT_AUTHOR_DATE` is left to the agent.
///
/// The returned vector is meant to be merged into the existing
/// `cmd.env(...)` calls — caller does the actual `cmd.env(k, v)` (or
/// pushes onto the daemon's env_extras Vec) per spawn path.
pub fn build_profile_env(
    repo_root: &str,
    explicit_agent_profile: Option<&str>,
) -> Vec<(String, String)> {
    let binding = resolve_workspace_binding(repo_root);
    let mut env: Vec<(String, String)> = Vec::new();

    let effective_agent = explicit_agent_profile
        .map(|s| s.to_string())
        .or_else(|| binding.agent_profile_name.clone());
    if let Some(name) = effective_agent.as_deref() {
        if let Some(home) = agent_profile_home(name) {
            env.push(("HOME".into(), home.to_string_lossy().into_owned()));
            // Tag the env so the spawned shell prompt / agent banner
            // can show which profile it's running under.
            env.push(("AURA_AGENT_PROFILE".into(), name.to_string()));
        }
    }

    if let Some(gid) = binding.git_profile_id.as_deref() {
        if let Some(g) = find_git_profile(gid) {
            env.push(("GIT_AUTHOR_NAME".into(), g.user_name.clone()));
            env.push(("GIT_AUTHOR_EMAIL".into(), g.user_email.clone()));
            env.push(("GIT_COMMITTER_NAME".into(), g.user_name.clone()));
            env.push(("GIT_COMMITTER_EMAIL".into(), g.user_email.clone()));
            if let Some(sk) = g.signing_key.as_deref() {
                env.push(("GIT_CONFIG_COUNT".into(), "1".into()));
                env.push(("GIT_CONFIG_KEY_0".into(), "user.signingkey".into()));
                env.push(("GIT_CONFIG_VALUE_0".into(), sk.to_string()));
            }
            env.push(("AURA_GIT_PROFILE".into(), gid.to_string()));
        }
    }

    env
}

// ── tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_profile_list() -> Result<Vec<AgentProfile>, String> {
    let Some(root) = agent_profiles_root() else {
        return Ok(vec![]);
    };
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out: Vec<AgentProfile> = Vec::new();
    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with('.') {
            continue;
        }
        out.push(read_agent_profile_metadata(&path, name));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn agent_profile_create(name: String, label: Option<String>) -> Result<AgentProfile, String> {
    let safe = sanitize_profile_name(&name);
    if safe.is_empty() {
        return Err("invalid profile name".into());
    }
    let root = agent_profiles_root().ok_or("no HOME")?;
    let dir = root.join(&safe);
    if dir.exists() {
        return Err(format!("profile '{safe}' already exists"));
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let profile = AgentProfile {
        name: safe.clone(),
        label,
        created_at: Some(now_unix()),
    };
    let meta = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    fs::write(dir.join("metadata.json"), meta).map_err(|e| e.to_string())?;
    Ok(profile)
}

#[tauri::command]
pub fn agent_profile_delete(name: String) -> Result<(), String> {
    let safe = sanitize_profile_name(&name);
    if safe.is_empty() {
        return Err("invalid profile name".into());
    }
    let root = agent_profiles_root().ok_or("no HOME")?;
    let dir = root.join(&safe);
    if !dir.exists() {
        return Ok(());
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_profile_list() -> Result<Vec<GitProfile>, String> {
    Ok(read_git_profiles_file())
}

#[tauri::command]
pub fn git_profile_upsert(profile: GitProfile) -> Result<GitProfile, String> {
    let mut list = read_git_profiles_file();
    if profile.id.trim().is_empty() {
        return Err("git profile id is required".into());
    }
    if profile.user_name.trim().is_empty() || profile.user_email.trim().is_empty() {
        return Err("user_name and user_email are required".into());
    }
    if let Some(existing) = list.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        list.push(profile.clone());
    }
    write_git_profiles_file(&list)?;
    Ok(profile)
}

#[tauri::command]
pub fn git_profile_delete(id: String) -> Result<(), String> {
    let mut list = read_git_profiles_file();
    let before = list.len();
    list.retain(|p| p.id != id);
    if list.len() == before {
        return Ok(());
    }
    write_git_profiles_file(&list)
}

#[tauri::command]
pub fn workspace_profile_get(repo_root: String) -> Result<WorkspaceBinding, String> {
    Ok(resolve_workspace_binding(&repo_root))
}

/// `scope` is "repo" (write `<repo>/.aura/profile.json`) or "global"
/// (update `~/.aura/workspace-profiles.json`). Empty binding under
/// "global" removes the entry; under "repo" it writes a minimal file
/// (so the user can still tell us "no profile, don't fall back to
/// global" by writing an empty repo file).
#[tauri::command]
pub fn workspace_profile_set(
    repo_root: String,
    binding: WorkspaceBinding,
    scope: String,
) -> Result<WorkspaceBinding, String> {
    match scope.as_str() {
        "repo" => {
            write_per_repo_binding(&repo_root, &binding)?;
        }
        "global" => {
            write_global_binding(&repo_root, &binding)?;
        }
        other => return Err(format!("unknown scope: {other}")),
    }
    Ok(resolve_workspace_binding(&repo_root))
}
