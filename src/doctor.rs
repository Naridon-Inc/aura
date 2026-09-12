//! Repo-health doctor — structured (JSON) report.
//!
//! The interactive `aura doctor` (in `main.rs`) interleaves its checks with
//! repairs: it prompts to force-end stuck sessions, prunes oversized snapshot
//! stores, cleans stale sessions, and removes orphaned replay worktrees. That
//! is the right behaviour for a human at a terminal, but the desktop shell's
//! `/doctor` slash card needs a *read-only* machine-readable snapshot it can
//! render as a calm plain-language card.
//!
//! `collect_report` runs the same probes — stuck sessions, orphaned/oversized
//! snapshots, git hooks, shadow branch, signing key, cloud rotation-chain
//! drift, skill ledger, replay worktrees, plugins — but performs NONE of the
//! mutations. Every value is real: no placeholders, no estimates beyond the
//! same `~200 bytes/snapshot` metadata overhead the text path already uses.
//!
//! The struct derives `Serialize` so `aura doctor --json` is just
//! `serde_json::to_string_pretty(&collect_report()?)`. The desktop's
//! `DoctorReport` TypeScript type (in `lib/api.ts`) mirrors this shape.

use serde::Serialize;
use std::path::Path;

use crate::{checkpoint, hook, intent_block, manifest_sig, plugin, replay, session, skill_rank};

/// A single stuck-session entry — the agent that left it and why doctor
/// considers it stuck (e.g. "no activity for 3h").
#[derive(Serialize, Clone, Debug)]
pub struct StuckSession {
    pub session_id: String,
    pub agent_id: String,
    pub files_touched: usize,
    pub reason: String,
}

/// Snapshot-store health. `oversized` mirrors the text path's >400 prune
/// trigger, but JSON mode only *reports* it (never prunes).
#[derive(Serialize, Clone, Debug)]
pub struct SnapshotHealth {
    pub total: usize,
    pub orphaned: usize,
    pub approx_kb: u64,
    pub oversized: bool,
}

/// Shadow checkpoint branch (`refs/heads/aura/checkpoints`) health.
#[derive(Serialize, Clone, Debug)]
pub struct ShadowHealth {
    pub exists: bool,
    pub checkpoints: usize,
}

/// One taxonomy cell still below the auto-routing sample threshold.
#[derive(Serialize, Clone, Debug)]
pub struct ImmatureCell {
    pub cell: String,
    pub samples: usize,
}

/// Skill-ledger health, or `present: false` when no ledger exists yet.
#[derive(Serialize, Clone, Debug)]
pub struct SkillLedgerHealth {
    pub present: bool,
    pub readable: bool,
    pub recorded: usize,
    /// Rows recorded locally but not yet flushed to the cloud.
    pub dirty: usize,
    pub total_cells: usize,
    pub min_samples: u32,
    pub immature_cells: Vec<ImmatureCell>,
}

impl Default for SkillLedgerHealth {
    fn default() -> Self {
        Self {
            present: false,
            readable: false,
            recorded: 0,
            dirty: 0,
            total_cells: 0,
            min_samples: skill_rank::MIN_SAMPLES,
            immature_cells: vec![],
        }
    }
}

/// One leaked replay-lab worktree from an interrupted `aura replay` run.
#[derive(Serialize, Clone, Debug)]
pub struct ReplayOrphan {
    pub branch: String,
    pub path: String,
}

/// One `aura` executable this machine can invoke, with the version it
/// reports. `version` is `"unknown"` when the binary exists but would not
/// run — which for the hook binary is itself a problem worth surfacing.
#[derive(Serialize, Clone, Debug)]
pub struct AuraBinary {
    pub path: String,
    pub version: String,
}

/// Which aura binaries exist, and which one the repo's pre-commit hook
/// actually invokes. Version skew between them is how a repo ends up
/// guarded by an older engine than the one the user runs by hand — the
/// hook silently stamps with a stale binary while `aura --version` in a
/// terminal reports something newer.
#[derive(Serialize, Clone, Debug)]
pub struct BinaryHealth {
    /// The binary answering this very doctor call.
    pub running: AuraBinary,
    /// Every distinct `aura` found on PATH, in PATH order.
    pub on_path: Vec<AuraBinary>,
    /// The binary the pre-commit hook invokes, if a hook exists and its
    /// aura invocation could be resolved.
    pub hook_invokes: Option<AuraBinary>,
    /// True when the known versions above disagree.
    pub version_skew: bool,
}

