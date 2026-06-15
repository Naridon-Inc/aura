//! Post-work acceptance gate for the autonomous loop — keep good work, undo bad.
//!
//! After an agent commits a task, this gate decides whether to keep the commit
//! or roll it back. It can run an optional shell verify command (your tests),
//! and it always consults the **free, AST-only** goal proof
//! ([`crate::goals::build::prove_active_on_commit`]) — no model call, no cost.
//! If the goal isn't built yet ("not_wired") the work is rolled back; rollback
//! is a hard `git reset --hard <before_sha>`. The absence of a goal NEVER
//! blocks: when there's nothing to check against, the work is kept.

use std::path::Path;
use std::process::Command;

use crate::goals::build;
use crate::goals::model::Verdict;

/// Outcome of the post-work acceptance gate.
pub struct AcceptOutcome {
    pub passed: bool,
    /// "verified" | "partial" | "not_wired" | "unknown", or `None` when there
    /// was no active goal to prove against.
    pub verdict: Option<String>,
    pub ok: usize,
    pub total: usize,
    /// Plain-language explanation for a non-engineer.
    pub reason: String,
}

/// Run the acceptance gate after an agent has (maybe) committed work.
///
/// 1. If `verify_cmd` is `Some`, run it as a shell command in `repo_root`; a
///    non-zero exit fails the gate.
/// 2. Always also run the free goal proof against `head_sha`. The strongest
///    active proof's verdict decides: `not_wired` fails (nothing the goal needs
///    was actually built), `partial` passes with a note, `verified` passes, and
///    no goal / `unknown` passes (we can't judge, so we never block).
///
/// `head_sha` is the commit to prove against (full or short sha).
pub fn check(repo_root: &Path, head_sha: &str, verify_cmd: Option<&str>) -> AcceptOutcome {
    // 1. Optional verify command (the agent's / project's tests).
    let verify_ok = verify_cmd.map(|cmd| {
        let code = run_verify(repo_root, cmd);
        if code != 0 {
            // Stash the failing command + code for the reason line.
            return Err((cmd.to_string(), code));
        }
        Ok(())
    });

    // If verify ran and failed, decide immediately — don't bother proving.
    if let Some(Err((cmd, code))) = &verify_ok {
        let (passed, reason) = decide_verify_failed(cmd, *code);
        return AcceptOutcome { passed, verdict: None, ok: 0, total: 0, reason };
    }
    // Collapse Option<Result<(), _>> down to Option<bool> for the policy.
    let verify_pass: Option<bool> = verify_ok.map(|r| r.is_ok());

    // 2. Free AST goal proof against the just-made commit. Best-effort: an empty
    //    Vec means there was no active goal — that's a clean PASS, never a block.
    let proofs = build::prove_active_on_commit(repo_root, head_sha);
    let strongest = strongest_proof(&proofs);

    let (verdict_str, ok, total) = match strongest {
        Some(p) => (Some(verdict_str(p.verdict)), p.ok, p.total),
        None => (None, 0, 0),
    };

    let (passed, reason) = decide(verify_pass, verdict_str.as_deref(), ok, total);
    AcceptOutcome { passed, verdict: verdict_str, ok, total, reason }
}

/// Revert HEAD + the working tree back to `before_sha` (undo the agent's
/// commit), while **preserving Aura's own `.aura/` control plane**. If HEAD is
/// already at `before_sha` (the agent produced no commit) this is a harmless
/// no-op and returns `Ok(())` without touching the repo.
///
/// We deliberately do NOT use a blunt `git reset --hard`: a coding agent often
/// `git add -A`s, sweeping `.aura/a2a/<task>.json` (the loop task store) and
/// `.aura/intent_log.jsonl` into its commit. A hard reset to `before_sha` —
/// which predates those writes — would delete them, destroying the very
/// bookkeeping that tracks this task (the caller's next `graph.fail` would then
/// fail with "task not found"). Instead we:
///   1. `git reset --mixed <before>` — move HEAD + index back, leave the
///      working tree untouched (so `.aura/` survives on disk).
///   2. `git checkout -- . :(exclude).aura` — restore tracked code files to the
///      `before` state, but never touch `.aura/`.
///   3. `git clean -fd -e .aura` — drop the agent's now-untracked new files,
///      keeping `.aura/`.
/// Net effect: code is exactly as it was at `before_sha`, the bad commit is gone
/// from history, and Aura's control plane is intact.
pub fn rollback(repo_root: &Path, before_sha: &str) -> Result<(), String> {
    // No-op when nothing was committed: HEAD already equals before_sha.
    if let Some(head) = head_sha(repo_root) {
        if same_commit(&head, before_sha) {
            return Ok(());
        }
    }

    // 1. Move HEAD + index back to `before` without clobbering the working tree.
    let reset = git(repo_root, &["reset", "--mixed", before_sha]);
    if let Err(detail) = reset {
        if detail.is_empty() {
            return Err("Couldn't undo the change — git refused to reset.".to_string());
        }
        return Err(format!("Couldn't undo the change — git said: {detail}"));
    }

    // 2. Restore tracked code files to `before`, excluding the .aura control
    //    plane. Best-effort: a clean repo with nothing to restore is fine.
    let _ = git(repo_root, &["checkout", "--", ".", ":(exclude).aura"]);

    // 3. Remove files the agent newly added (now untracked), keeping `.aura/`.
    let _ = git(repo_root, &["clean", "-fd", "-e", ".aura"]);

    Ok(())
}

