//! Team-aware coordination helpers for the Manager loop.
//!
//! Pre-dispatch: claim the task's declared zones and broadcast a
//! Sentinel message announcing intent. On conflict (zone already
//! claimed by another agent or human), the loop sets `blocked_reason`
//! and emits `ZoneCollision` instead of spawning the child.
//!
//! Post-completion: release the zones and broadcast a one-line summary.
//!
//! The implementation shells out to the existing `aura` CLI rather than
//! re-implementing zone semantics. Keeps this module ~30 LOC and means
//! every claim from the Manager goes through the same code path as
//! manual `aura zones claim` invocations — so cloud sync, conflict
//! detection, and audit logging stay unified.

use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

/// Result of a pre-dispatch zone claim attempt.
pub enum ClaimOutcome {
    /// Successfully acquired (or no zones to claim).
    Ok,
    /// Conflict — another agent already owns one of the patterns.
    /// The captured stdout/stderr is surfaced as `blocked_reason`.
    Conflict(String),
}

pub async fn claim_zones(repo_root: &str, patterns: &[String], label: &str) -> ClaimOutcome {
    if patterns.is_empty() {
        return ClaimOutcome::Ok;
    }
    if !Path::new(repo_root).is_dir() {
        // Repo root missing — surface as a soft conflict so the loop
        // doesn't spawn a child against a stale path.
        return ClaimOutcome::Conflict(format!("project root not found: {repo_root}"));
    }
    let mut args: Vec<String> = vec!["zones".into(), "claim".into()];
    args.extend(patterns.iter().cloned());
    args.push("--mode".into());
    args.push("warn".into());
    args.push("--label".into());
    args.push(label.to_string());

    let out = match Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(&args)
        .current_dir(repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => return ClaimOutcome::Conflict(format!("aura zones claim failed: {e}")),
    };
    if out.status.success() {
        ClaimOutcome::Ok
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let combined = format!("{stdout}\n{stderr}").trim().to_string();
        ClaimOutcome::Conflict(combined)
    }
}

/// Send a sentinel broadcast. `from_session` is the manager session id
/// so teammates can attribute the message. `to_session` is empty to
/// broadcast to the whole repo.
pub async fn announce(repo_root: &str, manager_sid: &str, content: &str) {
    if !Path::new(repo_root).is_dir() {
        return;
    }
    // Shell out to `aura msg send --to-session "" --content "..."`.
    let args = vec![
        "msg".to_string(),
        "send".to_string(),
        "--from-agent".to_string(),
        "manager".to_string(),
        "--from-session".to_string(),
        manager_sid.to_string(),
        "--to-session".to_string(),
        String::new(),
        "--content".to_string(),
        content.to_string(),
    ];
    let _ = Command::new(crate::agent_event_listener::resolve_aura_bin())
        .args(&args)
        .current_dir(repo_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
}
