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

use crate::{checkpoint, intent_block, manifest_sig, plugin, replay, session, skill_rank};

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

    // 4. Git hooks installed.
    let hooks_installed = Path::new(".git/hooks/pre-commit").exists();
    if !hooks_installed {
        issues_found += 1;
    }

    // 5. Shadow checkpoint branch.
    let shadow = match git2::Repository::open(".") {
        Ok(repo) => {
            let exists = repo
                .find_reference("refs/heads/aura/checkpoints")
                .is_ok();
            let checkpoints = if exists {
                checkpoint::CheckpointStore::get_shadow_checkpoints(&repo)
                    .map(|c| c.len())
                    .unwrap_or(0)
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
        issues_found,
    })
}
