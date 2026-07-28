//! Auto-init + auto-wire Aura the moment a repo is opened in the ADE.
//!
//! The product promise is "Aura is always running." Until now the wiring
//! was lazy and PTY-scoped: `.aura/` got created only when the aura CLI
//! happened to run, and the agent hooks/MCP were stamped only when an
//! *in-app* PTY spawned. Open someone else's repo, let Claude edit a file
//! from an external terminal, and Aura had no intent log to check against —
//! so every edit fell straight to the red "no intent logged" banner, which
//! (rightly) reads as meaningless.
//!
//! This module closes that gap. On repo-open the frontend calls
//! `aura_ensure_tracked`, which:
//!   1. shadows Aura's footprint into `.git/info/exclude` so nothing Aura
//!      writes ever shows up in the user's `git status` (their "silent
//!      everywhere, gitignored" choice — we never touch the tracked
//!      `.gitignore`);
//!   2. turns on passive capture with a silent, idempotent `aura enable`
//!      (creates `.aura/`, installs the git hooks) so there IS an intent
//!      log + checkpoint to reconcile against;
//!   3. wires every agent CLI (MCP server + Claude/Gemini hooks + a
//!      repo-level `.mcp.json`) so ANY agent editing this repo — in-app or
//!      launched from a plain terminal — logs intent through Aura.
//!
//! Non-git folders can't be tracked (Aura is a git overlay); for those we
//! return an honest status the UI turns into a one-click "Initialize Git &
//! turn on Aura" notice — never a trip to the CLI.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Result of an ensure-tracked pass, surfaced to the UI so it can show a
/// quiet confirmation (or the non-git notice) without guessing.
#[derive(Serialize, Clone, Debug)]
pub struct AuraTrackStatus {
    pub repo_root: String,
    /// Is this a git repository at all? Aura can't track without git.
    pub is_git: bool,
    /// Aura capture is on (`.aura/` present + git hooks installed) after
    /// this call.
    pub tracked: bool,
    /// True only when THIS call flipped it on (drives the "Aura is now
    /// tracking this project" toast — shown once, not on every re-open).
    pub newly_enabled: bool,
    /// Agent CLIs wired (MCP + hooks) so edits here log intent.
    pub wired: bool,
    /// Human-readable line for the non-git / error case; `None` on success.
    pub detail: Option<String>,
}

// Marker-delimited block we own inside `.git/info/exclude`. Idempotent by
// construction: if the begin marker is already present we leave the file
// alone. Kept narrow so a user editing their own exclude rules around it is
// never disturbed.
const EXCLUDE_BEGIN: &str = "# >>> aura (ADE local-only, do not commit) >>>";
const EXCLUDE_END: &str = "# <<< aura (ADE local-only) <<<";

// Paths Aura may write into a tracked repo that the user asked to keep out
// of `git status`. `.aura/` carries the intent log + checkpoints; the rest
// are per-agent wiring the CLIs read.
const EXCLUDE_ENTRIES: &[&str] = &[
    "/.aura/",
    "/.mcp.json",
    "/.claude/settings.local.json",
    "/.gemini.intent",
    "/.claude.intent",
    "/.aura.intent",
];

/// Make an opened repo a live Aura repo — idempotent and safe to call on
/// every repo focus. Order matters: exclude first (so the enable step's
/// writes are already invisible to git), then enable, then wire agents.
#[tauri::command]
pub async fn aura_ensure_tracked(repo_root: String) -> Result<AuraTrackStatus, String> {
    let root = PathBuf::from(&repo_root);
    if !root.is_dir() {
        return Err(format!("Not a directory: {repo_root}"));
    }

    // Aura is a git overlay — no git, nothing to track. Hand the UI an
    // honest status it can turn into a one-click init offer.
    if !root.join(".git").exists() {
        return Ok(AuraTrackStatus {
            repo_root,
            is_git: false,
            tracked: false,
            newly_enabled: false,
            wired: false,
            detail: Some(
                "This folder isn't a Git repository yet. Aura tracks changes on top of Git — turn it on to start."
                    .into(),
            ),
        });
    }

    // (1) Keep Aura out of `git status` before we write anything else.
    let _ = ensure_local_exclude(&root);

    // (2) Turn on passive capture if it isn't already on.
    let already = aura_capture_present(&root);
    let mut newly_enabled = false;
    if !already {
        newly_enabled = run_aura_enable(&repo_root);
    }
    let tracked = already || newly_enabled || aura_capture_present(&root);

    // (3) Wire the agent CLIs so any agent editing here logs intent.
    let wired = crate::cmd_agent_pty::wire_agents_for_repo(&repo_root);

    Ok(AuraTrackStatus {
        repo_root,
        is_git: true,
        tracked,
        newly_enabled,
        wired,
        detail: None,
    })
}

