//! Installing registry agents under `~/.aura/acp/agents/<id>/<version>/`.
//!
//! Binary archives are checked against the registry's sha256 before they
//! are unpacked; an entry that publishes no checksum installs only when the
//! caller says so (`allow_unverified`), because the person must have been
//! told. npm packages install with `npm install --prefix <dir>`, so nothing
//! lands in a global prefix. Every finished install writes a marker file;
//! a directory without one is a half-done install and is ignored.

use super::{package_name, platform_key, Probe, RegistryAgent};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MARKER: &str = "aura-acp.json";

pub fn agents_root(home: &Path) -> PathBuf {
    home.join(".aura").join("acp").join("agents")
}

pub fn install_dir(home: &Path, id: &str, version: &str) -> PathBuf {
    agents_root(home).join(safe_segment(id)).join(safe_segment(version))
}

/// Where npm puts an installed package's executable inside `dir`.
pub fn npm_bin_path(dir: &Path, bin: &str) -> PathBuf {
    let name = if cfg!(windows) { format!("{bin}.cmd") } else { bin.to_string() };
    dir.join("node_modules").join(".bin").join(name)
}

fn safe_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
        .collect::<String>()
        .trim_start_matches('.')
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub id: String,
    pub version: String,
    /// Relative to the install directory.
    pub program: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
}

fn read_marker(dir: &Path) -> Option<Marker> {
    let raw = std::fs::read_to_string(dir.join(MARKER)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// A finished install of `id`: the registry's current version when it is
/// there, otherwise the newest version that finished installing.
pub fn installed(home: &Path, id: &str, preferred: &str) -> Option<(String, PathBuf, Vec<String>)> {
    let check = |dir: &Path| -> Option<(String, PathBuf, Vec<String>)> {
        let m = read_marker(dir)?;
        if m.id != id || !is_contained(&m.program) {
            return None;
        }
        let program = dir.join(&m.program);
        program.is_file().then_some((m.version, program, m.args))
    };
    if let Some(hit) = check(&install_dir(home, id, preferred)) {
        return Some(hit);
    }
    let root = agents_root(home).join(safe_segment(id));
    let mut found: Vec<(String, PathBuf, Vec<String>)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| check(&e.path()))
        .collect();
    found.sort_by(|a, b| version_key(&a.0).cmp(&version_key(&b.0)));
    found.pop()
}

fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit()).filter_map(|p| p.parse().ok()).collect()
}

