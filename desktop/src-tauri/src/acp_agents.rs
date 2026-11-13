//! The ACP agents this desktop can run.
//!
//! The list is the ACP Registry: a live copy refreshed on request and cached
//! at `~/.aura/acp/registry.json`, merged over the snapshot shipped in
//! `aura-acp` so an offline machine still knows every agent. Installs land
//! under `~/.aura/acp/agents/<id>/<version>/` (checksummed binaries, or npm
//! with `--prefix` there; never a global prefix). The sign-in method a person
//! picked for an agent is remembered so the next chat signs in the same way.

use aura_acp::registry::{self, install, Availability, Launch, LaunchSource, Probe, Registry, RegistryAgent};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

/// Biggest registry document or agent archive Aura will download.
const MAX_REGISTRY_BYTES: usize = 4 << 20;
const MAX_ARCHIVE_BYTES: usize = 600 << 20;

pub struct AcpAgents {
    registry: Mutex<Registry>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn acp_dir(home: &Path) -> PathBuf {
    home.join(".aura").join("acp")
}

fn which(name: &str) -> Option<PathBuf> {
    registry::find_in_path(name, &std::env::var_os("PATH").unwrap_or_default())
}

impl AcpAgents {
    pub fn load() -> Self {
        let cached = std::fs::read_to_string(acp_dir(&home()).join("registry.json"))
            .ok()
            .and_then(|raw| Registry::parse(&raw).ok());
        Self { registry: Mutex::new(Registry::merged(cached)) }
    }

    pub fn snapshot(&self) -> Registry {
        self.registry.lock().map(|r| r.clone()).unwrap_or_else(|_| Registry::pinned())
    }