/// The non-git escape hatch: user clicked "Initialize Git & turn on Aura"
/// in the in-app notice. That click is the consent to create git history in
/// this folder — we never do it silently. Then run the normal ensure pass.
#[tauri::command]
pub async fn aura_git_init_and_track(repo_root: String) -> Result<AuraTrackStatus, String> {
    let root = PathBuf::from(&repo_root);
    if !root.is_dir() {
        return Err(format!("Not a directory: {repo_root}"));
    }
    if !root.join(".git").exists() {
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("git init failed".into());
        }
    }
    aura_ensure_tracked(repo_root).await
}

/// Is Aura passive capture already on here? `.aura/` present AND our git
/// pre-commit hook installed. Cheap file checks — no process spawn.
fn aura_capture_present(root: &Path) -> bool {
    if !root.join(".aura").is_dir() {
        return false;
    }
    let pre_commit = root.join(".git").join("hooks").join("pre-commit");
    match std::fs::read_to_string(&pre_commit) {
        Ok(body) => body.contains("AURA SEMANTIC ENGINE"),
        Err(_) => false,
    }
}

/// Shell the real `aura enable --quiet` in the repo — the idempotent,
/// non-interactive front door (creates `.aura/`, installs hooks, wires the
/// Team Radar). Returns whether it succeeded.
fn run_aura_enable(repo_root: &str) -> bool {
    let bin = crate::agent_event_listener::resolve_aura_bin();
    std::process::Command::new(bin)
        .args(["enable", "--quiet"])
        .current_dir(repo_root)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Append our marker-delimited block to `.git/info/exclude` if it isn't
/// there yet. `.git/info/exclude` is the local, never-committed ignore
/// list — perfect for hiding Aura's footprint without editing the repo's
/// tracked `.gitignore`. Idempotent: presence of the begin marker is a
/// no-op.
fn ensure_local_exclude(root: &Path) -> std::io::Result<()> {
    let info_dir = root.join(".git").join("info");
    std::fs::create_dir_all(&info_dir)?;
    let exclude = info_dir.join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.contains(EXCLUDE_BEGIN) {
        return Ok(());
    }

    let mut block = String::new();
    if !existing.is_empty() && !existing.ends_with('\n') {
        block.push('\n');
    }
    block.push_str(EXCLUDE_BEGIN);
    block.push('\n');
    for e in EXCLUDE_ENTRIES {
        block.push_str(e);
        block.push('\n');
    }
    block.push_str(EXCLUDE_END);
    block.push('\n');

    let combined = format!("{existing}{block}");
    std::fs::write(&exclude, combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclude_block_is_idempotent_and_hides_aura() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git").join("info")).unwrap();
        // Pre-existing user rule must survive.
        std::fs::write(root.join(".git/info/exclude"), "*.log\n").unwrap();

        ensure_local_exclude(root).unwrap();
        let body = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(body.contains("*.log"), "user rule preserved");
        assert!(body.contains("/.aura/"), "aura dir excluded");
        assert!(body.contains(EXCLUDE_BEGIN));

        // Second pass adds nothing.
        ensure_local_exclude(root).unwrap();
        let body2 = std::fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert_eq!(body, body2, "second ensure is a no-op");
        assert_eq!(body2.matches(EXCLUDE_BEGIN).count(), 1);
    }

    #[test]
    fn capture_absent_without_hook() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".aura")).unwrap();
        std::fs::create_dir_all(root.join(".git").join("hooks")).unwrap();
        assert!(!aura_capture_present(root), "no pre-commit hook => not tracked");
        std::fs::write(
            root.join(".git/hooks/pre-commit"),
            "#!/bin/sh\n# --- AURA SEMANTIC ENGINE ---\naura capture-context\n",
        )
        .unwrap();
        assert!(aura_capture_present(root), "hook marker => tracked");
    }
}