/// Extract the aura executable a hook script invokes. Scans non-comment
/// lines for the first token whose basename is `aura`, skipping wrapper
/// prefixes like `gtimeout 30` or `env`. Returns the raw token (`~` not
/// yet expanded); `None` when the script never calls aura.
pub fn extract_hook_binary(script: &str) -> Option<String> {
    for line in script.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        for token in line.split_whitespace() {
            let token = token.trim_matches(|c| c == '"' || c == '\'' || c == ';');
            let base = token.rsplit('/').next().unwrap_or(token);
            if base == "aura" {
                return Some(token.to_string());
            }
        }
    }
    None
}

/// Parse the version out of `aura --version` output ("aura 0.19.42" → "0.19.42").
pub fn parse_version_output(out: &str) -> Option<String> {
    let first = out.lines().next()?;
    let mut parts = first.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("aura"), Some(v)) => Some(v.to_string()),
        _ => None,
    }
}

/// True when the set of *known* versions (running, PATH, hook) is not a
/// single value. Unknown versions don't create skew by themselves.
pub fn versions_disagree<'a, I: IntoIterator<Item = &'a str>>(versions: I) -> bool {
    let mut known: Vec<&str> = versions
        .into_iter()
        .filter(|v| !v.is_empty() && *v != "unknown")
        .collect();
    known.sort_unstable();
    known.dedup();
    known.len() > 1
}

fn version_of(path: &Path) -> String {
    std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| parse_version_output(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_else(|| "unknown".to_string())
}

fn expand_home(token: &str) -> String {
    if let Some(rest) = token.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        return format!("{}/{}", home, rest);
    }
    token.to_string()
}

/// Resolve the repo's hooks directory through git's common dir, so
/// worktrees (whose private `.git` is a file) find the shared hooks
/// instead of reporting them missing.
pub fn hooks_dir() -> std::path::PathBuf {
    match git2::Repository::open(".") {
        Ok(repo) => repo.commondir().join("hooks"),
        Err(_) => Path::new(".git/hooks").to_path_buf(),
    }
}

/// Census the aura binaries: the one running, every one on PATH, and the
/// one the pre-commit hook invokes.
pub fn probe_binaries() -> BinaryHealth {
    let running_path = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "aura".to_string());
    let running = AuraBinary {
        path: running_path,
        version: env!("CARGO_PKG_VERSION").to_string(),
    };

    let mut on_path = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in ["aura", "aura.exe"] {
                let cand = dir.join(name);
                if !cand.is_file() {
                    continue;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let executable = std::fs::metadata(&cand)
                        .map(|m| m.permissions().mode() & 0o111 != 0)
                        .unwrap_or(false);
                    if !executable {
                        continue;
                    }
                }
                let canonical = cand
                    .canonicalize()
                    .unwrap_or_else(|_| cand.clone())
                    .display()
                    .to_string();
                if !seen.insert(canonical) {
                    continue;
                }
                on_path.push(AuraBinary {
                    version: version_of(&cand),
                    path: cand.display().to_string(),
                });
            }
        }
    }

    let hook_invokes = std::fs::read_to_string(hooks_dir().join("pre-commit"))
        .ok()
        .and_then(|script| extract_hook_binary(&script))
        .map(|token| {
            let resolved = expand_home(&token);
            let version = if resolved.contains('/') {
                version_of(Path::new(&resolved))
            } else {
                // Bare `aura` — the hook rides PATH; first PATH hit answers.
                on_path
                    .first()
                    .map(|b| b.version.clone())
                    .unwrap_or_else(|| "unknown".to_string())
            };
            AuraBinary {
                path: resolved,
                version,
            }
        });

    let version_skew = versions_disagree(
        std::iter::once(running.version.as_str())
            .chain(on_path.iter().map(|b| b.version.as_str()))
            .chain(hook_invokes.iter().map(|b| b.version.as_str())),
    );

    BinaryHealth {
        running,
        on_path,
        hook_invokes,
        version_skew,
    }
}

/// The full read-only doctor report. `issues_found` counts the same
/// problems the text path counts (it does NOT count purely informational
/// states like a missing-but-auto-minting signing key).
#[derive(Serialize, Clone, Debug)]
pub struct DoctorReport {
    pub stuck_sessions: Vec<StuckSession>,
    pub snapshots: SnapshotHealth,
    pub hooks_installed: bool,
    pub shadow: ShadowHealth,
    pub plugins_loaded: usize,
    /// Raw `manifest_sig::signing_health` JSON (status/key_id/key_path/…).
    pub signing: serde_json::Value,
    /// Raw `intent_block::cloud_rotation_chain_drift` JSON
    /// (status/local_count/cloud_count/local_only/cloud_only/…).
    pub cloud_rotation: serde_json::Value,
    pub skill_ledger: SkillLedgerHealth,
    pub replay_orphans: Vec<ReplayOrphan>,
    /// Which aura executables exist here and whether their versions agree.
    pub binaries: BinaryHealth,
    pub issues_found: usize,
}