/// Run a git subcommand in `repo_root`, mapping a non-zero exit (or spawn
/// failure) to the trimmed stderr so callers get a tidy reason string.
fn git(repo_root: &Path, args: &[&str]) -> Result<(), String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("git wouldn't run ({e})"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

// ── policy (pure, unit-testable) ────────────────────────────────────────────

/// PURE decision helper — no I/O. Given whether the verify command passed
/// (`None` = no verify command was run) and the proof verdict (`None` = no
/// goal), decide `(passed, plain-language reason)`. All accept/reject policy
/// lives here so it can be tested without git.
fn decide(
    verify_ok: Option<bool>,
    verdict: Option<&str>,
    ok: usize,
    total: usize,
) -> (bool, String) {
    // A failed verify command always loses — caller normally short-circuits
    // before reaching here, but keep the policy self-contained.
    if verify_ok == Some(false) {
        return (false, "Your check command failed — rolling this back.".to_string());
    }

    let verify_passed = verify_ok == Some(true);

    match verdict {
        // Nothing the goal needs got built — undo it.
        Some("not_wired") => (
            false,
            format!("The goal isn't built yet ({ok} of {total} checks) — rolling this back."),
        ),
        // Fully delivered.
        Some("verified") => {
            let reason = if verify_passed {
                "Your tests passed and the goal checks out — keeping this.".to_string()
            } else {
                "The goal checks out — keeping this.".to_string()
            };
            (true, reason)
        }
        // Some of the goal landed — keep it, but say it's not finished.
        Some("partial") => (
            true,
            format!(
                "Part of the goal is built ({ok} of {total} checks) — keeping this, but it isn't finished yet."
            ),
        ),
        // "unknown" or any unrecognized verdict: we can't judge the goal.
        Some(_) => {
            let reason = if verify_passed {
                "Your tests passed — keeping this. (Couldn't fully check the goal.)".to_string()
            } else {
                "Couldn't check the goal — keeping this.".to_string()
            };
            (true, reason)
        }
        // No goal at all: never block on the absence of a goal.
        None => {
            let reason = if verify_passed {
                "Your tests passed — keeping this.".to_string()
            } else {
                "Nothing to check against — keeping this.".to_string()
            };
            (true, reason)
        }
    }
}

/// Reason for the short-circuit path where the verify command failed outright.
fn decide_verify_failed(cmd: &str, code: i32) -> (bool, String) {
    (
        false,
        format!("Your check command failed (\"{cmd}\" returned {code}) — rolling this back."),
    )
}

// ── helpers ─────────────────────────────────────────────────────────────────

/// Stringify a [`Verdict`] to the engine's snake_case form. Matches the
/// `#[serde(rename_all = "snake_case")]` spelling on the enum so it compares
/// cleanly against `"verified"` / `"partial"` / `"not_wired"` / `"unknown"`.
fn verdict_str(v: Verdict) -> String {
    match v {
        Verdict::Verified => "verified",
        Verdict::Partial => "partial",
        Verdict::NotWired => "not_wired",
        Verdict::Unknown => "unknown",
    }
    .to_string()
}

/// Pick the most-decisive proof from a build's proofs. We rank by how
/// committal the verdict is so the gate reflects the strongest signal:
/// `not_wired` (block) > `verified` > `partial` > `unknown`.
fn strongest_proof(proofs: &[build::BuildProof]) -> Option<&build::BuildProof> {
    proofs.iter().max_by_key(|p| verdict_rank(p.verdict))
}

/// Rank used by [`strongest_proof`]. `not_wired` wins so that if any proven
/// goal isn't built, the gate sees it and blocks.
fn verdict_rank(v: Verdict) -> u8 {
    match v {
        Verdict::NotWired => 3,
        Verdict::Verified => 2,
        Verdict::Partial => 1,
        Verdict::Unknown => 0,
    }
}

/// Run the verify command through `sh -c`, inheriting stdio, return its code.
/// Mirrors `aura_loop_run::run_verify`.
fn run_verify(repo_root: &Path, cmd_str: &str) -> i32 {
    Command::new("sh")
        .arg("-c")
        .arg(cmd_str)
        .current_dir(repo_root)
        .status()
        .ok()
        .and_then(|s| s.code())
        .unwrap_or(1)
}

/// Current `git HEAD` sha (full), or `None` outside a repo / on error.
/// Mirrors `aura_loop_run::head_sha`.
fn head_sha(repo_root: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// True when two shas name the same commit, tolerant of short-vs-full form
/// (so a short `before_sha` still matches a full HEAD and the no-op holds).
fn same_commit(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let n = a.len().min(b.len());
    n >= 7 && a.as_bytes()[..n] == b.as_bytes()[..n]
}

// ── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_fail_blocks() {
        // A failed verify command rolls back regardless of any verdict.
        let (passed, reason) = decide(Some(false), Some("verified"), 3, 3);
        assert!(!passed);
        assert!(reason.to_lowercase().contains("rolling this back"));
    }

    #[test]
    fn verify_pass_plus_not_wired_blocks() {
        // Tests green but the goal isn't built — still a rollback.
        let (passed, reason) = decide(Some(true), Some("not_wired"), 0, 3);
        assert!(!passed);
        assert!(reason.contains("0 of 3"));
        assert!(reason.contains("rolling this back"));
    }

    #[test]
    fn verify_pass_plus_verified_passes() {
        let (passed, reason) = decide(Some(true), Some("verified"), 3, 3);
        assert!(passed);
        assert!(reason.contains("keeping this"));
    }

    #[test]
    fn no_verify_plus_partial_passes_with_note() {
        // No verify command, goal partially built — keep, but note it's unfinished.
        let (passed, reason) = decide(None, Some("partial"), 1, 3);
        assert!(passed);
        assert!(reason.contains("1 of 3"));
        assert!(reason.to_lowercase().contains("isn't finished"));
    }

    #[test]
    fn no_verify_plus_no_goal_passes() {
        // Nothing to judge against — never block on the absence of a goal.
        let (passed, reason) = decide(None, None, 0, 0);
        assert!(passed);
        assert!(reason.contains("keeping this"));
    }

    #[test]
    fn not_wired_with_no_verify_blocks() {
        // No verify command, but the goal isn't wired — roll it back.
        let (passed, reason) = decide(None, Some("not_wired"), 0, 2);
        assert!(!passed);
        assert!(reason.contains("0 of 2"));
        assert!(reason.contains("rolling this back"));
    }

    #[test]
    fn verify_pass_plus_unknown_passes() {
        // Tests green, goal unprovable — keep it, don't block on a missing check.
        let (passed, _reason) = decide(Some(true), Some("unknown"), 0, 0);
        assert!(passed);
    }

    #[test]
    fn verify_pass_plus_no_goal_passes() {
        let (passed, reason) = decide(Some(true), None, 0, 0);
        assert!(passed);
        assert!(reason.contains("keeping this"));
    }

    #[test]
    fn verdict_str_matches_engine_spelling() {
        // Must equal the serde snake_case form the rest of the engine emits.
        assert_eq!(verdict_str(Verdict::Verified), "verified");
        assert_eq!(verdict_str(Verdict::Partial), "partial");
        assert_eq!(verdict_str(Verdict::NotWired), "not_wired");
        assert_eq!(verdict_str(Verdict::Unknown), "unknown");
    }

    #[test]
    fn strongest_proof_prefers_not_wired() {
        let proofs = vec![
            build::BuildProof {
                goal_text: "a".into(),
                verdict: Verdict::Verified,
                ok: 2,
                total: 2,
                freshly_decomposed: false,
            },
            build::BuildProof {
                goal_text: "b".into(),
                verdict: Verdict::NotWired,
                ok: 0,
                total: 3,
                freshly_decomposed: false,
            },
        ];
        let s = strongest_proof(&proofs).unwrap();
        assert_eq!(s.verdict, Verdict::NotWired);
    }

    #[test]
    fn same_commit_tolerates_short_and_full() {
        let full = "abc1234def5678901234567890abcdef12345678";
        assert!(same_commit(full, "abc1234"));
        assert!(same_commit("abc1234", full));
        assert!(same_commit(full, full));
        assert!(!same_commit(full, "def5678"));
        // Too-short prefixes must not collide.
        assert!(!same_commit("abc", "abc1234"));
    }
}
