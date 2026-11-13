//! The ACP Registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`):
//! which agents exist, how each is distributed, and how to launch the copy
//! this machine has.
//!
//! Fetching is the caller's job (it owns the HTTP client); this module
//! parses, merges a live copy over the pinned snapshot shipped in the crate
//! (so an offline machine still knows every agent), and resolves launches.

pub mod install;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const REGISTRY_URL: &str = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// Snapshot of the registry taken when this crate was last released.
pub const PINNED_JSON: &str = include_str!("pinned.json");

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Registry {
    pub version: String,
    pub agents: Vec<RegistryAgent>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub distribution: Distribution,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct Distribution {
    #[serde(default)]
    pub npx: Option<PackageDist>,
    #[serde(default)]
    pub uvx: Option<PackageDist>,
    #[serde(default)]
    pub binary: BTreeMap<String, BinaryDist>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PackageDist {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct BinaryDist {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

impl Registry {
    pub fn parse(json: &str) -> Result<Registry, String> {
        let r: Registry = serde_json::from_str(json).map_err(|e| format!("bad ACP registry: {e}"))?;
        if !r.version.starts_with("1.") {
            return Err(format!("unsupported ACP registry version {}", r.version));
        }
        Ok(r)
    }

    pub fn pinned() -> Registry {
        Self::parse(PINNED_JSON).expect("pinned ACP registry snapshot parses")
    }

    /// Live entries win; agents only the snapshot knows are kept, so a
    /// registry hiccup never makes an agent disappear.
    pub fn merged(live: Option<Registry>) -> Registry {
        let mut base = Self::pinned();
        let Some(live) = live else { return base };
        for agent in live.agents {
            match base.agents.iter_mut().find(|a| a.id == agent.id) {
                Some(slot) => *slot = agent,
                None => base.agents.push(agent),
            }
        }
        base.version = live.version;
        base
    }

    pub fn get(&self, id: &str) -> Option<&RegistryAgent> {
        self.agents.iter().find(|a| a.id == id)
    }
}

/// This machine's registry platform key, e.g. `darwin-aarch64`.
pub fn platform_key() -> Option<&'static str> {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        return None;
    };
    Some(match (os, arch) {
        ("darwin", "aarch64") => "darwin-aarch64",
        ("darwin", _) => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", _) => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        _ => "windows-x86_64",
    })
}

/// Aura's agent ids → the registry entries that serve them over ACP, in
/// preference order. Agents not listed here use their registry id.
pub const AURA_TO_REGISTRY: &[(&str, &[&str])] = &[
    ("claude", &["claude-acp"]),
    ("codex", &["codex-acp"]),
    ("gemini", &["gemini"]),
    ("opencode", &["opencode"]),
    ("goose", &["goose"]),
    ("cursor", &["cursor"]),
    ("kimi", &["kimi-code", "kimi"]),
    ("copilot", &["github-copilot-cli"]),
    ("qwen", &["qwen-code"]),
    ("pi", &["pi-acp"]),
    ("amp", &["amp-acp"]),
];

pub fn registry_ids_for(aura_id: &str) -> Vec<&str> {
    AURA_TO_REGISTRY
        .iter()
        .find(|(a, _)| *a == aura_id)
        .map(|(_, ids)| ids.to_vec())
        .unwrap_or_else(|| vec![aura_id])
}

pub fn aura_id_for(registry_id: &str) -> &str {
    AURA_TO_REGISTRY
        .iter()
        .find(|(_, ids)| ids.contains(&registry_id))
        .map(|(a, _)| *a)
        .unwrap_or(registry_id)
}

/// Executable names a registry entry goes by when its CLI is installed on
/// PATH by other means (a package manager, the vendor installer). npm bin
/// names cannot be derived from package names, so the common ones are
/// listed; the rest fall back to the binary `cmd` or the package's last
/// path segment.
const PATH_NAMES: &[(&str, &[&str])] = &[
    ("claude-acp", &["claude-agent-acp", "claude-code-acp"]),
    ("codex-acp", &["codex-acp"]),
    ("gemini", &["gemini"]),
    ("cursor", &["cursor-agent"]),
    ("kimi-code", &["kimi"]),
    ("kimi", &["kimi"]),
    ("github-copilot-cli", &["copilot"]),
    ("qwen-code", &["qwen"]),
    ("factory-droid", &["droid"]),
    ("kilo", &["kilo", "kilocode"]),
    ("auggie", &["auggie"]),
];

impl RegistryAgent {
    pub fn path_names(&self) -> Vec<String> {
        if let Some((_, names)) = PATH_NAMES.iter().find(|(id, _)| *id == self.id) {
            return names.iter().map(|s| s.to_string()).collect();
        }
        let mut out = Vec::new();
        if let Some(b) = platform_key().and_then(|p| self.distribution.binary.get(p)) {
            if let Some(name) = Path::new(&b.cmd).file_name().and_then(|n| n.to_str()) {
                out.push(name.to_string());
            }
        }
        for p in [&self.distribution.npx, &self.distribution.uvx].into_iter().flatten() {
            let name = package_name(&p.package);
            let last = name.rsplit('/').next().unwrap_or(name).to_string();
            if !out.contains(&last) {
                out.push(last);
            }
        }
        out
    }

    /// The ACP args and env for launching this agent from a given source.
    pub fn launch_args(&self) -> (Vec<String>, BTreeMap<String, String>) {
        if let Some(b) = platform_key().and_then(|p| self.distribution.binary.get(p)) {
            return (b.args.clone(), b.env.clone());
        }
        if let Some(n) = &self.distribution.npx {
            return (n.args.clone(), n.env.clone());
        }
        if let Some(u) = &self.distribution.uvx {
            return (u.args.clone(), u.env.clone());
        }
        (Vec::new(), BTreeMap::new())
    }
}

/// `@scope/name@1.2.3` → `@scope/name`; `name==1.2` → `name`.
pub fn package_name(spec: &str) -> &str {
    let spec = spec.split("==").next().unwrap_or(spec);
    match spec.rfind('@') {
        Some(0) | None => spec,
        Some(i) => &spec[..i],
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LaunchSource {
    /// Installed by Aura under `~/.aura/acp/agents/<id>/<version>`.
    Installed { version: String },
    /// Found on PATH.
    Path,
    /// Run through `uvx`, which fetches and caches the package itself.
    Uvx,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Launch {
    pub registry_id: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub source: LaunchSource,
}

impl Launch {
    pub fn command(&self) -> tokio::process::Command {
        let mut c = tokio::process::Command::new(&self.program);
        c.args(&self.args);
        for (k, v) in &self.env {
            c.env(k, v);
        }
        c
    }
}

/// How one registry agent stands on this machine.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Availability {
    Ready { launch: Launch },
    Installable { plan: install::InstallPlan },
    Unavailable { reason: String },
}

/// What the resolver may look at. Injected so tests never read the real
/// PATH or home directory.
pub struct Probe<'a> {
    pub home: &'a Path,
    pub which: &'a dyn Fn(&str) -> Option<PathBuf>,
}

/// Resolve one registry agent: an Aura-installed copy first, then a CLI
/// already on PATH, then uvx, else how to install it.
pub fn resolve(agent: &RegistryAgent, probe: &Probe<'_>) -> Availability {
    let (args, env) = agent.launch_args();
    if let Some((version, program, iargs)) = install::installed(probe.home, &agent.id, &agent.version) {
        return Availability::Ready {
            launch: Launch { registry_id: agent.id.clone(), program, args: iargs, env, source: LaunchSource::Installed { version } },
        };
    }
    for name in agent.path_names() {
        if let Some(program) = (probe.which)(&name) {
            return Availability::Ready {
                launch: Launch { registry_id: agent.id.clone(), program, args, env, source: LaunchSource::Path },
            };
        }
    }
    if let Some(u) = &agent.distribution.uvx {
        if let Some(uvx) = (probe.which)("uvx") {
            let mut a = vec!["--from".to_string(), u.package.clone(), package_name(&u.package).to_string()];
            a.extend(u.args.iter().cloned());
            return Availability::Ready {
                launch: Launch { registry_id: agent.id.clone(), program: uvx, args: a, env, source: LaunchSource::Uvx },
            };
        }
    }
    match install::plan(agent, probe) {
        Some(plan) => Availability::Installable { plan },
        None => Availability::Unavailable { reason: format!("{} has no build for this machine", agent.name) },
    }
}

/// Look `name` up in a PATH-style list of directories.
pub fn find_in_path(name: &str, path: &std::ffi::OsStr) -> Option<PathBuf> {
    if name.contains('/') || name.contains('\\') {
        return None;
    }
    std::env::split_paths(path).find_map(|dir| {
        let candidate = dir.join(name);
        is_executable(&candidate).then_some(candidate)
    })
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file() || p.with_extension("exe").is_file() || p.with_extension("cmd").is_file()
}
