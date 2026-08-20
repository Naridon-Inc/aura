//! Which copy of an agent CLI is actually running — and what else is on disk.
//!
//! A machine can hold several installs of the same agent CLI: homebrew's
//! prefix, npm's global prefix, a volta/asdf shim, a stray `~/.local/bin`.
//! PATH picks exactly one of them, and every other copy is invisible. That
//! produces a failure people report as "it always asks me to update and
//! never ends": `npm i -g <agent>@latest` writes the new version into npm's
//! own prefix, PATH keeps running an older copy somewhere else, and the
//! agent's self-update nag never clears because from its point of view the
//! update never happened.
//!
//! `agents_installs_get` walks PATH *and* the install roots package managers
//! write to, probes every copy it finds, and says plainly which one runs,
//! which ones are hidden, and whether a hidden copy is newer than the one in
//! charge. Searching beyond PATH is the point, not thoroughness for its own
//! sake: the worst version of this bug is an npm global prefix whose `bin`
//! directory was never added to PATH, so `npm i -g` reports success forever
//! while nothing on the machine can run what it installed.
//!
//! The version compare is numeric, not string equality, because agent CLIs
//! spell `--version` a dozen ways (`codex-cli 0.147.0`, `0.55.1`,
//! `2.0.1 (Claude Code)`).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// One copy of an agent binary on disk.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentInstall {
    /// Absolute path of the copy.
    pub path: String,
    /// Raw first line of `<path> --version`, verbatim. None when the probe
    /// failed — a file can be executable and still refuse to run.
    pub raw_version: Option<String>,
    /// The dotted number parsed out of `raw_version`, e.g. "0.147.0".
    pub version: Option<String>,
    /// True when this copy sits in a directory PATH actually lists. False
    /// means the shell cannot reach it at all, whatever its version.
    pub on_path: bool,
}

/// What PATH resolution actually gives you for one agent.
#[derive(Debug, Clone, Serialize)]
pub struct AgentInstallHealth {
    pub agent_id: String,
    /// The binary name looked up, e.g. `cursor-agent`.
    pub bin: String,
    /// The copy PATH runs — the first one PATH reaches. None when the agent
    /// is either not installed at all, or installed only where PATH can't
    /// see it, which is itself worth saying out loud.
    pub running: Option<AgentInstall>,
    /// Every other copy found, in search order — the ones nothing reaches.
    pub shadowed: Vec<AgentInstall>,
    /// True when a hidden copy parses newer than the running one. This is
    /// the endless-update-nag case, stated as a fact rather than a guess.
    pub stale: bool,
    /// Highest version found across all copies, running or not.
    pub newest_version: Option<String>,
}

/// Agents whose install health we report. Same compiled-in set as
/// `cmd_agent_versions`, kept as `(id, bin)` because two of them do not
/// spell their binary the way they spell their id.
const AGENTS: &[(&str, &str)] = &[
    ("claude", "claude"),
    ("gemini", "gemini"),
    ("codex", "codex"),
    ("cursor", "cursor-agent"),
    ("kimi", "kimi"),
    ("opencode", "opencode"),
    ("pi", "pi"),
];

/// Report every copy of every known agent CLI on PATH.
///
/// One process spawn per copy found, so this is lazy-call territory: the
/// Settings pane asks for it when it opens, nothing asks on every render.
/// Runs on the blocking pool because probing is subprocess-bound.
#[tauri::command]
pub async fn agents_installs_get() -> Result<Vec<AgentInstallHealth>, String> {
    tauri::async_runtime::spawn_blocking(collect_install_health)
        .await
        .map_err(|e| format!("install probe panicked: {e}"))
}

fn collect_install_health() -> Vec<AgentInstallHealth> {
    let dirs = search_dirs();
    AGENTS
        .iter()
        .map(|(id, bin)| health_for(id, bin, &copies_in(&dirs, bin)))
        .collect()
}

/// Build the health verdict for one agent from the copies found, in search
/// order. Split out from the directory walk and the probe so the ranking
/// rule — "a newer thing the shell can't reach is the bug" — is testable
/// without touching the filesystem.
fn health_for(agent_id: &str, bin: &str, copies: &[AgentInstall]) -> AgentInstallHealth {
    // Whatever the search order, "running" means the first copy PATH can
    // actually reach. A newer copy off PATH never becomes the running one.
    let running_ix = copies.iter().position(|c| c.on_path);
    let running = running_ix.map(|i| copies[i].clone());
    let shadowed: Vec<AgentInstall> = copies
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != running_ix)
        .map(|(_, c)| c.clone())
        .collect();
    let newest = copies
        .iter()
        .filter_map(|c| c.version.as_deref())
        .max_by(|a, b| compare_versions(a, b));
    let stale = match (running.as_ref().and_then(|r| r.version.as_deref()), newest) {
        (Some(run), Some(best)) => compare_versions(best, run) == std::cmp::Ordering::Greater,
        _ => false,
    };
    AgentInstallHealth {
        agent_id: agent_id.to_string(),
        bin: bin.to_string(),
        running,
        shadowed,
        stale,
        newest_version: newest.map(|s| s.to_string()),
    }
}