    fn replace(&self, live: Registry) {
        if let Ok(mut r) = self.registry.lock() {
            *r = Registry::merged(Some(live));
        }
    }
}

/// How to start `aura_id`'s ACP server here, if this machine has one: an
/// agent Aura installed, or the agent's own CLI on PATH. Claude Code and
/// Codex only qualify through their ACP adapters, which a person installs
/// on purpose, so their native chat stays the default until then.
pub fn chat_launch(agents: &AcpAgents, aura_id: &str) -> Option<(RegistryAgent, Launch)> {
    let reg = agents.snapshot();
    let home = home();
    let probe = Probe { home: &home, which: &which };
    let ids = match registry::registry_ids_for(aura_id) {
        ids if ids.is_empty() => vec![aura_id],
        ids => ids,
    };
    ids.into_iter().find_map(|id| {
        let agent = reg.get(id)?.clone();
        match registry::resolve(&agent, &probe) {
            Availability::Ready { launch } if chat_ready(aura_id, &launch) => Some((agent, launch)),
            _ => None,
        }
    })
}

/// Every registry agent this machine can launch now, with its launch: the
/// agents workspace chat can run, resolved the same way, for the manager's
/// brain picker. Read from the cached registry, so listing costs no network.
pub fn launchable() -> Vec<(RegistryAgent, Launch)> {
    let reg = AcpAgents::load().snapshot();
    let home = home();
    let probe = Probe { home: &home, which: &which };
    reg.agents
        .iter()
        .filter_map(|agent| match registry::resolve(agent, &probe) {
            Availability::Ready { launch } if chat_ready(registry::aura_id_for(&agent.id), &launch) => {
                Some((agent.clone(), launch))
            }
            _ => None,
        })
        .collect()
}

/// Agents whose own stream Aura already renders natively.
const NATIVE_CHAT: &[&str] = &["claude", "codex"];

/// An adapter found on PATH does not move a native-chat agent onto ACP;
/// installing it through Aura does.
fn chat_ready(aura_id: &str, launch: &Launch) -> bool {
    !NATIVE_CHAT.contains(&aura_id) || matches!(launch.source, LaunchSource::Installed { .. })
}

fn launch_for(agents: &AcpAgents, id: &str) -> Result<(RegistryAgent, Launch), String> {
    let reg = agents.snapshot();
    let agent = reg.get(id).ok_or_else(|| format!("{id} is not in the ACP registry"))?.clone();
    let home = home();
    match registry::resolve(&agent, &Probe { home: &home, which: &which }) {
        Availability::Ready { launch } => Ok((agent, launch)),
        _ => Err(format!("{} is not installed on this machine", agent.name)),
    }
}

// ── remembered sign-in ─────────────────────────────────────────────────

fn auth_path(home: &Path) -> PathBuf {
    acp_dir(home).join("sign-in.json")
}

fn read_auth(home: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(auth_path(home)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The protocol sign-in method a person chose for this agent before. Only
/// ever an `agent`-type method: terminal sign-in is never replayed.
pub fn remembered_sign_in(registry_id: &str) -> Option<String> {
    read_auth(&home()).get(registry_id).cloned()
}

pub fn remember_sign_in(registry_id: &str, method_id: Option<&str>) {
    let home = home();
    let mut all = read_auth(&home);
    match method_id {
        Some(m) => all.insert(registry_id.to_string(), m.to_string()),
        None => all.remove(registry_id),
    };
    let _ = std::fs::create_dir_all(acp_dir(&home));
    if let Ok(body) = serde_json::to_vec_pretty(&all) {
        let _ = std::fs::write(auth_path(&home), body);
    }
}

// ── tauri commands ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AcpAgentRow {
    pub id: String,
    pub aura_id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub website: Option<String>,
    pub license: Option<String>,
    pub icon: Option<String>,
    /// `ready` | `installable` | `unavailable`.
    pub state: &'static str,
    pub source: Option<LaunchSource>,
    pub program: Option<String>,
    /// `binary` | `npm`, when installable.
    pub install_method: Option<&'static str>,
    /// Installable only without a published checksum.
    pub unverified: bool,
    pub reason: Option<String>,
    pub signed_in_with: Option<String>,
}

fn row(agent: &RegistryAgent, availability: Availability, signed_in: &BTreeMap<String, String>) -> AcpAgentRow {
    let mut r = AcpAgentRow {
        id: agent.id.clone(),
        aura_id: registry::aura_id_for(&agent.id).to_string(),
        name: agent.name.clone(),
        version: agent.version.clone(),
        description: agent.description.clone(),
        website: agent.website.clone().or_else(|| agent.repository.clone()),
        license: agent.license.clone(),
        icon: agent.icon.clone(),
        state: "unavailable",
        source: None,
        program: None,
        install_method: None,
        unverified: false,
        reason: None,
        signed_in_with: signed_in.get(&agent.id).cloned(),
    };
    match availability {
        Availability::Ready { launch } => {
            r.state = "ready";
            r.program = Some(launch.program.display().to_string());
            r.source = Some(launch.source);
        }
        Availability::Installable { plan } => {
            r.state = "installable";
            r.unverified = plan.unverified();
            r.install_method = Some(match plan {
                install::InstallPlan::Binary { .. } => "binary",
                install::InstallPlan::Npm { .. } => "npm",
            });
        }
        Availability::Unavailable { reason } => r.reason = Some(reason),
    }
    r
}

fn rows(agents: &AcpAgents) -> Vec<AcpAgentRow> {
    let home = home();
    let probe = Probe { home: &home, which: &which };
    let signed_in = read_auth(&home);
    let reg = agents.snapshot();
    let mut out: Vec<AcpAgentRow> =
        reg.agents.iter().map(|a| row(a, registry::resolve(a, &probe), &signed_in)).collect();
    out.sort_by(|a, b| (a.state != "ready", a.name.to_lowercase()).cmp(&(b.state != "ready", b.name.to_lowercase())));
    out
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("aura-desktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())
}

async fn download(url: &str, cap: usize, timeout: Duration) -> Result<Vec<u8>, String> {
    if !url.starts_with("https://") {
        return Err(format!("refusing a non-https download: {url}"));
    }
    let mut resp = client()?
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download failed: {e}"))?;
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download failed: {e}"))? {
        if body.len() + chunk.len() > cap {
            return Err("download is larger than Aura accepts for an agent".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// What installing `agent` has to do from where it stands now: nothing when
/// the registry's version already runs, the registry's version when Aura's
/// own copy is older (an update; the older copy stays until uninstall, so a
/// chat still running on it is not pulled out from under), or a first
/// install. An agent found on PATH belongs to the person and is left alone.
fn install_plan(
    agent: &RegistryAgent,
    now: Availability,
    probe: &Probe<'_>,
) -> Result<Option<install::InstallPlan>, String> {
    match now {
        Availability::Installable { plan } => Ok(Some(plan)),
        Availability::Ready { launch: Launch { source: LaunchSource::Installed { version }, .. } }
            if version != agent.version =>
        {
            install::plan(agent, probe)
                .map(Some)
                .ok_or_else(|| format!("{} {} has no build for this machine", agent.name, agent.version))
        }
        Availability::Ready { .. } => Ok(None),
        Availability::Unavailable { reason } => Err(reason),
    }
}

/// Every registry agent and how it stands on this machine. `refresh`
/// fetches the live registry first (falling back to what is cached).
#[tauri::command]
pub async fn acp_agents_list(state: State<'_, AcpAgents>, refresh: Option<bool>) -> Result<Vec<AcpAgentRow>, String> {
    if refresh.unwrap_or(false) {
        if let Ok(body) = download(registry::REGISTRY_URL, MAX_REGISTRY_BYTES, Duration::from_secs(15)).await {
            if let Ok(text) = String::from_utf8(body) {
                if let Ok(live) = Registry::parse(&text) {
                    let dir = acp_dir(&home());
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(dir.join("registry.json"), &text);
                    state.replace(live);
                }
            }
        }
    }
    Ok(rows(&state))
}

/// Install one registry agent for this user. A binary without a published
/// checksum installs only with `allow_unverified`, after the person agreed.
#[tauri::command]
pub async fn acp_agent_install(
    state: State<'_, AcpAgents>,
    id: String,
    allow_unverified: Option<bool>,
) -> Result<AcpAgentRow, String> {
    let reg = state.snapshot();
    let agent = reg.get(&id).ok_or_else(|| format!("{id} is not in the ACP registry"))?.clone();
    let home = home();
    // The probe borrows a non-Send closure, so it never lives across an await.
    let resolve_now = |agent: &RegistryAgent| registry::resolve(agent, &Probe { home: &home, which: &which });
    let plan = match install_plan(&agent, resolve_now(&agent), &Probe { home: &home, which: &which })? {
        Some(plan) => plan,
        None => return Ok(row(&agent, resolve_now(&agent), &read_auth(&home))),
    };
    match &plan {
        install::InstallPlan::Binary { url, .. } => {
            let bytes = download(url, MAX_ARCHIVE_BYTES, Duration::from_secs(600)).await?;
            let (p, h, allow) = (plan.clone(), home.clone(), allow_unverified.unwrap_or(false));
            tokio::task::spawn_blocking(move || install::install_binary(&p, &h, &bytes, allow))
                .await
                .map_err(|e| e.to_string())??;
        }
        install::InstallPlan::Npm { .. } => {
            let p = plan.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                std::fs::create_dir_all(p.dir()).map_err(|e| e.to_string())?;
                let mut cmd = install::npm_install_command(&p).ok_or("not an npm plan")?;
                let out = cmd.output().map_err(|e| format!("npm: {e}"))?;
                if !out.status.success() {
                    let tail: String = String::from_utf8_lossy(&out.stderr).lines().rev().take(6).collect::<Vec<_>>().join("\n");
                    return Err(format!("npm install failed: {tail}"));
                }
                install::finish_npm(&p).map(|_| ())
            })
            .await
            .map_err(|e| e.to_string())??;
        }
    }
    Ok(row(&agent, resolve_now(&agent), &read_auth(&home)))
}

/// Remove an agent Aura installed (every version). Agents found on PATH
/// belong to the person and are never touched.
#[tauri::command]
pub fn acp_agent_uninstall(id: String) -> Result<(), String> {
    let dir = install::agents_root(&home()).join(&id);
    if id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.') {
        return Err("not an agent id".into());
    }
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not remove {id}: {e}"))?;
    }
    Ok(())
}

/// The agent's own saved sessions for this folder (`session/list`), newest
/// first, so a chat can be reopened later. Empty when the agent cannot list.
#[tauri::command]
pub async fn acp_agent_sessions(
    state: State<'_, AcpAgents>,
    id: String,
    repo_root: String,
) -> Result<Vec<aura_acp::session::ListedSession>, String> {
    let (_, launch) = launch_for(&state, &id)?;
    let mut cmd = launch.command();
    cmd.current_dir(crate::spawn_dir::safe_spawn_dir(&repo_root));
    #[cfg(unix)]
    cmd.process_group(0);
    let (conn, _rx) = aura_acp::Connection::spawn(cmd, aura_acp::ConnOpts::default()).map_err(|e| e.to_string())?;
    let listed = tokio::time::timeout(Duration::from_secs(20), async {
        let driver = aura_acp::Driver::initialize(
            conn.clone(),
            &aura_acp::ClientInfo::aura(env!("CARGO_PKG_VERSION")),
            &aura_acp::ClientCaps::default(),
        )
        .await?;
        if !driver.agent.list {
            return Ok(Vec::new());
        }
        driver.list(Some(&repo_root), 5).await
    })
    .await;
    conn.close("listed");
    let mut sessions = listed.map_err(|_| "the agent did not answer in time".to_string())?.map_err(|e| e.to_string())?;
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// Forget the sign-in method remembered for an agent.
#[tauri::command]
pub fn acp_agent_forget_sign_in(id: String) -> Result<(), String> {
    remember_sign_in(&id, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_cover_the_whole_registry_and_name_their_aura_agent() {
        let agents = AcpAgents { registry: Mutex::new(Registry::pinned()) };
        let all = rows(&agents);
        assert_eq!(all.len(), Registry::pinned().agents.len());
        let claude = all.iter().find(|r| r.id == "claude-acp").unwrap();
        assert_eq!(claude.aura_id, "claude");
        assert!(matches!(claude.state, "ready" | "installable" | "unavailable"));
    }

    #[test]
    fn native_chat_agents_move_to_acp_only_through_an_aura_install() {
        let mut l = Launch {
            registry_id: "claude-acp".into(),
            program: PathBuf::from("/usr/local/bin/claude-agent-acp"),
            args: vec![],
            env: Default::default(),
            source: LaunchSource::Path,
        };
        assert!(!chat_ready("claude", &l));
        assert!(chat_ready("gemini", &l));
        l.source = LaunchSource::Installed { version: "0.103.0".into() };
        assert!(chat_ready("claude", &l));
    }

    #[test]
    fn uninstall_refuses_paths() {
        assert!(acp_agent_uninstall("../x".into()).is_err());
        assert!(acp_agent_uninstall(".hidden".into()).is_err());
    }

    /// A finished install of `id` at `version` under `home`, as the installer
    /// leaves it: the marker file and the program it names.
    fn installed_at(home: &Path, id: &str, version: &str) {
        let dir = install::install_dir(home, id, version);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin").join("agent"), b"").unwrap();
        let marker = install::Marker { id: id.into(), version: version.into(), program: "bin/agent".into(), args: vec![] };
        std::fs::write(dir.join(install::MARKER), serde_json::to_vec(&marker).unwrap()).unwrap();
    }

    #[test]
    fn an_older_aura_install_updates_to_the_registry_version() {
        let home = tempfile::tempdir().unwrap();
        let reg = Registry::pinned();
        let gemini = reg.get("gemini").unwrap();
        let npm = |name: &str| (name == "npm").then(|| PathBuf::from("/usr/bin/npm"));
        let probe = Probe { home: home.path(), which: &npm };
        installed_at(home.path(), "gemini", "0.1.0");

        let now = registry::resolve(gemini, &probe);
        assert!(matches!(&now, Availability::Ready { launch } if launch.source == LaunchSource::Installed { version: "0.1.0".into() }));
        match install_plan(gemini, now, &probe).unwrap() {
            Some(install::InstallPlan::Npm { version, .. }) => assert_eq!(version, gemini.version),
            other => panic!("expected an npm update, got {other:?}"),
        }

        installed_at(home.path(), "gemini", &gemini.version);
        assert_eq!(install_plan(gemini, registry::resolve(gemini, &probe), &probe).unwrap(), None);
    }

    #[test]
    fn an_agent_on_path_is_never_reinstalled() {
        let home = tempfile::tempdir().unwrap();
        let reg = Registry::pinned();
        let gemini = reg.get("gemini").unwrap();
        let both = |name: &str| matches!(name, "npm" | "gemini").then(|| PathBuf::from(format!("/usr/bin/{name}")));
        let probe = Probe { home: home.path(), which: &both };
        let now = registry::resolve(gemini, &probe);
        assert!(matches!(&now, Availability::Ready { launch } if launch.source == LaunchSource::Path));
        assert_eq!(install_plan(gemini, now, &probe).unwrap(), None);
    }

    #[tokio::test]
    async fn downloads_must_be_https() {
        assert!(download("http://example.invalid/a.zip", 10, Duration::from_secs(1)).await.unwrap_err().contains("https"));
    }
}