/// Run every doctor probe read-only and assemble the report. Mirrors the
/// `Commands::Doctor` text handler in `main.rs` minus all side-effects.
pub fn collect_report() -> Result<DoctorReport, Box<dyn std::error::Error>> {
    let mut issues_found: usize = 0;

    // 1. Stuck sessions (report only — never force-end here).
    let stuck: Vec<StuckSession> = session::SessionManager::find_stuck_sessions()
        .into_iter()
        .map(|(sess, reason)| StuckSession {
            session_id: sess.session_id,
            agent_id: sess.agent_id,
            files_touched: sess.files_touched.len(),
            reason,
        })
        .collect();
    issues_found += stuck.len();

    // 2 + 3. Snapshot store: orphans, count, approximate disk usage.
    let snapshots = checkpoint::SnapshotStore::get_all_snapshots();
    let orphaned = snapshots
        .iter()
        .filter(|s| !Path::new(&s.file_path).exists())
        .count();
    issues_found += orphaned;
    let snap_bytes: u64 = snapshots
        .iter()
        .map(|s| s.content.len() as u64 + 200) // ~200 bytes metadata overhead
        .sum();
    let snapshot_health = SnapshotHealth {
        total: snapshots.len(),
        orphaned,
        approx_kb: snap_bytes / 1024,
        oversized: snapshots.len() > 400,
    };

    // 4. Git hooks installed. Ask git where hooks live rather than assuming
    // `.git/hooks`: in a linked worktree `.git` is a file, and a repo with
    // `core.hooksPath` set runs hooks from somewhere else entirely. Assuming
    // the layout here reported "hooks not installed" in every worktree even
    // immediately after `aura enable` had installed them correctly — so the
    // card told people to run a command that could never change its verdict.
    let hooks_installed = hook::HookInstaller::hooks_dir().join("pre-commit").exists();
    if !hooks_installed {
        issues_found += 1;
    }

    // 5. Shadow checkpoint branch.
    let shadow = match git2::Repository::open(".") {
        Ok(repo) => {
            let exists = repo
                .find_reference("refs/heads/aura/checkpoints")
                .is_ok();
            // Count, never load. The archive on a working repository runs to
            // gigabytes of graph JSON, and this card wants one integer.
            let checkpoints = if exists {
                checkpoint::CheckpointStore::count_shadow_checkpoints(&repo).unwrap_or(0)
            } else {
                0
            };
            ShadowHealth { exists, checkpoints }
        }
        Err(_) => ShadowHealth {
            exists: false,
            checkpoints: 0,
        },
    };

    // 8. Plugins loaded.
    let plugin_config = plugin::load_plugin_config();
    let registry = plugin::PluginRegistry::load_from_config(&plugin_config);
    let plugins_loaded = registry.count();

    // 10. Signing-key health (read-only probe; never mints a key).
    let signing = manifest_sig::signing_health();
    match signing.get("status").and_then(|s| s.as_str()) {
        Some("unreadable") | Some("no_path") => issues_found += 1,
        Some("ok") | Some("missing") => {} // missing is informational
        _ => issues_found += 1,
    }

    // 11. Cloud rotation-chain drift (read-only).
    let cloud_rotation = intent_block::cloud_rotation_chain_drift("MCP Agent");
    match cloud_rotation.get("status").and_then(|s| s.as_str()) {
        Some("ok") => {
            let local_only = cloud_rotation
                .get("local_only")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let cloud_only = cloud_rotation
                .get("cloud_only")
                .and_then(|x| x.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            if cloud_only > 0 {
                issues_found += 1;
            }
            if local_only > 0 {
                issues_found += 1;
            }
        }
        Some("skipped") => {}
        Some("error") => issues_found += 1,
        _ => issues_found += 1,
    }

    // 12. Skill-ledger health.
    let ledger_path = {
        let home = std::env::var("HOME").unwrap_or_default();
        Path::new(&home).join(".aura").join("agent_skills.json")
    };
    let skill_ledger = match std::fs::read_to_string(&ledger_path) {
        Err(_) => SkillLedgerHealth::default(),
        Ok(raw) => match skill_rank::ledger_health(&raw) {
            None => SkillLedgerHealth {
                present: true,
                readable: false,
                ..SkillLedgerHealth::default()
            },
            Some(h) => {
                // A pending cloud flush with no cloud sign-in is the only
                // ledger state the text path counts as an issue.
                if h.dirty > 0 && crate::recall_cloud_creds().is_err() {
                    issues_found += 1;
                }
                SkillLedgerHealth {
                    present: true,
                    readable: true,
                    recorded: h.recorded,
                    dirty: h.dirty,
                    total_cells: h.total_cells,
                    min_samples: skill_rank::MIN_SAMPLES,
                    immature_cells: h
                        .immature_cells
                        .into_iter()
                        .map(|(cell, samples)| ImmatureCell { cell, samples })
                        .collect(),
                }
            }
        },
    };

    // 13. Orphaned replay worktrees (report only — never prune here).
    let replay_orphans: Vec<ReplayOrphan> = replay::worktree::list_orphans(Path::new("."))
        .into_iter()
        .map(|o| ReplayOrphan {
            branch: o.branch,
            path: o.path,
        })
        .collect();

    // 14. Binary census: skew between the running binary, PATH binaries
    // and the hook's binary means commits are guarded by a different
    // engine than the one the user sees. A hook whose binary won't even
    // run is counted too.
    let binaries = probe_binaries();
    if binaries.version_skew {
        issues_found += 1;
    }
    if binaries
        .hook_invokes
        .as_ref()
        .is_some_and(|b| b.version == "unknown")
    {
        issues_found += 1;
    }

    Ok(DoctorReport {
        stuck_sessions: stuck,
        snapshots: snapshot_health,
        hooks_installed,
        shadow,
        plugins_loaded,
        signing,
        cloud_rotation,
        skill_ledger,
        replay_orphans,
        binaries,
        issues_found,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_binary_found_through_wrappers() {
        let script = r#"#!/bin/sh
echo "[Aura] Analyzing staged files semantically..."
if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 30 ~/.cargo/bin/aura capture-context
fi
"#;
        assert_eq!(
            extract_hook_binary(script).as_deref(),
            Some("~/.cargo/bin/aura")
        );
    }

    #[test]
    fn hook_binary_bare_name_and_comments() {
        let script = "#!/bin/sh\n# aura is great\naura capture-context\n";
        assert_eq!(extract_hook_binary(script).as_deref(), Some("aura"));
        assert_eq!(extract_hook_binary("#!/bin/sh\nexit 0\n"), None);
    }

    #[test]
    fn hook_binary_ignores_lookalikes() {
        // `[Aura]` in echoes and `aura-statusline.sh` must not match.
        let script = "echo \"[Aura] hi\"\n~/.claude/aura-statusline.sh\n/usr/local/bin/aura hook\n";
        assert_eq!(
            extract_hook_binary(script).as_deref(),
            Some("/usr/local/bin/aura")
        );
    }

    #[test]
    fn version_output_parses_and_rejects() {
        assert_eq!(parse_version_output("aura 0.19.42\n").as_deref(), Some("0.19.42"));
        assert_eq!(parse_version_output("zsh: command not found"), None);
        assert_eq!(parse_version_output(""), None);
    }

    /// A probe is a probe. `aura doctor --json` is what the desktop's
    /// `/doctor` card and every script call, and the text path it mirrors
    /// used to delete stale session records and their transcripts while
    /// reporting how many it found. Nothing stated that this module writes
    /// nothing, so the next write added here would have arrived the same
    /// silent way.
    #[test]
    fn the_report_only_ever_reads() {
        let src = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join("doctor.rs"),
        )
        .expect("this module must be readable");
        // Strip this test, which necessarily names the things it forbids.
        let body = &src[..src.find("fn the_report_only_ever_reads(").unwrap_or(src.len())];
        for forbidden in [
            "remove_file",
            "remove_dir",
            "fs::write",
            "cleanup_stale",
            "OpenOptions",
        ] {
            assert!(
                !body.contains(forbidden),
                "`{forbidden}` in the doctor report: a diagnostic has to be \
                 safe to run, and the caller has asked to be told what is \
                 wrong, not to have it changed underneath them"
            );
        }
    }

    #[test]
    fn skew_needs_two_known_versions() {
        assert!(!versions_disagree(["0.19.42", "0.19.42", "unknown"]));
        assert!(versions_disagree(["0.19.42", "0.19.43"]));
        assert!(!versions_disagree(["unknown", "unknown"]));
        assert!(!versions_disagree([]));
    }
}