/// Every executable named `bin` in the search directories, in order,
/// deduplicated by the path each one really resolves to. Two entries that
/// are the same file through a symlink — or a PATH that lists the same
/// directory four times, which is common — are one install, not several;
/// reporting them as rivals would invent a problem.
fn copies_in(dirs: &[(PathBuf, bool)], bin: &str) -> Vec<AgentInstall> {
    let mut seen: Vec<PathBuf> = Vec::new();
    let mut out = Vec::new();
    for (dir, on_path) in dirs {
        let candidate = dir.join(bin);
        if !is_executable_file(&candidate) {
            continue;
        }
        let real = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
        let raw = probe_version_at(&candidate);
        out.push(AgentInstall {
            path: candidate.to_string_lossy().into_owned(),
            version: raw.as_deref().and_then(parse_version),
            raw_version: raw,
            on_path: *on_path,
        });
    }
    out
}

/// Where to look, in order: every PATH entry first (those are the copies
/// that can actually run), then the install roots package managers write to
/// that PATH may never have been told about. The flag records which is
/// which, because "old copy wins the PATH race" and "new copy is somewhere
/// your shell has never heard of" are different problems with different
/// fixes, and telling them apart is the whole value here.
fn search_dirs() -> Vec<(PathBuf, bool)> {
    let mut dirs: Vec<(PathBuf, bool)> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            dirs.push((dir, true));
        }
    }
    for extra in off_path_roots() {
        if !dirs.iter().any(|(d, _)| *d == extra) {
            dirs.push((extra, false));
        }
    }
    dirs
}

/// Install roots worth checking even when PATH omits them. Kept to the
/// places these CLIs are actually installed from — npm's own global prefix
/// (the one that produced the bug), plus the per-user bin directories the
/// common toolchain installers create.
fn off_path_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(prefix) = npm_global_prefix() {
        roots.push(prefix.join("bin"));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for rel in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
            ".yarn/bin",
            ".cargo/bin",
        ] {
            roots.push(home.join(rel));
        }
    }
    roots.push(PathBuf::from("/opt/homebrew/bin"));
    roots.push(PathBuf::from("/usr/local/bin"));
    roots
}

/// `npm prefix -g`, asked once per process. npm is slow to start, and the
/// answer cannot change while the app is running.
fn npm_global_prefix() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let out = std::process::Command::new("npm")
                .args(["prefix", "-g"])
                .output()
                .ok()?;
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(PathBuf::from(s)) }
        })
        .clone()
}