/// True when a relative path stays inside the directory it is joined to.
fn is_contained(p: &Path) -> bool {
    !p.as_os_str().is_empty() && p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveKind {
    Zip,
    TarGz,
    TarBz2,
    TarXz,
    Tar,
}

impl ArchiveKind {
    pub fn from_url(url: &str) -> Option<ArchiveKind> {
        let path = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
        if path.ends_with(".zip") {
            Some(ArchiveKind::Zip)
        } else if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
            Some(ArchiveKind::TarGz)
        } else if path.ends_with(".tar.bz2") || path.ends_with(".tbz2") {
            Some(ArchiveKind::TarBz2)
        } else if path.ends_with(".tar.xz") {
            Some(ArchiveKind::TarXz)
        } else if path.ends_with(".tar") {
            Some(ArchiveKind::Tar)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum InstallPlan {
    Binary {
        registry_id: String,
        name: String,
        version: String,
        url: String,
        archive: ArchiveKind,
        cmd: String,
        args: Vec<String>,
        sha256: Option<String>,
        dir: PathBuf,
    },
    Npm {
        registry_id: String,
        name: String,
        version: String,
        package: String,
        args: Vec<String>,
        npm: PathBuf,
        dir: PathBuf,
    },
}

impl InstallPlan {
    pub fn registry_id(&self) -> &str {
        match self {
            InstallPlan::Binary { registry_id, .. } | InstallPlan::Npm { registry_id, .. } => registry_id,
        }
    }
    pub fn dir(&self) -> &Path {
        match self {
            InstallPlan::Binary { dir, .. } | InstallPlan::Npm { dir, .. } => dir,
        }
    }
    /// A binary with no published checksum. The person must agree first.
    pub fn unverified(&self) -> bool {
        matches!(self, InstallPlan::Binary { sha256: None, .. })
    }
}

/// How to install `agent` here: a checksummed binary first, then npm when
/// it is on PATH, then a binary without a checksum.
pub fn plan(agent: &RegistryAgent, probe: &Probe<'_>) -> Option<InstallPlan> {
    let dir = install_dir(probe.home, &agent.id, &agent.version);
    let binary = platform_key().and_then(|p| agent.distribution.binary.get(p)).and_then(|b| {
        let archive = ArchiveKind::from_url(&b.archive)?;
        Some(InstallPlan::Binary {
            registry_id: agent.id.clone(),
            name: agent.name.clone(),
            version: agent.version.clone(),
            url: b.archive.clone(),
            archive,
            cmd: b.cmd.clone(),
            args: b.args.clone(),
            sha256: b.sha256.clone().map(|s| s.to_ascii_lowercase()),
            dir: dir.clone(),
        })
    });
    if let Some(b) = &binary {
        if !b.unverified() {
            return binary;
        }
    }
    if let Some(n) = &agent.distribution.npx {
        if let Some(npm) = (probe.which)("npm") {
            return Some(InstallPlan::Npm {
                registry_id: agent.id.clone(),
                name: agent.name.clone(),
                version: agent.version.clone(),
                package: n.package.clone(),
                args: n.args.clone(),
                npm,
                dir,
            });
        }
    }
    binary
}

pub fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let got = hex::encode(Sha256::digest(bytes));
    if got.eq_ignore_ascii_case(expected.trim()) {
        Ok(())
    } else {
        Err(format!("checksum mismatch: expected {expected}, got {got}"))
    }
}

fn staging_dir(home: &Path, id: &str) -> PathBuf {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    agents_root(home).join(".staging").join(format!("{}-{}-{n}", safe_segment(id), std::process::id()))
}

fn extract_command(kind: ArchiveKind, archive: &Path, dest: &Path) -> std::process::Command {
    let mut c = match kind {
        ArchiveKind::Zip if !cfg!(target_os = "macos") => {
            let mut c = std::process::Command::new("unzip");
            c.arg("-q").arg("-o").arg(archive).arg("-d").arg(dest);
            return c;
        }
        // bsdtar on macOS (and tar on Windows) reads zip archives too.
        _ => std::process::Command::new("tar"),
    };
    c.arg("-xf").arg(archive).arg("-C").arg(dest);
    c
}

/// Verify, unpack and register a downloaded binary archive.
pub fn install_binary(plan: &InstallPlan, home: &Path, bytes: &[u8], allow_unverified: bool) -> Result<PathBuf, String> {
    let InstallPlan::Binary { registry_id, version, archive, cmd, args, sha256, dir, .. } = plan else {
        return Err("not a binary install plan".into());
    };
    match sha256 {
        Some(sum) => verify_sha256(bytes, sum)?,
        None if allow_unverified => {}
        None => return Err(format!("{registry_id} publishes no checksum for this build; refusing to install it unconfirmed")),
    }
    let rel = PathBuf::from(cmd.trim_start_matches("./"));
    if !is_contained(&rel) {
        return Err(format!("registry command {cmd:?} points outside the install directory"));
    }
    let stage = staging_dir(home, registry_id);
    let out = stage.join("out");
    std::fs::create_dir_all(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
    let file = stage.join("download");
    let result = (|| {
        std::fs::write(&file, bytes).map_err(|e| format!("write download: {e}"))?;
        let status = extract_command(*archive, &file, &out).status().map_err(|e| format!("unpack: {e}"))?;
        if !status.success() {
            return Err(format!("unpack failed ({status})"));
        }
        let program = out.join(&rel);
        if !program.is_file() {
            return Err(format!("archive has no {cmd}"));
        }
        make_executable(&program)?;
        let marker = Marker { id: registry_id.clone(), version: version.clone(), program: rel.clone(), args: args.clone() };
        write_marker(&out, &marker)?;
        replace_dir(&out, dir)?;
        Ok(dir.join(&rel))
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

/// The `npm install` that puts the package under the plan's directory.
pub fn npm_install_command(plan: &InstallPlan) -> Option<std::process::Command> {
    let InstallPlan::Npm { package, npm, dir, .. } = plan else { return None };
    let mut c = std::process::Command::new(npm);
    c.arg("install")
        .arg("--prefix")
        .arg(dir)
        .args(["--no-fund", "--no-audit", "--no-save", "--loglevel=error"])
        .arg(package);
    Some(c)
}

/// After `npm_install_command` succeeded: find the package's executable and
/// write the marker.
pub fn finish_npm(plan: &InstallPlan) -> Result<PathBuf, String> {
    let InstallPlan::Npm { registry_id, version, package, args, dir, .. } = plan else {
        return Err("not an npm install plan".into());
    };
    let name = package_name(package);
    let manifest = dir.join("node_modules").join(name).join("package.json");
    let raw = std::fs::read_to_string(&manifest).map_err(|e| format!("read {}: {e}", manifest.display()))?;
    let pkg: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("bad package.json: {e}"))?;
    let bin = npm_bin_name(&pkg, name).ok_or_else(|| format!("{name} has no executable"))?;
    let program = npm_bin_path(dir, &bin);
    if !program.exists() {
        return Err(format!("npm did not link {}", program.display()));
    }
    let rel = program.strip_prefix(dir).map_err(|_| "bin outside install dir".to_string())?.to_path_buf();
    write_marker(dir, &Marker { id: registry_id.clone(), version: version.clone(), program: rel, args: args.clone() })?;
    Ok(program)
}

/// The executable a package.json declares. A single entry wins; with
/// several, the one named after the package.
pub fn npm_bin_name(pkg: &serde_json::Value, package: &str) -> Option<String> {
    let last = package.rsplit('/').next().unwrap_or(package);
    match pkg.get("bin")? {
        serde_json::Value::String(_) => Some(last.to_string()),
        serde_json::Value::Object(map) => {
            if map.len() == 1 {
                return map.keys().next().cloned();
            }
            if map.contains_key(last) {
                return Some(last.to_string());
            }
            map.keys().find(|k| k.contains("acp")).or_else(|| map.keys().next()).cloned()
        }
        _ => None,
    }
}

fn write_marker(dir: &Path, m: &Marker) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(MARKER), body).map_err(|e| format!("write marker: {e}"))
}

fn replace_dir(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    if to.exists() {
        std::fs::remove_dir_all(to).map_err(|e| format!("clear {}: {e}", to.display()))?;
    }
    std::fs::rename(from, to).map_err(|e| format!("move into {}: {e}", to.display()))
}

#[cfg(unix)]
fn make_executable(p: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = std::fs::metadata(p).map_err(|e| e.to_string())?.permissions();
    perm.set_mode(perm.mode() | 0o755);
    std::fs::set_permissions(p, perm).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn make_executable(_p: &Path) -> Result<(), String> {
    Ok(())
}