#[cfg(unix)]
fn is_executable_file(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable_file(p: &std::path::Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// First line of `<path> --version`, stdout preferred, stderr as fallback
/// (several of these CLIs print their banner to stderr).
fn probe_version_at(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let pick = if stdout.is_empty() {
        String::from_utf8_lossy(&out.stderr).trim().to_string()
    } else {
        stdout
    };
    let first = pick.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() { None } else { Some(first) }
}

/// Pull the dotted number out of a `--version` line. Accepts the shapes
/// these CLIs actually emit: bare `0.55.1`, prefixed `codex-cli 0.147.0`,
/// suffixed `2.0.1 (Claude Code)`, and a leading `v`.
pub fn parse_version(raw: &str) -> Option<String> {
    for token in raw.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',') {
        let t = token.trim().trim_start_matches(['v', 'V']);
        // Needs at least one dot and a digit on both sides of it, or a
        // word like "cli" and a date like "2025" both qualify as versions.
        if !t.contains('.') {
            continue;
        }
        let core: &str = t.split(|c: char| c == '-' || c == '+').next().unwrap_or(t);
        let mut parts = core.split('.');
        let valid = core.contains('.')
            && parts.clone().count() >= 2
            && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
        if valid {
            return Some(core.to_string());
        }
    }
    None
}

/// Numeric compare of two dotted versions. Missing trailing components read
/// as zero, so `0.147` and `0.147.0` are the same release — string equality
/// would call them different and cry stale forever.
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        let l = left.next();
        let r = right.next();
        if l.is_none() && r.is_none() {
            return std::cmp::Ordering::Equal;
        }
        let lv: u64 = l.unwrap_or("0").parse().unwrap_or(0);
        let rv: u64 = r.unwrap_or("0").parse().unwrap_or(0);
        match lv.cmp(&rv) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    fn install(path: &str, version: Option<&str>) -> AgentInstall {
        AgentInstall {
            path: path.to_string(),
            raw_version: version.map(|v| v.to_string()),
            version: version.map(|v| v.to_string()),
            on_path: true,
        }
    }

    /// A copy sitting where PATH can't reach it.
    fn hidden(path: &str, version: Option<&str>) -> AgentInstall {
        AgentInstall { on_path: false, ..install(path, version) }
    }

    #[test]
    fn parses_the_shapes_these_clis_actually_print() {
        assert_eq!(parse_version("0.55.1").as_deref(), Some("0.55.1"));
        assert_eq!(parse_version("codex-cli 0.147.0").as_deref(), Some("0.147.0"));
        assert_eq!(parse_version("2.0.1 (Claude Code)").as_deref(), Some("2.0.1"));
        assert_eq!(parse_version("v1.4.2").as_deref(), Some("1.4.2"));
        assert_eq!(parse_version("1.2.3-beta.4").as_deref(), Some("1.2.3"));
    }

    #[test]
    fn refuses_things_that_are_not_versions() {
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version("cursor-agent"), None);
        // A bare year is not a version: one dot minimum, digits both sides.
        assert_eq!(parse_version("built 2025"), None);
    }

    #[test]
    fn compares_numerically_not_lexically() {
        // The whole reason this exists: "0.147.0" < "0.9.0" as strings.
        assert_eq!(compare_versions("0.147.0", "0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.147", "0.147.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0", "1.0.1"), Ordering::Less);
    }

    #[test]
    fn a_newer_copy_behind_the_running_one_is_stale() {
        let h = health_for(
            "codex",
            "codex",
            &[
                install("/opt/homebrew/bin/codex", Some("0.146.0")),
                install("/Users/x/.hermes/node/bin/codex", Some("0.147.0")),
            ],
        );
        assert!(h.stale);
        assert_eq!(h.newest_version.as_deref(), Some("0.147.0"));
        assert_eq!(h.running.unwrap().path, "/opt/homebrew/bin/codex");
        assert_eq!(h.shadowed.len(), 1);
    }

    #[test]
    fn the_newest_copy_running_first_is_not_stale() {
        let h = health_for(
            "codex",
            "codex",
            &[
                install("/opt/homebrew/bin/codex", Some("0.147.0")),
                install("/Users/x/.hermes/node/bin/codex", Some("0.146.0")),
            ],
        );
        assert!(!h.stale);
        assert_eq!(h.shadowed.len(), 1);
    }

    #[test]
    fn a_newer_copy_off_path_entirely_is_the_reported_bug() {
        // The real shape of the endless-update-nag: `npm i -g` succeeds into
        // a prefix whose bin directory PATH was never told about, so the CLI
        // keeps running the old copy and keeps asking to be updated.
        let h = health_for(
            "codex",
            "codex",
            &[
                install("/opt/homebrew/bin/codex", Some("0.146.0")),
                hidden("/Users/x/.hermes/node/bin/codex", Some("0.147.0")),
            ],
        );
        assert!(h.stale);
        assert_eq!(h.running.unwrap().path, "/opt/homebrew/bin/codex");
        assert!(!h.shadowed[0].on_path);
    }

    #[test]
    fn an_off_path_copy_never_becomes_the_running_one() {
        // Search order puts off-PATH roots last, but order alone must not
        // decide this: even listed first, an unreachable copy cannot run.
        let h = health_for(
            "gemini",
            "gemini",
            &[
                hidden("/Users/x/.npm-global/bin/gemini", Some("0.55.1")),
                install("/opt/homebrew/bin/gemini", Some("0.45.0")),
            ],
        );
        assert_eq!(h.running.as_ref().unwrap().path, "/opt/homebrew/bin/gemini");
        assert_eq!(h.running.unwrap().version.as_deref(), Some("0.45.0"));
        assert!(h.stale);
    }

    #[test]
    fn installed_only_where_path_cannot_see_it_reports_nothing_running() {
        let h = health_for("kimi", "kimi", &[hidden("/Users/x/.hermes/node/bin/kimi", Some("1.0.0"))]);
        assert!(h.running.is_none());
        assert!(!h.stale); // nothing runs, so nothing is out of date — it's missing
        assert_eq!(h.shadowed.len(), 1);
        assert_eq!(h.newest_version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn one_copy_or_none_is_never_stale() {
        let single = health_for("kimi", "kimi", &[install("/usr/local/bin/kimi", Some("1.0.0"))]);
        assert!(!single.stale);
        assert!(single.shadowed.is_empty());

        let none = health_for("pi", "pi", &[]);
        assert!(!none.stale);
        assert!(none.running.is_none());
        assert!(none.newest_version.is_none());
    }

    #[test]
    fn an_unparseable_shadow_cannot_declare_the_running_copy_stale() {
        let h = health_for(
            "gemini",
            "gemini",
            &[
                install("/opt/homebrew/bin/gemini", Some("0.55.1")),
                install("/broken/gemini", None),
            ],
        );
        assert!(!h.stale);
        assert_eq!(h.newest_version.as_deref(), Some("0.55.1"));
    }
}
